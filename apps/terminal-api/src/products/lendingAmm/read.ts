// The lending AMM panel's read of the chain (#88): the market state first, for the accounts it names,
// then the market state again with Kamino's reserve, its lending market, the clock, the LP mint, the
// lock account and the viewing wallet's shares account in one `getMultipleAccounts`, so every figure
// comes from one slot. The panel works only from that second read, which is pinned to no slot, so
// Aviary's recorded test fixtures can hold it.
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { address, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { CLOCK_SYSVAR, lendingAmm } from "keeper-jobs/lending-amm.ts";
import { findAuthorityPda, findLpSharesPda, getLendingAmmMarketDecoder } from "lending-amm-scripts/client/index.ts";
import { decodeReserve } from "lending-amm-scripts/kamino.ts";
import { lendingView, type LendingView } from "./view";

/** The lending AMM's program on Aviary's cluster, the one its generated client names. */
export const LENDING_AMM_PROGRAM: Address = lendingAmm.programAddress;

/** Why a market state cannot be read as a lending AMM market. */
export class NotLendingMarket extends Error {}

const COMMITMENT = "confirmed";
const bytes = (data: readonly [string, string] | undefined | null) => (data ? new Uint8Array(Buffer.from(data[0], "base64")) : null);

export type LendingRead = { view: LendingView; lockAccount: Address; sharesAccount: Address | null; reserveLiquiditySupply: Address | null };

/** Reads the market state and every account the panel needs at one slot, and works the panel out. */
export async function readLending(rpc: Rpc<SolanaRpcApi>, marketState: Address, wallet: Address | null): Promise<LendingRead> {
  const first = await rpc.getAccountInfo(marketState, { encoding: "base64", commitment: COMMITMENT }).send();
  const data = bytes(first.value?.data);
  if (!first.value || !data || first.value.owner !== LENDING_AMM_PROGRAM || !lendingAmm.isMarket(data)) throw new NotLendingMarket(`${marketState} is not a lending AMM market state.`);
  const state = getLendingAmmMarketDecoder().decode(data);
  const watched = lendingAmm.watches!(data);
  const [authority] = await findAuthorityPda({ marketState });
  const [lockAccount] = await findAssociatedTokenPda({ owner: authority, mint: state.lpMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const sharesAccount = wallet ? (await findLpSharesPda({ marketState, lp: wallet }))[0] : null;
  const reserve = watched[0]!;
  const lendingMarket = watched.length === 3 ? watched[1]! : null;
  const wanted = [marketState, reserve, ...(lendingMarket ? [lendingMarket] : []), CLOCK_SYSVAR, state.lpMint, lockAccount, ...(sharesAccount ? [sharesAccount] : [])];
  // One getMultipleAccounts answers from one slot, so every figure the panel shows is of that slot.
  const { context, value } = await rpc.getMultipleAccounts(wanted, { encoding: "base64", commitment: COMMITMENT }).send();
  const at = (account: Address) => bytes(value[wanted.indexOf(account)]?.data);
  const stateNow = at(marketState);
  if (!stateNow || !lendingAmm.isMarket(stateNow)) throw new NotLendingMarket(`${marketState} is no longer a lending AMM market state.`);
  const reserveData = at(reserve);
  const view = lendingView({
    slot: context.slot,
    marketState,
    state: stateNow,
    reserve: reserveData,
    lendingMarket: lendingMarket ? at(lendingMarket) : null,
    clock: at(CLOCK_SYSVAR),
    lpMint: at(state.lpMint),
    lockAccount: at(lockAccount),
    ...(sharesAccount ? { walletShares: at(sharesAccount) } : {}),
  });
  const decoded = reserveData ? decodeReserve(reserveData) : null;
  return { view, lockAccount, sharesAccount, reserveLiquiditySupply: decoded && typeof decoded !== "string" ? address(decoded.liquiditySupply) : null };
}
