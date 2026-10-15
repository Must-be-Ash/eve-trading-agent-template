export const PUBLIC_COMMENTARY_COPY = Object.freeze({
  relatedCoverage: {
    candidates_found: "Related public links were found. They are discovery candidates, not confirmation of the statement.",
    conflicting: "Permitted related evidence materially conflicts with the statement or with another cited source.",
    no_established_source_found: "The bounded search found no official or established-newsroom candidate under the recorded classification policy.",
    not_applicable: "No external factual claim required a related-source search for this opinion statement.",
    not_found: "The completed bounded search returned no related public candidate.",
    not_run: "Related-source corroboration was not run because it was disabled, unconfigured, or not required.",
    unavailable: "Related-source corroboration is unavailable because the provider failed, timed out, was rate-limited, or exhausted its budget.",
  },
  sourceQuality: {
    conflicting: "Conflicting evidence remains visible and cited; Eve lowers confidence or abstains rather than hiding it.",
    missing: "No related candidate was found within the bounded search; this is not proof that supporting or conflicting coverage does not exist.",
    unavailable: "The related-source provider was unavailable, so the direct statement remains visible without a corroboration claim.",
    unrun: "Corroboration was not run, so Eve makes no claim about related coverage.",
    weak: "A weak or unfamiliar source remains visible and cited with its classification; it is not treated as verified truth.",
  },
});

