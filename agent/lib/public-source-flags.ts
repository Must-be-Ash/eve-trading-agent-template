export type XPublicStatementRuntimePath = "disabled" | "public_source_adapter" | "public_source_misconfigured";
export function resolveXPublicStatementRuntimePath(environment: NodeJS.ProcessEnv = process.env): XPublicStatementRuntimePath {
  if (environment.EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED !== "1") return "disabled";
  return environment.EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED === "1" && environment.EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED === "1"
    ? "public_source_adapter" : "public_source_misconfigured";
}
