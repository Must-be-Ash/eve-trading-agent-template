import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { startTestRedis } from "./helpers/photon-redis.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(`${root}tests/.evidence-lifetime-`);
await build({ absWorkingDir: root, entryPoints: ["agent/lib/hybrid-evidence-artifact-store.ts"], outfile: `${directory}/store.mjs`, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
const { createHybridEvidenceEphemeralArtifactStore } = await import(pathToFileURL(`${directory}/store.mjs`));
const redis = await startTestRedis();
const previous = [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN];
process.env.KV_REST_API_URL = redis.url;
process.env.KV_REST_API_TOKEN = redis.token;
after(async () => {
  await redis.close();
  await rm(directory, { recursive: true, force: true });
  ["KV_REST_API_URL", "KV_REST_API_TOKEN"].forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  });
});

function fixture(content, options = {}) {
  const bytes = Buffer.from(content);
  const objects = new Map();
  const blob = {
    async get(key) { return objects.get(key) ?? null; },
    async put(key, value) { objects.set(key, Buffer.from(value)); },
    async delete(key) { objects.delete(key); },
    ...options,
  };
  const first = createHybridEvidenceEphemeralArtifactStore({ blob });
  const second = createHybridEvidenceEphemeralArtifactStore({ blob });
  const input = {
    acquisitionId: "fixture-acquisition", authority: "X", bytes,
    canonicalPublicUrl: "https://x.com/fixture/status/100", mediaType: "text/plain",
    observedAt: new Date().toISOString(), parserEligibility: null, sourceInstanceId: "fixture-source",
    structure: { characterCount: content.length, columnCount: null, pageCount: null, rowCount: null, sheetCount: null },
  };
  const lease = referenceId => ({ expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), referenceId });
  const release = (store, artifact, referenceId) => store.setReference({ artifactDigest: artifact.contentDigest, active: false, kind: "transient", referenceId });
  const read = (store, artifact) => store.readSlice({ maximumBytes: bytes.length, locator: {
    artifactDigest: artifact.contentDigest, kind: "text_span", start: 0, end: content.length,
    spanDigest: createHash("sha256").update(bytes).digest("hex"),
  } });
  return { blob, first, second, input, lease, objects, release, read };
}

test("one completed workspace cannot remove shared evidence while another reader is still using it", async () => {
  const f = fixture("Two concurrent workspaces read this same public statement.");
  const first = await f.first.persist({ ...f.input, transientReference: f.lease("first-reader") });
  const second = await f.second.persist({ ...f.input, transientReference: f.lease("second-reader") });
  assert.equal(first.contentDigest, second.contentDigest);
  assert.equal(await f.first.deleteUnreferenced(first.contentDigest), false);
  // The first workspace has completed its semantic work; the second remains in flight.
  await f.release(f.first, first, "first-reader");
  assert.equal(await f.first.deleteUnreferenced(first.contentDigest), false);
  await f.second.setReference({ artifactDigest: second.contentDigest, active: true, kind: "accepted_result", referenceId: "second-result" });
  assert.equal((await f.read(f.second, second)).content, f.input.bytes.toString());
  await f.release(f.second, second, "second-reader");
  assert.equal(await f.second.deleteUnreferenced(second.contentDigest), true);
  assert.equal(f.objects.size, 0);
  assert.equal(await f.first.readManifest(first.contentDigest), null);
});

test("an abandoned ephemeral reader becomes collectible at expiry without releasing the storage quota", async () => {
  const f = fixture("Abandoned worker evidence has a finite private lifetime.");
  const lease = f.lease("abandoned-reader");
  const artifact = await f.first.persist({ ...f.input, transientReference: lease });
  assert.deepEqual(await f.first.collectExpired({ now: new Date(Date.parse(lease.expiresAt) - 1) }), []);
  assert.deepEqual(await f.first.collectExpired({ now: new Date(lease.expiresAt) }), [artifact.contentDigest]);
  assert.equal(f.objects.size, 0);
  assert.equal(await f.first.readManifest(artifact.contentDigest), null);
  const index = JSON.parse(await redis.command("GET", "eve:hybrid-evidence:v1:ephemeral-artifact-index"));
  assert.ok(index.usage.some(entry => entry.artifactDigest === artifact.contentDigest));
});

test("a failed first upload cannot erase a concurrent successful claimant's artifact", async () => {
  let entered;
  let fail;
  const enteredPut = new Promise(resolve => { entered = resolve; });
  const failedPut = new Promise(resolve => { fail = resolve; });
  let writes = 0;
  const f = fixture("Concurrent upload repair must preserve the successful reader.");
  const put = f.blob.put;
  f.blob.put = async (...args) => {
    if (++writes === 1) { entered(); await failedPut; throw new Error("fixture upload failed"); }
    await put(...args);
  };
  const firstAttempt = f.first.persist({ ...f.input, transientReference: f.lease("failed-reader") });
  const rejection = assert.rejects(firstAttempt, /storage_unavailable/);
  await enteredPut;
  const second = await f.second.persist({ ...f.input, transientReference: f.lease("successful-reader") });
  fail();
  await rejection;
  assert.equal((await f.read(f.second, second)).content, f.input.bytes.toString());
  await f.release(f.second, second, "successful-reader");
  assert.equal(await f.second.deleteUnreferenced(second.contentDigest), true);
  assert.equal(f.objects.size, 0);
});
