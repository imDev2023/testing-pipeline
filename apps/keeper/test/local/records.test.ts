// What the runner records (docs/spec/keeper-runner.md, "What it records"), against a local
// validator running devnet's router and the tax AMM: a pass that sent something is recorded once,
// with every job's signature, in Aviary's database when DATABASE_URL is set and as one `record`
// row in the log when it is not; a pass that sent nothing records nothing; and every pass ends
// with a heartbeat.
//
// Needs TEST_DATABASE_URL as well as the local validator (apps/keeper/README.md, "Testing").

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { KeeperHeartbeatPayload } from 'terminal-api/contract';
import { createDb, readKeeperRecords } from 'terminal-db';
import { createTestDatabase } from 'terminal-db/testing';

import type { Heartbeat } from '../../src/heartbeat.ts';
import { databaseRecorder } from '../../src/record-db.ts';
import { checkLocalValidator, createMarket, jobRows, testRunner, tokens, trade, until, wallet, type TestRunner } from './harness.ts';

const runners: TestRunner[] = [];
let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;

before(async () => {
    await checkLocalValidator();
    database = await createTestDatabase();
});
after(async () => {
    for (const { runner } of runners) runner.stop();
    await database?.drop();
});

/** A heartbeat that keeps what it is given. */
function heartbeats(): Heartbeat & { beats: KeeperHeartbeatPayload[] } {
    const beats: KeeperHeartbeatPayload[] = [];
    return { beats, beat: (payload) => void beats.push(payload), flush: async () => {} };
}

/**
 * A started runner, and a market made after its start (so the pass on start finds nothing to do)
 * that owes tax in every slot, with the runner's daily pass 30 minutes after it starts.
 */
async function owingMarket(options: Parameters<typeof testRunner>[2]) {
    const owner = await wallet(10n);
    const mints = await tokens(owner);
    const keeper = testRunner(await wallet(), mints, { dailyInMinutes: 30, ...options });
    runners.push(keeper);
    await keeper.runner.start();
    const market = await createMarket(owner, mints);
    await until(() => keeper.log.of('market').some((row) => row.market === market.marketState), 'the socket to find the new market');
    await trade(market);
    await keeper.runner.idle();
    return { keeper, market };
}

test('without DATABASE_URL, the pass that sent the payouts is logged as one record with their signatures, and quiet passes record nothing', async () => {
    const beat = heartbeats();
    const { keeper, market } = await owingMarket({ heartbeat: beat });
    const { runner, log, clock } = keeper;

    await clock.advance(25 * 60_000, () => runner.idle());
    assert.deepEqual(log.of('record'), [], 'the pass on start, the passes after the trade and two sweeps sent nothing, so nothing is recorded');
    const passes = beat.beats.map((b) => b.pass);
    assert.equal(passes[0], 'start');
    assert.deepEqual(passes.filter((pass) => pass === 'sweep'), ['sweep', 'sweep']);
    assert.equal(passes.length, log.of('pass').length, 'but each pass sent its heartbeat');

    await clock.advance(10 * 60_000, () => runner.idle());
    const records = log.of('record');
    assert.equal(records.length, 1);
    const record = records[0] as Record<string, any>;
    const sent = jobRows(log, market).filter((row) => row.outcome === 'sent');
    assert.equal(sent.length, 4);
    assert.equal(record.pass, 'daily');
    assert.equal(record.wallet, keeper.keeper.address);
    assert.deepEqual(
        record.jobs.map((job: Record<string, unknown>) => [job.market, job.job, job.slot, job.outcome, job.signature, job.cost]),
        sent.map((row) => [market.marketState, 'distribute', row.slot, 'sent', row.signature, row.cost]),
    );
    assert.equal(record.counts.sent, 4);
    assert.equal(record.spentByMarket[market.marketState], record.spentTotal);
    const daily = beat.beats.find((b) => b.pass === 'daily');
    assert.equal(daily?.sweepIntervalMs, 600_000);
    assert.equal(daily?.wallet, keeper.keeper.address);
});

test('with DATABASE_URL, the same pass is written to the database instead, and nothing is logged in its place', async () => {
    const url = database!.url;
    const { keeper, market } = await owingMarket({ recorder: (log) => databaseRecorder(url, log) });
    const { runner, log, clock } = keeper;

    await clock.advance(35 * 60_000, () => runner.idle());
    await clock.advance(20 * 60_000, () => runner.idle());
    assert.deepEqual(log.of('record'), []);

    const sent = jobRows(log, market).filter((row) => row.outcome === 'sent');
    assert.equal(sent.length, 4);
    const { db, close } = createDb(url);
    try {
        const records = await readKeeperRecords(db, { wallet: keeper.keeper.address, now: new Date(clock.now()), recentJobs: 10, since: null });
        assert.deepEqual(
            records.lastOfEachKind.map((pass) => [pass.pass, pass.counts.sent]),
            [['daily', 4]],
            'only the daily pass, which sent, was recorded',
        );
        assert.deepEqual(
            records.recent.map((job) => job.signature).sort(),
            sent.map((row) => row.signature).sort(),
        );
        assert.equal(records.today?.spentTotal, records.today?.spentByMarket[market.marketState]);
    } finally {
        await close();
    }
});
