import { defineAgent } from "eve";

export default defineAgent({
  build: { externalDependencies: ["@adaam/eve-workspace-runtime-bridge"] },
  compaction: { threshold: 0.75 },
  model: process.env.EVE_MODEL || "openai/gpt-5.4",
  limits: {
    // Same per-window budget as the former maxInputTokensPerSession /
    // maxOutputTokensPerSession caps: provider-reported input and output tokens.
    sessionUsage: ({ window }) => window.inputTokens >= 500_000 || window.outputTokens >= 30_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60_000,
  },
});
