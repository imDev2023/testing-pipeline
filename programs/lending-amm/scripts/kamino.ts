// The demo's own reading of a Kamino Lend reserve, at the offsets docs/spec/lending-pool.md
// ("Valuing the lent side") takes from the Kamino facts, section 4, for klend 1.28.0. It is
// written apart from the program's Kamino module (src/kamino.rs) on purpose, so that the demo
// checks the program's valuation against an independent decoding.

import { getAddressDecoder, type Address } from '@solana/kit';

export const RESERVE_SIZE = 8624;
/** Anchor's discriminator of klend's Reserve, `sha256("account:Reserve")[..8]`. */
export const RESERVE_DISCRIMINATOR = [43, 242, 204, 202, 26, 247, 59, 127];

const OFFSETS = {
    lastUpdateSlot: 16,
    lendingMarket: 32,
    liquidityMint: 128,
    totalAvailableAmount: 224,
    borrowedAmountSf: 232,
    accumulatedProtocolFeesSf: 344,
    accumulatedReferrerFeesSf: 360,
    pendingReferrerFeesSf: 376,
    collateralMint: 2560,
    mintTotalSupply: 2592,
} as const;

export type ReserveView = {
    lastUpdateSlot: bigint;
    /** `liquidity.total_available_amount`, the liquidity the reserve holds. */
    totalAvailableAmount: bigint;
    lendingMarket: Address;
    liquidityMint: Address;
    collateralMint: Address;
    /** S_total, in 60-bit fixed point. */
    totalSupplySf: bigint;
    /** S_ctoken, the reserve's own `collateral.mint_total_supply`. */
    mintTotalSupply: bigint;
};

function u64(data: Uint8Array, offset: number): bigint {
    return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

function u128(data: Uint8Array, offset: number): bigint {
    return u64(data, offset) + (u64(data, offset + 8) << 64n);
}

function key(data: Uint8Array, offset: number): Address {
    return getAddressDecoder().decode(data.subarray(offset, offset + 32));
}

/**
 * Decodes a reserve account, or says why it is not one: the size and Anchor discriminator of
 * klend's Reserve. The caller compares the addresses it names.
 */
export function decodeReserve(data: Uint8Array): ReserveView | string {
    if (data.length !== RESERVE_SIZE) return `${data.length} bytes, not a reserve's ${RESERVE_SIZE}`;
    if (!RESERVE_DISCRIMINATOR.every((byte, i) => data[i] === byte)) return "not a reserve's discriminator";
    const supply =
        (u64(data, OFFSETS.totalAvailableAmount) << 60n) +
        u128(data, OFFSETS.borrowedAmountSf) -
        u128(data, OFFSETS.accumulatedProtocolFeesSf) -
        u128(data, OFFSETS.accumulatedReferrerFeesSf) -
        u128(data, OFFSETS.pendingReferrerFeesSf);
    return {
        lastUpdateSlot: u64(data, OFFSETS.lastUpdateSlot),
        totalAvailableAmount: u64(data, OFFSETS.totalAvailableAmount),
        lendingMarket: key(data, OFFSETS.lendingMarket),
        liquidityMint: key(data, OFFSETS.liquidityMint),
        collateralMint: key(data, OFFSETS.collateralMint),
        totalSupplySf: supply,
        mintTotalSupply: u64(data, OFFSETS.mintTotalSupply),
    };
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
