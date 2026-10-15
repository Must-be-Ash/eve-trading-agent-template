import { commentaryActionabilityToolInputSchema, COMMENTARY_ACTIONABILITY_TOOL_DESCRIPTION, COMMENTARY_SEMANTIC_DEFINITION_ID, commentarySemanticWorkerCandidateSchema, createPublicCommentaryImpactDefinition, materializeCommentaryActionabilityCandidate, PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID, QUALIFIED_PUBLIC_COMMENTARY_ADAPTER_IDS } from "./public-commentary-semantics";
import { PUBLIC_COMMENTARY_AGENTIC_RESEARCH_BUDGET, PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID, publicCommentaryResearchWorkerCandidateSchema } from "./public-commentary-research";
import { createHybridEvidenceWorkerContractRegistry, type HybridEvidenceWorkerContract } from "./hybrid-evidence-worker-contract";
import type { StrategyPackCatalogEntry } from "./strategy-pack-catalog";

const contracts = Object.freeze([
  Object.freeze({
    capabilityRevisions: Object.freeze([1, 2]),
    completion: Object.freeze({
      description:
        "Commit one public-commentary candidate using the exact registered semantic contract.",
      inputSchema: commentarySemanticWorkerCandidateSchema,
    }),
    definitionId: COMMENTARY_SEMANTIC_DEFINITION_ID,
    research: null,
  }),
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description: `Commit one configured public-commentary impact decision. ${COMMENTARY_ACTIONABILITY_TOOL_DESCRIPTION}`,
      inputSchema: commentaryActionabilityToolInputSchema,
    }),
    definitionId: PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
    definitionDigests: Object.freeze([
      createPublicCommentaryImpactDefinition(
        ["google/gemini-3.7-flash"],
        { allowedAdapterIds: QUALIFIED_PUBLIC_COMMENTARY_ADAPTER_IDS },
        "1.0.3",
      ).definitionDigest,
    ]),
    materializeCandidate: materializeCommentaryActionabilityCandidate,
    research: null,
  }),
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description:
        "Commit one public-commentary executive brief using the exact registered research contract.",
      inputSchema: publicCommentaryResearchWorkerCandidateSchema,
    }),
    definitionId: PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID,
    research: Object.freeze({
      approvedUrlPolicy: "evidence_sources" as const,
      budget: PUBLIC_COMMENTARY_AGENTIC_RESEARCH_BUDGET,
      requiresParentRunId: true as const,
    }),
  }),
] satisfies readonly HybridEvidenceWorkerContract[]);

export const hybridEvidenceWorkerContractRegistry =
  createHybridEvidenceWorkerContractRegistry(contracts);

export function resolveHybridEvidenceWorkerContract(
  definitionId: string,
  definitionDigest?: string,
): HybridEvidenceWorkerContract | null {
  return hybridEvidenceWorkerContractRegistry.resolve(definitionId, definitionDigest);
}

export function resolveStrategyPackResearchWorkerContract(
  pack: Pick<StrategyPackCatalogEntry, "evidenceContracts">,
): HybridEvidenceWorkerContract | null {
  const matches = (pack.evidenceContracts ?? []).flatMap(({ id }) => {
    const contract = resolveHybridEvidenceWorkerContract(id);
    return contract?.research ? [contract] : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}
