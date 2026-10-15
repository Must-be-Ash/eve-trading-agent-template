import {
  createPublicCommentaryResearchDefinition,
  PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID,
  PUBLIC_COMMENTARY_RESEARCH_DEFINITION_VERSIONS,
} from "./public-commentary-research";
export interface PublicCommentaryResearchContract {
  readonly definitionId: string;
  readonly versions: readonly string[];
  createDefinition(
    modelIds: readonly string[],
    version: string,
  ): ReturnType<typeof createPublicCommentaryResearchDefinition>;
}

const contracts = new Map<string, PublicCommentaryResearchContract>([
  [PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID, Object.freeze({
    createDefinition: (modelIds: readonly string[], version: string) =>
      createPublicCommentaryResearchDefinition(
        [...modelIds],
        version as (typeof PUBLIC_COMMENTARY_RESEARCH_DEFINITION_VERSIONS)[number],
      ),
    definitionId: PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID,
    versions: PUBLIC_COMMENTARY_RESEARCH_DEFINITION_VERSIONS,
  })],
]);

/**
 * The research contract a pack declares, or null when it declares none. A pack
 * declaring more than one is ambiguous and resolves to null rather than
 * guessing which lane the owner meant.
 */
export function resolvePublicCommentaryResearchContract(pack: Readonly<{
  evidenceContracts?: readonly Readonly<{ id: string; version: string }>[];
}>): Readonly<{ contract: PublicCommentaryResearchContract; version: string }> | null {
  const declared = (pack.evidenceContracts ?? []).flatMap(({ id, version }) => {
    const contract = contracts.get(id);
    return contract && contract.versions.includes(version)
      ? [Object.freeze({ contract, version })]
      : [];
  });
  return declared.length === 1 ? declared[0]! : null;
}
