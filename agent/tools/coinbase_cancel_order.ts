import { defineTool } from "eve/tools";
import { z } from "zod";

import { coinbaseApproval, requireCoinbaseAccess } from "../lib/coinbase-access";
import { callCoinbaseMcpTool } from "../lib/coinbase-mcp";
import { executeCoinbaseMutation } from "../lib/coinbase-operation-store";
import { markPhotonApprovalExecution } from "../lib/photon-approval-store";

const cancelOrderSchema = z.object({ order_id: z.string().uuid() }).strict();
const openOrderSchema = z.object({
  order_id: z.string().uuid(),
  product_id: z.string().regex(/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/u),
  status: z.literal("OPEN"),
});
const cancelResultSchema = z.object({
  results: z.array(z.object({
    order_id: z.string().uuid(),
    success: z.boolean(),
  })).length(1),
});

export default defineTool({
  description:
    "Request cancellation of exactly one open Coinbase spot order by its order_id, after explicit owner approval. Cancels only the remaining open portion; fills are unaffected. Never retry automatically.",
  inputSchema: cancelOrderSchema,
  approval: (ctx) => coinbaseApproval(ctx, true),
  async execute(input, ctx) {
    const principal = requireCoinbaseAccess(ctx);
    const { order_id } = cancelOrderSchema.parse(input);
    let preflightFailed = false;
    try {
      const toolInput = { order_ids: [order_id] };
      const result = await executeCoinbaseMutation({
        callId: ctx.callId,
        principalId: principal.id,
        toolInput,
        toolName: "coinbase_orders_cancel",
        operation: async () => {
          try {
            const order = openOrderSchema.safeParse(await callCoinbaseMcpTool(
              "coinbase_orders_get",
              { order_id },
              { signal: ctx.abortSignal },
            ));
            if (!order.success || order.data.order_id !== order_id) {
              throw new Error("The exact Coinbase order could not be confirmed as OPEN. No cancellation was sent; inspect its current status.");
            }
            const product = await callCoinbaseMcpTool(
              "coinbase_products_get",
              { product_id: order.data.product_id },
              { signal: ctx.abortSignal },
            );
            if (
              typeof product !== "object" || product === null ||
              Reflect.get(product, "product_type") !== "SPOT"
            ) {
              throw new Error("Eve is restricted to Coinbase spot products. No cancellation was sent.");
            }
          } catch (error) {
            preflightFailed = true;
            throw error;
          }
          const response = await callCoinbaseMcpTool("coinbase_orders_cancel", toolInput, {
            signal: ctx.abortSignal,
          });
          const parsed = cancelResultSchema.safeParse(response);
          if (
            !parsed.success ||
            parsed.data.results[0].order_id !== order_id ||
            !parsed.data.results[0].success
          ) {
            throw new Error("Coinbase did not confirm acceptance of this order's cancellation. Completion is uncertain; inspect the order by ID and do not retry automatically.");
          }
          return response;
        },
      });
      await markPhotonApprovalExecution({ sessionId: ctx.session.id, state: "succeeded" }).catch(
        (error: unknown) => {
          console.error("[coinbase.cancel] Approval outcome update failed", {
            error_type: error instanceof Error ? error.name : typeof error,
          });
        },
      );
      return {
        order_id,
        cancellationAccepted: true,
        note: "Coinbase accepted the cancellation request for the remaining open portion. Fills are unaffected, and the order may have filled before cancellation took effect. Check order status if final confirmation is needed; do not automatically repeat the cancellation.",
        result,
      };
    } catch (error) {
      await markPhotonApprovalExecution({
        sessionId: ctx.session.id,
        state: preflightFailed ? "safe-failure" : "uncertain",
      }).catch(() => undefined);
      throw error;
    }
  },
});
