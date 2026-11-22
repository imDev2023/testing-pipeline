// What a pass records (docs/spec/keeper-runner.md, "What it records"): a row per job it sent, held
// or parked, so a pass that did none of these records nothing and the database can sleep. A job
// held by the same cap pass after pass is one hold, recorded once a UTC day.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/clock.ts';
import { MemoryLogger } from '../src/log.ts';
import { logRecorder, PassRecords, publicText, type JobRow } from '../src/record.ts';

const MARKET = 'FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB';
const START = Date.parse('2026-11-22T12:00:00Z');

const row = (outcome: string, fields: Partial<JobRow> = {}): JobRow => ({
    key: 'distribute:2',
    market: MARKET,
    product: 'tax-amm',
    job: 'distribute',
    slot: 2,
    outcome,
    ...fields,
});

function records() {
    const clock = new FakeClock(START);
    return { clock, records: new PassRecords(clock) };
}

test('a pass whose jobs were all skipped records nothing', () => {
    const { records: r } = records();
    r.job(row('nothing-to-do', { reason: 'refused in simulation' }));
    r.job(row('not-yet', { key: 'settle', job: 'settle', slot: null }));
    r.job(row('later-slot', { error: 'SwapThisSlot' }));
    r.job(row('chain-error', { error: 'timed out' }));
    r.job(row('failed', { attempt: 1, error: 'custom program error: 0x1771' }));
    assert.deepEqual(r.take(), []);
});

test('a job whose transaction landed is recorded with its signature and cost, whatever it did', () => {
    const { records: r } = records();
    r.job(row('sent', { signature: 'sig1', cost: 5_000n, estimate: 5_000n }));
    r.job(row('failed', { key: 'distribute:3', slot: 3, signature: 'sig2', cost: 5_000n, attempt: 1, error: 'custom program error: 0x1771' }));
    r.job(row('nothing-to-do', { key: 'distribute:4', slot: 4, signature: 'sig3', cost: 5_000n, reason: 'landed without effect' }));
    const taken = r.take();
    assert.deepEqual(
        taken.map((job) => [job.outcome, job.slot, job.signature, job.cost, job.error, job.attempt]),
        [
            ['sent', 2, 'sig1', 5_000n, null, null],
            ['failed', 3, 'sig2', 5_000n, 'custom program error: 0x1771', 1],
            ['nothing-to-do', 4, 'sig3', 5_000n, null, null],
        ],
    );
    assert.deepEqual(taken[0], {
        at: new Date(START),
        market: MARKET,
        product: 'tax-amm',
        job: 'distribute',
        slot: 2,
        outcome: 'sent',
        signature: 'sig1',
        cost: 5_000n,
        estimate: 5_000n,
        cap: null,
        error: null,
        attempt: null,
    });
    assert.deepEqual(r.take(), [], 'taking empties the pass');
});

test('parks and unparks are recorded', () => {
    const { records: r } = records();
    r.job(row('parked', { attempt: 4, error: 'custom program error: 0x1771' }));
    r.job(row('unparked', { key: 'settle', job: 'settle', slot: null, reason: "the market's state changed" }));
    assert.deepEqual(
        r.take().map((job) => [job.outcome, job.job, job.error]),
        [
            ['parked', 'distribute', 'custom program error: 0x1771'],
            ['unparked', 'settle', null],
        ],
    );
});

test('a job held by one cap is recorded once a day, again for another cap, after it went, or on the next day', () => {
    const { clock, records: r } = records();
    const held = (cap: string) => row('held', { cap, estimate: 2_044_280n });

    r.job(held('MARKET_DAILY_CAP'));
    assert.deepEqual(r.take().map((job) => [job.outcome, job.cap, job.estimate]), [['held', 'MARKET_DAILY_CAP', 2_044_280n]]);

    clock.advance(10 * 60_000);
    r.job(held('MARKET_DAILY_CAP'));
    assert.deepEqual(r.take(), [], 'the same hold in the next pass is not recorded again');

    r.job(held('DAILY_CAP'));
    assert.deepEqual(r.take().map((job) => job.cap), ['DAILY_CAP'], 'a hold by another cap is');

    r.job(row('nothing-to-do', { reason: 'no longer due' }));
    r.job(held('DAILY_CAP'));
    assert.deepEqual(
        r.take().map((job) => [job.outcome, job.cap]),
        [
            ['nothing-to-do', null],
            ['held', 'DAILY_CAP'],
        ],
        'so are the end of the hold and a hold after it',
    );

    clock.advance(12 * 3_600_000);
    r.job(held('DAILY_CAP'));
    assert.deepEqual(r.take().map((job) => job.cap), ['DAILY_CAP'], 'and the first hold of a new UTC day');
});

test('holds of different jobs are told apart by their market and unit', () => {
    const { records: r } = records();
    r.job(row('held', { cap: 'DAILY_CAP' }));
    r.job(row('held', { cap: 'DAILY_CAP', key: 'distribute:3', slot: 3 }));
    r.job(row('held', { cap: 'DAILY_CAP', market: '7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK' }));
    assert.equal(r.take().length, 3);
});

test('the keeper wallet unwrapping its tips is recorded as its own job, with no market', () => {
    const { records: r } = records();
    r.job({ key: 'unwrap', market: null, product: null, job: 'unwrap', slot: null, outcome: 'sent', signature: 'sigU', cost: 5_000n });
    assert.deepEqual(r.take().map((job) => [job.market, job.job, job.signature]), [[null, 'unwrap', 'sigU']]);
});

test('without a database a pass is logged as one record row, as the database would hold it', async () => {
    const log = new MemoryLogger();
    const record = {
        wallet: '8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2',
        pass: 'daily',
        at: new Date(START),
        balance: 1_999_000_000n,
        day: '2026-11-22',
        spentTotal: 5_000n,
        spentByMarket: { [MARKET]: 5_000n },
        caps: { maxTxCost: 3_000_000n, marketDailyCap: 10_000_000n, dailyCap: 100_000_000n, minBalance: 100_000_000n, lowBalance: 500_000_000n },
        settings: { SWEEP_INTERVAL: '10m' },
        warnings: [],
        counts: { markets: 1, sent: 1, held: 0, parked: 0, skipped: 0, failed: 0 },
        jobs: new PassRecords(new FakeClock(START)).take(),
    };
    await logRecorder(log).record(record);
    assert.deepEqual(log.of('record'), [{ row: 'record', ...record }]);
});

test('a held or parked job that is next skipped, refused or fails is recorded, so the page stops showing it waiting', () => {
    const { records: r } = records();
    r.job(row('held', { cap: 'DAILY_CAP' }));
    r.job(row('parked', { key: 'distribute:3', slot: 3, attempt: 4, error: 'custom program error: 0x1771' }));
    r.take();
    r.job(row('nothing-to-do', { reason: 'no longer due' }));
    r.job(row('chain-error', { key: 'distribute:3', slot: 3, error: 'timed out' }));
    assert.deepEqual(r.take().map((job) => [job.slot, job.outcome]), [
        [2, 'nothing-to-do'],
        [3, 'chain-error'],
    ]);
    r.job(row('nothing-to-do', { reason: 'no longer due' }));
    assert.deepEqual(r.take(), [], 'once the wait has ended, a skip is not recorded again');
});

test('a held or parked job that is no longer due at all, as when another keeper sent it, is recorded as no longer due', () => {
    const { records: r } = records();
    r.job(row('held', { cap: 'DAILY_CAP' }));
    r.job(row('held', { cap: 'DAILY_CAP', key: 'distribute:3', slot: 3 }));
    r.job(row('parked', { key: 'place_wall', job: 'place_wall', product: 'buy-wall-amm', market: 'WALL', slot: null }));
    r.take();
    // The market's distribute is due only on slot 3 now; another market's jobs are not looked at.
    r.stillDue(MARKET, 'distribute', ['distribute:3']);
    assert.deepEqual(r.take().map((job) => [job.market, job.job, job.slot, job.outcome]), [[MARKET, 'distribute', 2, 'no-longer-due']]);
    r.stillDue(MARKET, 'distribute', ['distribute:3']);
    assert.deepEqual(r.take(), [], 'recorded once');
});

test('errors in records never carry a URL\'s path or query, which can hold an API key', () => {
    const { records: r } = records();
    r.job(row('failed', { signature: 's', error: 'fetch https://solana-devnet.g.alchemy.com/v2/secret-key failed; wss://x.example/?api-key=abc closed' }));
    assert.equal(r.take()[0]?.error, 'fetch https://solana-devnet.g.alchemy.com failed; wss://x.example closed');
});

test('publicText keeps a text short enough for the page and strips URLs to their host', () => {
    assert.equal(publicText('see https://devnet.helius-rpc.com/?api-key=k now', 100), 'see https://devnet.helius-rpc.com now');
    assert.equal(publicText('x'.repeat(50), 10), 'xxxxxxx...');
});
