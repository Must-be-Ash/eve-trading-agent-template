import type { WorkspaceRunOutcome } from "./workspace-finding-store";
import type { WorkspaceWorkerControlPlaneClients } from "./workspace-worker-control-plane";
import type { PreparedWorkspaceWorkerRecovery } from "./workspace-worker-runner";

// The X evaluator has no complete crash-recovery receipt for its source
// acknowledgement and multiple alert presentations. A lost occurrence must be
// quarantined by the scheduler instead of repeating potentially paid work or
// reporting that its checkpoint and deliveries have been recovered.
export async function recoverWorkspaceRunForControlPlane(_input: {
  readonly clients?: WorkspaceWorkerControlPlaneClients;
  readonly now?: Date;
  readonly prepared: PreparedWorkspaceWorkerRecovery;
}): Promise<
  | { readonly status: "not_applicable" | "missing" }
  | { readonly status: "recovered" | "already_completed"; readonly outcome: WorkspaceRunOutcome }
> {
  return { status: "not_applicable" };
}
