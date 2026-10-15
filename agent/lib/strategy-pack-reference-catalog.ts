export const PUBLIC_COMMENTARY_ALERT_PRESENTATION_ID = "alert.public-commentary-signal/v1";
export const PUBLIC_COMMENTARY_EVALUATION_TOOL_ID = "evaluate_public_commentary_signals";
export const PUBLIC_COMMENTARY_FINDING_SCHEMA_ID = "public-commentary-signal/v1";
export const PUBLIC_COMMENTARY_TRACKER_EVAL_SUITE_ID = "eval.public-commentary-tracker/v1";
export const PUBLIC_COMMENTARY_TRACKER_SOURCE_ID = "public-commentary-tracker-source";
// Logical configuration reference only: installation resolves an owner-selected X identity.
export const PUBLIC_COMMENTARY_TRACKER_SOURCE_URL = "https://api.x.com/2/users/by/username";
export const PUBLIC_COMMENTARY_TRACKER_SOURCE_ALLOWED_ORIGINS = Object.freeze(["https://api.x.com"]);
export const PUBLIC_COMMENTARY_TRACKER_SOURCE_CONTRACT_VERSION = "1.0.0";
export const PUBLIC_COMMENTARY_TRACKER_SOURCE_CONTRACT_DIGEST = "97c37a9d709181f355ef1e82a20de65306139836c1700a6f1efbe96ae0f6f979";
const xPublicStatementAdapterDefinitionCore = {
  acquisitionMethod: "poll",
  adapterId: "x-public-statements",
  adapterVersion: "1.0.0",
  authorityOrigin: "https://api.x.com",
  configurationSchemaVersion: 1,
  factSchemaVersions: ["public-statement/v1"],
  implementationRevision: 1,
  limits: {
    maximumArchiveBytes: 1,
    maximumFactsPerAcquisition: 200,
    maximumPdfBytes: 1,
    maximumPdfPages: 1,
    maximumResponseBytes: 1 * 1_024 * 1_024,
  },
  maximumCadenceMinutes: 60,
  minimumCadenceMinutes: 10,
  recordType: "public_source_adapter_definition",
  schemaVersion: 1,
} as const;

export const X_CONFIGURABLE_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER = Object.freeze({
  ...xPublicStatementAdapterDefinitionCore,
  adapterVersion: "1.1.0",
  definitionDigest: "e3ae1002875dc764e4f8e1f23e7fde6b32c97f096128a963a1dc8b7533ed84f6",
  maximumCadenceMinutes: 1_440,
});
export const X_CONFIGURABLE_PUBLIC_STATEMENTS_CONTRACT_DIGEST =
  "97c37a9d709181f355ef1e82a20de65306139836c1700a6f1efbe96ae0f6f979";


export const PUBLIC_COMMENTARY_TRACKER_EVAL_FIXTURE_IDS = Object.freeze([
  "fixture.public-commentary-tracker.forbidden-capability", "fixture.public-commentary-tracker.malformed",
  "fixture.public-commentary-tracker.no-view", "fixture.public-commentary-tracker.positive", "fixture.public-commentary-tracker.replay",
]);
export const STRATEGY_PACK_REFERENCE_CATALOG = Object.freeze({
  alertPresentationIds: Object.freeze([PUBLIC_COMMENTARY_ALERT_PRESENTATION_ID]),
  capabilityIds: Object.freeze([PUBLIC_COMMENTARY_EVALUATION_TOOL_ID, "skill.public-commentary-tracker-analysis"]),
  evalSuites: Object.freeze({[PUBLIC_COMMENTARY_TRACKER_EVAL_SUITE_ID]: PUBLIC_COMMENTARY_TRACKER_EVAL_FIXTURE_IDS}),
  findingSchemaIds: Object.freeze([PUBLIC_COMMENTARY_FINDING_SCHEMA_ID]),
  parameterizedSourceContracts: Object.freeze({}),
  sourceContracts: Object.freeze({
    [PUBLIC_COMMENTARY_TRACKER_SOURCE_ID]: Object.freeze({
      allowedOrigins: PUBLIC_COMMENTARY_TRACKER_SOURCE_ALLOWED_ORIGINS,
      canonicalUrl: PUBLIC_COMMENTARY_TRACKER_SOURCE_URL,
      contractDigest: PUBLIC_COMMENTARY_TRACKER_SOURCE_CONTRACT_DIGEST,
      contractVersion: PUBLIC_COMMENTARY_TRACKER_SOURCE_CONTRACT_VERSION,
    }),
  }),
});
export const STRATEGY_PACK_CAPABILITY_INVENTORY = Object.freeze([
  Object.freeze({category: "control" as const, id: PUBLIC_COMMENTARY_EVALUATION_TOOL_ID}),
]);
