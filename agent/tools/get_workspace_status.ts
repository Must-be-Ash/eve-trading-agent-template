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

export default defineTool({
  description: "Inspect current-workspace monitor health, schedules, checkpoints, and budget policy without changing state.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    const runtimeScope = requirePhotonWorkspaceToolScope(ctx);
    const scope = authorizePhotonWorkspaceToolStore(ctx, runtimeScope);
    const monitors = await listWorkspaceMonitors(scope);
    const [budget, hybridEvidence, strategyPack] = await Promise.all([
      readWorkspaceDocument("budget", scope),
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
