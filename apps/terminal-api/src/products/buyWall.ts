// The buy wall AMM as Aviary reads it (docs/spec/pool4-for-solana.md, Aviary's panel and Custom
// actions and metadata; #57): every value from the market state, read at the offsets the spec's
// "Byte offsets" table fixes, through the program's generated client, whose layout is the IDL's and
// which the program's own tests check against that table. Pipeline's API reports raw vault balances,
// where retired tokens, the buy wall, idle SOL and unpaid fees all show as liquidity, so nothing
// here reads a vault or an event. The market page's panel and the explainer's facts both read a
// market through this module, so they say the same things.
import type { Address, ReadonlyUint8Array } from "@solana/kit";
import type { Fact } from "terminal-explainer";
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

/** A mint's supply and decimals, at the same offsets in SPL Token and Token-2022 mints. */
export function mintSupply(mint: Uint8Array): { supply: bigint; decimals: number } | null {
  if (mint.length < 82) return null;
  return { supply: new DataView(mint.buffer, mint.byteOffset).getBigUint64(36, true), decimals: mint[44]! };
}

const SIGNIFICANT = 6;
/** A non-negative fraction as a plain decimal with at most `significant` significant figures, no grouping, no trailing zeros. */
function decimal(numerator: bigint, denominator: bigint, significant = SIGNIFICANT): string {
  if (numerator === 0n) return "0";
  const whole = numerator / denominator;
  // Enough fractional digits to show `significant` figures of a value below 1.
  let digits = 0;
  if (whole === 0n) {
    while ((numerator * 10n ** BigInt(digits + 1)) / denominator === 0n) digits++;
    digits += significant;
  } else digits = Math.max(0, significant - whole.toString().length);
  const scaled = (numerator * 10n ** BigInt(digits) + denominator / 2n) / denominator;
  const text = scaled.toString().padStart(digits + 1, "0");
  const fraction = digits ? text.slice(-digits).replace(/0+$/, "") : "";
  return `${digits ? text.slice(0, -digits) : text}${fraction ? `.${fraction}` : ""}`;
}

/** A token or lamport amount in whole units, exactly. */
export function units(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${raw / scale}${fraction ? `.${fraction}` : ""}`;
}

/** A square-root price (Q64.64, lamports per token unit) as SOL per whole token, to six significant figures. */
export const priceInSol = (sqrt: bigint, decimals: number): string => decimal(sqrt * sqrt * 10n ** BigInt(decimals), (1n << 128n) * 1_000_000_000n);
/** A price as a number of SOL per whole token, for charts and the panel's formatter. */
export const priceNumber = (sqrt: bigint, decimals: number): number => Number(priceInSol(sqrt, decimals));
/** Basis points as a percentage: 2000 is "20%". */
export const percentOf = (bps: bigint | number): string => `${decimal(BigInt(bps), 100n, 4)}%`;

const SOL = 9;
const two = (n: number) => String(n).padStart(2, "0");
const utc = (seconds: bigint) => {
  const d = new Date(Number(seconds) * 1000);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
};

/**
 * The explainer's facts of a buy wall market (docs/spec/pool4-for-solana.md, Aviary's panel): what the
 * panel shows, from the market state and its token's mint read at `slot`, the cap decay allowance
 * brought up to `now` (Unix seconds).
 */
export function buyWallFacts({ state: stateData, mint, slot, now }: { state: Uint8Array; mint: Uint8Array; slot: number; now: bigint }): Fact[] {
  const source = `the sampled market's state, read at slot ${slot}`;
  const state = readBuyWallState(stateData);
  const token = mintSupply(mint);
  if (!state || !token) return [{ group: "Buy wall AMM", label: "Market state", value: "Aviary could not read the sampled market's state as a buy wall market.", source }];
  const { decimals } = token;
  const r = readBuyWall(state, { supply: token.supply, now });
  const tokens = (raw: bigint) => `${units(raw, decimals)} tokens`;
  const sol = (raw: bigint) => `${units(raw, SOL)} SOL`;
  const price = (sqrt: bigint) => `${priceInSol(sqrt, decimals)} SOL per token`;
  const fact = (label: string, value: string): Fact => ({ group: "Buy wall AMM", label, value, source });
  return [
    fact("Price", `${price(r.price)}.`),
    fact(
      "Buy wall",
      `${r.wall.placed ? `Placed, its top at ${price(r.wall.top)}. It holds ${sol(r.wall.sol)} and has bought ${tokens(r.wall.bought)}, spending ${sol(r.wall.spent)}, since it was placed.` : "Not placed."} Its floor is ${price(r.wall.floor)}. ${sol(r.wall.idle)} is idle, waiting to be placed as the wall.`,
    ),
    fact(
      "Inventory cap",
      `${tokens(r.cap.cap)}, against ${tokens(r.cap.held)} the curve holds. The cap floor is ${tokens(r.cap.floor)} (${percentOf(state.capFloorBps)} of the ${tokens(state.seededTokens)} seeded); the cap decay is ${tokens(r.cap.decayPerDay)} a day (${percentOf(state.capDecayBps)} of the tokens seeded); ${tokens(r.cap.allowance)} of cap decay allowance are built up.`,
    ),
    fact(
      "Retired, owed and burned tokens",
      `${tokens(r.tokens.retired)} retired, waiting to be burned or kept for rewards; ${tokens(r.tokens.rewardsOwed)} of rewards owed; ${tokens(r.tokens.burned)} burned so far, ${decimal(BigInt(r.tokens.burnedPpm), 10_000n, 4)}% of the supply before these burns.`,
    ),
    fact(
      "Fee and its split",
      `${percentOf(r.fee.bps)} of every swap, taken in SOL on top of Pipeline's fee: ${percentOf(r.fee.designerBps)} of it is the designer share for IMD and Adam, ${percentOf(r.fee.suiteBps)} the suite share, and the rest is the market's, ${percentOf(r.fee.wallSplitBps)} of it to the buy wall and ${percentOf(10_000n - r.fee.wallSplitBps)} to the fee recipient.`,
    ),
    fact(
      "Fee ledgers",
      `Fee recipient: ${sol(r.fee.ledgers.recipient)}. Designer share: ${sol(r.fee.ledgers.designer)}, ${r.fee.designerWallet ? `paid to ${r.fee.designerWallet}` : "waiting in the market, since its wallet is not set yet"}. Suite share: ${sol(r.fee.ledgers.suite)}, paid to ${r.fee.suiteWallet}.`,
    ),
    fact(
      "Parameters",
      `Fee ${state.feeBps} bps, buy wall split ${state.wallSplitBps} bps, reward share ${state.rewardShareBps} bps, cap floor ${state.capFloorBps} bps and cap decay ${state.capDecayBps} bps a day, none of which can change. ${tokens(state.seededTokens)} seeded by ${state.seeder}; created ${utc(state.creationTime)}, ${state.status === 2 ? `seeded ${utc(state.seedTime)}` : "not seeded yet"}.`,
    ),
    fact("Recipients", `Fee recipient: ${r.recipients.fee ?? "none"}. Rewards recipient: ${r.recipients.rewards ?? "none"}. Each may hand its own role to another wallet; nobody else can change either.`),
  ];
}

/** The risks of every buy wall market, as the spec states them (docs/spec/pool4-for-solana.md, Aviary's panel). */
export const BUY_WALL_RISKS: readonly Fact[] = [
  ["Risk: the curve thins as the cap falls", "The curve's liquidity thins as the inventory cap falls, so the same trade moves the price more over time."],
  ["Risk: the buy wall can sit well below the price", "After a fall in price the buy wall can sit well below the price, because its floor rises only about 4% a day."],
  ["Risk: the rewards recipient can trade the cap down", "The rewards recipient can trade the cap down itself and take the reward share of that fall at once, though never more than the budget the reward share and the cap floor set."],
].map(([label, value]) => ({ group: "Buy wall AMM", label: label!, value: value!, source: "the buy wall AMM's design (docs/spec/pool4-for-solana.md, Aviary's panel), the same for every market" }));
