import { defineDynamic, defineTool } from "eve/tools";

import {
  coinbaseApproval,
  coinbasePrincipal,
  coinbasePrincipalAllowed,
  requireCoinbaseAccess,
} from "../lib/coinbase-access";
import {
  callCoinbaseMcpTool,
  listCoinbaseMcpTools,
  type CoinbaseMcpToolDefinition,
} from "../lib/coinbase-mcp";
import { validateCoinbaseMcpInput } from "../lib/coinbase-mcp-policy";

const READ_ONLY_TOOLS = new Set([
  "coinbase_orders_list",
  "coinbase_orders_get",
  "coinbase_orders_fills",
  "coinbase_portfolios_list",
  "coinbase_portfolios_get",
  "coinbase_products_list",
  "coinbase_products_get",
  "coinbase_products_ticker",
  "coinbase_products_book",
  "coinbase_products_candles",
  "coinbase_products_best_bid_ask",
  "coinbase_balance",
  "coinbase_fees",
]);

let toolDefinitions: Promise<CoinbaseMcpToolDefinition[]> | undefined;

async function availableTools(): Promise<CoinbaseMcpToolDefinition[]> {
  toolDefinitions ??= listCoinbaseMcpTools().catch((error) => {
    toolDefinitions = undefined;
    throw error;
  });
  return toolDefinitions;
}

function spotOnlyInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const products = [
    input.product_id,
    ...(Array.isArray(input.product_ids) ? input.product_ids : []),
    ...(typeof input.product_ids === "string" ? input.product_ids.split(",") : []),
  ];
  if (products.some((value) => typeof value === "string" && /(?:^|[-_])(?:PERP|FUT(?:URE)?)(?:$|[-_])/iu.test(value))) {
    throw new Error("Coinbase access is restricted to spot products.");
  }
  if (["coinbase_products_list", "coinbase_orders_list", "coinbase_fees"].includes(toolName)) {
    return { ...input, product_type: "SPOT" };
  }
  return input;
}

export default defineDynamic({
  events: {
    "step.started": async (_event, ctx) => {
      const principal = coinbasePrincipal(ctx.session);
      if (!principal || !coinbasePrincipalAllowed(principal)) return null;
      const definitions = (await availableTools()).filter((definition) => READ_ONLY_TOOLS.has(definition.name));
      return Object.fromEntries(definitions.map((definition) => [
        definition.name,
        defineTool({
          description: `${definition.description ?? definition.name} Read-only; available to the allowlisted owner.`,
          inputSchema: definition.inputSchema,
          approval: (approvalCtx) => coinbaseApproval(approvalCtx, false),
          async execute(input, toolCtx) {
            requireCoinbaseAccess(toolCtx);
            return callCoinbaseMcpTool(
              definition.name,
              spotOnlyInput(definition.name, validateCoinbaseMcpInput(input)),
              { signal: toolCtx.abortSignal },
            );
          },
        }),
      ]));
    },
  },
});
