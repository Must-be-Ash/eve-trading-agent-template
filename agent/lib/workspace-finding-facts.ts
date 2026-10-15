import { z } from "zod";

import { commentaryFindingSchema } from "./public-commentary-schema";

const timestampSchema = z.string().datetime({ offset: true });

export const publicCommentarySignalFactSchema = z.object({
  filingIdentity: z.string().min(1).max(160),
  finding: commentaryFindingSchema,
  kind: z.literal("public_commentary_signal"),
  observedAt: timestampSchema,
  schemaVersion: z.literal(1),
  source: z.object({
    accessClassification: z.literal("public"),
    canonicalUrl: z.string().url().max(2_048),
    origin: z.string().url().max(500),
    sourceId: z.string().min(2).max(160),
  }).strict(),
}).strict().superRefine((fact, context) => {
  const corrective = fact.finding.outcome === "corrected" || fact.finding.outcome === "retracted";
  if (
    fact.filingIdentity !== fact.finding.findingId ||
    (fact.finding.outcome !== "accepted" && !corrective) ||
    (!fact.finding.materiality.alertEligible && !corrective) ||
    new URL(fact.source.canonicalUrl).origin !== fact.source.origin
  ) context.addIssue({ code: "custom", message: "public_commentary_signal_fact_invalid" });
});

export const workspaceFindingFactSchema = publicCommentarySignalFactSchema;

export type PublicCommentarySignalFact = z.infer<typeof publicCommentarySignalFactSchema>;
export type WorkspaceFindingFact = z.infer<typeof workspaceFindingFactSchema>;
