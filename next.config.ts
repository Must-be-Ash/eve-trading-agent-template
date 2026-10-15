import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};
export default withEve(nextConfig, { eveBuildCommand: "npm run build:agent" });
