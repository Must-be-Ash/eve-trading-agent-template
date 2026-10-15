import { digestHybridEvidenceValue, hybridEvidenceJobDefinitionSchema, type EvidenceLocator, type HybridEvidenceJobDefinition } from "./hybrid-evidence-schema";
import { commentarySemanticValidationContract, publicCommentaryImpactValidationContract } from "./public-commentary-semantics";
import { publicCommentaryResearchValidationContract } from "./public-commentary-research";

export interface WorkspaceSemanticValidationContract {
  readonly definitionId: string;
  readonly outputSchema: HybridEvidenceJobDefinition["outputSchema"];
  readonly requiredValidator: HybridEvidenceJobDefinition["requiredValidator"];
  validate(input: {
    readonly disposition: "accepted" | "abstained";
    readonly evidenceTexts?: readonly Readonly<{
      content: string;
      locator: EvidenceLocator;
    }>[];
    readonly fields: Readonly<Record<string, unknown>>;
    readonly inputProjection?: unknown;
    readonly unknowns: readonly string[];
  }): {
    readonly assertionCitations: readonly EvidenceLocator[];
    readonly payload: Readonly<Record<string, unknown>>;
    readonly requireExactCitations?: boolean;
  };
}

export interface WorkspaceSemanticValidationRegistry {
  resolve(definition: HybridEvidenceJobDefinition): WorkspaceSemanticValidationContract | null;
}

export function createWorkspaceSemanticValidationRegistry(
  contracts: readonly WorkspaceSemanticValidationContract[],
): WorkspaceSemanticValidationRegistry {
  const registered = [...contracts];
  if (new Set(registered.map((contract) => JSON.stringify([
    contract.definitionId,
    contract.outputSchema.schemaId,
    contract.outputSchema.schemaVersion,
    contract.requiredValidator.validatorId,
    contract.requiredValidator.version,
  ]))).size !== registered.length) {
    throw new Error("hybrid_semantic_contract_conflict");
  }
  return Object.freeze({
    resolve(definition: HybridEvidenceJobDefinition) {
      return registered.find((contract) =>
        contract.definitionId === definition.definitionId &&
        contract.outputSchema.schemaId === definition.outputSchema.schemaId &&
        contract.outputSchema.schemaVersion === definition.outputSchema.schemaVersion &&
        contract.requiredValidator.validatorId === definition.requiredValidator.validatorId &&
        contract.requiredValidator.version === definition.requiredValidator.version) ?? null;
    },
  });
}

export const workspaceSemanticValidationRegistry = createWorkspaceSemanticValidationRegistry([
  commentarySemanticValidationContract,
  publicCommentaryImpactValidationContract,
  publicCommentaryResearchValidationContract,
]);

export function createWorkspaceSemanticDefinition(input: {
  readonly allowedAdapterIds: readonly string[];
  readonly definitionId: string;
  readonly instruction: string;
  readonly inputProjection?: HybridEvidenceJobDefinition["inputProjection"];
  readonly limits?: Partial<HybridEvidenceJobDefinition["limits"]>;
  readonly modelIds: readonly string[];
  readonly outputSchemaId: string;
  readonly outputSchemaVersion?: string;
  readonly promptId: string;
  readonly validatorId: string;
  readonly version?: string;
}): HybridEvidenceJobDefinition {
  const modelIds = [...new Set(input.modelIds)].sort();
  if (modelIds.length === 0) throw new Error("hybrid_definition_model_policy_empty");
  const version = input.version ?? "1.0.0";
  const core = {
    accessClassifications: ["public"],
    allowedAdapterIds: [...new Set(input.allowedAdapterIds)].sort(),
    allowedMediaTypes: ["text/html", "text/plain"],
    allowedModelIds: modelIds,
    definitionId: input.definitionId,
    definitionVersion: version,
    inputProjection: input.inputProjection ??
      { schemaId: "authorized-public-text-projection", schemaVersion: "1.0.0" },
    instructionTemplate: {
      content: input.instruction,
      delimiterPolicy: "untrusted_evidence_xml/v1",
      digest: digestHybridEvidenceValue([
        input.promptId,
        version,
        input.instruction,
      ]),
      templateId: input.promptId,
      version,
    },
    limits: {
      maximumAttempts: 1,
      maximumEvidenceBytes: 64 * 1_024,
      maximumInputTokens: 8_000,
      maximumOutputTokens: 1_000,
      maximumPages: 0,
      maximumPaidCostUsd: "0.1000",
      maximumRows: 0,
      maximumRuntimeMs: 60_000,
      ...input.limits,
    },
    outputSchema: {
      schemaId: input.outputSchemaId,
      schemaVersion: input.outputSchemaVersion ?? "1.0.0",
    },
    purpose: "semantic_interpretation",
    recordType: "hybrid_evidence_job_definition",
    requiredValidator: { validatorId: input.validatorId, version: "1.0.0" },
    resultScope: "workspace",
    schemaVersion: 1,
    triggeringParserCodes: [],
  } as const;
  return hybridEvidenceJobDefinitionSchema.parse({
    ...core,
    definitionDigest: digestHybridEvidenceValue(core),
  });
}

