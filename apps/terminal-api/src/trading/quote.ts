// A quote while the trader types (docs/spec/pipescope-architecture.md, Trading path, step 1;
// PIPESCOPE-34, PIPESCOPE-76): the amount typed worked back to what goes into the market, then the
// strategy's own `pipeline_quote`, run by RPC simulation through Pipeline's SDK on Aviary's RPC, with
// the accounts the strategy asks for. The rates it was worked out at come back with it, so the trade
// box shows exactly the rate the swap is built from.
import { marketViewFeeSide, quoteStrategy, resolveAccounts, SimulationError, TradeMode, type FeeSide, type TradeRequest } from "@pipeline-sol/sdk";
import { address, type AccountMeta, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { HTTPException } from "hono/http-exception";
import type { Quote } from "../contract";
import type { IntegratorFeeVar } from "../env";
import { feeOf, keptAfterOutputFee, splitTyped } from "./amounts";
import { decodeFailure } from "./failure";
import { integratorFee, PIPELINE_RATE_BPS } from "./fees";
import type { TradeMarket } from "./market";

/** Quotes and simulations read the chain at `confirmed`, the commitment trades confirm at, so a quote never trails the last swap. */
export const COMMITMENT = "confirmed";

/** A refusal from the strategy or the chain, decoded, which the routes answer with a 422 and the failure. */
export class Refused extends Error {
  constructor(readonly failure: ReturnType<typeof decodeFailure>) {
    super(failure.sentence);
  }
}

export type QuoteInput = { market: TradeMarket; inputMint: string; outputMint: string; typed: bigint; trader: Address | null };

/** A quote, and what building its swap needs: the trade request, the strategy's accounts and the side Pipeline's fee is paid on. */
export type QuoteResult = { quote: Quote; trade: TradeRequest; strategyAccounts: AccountMeta[]; feeSide: FeeSide; integratorAccount: Address | null };

export async function quoteTyped(rpc: Rpc<SolanaRpcApi>, setting: IntegratorFeeVar, { market, inputMint, outputMint, typed, trader }: QuoteInput): Promise<QuoteResult> {
  const fee = integratorFee(setting);
  const inputIndex = market.mints.findIndex((m) => m.address === inputMint);
  const outputIndex = market.mints.findIndex((m) => m.address === outputMint);
  if (inputIndex < 0 || outputIndex < 0 || inputIndex === outputIndex) throw new HTTPException(400, { message: "input_mint and output_mint are two different mints of this market." });
  // The integrator fee only when the trader pays in a fee mint (PIPESCOPE-11).
  const integratorAccount = fee.accounts[inputMint] ? address(fee.accounts[inputMint]) : null;
  const integratorBps = integratorAccount ? fee.bps : 0;
  const feeSide = marketViewFeeSide(market.view, address(outputMint));
  const split = splitTyped(typed, { feeSide, pipelineBps: PIPELINE_RATE_BPS, integratorBps });
  if (split.netSent === 0n) throw new HTTPException(400, { message: "This amount is too small to pay the fees and still send anything into the market." });

  const trade: TradeRequest = { mode: TradeMode.ExactIn, inputIndex, outputIndex, amount: split.netSent, trader, extra: new Uint8Array() };
  // The fee wallet pays the simulation's fee (it does not sign), so a quote works before a wallet holds any SOL.
  const feePayer = address(fee.wallet);
  try {
    const strategyAccounts = await resolveAccounts(rpc, market.view, trade, feePayer, { commitment: COMMITMENT });
    const { quote, unitsConsumed } = await quoteStrategy(rpc, market.view, trade, strategyAccounts, feePayer, { commitment: COMMITMENT });
    const pipelineFee = feeSide === "output" ? feeOf(quote.amountOut, PIPELINE_RATE_BPS) : split.pipelineFeeOnInput;
    return {
      trade,
      strategyAccounts,
      feeSide,
      integratorAccount,
      quote: {
        market: market.address,
        input_mint: inputMint,
        output_mint: outputMint,
        amount: String(typed),
        fee_side: feeSide,
        pipeline_fee_bps: PIPELINE_RATE_BPS,
        integrator_fee_bps: integratorBps,
        net_sent: String(split.netSent),
        pipeline_fee: String(pipelineFee),
        pipeline_fee_mint: feeSide === "output" ? outputMint : inputMint,
        integrator_fee: String(split.integratorFee),
        total_spend: String(split.totalSpend),
        strategy_amount_out: String(quote.amountOut),
        expected_out: String(feeSide === "output" ? keptAfterOutputFee(quote.amountOut, PIPELINE_RATE_BPS) : quote.amountOut),
        compute_units: unitsConsumed === null ? null : Number(unitsConsumed),
      },
    };
  } catch (e) {
    if (e instanceof SimulationError) throw new Refused(decodeFailure(e.err, e.logs, { strategy: market.view.strategyProgram }));
    throw e;
  }
}
