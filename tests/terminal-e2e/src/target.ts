/**
 * The local run's two Workers, as scripts/dev.ts (terminal-api) and `pnpm preview` (terminal-web)
 * serve them: on 8811 and 3111, or on the ports E2E_API_PORT and E2E_WEB_PORT name, so a second
 * worktree's tests run beside a local run already up.
 */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 8811);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3111);
export const API = `http://localhost:${API_PORT}`;
export const WEB = `http://localhost:${WEB_PORT}`;

/** Aviary's own origins: a page view may request nothing from any other. */
export const OWN_ORIGINS = [new URL(API).origin, new URL(WEB).origin];

/**
 * `local`: a local validator running devnet's router, for a demo run (`pnpm --filter terminal-e2e
 * hooked:local`, #122): the API reads it and the test wallet sends to it.
 */
export type RpcMode = "devnet" | "fixtures" | "record" | "local";
export const RPC_MODE: RpcMode = ((): RpcMode => {
  const mode = process.env.E2E_RPC ?? (process.env.CI ? "fixtures" : "devnet");
  if (mode !== "devnet" && mode !== "fixtures" && mode !== "record" && mode !== "local") throw new Error(`E2E_RPC is ${mode}: use devnet, fixtures, record or local.`);
  return mode;
})();

/** The local validator of a `local` run: E2E_LOCAL_RPC, or the hooked-mints demo's (demo/hooked-validator.sh as docs/toolchain.md starts it). */
export const LOCAL_RPC = process.env.E2E_LOCAL_RPC ?? "http://127.0.0.1:8977";

/** Where the test wallet sends what it signs: the local validator on a `local` run, else devnet's RPC_URL. */
export const SEND_RPC = RPC_MODE === "local" ? LOCAL_RPC : (process.env.RPC_URL ?? "");
