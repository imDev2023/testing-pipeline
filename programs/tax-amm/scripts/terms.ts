// The hash of a tax market's terms, which its `seed` action checks (docs/spec/tax-amm.md,
// "The seed"; hardening finding H019 of #67): the SHA-256 of the Borsh encoding of the two
// mints, the creation parameters as `init_data` holds them, and the pending buy and sell tax
// with the slot they apply from (all 0 when nothing is pending). A seeder computes it from
// the terms it created the market with, or from the market state it was shown, and the seed
// is refused if the market's terms hash otherwise.
//
// The metadata's `seed` action takes it as `expected_terms`, a `pubkey` argument: 32 bytes
// written in base58, since metadata arguments have no fixed-size byte type.

import { createHash } from 'node:crypto';
import { getAddressDecoder, getAddressEncoder, type Address } from '@solana/kit';

import { getInitParamsEncoder, type InitParamsArgs, type TaxMarket } from './client/index.ts';

/** A rate change waiting for its slot, as the market state holds it; all 0 for none. */
export type PendingRates = { buyTaxBps: number; sellTaxBps: number; fromSlot: bigint };

/** No pending rate change: a market as it is created. */
export const NO_PENDING_CHANGE: PendingRates = { buyTaxBps: 0, sellTaxBps: 0, fromSlot: 0n };

/** The hash of a market's terms, as the 32 bytes the program compares. */
export function termsHash(
    mints: readonly [Address, Address],
    params: InitParamsArgs,
    pending: PendingRates = NO_PENDING_CHANGE,
): Uint8Array {
    const hasher = createHash('sha256');
    const addresses = getAddressEncoder();
    for (const mint of mints) hasher.update(new Uint8Array(addresses.encode(mint)));
    hasher.update(new Uint8Array(getInitParamsEncoder().encode(params)));
    const tail = new DataView(new ArrayBuffer(12));
    tail.setUint16(0, pending.buyTaxBps, true);
    tail.setUint16(2, pending.sellTaxBps, true);
    tail.setBigUint64(4, pending.fromSlot, true);
    hasher.update(new Uint8Array(tail.buffer));
    return new Uint8Array(hasher.digest());
}

/** The hash of the terms a market state holds, as a seeder shown that market computes it. */
export function termsOf(state: TaxMarket): Uint8Array {
    return termsHash([state.mints[0]!, state.mints[1]!], state, {
        buyTaxBps: state.pendingBuyTaxBps,
        sellTaxBps: state.pendingSellTaxBps,
        fromSlot: state.pendingFromSlot,
    });
}

/** The hash as the `seed` action's `expected_terms` argument takes it: base58, as a key. */
export function termsArg(hash: Uint8Array): Address {
    return getAddressDecoder().decode(hash);
}
