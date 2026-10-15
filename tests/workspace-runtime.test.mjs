import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = new URL("../", import.meta.url).pathname;
const directory = await mkdtemp(join(projectRoot, "tests/.workspace-"));
after(() => rm(directory, { recursive: true, force: true }));

for (const [entry, behavior] of [
  ["monitor-schedule", "schedules handle DST, bounded catch-up, and completed occurrence replay"],
  ["worker-auth", "worker envelopes reject tampering, expiry, and workspace substitution"],
  ["budget-ledger", "atomic reservations enforce shared budgets and retain uncertain spend"],
  ["runtime-scope", "conversation and generation scopes reject mismatched owner identity"],
]) {
  test(behavior, async () => {
    const outfile = join(directory, `${entry}.mjs`);
    await build({
      absWorkingDir: projectRoot,
      entryPoints: [`tests/workspace-${entry}.ts`],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    await import(pathToFileURL(outfile).href);
  });
}
