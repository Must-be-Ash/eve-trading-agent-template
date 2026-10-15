import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(projectRoot, "tests/.x-monitor-"));
const bundlePath = join(directory, "runtime.mjs");
await build({
  absWorkingDir: projectRoot,
  stdin: { contents: `
    export * from "./agent/lib/x-public-identity.ts";
    export * from "./agent/lib/x-public-statement-adapter.ts";
    export * from "./agent/lib/x-public-statement-rehydration-store.ts";
    export * from "./agent/lib/public-source-registry.ts";
    export * from "./agent/lib/public-source-acquisition-store.ts";
    export * from "./agent/lib/public-source-coordinator.ts";
    export * from "./agent/lib/public-source-workspace-reference.ts";
    export * from "./agent/lib/public-source-subscription-store.ts";
    export * from "./agent/lib/revocable-evidence-store.ts";
    export * from "./agent/lib/public-commentary-schema.ts";
    export * from "./agent/lib/strategy-pack-catalog.ts";
    export { resolveStrategyPackConfiguration, resolveStrategyPackSourceInstances, resolveStrategyPackWorkerModelPolicy } from "./agent/lib/strategy-pack-service.ts";
    export { authorizeDeploymentWorkspaceStore } from "./agent/lib/workspace-store-authorization.ts";
  `, resolveDir: projectRoot, loader: "ts" },
  bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundlePath, logLevel: "silent",
});
const api = await import(pathToFileURL(bundlePath).href);
after(() => rm(directory, { recursive: true, force: true }));
class Store {
  values = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async compareAndSet(key, expected, next) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next); return true;
  }
  async delete(key) { this.values.delete(key); }
}
const SOURCE_ID = "x-public-commentary-user.123456789.fixture_desk";
const source = api.resolveReviewedPublicSource(SOURCE_ID);
const window = { startAt: "2026-01-01T12:00:00.000Z", endAt: "2026-01-01T12:10:00.000Z" };
const identity = { displayName: "Fixture Desk", numericUserId: "123456789", profileUrl: "https://x.com/fixture_desk", username: "fixture_desk" };
const identityValue = [identity.profileUrl, identity.username, identity.displayName, identity.numericUserId, "confirmed"];
function evidence(client) { return { client, encryptionKey: new Uint8Array(32).fill(7), keyReference: "kms://fixture-key" }; }
function post(id, text = "Fixture market statement.") {
  return { id, text, author_id: identity.numericUserId, conversation_id: id, created_at: "2026-01-01T12:01:00.000Z", edit_controls: { editable_until: "2026-01-01T12:31:00.000Z" }, edit_history_tweet_ids: [id] };
}
function response(request, data, meta = {}, status = 200) {
  return { body: JSON.stringify({ data, meta }), requestedUrl: request.url, finalUrl: request.url, observedAt: window.endAt, rateLimit: 10000, rateRemaining: 9999, rateReset: 1767270600, status };
}

test("X setup requires owner configuration and binds a resolved identity receipt to owner, session, identity, and expiry", async () => {
  const pack = api.strategyPackCatalog.resolve({ id: "public-commentary-tracker", version: "1.5.4" });
  assert.throws(() => api.resolveStrategyPackConfiguration(pack, {}), /strategy_pack_invalid_request/);
  const configuration = { xIdentity: identityValue, monitoringObjective: "Watch public comments about market liquidity.", topics: ["liquidity"], impactHypotheses: ["improving liquidity|BTC|up"] };
  const resolved = api.resolveStrategyPackConfiguration(pack, configuration);
  assert.equal(resolved.configuration.alerts, "disabled");
  assert.equal(pack.monitors[0].activationDefault, "paused");
  assert.equal(api.resolveStrategyPackSourceInstances(pack, resolved.configuration)[0].canonicalUrl, "https://api.x.com/2/users/123456789/tweets");
  assert.throws(() => api.resolveReviewedPublicSource("public-commentary-tracker-source"), /public_source_not_reviewed/);
  assert.deepEqual(api.resolveStrategyPackWorkerModelPolicy({ pack, environment: {} }).allowedModelIds, ["google/gemini-3.7-flash", "openai/gpt-5.4-mini"]);
  let requested;
  const resolvedIdentity = await api.resolveXPublicIdentity({ profile: "@fixture_desk", environment: { X_BEARER_TOKEN: "fixture-token" }, fetchImpl: async (url, init) => {
    requested = { url: String(url), authorization: new Headers(init.headers).get("authorization") };
    return new Response(JSON.stringify({ data: { id: identity.numericUserId, name: identity.displayName, username: identity.username } }), { status: 200 });
  } });
  assert.deepEqual(resolvedIdentity, identity);
  assert.equal(requested.authorization, "Bearer fixture-token");
  assert.equal(new URL(requested.url).pathname, "/2/users/by/username/fixture_desk");
  const secret = "fixture-identity-signing-secret-at-least-32";
  const scope = { principalId: "owner_fixture", threadId: "conversation_fixture", issuedAt: new Date(window.startAt) };
  const receipt = api.mintXPublicIdentityResolutionReceipt(identity, scope, secret);
  api.verifyXPublicIdentityResolutionReceipt(receipt, identity, { ...scope, now: new Date(window.endAt) }, secret);
  for (const override of [{ principalId: "other_owner" }, { threadId: "other_session" }, { now: new Date("2026-01-01T12:16:00.000Z") }]) {
    assert.throws(() => api.verifyXPublicIdentityResolutionReceipt(receipt, identity, { ...scope, now: new Date(window.endAt), ...override }, secret), /receipt_invalid/);
  }
  assert.throws(() => api.verifyXPublicIdentityResolutionReceipt(receipt, { ...identity, numericUserId: "999" }, { ...scope, now: new Date(window.endAt) }, secret), /receipt_invalid/);
});

test("X requests are bounded and paid multi-page continuation resumes without replaying paid reads", async () => {
  assert.throws(() => api.createXTimelineRequest({ sourceInstance: source.sourceInstance }), /x_timeline_request_unbounded/);
  const firstRequest = new URL(api.createXTimelineRequest({ fallbackStartAt: window.startAt, sourceInstance: source.sourceInstance }).url);
  assert.equal(firstRequest.searchParams.get("start_time"), window.startAt);
  assert.equal(firstRequest.searchParams.get("exclude"), "retweets,replies");
  const store = new Store(); const requests = [];
  const fetchResponse = async request => {
    const token = new URL(request.url).searchParams.get("pagination_token"); requests.push(token);
    if (token === null) return response(request, [post("100")], { next_token: "second" });
    if (token === "second") return response(request, [post("101")], { next_token: "third" });
    assert.equal(token, "third"); return response(request, [post("102")], { newest_id: "102" });
  };
  const first = await api.runSharedXPublicStatementAcquisition({ client: store, evidence: evidence(store), fetchResponse, firstRunStartAt: window.startAt, sourceId: SOURCE_ID, window });
  assert.equal(first.acquisition.errorCode, "pagination_bounds_exceeded");
  assert.equal(first.statements.length, 0);
  assert.equal(first.receipt.billablePostReads, 2);
  const nextWindow = { startAt: window.endAt, endAt: "2026-01-01T12:20:00.000Z" };
  const complete = await api.runSharedXPublicStatementAcquisition({ client: store, evidence: evidence(store), fetchResponse, sourceId: SOURCE_ID, window: nextWindow });
  assert.equal(complete.acquisition.status, "complete");
  assert.equal(complete.statements.length, 3);
  assert.equal(complete.receipt.billablePostReads, 1);
  assert.deepEqual(requests, [null, "second", "third"]);
  assert.equal((await api.readPublicSourceInstance(source.sourceInstance.sourceInstanceId, store)).cursor.watermark, "102");
  const replay = await api.runSharedXPublicStatementAcquisition({ client: store, evidence: evidence(store), fetchResponse: async () => { throw new Error("must not refetch committed acquisition"); }, sourceId: SOURCE_ID, window: nextWindow });
  assert.equal(replay.reused, true);
  assert.equal(replay.acquisition.acquisitionId, complete.acquisition.acquisitionId);
  assert.ok(!JSON.stringify(complete).includes("Fixture market statement."));
});

test("X acquisition projects only into its authorized session and encrypted evidence can be revoked", async () => {
  const store = new Store(); const workspaceId = "123e4567-e89b-42d3-a456-426614174201";
  const scope = api.authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId }, { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" });
  const otherScope = api.authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614174202" }, { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" });
  const monitorId = "monitor.fixture";
  const reference = api.resolvePublicSourceWorkspaceReference({ monitorId, sourceId: SOURCE_ID, workspaceId });
  const monitor = { lifecycleState: "enabled", managedBy: null, monitorId, publicSourceSubscriptions: [reference], workspaceId };
  const input = { clients: { acquisition: store, subscription: store }, environment: { EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1", EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1", EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: "1" }, fetch: { adapterId: "x-public-statements", evidence: evidence(store), firstRunStartAt: window.startAt, fetchResponse: async request => response(request, [post("100", "A bounded public statement.")], { newest_id: "100" }) }, monitor, scope, sourceId: SOURCE_ID, window };
  const result = await api.coordinatePublicSourceOccurrence(input);
  assert.equal(result.projection.projections.length, 1);
  assert.equal(result.projection.projections[0].projection.workspaceId, workspaceId);
  await assert.rejects(api.coordinatePublicSourceOccurrence({ ...input, scope: otherScope }), /public_source_reference_invalid/);
  const fact = result.projection.projections[0].fact;
  const envelopeId = fact.payload.statement.contentReference.envelopeId;
  const envelope = await api.readRevocableEvidenceEnvelope(envelopeId, store);
  assert.ok(envelope);
  assert.ok(![...store.values.values()].some(value => value.includes("A bounded public statement.")));
  assert.equal(await api.readRevocableEvidencePayload({ client: store, encryptionKey: evidence(store).encryptionKey, envelopeId }), "A bounded public statement.");
  await api.purgeRevocableEvidence({ client: store, envelopeId, lifecycle: "deleted", reason: "provider_deleted", observedAt: window.endAt });
  const revoked = await api.readRevocableEvidenceEnvelope(envelopeId, store);
  assert.equal(revoked.payloadDeletion.state, "confirmed");
  assert.equal(await api.readRevocableEvidencePayload({ client: store, encryptionKey: evidence(store).encryptionKey, envelopeId }), null);
});
