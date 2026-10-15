import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { startTestRedis } from "./helpers/photon-redis.mjs";

// This boundary test joins the real publisher tools, Blob manifests, and Next
// page/metadata renderers. Only Blob and remote-media networking are fixtures.
// Eve's real context container backs publication state; no product gate is stubbed.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(new URL(".artifact-journey-", import.meta.url));
const output = `${directory}/owners.mjs`;
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      ${["report", "chart", "image", "pdf", "audio", "video", "file"].map(kind =>
        `export { default as ${kind} } from "./agent/tools/publish_${kind}.ts";`).join("\n")}
      export { default as page, generateMetadata } from "./app/artifacts/[artifactId]/page.tsx";
      export { createHybridEvidenceEphemeralArtifactStore } from "./agent/lib/hybrid-evidence-artifact-store.ts";
    `,
    resolveDir: root, loader: "ts",
  },
  bundle: true, packages: "external", platform: "node", format: "esm",
  outfile: output, logLevel: "silent",
  plugins: [{ name: "external-artifact-fixtures", setup(plugin) {
    plugin.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next/navigation.js", external: true }));
    plugin.onResolve({ filter: /^(@vercel\/blob|node:https|node:dns\/promises)$/ }, ({ path }) => ({ path, namespace: "io" }));
    plugin.onLoad({ filter: /.*/, namespace: "io" }, ({ path }) => ({ loader: "js", contents:
      path === "@vercel/blob"
        ? `export const put=(...a)=>globalThis.__artifactJourney.put(...a); export const get=(...a)=>globalThis.__artifactJourney.get(...a); export const del=(...a)=>globalThis.__artifactJourney.del(...a);`
        : path === "node:https"
          ? `export const request=(...a)=>globalThis.__artifactJourney.request(...a);`
          : `export const lookup=async()=>[{address:"8.8.8.8",family:4}];`,
    }));
    plugin.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }));
  }}],
});
const api = await import(pathToFileURL(output));
const { ContextContainer, contextStorage } = await import(
  new URL("../node_modules/eve/dist/src/context/container.js", import.meta.url));
after(() => rm(directory, { recursive: true, force: true }));

const report = {
  title: "Public sample research", description: "Public market research fixture",
  asOf: "2026-10-15", summary: "Sample price increased.", confidence: "medium",
  subject: { name: "Sample asset", symbol: "SAMPLE", assetClass: "Crypto" },
  sources: [{ label: "Public source", url: "https://example.com/markets" }],
  blocks: [{ type: "text", heading: "Research", body: "<script>alert('sample')</script> is inert text." }],
};
const chart = { type: "line-chart", heading: "Public prices", series: [{ name: "Price", points: [{ label: "A", value: 1 }, { label: "B", value: 2 }] }] };
const canaries = ["PRIVATE_BALANCE_4827", "PRIVATE_ACCOUNT_7829", "PRIVATE_CONVERSATION_9124", "BEARER_TOKEN_8172", "PRIVATE_EVIDENCE_1281"];

test("public artifact tools persist and render all seven kinds without carrying private session context", async () => {
  const originalUrl = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = "https://fixture.example";
  const objects = new Map();
  const writes = [];
  const responses = [];
  const io = {
    async put(path, body, options) {
      const bytes = body instanceof ReadableStream
        ? Buffer.from(await new Response(body).arrayBuffer()) : Buffer.from(body);
      const key = `${options.access}:${path}`;
      objects.set(key, bytes); writes.push({ path, bytes, options });
      const url = `https://fixture.public.blob.vercel-storage.com/${path}`;
      return { url, downloadUrl: `${url}?download=1` };
    },
    async get(path, options) {
      const bytes = objects.get(`${options.access}:${path}`);
      return bytes ? { statusCode: 200, blob: { size: bytes.length }, stream: new Response(bytes).body } : null;
    },
    async del() { throw new Error("Unexpected delete"); },
    request(url, options, callback) {
      assert.equal(new URL(url).hostname, "media.example");
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        const response = responses.shift();
        assert.ok(response, "Unexpected external request");
        const incoming = Readable.from([response.bytes]);
        incoming.statusCode = 200;
        incoming.rawHeaders = ["content-type", response.type];
        callback(incoming);
      });
      return request;
    },
  };
  globalThis.__artifactJourney = io;
  const context = {
    abortSignal: new AbortController().signal,
    session: { id: canaries[1], turn: { id: "artifact-turn" },
      auth: { current: { principalType: "user", principalId: "imessage:+15555550100", attributes: { bearer: canaries[3] } } },
      balance: canaries[0], conversation: canaries[2], evidence: canaries[4] },
  };
  const cases = [
    ["report", { report, requirements: ["text", "sources"] }, /Public sample research/],
    ["chart", { ...report, blocks: undefined, charts: [chart] }, /Public prices/],
    ["image", { sourceUrl: "https://media.example/chart.png", title: "Sample image" }, /<img /, "image/png", Buffer.from([137,80,78,71,13,10,26,10])],
    ["pdf", { sourceUrl: "https://media.example/report.pdf", title: "Sample PDF" }, /Open PDF/, "application/pdf", Buffer.from("%PDF-1.7\nfixture")],
    ["audio", { sourceUrl: "https://media.example/audio.mp3", title: "Sample audio" }, /<audio /, "audio/mpeg", Buffer.from("ID3fixture")],
    ["video", { sourceUrl: "https://media.example/video.mp4", title: "Sample video" }, /<video /, "video/mp4", Buffer.from("0000ftypisom")],
    ["file", { fileName: "sample.csv", text: "date,price\n2026-10-15,2", title: "Public CSV" }, /Download file/],
  ];
  try {
    await contextStorage.run(new ContextContainer(), async () => {
      for (const [kind, input, expected, type, bytes] of cases) {
        const tool = api[kind];
        const parsed = tool.inputSchema.parse({ ...input, publicDataOnly: true });
        const ctx = { ...context, callId: `public-${kind}` };
        assert.equal(tool.approval(ctx), "not-applicable");
        if (bytes) responses.push({ type, bytes });
        const published = await tool.execute(parsed, ctx);
        assert.equal(published.status, "published");
        const params = Promise.resolve({ artifactId: published.artifactId });
        const html = renderToStaticMarkup(await api.page({ params }));
        const metadata = await api.generateMetadata({ params });
        assert.match(html, expected);
        assert.deepEqual(metadata.robots, { follow: false, index: false });
        assert.equal(html.includes("<script>"), false);
        const publicData = JSON.stringify({ published, metadata, html, model: tool.toModelOutput(published) });
        for (const canary of canaries) assert.equal(publicData.includes(canary), false);
        assert.equal(new URL(published.publicUrl).search, "");
        assert.equal(new URL(published.publicUrl).hash, "");
        // Retries of the same call must preserve URL and object identity.
        const pathsBefore = [...objects.keys()];
        if (bytes) responses.push({ type, bytes });
        assert.deepEqual(await tool.execute(parsed, ctx), published);
        assert.deepEqual([...objects.keys()], pathsBefore);
      }
      assert.equal(responses.length, 0);
      for (const write of writes) {
        assert.equal(write.options.access, "public");
        for (const canary of canaries) assert.equal(write.bytes.includes(canary), false);
      }
      const rejected = await api.report.execute(
        api.report.inputSchema.parse({ publicDataOnly: true, report, requirements: ["candlestick-chart"] }),
        { ...context, callId: "incomplete" });
      assert.equal(rejected.status, "not_published");
      const writeCount = writes.length;
      assert.equal((await api.file.execute(api.file.inputSchema.parse({
        publicDataOnly: true, title: "Retry", fileName: "retry.txt", text: "public",
      }), { ...context, callId: "retry" })).status, "not_published");
      assert.equal(writes.length, writeCount, "final validation failure cannot be bypassed with another publisher in the turn");
    });

    const redis = await startTestRedis();
    const envNames = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "EVE_HYBRID_EVIDENCE_READ_WRITE_TOKEN"];
    const previous = envNames.map(name => process.env[name]);
    Object.assign(process.env, { KV_REST_API_URL: redis.url, KV_REST_API_TOKEN: redis.token, EVE_HYBRID_EVIDENCE_READ_WRITE_TOKEN: "fixture-private-store-token" });
    try {
      const privateStore = api.createHybridEvidenceEphemeralArtifactStore();
      const evidence = Buffer.from(canaries[4]);
      await privateStore.persist({
        acquisitionId: "fixture-acquisition", authority: "x", bytes: evidence,
        canonicalPublicUrl: "https://x.com/example/status/100", mediaType: "text/plain",
        observedAt: new Date().toISOString(), parserEligibility: null,
        sourceInstanceId: "fixture-source", structure: { characterCount: evidence.length, pageCount: null, rowCount: null, columnCount: null, sheetCount: null },
      });
      const evidenceWrite = writes.at(-1);
      assert.equal(evidenceWrite.options.access, "private");
      assert.equal(evidenceWrite.options.token, "fixture-private-store-token");
      assert.ok(evidenceWrite.path.startsWith("hybrid-evidence-private/"));
      await assert.rejects(api.page({ params: Promise.resolve({ artifactId: "0".repeat(32) }) }), /NEXT_HTTP_ERROR_FALLBACK;404/);
    } finally {
      await redis.close();
      envNames.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    }
  } finally {
    delete globalThis.__artifactJourney;
    if (originalUrl === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = originalUrl;
  }
});
