import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.EVE_MODEL || "openai/gpt-5.4",
  limits: { maxInputTokensPerSession: 500_000, maxOutputTokensPerSession: 30_000 },
});
