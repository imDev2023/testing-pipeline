// Every page built so far on Aviary's hosted devnet deployment (#192): `pnpm --filter terminal-e2e
// deployed`, after `pnpm terminal:deploy`. It starts no server and seeds nothing, since the pages
// read the deployment's own API and database (src/deployed.spec.ts); each page is checked at 1440,
// 390 and 360 px in the light and the dark theme, and its screenshot saved to
// screenshots/deployed-<width>-<theme>/. Never in CI: it reads the live deployment.
import { defineConfig, devices } from "@playwright/test";
import { DEPLOYED_WEB } from "./src/deployedTarget";

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 360, height: 780 },
];
const THEMES = ["light", "dark"] as const;

export default defineConfig({
  testDir: "./src",
  testMatch: /deployed\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results/deployed",
  use: { baseURL: DEPLOYED_WEB, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  projects: WIDTHS.flatMap((viewport) => THEMES.map((colorScheme) => ({ name: `deployed-${viewport.width}-${colorScheme}`, use: { viewport, colorScheme, isMobile: false } }))),
});
