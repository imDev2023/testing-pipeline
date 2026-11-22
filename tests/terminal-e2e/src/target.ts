/** The local run's two Workers, as scripts/dev.ts (terminal-api) and `pnpm preview` (terminal-web) serve them. */
export const API = "http://localhost:8811";
export const WEB = "http://localhost:3111";

/** Aviary's own origins: a page view may request nothing from any other. */
export const OWN_ORIGINS = [new URL(API).origin, new URL(WEB).origin];

export type RpcMode = "devnet" | "fixtures" | "record";
export const RPC_MODE: RpcMode = ((): RpcMode => {
  const mode = process.env.E2E_RPC ?? (process.env.CI ? "fixtures" : "devnet");
  if (mode !== "devnet" && mode !== "fixtures" && mode !== "record") throw new Error(`E2E_RPC is ${mode}: use devnet, fixtures or record.`);
  return mode;
})();
