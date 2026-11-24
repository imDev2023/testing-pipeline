// The hash of a tax market's terms without Node's crypto, for Aviary's launch form, which hashes
// in the page (docs/spec/tax-amm.md, "The seed"; TAX-59): the same bytes as ./terms.ts hashes,
// the Borsh encoding of the two mints, the creation parameters as `init_data` holds them, and the
// pending buy and sell tax with the slot they apply from, hashed with WebCrypto's SHA-256. Its
// test pins the same hashes as the program's tests.

import { getAddressDecoder, getAddressEncoder, type Address } from '@solana/kit';

import { getInitParamsEncoder, type InitParamsArgs, type TaxMarket } from './client/index.ts';

/** A rate change waiting for its slot, as the market state holds it; all 0 for none. */
export type PendingRates = { buyTaxBps: number; sellTaxBps: number; fromSlot: bigint };

/** No pending rate change: a market as it is created. */
export const NO_PENDING_CHANGE: PendingRates = { buyTaxBps: 0, sellTaxBps: 0, fromSlot: 0n };

/** The bytes a market's terms hash covers, in the order the program hashes them. */
export function termsPreimage(
    mints: readonly [Address, Address],
    params: InitParamsArgs,
    pending: PendingRates = NO_PENDING_CHANGE,
): Uint8Array {
    const addresses = getAddressEncoder();
    const encodedParams = getInitParamsEncoder().encode(params);
    const tail = new DataView(new ArrayBuffer(12));
    tail.setUint16(0, pending.buyTaxBps, true);
    tail.setUint16(2, pending.sellTaxBps, true);
    tail.setBigUint64(4, pending.fromSlot, true);
    const parts = [addresses.encode(mints[0]), addresses.encode(mints[1]), encodedParams, new Uint8Array(tail.buffer)];
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
    }
    return bytes;
}

/** The pending rate change a market state holds, as its terms hash takes it. */
export function pendingOf(state: TaxMarket): PendingRates {
    return { buyTaxBps: state.pendingBuyTaxBps, sellTaxBps: state.pendingSellTaxBps, fromSlot: state.pendingFromSlot };
}

/** The hash of a market's terms with WebCrypto, as the 32 bytes the program compares. */
export async function webTermsHash(
    mints: readonly [Address, Address],
    params: InitParamsArgs,
    pending: PendingRates = NO_PENDING_CHANGE,
): Promise<Uint8Array> {
    const preimage = termsPreimage(mints, params, pending);
    return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', preimage.buffer as ArrayBuffer));
}

/** The hash as the `seed` action's `expected_terms` argument takes it: base58, as a key. */
export function termsArg(hash: Uint8Array): Address {
    return getAddressDecoder().decode(hash);
}
