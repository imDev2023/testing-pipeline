// The demo's own reading of a Kamino Lend reserve, at the offsets docs/spec/lending-pool.md
// ("Valuing the lent side") takes from the Kamino facts, section 4, for klend 1.28.0. It is
// written apart from the program's Kamino module (src/kamino.rs) on purpose, so that the demo
// checks the program's valuation against an independent decoding. The keeper runner's jobs
// (packages/keeper-jobs/lending-amm.ts) read reserves and lending markets with it too.

import { getAddressDecoder, type Address } from '@solana/kit';

export const RESERVE_SIZE = 8624;
/** Anchor's discriminator of klend's Reserve, `sha256("account:Reserve")[..8]`. */
export const RESERVE_DISCRIMINATOR = [43, 242, 204, 202, 26, 247, 59, 127];

/** Anchor's discriminator of klend's LendingMarket, `sha256("account:LendingMarket")[..8]`. */
export const LENDING_MARKET_DISCRIMINATOR = [246, 114, 50, 98, 72, 157, 28, 120];
export const LENDING_MARKET_SIZE = 4664;
/** `emergency_mode` in klend's LendingMarket: while set, klend refuses `refresh_reserve` and every redeem. */
const LENDING_MARKET_EMERGENCY_MODE = 122;

/** The `version` of a reserve klend can use; any other (a write-off deprecates it) redeems nothing. */
export const RESERVE_VERSION = 1n;

const OFFSETS = {
    version: 8,
    lastUpdateSlot: 16,
    lendingMarket: 32,
    liquidityMint: 128,
    liquiditySupply: 160,
    totalAvailableAmount: 224,
    borrowedAmountSf: 232,
    accumulatedProtocolFeesSf: 344,
    accumulatedReferrerFeesSf: 360,
    pendingReferrerFeesSf: 376,
    collateralMint: 2560,
    mintTotalSupply: 2592,
    blockCtokenUsage: 4862,
    emergencyMode: 4864,
    // config.token_info: the oracles klend's refresh_reserve takes, Pubkey::default or
    // klend's NULL_PUBKEY where the reserve has none.
    scopePriceFeed: 5112,
    switchboardPriceAggregator: 5160,
    switchboardTwapAggregator: 5192,
    pythPrice: 5224,
    // config.deposit_withdrawal_cap: i64 capacity, i64 current total, u64 interval start
    // (Unix seconds), u64 interval length (seconds).
    withdrawalCap: 5416,
    queuedCollateralAmount: 6968,
} as const;

/** klend's NULL_PUBKEY, which a reserve's config holds for an oracle it does not use, as does the default key. */
const NULL_PUBKEY = 'nu11111111111111111111111111111111111111111';
const DEFAULT_PUBKEY = '11111111111111111111111111111111';

/** A reserve's deposit withdrawal cap: how much may leave it, net of deposits, per interval; an interval of 0 means none. */
export type WithdrawalCap = { capacity: bigint; currentTotal: bigint; intervalStart: bigint; intervalLength: bigint };

export type ReserveView = {
    version: bigint;
    lastUpdateSlot: bigint;
    /** `liquidity.total_available_amount`, the liquidity the reserve holds. */
    totalAvailableAmount: bigint;
    lendingMarket: Address;
    liquidityMint: Address;
    /** The token account holding the reserve's liquidity, which klend's deposit and redeem take. */
    liquiditySupply: Address;
    collateralMint: Address;
    /** `block_ctoken_usage`: klend takes no cToken deposits, though it still redeems. */
    blockCtokenUsage: boolean;
    emergencyMode: boolean;
    withdrawalCap: WithdrawalCap;
    /** The oracle accounts klend's `refresh_reserve` takes, null where the reserve has none. */
    oracles: { pythPrice: Address | null; switchboardPrice: Address | null; switchboardTwap: Address | null; scopePrices: Address | null };
    /** S_total, in 60-bit fixed point. */
    totalSupplySf: bigint;
    /** S_ctoken, the reserve's own `collateral.mint_total_supply`. */
    mintTotalSupply: bigint;
    /** cTokens held back by queued withdrawal tickets. */
    queuedCollateralAmount: bigint;
};

function u64(data: Uint8Array, offset: number): bigint {
    return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

function i64(data: Uint8Array, offset: number): bigint {
    return new DataView(data.buffer, data.byteOffset + offset, 8).getBigInt64(0, true);
}

function u128(data: Uint8Array, offset: number): bigint {
    return u64(data, offset) + (u64(data, offset + 8) << 64n);
}

function key(data: Uint8Array, offset: number): Address {
    return getAddressDecoder().decode(data.subarray(offset, offset + 32));
}

/** An oracle key of the reserve's config, or null where it has none. */
function oracle(data: Uint8Array, offset: number): Address | null {
    const found = key(data, offset);
    return found === NULL_PUBKEY || found === DEFAULT_PUBKEY ? null : found;
}

/**
 * Decodes a reserve account, or says why it is not one: the size and Anchor discriminator of
 * klend's Reserve. The caller compares the addresses it names.
 */
export function decodeReserve(data: Uint8Array): ReserveView | string {
    if (data.length !== RESERVE_SIZE) return `${data.length} bytes, not a reserve's ${RESERVE_SIZE}`;
    if (!RESERVE_DISCRIMINATOR.every((byte, i) => data[i] === byte)) return "not a reserve's discriminator";
    // klend's order: the sum first, which fails beyond 128 bits whatever the subtractions after it
    // would leave, then each subtraction; a failure is kept as 2^128, which nobody can value.
    const sum = (u64(data, OFFSETS.totalAvailableAmount) << 60n) + u128(data, OFFSETS.borrowedAmountSf);
    const supply =
        sum >= 1n << 128n
            ? 1n << 128n
            : sum - u128(data, OFFSETS.accumulatedProtocolFeesSf) - u128(data, OFFSETS.accumulatedReferrerFeesSf) - u128(data, OFFSETS.pendingReferrerFeesSf);
    const cap = OFFSETS.withdrawalCap;
    return {
        version: u64(data, OFFSETS.version),
        lastUpdateSlot: u64(data, OFFSETS.lastUpdateSlot),
        totalAvailableAmount: u64(data, OFFSETS.totalAvailableAmount),
        lendingMarket: key(data, OFFSETS.lendingMarket),
        liquidityMint: key(data, OFFSETS.liquidityMint),
        liquiditySupply: key(data, OFFSETS.liquiditySupply),
        collateralMint: key(data, OFFSETS.collateralMint),
        blockCtokenUsage: data[OFFSETS.blockCtokenUsage] !== 0,
        emergencyMode: data[OFFSETS.emergencyMode] !== 0,
        withdrawalCap: { capacity: i64(data, cap), currentTotal: i64(data, cap + 8), intervalStart: u64(data, cap + 16), intervalLength: u64(data, cap + 24) },
        oracles: {
            pythPrice: oracle(data, OFFSETS.pythPrice),
            switchboardPrice: oracle(data, OFFSETS.switchboardPriceAggregator),
            switchboardTwap: oracle(data, OFFSETS.switchboardTwapAggregator),
            scopePrices: oracle(data, OFFSETS.scopePriceFeed),
        },
        totalSupplySf: supply,
        mintTotalSupply: u64(data, OFFSETS.mintTotalSupply),
        queuedCollateralAmount: u64(data, OFFSETS.queuedCollateralAmount),
    };
}

/**
 * Whether a lending market's emergency mode is on, or why `data` is not a lending market: the
 * size and Anchor discriminator of klend's LendingMarket.
 */
export function decodeLendingMarket(data: Uint8Array): { emergencyMode: boolean } | string {
    if (data.length !== LENDING_MARKET_SIZE) return `${data.length} bytes, not a lending market's ${LENDING_MARKET_SIZE}`;
    if (!LENDING_MARKET_DISCRIMINATOR.every((byte, i) => data[i] === byte)) return "not a lending market's discriminator";
    return { emergencyMode: data[LENDING_MARKET_EMERGENCY_MODE] !== 0 };
}

/**
 * The reserve's freely available liquidity, which withdraw mode measures: what it holds less
 * the value of queued withdrawal tickets at the stored rate (docs/spec/lending-pool.md,
 * "Redeeming the shortfall").
 */
export function freeLiquidity(reserve: ReserveView): bigint {
    const queued = lentValue(reserve.queuedCollateralAmount, reserve);
    return reserve.totalAvailableAmount > queued ? reserve.totalAvailableAmount - queued : 0n;
}

/**
 * What `ctokens` cTokens are worth at the reserve's stored rate, `floor(c x S_total / S_ctoken)`,
 * as the program values them: nothing for no cTokens, or when either supply is 0; and a
 * refusal (here a thrown error) when the total supply is negative or beyond 128 bits, which
 * klend could not compute either.
 */
export function lentValue(ctokens: bigint, reserve: ReserveView): bigint {
    if (ctokens === 0n) return 0n;
    if (reserve.totalSupplySf < 0n || reserve.totalSupplySf >= 1n << 128n) {
        throw new Error(`the reserve's total supply ${reserve.totalSupplySf} cannot be computed; the program refuses it`);
    }
    if (reserve.totalSupplySf === 0n || reserve.mintTotalSupply === 0n) return 0n;
    return (ctokens * reserve.totalSupplySf) / (reserve.mintTotalSupply << 60n);
}

/** The stored rate as a decimal, for display. */
export function rate(reserve: ReserveView): string {
    if (reserve.mintTotalSupply === 0n) return '1';
    const scaled = (reserve.totalSupplySf * 10n ** 12n) / (reserve.mintTotalSupply << 60n);
    const text = scaled.toString().padStart(13, '0');
    return `${text.slice(0, -12)}.${text.slice(-12)}`;
}

/**
 * klend's `deposit_reserve_liquidity` for `liquidity` at a reserve whose total supply is
 * `totalSupplySf` and cToken supply `mintTotalSupply` once refreshed: it mints
 * `floor(liquidity x S_ctoken / S_total)` cTokens and takes back what they are worth, rounded up
 * (`compute_depositable_amount_and_minted_collateral` in klend 1.28.0), written here on its own.
 */
export function klendDeposit(liquidity: bigint, totalSupplySf: bigint, mintTotalSupply: bigint) {
    const ctokens = (liquidity * mintTotalSupply << 60n) / totalSupplySf;
    const scaled = mintTotalSupply << 60n;
    const taken = (ctokens * totalSupplySf + scaled - 1n) / scaled;
    return { ctokens, taken };
}

/**
 * klend's `redeem_reserve_collateral` of `ctokens` at a reserve whose total supply is
 * `totalSupplySf` and cToken supply `mintTotalSupply` once refreshed: it pays
 * `floor(ctokens x S_total / S_ctoken)` of the liquidity (`collateral_to_liquidity` in klend
 * 1.28.0), written here on its own.
 */
export function klendRedeem(ctokens: bigint, totalSupplySf: bigint, mintTotalSupply: bigint) {
    return (ctokens * totalSupplySf) / (mintTotalSupply << 60n);
}
