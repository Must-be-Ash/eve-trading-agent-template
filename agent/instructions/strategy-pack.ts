import { defineDynamic, defineInstructions } from "eve/instructions";

import {
  resolveSessionStrategyPackRuntime,
  STRATEGY_PACK_RUNTIME_UNAVAILABLE_INSTRUCTION,
} from "../lib/strategy-pack-runtime";

type StrategyPackInstruction =
  | { readonly kind: "none" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "pack"; readonly workspaceInstruction: string };

export default defineDynamic(async (ctx) => {
  const attributes = ctx.session.auth.current?.attributes ?? {};
  // Resolve once per session and workspace binding, as the former
  // session.started resolver did, instead of before every model call.
  const resolved = await ctx.memo(
    ["strategy-pack-instruction", ctx.session.id, attributes.workspace_id ?? null, attributes.workspace_generation ?? null],
    async (): Promise<StrategyPackInstruction> => {
      try {
        const runtime = await resolveSessionStrategyPackRuntime({ ctx });
        if (!runtime || runtime.state === "unbound") return { kind: "none" };
        return { kind: "pack", workspaceInstruction: runtime.workspaceInstruction };
      } catch {
        return { kind: "unavailable" };
      }
    },
  );
  if (resolved.kind === "none") return null;
  if (resolved.kind === "unavailable") {
    return defineInstructions({ content: STRATEGY_PACK_RUNTIME_UNAVAILABLE_INSTRUCTION });
  }
  return defineInstructions({
    content: [
      "# Active workspace strategy pack",
      "",
      resolved.workspaceInstruction.trim(),
      "",
      "Apply only this exact installed pack. Do not infer missions, playbooks, sources, or capabilities from any other catalog entry.",
    ].join("\n"),
  });
});
