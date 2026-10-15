export const PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID =
  "monitor.public-commentary-cadence/v1";

export interface WorkspaceMonitorLifecycleContract {
  readonly activationWatermark: "none" | "on_enable";
  readonly deferredSourceRetry: "none";
  readonly id: string;
  readonly initialEvaluationWindow: "created_at" | "preceding_interval";
  readonly initialOccurrence: "scheduled" | "immediate";
  readonly sourceAdmission: "any_declared_source";
  readonly sourcelessInstall: "allowed" | "forbidden";
  readonly admitsActivationSources: (
    sources: readonly { readonly sourceId: string }[],
  ) => boolean;
}

const commentaryContract: WorkspaceMonitorLifecycleContract = Object.freeze({
  activationWatermark: "on_enable",
  deferredSourceRetry: "none",
  id: PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
  initialEvaluationWindow: "preceding_interval",
  initialOccurrence: "immediate",
  sourceAdmission: "any_declared_source",
  sourcelessInstall: "forbidden",
  admitsActivationSources: (sources: readonly { readonly sourceId: string }[]) => sources.length > 0,
});

export function resolveWorkspaceMonitorLifecycleContract(
  contractId: string | null | undefined,
): WorkspaceMonitorLifecycleContract | null {
  return contractId === commentaryContract.id ? commentaryContract : null;
}

export function resolveManagedMonitorLifecycleContract(input: Readonly<{
  lifecycleContractId?: string | null;
  managedBy?: Readonly<{
    packId: string;
    packVersion: string;
    resourceId: string;
  }> | null;
}>): WorkspaceMonitorLifecycleContract | null {
  return resolveWorkspaceMonitorLifecycleContract(input.lifecycleContractId);
}
