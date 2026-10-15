import { defineTool } from "eve/tools";
import { z } from "zod";

import { listWorkspaceMonitors } from "../lib/workspace-monitor-store";
import {
  readPublicSourceWorkspaceHealth,
  unavailablePublicSourceWorkspaceHealth,
} from "../lib/public-source-health";
import { inspectStrategyPackWorkspace } from "../lib/strategy-pack-service";
import { readWorkspaceDocument } from "../lib/workspace-state-store";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";
import { inspectWorkspaceHybridEvidence } from "../lib/hybrid-evidence-semantic";
import { readWorkspaceBudgetLedger, summarizeWorkspaceBudgetUsage } from "../lib/workspace-budget-ledger";

export default defineTool({
  description: "Inspect current-workspace monitor health, schedules, checkpoints, budget policy, and current usage including reservations. Usage is admission accounting, not an all-services invoice. Unavailable usage must not be treated as zero spend.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    const runtimeScope = requirePhotonWorkspaceToolScope(ctx);
    const scope = authorizePhotonWorkspaceToolStore(ctx, runtimeScope);
    const monitors = await listWorkspaceMonitors(scope);
    const [budget, budgetLedger, hybridEvidence, strategyPack] = await Promise.all([
      readWorkspaceDocument("budget", scope),
      readWorkspaceBudgetLedger(scope).catch(() => null),
      inspectWorkspaceHybridEvidence({
        scope,
        sourceReferences: monitors.flatMap((monitor) => monitor.publicSourceSubscriptions ?? []),
      }),
      inspectStrategyPackWorkspace({ scope, workspaceGeneration: runtimeScope.generation }),
    ]);
    const sourceHealth = await Promise.all(monitors.flatMap((monitor) =>
      (monitor.publicSourceSubscriptions ?? []).map((reference) =>
        readPublicSourceWorkspaceHealth({ reference, scope }).catch(() =>
          unavailablePublicSourceWorkspaceHealth(reference)))));
    return {
      budget,
      budgetUsage: budget && budgetLedger
        ? { status: "available", ...summarizeWorkspaceBudgetUsage(budgetLedger, new Date(), budget.value.ownerTimezone) }
        : { status: "unavailable" },
      sourceHealth,
      strategyPack,
      hybridEvidence,
      monitorCounts: {
        enabled: monitors.filter((monitor) => monitor.lifecycleState === "enabled").length,
        paused: monitors.filter((monitor) => monitor.lifecycleState !== "enabled" && monitor.lifecycleState !== "retired").length,
        retired: monitors.filter((monitor) => monitor.lifecycleState === "retired").length,
        total: monitors.length,
      },
      monitors,
    };
  },
});
