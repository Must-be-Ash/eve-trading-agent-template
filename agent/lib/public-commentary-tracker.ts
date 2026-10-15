import { marketSymbolSchema } from "./strategy-pack-schema";
import { parseConfirmedXPublicIdentity } from "./x-public-identity";

export interface PublicCommentaryImpactHypothesis {
  readonly asset: string;
  readonly outcome: string;
  readonly pressure: "down" | "up";
}

export type PublicCommentaryImpactClassification = "de_escalation" | "escalation" | "mixed" | "unclear";

export function parsePublicCommentaryImpactHypotheses(values: unknown): readonly PublicCommentaryImpactHypothesis[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
    throw new Error("public_commentary_impact_hypotheses_invalid");
  }
  const parsed = values.map((value) => {
    if (typeof value !== "string") throw new Error("public_commentary_impact_hypotheses_invalid");
    const [outcome, assetValue, pressure, ...remainder] = value.split("|");
    const asset = marketSymbolSchema.safeParse(assetValue);
    if (
      remainder.length !== 0 || !outcome || outcome.trim() !== outcome ||
      !asset.success || (pressure !== "up" && pressure !== "down")
    ) throw new Error("public_commentary_impact_hypotheses_invalid");
    return Object.freeze({ asset: asset.data, outcome, pressure });
  });
  return Object.freeze(parsed);
}

export function resolvePublicCommentaryTrackerSourcePolicy(configuration: Readonly<Record<string, unknown>>) {
  let identity;
  try { identity = parseConfirmedXPublicIdentity(configuration.xIdentity); }
  catch { throw new Error("public_commentary_tracker_identity_unconfirmed"); }
  return Object.freeze({ numericUserId: identity.numericUserId, sourceKind: "x_user_timeline" as const, xEnabled: true as const });
}

export function classifyPublicCommentaryImpact(text: string, hypotheses: readonly PublicCommentaryImpactHypothesis[], topics: readonly string[] = []): Readonly<{asset: string | null; classification: PublicCommentaryImpactClassification; pressure: "down" | "up" | null}> {
  const normalized = text.toLocaleLowerCase("en-US");
  const relevant = topics.length === 0 || topics.some(topic => normalized.includes(topic.toLocaleLowerCase("en-US")));
  const matches = relevant ? hypotheses.filter(({outcome}) => normalized.includes(outcome.toLocaleLowerCase("en-US"))) : [];
  if (matches.length !== 1) return Object.freeze({asset: null, classification: matches.length > 1 ? "mixed" : "unclear", pressure: null});
  const match = matches[0]!;
  return Object.freeze({asset: match.asset, classification: match.pressure === "up" ? "escalation" : "de_escalation", pressure: match.pressure});
}
