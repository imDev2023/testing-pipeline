// The three parties the script plays besides the market owner: the second depositor (the devnet wallet), the plain
// cToken holder and the test borrower.
import type { Context } from "./context.ts";
import { deposit, partyAccounts, readReserve, redeem, type DepositResult, type RedeemResult } from "./ctokens.ts";
import { redeemValue, totalSupplySf } from "./layout.ts";
import { RESERVES, SECOND_DEPOSITOR, type ReserveKey } from "./policy.ts";

/** A few base units above the target, so the cTokens bought, valued back at the stored rate, still reach it. */
const ROUNDING_MARGIN = 10n;

/** What the devnet wallet's cTokens in the reserve are worth at the stored rate. */
export async function secondDepositorPosition(ctx: Context, key: ReserveKey): Promise<bigint> {
  const accounts = await partyAccounts(ctx, ctx.keys.wallet, key);
  return redeemValue(await readReserve(ctx, key), await ctx.chain.tokenBalance(accounts.ctokens));
}

/**
 * The second depositor tops its position in the reserve up to `SECOND_DEPOSITOR`, which keeps the reserve's free
 * liquidity above 10 times a demo market's target lent value; returns null when the position already reaches it.
 */
export async function supplySecondDepositor(ctx: Context, key: ReserveKey): Promise<DepositResult | null> {
  const shortfall = SECOND_DEPOSITOR[key] - (await secondDepositorPosition(ctx, key));
  if (shortfall <= 0n) return null;
  return deposit(
    ctx,
    ctx.keys.wallet,
    key,
    shortfall + ROUNDING_MARGIN,
    `second depositor supplies the ${RESERVES[key].label} reserve`,
  );
}

/** The second depositor takes back about `amount` of liquidity (never more), or everything it supplied. */
export async function takeBack(ctx: Context, key: ReserveKey, amount: bigint | "all"): Promise<RedeemResult> {
  let ctokens: bigint | "all" = "all";
  if (amount !== "all") {
    const reserve = await readReserve(ctx, key);
    ctokens =
      reserve.collateralMintTotalSupply === 0n
        ? amount
        : (amount * reserve.collateralMintTotalSupply * (1n << 60n)) / totalSupplySf(reserve);
  }
  return redeem(ctx, ctx.keys.wallet, key, ctokens, `second depositor takes back from the ${RESERVES[key].label} reserve`);
}
