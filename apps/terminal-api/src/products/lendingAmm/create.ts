// The lending AMM's create form (docs/spec/lending-pool.md, "Creating a market" and "Creation
// parameters"; #88): one transaction, as Pipeline's guide recommends, of the router's `create_market`
// from the strategy's metadata `init`, the router's `init_fee_account` for each of the two mints, and
// the strategy's `add_liquidity` from its metadata, which makes the first deposit and sets the price.
// The form takes the other mint first and the lent mint second, as the metadata's `init` does, so
// `lent_index` is 1; the collateral mint and the reserve are the lent mint's, read from the reserve the
// program lends it to. SOL is wrapped before the deposit and the wrapped-SOL account closed back after
// it as for any custom action (PIPESCOPE-145), and a hooked token's deposit carries its hook's
// accounts (PIPESCOPE-154). Built and simulated with the wallet as fee payer; Aviary signs nothing.
import { buildCreateMarketFromMetadata, initFeeAccount, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, type MarketView, type MetadataInit } from "@pipeline-sol/sdk";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { AccountRole, address, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { LENT_RESERVES } from "keeper-jobs/lending-amm.ts";
import { MINIMUM_LIQUIDITY } from "lending-amm-scripts/client/index.ts";
import { decodeReserve } from "lending-amm-scripts/kamino.ts";
import type { AviaryAction } from "strategy-actions";
import { CREATE_MARKET_MAX_CREATOR_LAMPORTS, LENDING_AMM } from "../../config";
import { actionTransaction, prepareTransaction, walletWrappedSol } from "../../trading/action";
import { hookAccounts } from "../../trading/hooks";
import { transferHookProgram } from "../../trading/market";
import { Refused } from "../../trading/quote";
import type { PrepareLendingCreate, PreparedLendingCreate } from "./contract";
import { LENDING_AMM_PROGRAM } from "./read";

const refusal = (sentence: string) => new Refused({ class: "bad_input", sentence, name: null, number: null, message: null, program: null, raw: sentence });

/** `isqrt`, as the program takes the first deposit's shares. */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** The shares a first deposit mints: `isqrt(other x lent) - MINIMUM_LIQUIDITY`, or 0 when it would not be above 0. */
export const firstShares = (other: bigint, lent: bigint) => {
  const root = isqrt(other * lent);
  return root > MINIMUM_LIQUIDITY ? root - MINIMUM_LIQUIDITY : 0n;
};

type Source = { init: MetadataInit; addLiquidity: AviaryAction };

/** The mints the program lends on this cluster: each reserve of its list that exists here, with its liquidity mint, the mint's decimals and the collateral mint. */
export async function lentMints(rpc: Rpc<SolanaRpcApi>): Promise<{ mint: Address; decimals: number; reserve: Address; collateralMint: Address }[]> {
  const { value } = await rpc.getMultipleAccounts(LENT_RESERVES.map((r) => r.reserve), { encoding: "base64", commitment: "confirmed" }).send();
  const found = value.flatMap((account, i) => {
    if (!account) return [];
    const view = decodeReserve(new Uint8Array(Buffer.from(account.data[0], "base64")));
    return typeof view === "string" ? [] : [{ mint: address(view.liquidityMint), reserve: LENT_RESERVES[i]!.reserve, collateralMint: address(view.collateralMint) }];
  });
  if (!found.length) return [];
  const mints = await rpc.getMultipleAccounts(found.map((f) => f.mint), { encoding: "base64", commitment: "confirmed" }).send();
  return found.map((f, i) => ({ ...f, decimals: mints.value[i] ? new Uint8Array(Buffer.from(mints.value[i]!.data[0], "base64"))[44] ?? 0 : 0 }));
}

/** The lent mint's reserve and collateral mint, from the reserves the program lends to, read on this cluster. */
async function lentReserve(rpc: Rpc<SolanaRpcApi>, lentMint: Address) {
  const found = (await lentMints(rpc)).find((m) => m.mint === lentMint);
  if (!found) throw refusal(`The lending AMM lends only the mints on its list, and ${lentMint} is not one of them on this cluster.`);
  return found;
}

/** The mint's token program and transfer hook program, read from its account. */
async function mintInfo(rpc: Rpc<SolanaRpcApi>, mint: Address) {
  const { value } = await rpc.getAccountInfo(mint, { encoding: "base64", commitment: "confirmed" }).send();
  if (!value || (value.owner !== TOKEN_PROGRAM_ADDRESS && value.owner !== TOKEN_2022_PROGRAM_ADDRESS)) throw refusal(`${mint} could not be read as a token mint.`);
  const data = new Uint8Array(Buffer.from(value.data[0], "base64"));
  return { tokenProgram: value.owner, transferHook: value.owner === TOKEN_2022_PROGRAM_ADDRESS ? transferHookProgram(data) : null };
}

export async function prepareLendingCreate(rpc: Rpc<SolanaRpcApi>, source: Source, request: PrepareLendingCreate): Promise<PreparedLendingCreate> {
  const trader = address(request.trader);
  const other = address(request.other_mint);
  const lent = address(request.lent_mint);
  if (other === lent) throw refusal("The two mints must differ.");
  const otherAmount = BigInt(request.other_amount);
  const lentAmount = BigInt(request.lent_amount);
  if (otherAmount <= 0n || lentAmount <= 0n) throw refusal("The first deposit sets the price, so it puts in some of both mints.");
  const shares = firstShares(otherAmount, lentAmount);
  if (shares === 0n) throw refusal(`The first deposit is too small: the program locks the first ${MINIMUM_LIQUIDITY} LP base units for good and mints the rest, so the square root of the two amounts multiplied must be above that.`);

  // The lent mint is checked first, so a mint the program does not lend is refused for that reason.
  const { reserve, collateralMint } = await lentReserve(rpc, lent);
  const [otherMint, lentMint] = await Promise.all([mintInfo(rpc, other), mintInfo(rpc, lent)]);
  const mints = [other, lent] as const;
  const tokenPrograms = { [other]: otherMint.tokenProgram, [lent]: lentMint.tokenProgram };
  const { instruction: create, resolved } = await buildCreateMarketFromMetadata({
    init: source.init,
    strategyProgram: LENDING_AMM_PROGRAM,
    creator: trader,
    args: { lent_index: LENDING_AMM.create.lentIndex, lp_fee_bps: request.lp_fee_bps },
    inputs: { other_mint: other, lent_mint: lent, collateral_mint: collateralMint },
    tokenPrograms,
    maxCreatorLamports: CREATE_MARKET_MAX_CREATOR_LAMPORTS,
    rpc,
  }).catch((e: unknown) => {
    if (e instanceof Error && e.name === "MetadataInstructionError") throw refusal(`The form could not be built: ${e.message}.`);
    throw e;
  });
  const fees = await Promise.all(mints.map((mint) => initFeeAccount({ payer: trader, market: resolved.market, mint, tokenProgram: tokenPrograms[mint]! })));
  const vaults = resolved.strategyAccounts.filter((_, i) => source.init.accounts?.[i]?.name === "vault_0" || source.init.accounts?.[i]?.name === "vault_1").map((a) => a.address);
  if (vaults.length !== 2) throw refusal("The strategy's create form does not name its two vaults, so the first deposit cannot be built from it.");
  const view: MarketView = { market: resolved.market, strategyProgram: LENDING_AMM_PROGRAM, marketState: resolved.marketState, mints: [...mints], vaults, tokenPrograms: [otherMint.tokenProgram, lentMint.tokenProgram], supportsExactOut: false };
  // The first deposit takes both amounts in full, so each maximum is its amount and the shares are exact.
  const deposit = await actionTransaction({
    action: source.addLiquidity,
    market: view,
    trader,
    args: { max_0: otherAmount, max_1: lentAmount, min_lp: shares },
    inputs: { reserve },
    tokenPrograms,
    rpc,
    walletWrappedSol: await walletWrappedSol(rpc, trader),
  });
  // A hooked token's transfer from the wallet into its vault, the first deposit's only one of it, carries the hook's accounts after the action's own.
  let action = deposit.action;
  if (otherMint.transferHook) {
    const [wallet] = await findAssociatedTokenPda({ owner: trader, mint: other, tokenProgram: otherMint.tokenProgram });
    const extra = await hookAccounts(rpc, { address: other, tokenProgram: otherMint.tokenProgram, decimals: 0, transferHook: otherMint.transferHook }, [{ source: wallet, destination: vaults[0]!, owner: trader, amount: otherAmount }]);
    action = { ...action, accounts: [...(action.accounts ?? []), ...extra] };
  }
  const instructions = [create, ...fees, ...deposit.instructions.map((i) => (i === deposit.action ? action : i))];
  const prepared = await prepareTransaction(rpc, { instructions, trader, strategy: LENDING_AMM_PROGRAM, market: null, what: "Creating this market", hooks: otherMint.transferHook ? [otherMint.transferHook] : [] });
  return {
    market: resolved.market,
    market_state: resolved.marketState,
    lp_fee_bps: request.lp_fee_bps,
    lent_index: LENDING_AMM.create.lentIndex,
    first_shares: shares.toString(),
    wrapped_sol: deposit.wrapped.toString(),
    accounts: (create.accounts ?? []).map((a) => ({ address: a.address, writable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER, signer: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER })),
    ...prepared,
  };
}
