// The lending AMM's panel, worked out (docs/spec/lending-pool.md, "Aviary's panel"; #88): every figure
// the panel and the explainer's fact table show, from the market state and Kamino's reserve, its
// lending market, the clock, the LP mint and the lock account, all read at one slot. Nothing here
// reads a vault's balance or an event: the market's own records (`R`, `B`, `c` and its running totals)
// and the reserve's fields at the spec's offsets are the inputs, and every rule is the program's own,
// through the keeper runner's copy of it (`packages/keeper-jobs/lending-amm.ts`), so the panel shows
// `rebalance` due exactly when the runner would send it.
//
// Pure: `./read` reads the accounts, `./routes` serves the result, `./facts` writes the explainer's
// items from the same view.
import type { Address } from "@solana/kit";
import { feeOf } from "../../trading/amounts";
import { canPayPlanned, decideRebalance, freelyAvailable, lendingAmm, lentValueOf, redeemsStopped, withdrawalCapRemaining, type LendingMarket } from "keeper-jobs/lending-amm.ts";
import {
  BUFFER_MAX_BPS,
  BUFFER_MIN_BPS,
  BUFFER_TARGET_BPS,
  getLendingAmmMarketDecoder,
  MINIMUM_LIQUIDITY,
  TRADE_MAX_RESERVE_AGE_SLOTS,
  WITHDRAW_MODE_EXIT_DELAY_SLOTS,
  type LendingAmmMarket,
} from "lending-amm-scripts/client/index.ts";
import { RESERVE_SIZE } from "lending-amm-scripts/kamino.ts";

const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
/** Every LP mint's decimals (the program's LP_DECIMALS). */
export const LP_DECIMALS = 9;
const ONE_SHARE = 10n ** BigInt(LP_DECIMALS);

/** Fields of klend's Reserve the keeper's decoder does not read, at the offsets of the Kamino facts, section 4 (klend 1.28.0). */
const RESERVE_EXTRA = { borrowedAmountSf: 232, protocolTakeRatePct: 4870, borrowRateCurve: 4920, curvePoints: 11 } as const;

/** The accounts the panel reads, at one slot. A missing account is null. */
export type LendingAccounts = {
  slot: bigint;
  marketState: Address;
  state: Uint8Array;
  reserve: Uint8Array | null;
  lendingMarket: Uint8Array | null;
  clock: Uint8Array | null;
  lpMint: Uint8Array | null;
  lockAccount: Uint8Array | null;
  /** The viewing wallet's shares account (`["lp_shares", market_state, wallet]`), when a wallet is named. */
  walletShares?: Uint8Array | null;
};

export type Band = "below" | "within" | "above";

/** What `rebalance` would do, as the panel shows it. */
export type RebalanceView = {
  /** Due exactly when the keeper runner would send it. */
  due: boolean;
  deposit: bigint | null;
  redeem: bigint | null;
  /** The mode the call leaves the market in. */
  withdrawModeAfter: boolean | null;
  /** The program's refusal by name when it would do nothing (WithinBand, BelowMinRebalance, KaminoStopped, KaminoDepositsBlocked). */
  refusal: string | null;
};

export type KaminoFigures = {
  /** Why the program would refuse to read the reserve or its lending market, or null when it reads them. */
  problem: string | null;
  utilisationBps: number | null;
  freeLiquidity: bigint | null;
  /** The supply rate, a year, at the stored state: utilisation x the curve's borrow rate x (1 - protocol take), as Kamino's SDK states it. */
  supplyRateBps: number | null;
  borrowRateBps: number | null;
  reserveEmergency: boolean | null;
  lendingMarketEmergency: boolean | null;
  blockCtokenUsage: boolean | null;
  deprecated: boolean | null;
  redeemsStopped: boolean | null;
  lastRefreshSlot: bigint | null;
  refreshAgeSlots: bigint | null;
  /** The withdrawal cap still free this interval, or null for no cap. */
  withdrawalCapRemaining: bigint | null;
  /** What a swap's redeem may take right now, the program's `can_pay_planned`. */
  canPay: bigint;
};

/** The largest sells, in base units of the other mint sold into the market (what the strategy is credited). */
export type SellEdges = {
  /** Why no sell trades at all now, or null. */
  refused: "market-closed" | "reserve-unreadable" | "reserve-stale" | null;
  /** The largest sell the buffer pays alone; null when even the smallest sell would redeem (an empty buffer) or none trades. */
  bufferAlone: bigint | null;
  /** True when the buffer pays every sell the market can take, so there is no edge. */
  bufferPaysAll: boolean;
  /** The largest sell the buffer and what Kamino can pay right now cover together; one unit more is refused. */
  withKamino: bigint | null;
  withKaminoPaysAll: boolean;
};

export type WalletShares = {
  shares: bigint;
  /** What removing all of them pays now: the other side, the buffer's part, the cTokens' part and their value at the stored rate. */
  other: bigint;
  bufferPart: bigint;
  ctokenPart: bigint;
  ctokenValue: bigint | null;
  /** Whether a cash removal of all of them would go through now, or why not. */
  cash: "yes" | "kamino-cannot-pay" | "kamino-stopped" | "reserve-unreadable" | "nothing";
  /** The most of them a cash removal could take now (in kind takes any number). */
  cashMaxShares: bigint;
};

export type LendingView = {
  slot: bigint;
  unixTime: bigint | null;
  marketState: Address;
  state: LendingAmmMarket;
  lentIndex: 0 | 1;
  otherIndex: 0 | 1;
  lentMint: Address;
  otherMint: Address;
  lendingMarket: Address | null;
  open: boolean;
  buffer: bigint;
  otherReserve: bigint;
  lentValue: bigint | null;
  lentTotal: bigint | null;
  /** `B / L` in basis points, rounded down to a hundredth; null while `L` is 0 or unknown. */
  bufferShareBps: number | null;
  band: Band | null;
  bandBps: { min: number; target: number; max: number };
  /** Since when a market in withdraw mode has seen Kamino's free liquidity above the exit threshold, and from which slot it may leave. */
  exitSeen: { slot: bigint; leaveFrom: bigint } | null;
  kamino: KaminoFigures;
  sells: SellEdges;
  lp: { supply: bigint | null; shareCount: bigint | null; locked: bigint; minimumLiquidity: bigint; valueOther: bigint | null; valueLent: bigint | null };
  /** `V + redeemed - deposited`, which can be negative after a loss Kamino wrote off. */
  yieldSoFar: bigint | null;
  rebalance: RebalanceView;
  wallet: WalletShares | null;
};

const u64At = (data: Uint8Array, offset: number) => new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
const u128At = (data: Uint8Array, offset: number) => u64At(data, offset) + (u64At(data, offset + 8) << 64n);

/** An SPL token account's amount, or 0 for a missing account. */
const tokenAmount = (data: Uint8Array | null | undefined) => (data && data.length >= 72 ? u64At(data, 64) : 0n);
/** An SPL mint's supply, or null when the account is not one. */
const mintSupply = (data: Uint8Array | null) => (data && data.length >= 82 ? u64At(data, 36) : null);

/**
 * What the trader types for a sale that puts `intoMarket` into the market: the largest typed amount
 * whose market amount is at most it, so the fees Pipeline and Aviary take on the input are counted;
 * on a sale into the market's fee mint Pipeline's fee comes out of the output and only Aviary's, if
 * any, is on the input (../../trading/amounts, `splitTyped`).
 */
export function typedFor(intoMarket: bigint, { onInputBps, integratorBps }: { onInputBps: number; integratorBps: number }): bigint {
  const spend = (net: bigint) => net + feeOf(net, onInputBps) + feeOf(net, integratorBps);
  return spend(intoMarket + 1n) - 1n;
}

// The program's pricing (src/pricing.rs, `exact_in`) --------------------------------------------

/** `exact_in`: what a credited input of `amount` pays out, or null where the program refuses (ZeroOutput, WouldEmptySide, Overflow). */
export function exactIn(reserveIn: bigint, reserveOut: bigint, amount: bigint, feeBps: number): bigint | null {
  const fee = (amount * BigInt(feeBps) + BPS - 1n) / BPS;
  const net = amount - fee;
  if (net < 0n) return null;
  const denominator = reserveIn + net;
  if (denominator === 0n) return null;
  const out = (reserveOut * net) / denominator;
  if (out === 0n || out >= reserveOut) return null;
  return out;
}

/**
 * The largest credited input in [1, u64::MAX] whose sale pays out at most `limit`, by binary search on
 * the program's pricing, which never falls as the input grows; null when even the smallest sale
 * that pays anything pays more, and `all` when every sale the market takes pays at most `limit`.
 */
export function largestSellWithin(reserveIn: bigint, reserveOut: bigint, feeBps: number, limit: bigint): { amount: bigint | null; all: boolean } {
  // `exact_in` pays 0 (refused) for the smallest inputs, so "pays at most limit" counts a refused zero as within it.
  const within = (a: bigint) => (exactIn(reserveIn, reserveOut, a, feeBps) ?? 0n) <= limit;
  if (within(U64_MAX)) return { amount: U64_MAX, all: true };
  let low = 0n;
  let high = U64_MAX;
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (within(mid)) low = mid;
    else high = mid;
  }
  // `low` pays at most `limit`, `low + 1` more; a `low` whose sale pays nothing is no sale.
  return { amount: exactIn(reserveIn, reserveOut, low, feeBps) === null ? null : low, all: false };
}

// Kamino's figures ------------------------------------------------------------------------------

/** The reserve's borrow curve as (utilisation bps, rate bps) points, cut after the point at 100%, as Kamino's SDK reads it. */
function borrowCurve(reserve: Uint8Array): [number, number][] {
  const points: [number, number][] = [];
  const view = new DataView(reserve.buffer, reserve.byteOffset, reserve.length);
  for (let i = 0; i < RESERVE_EXTRA.curvePoints; i++) {
    const at = RESERVE_EXTRA.borrowRateCurve + i * 8;
    const point: [number, number] = [view.getUint32(at, true), view.getUint32(at + 4, true)];
    points.push(point);
    if (point[0] === 10_000) break;
  }
  return points;
}

/** A fraction scale for the rates, so the bps they come out in keep many decimals before the final rounding. */
const SCALE = 10n ** 12n;

/**
 * Utilisation, the curve's borrow rate there and the supply rate, in bps: Kamino's SDK's
 * `calculateUtilizationRatio`, `getBorrowRate` (linear between the curve's points) and the borrow part
 * of `calculateSupplyAPR`, at the reserve's stored state; null where the SDK would refuse the curve.
 */
export function kaminoRates(reserve: Uint8Array, totalSupplySf: bigint): { utilisationBps: number; borrowRateBps: number | null; supplyRateBps: number | null } {
  const borrowedSf = u128At(reserve, RESERVE_EXTRA.borrowedAmountSf);
  // Utilisation in bps x SCALE, at most 100%.
  let u = totalSupplySf <= 0n ? 0n : (borrowedSf * BPS * SCALE) / totalSupplySf;
  if (u > BPS * SCALE) u = BPS * SCALE;
  const utilisationBps = Number(u / (SCALE / 100n)) / 100;
  const curve = borrowCurve(reserve);
  let segment: [[number, number], [number, number]] | null = null;
  let exact: number | null = null;
  for (let i = 1; i < curve.length; i++) {
    const point = curve[i]!;
    const at = BigInt(point[0]) * SCALE;
    if (at === u) {
      exact = point[1];
      break;
    }
    if (u <= at) {
      segment = [curve[i - 1]!, point];
      break;
    }
  }
  let rate: bigint | null = null;
  if (exact !== null) rate = BigInt(exact) * SCALE;
  else if (segment) {
    const [[x0, y0], [x1, y1]] = segment;
    if (x0 < x1 && y0 <= y1) rate = BigInt(y0) * SCALE + ((u - BigInt(x0) * SCALE) * BigInt(y1 - y0)) / BigInt(x1 - x0);
  }
  if (rate === null) return { utilisationBps, borrowRateBps: null, supplyRateBps: null };
  const take = BigInt(reserve[RESERVE_EXTRA.protocolTakeRatePct] ?? 0);
  // u (bps x SCALE) x rate (bps x SCALE) x (100 - take) / 100, in bps x SCALE.
  const supply = (u * rate * (100n - (take > 100n ? 100n : take))) / (BPS * SCALE * 100n);
  const bps = (scaled: bigint) => Number(scaled / (SCALE / 100n)) / 100;
  return { utilisationBps, borrowRateBps: bps(rate), supplyRateBps: bps(supply) };
}

// The view ----------------------------------------------------------------------------------------

/** The keeper's reading of the market with the accounts it watches, the reserve, its lending market and the clock. */
function keeperReading(accounts: LendingAccounts): LendingMarket {
  // The keeper watches the reserve, its lending market and the clock, or only the reserve and the clock for a reserve it does not list.
  const named = lendingAmm.watches!(accounts.state);
  const data = named.length === 3 ? [accounts.reserve, accounts.lendingMarket, accounts.clock] : [accounts.reserve, accounts.clock];
  return lendingAmm.decode(accounts.state, new Map(named.map((account, i) => [account, data[i] ?? null])));
}

/** Why the program would refuse to read Kamino's accounts, in the spec's words, or null. */
function kaminoProblem(accounts: LendingAccounts, reading: LendingMarket): string | null {
  if (reading.lendingMarket === null) return "The market's reserve is not one the program lends to.";
  if (!accounts.reserve) return "Kamino's reserve account is missing.";
  if (accounts.reserve.length !== RESERVE_SIZE) return "Kamino's reserve is not the size the program reads, so the program refuses to read it.";
  if (!accounts.lendingMarket) return "Kamino's lending market account is missing.";
  if (!reading.kamino) return "Kamino's reserve or lending market does not pass the program's check, so the program refuses to read them.";
  const version = reading.kamino.reserve.version;
  if (version !== 1n && version !== U64_MAX) return "Kamino's reserve is of a version the program was not written for, so the program refuses to read it.";
  return null;
}

/** Works the panel out from accounts read at one slot. */
export function lendingView(accounts: LendingAccounts): LendingView {
  const state = getLendingAmmMarketDecoder().decode(accounts.state);
  const lentIndex = state.lentIndex === 0 ? 0 : 1;
  const otherIndex = lentIndex === 0 ? 1 : 0;
  const reading = keeperReading(accounts);
  const problem = kaminoProblem(accounts, reading);
  const kamino = problem === null ? reading.kamino : null;
  const buffer = state.reserves[lentIndex]!;
  const otherReserve = state.reserves[otherIndex]!;

  const lentValue = kamino ? lentValueOf(kamino.reserve, state.ctokens) : state.ctokens === 0n ? 0n : null;
  const lentTotal = lentValue === null ? null : buffer + lentValue;
  const bufferShareBps = lentTotal ? Number((buffer * BPS * 100n) / lentTotal) / 100 : null;
  const band: Band | null = lentTotal === null ? null : buffer * BPS < lentTotal * BigInt(BUFFER_MIN_BPS) ? "below" : buffer * BPS > lentTotal * BigInt(BUFFER_MAX_BPS) ? "above" : "within";

  const stopped = kamino ? redeemsStopped(kamino) : null;
  const canPay = kamino ? canPayPlanned(kamino, state.ctokens) : 0n;
  const age = kamino ? (kamino.slot > kamino.reserve.lastUpdateSlot ? kamino.slot - kamino.reserve.lastUpdateSlot : 0n) : null;
  const deprecated = kamino ? kamino.reserve.version !== 1n : null;
  const rates = kamino && accounts.reserve ? kaminoRates(accounts.reserve, kamino.reserve.totalSupplySf) : null;
  const cap = kamino ? withdrawalCapRemaining(kamino.reserve.withdrawalCap, kamino.unixTime < 0n ? 0n : kamino.unixTime) : null;
  const kaminoFigures: KaminoFigures = {
    problem,
    utilisationBps: rates?.utilisationBps ?? null,
    freeLiquidity: kamino ? freelyAvailable(kamino.reserve) : null,
    supplyRateBps: rates?.supplyRateBps ?? null,
    borrowRateBps: rates?.borrowRateBps ?? null,
    reserveEmergency: kamino ? kamino.reserve.emergencyMode : null,
    lendingMarketEmergency: kamino ? kamino.lendingMarketEmergency : null,
    blockCtokenUsage: kamino ? kamino.reserve.blockCtokenUsage : null,
    deprecated,
    redeemsStopped: stopped,
    lastRefreshSlot: kamino ? kamino.reserve.lastUpdateSlot : null,
    refreshAgeSlots: age,
    withdrawalCapRemaining: cap === null || cap === U64_MAX ? null : cap,
    canPay,
  };

  // Quotes and swaps refuse a reserve that fails its check, and once the market holds cTokens one
  // refreshed longer ago than TRADE_MAX_RESERVE_AGE_SLOTS, unless a write-off deprecated it.
  const open = otherReserve > 0n;
  const stale = kamino !== null && state.ctokens > 0n && !deprecated && age !== null && age > TRADE_MAX_RESERVE_AGE_SLOTS;
  const refused: SellEdges["refused"] = !open ? "market-closed" : kamino === null || lentTotal === null ? "reserve-unreadable" : stale ? "reserve-stale" : null;
  let sells: SellEdges = { refused, bufferAlone: null, bufferPaysAll: false, withKamino: null, withKaminoPaysAll: false };
  if (refused === null && lentTotal !== null) {
    const alone = largestSellWithin(otherReserve, lentTotal, state.lpFeeBps, buffer);
    const together = largestSellWithin(otherReserve, lentTotal, state.lpFeeBps, buffer + canPay);
    sells = { refused, bufferAlone: alone.amount, bufferPaysAll: alone.all, withKamino: together.amount, withKaminoPaysAll: together.all };
  }

  const supply = mintSupply(accounts.lpMint);
  const shareCount = supply === null ? null : supply + MINIMUM_LIQUIDITY;
  const lp = {
    supply,
    shareCount,
    locked: tokenAmount(accounts.lockAccount),
    minimumLiquidity: MINIMUM_LIQUIDITY,
    valueOther: shareCount ? (otherReserve * ONE_SHARE) / shareCount : null,
    valueLent: shareCount && lentTotal !== null ? (lentTotal * ONE_SHARE) / shareCount : null,
  };

  const decision = decideRebalance(reading);
  const due = lendingAmm.jobs.find((job) => job.name === "rebalance")!.due(reading).length > 0;
  const rebalance: RebalanceView =
    decision === null
      ? { due: false, deposit: null, redeem: null, withdrawModeAfter: null, refusal: null }
      : typeof decision === "string"
        ? { due: false, deposit: null, redeem: null, withdrawModeAfter: null, refusal: decision }
        : {
            due,
            deposit: decision.planned && "deposit" in decision.planned ? decision.planned.deposit : null,
            redeem: decision.planned && "redeem" in decision.planned ? decision.planned.redeem : null,
            withdrawModeAfter: decision.withdrawMode,
            refusal: null,
          };

  return {
    slot: accounts.slot,
    unixTime: kamino ? kamino.unixTime : null,
    marketState: accounts.marketState,
    state,
    lentIndex,
    otherIndex,
    lentMint: state.mints[lentIndex]!,
    otherMint: state.mints[otherIndex]!,
    lendingMarket: reading.lendingMarket,
    open,
    buffer,
    otherReserve,
    lentValue,
    lentTotal,
    bufferShareBps,
    band,
    bandBps: { min: BUFFER_MIN_BPS, target: BUFFER_TARGET_BPS, max: BUFFER_MAX_BPS },
    exitSeen: state.withdrawMode && state.exitSeenSlot > 0n ? { slot: state.exitSeenSlot, leaveFrom: state.exitSeenSlot + WITHDRAW_MODE_EXIT_DELAY_SLOTS } : null,
    kamino: kaminoFigures,
    sells,
    lp,
    yieldSoFar: lentValue === null ? null : lentValue + state.redeemed - state.deposited,
    rebalance,
    wallet: accounts.walletShares === undefined ? null : walletShares(tokenAmount(accounts.walletShares), state, shareCount, kamino, lentIndex, otherIndex),
  };
}

/** A removal's parts for `lp` shares, each `X x lp / N` rounded down (the program's `shares::removal`). */
export function removalParts(lp: bigint, state: LendingAmmMarket, shareCount: bigint, lentIndex: number, otherIndex: number) {
  return {
    other: (state.reserves[otherIndex]! * lp) / shareCount,
    bufferPart: (state.reserves[lentIndex]! * lp) / shareCount,
    ctokenPart: (state.ctokens * lp) / shareCount,
  };
}

function walletShares(shares: bigint, state: LendingAmmMarket, shareCount: bigint | null, kamino: LendingMarket["kamino"], lentIndex: number, otherIndex: number): WalletShares {
  if (shareCount === null || shares === 0n) return { shares, other: 0n, bufferPart: 0n, ctokenPart: 0n, ctokenValue: shares === 0n ? 0n : null, cash: "nothing", cashMaxShares: 0n };
  const parts = removalParts(shares, state, shareCount, lentIndex, otherIndex);
  const value = kamino ? lentValueOf(kamino.reserve, parts.ctokenPart) : null;
  /** Whether a cash removal of `lp` shares passes the program's checks before it calls Kamino. */
  const cashOk = (lp: bigint): boolean => {
    const { ctokenPart } = removalParts(lp, state, shareCount, lentIndex, otherIndex);
    if (ctokenPart === 0n) return true;
    if (!kamino || redeemsStopped(kamino)) return false;
    const worth = lentValueOf(kamino.reserve, ctokenPart);
    if (worth === null) return false;
    return worth === 0n || worth <= canPayPlanned(kamino, ctokenPart);
  };
  const cash: WalletShares["cash"] = cashOk(shares) ? "yes" : !kamino ? "reserve-unreadable" : redeemsStopped(kamino) ? "kamino-stopped" : "kamino-cannot-pay";
  // The largest cash removal: a removal's cTokens' part, and with it what it asks of Kamino, never falls as the shares grow.
  let low = 0n;
  let high = shares + 1n;
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (cashOk(mid)) low = mid;
    else high = mid;
  }
  return { shares, ...parts, ctokenValue: value, cash, cashMaxShares: low };
}
