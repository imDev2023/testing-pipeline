// Each spending cap, and the minimum balance, holds a job rather than send it
// (docs/spec/keeper-runner.md, "Spending caps" and "When the wallet runs low or a cap is
// reached"). Each test sets one cap low through its KEEPER_ variable, with a fresh keeper wallet
// so today's spend starts at 0.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { BURN_SLOT, SUITE_SLOT } from 'tax-amm-scripts/client/index.ts';

import { balance, checkLocalValidator, createMarket, jobRows, owed, signaturesOf, testRunner, tokens, trade, wallet, type TestMarket } from './harness.ts';

before(checkLocalValidator);

/** A market owing its owner, a fresh second recipient (no token account yet), the burn and the suite share. */
async function owingMarket(owner?: Awaited<ReturnType<typeof wallet>>, mints?: Awaited<ReturnType<typeof tokens>>): Promise<TestMarket> {
    owner ??= await wallet(10n);
    const market = await createMarket(owner, mints ?? (await tokens(owner)));
    await trade(market);
    return market;
}

const outcomes = (rows: ReturnType<typeof jobRows>) => rows.map((row) => [row.slot, row.outcome, row.cap ?? null]);

test('MAX_TX_COST holds a payout that would cost more than one transaction may', async () => {
    const market = await owingMarket();
    const keeper = await wallet();
    // Below the 5,000-lamport fee, so every payout is over it.
    const { runner, log } = testRunner(keeper, market.mints, { env: { KEEPER_MAX_TX_COST: '0.000004' } });
    const summary = await runner.once();
    assert.deepEqual(outcomes(jobRows(log, market)), [0, 1, BURN_SLOT, SUITE_SLOT].map((slot) => [slot, 'held', 'MAX_TX_COST']));
    assert.equal(summary.held, 4);
    assert.equal((await signaturesOf(keeper.address)).length, 1);
    assert.ok((await owed(market)).every((amount, slot) => slot === 2 || slot === 3 || amount > 0n));
});

test("MARKET_DAILY_CAP holds a market's payouts once it has had its day's share", async () => {
    const market = await owingMarket();
    const keeper = await wallet();
    // One plain payout (its fee) fits; the next does not.
    const { runner, log } = testRunner(keeper, market.mints, { env: { KEEPER_MARKET_DAILY_CAP: '0.000005' } });
    await runner.once();
    assert.deepEqual(outcomes(jobRows(log, market)), [
        [0, 'sent', null],
        [1, 'held', 'MARKET_DAILY_CAP'],
        [BURN_SLOT, 'held', 'MARKET_DAILY_CAP'],
        [SUITE_SLOT, 'held', 'MARKET_DAILY_CAP'],
    ]);
    assert.equal(runner.spentToday()!.of(market.marketState), 5_000n);
});

test('DAILY_CAP holds every payout, on every market, once the day is spent', async () => {
    const owner = await wallet(10n);
    const mints = await tokens(owner);
    const first = await owingMarket(owner, mints);
    const second = await owingMarket(owner, mints);
    const keeper = await wallet();
    const { runner, log } = testRunner(keeper, mints, { env: { KEEPER_DAILY_CAP: '0.000005' } });
    await runner.once();
    const rows = [...jobRows(log, first), ...jobRows(log, second)];
    assert.equal(rows.filter((row) => row.outcome === 'sent').length, 1);
    assert.equal(rows.filter((row) => row.outcome === 'held' && row.cap === 'DAILY_CAP').length, 7);
    assert.equal(runner.spentToday()!.total, 5_000n);
    assert.equal((await signaturesOf(keeper.address)).length, 2);
});

test('below MIN_BALANCE the runner sends nothing, and every pass warns below LOW_BALANCE', async () => {
    const market = await owingMarket();
    const keeper = await wallet();
    const lamports = await balance(keeper.address);
    // Both above the 2 SOL the wallet holds.
    const { runner, log } = testRunner(keeper, market.mints, { env: { KEEPER_MIN_BALANCE: '3', KEEPER_LOW_BALANCE: '4', KEEPER_FLOAT_TARGET: '5' } });
    await runner.once();
    assert.deepEqual(outcomes(jobRows(log, market)), [0, 1, BURN_SLOT, SUITE_SLOT].map((slot) => [slot, 'held', 'MIN_BALANCE']));
    assert.equal(await balance(keeper.address), lamports);
    const [pass] = log.of('pass');
    assert.match(String((pass!.warnings as string[]).join()), /low balance/);
});
