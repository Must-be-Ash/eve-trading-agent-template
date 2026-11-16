import { usage } from "eve/events";
import { defineHook } from "eve/hooks";

import {
  decodeHybridEvidenceWorkerToken,
  hybridEvidenceWorkerTokenFromSessionAuth,
} from "../../../lib/hybrid-evidence-auth";

/**
 * Enforces the signed job's token reservation as a hard stop.
 *
 * Eve 1.0 removed per-session token caps from runtime subagent configs, and its
 * `sessionUsage` limit pauses for a person, which an unattended worker never
 * has. A hook error fails the running turn, so the parent records the attempt
 * as failed instead of letting the worker spend past its reservation.
 */
export default defineHook({
  events: {
    "usage.recorded"(_event, ctx) {
      const token = hybridEvidenceWorkerTokenFromSessionAuth(ctx.session.auth);
      if (!token) return;
      const { budget } = decodeHybridEvidenceWorkerToken(token, { now: ctx.now });
      const { total } = usage(ctx.view);
      if (total.inputTokens > budget.inputTokens || total.outputTokens > budget.outputTokens) {
        throw new Error("hybrid_evidence_token_budget_exceeded");
      }
    },
  },
});
