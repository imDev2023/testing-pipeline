/**
 * Aviary's hosted devnet deployment (#192), which `pnpm --filter terminal-e2e deployed` checks: the
 * two Workers `pnpm terminal:deploy` printed, or the URLs E2E_DEPLOYED_WEB and E2E_DEPLOYED_API name.
 */
export const DEPLOYED_WEB = process.env.E2E_DEPLOYED_WEB ?? "https://terminal-web-devnet.rc-labs.workers.dev";
export const DEPLOYED_API = process.env.E2E_DEPLOYED_API ?? "https://terminal-api-devnet.rc-labs.workers.dev";

/** The deployment's own origins: a page view may request nothing from any other. */
export const DEPLOYED_ORIGINS = [new URL(DEPLOYED_WEB).origin, new URL(DEPLOYED_API).origin];
