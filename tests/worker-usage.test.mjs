import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(root, "tests/.worker-usage-"));
const outfile = join(directory, "worker.mjs");
await build({
  absWorkingDir: root,
  stdin: { contents: 'export { drainPublicCommentaryHybridWorker } from "./agent/lib/public-commentary-workspace-worker.ts";', resolveDir: root, loader: "ts" },
  outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { drainPublicCommentaryHybridWorker: drain } = await import(pathToFileURL(outfile).href);
after(() => rm(directory, { recursive: true, force: true }));
const usage = (inputTokens, outputTokens) => ({ type: "usage.recorded", data: { kind: "model", usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
const call = (callId, name, outcome) => [
  { type: "call.requested", data: { callId, capability: { kind: "tool", name } } },
  { type: "call.settled", data: { callId, outcome } },
];
const completion = call("call-complete", "complete_hybrid_evidence_job", "completed");
const turnSettled = (outcome, error) => ({ type: "turn.settled", data: { turnId: "turn-1", outcome, ...(error ? { error } : {}) } });

test("worker accounting includes completion and trailing model steps without waiting for stream closure", async () => {
  let cancelled = false;
  const events = new ReadableStream({
    start(controller) {
      controller.enqueue(usage(1_000, 50));
      for (const event of completion) controller.enqueue(event);
      controller.enqueue(usage(2_000, 400));
      controller.enqueue(usage(800, 30));
      controller.enqueue(turnSettled("completed"));
      // Eve's durable stream can remain open after the turn's paid work settles.
    },
    cancel() { cancelled = true; },
  });
  const result = await drain({}, async () => ({ sessionId: "fixture-worker", events }));
  assert.deepEqual(result, { inputTokens: 3_800, outputTokens: 480 });
  assert.equal(cancelled, false);
  assert.equal(events.locked, false);
});

test("an incomplete worker tail cannot be reported as complete actual usage", async () => {
  for (const tail of [
    [usage(2_000, 400)],
    [turnSettled("failed", { code: "model_failed", message: "fixture" })],
    [{ type: "session.ended", data: { outcome: "failed", error: { code: "session_failed", message: "fixture" } } }],
  ]) {
    const events = new ReadableStream({ start(controller) {
      controller.enqueue(usage(1_000, 50)); for (const event of completion) controller.enqueue(event);
      for (const event of tail) controller.enqueue(event);
      controller.close();
    } });
    await assert.rejects(drain({}, async () => ({ sessionId: "fixture-worker", events })), /completion_usage_unsettled/);
  }
});

test("an unsettled completion tail is bounded without cancelling the durable worker", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const events = new ReadableStream({
    start(controller) { for (const event of completion) controller.enqueue(event); },
    cancel() { cancelled = true; },
  });
  const result = drain({}, async () => ({ sessionId: "fixture-worker", events }));
  const rejected = assert.rejects(result, /completion_usage_unsettled/);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5_000);
  await rejected;
  assert.equal(cancelled, false);
  assert.equal(events.locked, false);
});

test("a worker that settles without committing names its last tool and never hangs on an open stream", async () => {
  const events = new ReadableStream({ start(controller) {
    for (const event of call("call-read", "read_hybrid_evidence_bundle", "failed")) controller.enqueue(event);
    controller.enqueue(turnSettled("completed"));
    // Stream stays open, as an idle Eve 1.0 session's stream does.
  } });
  await assert.rejects(
    drain({}, async () => ({ sessionId: "fixture-worker", events })),
    /completion_missing:tools=1:last=read_hybrid_evidence_bundle:err=true/,
  );
});
