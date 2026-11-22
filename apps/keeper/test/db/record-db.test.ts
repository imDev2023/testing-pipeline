// The runner's writer (docs/spec/keeper-runner.md, "What it records"): each recorded pass goes to
// Aviary's Postgres in one transaction, and a database that cannot be reached never stops the
// runner: the pass is logged as it would have been without DATABASE_URL, with the reason.
//
// Needs TEST_DATABASE_URL (the Docker Postgres locally, the terminal job's service in CI), as
// packages/terminal-db's own tests do.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createDb, readKeeperRecords } from 'terminal-db';
import { createTestDatabase } from 'terminal-db/testing';

import { MemoryLogger } from '../../src/log.ts';
import { databaseRecorder } from '../../src/record-db.ts';
import type { KeeperPassRecord } from '../../src/record.ts';

const WALLET = '8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2';
const MARKET = 'FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB';
const AT = new Date('2026-11-22T00:00:04Z');

const pass: KeeperPassRecord = {
    wallet: WALLET,
    pass: 'daily',
    at: AT,
    balance: 1_999_995_000n,
    day: '2026-11-22',
    spentTotal: 5_000n,
    spentByMarket: { [MARKET]: 5_000n },
    caps: { maxTxCost: 3_000_000n, marketDailyCap: 10_000_000n, dailyCap: 100_000_000n, minBalance: 100_000_000n, lowBalance: 500_000_000n },
    settings: { SWEEP_INTERVAL: '10m', DATABASE_URL: 'postgres://terminal:<password>@127.0.0.1:5462/terminal' },
    warnings: [],
    counts: { markets: 1, sent: 1, held: 0, parked: 0, skipped: 3, failed: 0 },
    jobs: [
        { at: AT, market: MARKET, product: 'tax-amm', job: 'distribute', slot: 0, outcome: 'sent', signature: '5sig', cost: 5_000n, estimate: 5_000n, cap: null, error: null, attempt: null },
    ],
};

let database: Awaited<ReturnType<typeof createTestDatabase>>;
before(async () => {
    database = await createTestDatabase();
});
after(async () => {
    await database?.drop();
});

test('a recorded pass and its jobs are written to the database, and nothing is logged in their place', async () => {
    const log = new MemoryLogger();
    const recorder = databaseRecorder(database.url, log);
    try {
        await recorder.record(pass);
    } finally {
        await recorder.close();
    }
    assert.deepEqual(log.rows, []);
    const { db, close } = createDb(database.url);
    try {
        const records = await readKeeperRecords(db, { wallet: WALLET, now: new Date('2026-11-22T00:05:00Z'), recentJobs: 10, since: null });
        const { jobs, wallet, ...rest } = pass;
        assert.deepEqual(records.latest, rest);
        assert.deepEqual(records.recent, jobs.map((job) => ({ ...job, pass: 'daily' })));
        assert.equal(wallet, WALLET);
    } finally {
        await close();
    }
});

test('a database that cannot be reached is logged with the pass, and the runner goes on', async () => {
    const log = new MemoryLogger();
    // A port nothing listens on: refused at once.
    const recorder = databaseRecorder('postgres://terminal:terminal@127.0.0.1:9/terminal', log);
    try {
        await recorder.record(pass);
    } finally {
        await recorder.close();
    }
    const [row] = log.of('record');
    assert.ok(row, 'the pass is logged instead');
    assert.match(String(row.error), /^the database could not record this pass: /);
    assert.doesNotMatch(String(row.error), /terminal:terminal/, 'the error never shows the password');
    const { row: _, error: __, ...logged } = row;
    assert.deepEqual(logged, pass);
});
