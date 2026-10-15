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
const usage = (inputTokens, outputTokens) => ({ type: "step.completed", data: { usage: { inputTokens, outputTokens } } });
const completion = { type: "action.result", data: { status: "completed", result: { kind: "tool-result", toolName: "complete_hybrid_evidence_job", isError: false } } };

test("worker accounting includes completion and trailing model steps without waiting for stream closure", async () => {
  let cancelled = false;
  const events = new ReadableStream({
    start(controller) {
      controller.enqueue(usage(1_000, 50));
      controller.enqueue(completion);
      controller.enqueue(usage(2_000, 400));
      controller.enqueue(usage(800, 30));
      controller.enqueue({ type: "turn.completed", data: {} });
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
    [{ type: "step.completed", data: {} }, { type: "turn.completed", data: {} }],
    [{ type: "step.failed", data: { code: "model_failed", message: "fixture" } }, { type: "turn.completed", data: {} }],
  ]) {
    const events = new ReadableStream({ start(controller) {
      controller.enqueue(usage(1_000, 50)); controller.enqueue(completion);
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
    start(controller) { controller.enqueue(completion); },
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
