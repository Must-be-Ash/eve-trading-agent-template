import type { SessionAuthContext } from "eve/context";

import { evaluatePublicCommentarySignalsForWorker } from "./public-commentary-workspace-worker";
import { PUBLIC_COMMENTARY_EVALUATION_TOOL_ID } from "./strategy-pack-reference-catalog";
import type { PreparedWorkspaceWorkerRun } from "./workspace-worker-runner";

/*
 * A scheduled occurrence used to run an LLM "worker" session whose only job was
 * to call exactly one deterministic evaluator tool (see the old
 * `subagents/workspace-worker`): "call `evaluate_<strategy>` exactly once; the
 * capability owns everything." That model turn did no reasoning - all
 * materiality, research, and brief judgement runs in nested hybrid-evidence
 * child jobs on the frontier model - yet it added a real failure mode: the
 * reasoning model intermittently returned an empty completion on its first turn
 * and paused live monitors, and no retry/upgrade fixed it because the turn
 * should not exist at all.
 *
 * Each evaluator is a plain function of a `WorkerContext`, which is nothing but
 * the signed, self-verifying dispatch envelope (`ctx.session.auth.current`).
 * Every finding, alert, checkpoint, and budget write it performs is a direct
 * store call keyed off that envelope, not an eve tool call. So the scheduler can
 * invoke the evaluator directly and skip the LLM entirely. This is the same code
 * the tool wrappers called; only the empty-response layer is gone.
 */

// The evaluator context: the entire authenticated surface an evaluator reads is
// `ctx.session.auth.current`, a `SessionAuth`-shaped holder of the signed
// runtime envelope produced by `prepareWorkspaceWorkerRun`.
type WorkspaceEvaluatorContext = {
  readonly session: {
    readonly auth: {
      readonly current: SessionAuthContext;
      readonly initiator: SessionAuthContext;
    };
  };
};

export class WorkspaceEvaluatorDispatchError extends Error {
  readonly code = "workspace_evaluator_unresolved";

  constructor() {
    super("workspace_evaluator_unresolved");
    this.name = "WorkspaceEvaluatorDispatchError";
  }
}

export function resolveWorkspaceEvaluatorCapabilityId(
  requiredCapabilityIds: readonly string[],
): string {
  const matches = requiredCapabilityIds.filter((id) =>
    id === PUBLIC_COMMENTARY_EVALUATION_TOOL_ID,
  );
  if (matches.length !== 1) throw new WorkspaceEvaluatorDispatchError();
  return matches[0]!;
}

/*
 * Run one monitor occurrence deterministically. The evaluator commits its
 * durable outcome (finding, alert presentations, checkpoint) before returning,
 * exactly as it did when an LLM called it; the scheduler then reads that
 * committed outcome from the store and delivers it. Throws propagate to the
 * scheduler unchanged, which records the failure and reconciles the budget.
 */
export async function runWorkspaceEvaluatorForMonitor(input: {
  readonly prepared: Pick<PreparedWorkspaceWorkerRun, "request">;
  readonly requiredCapabilityIds: readonly string[];
}): Promise<void> {
  const capabilityId = resolveWorkspaceEvaluatorCapabilityId(
    input.requiredCapabilityIds,
  );
  const auth = input.prepared.request.auth;
  const ctx: WorkspaceEvaluatorContext = {
    session: { auth: { current: auth, initiator: auth } },
  };
  if (capabilityId !== PUBLIC_COMMENTARY_EVALUATION_TOOL_ID) throw new WorkspaceEvaluatorDispatchError();
  await evaluatePublicCommentarySignalsForWorker({ ctx });
}
