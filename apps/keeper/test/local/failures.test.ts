// A failed job is retried after each of RETRY_DELAYS, then parked until its market's state
// changes (docs/spec/keeper-runner.md, "Failures"). The failure is real: the recipient's token
// account is frozen, so the payout's transfer is refused.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
    checkLocalValidator,
    createMarket,
    freezeRecipient,
    jobRows,
    owed,
    testRunner,
    thawRecipient,
    tokenBalance,
    tokens,
    trade,
    wallet,
    type TestRunner,
} from './harness.ts';

let keeper: TestRunner | undefined;

before(checkLocalValidator);
after(() => keeper?.runner.stop());

test('a failing payout is retried at RETRY_DELAYS, then parked until its market changes', async () => {
    const owner = await wallet(10n);
    const mints = await tokens(owner, true);
    const market = await createMarket(owner, mints);
    const frozen = market.recipients[1]!;
    await freezeRecipient(market, frozen);
    await trade(market);
    const owedToFrozen = (await owed(market))[1]!;
    assert.ok(owedToFrozen > 0n);

    // Passes far apart, so only the retries run in between.
    keeper = testRunner(await wallet(), mints, {
        env: { KEEPER_RETRY_DELAYS: '1m,3m', KEEPER_SWEEP_INTERVAL: '6h', KEEPER_SETTLE_INTERVAL: '6h' },
        dailyInMinutes: 60,
    });
    const { runner, log, clock } = keeper;
    const slot1 = () => jobRows(log, market).filter((row) => row.slot === 1);

    // The full pass on start pays every slot but the frozen recipient's, whose payout fails.
    await runner.start();
    assert.deepEqual(jobRows(log, market).filter((row) => row.slot !== 1).map((row) => row.outcome), ['sent', 'sent', 'sent']);
    assert.deepEqual(slot1().map((row) => [row.outcome, row.attempt, row.retryInMs]), [['failed', 1, 60_000]]);
    assert.match(String(slot1()[0]!.error), /0x11|AccountFrozen|frozen/i);

    // Not before its delay; then exactly at it.
    await clock.advance(59_000, () => runner.idle());
    assert.equal(slot1().length, 1);
    await clock.advance(1_000, () => runner.idle());
    assert.deepEqual(slot1().map((row) => [row.outcome, row.attempt]), [['failed', 1], ['failed', 2]]);
    await clock.advance(179_000, () => runner.idle());
    assert.equal(slot1().length, 2);
    await clock.advance(1_000, () => runner.idle());
    assert.deepEqual(slot1().map((row) => row.outcome), ['failed', 'failed', 'parked']);
    assert.equal(slot1()[2]!.attempt, 3);

    // Parked: the daily pass leaves it alone while the market is unchanged.
    await clock.advance(60 * 60_000, () => runner.idle());
    const daily = log.of('pass').filter((row) => row.pass === 'daily');
    assert.equal(daily.length, 1);
    assert.equal(daily[0]!.parked, 1);
    assert.equal(slot1().length, 3);

    // The market changes (a trade), and the account is thawed: the next daily pass pays it.
    await thawRecipient(market, frozen);
    await trade(market);
    const owedNow = (await owed(market))[1]!;
    const before = await tokenBalance(frozen, mints[1]);
    await runner.idle();
    await clock.advance(24 * 60 * 60_000, () => runner.idle());
    assert.deepEqual(slot1().slice(3).map((row) => row.outcome), ['unparked', 'sent']);
    assert.equal((await tokenBalance(frozen, mints[1])) - before, owedNow);
    assert.deepEqual(await owed(market), [0n, 0n, 0n, 0n, 0n, 0n]);
});
