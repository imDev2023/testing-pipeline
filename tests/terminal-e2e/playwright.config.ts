// Adapted from Top-pad b833a7b, tests/ui/playwright.config.ts; owned here since.
// Aviary end to end (`pnpm --filter terminal-e2e e2e`), on the local run: `terminal-api` in
// `wrangler dev` against the Docker Postgres, and `terminal-web` built through OpenNext and run in
// `wrangler dev`, so the pages are the build that deploys (PIPESCOPE-96).
//
// Where the API's RPC goes, by E2E_RPC:
// - `devnet` (the default outside CI): RPC_URL from the project's .env, live devnet.
// - `fixtures` (the default in CI): recorded devnet answers from fixtures/devnet-rpc.json, and the
//   strategies' metadata documents from fixtures/metadata.json, no network.
// - `record`: live devnet and the web through the fixture server, which records every answer it passes on.
// - `local`: a local validator running devnet's router (E2E_LOCAL_RPC), for the hooked-mints demo run
//   (`pnpm --filter terminal-e2e hooked:local`, #122), whose one project buys and sells hooked mints
//   through the trade box (src/trade-hooked.spec.ts); docs/toolchain.md, "Aviary's hooked-mints demo".
//
// Before the tests, src/global-setup.ts fires the cron and waits for the indexer's first run.
//
// `pnpm --filter terminal-e2e swaps:devnet` adds real swaps through the trade box (E2E_SWAPS), and
// `wallet:devnet` the wallet page's devnet demo (E2E_WALLET_DEVNET).
//
// Every page test runs at 1440, 390 and 360 px wide in the light and the dark theme, and saves a
// screenshot of each page to screenshots/<width>-<theme>/.
import { defineConfig, devices, type PlaywrightTestOptions, type Project } from "@playwright/test";
import { API, API_PORT, LOCAL_RPC, RPC_MODE, WEB, WEB_PORT } from "./src/target";
import { TEST_KEEPER_WALLET } from "./src/keeper";
import { METADATA_PATH, RPC_PORT } from "./src/rpc";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set: it names the Docker Postgres (docs/toolchain.md, \"Aviary's local run\").");
const rpcUrl = RPC_MODE === "devnet" ? process.env.RPC_URL : RPC_MODE === "local" ? LOCAL_RPC : `http://127.0.0.1:${RPC_PORT}`;
const LOCAL = RPC_MODE === "local";
if (!rpcUrl) throw new Error("RPC_URL is not set: run with the project's .env loaded, or set E2E_RPC=fixtures.");
if (RPC_MODE === "record" && !process.env.RPC_URL) throw new Error("E2E_RPC=record needs RPC_URL: run with the project's .env loaded.");

// E2E_SWAPS adds the project that sends real swaps on devnet, with the test trader's key.
const SWAPS = Boolean(process.env.E2E_SWAPS);
if (SWAPS && RPC_MODE !== "devnet") throw new Error("E2E_SWAPS sends real devnet swaps: run it with E2E_RPC=devnet.");
// E2E_WALLET_DEVNET adds the wallet page's devnet project (#122), which unwraps the project wallet's wrapped SOL.
const WALLET_DEVNET = Boolean(process.env.E2E_WALLET_DEVNET);
if (WALLET_DEVNET && RPC_MODE !== "devnet") throw new Error("E2E_WALLET_DEVNET sends a real devnet transaction: run it with E2E_RPC=devnet.");

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 360, height: 780 },
];
const THEMES = ["light", "dark"] as const;

/**
 * The suite's projects. Each reads the API as a reader of its own, under a client address of its own
 * (`cf-connecting-ip`, which the API's per-IP limits key on, PIPESCOPE-90), so one project's reads
 * never spend another's 300 a minute: the suite is many readers on one machine, and how fast a
 * runner gets through the pages must not decide whether a later project is refused. The API spec's
 * own limit test names an address of its own on each request.
 */
const PROJECTS: Project<PlaywrightTestOptions>[] = [
  ...WIDTHS.flatMap((viewport) =>
    THEMES.map((colorScheme) => ({
      name: `${viewport.width}-${colorScheme}`,
      testMatch: /pages\.spec\.ts/,
      use: { viewport, colorScheme, isMobile: false },
    })),
  ),
  { name: "behaviour", testMatch: /behaviour\.spec\.ts/, use: { viewport: WIDTHS[0], colorScheme: "light" as const } },
  // Search and token names and images (#120).
  { name: "search", testMatch: /search\.spec\.ts/, use: { viewport: WIDTHS[0], colorScheme: "light" as const } },
  // Live updates: swaps landed on devnet, or announced on the fixture socket (src/live.ts).
  { name: "live", testMatch: /live\.spec\.ts/, use: { viewport: WIDTHS[0], colorScheme: "light" as const } },
  { name: "api", testMatch: /api\.spec\.ts/ },
  // The trade box with the Playwright test wallet: quotes, reviews and refusals, never sending (src/trade.spec.ts).
  { name: "trade", testMatch: /trade\.spec\.ts/, use: { viewport: WIDTHS[0], colorScheme: "light" as const } },
  // Canary's devnet criterion (src/canary-devnet.spec.ts), on a devnet run after Canary's sweep: never on CI's fixtures.
  ...(RPC_MODE === "devnet" ? [{ name: "canary-devnet", testMatch: /canary-devnet\.spec\.ts/, use: { viewport: WIDTHS[0], colorScheme: "light" as const } }] : []),
  // Real swaps on devnet through the trade box (src/trade-devnet.spec.ts): only when asked for, never in CI.
  // The wallet page with the Playwright test wallet: holdings, swaps and the unwrap reviewed, never sending (src/wallet.spec.ts, #122).
  { name: "wallet", testMatch: /wallet\.spec\.ts/, use: { viewport: WIDTHS[0], colorScheme: "light" as const } },
  ...(SWAPS ? [{ name: "swaps", testMatch: /trade-devnet\.spec\.ts/, use: { viewport: WIDTHS[0], colorScheme: "light" as const } }] : []),
  // The project wallet's swaps against the hosted API and its wrapped SOL unwrapped on devnet (src/wallet-devnet.spec.ts): only when asked for, never in CI.
  ...(WALLET_DEVNET ? [{ name: "wallet-devnet", testMatch: /wallet-devnet\.spec\.ts/, use: { viewport: WIDTHS[0], colorScheme: "light" as const } }] : []),
];

/** A project with a client address of its own, in the range set aside for tests (198.18.0.0/15). */
const ownReader = (project: Project<PlaywrightTestOptions>, i: number): Project<PlaywrightTestOptions> => ({ ...project, use: { ...project.use, extraHTTPHeaders: { ...project.use?.extraHTTPHeaders, "cf-connecting-ip": `198.18.0.${i + 1}` } } });

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
  projects: LOCAL
    ? // A local demo run: the hooked mints, bought and sold through the trade box, and nothing else, since the pages' other tests read devnet's markets.
      [{ name: "hooked", testMatch: /trade-hooked\.spec\.ts/, use: { viewport: WIDTHS[0], colorScheme: "light" as const } }]
    : PROJECTS.map(ownReader),
  webServer: [
    // The fixture RPC, first, so the API can read it from its first request.
    ...(RPC_MODE === "devnet" || LOCAL
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
      // Off devnet, strategies' metadata documents are read through the fixture server too. Canary's
      // container is not built: the pages show real results the global setup stores for six markets
      // (src/canary.ts), and Canary's runs are checked by its own demos and devnet tests.
      command: `node scripts/dev.ts --var KEEPER_WALLET:${TEST_KEEPER_WALLET}${RPC_MODE === "devnet" || LOCAL ? "" : ` --var TEST_METADATA_FIXTURES:http://127.0.0.1:${RPC_PORT}${METADATA_PATH}`} --enable-containers=false`,
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
