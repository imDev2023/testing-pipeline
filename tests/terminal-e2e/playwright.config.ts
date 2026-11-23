// Adapted from Top-pad b833a7b, tests/ui/playwright.config.ts; owned here since.
// Aviary end to end (`pnpm --filter terminal-e2e e2e`), on the local run: `terminal-api` in
// `wrangler dev` against the Docker Postgres, and `terminal-web` built through OpenNext and run in
// `wrangler dev`, so the pages are the build that deploys (PIPESCOPE-96).
//
// Where the API's RPC goes, by E2E_RPC:
// - `devnet` (the default outside CI): RPC_URL from the project's .env, live devnet.
// - `fixtures` (the default in CI): recorded devnet answers from fixtures/devnet-rpc.json, no network.
// - `record`: live devnet through the fixture server, which records every answer it passes on.
//
// Before the tests, src/global-setup.ts fires the cron and waits for the indexer's first run.
//
// Every page test runs at 1440, 390 and 360 px wide in the light and the dark theme, and saves a
// screenshot of each page to screenshots/<width>-<theme>/.
import { defineConfig, devices } from "@playwright/test";
import { API, API_PORT, RPC_MODE, WEB, WEB_PORT } from "./src/target";
import { TEST_KEEPER_WALLET } from "./src/keeper";
import { RPC_PORT } from "./src/rpc";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set: it names the Docker Postgres (docs/toolchain.md, \"Aviary's local run\").");
const rpcUrl = RPC_MODE === "devnet" ? process.env.RPC_URL : `http://127.0.0.1:${RPC_PORT}`;
if (!rpcUrl) throw new Error("RPC_URL is not set: run with the project's .env loaded, or set E2E_RPC=fixtures.");
if (RPC_MODE === "record" && !process.env.RPC_URL) throw new Error("E2E_RPC=record needs RPC_URL: run with the project's .env loaded.");

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 360, height: 780 },
];
const THEMES = ["light", "dark"] as const;

export default defineConfig({
  testDir: "./src",
  // The indexer runs once the Workers are up, so the pages have devnet's markets to show.
  globalSetup: "./src/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: { baseURL: WEB, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  projects: [
    ...WIDTHS.flatMap((viewport) =>
      THEMES.map((colorScheme) => ({
        name: `${viewport.width}-${colorScheme}`,
        testMatch: /pages\.spec\.ts/,
        use: { viewport, colorScheme, isMobile: false },
      })),
    ),
    { name: "behaviour", testMatch: /behaviour\.spec\.ts/, use: { viewport: WIDTHS[0], colorScheme: "light" as const } },
    { name: "api", testMatch: /api\.spec\.ts/ },
  ],
  webServer: [
    // The fixture RPC, first, so the API can read it from its first request.
    ...(RPC_MODE === "devnet"
      ? []
      : [
          {
            command: RPC_MODE === "record" ? "node src/serve-rpc.ts --record" : "node src/serve-rpc.ts",
            url: `http://127.0.0.1:${RPC_PORT}/`,
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]),
    {
      // The keeper page's wallet is the tests' own, whose heartbeats they can sign (src/keeper.ts).
      command: `node scripts/dev.ts --var KEEPER_WALLET:${TEST_KEEPER_WALLET}`,
      cwd: "../../apps/terminal-api",
      env: { RPC_URL: rpcUrl, DATABASE_URL, TERMINAL_API_PORT: String(API_PORT) },
      url: `${API}/health`,
      // A running local API reads whatever RPC it was started with, so only a devnet run may reuse one.
      reuseExistingServer: !process.env.CI && RPC_MODE === "devnet",
      timeout: 120_000,
      stdout: "ignore",
    },
    {
      command: `pnpm exec opennextjs-cloudflare build && pnpm exec opennextjs-cloudflare preview --port ${WEB_PORT}`,
      cwd: "../../apps/terminal-web",
      env: { NEXT_PUBLIC_API_URL: API },
      url: WEB,
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
      stdout: "ignore",
    },
  ],
});
