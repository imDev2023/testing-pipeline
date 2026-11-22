// Today's spend is rebuilt from the keeper wallet's own transactions whenever the runner starts,
// so a restart can never reset a cap (docs/spec/keeper-runner.md, "Spending caps").

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { checkLocalValidator, createMarket, owed, testRunner, tokens, trade, wallet } from './harness.ts';

before(checkLocalValidator);

test("after a restart, today's spend is the spend before it, in all and per market", async () => {
    const owner = await wallet(10n);
    const mints = await tokens(owner);
    const first = await createMarket(owner, mints);
    const second = await createMarket(owner, mints, 0);
    await trade(first);
    await trade(second);
    const keeper = await wallet();

    // Paying both markets out creates token accounts (rent) as well as paying fees.
    const before = testRunner(keeper, mints);
    const summary = await before.runner.once();
    assert.equal(summary.sent, 7);
    assert.deepEqual(await owed(first), [0n, 0n, 0n, 0n, 0n, 0n]);
    const spent = before.runner.spentToday()!;
    assert.ok(spent.of(first.marketState) > 2_000_000n, 'the first market paid rent for a new token account');
    assert.ok(spent.of(second.marketState) > 0n);
    assert.equal(spent.total, spent.of(first.marketState) + spent.of(second.marketState));

    // A new runner on the same wallet, as after a restart, owing nothing, so it sends nothing.
    const after = testRunner(keeper, mints);
    const again = await after.runner.once();
    assert.equal(again.sent, 0);
    const rebuilt = after.runner.spentToday()!;
    assert.equal(rebuilt.total, spent.total);
    assert.equal(rebuilt.of(first.marketState), spent.of(first.marketState));
    assert.equal(rebuilt.of(second.marketState), spent.of(second.marketState));
    assert.ok(after.log.of('spend').some((row) => row.event === 'rebuilt'));
});
