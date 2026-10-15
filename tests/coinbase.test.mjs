import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { startTestRedis } from "./helpers/photon-redis.mjs";

const projectRoot = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(projectRoot, "tests/.coinbase-"));
const bundlePath = join(directory, "fixture.mjs");
const providerFixture = `
  export const provider = { calls: [], productType: "SPOT", fail: null };
  export async function listCoinbaseMcpTools() {
    return ["coinbase_balance", "coinbase_orders_create", "coinbase_orders_cancel", "coinbase_transfer", "coinbase_convert_execute", "coinbase_portfolios_delete"]
      .map(name => ({ name, inputSchema: { type: "object", properties: {} } }));
  }
  export async function callCoinbaseMcpTool(name, input) {
    provider.calls.push({ name, input });
    if (name === "coinbase_products_get") return { product_type: provider.productType, status: "ONLINE" };
    if (provider.fail) throw new Error(provider.fail);
    if (name === "coinbase_orders_preview") return { commission_total: "0.01", quote_size: input.quote_size };
    return { success: true, order_id: "fixture-order", client_order_id: input.client_order_id };
  }
`;
await build({
  absWorkingDir: projectRoot,
  stdin: {
    contents: `
      export * from "./agent/lib/coinbase-order.ts";
      export * from "./agent/lib/photon-approval.ts";
      export * from "./agent/lib/photon-approval-store.ts";
      export * from "./agent/lib/coinbase-cli.ts";
      export * from "./agent/lib/mcp-tool-result.ts";
      export * from "./agent/lib/coinbase-mcp-policy.ts";
      export { default as previewTool } from "./agent/tools/coinbase_preview_order.ts";
      export { default as createTool } from "./agent/tools/coinbase_create_order.ts";
      export { default as dynamicTools } from "./agent/tools/coinbase_mcp.ts";
      export { provider } from "coinbase-provider-fixture";
    `,
    resolveDir: projectRoot,
    loader: "ts",
  },
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
  plugins: [{
    name: "offline-coinbase-provider",
    setup(plugin) {
      plugin.onResolve({ filter: /(?:^coinbase-provider-fixture$|\/coinbase-mcp$)/ }, () => ({ path: "provider", namespace: "fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: providerFixture, loader: "js" }));
    },
  }],
});
const api = await import(pathToFileURL(bundlePath).href);
let redis;
const OWNER = "imessage:+15555550100";
const ORDER = { productId: "BTC-USD", side: "BUY", type: "market", quoteSize: "10.00" };
const environmentNames = ["PHOTON_ALLOWED_PRINCIPALS", "COINBASE_ALLOWED_PRINCIPALS", "COINBASE_KEY_ID", "COINBASE_KEY_SECRET", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
const environment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
function context(callId = "call-1", principalId = OWNER) {
  return {
    callId,
    abortSignal: new AbortController().signal,
    session: {
      id: "test-session",
      auth: { current: { principalType: "user", principalId, authenticator: "photon-imessage-webhook", attributes: { channel: "photon" } } },
    },
  };
}
function resetProvider() {
  api.provider.calls.length = 0;
  api.provider.fail = null;
  api.provider.productType = "SPOT";
}
before(async () => {
  process.env.PHOTON_ALLOWED_PRINCIPALS = OWNER;
  process.env.COINBASE_ALLOWED_PRINCIPALS = OWNER;
  process.env.COINBASE_KEY_ID = "offline-fixture-key-id";
  process.env.COINBASE_KEY_SECRET = "offline-fixture-signing-secret";
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  redis = await startTestRedis();
  process.env.UPSTASH_REDIS_REST_URL = redis.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = redis.token;
});
after(async () => {
  await redis?.close();
  await rm(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test("provider diagnostics retain safe rejection reasons and distinguish uncertain writes", () => {
  for (const [message, expected] of [
    ["HTTP 400: invalid quote size too small", /invalid quote size too small.*not submitted/u],
    ["HTTP 400: invalid base size too small", /invalid base size too small.*not submitted/u],
    ["HTTP 400: product is not available", /product is not available.*not submitted/u],
    ["HTTP 400: insufficient funds", /insufficient available funds/u],
    ["HTTP 401: Unauthorized", /authentication failed/u],
    ["HTTP 403: missing required scopes", /portfolio scope/u],
    ["INVALID_VALUE", /Re-check the product/u],
    ["HTTP 429: too many requests", /rate-limited.*rejected rather than executed/u],
    ["HTTP 500: internal server error", /completion state is unknown/u],
    ["HTTP 504: request timed out", /completion state is unknown/u],
  ]) {
    assert.match(api.safeCoinbaseFailure(new api.McpToolResultError(message)).message, expected);
  }
  const opaque = api.safeCoinbaseFailure(Object.assign(new Error("spawn failed"), { stderr: "COINBASE_KEY_SECRET=do-not-echo" }));
  assert.equal(opaque.message, "The Coinbase request failed without a safe diagnostic.");
  const credential = api.safeCoinbaseFailure(new api.McpToolResultError(`HTTP 400: ${process.env.COINBASE_KEY_SECRET}`));
  assert.doesNotMatch(credential.message, /offline-fixture-signing-secret/u);
  assert.match(credential.message, /credential omitted/u);
  assert.ok(api.safeCoinbaseFailure(new api.McpToolResultError(`HTTP 400: ${"x".repeat(5000)}`)).message.length < 600);
});

test("Coinbase pages preserve precise values and reject partial lists before advancing the cursor", () => {
  const page = count => ({ content: [], structuredContent: { orders: Array.from({ length: count }, (_, i) => ({ order_id: `order-${i}`, quote_size: "0.123456789012345678" })), cursor: "next-page", has_next: true } });
  const result = api.normalizeCoinbaseMcpToolResult(page(200), "coinbase_orders_list");
  assert.equal(result.orders.length, 200);
  assert.equal(result.orders.at(-1).quote_size, "0.123456789012345678");
  assert.equal(result.cursor, "next-page");
  assert.throws(() => api.normalizeCoinbaseMcpToolResult(page(201), "coinbase_orders_list"), /smaller page|safe list context/u);
  const redacted = api.normalizeCoinbaseMcpToolResult({ content: [], structuredContent: { api_key: "secret-key", note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", product_id: "BTC-USD", long: "a".repeat(150_000) } }, "coinbase_products_get");
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /secret-key|abcdefghijklmnopqrstuvwxyz/u);
  assert.match(serialized, /BTC-USD/u);
  assert.ok(serialized.length <= 120_000);
});

test("only allowlisted Photon owners can discover reads or request order approval", async () => {
  resetProvider();
  const owner = context();
  const definitions = await api.dynamicTools.events["step.started"]({}, owner);
  assert.ok(definitions.coinbase_balance);
  for (const forbidden of ["coinbase_orders_create", "coinbase_orders_cancel", "coinbase_transfer", "coinbase_convert_execute", "coinbase_portfolios_delete"]) {
    assert.equal(definitions[forbidden], undefined);
  }
  assert.equal(await api.createTool.approval(owner), "user-approval");
  const outsider = context("outsider", "imessage:+15555550101");
  assert.equal(await api.dynamicTools.events["step.started"]({}, outsider), null);
  assert.equal((await api.createTool.approval(outsider)).type, "denied");
  await assert.rejects(api.previewTool.execute(ORDER, outsider), /not authorized/u);
  await assert.rejects(definitions.coinbase_balance.execute({}, outsider), /not authorized/u);
  process.env.PHOTON_ALLOWED_PRINCIPALS = "imessage:+15555550101";
  try {
    assert.equal((await api.createTool.approval(owner)).type, "denied");
    await assert.rejects(definitions.coinbase_balance.execute({}, owner), /not authorized/u);
  } finally { process.env.PHOTON_ALLOWED_PRINCIPALS = OWNER; }
  const runtime = context();
  runtime.session.auth.current = { principalType: "runtime", principalId: "eve:app", authenticator: "app", attributes: {} };
  await assert.rejects(api.previewTool.execute(ORDER, runtime), /authenticated user/u);
  assert.equal(api.provider.calls.length, 0);
});

test("preview checks spot metadata and never signs a failed provider preview", async () => {
  resetProvider();
  api.provider.productType = "FUTURE";
  await assert.rejects(api.previewTool.execute(ORDER, context()), /restricted to spot/u);
  assert.deepEqual(api.provider.calls.map(call => call.name), ["coinbase_products_get"]);
  resetProvider();
  api.provider.fail = "preview rejected";
  await assert.rejects(api.previewTool.execute(ORDER, context()), /preview rejected/u);
  assert.deepEqual(api.provider.calls.map(call => call.name), ["coinbase_products_get", "coinbase_orders_preview"]);
});

test("order schemas reject ambiguous size and price combinations before execution", () => {
  for (const invalid of [
    { ...ORDER, baseSize: "0.01" },
    { ...ORDER, side: "SELL" },
    { ...ORDER, quoteSize: "-1" },
    { ...ORDER, limitPrice: "50000" },
    { productId: "BTC-USD", side: "BUY", type: "limit", baseSize: "0.01" },
    { productId: "BTC-USD", side: "BUY", type: "stop_limit", baseSize: "0.01", limitPrice: "50000" },
  ]) {
    assert.equal(api.previewTool.inputSchema.safeParse(invalid).success, false);
  }
});

test("signed previews bind the exact order, owner, expiry, and canonical token bytes", async () => {
  resetProvider();
  const preview = await api.previewTool.execute(ORDER, context());
  const token = preview.authorization.previewToken;
  const input = { ...ORDER, previewToken: token };
  api.provider.calls.length = 0;
  await assert.rejects(api.createTool.execute({ ...input, quoteSize: "11.00" }, context("changed-order")), /changed after preview/u);
  for (const suffix of ["A", "="]) {
    await assert.rejects(api.createTool.execute({ ...input, previewToken: `${token}${suffix}` }, context(`tampered-${suffix}`)), /invalid/u);
  }
  const nextOwner = "imessage:+15555550101";
  process.env.PHOTON_ALLOWED_PRINCIPALS = nextOwner;
  process.env.COINBASE_ALLOWED_PRINCIPALS = nextOwner;
  try {
    await assert.rejects(api.createTool.execute(input, context("different-owner", nextOwner)), /different private-chat/u);
  } finally {
    process.env.PHOTON_ALLOWED_PRINCIPALS = OWNER;
    process.env.COINBASE_ALLOWED_PRINCIPALS = OWNER;
  }
  const now = Date.now;
  Date.now = () => Date.parse(preview.authorization.expiresAt) + 1;
  try { await assert.rejects(api.createTool.execute(input, context("expired-preview")), /expired/u); }
  finally { Date.now = now; }
  assert.equal(api.provider.calls.length, 0);
});

test("create rechecks spot status, journals success, and refuses replay after process reload", async () => {
  resetProvider();
  const preview = await api.previewTool.execute(ORDER, context());
  const input = { ...ORDER, previewToken: preview.authorization.previewToken };
  api.provider.productType = "FUTURE";
  await assert.rejects(api.createTool.execute(input, context("spot-recheck")), /restricted to Coinbase spot/u);
  assert.equal(api.provider.calls.filter(call => call.name === "coinbase_orders_create").length, 0);
  api.provider.productType = "SPOT";
  const response = await api.createTool.execute(input, context("successful-call"));
  const write = api.provider.calls.find(call => call.name === "coinbase_orders_create");
  assert.equal(write.input.client_order_id, response.clientOrderId);
  assert.equal(response.clientOrderId, api.clientOrderIdForPreview(input.previewToken));
  const reloaded = await import(`${pathToFileURL(bundlePath).href}?reloaded`);
  await assert.rejects(reloaded.createTool.execute(input, context("successful-call")), /already succeeded/u);
  assert.equal(reloaded.provider.calls.filter(call => call.name === "coinbase_orders_create").length, 0);
  const changedOrder = { ...ORDER, quoteSize: "12" };
  const changedPreview = api.createOrderPreviewToken(changedOrder, OWNER);
  await assert.rejects(reloaded.createTool.execute({ ...changedOrder, previewToken: changedPreview.token }, context("successful-call")), /conflicts with an existing operation/u);
});

test("uncertain writes stay journaled and are never automatically retried", async () => {
  resetProvider();
  const preview = await api.previewTool.execute(ORDER, context());
  const input = { ...ORDER, previewToken: preview.authorization.previewToken };
  const ctx = context("uncertain-call");
  const scope = { principalId: OWNER, sessionId: ctx.session.id, threadId: "uncertain-thread" };
  const prompt = api.createPhotonApprovalPrompt({ kind: "tool-approval", requestId: ctx.callId, action: { toolName: "coinbase_create_order", input } });
  const saved = await api.savePhotonApproval({ ...scope, prompt });
  await api.activatePhotonApproval({ ...scope, approvalToken: saved.approvalToken });
  const claim = await api.claimPhotonApprovalDecision({ approvalToken: saved.approvalToken, decision: "approve" });
  assert.equal(claim.status, "deliver");
  await api.completePhotonApprovalDecision(claim.delivery);
  api.provider.fail = "completion state is unknown";
  await assert.rejects(api.createTool.execute(input, context("uncertain-call")), /completion state is unknown/u);
  api.provider.fail = null;
  await assert.rejects(api.createTool.execute(input, context("uncertain-call")), /already attempted.*uncertain/u);
  const now = Date.now;
  Date.now = () => Date.parse(preview.authorization.expiresAt) + 1;
  try { await assert.rejects(api.createTool.execute(input, ctx)); }
  finally { Date.now = now; }
  assert.equal(await api.releasePhotonApprovalProcessing(ctx.session.id), "retained");
  assert.equal(await api.getCurrentPhotonApprovalActivity(scope), "processing");
  assert.equal(api.provider.calls.filter(call => call.name === "coinbase_orders_create").length, 1);
});
