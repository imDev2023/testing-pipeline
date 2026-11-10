// Every policy value of our devnet Kamino lending market, in one place so each is cheap to change.
// They are defaults MetalLegBob may change (docs/decisions.md once it lands; until then the ticket's resolution
// comment lists them under "Decisions open to MetalLegBob"). A value changed here reaches devnet on the next
// `setup`, which moves each configured field of each reserve to the value below.
import { address } from "@solana/kit";

export const DEVNET = "https://api.devnet.solana.com";

/** Kamino Lend, the same id on devnet and mainnet (`KLEND_PROGRAM` in docs/spec/lending-pool.md). */
export const KLEND_PROGRAM = address("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
/** Kamino's global config PDA (seed `global_config`), which `update_reserve_config` reads. */
export const KLEND_GLOBAL_CONFIG = address("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");

export const WSOL_MINT = address("So11111111111111111111111111111111111111112");

/** The live devnet Pyth feeds (Pyth receiver `PriceUpdateV2` accounts) the reserves name, as the spec's Devnet asks. */
export const PYTH_FEEDS = {
  wsol: address("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  testUsdc: address("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
} as const;

/**
 * Seeds for `createAccountWithSeed`, so every account the script creates has an address derived from a key in
 * `~/.config/testing-pipeline/devnet/`: a re-run finds the same addresses with no account keypairs kept.
 */
export const ACCOUNT_SEEDS = {
  lendingMarket: "kamino-lending-market",
  reserves: { wsol: "kamino-reserve-wsol", testUsdc: "kamino-reserve-test-usdc" },
  testUsdcMint: "test-usdc-mint",
} as const;

/** Key files, all in the devnet key folder, never in the repo; the setup creates the ones that do not exist yet. */
export const KEY_FILES = {
  /** This project's devnet wallet: it pays, funds the other keys and is the second depositor. */
  wallet: "wallet.json",
  marketOwner: "kamino-market-owner.json",
  testUsdcMintAuthority: "test-usdc-mint-authority.json",
  ctokenHolder: "kamino-ctoken-holder.json",
  borrower: "kamino-borrower.json",
} as const;

export const TEST_USDC_DECIMALS = 6;
/** The lending market's quote currency, as Kamino's markets name it. */
export const QUOTE_CURRENCY = "USD";

/** One borrow rate curve point: utilisation and the yearly borrow rate it gives, both in basis points. */
export interface CurvePointPolicy {
  utilizationRateBps: number;
  borrowRateBps: number;
}

export interface ReservePolicy {
  /** What the script calls the reserve's token in its output. */
  label: string;
  /** Kamino's token info name (at most 32 bytes). */
  name: string;
  decimals: number;
  /** The deposit limit, in base units; raising it from 0 is what opens the reserve. */
  depositLimit: bigint;
  borrowLimit: bigint;
  loanToValuePct: number;
  liquidationThresholdPct: number;
  /** Kamino refuses a price older than this. Devnet's Pyth feeds were seen updating about every 5 minutes. */
  maxPriceAgeSeconds: bigint;
  /** Net outflow (redeems minus deposits) allowed per interval. */
  depositWithdrawalCap: { capacity: bigint; intervalSeconds: bigint };
  /** 11 points from 0% to 100% utilisation; the last points repeat 100% (klend's rule). */
  borrowRateCurve: CurvePointPolicy[];
}

const SOL = 1_000_000_000n;
const USDC = 1_000_000n;

/**
 * Steep, so that a few SOL borrowed show interest in base units within seconds and the devnet demo can watch a
 * market's lending yield grow: about 400% a year at the test borrower's 70% utilisation, about 440 lamports a second.
 */
const STEEP_CURVE: CurvePointPolicy[] = [
  { utilizationRateBps: 0, borrowRateBps: 0 },
  { utilizationRateBps: 5_000, borrowRateBps: 20_000 },
  { utilizationRateBps: 8_000, borrowRateBps: 50_000 },
  ...Array.from({ length: 8 }, () => ({ utilizationRateBps: 10_000, borrowRateBps: 100_000 })),
];

export const RESERVES = {
  wsol: {
    label: "WSOL",
    name: "SOL",
    decimals: 9,
    depositLimit: 10_000n * SOL,
    borrowLimit: 10_000n * SOL,
    loanToValuePct: 75,
    liquidationThresholdPct: 85,
    maxPriceAgeSeconds: 600n,
    depositWithdrawalCap: { capacity: 10_000n * SOL, intervalSeconds: 86_400n },
    borrowRateCurve: STEEP_CURVE,
  },
  testUsdc: {
    label: "test USDC",
    name: "USDC",
    decimals: TEST_USDC_DECIMALS,
    depositLimit: 100_000_000n * USDC,
    borrowLimit: 100_000_000n * USDC,
    loanToValuePct: 75,
    liquidationThresholdPct: 85,
    maxPriceAgeSeconds: 600n,
    depositWithdrawalCap: { capacity: 100_000_000n * USDC, intervalSeconds: 86_400n },
    borrowRateCurve: STEEP_CURVE,
  },
} as const satisfies Record<string, ReservePolicy>;

export type ReserveKey = keyof typeof RESERVES;
export const RESERVE_KEYS = Object.keys(RESERVES) as ReserveKey[];

/** Kamino's seed deposit on a new reserve (a new market's `min_initial_deposit_amount`). */
export const RESERVE_SEED = 100_000n;

/** SOL the wallet keeps in the market owner's key for rent and fees; topped up to this when lower. */
export const MARKET_OWNER_FUNDING = SOL / 10n;

/**
 * The second depositor (the devnet wallet) keeps each reserve's free liquidity above 10 times the target lent value
 * of a demo market (0.4 SOL for a lent side of 0.5 SOL), as the spec's Devnet asks.
 */
export const SECOND_DEPOSITOR = { wsol: 5n * SOL, testUsdc: 100_000n * USDC } as const;
export const DEMO_TARGET_LENT_VALUE = { wsol: (4n * SOL) / 10n } as const;
export const WITHDRAW_MODE_EXIT = 10n;

/** The plain cToken holder: how much it deposits and redeems in each run, and the SOL it is kept funded with. */
export const CTOKEN_HOLDER = { wsol: SOL / 10n, testUsdc: 100n * USDC, funding: SOL / 4n } as const;

/** The test borrower: its test USDC collateral, the WSOL it borrows, and SOL for rent, fees and the interest. */
export const TEST_BORROWER = { collateral: 1_000n * USDC, borrow: (35n * SOL) / 10n, funding: SOL / 10n } as const;

/** How long the proof keeps the loan open before refreshing the reserve and checking the stored rate rose. */
export const RATE_WATCH_SECONDS = 20;
