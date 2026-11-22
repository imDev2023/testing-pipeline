// Today's spend, put to each market by the accounts of the transactions that spent it
// (docs/spec/keeper-runner.md, "Spending caps").

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { address, type Address } from '@solana/kit';

import { Spend } from '../src/spend.ts';

const KEEPER = address('8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2');
const MARKET = address('FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB');
const OTHER = address('53NMZDSkxjVeKBKPbGeDm9W9n1SaLHJbXSTF2uzvN1LC');

test('a market found after the spend was rebuilt still gets its share, so its cap is not reset', () => {
    const known = new Set<Address>();
    const spend = new Spend('2026-11-20', (account) => known.has(account));
    spend.add([KEEPER, MARKET], 2_044_280n);
    spend.add([KEEPER, OTHER], 5_000n);
    spend.add([KEEPER], 5_000n);
    assert.equal(spend.total, 2_054_280n);
    assert.equal(spend.of(MARKET), 0n);
    // Discovery succeeds in a later pass.
    known.add(MARKET);
    known.add(OTHER);
    assert.equal(spend.of(MARKET), 2_044_280n);
    assert.equal(spend.of(OTHER), 5_000n);
    assert.deepEqual(Object.fromEntries(spend.byMarket()), { [MARKET]: 2_044_280n, [OTHER]: 5_000n });
});
