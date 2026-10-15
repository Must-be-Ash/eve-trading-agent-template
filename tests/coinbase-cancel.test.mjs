import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { startTestRedis } from "./helpers/photon-redis.mjs";

const projectRoot = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(projectRoot, "tests/.coinbase-cancel-"));
const bundlePath = join(directory, "fixture.mjs");
const providerFixture = `
  export const provider = { calls: [], order: null, productType: "SPOT", response: null, fail: false };
  export async function callCoinbaseMcpTool(name, input) {
    provider.calls.push({ name, input });
    if (name === "coinbase_orders_get") return provider.order;
    if (name === "coinbase_products_get") return { product_type: provider.productType };
    if (name !== "coinbase_orders_cancel") throw new Error("Unexpected provider action");
    if (provider.fail) throw new Error("Transport timed out; completion state is unknown");
    return provider.response;
  }
`;
await build({
  absWorkingDir: projectRoot,
  stdin: {
    contents: `
      export { default as cancelTool } from "./agent/tools/coinbase_cancel_order.ts";
      export * from "./agent/lib/photon-approval.ts";
      export * from "./agent/lib/photon-approval-store.ts";
      export { provider } from "coinbase-cancel-provider-fixture";
    `,
    resolveDir: projectRoot, loader: "ts",
  },
  outfile: bundlePath, bundle: true, platform: "node", format: "esm",
  packages: "external", logLevel: "silent",
  plugins: [{
    name: "offline-coinbase-cancellation",
    setup(plugin) {
      plugin.onResolve({ filter: /(?:^coinbase-cancel-provider-fixture$|\/coinbase-mcp$)/ }, () => ({ path: "provider", namespace: "fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: providerFixture, loader: "js" }));
    },
  }],
});
const api = await import(pathToFileURL(bundlePath).href);
const OWNER = "imessage:+15555550100";
const ORDER_ID = "f9ef2d74-e445-4bc5-86c2-c3a192337d6e";
const OTHER_ID = "0b843388-d7a4-4359-919a-3d89709997ea";
const input = { order_id: ORDER_ID };
const environmentNames = ["PHOTON_ALLOWED_PRINCIPALS", "COINBASE_ALLOWED_PRINCIPALS", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
const environment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
let redis;
function context(callId, principalId = OWNER) {
  return {
    callId, abortSignal: new AbortController().signal,
    session: {
      id: `cancel-session-${callId}`,
      auth: { current: { principalType: "user", principalId, authenticator: "photon-imessage-webhook", attributes: { channel: "photon" } } },
    },
  };
}
function request(value = input, requestId = "cancel-request") {
  return { kind: "tool-approval", requestId, action: { toolName: "coinbase_cancel_order", input: value } };
}
function resetProvider(target = api) {
  target.provider.calls.length = 0;
  target.provider.order = { order_id: ORDER_ID, product_id: "BTC-USD", status: "OPEN", filled_size: "0.2" };
  target.provider.productType = "SPOT";
  target.provider.response = { results: [{ order_id: ORDER_ID, success: true }] };
  target.provider.fail = false;
}
async function approve(ctx) {
  const scope = { principalId: OWNER, sessionId: ctx.session.id, threadId: `thread-${ctx.callId}` };
  const saved = await api.savePhotonApproval({ ...scope, prompt: api.createPhotonApprovalPrompt(request(input, ctx.callId)) });
  await api.activatePhotonApproval({ ...scope, approvalToken: saved.approvalToken });
  const claim = await api.claimPhotonApprovalDecision({ approvalToken: saved.approvalToken, decision: "approve" });
  assert.equal(claim.status, "deliver");
  await api.completePhotonApprovalDecision(claim.delivery);
  return scope;
}
before(async () => {
  process.env.PHOTON_ALLOWED_PRINCIPALS = OWNER;
  process.env.COINBASE_ALLOWED_PRINCIPALS = OWNER;
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

test("cancellation approval identifies one exact order and cannot imply reversal of fills", () => {
  const now = Date.now();
  const prompt = api.createPhotonApprovalPrompt(request(), now);
  assert.equal(prompt.approvalText, `Request cancellation of order ${ORDER_ID}? Only the remaining open portion can be canceled; filled portions are unaffected.`);
  assert.equal(prompt.expiresAtMs, now + 5 * 60_000);
  for (const invalid of [{}, { order_id: "all" }, { order_ids: [ORDER_ID, OTHER_ID] }, { ...input, order_ids: [OTHER_ID] }]) {
    assert.equal(api.cancelTool.inputSchema.safeParse(invalid).success, false);
    assert.throws(() => api.createPhotonApprovalPrompt(request(invalid), now), /exact approval/u);
  }
});

test("cancellation requires approval and rechecks the live owner's authorization before reading or writing", async () => {
  resetProvider();
  const owner = context("owner");
  assert.equal(await api.cancelTool.approval(owner), "user-approval");
  const outsider = context("outsider", "imessage:+15555550101");
  assert.equal((await api.cancelTool.approval(outsider)).type, "denied");
  await assert.rejects(api.cancelTool.execute(input, outsider), /not authorized/u);
  const runtime = context("runtime");
  runtime.session.auth.current = { principalType: "runtime", principalId: "eve:app", authenticator: "app", attributes: {} };
  await assert.rejects(api.cancelTool.execute(input, runtime), /authenticated user/u);
  process.env.COINBASE_ALLOWED_PRINCIPALS = "";
  try { await assert.rejects(api.cancelTool.execute(input, owner), /not authorized/u); }
  finally { process.env.COINBASE_ALLOWED_PRINCIPALS = OWNER; }
  assert.equal(api.provider.calls.length, 0);
});

test("final order checks reject terminal, unknown, mismatched, or non-spot orders before cancellation", async () => {
  for (const order of [
    ...["FILLED", "CANCELLED", "EXPIRED", "FAILED", "PENDING", "UNKNOWN_ORDER_STATUS"].map(status => ({ order_id: ORDER_ID, product_id: "BTC-USD", status })),
    { order_id: OTHER_ID, product_id: "BTC-USD", status: "OPEN" },
    { order_id: ORDER_ID, status: "OPEN" },
    null,
  ]) {
    resetProvider();
    api.provider.order = order;
    await assert.rejects(api.cancelTool.execute(input, context(`not-open-${order?.status}`)), /could not be confirmed as OPEN/u);
    assert.deepEqual(api.provider.calls.map(call => call.name), ["coinbase_orders_get"]);
  }
  resetProvider();
  api.provider.productType = "FUTURE";
  const ctx = context("non-spot");
  await approve(ctx);
  await assert.rejects(api.cancelTool.execute(input, ctx), /restricted to Coinbase spot/u);
  assert.equal(api.provider.calls.some(call => call.name === "coinbase_orders_cancel"), false);
  assert.equal(await api.releasePhotonApprovalProcessing(ctx.session.id), "released", "a confirmed pre-write failure must not leave the owner blocked");
});

test("approved cancellation sends exactly one native order ID and journals the accepted request across reload", async () => {
  resetProvider();
  const ctx = context("accepted");
  await approve(ctx);
  const result = await api.cancelTool.execute(input, ctx);
  assert.deepEqual(api.provider.calls, [
    { name: "coinbase_orders_get", input: { order_id: ORDER_ID } },
    { name: "coinbase_products_get", input: { product_id: "BTC-USD" } },
    { name: "coinbase_orders_cancel", input: { order_ids: [ORDER_ID] } },
  ]);
  assert.equal(result.cancellationAccepted, true);
  assert.equal(result.order_id, ORDER_ID);
  assert.match(result.note, /may have filled/u);
  assert.equal(await api.releasePhotonApprovalProcessing(ctx.session.id), "released");
  const reloaded = await import(`${pathToFileURL(bundlePath).href}?reload`);
  resetProvider(reloaded);
  await assert.rejects(reloaded.cancelTool.execute(input, ctx), /already succeeded/u);
  reloaded.provider.order.order_id = OTHER_ID;
  await assert.rejects(reloaded.cancelTool.execute({ order_id: OTHER_ID }, ctx), /conflicts with an existing operation/u);
  assert.equal(reloaded.provider.calls.some(call => call.name === "coinbase_orders_cancel"), false);
});

test("unknown, rejected, or malformed cancellation outcomes retain the approval guard and prevent replay", async () => {
  const cases = [
    { label: "timeout", fail: true },
    { label: "rejected", response: { results: [{ order_id: ORDER_ID, success: false }] } },
    { label: "mismatched", response: { results: [{ order_id: OTHER_ID, success: true }] } },
    { label: "missing", response: { success: true } },
    { label: "unexpected-batch", response: { results: [{ order_id: ORDER_ID, success: true }, { order_id: OTHER_ID, success: true }] } },
  ];
  for (const value of cases) {
    resetProvider();
    const ctx = context(value.label);
    const scope = await approve(ctx);
    if (value.fail) api.provider.fail = true;
    else api.provider.response = value.response;
    await assert.rejects(api.cancelTool.execute(input, ctx), /uncertain|unknown/u);
    assert.equal(await api.releasePhotonApprovalProcessing(ctx.session.id), "retained");
    assert.equal(await api.getCurrentPhotonApprovalActivity(scope), "processing");
    api.provider.fail = false;
    api.provider.response = { results: [{ order_id: ORDER_ID, success: true }] };
    await assert.rejects(api.cancelTool.execute(input, ctx), /already attempted.*uncertain/u);
    assert.equal(api.provider.calls.filter(call => call.name === "coinbase_orders_cancel").length, 1);
  }
});

test("concurrent execution of the same approved cancellation cannot send two mutations", async () => {
  resetProvider();
  const ctx = context("concurrent");
  const results = await Promise.allSettled([
    api.cancelTool.execute(input, ctx), api.cancelTool.execute(input, ctx),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(api.provider.calls.filter(call => call.name === "coinbase_orders_cancel").length, 1);
});
