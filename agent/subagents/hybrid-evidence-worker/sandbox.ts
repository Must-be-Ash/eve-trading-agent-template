import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { VercelSandbox } from "eve/sandbox/vercel";

// Keep native isolation on both hosts: Vercel Sandbox when deployed, Docker locally.
export const environment = process.env.VERCEL
  ? VercelSandbox.environment()
  : DockerSandbox.environment();

export default defineSandbox(() => environment.open({ networkPolicy: "deny-all" }));
