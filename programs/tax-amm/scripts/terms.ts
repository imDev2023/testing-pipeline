// The hash of a tax market's terms, which its `seed` action checks (docs/spec/tax-amm.md,
// "The seed"; hardening finding H019 of #67): the SHA-256 of the Borsh encoding of the two
// mints, the creation parameters as `init_data` holds them, and the pending buy and sell tax
// with the slot they apply from (all 0 when nothing is pending). A seeder computes it from
// the terms it created the market with, or from the market state it was shown, and the seed
// is refused if the market's terms hash otherwise.
//
// The metadata's `seed` action takes it as `expected_terms`, a `pubkey` argument: 32 bytes
// written in base58, since metadata arguments have no fixed-size byte type.
//
// The bytes hashed are ./terms-web.ts's, which also hashes them without Node for Aviary's page.

import { createHash } from 'node:crypto';
import type { Address } from '@solana/kit';

import type { InitParamsArgs, TaxMarket } from './client/index.ts';
import { NO_PENDING_CHANGE, pendingOf, termsPreimage, type PendingRates } from './terms-web.ts';

export { NO_PENDING_CHANGE, termsArg, termsPreimage, type PendingRates } from './terms-web.ts';

/** The hash of a market's terms, as the 32 bytes the program compares. */
export function termsHash(
    mints: readonly [Address, Address],
    params: InitParamsArgs,
    pending: PendingRates = NO_PENDING_CHANGE,
): Uint8Array {
    return new Uint8Array(createHash('sha256').update(termsPreimage(mints, params, pending)).digest());
}

/** The hash of the terms a market state holds, as a seeder shown that market computes it. */
export function termsOf(state: TaxMarket): Uint8Array {
    return termsHash([state.mints[0]!, state.mints[1]!], state, pendingOf(state));
}
