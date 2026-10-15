import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(projectRoot, "tests/.workspace-dispatch-"));
const outfile = join(directory, "dispatch.mjs");
after(() => rm(directory, { recursive: true, force: true }));
await build({
  absWorkingDir: projectRoot,
  entryPoints: ["agent/schedules/monitors.ts"], outfile,
  bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
  plugins: [{ name: "offline-effects", setup(plugin) {
    // Exercise the real scheduler. Its remote evaluator and delivery adapters
    // are replaced so an unexpected fallback can never call paid/live services.
    plugin.onResolve({ filter: /workspace-(evaluator-dispatch|alert-dispatch)$/ }, (args) => ({ path: args.path, namespace: "offline" }));
    plugin.onLoad({ filter: /.*/, namespace: "offline" }, (args) => ({ loader: "js", contents:
      args.path.endsWith("evaluator-dispatch")
        ? 'export async function runWorkspaceEvaluatorForMonitor(){throw new Error("live_evaluator_forbidden")}'
        : 'export async function deliverWorkspaceOutcomeToPhoton(){throw new Error("live_delivery_forbidden")}' }));
  } }],
});
const { createWorkspaceMonitorSchedule } = await import(pathToFileURL(outfile).href);
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
    resolveRuntimeFlags: () => ({ state: true, dispatch: true, photonAlerts: true }),
    claimWorkspaceMonitors: async () => [job],
    emitRuntimeObservation: () => {},
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

test("a scheduled result is committed before delivery and budget settlement", async () => {
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
