// A "nothing to do" outcome is a skip that costs nothing, and another keeper sending the job
// first costs the runner only a refused simulation (docs/spec/keeper-runner.md, "Sending a
// job").

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { taxAmm } from 'keeper-jobs';

import type { Chain } from '../../src/chain.ts';
import { balance, checkLocalValidator, createMarket, jobRows, owed, rpc, send, signaturesOf, testRunner, tokens, trade, wallet } from './harness.ts';

before(checkLocalValidator);

test('a market that owes nothing sends nothing', async () => {
    const owner = await wallet(10n);
    const mints = await tokens(owner);
    const market = await createMarket(owner, mints);
    const keeper = await wallet();
    const { runner, log } = testRunner(keeper, mints);
    const summary = await runner.once();
    assert.equal(summary.markets, 1);
    assert.equal(summary.sent, 0);
    assert.deepEqual(jobRows(log, market), []);
    assert.equal((await signaturesOf(keeper.address)).length, 1);
});

test('a second keeper paying a slot first costs the runner only a simulation that did nothing', async () => {
    const owner = await wallet(10n);
    const mints = await tokens(owner);
    const market = await createMarket(owner, mints, 0);
    await trade(market);
    assert.ok((await owed(market))[0]! > 0n);

    const keeper = await wallet();
    const rival = await wallet();
    const distribute = taxAmm.jobs[0]!;
    // Between the runner reading the market and simulating its payout, a rival keeper pays it.
    const racing = (real: Chain): Chain => ({
        ...real,
        async simulate(transaction, payer) {
            const state = taxAmm.decode((await real.accounts([market.marketState])).get(market.marketState)!.data);
            for (const unit of distribute.due(state)) {
                await send(rival, await distribute.build({ rpc, marketState: market.marketState, state, unit, payer: rival }));
            }
            return real.simulate(transaction, payer);
        },
    });
    const { runner, log } = testRunner(keeper, mints, { chain: racing(testRunner(keeper, mints).chain) });
    const lamportsBefore = await balance(keeper.address);
    const summary = await runner.once();

    assert.deepEqual(await owed(market), [0n, 0n, 0n, 0n, 0n, 0n]);
    // The rival paid every slot at the runner's first simulation: that payout simulated as
    // doing nothing, and the rest were no longer due when the runner re-read the market.
    const rows = jobRows(log, market);
    assert.deepEqual(
        rows.map((row) => [row.outcome, row.reason]),
        [['nothing-to-do', 'refused in simulation'], ...rows.slice(1).map(() => ['nothing-to-do', 'no longer due'])],
    );
    assert.ok(rows.length >= 2);
    assert.equal(summary.sent, 0);
    assert.equal(await balance(keeper.address), lamportsBefore);
    assert.equal((await signaturesOf(keeper.address)).length, 1);
    assert.equal(runner.spentToday()!.total, 0n);
});
