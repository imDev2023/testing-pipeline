// The fees of a swap (docs/spec/pipescope.md, The integrator fee; PIPESCOPE-10 to PIPESCOPE-13,
// PIPESCOPE-91): Pipeline's own rate, and Aviary's integrator fee from terminal-api's INTEGRATOR_FEE
// var, read and checked here, the one place a swap or a page gets them from.
import { PIPELINE_FEE_BPS } from "@pipeline-sol/sdk";
import { HTTPException } from "hono/http-exception";
import { AVIARY_MINT_NAMES } from "../config";
import type { Fees } from "../contract";
import type { IntegratorFeeVar } from "../env";

/**
 * Pipeline's fee, in basis points. The router holds it as a constant of its program (Pipeline 0.3
 * keeps no fee in its config account), so it is read from Pipeline's SDK at the version pinned with
 * the router, and served from here; no page writes it.
 */
export const PIPELINE_RATE_BPS = Number(PIPELINE_FEE_BPS);

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The integrator fee's settings, checked: a rate a u16 holds below 100%, and real addresses. */
export function integratorFee(setting: IntegratorFeeVar): IntegratorFeeVar {
  const ok =
    setting !== null &&
    typeof setting === "object" &&
    Number.isInteger(setting.bps) &&
    setting.bps >= 0 &&
    setting.bps < 10_000 &&
    typeof setting.wallet === "string" &&
    ADDRESS.test(setting.wallet) &&
    setting.accounts !== null &&
    typeof setting.accounts === "object" &&
    Object.entries(setting.accounts).every(([mint, account]) => ADDRESS.test(mint) && typeof account === "string" && ADDRESS.test(account));
  if (!ok) throw new HTTPException(500, { message: "Aviary's fee settings cannot be read, so it quotes and builds no swap until they are fixed." });
  return setting;
}

/** What `GET /v1/fees` serves. */
export function feesView(setting: IntegratorFeeVar): Fees {
  const fee = integratorFee(setting);
  return {
    pipeline_fee_bps: PIPELINE_RATE_BPS,
    integrator_fee_bps: fee.bps,
    fee_wallet: fee.wallet,
    fee_mints: Object.entries(fee.accounts).map(([mint, account]) => ({ mint, symbol: AVIARY_MINT_NAMES[mint] ?? mint, account })),
  };
}
