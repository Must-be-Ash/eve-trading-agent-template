import { z } from "zod";

import {
  COMMENTARY_DIRECTION_PRESERVATION_TRANSFORM,
  createCommentaryPolicyDefinition,
} from "./commentary-policy";

export const COMMENTARY_CONFIGURED_IMPACT_CONTRACT_ID = "commentary-configured-impact";

export const PUBLIC_COMMENTARY_TRACKER_POLICY = createCommentaryPolicyDefinition({
  displayName: "Configured public-commentary impact hypothesis",
  policyId: COMMENTARY_CONFIGURED_IMPACT_CONTRACT_ID,
  policyVersion: "1.0.0",
  transformId: COMMENTARY_DIRECTION_PRESERVATION_TRANSFORM.transformId,
  transformVersion: COMMENTARY_DIRECTION_PRESERVATION_TRANSFORM.version,
});

/*
 * Which statements a commentary strategy may escalate to frontier
 * interpretation, and which registered policy assigns the resulting research
 * direction, are strategy decisions. The shared vertical selects both from the
 * evidence contract the pack declares, never from a pack identifier, so two
 * differently configured commentary strategies reach different conclusions on
 * the same normalized statement without a branch in shared plumbing.
 *
 * `deterministic_market_view` escalates a statement whose deterministic
 * extraction already resolves a directional market view on a named target.
 * `configured_impact_hypothesis` escalates a statement whose text matches one
 * of the owner-configured outcome/asset/pressure hypotheses.
 */
const contractSchema = z.object({
  actionability: z.literal("configured_impact_hypothesis"),
  id: z.string().min(3).max(160),
  version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
}).strict();

export type PublicCommentaryInterpretationContract = z.infer<typeof contractSchema> & {
  readonly policy: ReturnType<typeof createCommentaryPolicyDefinition>;
};

function defineContract(
  actionability: z.infer<typeof contractSchema>["actionability"],
  policy: ReturnType<typeof createCommentaryPolicyDefinition>,
): PublicCommentaryInterpretationContract {
  return Object.freeze({
    ...contractSchema.parse({
      actionability,
      id: policy.policyId,
      version: policy.policyVersion,
    }),
    policy,
  });
}

export const COMMENTARY_CONFIGURED_IMPACT_CONTRACT = defineContract(
  "configured_impact_hypothesis",
  PUBLIC_COMMENTARY_TRACKER_POLICY,
);

const contracts = new Map<string, PublicCommentaryInterpretationContract>(
  [COMMENTARY_CONFIGURED_IMPACT_CONTRACT]
    .map((contract) => [contract.id, contract]),
);

export function resolvePublicCommentaryInterpretationContract(pack: Readonly<{
  evidenceContracts?: readonly Readonly<{ id: string; version: string }>[];
  id: string;
  version: string;
}>): PublicCommentaryInterpretationContract | null {
  const declared = (pack.evidenceContracts ?? []).flatMap(({ id, version }) => {
    const contract = contracts.get(id);
    return contract && contract.version === version ? [contract] : [];
  });
  if (declared.length > 1) return null;
  return declared[0] ?? null;
}
