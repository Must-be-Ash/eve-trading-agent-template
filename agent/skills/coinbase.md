---
description: Read Coinbase spot-market and account data, preview exact spot orders, and submit or cancel one order after explicit owner approval.
---

# Coinbase trading

Use Coinbase only for the configured owner in a private iMessage conversation.
The owner must be in both `PHOTON_ALLOWED_PRINCIPALS` and
`COINBASE_ALLOWED_PRINCIPALS`. Credentials stay in encrypted server environment
variables. Use `coinbase_access_status` for setup status; never request secrets
in chat. Runtime or scheduled sessions cannot trade.

## Supported operations

Read market products, prices, books, candles, balances, portfolios, fees, orders,
and fills. Submit spot market, limit, or stop-limit orders through the authored
preview/create workflow below. Cancel an open spot order through
`coinbase_cancel_order`. Transfers, conversions, portfolio changes, and order
editing are not available in this template.

Read-only calls do not need a separate approval prompt. For balances, call
`coinbase_balance` with `limit: 200` and `show_zero: false`; use `show_zero: true`
only if the user requests zero balances. Avoid extra price or valuation calls
unless the user asks for a valuation.

## One exact order per approval

1. Resolve the exact product with `coinbase_products_get`. Check `product_type`
   is `SPOT`, the product is online, and both currencies match the request.
   Never substitute `ETH-USD` for `ETH-USDC` or trade leverage, futures, or margin.
2. If sizing depends on holdings, read the current available balance. Resolve
   "half" or "all" against that balance, including funds on hold, rather than
   relying on earlier conversation values.
3. Call `coinbase_preview_order` with the exact order. Raw
   `coinbase_orders_preview` and `coinbase_orders_create` are intentionally hidden.
4. Present the product, side, order type, amount, estimated fill, fees, and
   slippage. Call `coinbase_create_order` with unchanged fields and the fresh
   preview token to request approval. The Photon approval card is the explicit
   authorization step; a thread-bound `YES` or `NO` reply is the fallback.
5. The preview expires after five minutes. Changed or expired orders need a new
   preview and approval. A stable client order ID and durable operation journal
   protect interrupted executions from duplicate submission.
6. Report the create response. Submission does not mean the order is filled.
   Fetch subsequent status only if the user asks or an uncertain submission
   needs reconciliation. Do not claim fills or proceeds absent provider evidence.

Do not overlap orders or approvals. For a chain such as "sell BTC and buy SOL
with the proceeds," finish the first order, report its actual status, and stop.
Do not size a second trade from estimated proceeds. Wait for the owner's next
instruction, check that funds are settled, and request a separate approval.

Never infer authorization from preferences, alerts, previous approvals, or a
vague request. Do not describe a trade as guaranteed or risk-free.

## Cancel one open order

1. Resolve the owner's exact order using `coinbase_orders_list` or
   `coinbase_orders_get`. In private chat, show its full order ID, product, side,
   status, and remaining amount when supplied by Coinbase. Ask which order if
   the request is ambiguous; never choose an order by guessing.
2. Call `coinbase_cancel_order` with only that `order_id` to request a separate
   approval. Its card names the exact order ID and explains that only the
   remaining open portion is canceled; existing fills are unaffected.
3. Approval expires after five minutes. Execution rechecks authorization, the
   exact order's OPEN status, and the spot product before sending one request.
   Do not bypass this workflow with raw `coinbase_orders_cancel`.
4. Report acceptance as a cancellation request, not a promise that the order
   could not fill. If completion is uncertain, inspect the order by its exact
   ID. Never automatically retry cancellation or replace it with another order.

Account balances, holdings, orders, and fills stay in private chat. Use public
artifacts only for public market research, without private account details.

### Order sizes

- Market BUY: `quoteSize`, the amount of quote currency to spend.
- Market SELL: `baseSize`, the quantity of the asset to sell.
- Limit BUY or SELL: `baseSize` and `limitPrice`.
- Stop-limit: `baseSize`, `limitPrice`, `stopPrice`, and `stopDirection`.
- Never supply both base and quote size.

## Results and recovery

Preserve product and order IDs, decimal amounts, fees, currencies, and timestamps
exactly. Use returned cursors for pagination. If a page is rejected for size,
request a smaller limit or narrower filters without advancing its cursor.

Distinguish available balance from held funds and submitted orders from fills.
For an uncertain write, never retry automatically. Reconcile with
`coinbase_orders_list`, `coinbase_orders_get`, or `coinbase_orders_fills` using the
existing client order ID. Relay safe rejection reasons and stop; do not silently
change size, product, or order type. Never include credentials or raw account
responses in logs.
