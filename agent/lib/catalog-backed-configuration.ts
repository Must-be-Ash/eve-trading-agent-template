export interface CatalogBackedFieldReference {
  readonly catalogDigest: string;
  readonly catalogId: string;
  readonly catalogRevision: number;
}

export interface CatalogBackedOption {
  readonly coverageReason: string | null;
  readonly coverageState: string;
  readonly id: string;
  readonly label: string;
}

export class CatalogBackedConfigurationError extends Error {
  constructor(readonly code: "catalog_reference_invalid" | "catalog_value_invalid") {
    super(code);
    this.name = "CatalogBackedConfigurationError";
  }
}

export function resolveCatalogBackedOptions(_reference: CatalogBackedFieldReference): readonly CatalogBackedOption[] {
  throw new CatalogBackedConfigurationError("catalog_reference_invalid");
}
export function assertCatalogBackedValues(_reference: CatalogBackedFieldReference, _values: readonly string[]): void {
  throw new CatalogBackedConfigurationError("catalog_reference_invalid");
}
