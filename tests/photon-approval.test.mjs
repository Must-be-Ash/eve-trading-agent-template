import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { startTestRedis } from "./helpers/photon-redis.mjs";

const output = await build({
  stdin: {
    contents: `export * from './agent/lib/photon-approval-store.ts';
      export * from './agent/lib/photon-approval.ts';
      export * from './agent/lib/photon-auth.ts';
      export * from './agent/lib/photon-mini-app.ts';
      export { default as approvalApp } from './agent/channels/photon-approval-app.ts';`,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts",
  }, bundle: true, packages: "external", platform: "node", format: "esm", write: false,
});
const directory = await mkdtemp(new URL(".photon-tests-", import.meta.url));
const file = `${directory}/owners.mjs`;
await writeFile(file, output.outputFiles[0].text);
let owners;
try { owners = await import(pathToFileURL(file)); }
finally { await rm(directory, { recursive: true, force: true }); }

const principalId = "imessage:+15555550123";
const scope = (suffix) => ({ principalId, threadId: `imessage:thread-${suffix}`, sessionId: `session-${suffix}` });
const prompt = (suffix, expiresAtMs = Date.now() + 60_000) => ({ approvalText: "Buy 25 USD of BTC?", expiresAtMs, requestId: `request-${suffix}`, toolName: "coinbase_create_order" });
const post = (path, body, headers = {}) => new Request(`https://template.example${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
const handler = (suffix, method = "POST") => owners.approvalApp.routes.find((route) => route.method === method && route.path === `/eve/v1/photon-approval${suffix}`).handler;

// This is the primary approval-state contract: real Redis executes all Lua,
// including races, token reservation, timestamp admission and retained guards.
test("approval lifecycle is atomic, one-use, sender-bound, and retains uncertain orders", async () => {
  const redis = await startTestRedis();
  process.env.KV_REST_API_URL = redis.url;
  process.env.KV_REST_API_TOKEN = redis.token;
  process.env.PHOTON_ALLOWED_PRINCIPALS = principalId;
  try {
    const current = scope("one");
    const saved = await owners.savePhotonApproval({ ...current, prompt: prompt("one") });
    assert.match(saved.approvalToken, /^[\w-]{43}$/);
    assert.equal((await owners.getPhotonApprovalView(saved.approvalToken)).status, "opening");
    assert.equal((await owners.claimCurrentPhotonApprovalDecision({ ...current, decision: "approve" })).status, "unavailable");
    const replay = await owners.savePhotonApproval({ ...current, prompt: prompt("one") });
    assert.equal(replay.reused, true);
    assert.equal(replay.approvalToken, undefined);
    const values = await Promise.all((await redis.command("KEYS", "*")).map((key) => redis.command("GET", key)));
    assert.equal(values.some((value) => value.includes(saved.approvalToken)), false, "only the bearer hash may be stored");
    await owners.activatePhotonApproval({ ...current, approvalToken: saved.approvalToken });
    assert.equal((await owners.claimCurrentPhotonApprovalDecision({ ...current, decision: "approve", decisionSentAtMs: 1 })).status, "stale");
    assert.equal((await owners.claimCurrentPhotonApprovalDecision({ ...current, principalId: "imessage:+15555550999", decision: "approve" })).status, "missing");
    assert.equal(await owners.claimPhotonApprovalEvent({ ...current, eventId: "inbound-one" }), true);
    assert.equal(await owners.claimPhotonApprovalEvent({ ...current, eventId: "inbound-one" }), false);

    const claims = await Promise.all([
      owners.claimPhotonApprovalDecision({ approvalToken: saved.approvalToken, decision: "approve" }),
      owners.claimPhotonApprovalDecision({ approvalToken: saved.approvalToken, decision: "approve" }),
    ]);
    assert.equal(claims.filter((claim) => claim.status === "deliver").length, 1);
    assert.equal(claims.filter((claim) => claim.status === "processing").length, 1);
    const accepted = claims.find((claim) => claim.status === "deliver");
    assert.equal((await owners.claimPhotonApprovalDecision({ approvalToken: saved.approvalToken, decision: "deny" })).status, "conflict");
    assert.equal(await owners.getCurrentPhotonApprovalActivity(current), "processing");
    await owners.completePhotonApprovalDecision(accepted.delivery);
    await owners.markPhotonApprovalExecution({ sessionId: current.sessionId, state: "uncertain" });
    assert.equal(await owners.releasePhotonApprovalProcessing(current.sessionId), "retained");
    assert.equal(await redis.command("TTL", accepted.delivery.recordKey), -1, "uncertain execution cannot time out into a fresh order");
    await assert.rejects(owners.savePhotonApproval({ ...current, prompt: prompt("other") }), /already active/);
    await owners.markPhotonApprovalExecution({ sessionId: current.sessionId, state: "succeeded" });
    assert.equal(await owners.releasePhotonApprovalProcessing(current.sessionId), "released");
    assert.equal(await owners.getCurrentPhotonApprovalActivity(current), null);
    assert.equal((await owners.getPhotonApprovalView(saved.approvalToken)).status, "delivered");

    const expiredScope = scope("expired");
    const expired = await owners.savePhotonApproval({ ...expiredScope, prompt: prompt("expired", Date.now() - 1) });
    await owners.activatePhotonApproval({ ...expiredScope, approvalToken: expired.approvalToken });
    const expiredClaim = await owners.claimPhotonApprovalDecision({ approvalToken: expired.approvalToken, decision: "approve" });
    assert.equal(expiredClaim.status, "deliver");
    assert.equal(expiredClaim.delivery.decision, "deny");
    assert.equal(expiredClaim.delivery.expired, true);
    await owners.completePhotonApprovalDecision(expiredClaim.delivery);
    assert.equal(await owners.getCurrentPhotonApprovalActivity(expiredScope), null);

    const draftScope = scope("aborted-delivery");
    const draft = await owners.savePhotonApproval({ ...draftScope, prompt: prompt("draft") });
    const cancel = await owners.claimCurrentPhotonApprovalDecision({ ...draftScope, decision: "deny" });
    assert.equal(cancel.status, "deliver", "owner can cancel a card delivery that never activated");
    await owners.completePhotonApprovalDecision(cancel.delivery);
    assert.equal((await owners.getPhotonApprovalView(draft.approvalToken)).decision, "deny");

    const appScope = scope("app");
    const appApproval = await owners.savePhotonApproval({ ...appScope, prompt: prompt("app") });
    await owners.activatePhotonApproval({ ...appScope, approvalToken: appApproval.approvalToken });
    const responses = [];
    const requestBody = { approvalToken: appApproval.approvalToken, decision: "approve" };
    const args = { attachSession: (id) => ({ respond: async (inputResponses, options) => {
      responses.push({ id, inputResponses, options });
      return { sessionId: id, status: "accepted" };
    } }) };
    const response = await handler("/decision")(post("/eve/v1/photon-approval/decision", requestBody), args);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "approved");
    assert.deepEqual(responses[0].inputResponses, [{ requestId: "request-app", optionId: "approve" }]);
    assert.equal(responses[0].id, appScope.sessionId);
    assert.equal(responses[0].options.auth.principalId, principalId);
    await handler("/decision")(post("/eve/v1/photon-approval/decision", requestBody), args);
    assert.equal(responses.length, 1, "repeat button cannot deliver another approval");

    const revokedScope = scope("revoked");
    const revoked = await owners.savePhotonApproval({ ...revokedScope, prompt: prompt("revoked") });
    await owners.activatePhotonApproval({ ...revokedScope, approvalToken: revoked.approvalToken });
    const guardsBeforeRevocation = (await redis.command("KEYS", "eve:photon:v3:processing-approval:*")).sort();
    delete process.env.PHOTON_ALLOWED_PRINCIPALS;
    const denied = await handler("/decision")(post("/eve/v1/photon-approval/decision", { approvalToken: revoked.approvalToken, decision: "approve" }), args);
    assert.equal(denied.status, 409);
    assert.equal(responses.length, 1, "revoked owner cannot use an old bearer");
    assert.deepEqual((await redis.command("KEYS", "eve:photon:v3:processing-approval:*")).sort(), guardsBeforeRevocation, "a definitely undelivered decision must not leave a permanent processing guard");
  } finally { await redis.close(); }
});

test("approval app rejects oversized and cross-origin JSON and isolates its bearer page", async () => {
  const route = handler("/decision");
  assert.equal((await route(post("/eve/v1/photon-approval/decision", {}, { origin: "https://attacker.example" }), {})).status, 403);
  assert.equal((await route(post("/eve/v1/photon-approval/decision", { data: "x".repeat(1100) }), {})).status, 413);
  const page = await handler("", "GET")(new Request("https://template.example/eve/v1/photon-approval"));
  assert.match(page.headers.get("cache-control"), /no-store/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);
});

test("exact supported order summaries clamp to the preview and keep mini-apps on this app", () => {
  const now = Date.now();
  const previewToken = `${Buffer.from(JSON.stringify({ expiresAtMs: now + 30_000 })).toString("base64url")}.fixture`;
  const request = (input) => ({ kind: "tool-approval", requestId: "request", action: { toolName: "coinbase_create_order", input: { previewToken, ...input } } });
  for (const [input, expected] of [
    [{ productId: "BTC-USD", side: "BUY", type: "market", quoteSize: "25" }, "Buy 25 USD of BTC?"],
    [{ productId: "ETH-USDC", side: "SELL", type: "limit", baseSize: "0.5", limitPrice: "5000" }, "Sell 0.5 ETH at 5000 USDC?"],
    [{ productId: "BTC-USD", side: "BUY", type: "stop_limit", baseSize: "0.01", limitPrice: "50000", stopPrice: "49000", stopDirection: "up" }, "Buy 0.01 BTC at 50000 USD after up stop 49000?"],
  ]) {
    const prompt = owners.createPhotonApprovalPrompt(request(input), now);
    assert.equal(prompt.approvalText, expected);
    assert.equal(prompt.expiresAtMs, now + 30_000);
  }
  assert.throws(() => owners.createPhotonApprovalPrompt({ ...request({}), action: { toolName: "unknown_write", input: {} } }), /cannot be approved/);
  assert.throws(() => owners.createPhotonApprovalPrompt(request({ productId: "BTC-USD", side: "BUY", type: "market" })), /exact approval/);
  assert.equal(owners.parsePhotonTextDecision("YES!"), "approve");
  assert.equal(owners.parsePhotonTextDecision("no."), "deny");
  assert.equal(owners.parsePhotonTextDecision("yes, buy twice"), null);
  process.env.PHOTON_ALLOWED_PRINCIPALS = `${principalId},imessage:+15555550999`;
  assert.equal(owners.isPhotonPrincipalAllowed(principalId), false);
  process.env.PHOTON_ALLOWED_PRINCIPALS = principalId;
  assert.equal(owners.isPhotonPrincipalAllowed(principalId), true);
  process.env.PUBLIC_APP_URL = "https://template.example";
  const token = "A".repeat(43);
  const url = new URL(owners.photonApprovalAppUrl(token));
  assert.equal(url.hash, `#${token}`);
  assert.equal(url.search, "");
  assert.equal(owners.photonArtifactPresentation("https://miniup.app/anything"), null);
  assert.equal(owners.photonArtifactPresentation("https://attacker.example/artifacts/abc"), null);
});
