import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(root, "tests/.research-"));
const bundle = join(directory, "research.mjs");
await build({ absWorkingDir: root, entryPoints: ["agent/lib/hybrid-evidence-research.ts"], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
const { createBoundedPublicDocumentFetcher, normalizeHybridEvidenceResearchUrl } = await import(pathToFileURL(bundle).href);
after(() => rm(directory, { recursive: true, force: true }));

// Characterization of the retained research boundary; transports never contact a provider.
test("background research fetches only granted public URLs and pins each redirect's DNS address", async () => {
  const first = "https://first.example/document";
  const second = "https://second.example/document";
  const seen = [];
  const fetchDocument = createBoundedPublicDocumentFetcher({
    resolveAddresses: async host => host === "first.example" ? ["1.1.1.1"] : ["8.8.8.8"],
    transport: async ({ address, url }) => {
      seen.push([url, address]);
      return url === first
        ? new Response(null, { status: 302, headers: { location: second } })
        : new Response("Public context", { headers: { "content-type": "text/plain" } });
    },
  });
  await assert.rejects(fetchDocument({ allowedUrls: [first], url: second }), /research_url_not_granted/u);
  assert.equal(seen.length, 0);
  const result = await fetchDocument({ allowedUrls: [first, second], url: first });
  assert.equal(result.content, "Public context");
  assert.deepEqual(seen, [[first, "1.1.1.1"], [second, "8.8.8.8"]]);
  for (const url of ["http://public.example/data", "https://user:password@public.example/data", "https://public.example/?api_key=private", "https://127.0.0.1/data", "https://[::1]/data"]) {
    assert.throws(() => normalizeHybridEvidenceResearchUrl(url));
  }
});

test("background research refuses private destinations, ungranted redirects, and oversized documents", async () => {
  const url = "https://public.example/document";
  let requests = 0;
  const privateFetch = createBoundedPublicDocumentFetcher({
    resolveAddresses: async () => ["10.0.0.1"],
    transport: async () => { requests++; return new Response("secret"); },
  });
  await assert.rejects(privateFetch({ allowedUrls: [url], url }), /research_destination_denied/u);
  assert.equal(requests, 0);
  const redirectFetch = createBoundedPublicDocumentFetcher({
    resolveAddresses: async () => ["8.8.8.8"],
    transport: async () => new Response(null, { status: 302, headers: { location: "https://other.example/document" } }),
  });
  await assert.rejects(redirectFetch({ allowedUrls: [url], url }), /research_redirect_denied/u);
  const largeFetch = createBoundedPublicDocumentFetcher({
    maximumBytes: 1024, resolveAddresses: async () => ["8.8.8.8"],
    transport: async () => new Response("x".repeat(1025), { headers: { "content-type": "text/plain" } }),
  });
  await assert.rejects(largeFetch({ allowedUrls: [url], url }), /research_document_too_large/u);
});
