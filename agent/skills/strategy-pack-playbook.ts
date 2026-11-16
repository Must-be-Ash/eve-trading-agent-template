import { defineDynamic, defineSkill } from "eve/skills";

import { resolveSessionStrategyPackRuntime } from "../lib/strategy-pack-runtime";

type StrategyPackSkill = { readonly description: string; readonly id: string; readonly instruction: string };

export default defineDynamic(async (ctx) => {
  const attributes = ctx.session.auth.current?.attributes ?? {};
  // Resolve once per session and workspace binding, as the former
  // session.started resolver did, instead of before every model call.
  const skills = await ctx.memo(
    ["strategy-pack-skills", ctx.session.id, attributes.workspace_id ?? null, attributes.workspace_generation ?? null],
    async (): Promise<StrategyPackSkill[] | null> => {
      try {
        const runtime = await resolveSessionStrategyPackRuntime({ ctx });
        if (!runtime || runtime.state === "unbound") return null;
        return runtime.skills.map((skill) => ({
          description: skill.description,
          id: skill.id,
          instruction: skill.instruction,
        }));
      } catch {
        return null;
      }
    },
  );
  if (!skills) return null;
  return Object.fromEntries(
    skills.map((skill) => [
      skill.id,
      defineSkill({ content: skill.instruction, description: skill.description }),
    ]),
  );
});
