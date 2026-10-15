import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { startTestRedis } from "./helpers/photon-redis.mjs";

const projectRoot = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(projectRoot, "tests/.workspace-dispatch-"));
const outfile = join(directory, "dispatch.mjs");
after(() => rm(directory, { recursive: true, force: true }));
await build({
  absWorkingDir: projectRoot,
  stdin: { contents: `
    export * from "./agent/schedules/monitors.ts";
    export * from "./agent/lib/workspace-alert-dispatch.ts";
    export * from "./agent/lib/workspace-worker-control-plane.ts";
    export * from "./agent/lib/workspace-worker-runner.ts";
    export * from "./agent/lib/workspace-monitor-lifecycle-contract.ts";
    export * from "./agent/lib/workspace-alert-store.ts";
    export * from "./agent/lib/workspace-monitor-store.ts";
    export * from "./agent/lib/workspace-store-authorization.ts";
    export * from "./agent/lib/photon-workspace-store.ts";
    export * from "./agent/lib/photon-alert-reply-store.ts";
    export * from "./agent/lib/photon-alert-subscription-store.ts";
    export * from "./agent/lib/owner-identity.ts";
  `, resolveDir: projectRoot, loader: "ts" }, outfile,
  bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
  plugins: [{ name: "offline-effects", setup(plugin) {
    // Exercise the real scheduler. Its remote evaluator and delivery adapters
    // are replaced so an unexpected fallback can never call paid/live services.
    plugin.onResolve({ filter: /workspace-evaluator-dispatch|photon-alert-outbound$/ }, (args) => ({ path: args.path, namespace: "offline" }));
    plugin.onLoad({ filter: /.*/, namespace: "offline" }, (args) => ({ loader: "js", contents:
      args.path.endsWith("evaluator-dispatch")
        ? 'export async function runWorkspaceEvaluatorForMonitor(){throw new Error("live_evaluator_forbidden")}'
        : 'export async function sendPhotonWorkspaceAlertCard(){throw new Error("live_delivery_forbidden")}' }));
  } }],
});
const api = await import(pathToFileURL(outfile).href);
const { createWorkspaceMonitorSchedule } = api;
let redis;
before(async () => {
  redis = await startTestRedis();
  process.env.KV_REST_API_URL = redis.url;
  process.env.KV_REST_API_TOKEN = redis.token;
  process.env.PHOTON_ALLOWED_PRINCIPALS = "imessage:+15555550100";
  process.env.EVE_DEPLOYMENT_OWNER_ID = "owner_fixture";
  process.env.EVE_OWNER_ALIAS_HMAC_SECRET = "A".repeat(43);
  process.env.EVE_WORKSPACE_STATE_ENABLED = "1";
  process.env.EVE_WORKSPACE_MONITOR_WRITES_ENABLED = "1";
  process.env.PUBLIC_APP_URL = "https://template.example";
});
after(async () => redis?.close());
const now = new Date("2026-10-15T20:00:00.000Z");
const job = {
  scope: { ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614174000" },
  monitor: { configurationRevision: 1, monitorId: "223e4567-e89b-42d3-a456-426614174000", lifecycleState: "enabled", requiredCapabilityIds: ["evaluate_public_commentary_signals"], managedBy: { packId: "public-commentary-tracker" } },
  occurrence: { attempt: 1, occurrenceKey: "a".repeat(64), scheduledFor: now.toISOString(), leaseTokenDigest: "b".repeat(64) },
  leaseToken: "fixture-lease",
};
const budget = { global: { state: "reserved" }, workspace: { state: "reserved" }, runId: "fixture-run" };
async function dispatch(overrides = {}) {
  const events = [];
  const dependencies = {
    now: () => now,
    resolveRuntimeFlags: () => ({ state: true, dispatch: true, paidResearch: true, photonAlerts: true }),
    claimWorkspaceMonitors: async () => [job],
    emitRuntimeObservation: () => {},
    retryWorkspaceAlerts: async () => {},
    reserveWorkspaceBudget: async () => { events.push("reserved"); return budget; },
    prepareWorkspaceWorker: async () => { events.push("prepared"); return { request: {} }; },
    runWorkspaceEvaluator: async () => { events.push("evaluated"); },
    requireWorkspaceOutcome: async () => { events.push("outcome"); return { outcome: "no_match" }; },
    deliverWorkspaceOutcome: async () => { events.push("delivered"); },
    finishWorkspaceBudget: async (_job, _budget, settlement) => { events.push(`budget:${settlement.outcome}`); },
    recordWorkspaceFailure: async (input) => { events.push(`failure:${input.errorCode}:${input.failureThreshold ?? "default"}`); return {}; },
    releaseWorkspaceLease: async () => { events.push("released"); return true; },
    getWorkspaceMonitor: async () => job.monitor,
    prepareWorkspaceRecovery: async ({ claimed }) => ({ claimed }),
    ...overrides,
  };
  let pending;
  createWorkspaceMonitorSchedule(dependencies).run({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  return events;
}

test("the scheduler orders evaluation, outcome lookup, delivery, and settlement", async () => {
  assert.deepEqual(await dispatch(), ["reserved", "prepared", "evaluated", "outcome", "delivered", "budget:reconciled"]);
});

test("a durable result still reaches the owner when the evaluator fails after committing", async () => {
  const events = await dispatch({ runWorkspaceEvaluator: async () => { throw new Error("after_commit_failure"); } });
  assert.deepEqual(events, ["reserved", "prepared", "outcome", "delivered", "failure:workspace_worker_failed:default", "released", "budget:reconciled"]);
});

test("uncertain X occurrences quarantine without spending again or fabricating recovery", async () => {
  const events = await dispatch({ claimWorkspaceMonitors: async () => [{ ...job, occurrence: { ...job.occurrence, attempt: 2 } }] });
  assert.deepEqual(events, ["failure:worker_recovery_not_applicable:1", "released"]);
});


async function alertFixture(label, presentations) {
  const photonScope = { principalId: process.env.PHOTON_ALLOWED_PRINCIPALS, threadId: `imessage:${label}` };
  const state = await api.getPhotonWorkspaceState(photonScope);
  const identity = api.resolvePhotonOwnerConversationIdentity(photonScope);
  const scope = api.authorizeDeploymentWorkspaceStore({ ownerId: identity.ownerId, workspaceId: state.activeWorkspace.id });
  await api.savePhotonAlertDeliverySubscription({ ...photonScope, ...identity, subscriptionId: identity.conversationId });
  const created = await api.createWorkspaceMonitor({
    deliverySubscriptionId: identity.conversationId, idempotencyKey: label,
    instruction: "Watch for the configured public update.", name: label, nextOccurrenceAt: now.toISOString(), now, scope,
    lifecycleContractId: api.PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
    managedBy: { kind: "strategy_pack", bindingRevision: 1, packContentDigest: "a".repeat(64), packId: "public-commentary-tracker", packVersion: "1.5.4", resourceId: "evaluate-public-commentary" },
    requiredCapabilityIds: ["evaluate_public_commentary_signals"],
    schedule: { kind: "interval", anchor: now.toISOString(), everyMinutes: 30 },
    sources: [{ accessClassification: "public", sourceId: "x.fixture", origin: "https://api.x.com", canonicalUrl: "https://api.x.com/2/users/123456/tweets" }],
  });
  const monitor = await api.updateWorkspaceMonitor({ scope, monitorId: created.monitorId, expectedRevision: created.configurationRevision, now,
    patch: { lifecycleState: "enabled", nextOccurrenceAt: now.toISOString(), pauseReason: null, pausedAt: null } });
  const finding = { accessClassification: "public", artifactRefs: [], asOf: now.toISOString(), contentHash: "d".repeat(64),
    findingId: `finding_${label}`, monitorId: monitor.monitorId, ownerId: scope.ownerId, recordType: "finding", runId: "fixture-run",
    schemaVersion: 1, state: "staged", strategyPack: null, workspaceId: scope.workspaceId, summary: "A configured public update matched.",
    provenance: [{ accessClassification: "public", canonicalUrl: "https://x.com/example/status/123", origin: "https://x.com", sourceId: "x.fixture" }] };
  const stagedJob = { ...job, scope, monitor };
  if (presentations.length) await api.stageWorkspaceAlertPresentations({ alertPresentations: presentations, finding, monitor, now, scope });
  return { finding, job: stagedJob, photonScope, identity };
}

test("persisted matching presentations reach their session once through real dispatch", async () => {
  const fixture = await alertFixture("multi-presentations", [
    { key: "post-one", title: "First market update", whyMatched: "The first watched topic matched." },
    { key: "post-two", title: "Second market update", whyMatched: "The second watched topic matched." },
  ]);
  const sent = [];
  const input = { job: fixture.job, outcome: { finding: fixture.finding }, clients: { send: async (card, destination) => {
    sent.push({ card, destination }); return { messageId: `message-${sent.length}` };
  } } };
  await api.deliverWorkspaceOutcomeToPhoton(input);
  await api.deliverWorkspaceOutcomeToPhoton(input);
  assert.equal(sent.length, 2, "every persisted presentation is delivered once");
  assert(sent.some(({ card }) => card.fallbackText.includes("First market update")));
  assert(sent.some(({ card }) => card.fallbackText.includes("Second market update")));
  assert(sent.every(({ destination }) => destination === fixture.photonScope.threadId));
  const recent = await api.readRecentPhotonAlerts(fixture.identity.conversationId);
  assert.equal(recent.length, 2);
  assert(recent.every((alert) => alert.workspaceId === fixture.job.scope.workspaceId));
  await assert.rejects(api.deliverWorkspaceOutcomeToPhoton({ ...input, outcome: { finding: { ...fixture.finding, findingId: "finding_missing" } } }), /workspace_alert_unavailable/);
});

test("a pre-send preparation failure is retried by the schedule without rerunning research", async () => {
  const fixture = await alertFixture("retry-preparation", [{ key: "post", title: "Retry this alert", whyMatched: "A configured public update." }]);
  // URL construction is a pre-send preparation step; no provider receives anything.
  delete process.env.PUBLIC_APP_URL;
  await assert.rejects(api.deliverWorkspaceOutcomeToPhoton({ job: fixture.job, outcome: { finding: fixture.finding } }), /deployment URL/);
  process.env.PUBLIC_APP_URL = "https://template.example";
  const sent = [];
  const recovery = { now: () => new Date(now.getTime() + 120_000), claimWorkspaceMonitors: async () => [],
    runWorkspaceEvaluator: async () => { throw new Error("research_must_not_repeat"); },
  };
  // The production scheduler owns retry consumption; only the transport is offline.
  recovery.retryWorkspaceAlerts = (input) => api.retryPendingWorkspaceAlertsToPhoton({ ...input,
    clients: { send: async (card) => { sent.push(card); return { messageId: "recovered-message" }; } } });
  await dispatch(recovery);
  await dispatch(recovery);
  assert.equal(sent.length, 1, "the committed alert survives a transient pre-send failure");
});

test("known-unstarted preparation failure releases budget and requeues safely", async () => {
  const events = await dispatch({ prepareWorkspaceWorker: async () => { throw new Error("temporary_state_read_failure"); } });
  assert.deepEqual(events, ["reserved", "budget:released", "failure:worker_preparation_failed:default", "released"]);
});


test("known-unstarted Redis retries preserve the initial window and consume their proof once", async () => {
  const fixture = await alertFixture("known-unstarted-window", []);
  const monitor = fixture.job.monitor;
  const claim = await api.claimWorkspaceMonitorOccurrence({ scope: fixture.job.scope, monitorId: monitor.monitorId,
    configurationRevision: monitor.configurationRevision, occurrenceIdentity: `interval:${now.toISOString()}`,
    scheduledFor: now.toISOString(), now, leaseForMs: 60_000 });
  const claimed = { ...fixture.job, ...claim };
  const firstWindow = api.resolveWorkspaceWorkerEvaluationWindow(claimed);
  assert.deepEqual(firstWindow, { startAt: "2026-10-15T19:30:00.000Z", endAt: now.toISOString() });
  await dispatch({ claimWorkspaceMonitors: async () => [claimed],
    prepareWorkspaceWorker: async () => { throw new Error("temporary_state_read_failure"); },
    recordWorkspaceFailure: api.recordWorkspaceMonitorFailure,
    releaseWorkspaceLease: api.releaseWorkspaceMonitorLease });
  const unchanged = await api.getWorkspaceMonitor(claimed.scope, monitor.monitorId);
  assert.equal(unchanged.lifecycleState, "enabled");
  assert.equal(unchanged.sourceCheckpoint.watermark, null, "retry proof never fabricates source coverage");
  // Even after a later cadence boundary, recover the original unstarted window.
  const later = new Date(now.getTime() + 31 * 60_000);
  const retries = await api.claimDueWorkspaceMonitors({ now: later, leaseForMs: 60_000, limit: 20, recoveryWindowMs: 6 * 60 * 60_000 });
  const retry = retries.find((candidate) => candidate.monitor.monitorId === monitor.monitorId);
  assert.ok(retry, "known-unstarted preparation must release and requeue the original occurrence");
  assert.equal(retry.occurrence.attempt, 2);
  assert.equal(retry.occurrence.retryableBeforeExecution, true);
  assert.deepEqual(api.resolveWorkspaceWorkerEvaluationWindow(retry), firstWindow);
  assert.equal(retry.occurrence.occurrenceKey, claimed.occurrence.occurrenceKey);
  const events = await dispatch({ claimWorkspaceMonitors: async () => [retry] });
  assert.deepEqual(events, ["reserved", "prepared", "evaluated", "outcome", "delivered", "budget:reconciled"],
    "a durable unstarted proof admits a new attempt instead of quarantining it");
  // Simulate a process loss after that claim: a subsequent ordinary release has
  // no proof that evaluation stayed unstarted, so the next attempt quarantines.
  await api.releaseWorkspaceMonitorLease({ scope: retry.scope, monitorId: monitor.monitorId, leaseToken: retry.leaseToken });
  const following = (await api.claimDueWorkspaceMonitors({ now: later, leaseForMs: 60_000, limit: 20, recoveryWindowMs: 6 * 60 * 60_000 }))
    .find((candidate) => candidate.monitor.monitorId === monitor.monitorId);
  assert.equal(following.occurrence.retryableBeforeExecution, false);
  const held = await dispatch({ claimWorkspaceMonitors: async () => [following] });
  assert.deepEqual(held, ["failure:worker_recovery_not_applicable:1", "released"]);
});

test("alert recovery holds uncertain or in-flight acceptance and respects archived sessions", async () => {
  const fixture = await alertFixture("uncertain-alert", [{ key: "post", title: "Accepted status unknown", whyMatched: "A configured public update." }]);
  let attempts = 0;
  await assert.rejects(api.deliverWorkspaceOutcomeToPhoton({ job: fixture.job, outcome: { finding: fixture.finding },
    clients: { send: async () => { attempts++; throw new Error("connection_lost_after_acceptance"); } } }), /uncertain/);
  await api.retryPendingWorkspaceAlertsToPhoton({ now: new Date(now.getTime() + 120_000),
    clients: { send: async () => { attempts++; return { messageId: "must-not-send" }; } } });
  assert.equal(attempts, 1);
  assert.equal((await api.getWorkspaceMonitor(fixture.job.scope, fixture.job.monitor.monitorId)).lifecycleState, "paused_failure");

  const interrupted = await alertFixture("interrupted-alert", [{ key: "post", title: "In flight", whyMatched: "A configured public update." }]);
  const alert = await api.readWorkspaceAlert(interrupted.job.scope, interrupted.finding.findingId);
  const staged = await api.stageWorkspaceAlertDelivery({ alert, destination: interrupted.photonScope.threadId,
    now, scope: interrupted.job.scope, subscriptionId: interrupted.identity.conversationId });
  await api.claimWorkspaceAlertDelivery({ deliveryId: staged.deliveryId, now, scope: interrupted.job.scope });
  await api.retryPendingWorkspaceAlertsToPhoton({ now: new Date(now.getTime() + 31 * 60_000),
    clients: { send: async () => { throw new Error("in_flight_send_must_not_repeat"); } } });
  assert.equal((await api.readWorkspaceAlertDelivery(interrupted.job.scope, staged.deliveryId)).state, "delivery_uncertain");
  assert.equal((await api.getWorkspaceMonitor(interrupted.job.scope, interrupted.job.monitor.monitorId)).lifecycleState, "paused_failure");

  const archived = await alertFixture("archived-alert", [{ key: "post", title: "Old session", whyMatched: "A configured public update." }]);
  await api.suspendWorkspaceMonitorsForArchive({ scope: archived.job.scope, now });
  await api.retryPendingWorkspaceAlertsToPhoton({ now: new Date(now.getTime() + 120_000),
    clients: { send: async () => { throw new Error("archived_session_must_not_receive"); } } });
});
