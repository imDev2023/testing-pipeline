// Adapted from Top-pad b833a7b, apps/web/next.config.ts; owned here since.
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // terminal-api's product readings import the programs' generated clients, TypeScript as written.
  transpilePackages: ["terminal-api", "buy-wall-amm-scripts", "tax-amm-scripts"],
  images: { unoptimized: true },
  // Next's dev badge would sit over the pages the end-to-end tests photograph.
  devIndicators: false,
  // The repo's agent instructions live in CLAUDE.md files, never AGENTS.md.
  agentRules: false,
};

initOpenNextCloudflareForDev();
export default config;
