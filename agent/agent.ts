import { defineAgent } from "eve";

export default defineAgent({
  build: { externalDependencies: ["@adaam/eve-workspace-runtime-bridge"] },
  compaction: { thresholdPercent: 0.75 },
  model: process.env.EVE_MODEL || "openai/gpt-5.4",
  limits: { maxInputTokensPerSession: 500_000, maxOutputTokensPerSession: 30_000, sessionTimeoutMs: 7 * 24 * 60 * 60_000 },
});
