import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import { vercel } from "eve/sandbox/vercel";

export default defineSandbox({
  backend: process.env.VERCEL
    ? vercel({ networkPolicy: "deny-all" })
    : docker({ networkPolicy: "deny-all" }),
});
