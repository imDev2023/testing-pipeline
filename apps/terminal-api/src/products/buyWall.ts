// The buy wall AMM as Aviary reads it (docs/spec/pool4-for-solana.md, Aviary's panel and Custom
// actions and metadata; #57): every value from the market state, read at the offsets the spec's
// "Byte offsets" table fixes, through the program's generated client, whose layout is the IDL's and
// which the program's own tests check against that table. Pipeline's API reports raw vault balances,
// where retired tokens, the buy wall, idle SOL and unpaid fees all show as liquidity, so nothing
// here reads a vault or an event. The market page's panel and the explainer's facts both read a
// market through this module, so they say the same things.
import type { Address, ReadonlyUint8Array } from "@solana/kit";
import { getMarketStateDecoder, getMarketStateSize, MARKET_STATE_DISCRIMINATOR } from "buy-wall-amm-scripts/client/accounts/marketState.ts";
import { DECAY_CREDIT_WINDOW, DESIGNER_RECIPIENT, DESIGNER_SHARE_BPS, SUITE_SHARE_BPS, SUITE_TREASURY } from "buy-wall-amm-scripts/client/constants/buyWallAmm.ts";

/** A buy wall market state, every field of the spec's table but the discriminator and the reserve. */
export type BuyWallState = {
  layoutVersion: number;
  /** 1 once created, 2 once seeded. */
  status: number;
  authorityBump: number;
  tokenVaultBump: number;
  solVaultBump: number;
  marketSigner: Address;
  tokenMint: Address;
  wsolMint: Address;
  tokenVault: Address;
  solVault: Address;
  seeder: Address;
  creationSlot: bigint;
  /** Unix seconds, as are every other time. */
  creationTime: bigint;
  seedTime: bigint;
  volume0: bigint;
  volume1: bigint;
  feesCollected: bigint;
  swapCount: bigint;
  feeBps: bigint;
  wallSplitBps: bigint;
  rewardShareBps: bigint;
  feeRecipient: Address;
  rewardsRecipient: Address;
  capFloorBps: bigint;
  capDecayBps: bigint;
  capFloor: bigint;
  capDecayPerDay: bigint;
  seededTokens: bigint;
  /** Q64.64, as are `wallTop`, `ref`, `floor`, `lastClose` and `lowSincePlacement`. */
  sqrtPrice: bigint;
  liquidity: bigint;
  wallLiquidity: bigint;
  wallTop: bigint;
  wallSolPlaced: bigint;
  poolTokens: bigint;
  poolSol: bigint;
  retiredTokens: bigint;
  rewardsOwed: bigint;
  idleSol: bigint;
  feesRecipient: bigint;
  feesDesigner: bigint;
  feesSuite: bigint;
  /** The inventory cap, in token units. */
  cap: bigint;
  /** Token-seconds. */
  decayCredit: bigint;
  decayTime: bigint;
  /** The wall's reference. */
  ref: bigint;
  refTime: bigint;
  floor: bigint;
  floorTime: bigint;
  lastSlot: bigint;
  lastClose: bigint;
  tokensTrimmed: bigint;
  solTrimmed: bigint;
  wallTokensBought: bigint;
  tokensBurned: bigint;
  rewardsPaid: bigint;
  tipsPaid: bigint;
  capFallUnmatched: bigint;
  retiredRewardable: bigint;
  lowSincePlacement: bigint;
};

/** A little-endian unsigned integer, as the zero-copy state stores each. */
const unsigned = (bytes: ReadonlyUint8Array): bigint => bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
/** A little-endian i64. */
const signed = (bytes: ReadonlyUint8Array): bigint => BigInt.asIntN(64, unsigned(bytes));

/** The market state in `data`, or null when it is not a buy wall market state (its size or discriminator differ). */
export function readBuyWallState(data: Uint8Array): BuyWallState | null {
  if (data.length !== getMarketStateSize() || !MARKET_STATE_DISCRIMINATOR.every((byte, i) => data[i] === byte)) return null;
  const s = getMarketStateDecoder().decode(data);
  return {
    layoutVersion: s.layoutVersion,
    status: s.status,
    authorityBump: s.authorityBump,
    tokenVaultBump: s.tokenVaultBump,
    solVaultBump: s.solVaultBump,
    marketSigner: s.marketSigner,
    tokenMint: s.tokenMint,
    wsolMint: s.wsolMint,
    tokenVault: s.tokenVault,
    solVault: s.solVault,
    seeder: s.seeder,
    creationSlot: unsigned(s.creationSlot),
    creationTime: signed(s.creationTime),
    seedTime: signed(s.seedTime),
    volume0: unsigned(s.volume[0]!),
    volume1: unsigned(s.volume[1]!),
    feesCollected: unsigned(s.feesCollected),
    swapCount: unsigned(s.swapCount),
    feeBps: unsigned(s.feeBps),
    wallSplitBps: unsigned(s.wallSplitBps),
    rewardShareBps: unsigned(s.rewardShareBps),
    feeRecipient: s.feeRecipient,
    rewardsRecipient: s.rewardsRecipient,
    capFloorBps: unsigned(s.capFloorBps),
    capDecayBps: unsigned(s.capDecayBps),
    capFloor: unsigned(s.capFloor),
    capDecayPerDay: unsigned(s.capDecayPerDay),
    seededTokens: unsigned(s.seededTokens),
    sqrtPrice: unsigned(s.sqrtPrice),
    liquidity: unsigned(s.liquidity),
    wallLiquidity: unsigned(s.wallLiquidity),
    wallTop: unsigned(s.wallTop),
    wallSolPlaced: unsigned(s.wallSolPlaced),
    poolTokens: unsigned(s.poolTokens),
    poolSol: unsigned(s.poolSol),
    retiredTokens: unsigned(s.retiredTokens),
    rewardsOwed: unsigned(s.rewardsOwed),
    idleSol: unsigned(s.idleSol),
    feesRecipient: unsigned(s.feesRecipient),
    feesDesigner: unsigned(s.feesDesigner),
    feesSuite: unsigned(s.feesSuite),
    cap: unsigned(s.cap),
    decayCredit: unsigned(s.decayCredit),
    decayTime: signed(s.decayTime),
    ref: unsigned(s.reference),
    refTime: signed(s.refTime),
    floor: unsigned(s.floor),
    floorTime: signed(s.floorTime),
    lastSlot: unsigned(s.lastSlot),
    lastClose: unsigned(s.lastClose),
    tokensTrimmed: unsigned(s.tokensTrimmed),
    solTrimmed: unsigned(s.solTrimmed),
    wallTokensBought: unsigned(s.wallTokensBought),
    tokensBurned: unsigned(s.tokensBurned),
    rewardsPaid: unsigned(s.rewardsPaid),
    tipsPaid: unsigned(s.tipsPaid),
    capFallUnmatched: unsigned(s.capFallUnmatched),
    retiredRewardable: unsigned(s.retiredRewardable),
    lowSincePlacement: unsigned(s.lowSincePlacement),
  };
}

const Q = 1n << 64n;
const DAY = 86_400n;
/** The all-zero key: a recipient left unset at creation, and DESIGNER_RECIPIENT while it is unset. */
export const UNSET = "11111111111111111111111111111111";
const walletOrNone = (key: Address): Address | null => (key === UNSET ? null : key);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** What a buy wall market holds and owes, as the panel and the explainer state it; every amount in token units or lamports, every price a Q64.64 square root. */
export type BuyWallReading = {
  /** The square root of the price, in lamports per token unit. */
  price: bigint;
  wall: {
    placed: boolean;
    /** Square roots of prices. */
    top: bigint;
    floor: bigint;
    /** The SOL the wall holds now. */
    sol: bigint;
    /** The SOL it has spent buying tokens since it was placed (the program's `converted`). */
    spent: bigint;
    /** The tokens it has bought since it was placed. */
    bought: bigint;
    /** SOL waiting to be placed as the wall. */
    idle: bigint;
  };
  cap: { cap: bigint; held: bigint; floor: bigint; decayPerDay: bigint; allowance: bigint };
  tokens: { retired: bigint; rewardsOwed: bigint; burned: bigint; burnedPpm: number };
  fee: {
    bps: bigint;
    designerBps: number;
    suiteBps: number;
    /** Of the market's part of the fee, the share that goes to the buy wall. */
    wallSplitBps: bigint;
    ledgers: { recipient: bigint; designer: bigint; suite: bigint };
    /** Null while DESIGNER_RECIPIENT is unset, the designer share waiting in the market. */
    designerWallet: Address | null;
    suiteWallet: Address;
  };
  recipients: { fee: Address | null; rewards: Address | null };
};

/**
 * A market's reading from its state, with its token's supply (from the mint, in the same read) and
 * the chain's time in Unix seconds, which the cap decay allowance is brought up to as the next swap
 * would bring it (docs/spec/pool4-for-solana.md, After pricing, step 5).
 */
export function readBuyWall(state: BuyWallState, { supply, now }: { supply: bigint; now: bigint }): BuyWallReading {
  const s = state.sqrtPrice;
  const placed = state.wallLiquidity > 0n;
  // The wall's SOL at the current price, `floor(W x min(s, top) / Q)`, and what it has spent (the program's `wall::converted`).
  const sol = placed ? (state.wallLiquidity * min(s, state.wallTop)) / Q : 0n;
  const spent = placed && state.wallSolPlaced > sol ? state.wallSolPlaced - sol : 0n;
  // The tokens it bought, `floor(W x Q x (top - s) / (top x s))` while the price is below its top (place_wall step 2).
  const bought = placed && s > 0n && s < state.wallTop ? (state.wallLiquidity * Q * (state.wallTop - s)) / (state.wallTop * s) : 0n;
  // What the curve holds, `floor(L x Q / s)` (After pricing, step 6).
  const held = s > 0n ? (state.liquidity * Q) / s : 0n;
  const elapsed = now > state.decayTime ? now - state.decayTime : 0n;
  const credit = min(state.decayCredit + state.capDecayPerDay * elapsed, state.capDecayPerDay * DECAY_CREDIT_WINDOW);
  const everMinted = supply + state.tokensBurned;
  return {
    price: s,
    wall: { placed, top: state.wallTop, floor: state.floor, sol, spent, bought, idle: state.idleSol },
    cap: { cap: state.cap, held, floor: state.capFloor, decayPerDay: state.capDecayPerDay, allowance: credit / DAY },
    tokens: { retired: state.retiredTokens, rewardsOwed: state.rewardsOwed, burned: state.tokensBurned, burnedPpm: everMinted > 0n ? Number((state.tokensBurned * 1_000_000n) / everMinted) : 0 },
    fee: {
      bps: state.feeBps,
      designerBps: DESIGNER_SHARE_BPS,
      suiteBps: SUITE_SHARE_BPS,
      wallSplitBps: state.wallSplitBps,
      ledgers: { recipient: state.feesRecipient, designer: state.feesDesigner, suite: state.feesSuite },
      designerWallet: walletOrNone(DESIGNER_RECIPIENT),
      suiteWallet: SUITE_TREASURY,
    },
    recipients: { fee: walletOrNone(state.feeRecipient), rewards: walletOrNone(state.rewardsRecipient) },
  };
}
