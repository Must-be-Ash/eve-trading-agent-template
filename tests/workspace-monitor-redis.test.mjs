import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { startTestRedis } from "./helpers/photon-redis.mjs";

const projectRoot = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(projectRoot, "tests/.workspace-monitors-"));
const outfile = join(directory, "runtime.mjs");
await build({
  absWorkingDir: projectRoot,
  stdin: { contents: `
    export * from "./agent/lib/workspace-monitor-store.ts";
    export * from "./agent/lib/workspace-store-authorization.ts";
    export * from "./agent/lib/workspace-monitor-lifecycle-contract.ts";
    export * from "./agent/lib/workspace-runtime-scope.ts";
    export * from "./agent/lib/photon-auth.ts";
    export { default as updateTool } from "./agent/tools/update_workspace_monitor.ts";
  `, resolveDir: projectRoot, loader: "ts" },
  outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const api = await import(pathToFileURL(outfile).href);
const environmentNames = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "EVE_DEPLOYMENT_OWNER_ID", "PHOTON_ALLOWED_PRINCIPALS", "EVE_OWNER_ALIAS_HMAC_SECRET", "EVE_WORKSPACE_STATE_ENABLED", "EVE_WORKSPACE_MONITOR_WRITES_ENABLED"];
const saved = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
let redis;
before(async () => {
  redis = await startTestRedis();
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = redis.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = redis.token;
  process.env.EVE_DEPLOYMENT_OWNER_ID = "owner_fixture";
  process.env.PHOTON_ALLOWED_PRINCIPALS = "imessage:+15555550100";
  process.env.EVE_OWNER_ALIAS_HMAC_SECRET = "A".repeat(43);
  process.env.EVE_WORKSPACE_STATE_ENABLED = "1";
  process.env.EVE_WORKSPACE_MONITOR_WRITES_ENABLED = "1";
});
after(async () => {
  await redis?.close();
  await rm(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
const owner = { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" };
const scope = api.authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614174000" }, owner);
const otherScope = api.authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId: "223e4567-e89b-42d3-a456-426614174000" }, owner);
const now = new Date("2026-10-15T20:00:00.000Z");
const scheduledFor = now.toISOString();

async function pausedMonitor(idempotencyKey) {
  return api.createWorkspaceMonitor({
    deliverySubscriptionId: "delivery.fixture", idempotencyKey,
    instruction: "Watch the configured public account for a matching update.",
    lifecycleContractId: api.PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
    managedBy: { kind: "strategy_pack", bindingRevision: 1, packContentDigest: "a".repeat(64), packId: "public-commentary-tracker", packVersion: "1.5.4", resourceId: "evaluate-public-commentary" },
    name: idempotencyKey, nextOccurrenceAt: scheduledFor, now, scope,
    requiredCapabilityIds: ["evaluate_public_commentary_signals"],
    schedule: { kind: "interval", anchor: scheduledFor, everyMinutes: 30 },
    sources: [{ accessClassification: "public", sourceId: "x.fixture", origin: "https://api.x.com", canonicalUrl: "https://api.x.com/2/users/123456/tweets" }],
  });
}
async function enable(monitor) {
  return api.updateWorkspaceMonitor({ scope, monitorId: monitor.monitorId, expectedRevision: monitor.configurationRevision, now,
    patch: { lifecycleState: "enabled", nextOccurrenceAt: scheduledFor, pauseReason: null, pausedAt: null } });
}
function claimInput(monitor) {
  return { scope, monitorId: monitor.monitorId, configurationRevision: monitor.configurationRevision, now,
    leaseForMs: 60_000, occurrenceIdentity: `interval:${scheduledFor}`, scheduledFor };
}

test("managed monitors start paused, remain isolated, and cannot dispatch after archive/restore", async () => {
  const created = await pausedMonitor("paused-isolated");
  assert.equal(created.lifecycleState, "paused");
  assert.equal((await pausedMonitor("paused-isolated")).monitorId, created.monitorId);
  assert.equal(await api.getWorkspaceMonitor(otherScope, created.monitorId), null);
  assert.deepEqual(await api.listWorkspaceMonitors(otherScope), []);
  await assert.rejects(api.claimWorkspaceMonitorOccurrence(claimInput(created)), /monitor_occurrence_not_due/);
  const enabled = await enable(created);
  assert.equal(enabled.activationWatermark, scheduledFor);
  await api.suspendWorkspaceMonitorsForArchive({ scope, now });
  const restored = await api.pauseWorkspaceMonitorsAfterRestore({ scope, now });
  assert.equal(restored.find((item) => item.monitorId === created.monitorId).lifecycleState, "paused");
  await assert.rejects(api.claimWorkspaceMonitorOccurrence(claimInput(restored[0])), /monitor_occurrence_not_due/);
});

test("Redis admits one concurrent occurrence and rejects stale checkpoint writes and replay", async () => {
  const monitor = await enable(await pausedMonitor("one-occurrence"));
  const input = claimInput(monitor);
  const claims = await Promise.allSettled([api.claimWorkspaceMonitorOccurrence(input), api.claimWorkspaceMonitorOccurrence(input)]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(claims.find((result) => result.status === "rejected").reason.message, /monitor_occurrence_leased/);
  const claimed = claims.find((result) => result.status === "fulfilled").value;
  const completion = { scope, monitorId: monitor.monitorId, configurationRevision: monitor.configurationRevision,
    occurrenceKey: claimed.occurrence.occurrenceKey, leaseTokenDigest: claimed.occurrence.leaseTokenDigest,
    contentDigest: "b".repeat(64), watermark: scheduledFor, scheduledFor, completedAt: now };
  await assert.rejects(api.completeWorkspaceMonitorCheckpoint({ ...completion, leaseTokenDigest: "c".repeat(64) }), /monitor_occurrence_stale/);
  const completed = await api.completeWorkspaceMonitorCheckpoint(completion);
  assert.equal(completed.sourceCheckpoint.watermark, scheduledFor);
  assert.equal(completed.nextOccurrenceAt, "2026-10-15T20:30:00.000Z");
  assert.deepEqual(await api.completeWorkspaceMonitorCheckpoint(completion), completed);
  await assert.rejects(api.claimWorkspaceMonitorOccurrence(input), /monitor_occurrence_not_due|monitor_occurrence_duplicate/);
});

test("schedule changes preserve managed X binding and reject edits that invalidate its source contract", async () => {
  const monitor = await pausedMonitor("schedule-edit");
  const threadId = "imessage:fixture-thread";
  const runtimeScope = api.projectPhotonWorkspaceRuntimeScope({ generation: 1,
    principalId: process.env.PHOTON_ALLOWED_PRINCIPALS, threadId, workspaceId: scope.workspaceId });
  const ctx = { session: { auth: { current: api.photonAuth("+15555550100", threadId, runtimeScope) } } };
  for (const patch of [{ instruction: "Replace the bound strategy" }, { sources: monitor.sources }, { requiredCapabilityIds: [] }, { addSources: monitor.sources }]) {
    await assert.rejects(api.updateTool.execute({ expectedRevision: monitor.configurationRevision, monitorId: monitor.monitorId, ...patch }, ctx),
      /managed_monitor_requires_playbook_configuration/);
  }
  assert.equal((await api.getWorkspaceMonitor(scope, monitor.monitorId)).configurationRevision, monitor.configurationRevision);
  const first = await api.updateTool.execute({ expectedRevision: monitor.configurationRevision, monitorId: monitor.monitorId,
    schedule: { kind: "daily_local", times: ["09:00"], timezone: "America/Vancouver" } }, ctx);
  const second = await api.updateTool.execute({ expectedRevision: first.monitor.configurationRevision, monitorId: monitor.monitorId,
    addDailyTimes: ["16:00", "09:00"] }, ctx);
  assert.deepEqual(second.monitor.schedule, { kind: "daily_local", times: ["09:00", "16:00"], timezone: "America/Vancouver" });
  assert.deepEqual(second.monitor.managedBy, monitor.managedBy);
  assert.equal(second.monitor.lifecycleState, "paused");
});
