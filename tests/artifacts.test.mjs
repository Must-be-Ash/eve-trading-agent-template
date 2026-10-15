import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Bundle only the extensionless application imports. Substitute external I/O at
// the package boundary so these tests cannot write public Blob objects or fetch.
const bundled = await build({
  stdin: {
    contents: `export { artifactIdForCall, publishReportArtifact, publishRemoteMediaArtifact,
      publishTextFileArtifact, readArtifactManifest } from "./agent/lib/artifact-store.ts";
      export * from "./agent/lib/artifact-publication.ts";`,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    sourcefile: "artifact-test-owners.ts",
    loader: "ts",
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  write: false,
  plugins: [{
    name: "artifact-test-io",
    setup(build) {
      build.onResolve({ filter: /^(@vercel\/blob|node:dns\/promises)$/ }, ({ path }) =>
        ({ path, namespace: "artifact-test-io" }));
      build.onLoad({ filter: /.*/, namespace: "artifact-test-io" }, ({ path }) => ({
        contents: path === "@vercel/blob"
          ? `export const put = (...args) => globalThis.__artifactTestIO.put(...args);
             export const get = (...args) => globalThis.__artifactTestIO.get(...args);`
          : `export const lookup = (...args) => globalThis.__artifactTestIO.lookup(...args);`,
        loader: "js",
      }));
    },
  }],
});
const temporaryDirectory = await mkdtemp(new URL(".artifact-tests-", import.meta.url));
const bundledPath = `${temporaryDirectory}/owners.mjs`;
await writeFile(bundledPath, bundled.outputFiles[0].text);
let owners;
try {
  owners = await import(pathToFileURL(bundledPath));
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
const { artifactIdForCall } = owners;

import {
  chartNiceTicks,
  chartPricePrecision,
  cumulativeDepthPoints,
  inferredChartPricePrefix,
} from "../app/artifacts/[artifactId]/chart-display.ts";
import {
  artifactManifestSchema,
  publishChartInputSchema,
  publishFileInputSchema,
  publishImageInputSchema,
  publishReportInputSchema,
} from "../agent/lib/artifact-schema.ts";
import {
  artifactFinalValidationDecision,
  validateReportForPublication,
} from "../agent/lib/artifact-validation.ts";
import {
  artifactPageUrl,
  publicArtifactPageUrl,
} from "../agent/lib/public-app-url.ts";

test("structured public artifacts preserve schema, chart, final-validation, and URL contracts", () => {
assert.equal(
  publishFileInputSchema.safeParse({
    fileName: "unsupported.svg",
    publicDataOnly: true,
    text: "<svg></svg>",
    title: "Unsupported image",
  }).success,
  false,
  "publish_file must reject SVG files",
);

assert.deepEqual(chartNiceTicks([62_209.81, 66_923.95]), [
  62_000,
  64_000,
  66_000,
  68_000,
]);
assert.equal(chartPricePrecision([63_252.09]), 2);
assert.equal(chartPricePrecision([0.0042]), 6);
assert.equal(
  inferredChartPricePrefix(undefined, "30-Day Candles (BTC-USD)"),
  "$",
);
assert.equal(inferredChartPricePrefix("", "BTC-USD"), "");
assert.deepEqual(
  cumulativeDepthPoints(
    [
      { price: 99, size: 2 },
      { price: 101, size: 1 },
      { price: 100, size: 3 },
    ],
    "descending",
  ),
  [
    { price: 101, size: 1 },
    { price: 100, size: 4 },
    { price: 99, size: 6 },
  ],
);

const report = {
  asOf: "August 13, 2026",
  blocks: [
    {
      body: "Demand improved, but the evidence remains mixed.",
      bullets: ["Volume expanded.", "Liquidity remained concentrated."],
      heading: "What changed",
      type: "text",
    },
    {
      heading: "Thirty-day volume",
      series: [
        {
          name: "Daily volume",
          points: [
            { label: "Jul 15", value: 120 },
            { label: "Aug 13", value: 180 },
          ],
        },
      ],
      type: "line-chart",
      valuePrefix: "$",
      valueSuffix: "m",
    },
    {
      candles: [
        { close: 11, high: 12, label: "Aug 12", low: 9, open: 10 },
        { close: 12, high: 13, label: "Aug 13", low: 10, open: 11 },
      ],
      heading: "Price",
      type: "candlestick-chart",
      valuePrefix: "$",
    },
    {
      asks: [{ price: 12.1, size: 100 }],
      bids: [{ price: 11.9, size: 90 }],
      heading: "Displayed depth",
      type: "depth-chart",
      valuePrefix: "$",
    },
  ],
  confidence: "medium",
  description: "A public-data test of Eve's deterministic report renderer.",
  metrics: [
    {
      detail: "Compared with the prior 30 days",
      label: "Volume",
      tone: "positive",
      value: "+50%",
    },
  ],
  sources: [
    {
      label: "Coinbase market data",
      publisher: "Coinbase",
      url: "https://www.coinbase.com/price/hyperliquid",
    },
  ],
  subject: {
    assetClass: "Crypto",
    name: "Hyperliquid",
    symbol: "HYPE",
  },
  summary: "A concise summary based only on public market data.",
  title: "HYPE market dossier",
  verdict: {
    label: "Constructive, with liquidity risk",
    rationale: "Participation improved while visible depth remained uneven.",
    tone: "warning",
  },
};

assert.doesNotThrow(() =>
  publishReportInputSchema.parse({
    publicDataOnly: true,
    report,
    requirements: [
      "metrics",
      "line-chart",
      "candlestick-chart",
      "depth-chart",
      "sources",
    ],
  }),
);
assert.throws(() =>
  publishReportInputSchema.parse({
    publicDataOnly: true,
    report,
    requirements: [],
  }),
);
assert.throws(() =>
  publishReportInputSchema.parse({
    publicDataOnly: false,
    requirements: ["text"],
    report,
  }),
);
assert.throws(() =>
  publishImageInputSchema.parse({
    publicDataOnly: true,
    sourceUrl: "https://cdn.example/image.png?token=secret",
    title: "Unsafe image",
  }),
);
assert.throws(() =>
  publishReportInputSchema.parse({
    publicDataOnly: true,
    requirements: ["text"],
    report: {
      ...report,
      sources: [{ label: "Unsafe", url: "javascript:alert(1)" }],
    },
  }),
);
assert.throws(() =>
  publishReportInputSchema.parse({
    publicDataOnly: true,
    requirements: ["text"],
    report: {
      ...report,
      sources: [
        {
          label: "Credential-bearing source",
          url: "https://files.example/report?access_token=secret",
        },
      ],
    },
  }),
);

const { blocks: _reportBlocks, ...chartMetadata } = report;
const chartInput = {
  ...chartMetadata,
  charts: [report.blocks[1]],
  publicDataOnly: true,
};
assert.doesNotThrow(() => publishChartInputSchema.parse(chartInput));
assert.throws(() =>
  publishChartInputSchema.parse({
    ...chartInput,
    charts: [],
  }),
);
assert.throws(() =>
  publishChartInputSchema.parse({
    ...chartInput,
    charts: [
      {
        heading: "Missing numeric series",
        series: [{ name: "Price", points: [] }],
        type: "line-chart",
      },
    ],
  }),
);

assert.doesNotThrow(() =>
  publishFileInputSchema.parse({
    fileName: "market-data.csv",
    publicDataOnly: true,
    sourceUrl: "https://files.example/market-data.csv",
    title: "Market data",
  }),
);
assert.throws(() =>
  publishFileInputSchema.parse({
    fileName: "market-data.csv",
    publicDataOnly: true,
    sourceUrl: "https://files.example/market-data.csv",
    text: "date,value\n2026-08-13,1",
    title: "Market data",
  }),
);

const reportRequirements = [
  "metrics",
  "line-chart",
  "candlestick-chart",
  "depth-chart",
  "sources",
];
assert.deepEqual(
  validateReportForPublication(report, reportRequirements),
  [],
);
assert.deepEqual(
  validateReportForPublication(
    {
      ...report,
      blocks: report.blocks.filter(
        (block) => block.type !== "candlestick-chart",
      ),
      sources: [],
    },
    reportRequirements,
  ),
  ["candlestick-chart", "sources"],
);

const firstValidation = artifactFinalValidationDecision(
  { rejection: null, turnId: null },
  "turn-1",
  ["candlestick-chart"],
);
assert.equal(firstValidation.rejection?.status, "not_published");
assert.equal(firstValidation.rejection?.retryAllowed, false);
const blockedRepair = artifactFinalValidationDecision(
  firstValidation.state,
  "turn-1",
  [],
);
assert.deepEqual(blockedRepair.rejection, firstValidation.rejection);
assert.equal(
  artifactFinalValidationDecision(firstValidation.state, "turn-2", [])
    .rejection,
  null,
);

const firstId = artifactIdForCall("call_artifact_test");
assert.equal(firstId, "0e7b7ca4ff0d30305f20e8ff22ad59ec");
assert.notEqual(firstId, artifactIdForCall("call_artifact_other"));
assert.match(firstId, /^[a-f0-9]{32}$/u);

const previousBaseUrl = process.env.PUBLIC_APP_URL;
try {
  process.env.PUBLIC_APP_URL = "https://eve.example";
  const publicUrl = artifactPageUrl(firstId);
  assert.equal(publicUrl, `https://eve.example/artifacts/${firstId}`);
  assert.equal(publicArtifactPageUrl(publicUrl), publicUrl);
  assert.equal(
    publicArtifactPageUrl(`https://eve.example/artifacts/${firstId}?token=x`),
    null,
  );
  assert.equal(
    publicArtifactPageUrl(`https://attacker.example/artifacts/${firstId}`),
    null,
  );
} finally {
  if (previousBaseUrl === undefined) {
    delete process.env.PUBLIC_APP_URL;
  } else {
    process.env.PUBLIC_APP_URL = previousBaseUrl;
  }
}

assert.doesNotThrow(() =>
  artifactManifestSchema.parse({
    createdAt: "2026-08-13T20:00:00.000Z",
    description: report.description,
    id: firstId,
    kind: "chart",
    report: {
      ...report,
      blocks: [report.blocks[1]],
    },
    schemaVersion: 1,
    title: "HYPE volume chart",
    visibility: "public",
  }),
);

assert.doesNotThrow(() =>
  artifactManifestSchema.parse({
    createdAt: "2026-08-13T20:00:00.000Z",
    description: "Public image",
    id: firstId,
    kind: "image",
    media: {
      byteLength: 1024,
      contentType: "image/png",
      downloadUrl:
        "https://store.public.blob.vercel-storage.com/artifacts/test/image.png?download=1",
      fileName: "image.png",
      url: "https://store.public.blob.vercel-storage.com/artifacts/test/image.png",
    },
    schemaVersion: 1,
    title: "Public image",
    visibility: "public",
  }),
);
assert.throws(() =>
  artifactManifestSchema.parse({
    createdAt: "2026-08-13T20:00:00.000Z",
    description: "Unsafe image",
    id: firstId,
    kind: "image",
    media: {
      byteLength: 1024,
      contentType: "image/png",
      downloadUrl: "https://attacker.example/image.png?download=1",
      fileName: "image.png",
      url: "https://attacker.example/image.png",
    },
    schemaVersion: 1,
    title: "Unsafe image",
    visibility: "public",
  }),
);



});

async function withArtifactIO(run) {
  const previousBaseUrl = process.env.PUBLIC_APP_URL;
  const previousFetch = globalThis.fetch;
  const writes = [];
  const requests = [];
  const fixture = {
    addresses: [{ address: "8.8.8.8", family: 4 }],
    responses: [],
    readResult: null,
    async lookup() { return this.addresses; },
    async get() { return this.readResult; },
    async put(path, body, options) {
      let byteLength = 0;
      if (body instanceof ReadableStream) {
        for await (const chunk of body) byteLength += chunk.byteLength;
      } else {
        byteLength = Buffer.byteLength(body);
      }
      writes.push({ path, body, byteLength, options });
      const url = `https://fixture.public.blob.vercel-storage.com/${path}`;
      return { url, downloadUrl: `${url}?download=1` };
    },
  };
  process.env.PUBLIC_APP_URL = "https://eve.example";
  globalThis.__artifactTestIO = fixture;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    assert.ok(fixture.responses.length, "unexpected network request");
    return fixture.responses.shift();
  };
  try {
    return await run({ fixture, requests, writes });
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.__artifactTestIO;
    if (previousBaseUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previousBaseUrl;
  }
}

const remoteInput = {
  artifactId: "11111111111111111111111111111111",
  description: "Public market image",
  kind: "image",
  sourceUrl: "https://media.example/chart.png",
  title: "Public market image",
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The shared publisher's auth gate must stop before it can access session state
// or perform a public write, even if a caller bypasses Eve's approval callback.
test("artifact publishers reject unauthenticated and runtime principals before any write", async () => {
  for (const current of [undefined, { principalType: "runtime" }]) {
    const context = { session: { auth: { current } } };
    assert.equal(owners.artifactPublicationApproval(context).type, "denied");
    for (const publish of [
      () => owners.publishStructuredReport({}, context),
      () => owners.publishChartArtifact({}, context),
      () => owners.publishRemoteArtifact("image", {}, context),
      () => owners.publishFileArtifact({}, context),
    ]) {
      await assert.rejects(publish, /Only an authenticated user session/u);
    }
  }
  assert.equal(owners.artifactPublicationApproval({
    session: { auth: { current: { principalType: "user" } } },
  }), "not-applicable");
});

test("remote artifacts reject private addresses, private DNS answers, and redirect targets", async () => {
  await withArtifactIO(async ({ fixture, requests, writes }) => {
    for (const host of ["127.0.0.1", "169.254.169.254", "[::1]", "[::ffff:7f00:1]", "localhost", "service.internal"]) {
      await assert.rejects(
        owners.publishRemoteMediaArtifact({ ...remoteInput, sourceUrl: `https://${host}/image.png` }),
        /public|private network/u,
      );
    }
    assert.equal(requests.length, 0);
    fixture.addresses = [{ address: "10.0.0.7", family: 4 }];
    await assert.rejects(owners.publishRemoteMediaArtifact(remoteInput), /public address/u);
    assert.equal(requests.length, 0);
    fixture.addresses = [{ address: "8.8.8.8", family: 4 }];
    fixture.responses.push(new Response(null, { status: 302, headers: { location: "https://127.0.0.1/image.png" } }));
    await assert.rejects(owners.publishRemoteMediaArtifact(remoteInput), /private network/u);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.redirect, "manual");
    assert.equal(writes.length, 0);
  });
});

test("remote publication verifies media type, signature, and bounded redirects before writes", async () => {
  await withArtifactIO(async ({ fixture, requests, writes }) => {
    fixture.responses.push(new Response(png, { headers: { "content-type": "image/png" } }));
    await assert.rejects(
      owners.publishRemoteMediaArtifact({ ...remoteInput, contentType: "image/jpeg" }),
      /different content type/u,
    );
    fixture.responses.push(new Response("<html>not an image</html>", { headers: { "content-type": "image/png" } }));
    await assert.rejects(owners.publishRemoteMediaArtifact(remoteInput), /does not match/u);
    fixture.responses.push(new Response("<svg></svg>", { headers: { "content-type": "image/svg+xml" } }));
    await assert.rejects(owners.publishRemoteMediaArtifact({ ...remoteInput, kind: "file" }), /SVG files are not supported/u);
    for (let i = 0; i < 5; i++) {
      fixture.responses.push(new Response(null, { status: 302, headers: { location: "/another.png" } }));
    }
    await assert.rejects(owners.publishRemoteMediaArtifact(remoteInput), /redirected too many times/u);
    assert.equal(requests.length, 8);
    assert.equal(writes.length, 0);
  });
});

test("remote publication rejects declared and streamed bodies over the 100 MB limit", async () => {
  await withArtifactIO(async ({ fixture, writes }) => {
    fixture.responses.push(new Response(png, { headers: {
      "content-type": "image/png", "content-length": String(100 * 1024 * 1024 + 1),
    } }));
    await assert.rejects(owners.publishRemoteMediaArtifact(remoteInput), /100 MB publication limit/u);
    let chunks = 0;
    const chunk = new Uint8Array(2 * 1024 * 1024);
    chunk.set(png);
    fixture.responses.push(new Response(new ReadableStream({
      pull(controller) {
        if (chunks++ < 51) controller.enqueue(chunk);
        else controller.close();
      },
    }), { headers: { "content-type": "image/png" } }));
    await assert.rejects(owners.publishRemoteMediaArtifact(remoteInput), /100 MB publication limit/u);
    assert.equal(writes.length, 0);
  });
});

test("successful media publication persists a matching public manifest and replay-stable URL", async () => {
  await withArtifactIO(async ({ fixture, writes }) => {
    fixture.responses.push(new Response(png, { headers: { "content-type": "image/png" } }));
    const result = await owners.publishRemoteMediaArtifact(remoteInput);
    assert.equal(result.publicUrl, "https://eve.example/artifacts/11111111111111111111111111111111");
    assert.equal(writes.length, 2);
    const [media, manifestWrite] = writes;
    assert.equal(media.byteLength, png.byteLength);
    assert.equal(media.options.contentType, "image/png");
    assert.equal(media.options.access, "public");
    const manifest = artifactManifestSchema.parse(JSON.parse(manifestWrite.body));
    assert.equal(manifest.id, remoteInput.artifactId);
    assert.equal(manifest.media.byteLength, png.byteLength);
    assert.equal(manifest.media.url, `https://fixture.public.blob.vercel-storage.com/${media.path}`);
    assert.equal(manifest.visibility, "public");
    assert.equal(manifestWrite.path, `artifacts/${remoteInput.artifactId}/manifest.json`);
    assert.equal(manifestWrite.options.addRandomSuffix, false);
    assert.equal(manifestWrite.options.allowOverwrite, true);
  });
});

test("downloadable text is stored as inert bytes and read manifests must match their requested ID", async () => {
  await withArtifactIO(async ({ fixture, writes }) => {
    await owners.publishTextFileArtifact({
      artifactId: remoteInput.artifactId,
      contentType: "text/csv",
      description: "Public CSV",
      fileName: "market.csv",
      text: "date,price\n2026-01-01,100",
      title: "Public CSV",
    });
    assert.equal(writes[0].options.contentType, "application/octet-stream");
    assert.equal(writes[0].body.toString(), "date,price\n2026-01-01,100");
    const manifest = JSON.parse(writes[1].body);
    const read = (value) => ({
      statusCode: 200,
      blob: { size: Buffer.byteLength(JSON.stringify(value)) },
      stream: new Response(JSON.stringify(value)).body,
    });
    fixture.readResult = read(manifest);
    assert.equal((await owners.readArtifactManifest(remoteInput.artifactId)).kind, "file");
    fixture.readResult = read({ ...manifest, id: "22222222222222222222222222222222" });
    assert.equal(await owners.readArtifactManifest(remoteInput.artifactId), null);
    fixture.readResult = { ...read(manifest), blob: { size: 1024 * 1024 + 1 } };
    assert.equal(await owners.readArtifactManifest(remoteInput.artifactId), null);
    fixture.readResult = read({ ...manifest, visibility: "private" });
    assert.equal(await owners.readArtifactManifest(remoteInput.artifactId), null);
  });
});
