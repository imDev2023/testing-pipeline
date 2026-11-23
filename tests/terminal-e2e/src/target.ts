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

export type RpcMode = "devnet" | "fixtures" | "record";
export const RPC_MODE: RpcMode = ((): RpcMode => {
  const mode = process.env.E2E_RPC ?? (process.env.CI ? "fixtures" : "devnet");
  if (mode !== "devnet" && mode !== "fixtures" && mode !== "record") throw new Error(`E2E_RPC is ${mode}: use devnet, fixtures or record.`);
  return mode;
})();
