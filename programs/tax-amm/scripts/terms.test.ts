// The TypeScript hash of a market's terms against the one the program's tests compute
// (programs/tax-amm/tests/common/mod.rs, `terms_hash`), on fixed terms: the same 32 bytes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { address } from '@solana/kit';

import { NO_PENDING_CHANGE, termsArg, termsHash } from './terms.ts';

const DEFAULT = address('11111111111111111111111111111111');
const params = {
    taxSide: 1,
    buyTaxBps: 300,
    sellTaxBps: 500,
    buyTaxMinBps: 100,
    buyTaxMaxBps: 800,
    sellTaxMinBps: 0,
    sellTaxMaxBps: 1_000,
    taxAuthority: address('9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt'),
    seeder: address('ACrn3UD4DLgyCKbNMiqx6Vcs2d49RSbHdbLJ82uw61s8'),
    recipients: [address('8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2'), DEFAULT, DEFAULT, DEFAULT],
    shares: [9_000, 0, 0, 0],
    burnShareBps: 1_000,
    virtualSide: 0,
    virtualReserve: 50_000_000_000n,
};
const mints = [
    address('So11111111111111111111111111111111111111112'),
    address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
] as const;

test('the terms hash is the one the program checks', () => {
    // From `cargo test -p tax-amm --test seed the_terms_hash_of_fixed_terms -- --nocapture`.
    assert.equal(termsArg(termsHash(mints, params)), EXPECTED_NONE);
    assert.equal(termsArg(termsHash(mints, params, { buyTaxBps: 800, sellTaxBps: 900, fromSlot: 12_345n })), EXPECTED_PENDING);
    assert.notEqual(termsArg(termsHash(mints, params, NO_PENDING_CHANGE)), EXPECTED_PENDING);
});

const EXPECTED_NONE = 'FBQRE7k7qyqiavt2rD3WFVRj2wrjESjBLU36g3TZSKbs';
const EXPECTED_PENDING = 'FXQuHEirGu2qVb8yD38kFxBLyoEenoVvSjctJWwD1DG2';
