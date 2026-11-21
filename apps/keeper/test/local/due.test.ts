// The runner sends a job when it is due and only then (docs/spec/keeper-runner.md, "Testing
// it"), against a local validator running devnet's router and the tax AMM.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BURN_SLOT, SUITE_SLOT, SUITE_TREASURY } from 'tax-amm-scripts/client/index.ts';

import {
    checkLocalValidator,
    createMarket,
    jobRows,
    owed,
    signaturesOf,
    supply,
    testRunner,
    tokenBalance,
    tokens,
    trade,
    until,
    wallet,
    type TestRunner,
} from './harness.ts';

let keeper: TestRunner | undefined;

before(checkLocalValidator);
after(() => keeper?.runner.stop());

test('distribute is sent in the daily pass for every owed slot, the burn included, and at no other time', async () => {
    const owner = await wallet(10n);
    const mints = await tokens(owner);
    const settings = { KEEPER_SWEEP_INTERVAL: '10m', KEEPER_SETTLE_INTERVAL: '1h' };
    keeper = testRunner(await wallet(), mints, { env: settings, dailyInMinutes: 150 });
    const { runner, log, clock } = keeper;

    // Nothing exists yet, so the full pass on start finds nothing to do.
    const start = await runner.start();
    assert.equal(start.markets, 0);

    // A market made after the start is found from the runner's own socket.
    const market = await createMarket(owner, mints);
    await until(() => log.of('market').some((row) => row.market === market.marketState), 'the socket to find the new market');
    await trade(market);
    const due = await owed(market);
    assert.deepEqual(due.map((amount, slot) => [slot, amount > 0n]).filter(([, owing]) => owing).map(([slot]) => slot), [0, 1, BURN_SLOT, SUITE_SLOT]);
    await runner.idle();

    // Sweeps and hourly passes come and go: distribute is a daily job, so nothing is sent.
    await clock.advance(140 * 60_000, () => runner.idle());
    assert.ok(log.of('pass').filter((row) => row.pass === 'sweep').length >= 14);
    assert.ok(log.of('pass').some((row) => row.pass === 'hourly'));
    assert.deepEqual(jobRows(log, market), []);
    // The keeper wallet's only transaction is still the airdrop that funded it.
    assert.equal((await signaturesOf(keeper.keeper.address)).length, 1);

    // The daily pass pays every owed slot, each in its own transaction.
    const before = {
        owner: await tokenBalance(owner.address, mints[1]),
        second: await tokenBalance(market.recipients[1]!, mints[1]),
        suite: await tokenBalance(SUITE_TREASURY, mints[1]),
        supply: await supply(mints[1]),
    };
    await clock.advance(10 * 60_000, () => runner.idle());
    const sent = jobRows(log, market).filter((row) => row.outcome === 'sent');
    assert.deepEqual(sent.map((row) => row.slot), [0, 1, BURN_SLOT, SUITE_SLOT]);
    assert.equal(new Set(sent.map((row) => row.signature)).size, 4);
    assert.equal((await tokenBalance(owner.address, mints[1])) - before.owner, due[0]);
    assert.equal((await tokenBalance(market.recipients[1]!, mints[1])) - before.second, due[1]);
    assert.equal(before.supply - (await supply(mints[1])), due[BURN_SLOT]);
    assert.equal((await tokenBalance(SUITE_TREASURY, mints[1])) - before.suite, due[SUITE_SLOT]);
    assert.deepEqual(await owed(market), [0n, 0n, 0n, 0n, 0n, 0n]);
    assert.ok(log.of('pass').some((row) => row.pass === 'daily' && row.sent === 4));
});
