// The runner calling the buy wall AMM's four keeper jobs against a local validator running
// devnet's router and the buy wall AMM (docs/spec/keeper-runner.md, "Testing it"): the wall
// placed after the swap that makes it due, its keeper tip landing in the keeper wallet's
// wrapped-SOL account and unwrapped into the float once above TIP_UNWRAP_AT, `settle` never
// twice within SETTLE_INTERVAL on one market, and the daily payouts.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { SUITE_TREASURY } from 'buy-wall-amm-scripts/client/index.ts';

import { checkBuyWallRegistered, createWallMarket, makeWallDue, scopedWall, swap, wallState, WSOL, type WallMarket } from './buy-wall.ts';
import { balance, checkLocalValidator, jobRows as taxJobRows, LOCAL_URL, rpc, send, testRunner, tokenAccount, tokenBalance, until, wallet, type TestRunner } from './harness.ts';

const runners: TestRunner[] = [];
const start = (keeper: KeyPairSigner, market: WallMarket, env: Record<string, string> = {}, dailyInMinutes = 12 * 60) => {
    const made = testRunner(keeper, [], { env: { KEEPER_SWEEP_INTERVAL: '10m', KEEPER_SETTLE_INTERVAL: '1h', ...env }, dailyInMinutes, products: [scopedWall([market.token])] });
    runners.push(made);
    return made;
};
const jobRows = (made: TestRunner, market: WallMarket, job?: string) =>
    taxJobRows(made.log, { marketState: market.marketState } as Parameters<typeof taxJobRows>[1]).filter((row) => job === undefined || row.job === job);

const exists = async (account: Parameters<typeof balance>[0]) => (await rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send()).value !== null;
/** An amount of lamports as a KEEPER_ setting writes it, in SOL. */
const asSol = (lamports: bigint) => `${lamports / 1_000_000_000n}.${(lamports % 1_000_000_000n).toString().padStart(9, '0')}`;

before(async () => {
    await checkLocalValidator();
    await checkBuyWallRegistered(LOCAL_URL);
});
after(() => runners.forEach(({ runner }) => runner.stop()));

test("place_wall is sent from the runner's own socket after the swap that makes it due, tipping the keeper wallet's wrapped-SOL account, which the same transaction creates", async () => {
    const owner = await wallet(20n);
    const market = await createWallMarket(owner);
    const keeper = await wallet();
    const made = start(keeper, market);
    await made.runner.start();
    const tipAccount = await tokenAccount(keeper.address, WSOL);
    assert.equal(await exists(tipAccount), false);

    await makeWallDue(market);
    const madeDue = Date.now();
    await until(() => jobRows(made, market, 'place_wall').some((row) => row.outcome === 'sent'), 'the runner to place the wall', 60_000);
    const placedWithinMs = Date.now() - madeDue;
    await made.runner.idle();

    const [placed] = jobRows(made, market, 'place_wall').filter((row) => row.outcome === 'sent');
    const state = await wallState(market);
    assert.ok(state.wallLiquidity > 0n, 'the wall is placed');
    assert.equal(state.idleSol, 0n);
    // The tip account was created by the placement itself, and holds exactly the tips the market paid.
    const tips = await tokenBalance(keeper.address, WSOL);
    assert.ok(tips > 0n);
    const raw = await rpc.getAccountInfo(market.marketState, { encoding: 'base64', commitment: 'confirmed' }).send();
    const tipsPaid = Buffer.from(raw.value!.data[0], 'base64').readBigUInt64LE(703);
    assert.equal(tips, tipsPaid);
    const transaction = await rpc.getTransaction(placed!.signature as never, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
    assert.ok(transaction!.transaction.message.accountKeys.includes(tipAccount));
    assert.ok(placedWithinMs < 60_000, `placed ${placedWithinMs} ms after the swap`);
});

test('settle runs at most once every SETTLE_INTERVAL on a market, a restart included', async () => {
    const owner = await wallet(20n);
    const market = await createWallMarket(owner);
    await makeWallDue(market);
    assert.ok((await wallState(market)).retiredTokens > 0n);
    const keeper = await wallet();

    // The first runner's start pass settles what the sell retired.
    const first = start(keeper, market);
    await first.runner.start();
    await first.runner.idle();
    assert.equal(jobRows(first, market, 'settle').filter((row) => row.outcome === 'sent').length, 1);
    assert.equal((await wallState(market)).retiredTokens, 0n);

    // More is retired, and the hourly passes before the hour is up send nothing.
    await makeWallDue(market);
    await first.runner.idle();
    assert.ok((await wallState(market)).retiredTokens > 0n);
    await first.clock.advance(59 * 60_000, () => first.runner.idle());
    assert.equal(jobRows(first, market, 'settle').filter((row) => row.outcome === 'sent').length, 1);
    first.runner.stop();

    // A restart within the hour finds the settle on the chain, so its full pass waits too.
    const second = start(keeper, market);
    await second.runner.start();
    await second.runner.idle();
    assert.deepEqual(jobRows(second, market, 'settle').map((row) => row.outcome), ['not-yet']);
    assert.ok((await wallState(market)).retiredTokens > 0n);

    // Once the hour is up, the hourly pass settles.
    await second.clock.advance(60 * 60_000, () => second.runner.idle());
    assert.equal(jobRows(second, market, 'settle').filter((row) => row.outcome === 'sent').length, 1);
    assert.equal((await wallState(market)).retiredTokens, 0n);
});

test('tips are unwrapped into the float once the wrapped-SOL account holds more than TIP_UNWRAP_AT, and not at exactly it', async () => {
    const owner = await wallet(20n);
    const market = await createWallMarket(owner);
    const keeper = await wallet();
    const tipAccount = await tokenAccount(keeper.address, WSOL);

    // A first runner places the wall once and keeps the tip wrapped.
    await makeWallDue(market);
    const first = start(keeper, market);
    await first.runner.start();
    await first.runner.idle();
    first.runner.stop();
    const firstTip = await tokenBalance(keeper.address, WSOL);
    assert.ok(firstTip > 0n);

    // With TIP_UNWRAP_AT at exactly what it holds, nothing is unwrapped.
    const second = start(keeper, market, { KEEPER_TIP_UNWRAP_AT: asSol(firstTip) });
    await second.runner.start();
    await second.runner.idle();
    assert.equal(await tokenBalance(keeper.address, WSOL), firstTip);
    assert.deepEqual(second.log.of('unwrap'), []);

    // The next tip takes it past TIP_UNWRAP_AT: the account is closed into the keeper wallet.
    await makeWallDue(market);
    await until(() => second.log.of('unwrap').some((row) => row.outcome === 'sent'), 'the tips to be unwrapped', 60_000);
    await second.runner.idle();
    assert.equal(await exists(tipAccount), false);
    const [unwrap] = second.log.of('unwrap').filter((row) => row.outcome === 'sent');
    const tips = BigInt(unwrap!.tips as bigint);
    assert.ok(tips > firstTip);
    // The float gained the tips and the account's rent, less the fee.
    const transaction = await rpc.getTransaction(unwrap!.signature as never, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
    const gained = BigInt(transaction!.meta!.postBalances[0]!) - BigInt(transaction!.meta!.preBalances[0]!);
    assert.equal(gained, tips + 2_039_280n - BigInt(transaction!.meta!.fee));
    // Its fee counts in today's spend, as a restart would rebuild it.
    assert.ok(second.runner.spentToday()!.total > 0n);

    // The next placement makes the account again, and its tip lands there (it may be unwrapped
    // again at once, if it alone is more than TIP_UNWRAP_AT).
    await makeWallDue(market);
    await until(() => jobRows(second, market, 'place_wall').filter((row) => row.outcome === 'sent').length === 2, 'the next placement', 60_000);
    await second.runner.idle();
    const [, again] = jobRows(second, market, 'place_wall').filter((row) => row.outcome === 'sent');
    const placement = await rpc.getTransaction(again!.signature as never, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
    const tipBalance = (placement!.meta!.postTokenBalances ?? []).find((entry) => entry.owner === keeper.address && entry.mint === WSOL);
    assert.ok(tipBalance && BigInt(tipBalance.uiTokenAmount.amount) > 0n);
    assert.ok(!(placement!.meta!.preTokenBalances ?? []).some((entry) => entry.owner === keeper.address && entry.mint === WSOL));
});

test('the daily pass pays the rewards and sweeps each fee slot owed, slot 1 skipped while DESIGNER_RECIPIENT is unset, and a payout into a missing account worth less than its rent waits', async () => {
    const owner = await wallet(40n);
    // The suite treasury's wrapped-SOL account exists, as on devnet, so slot 2 is paid whatever it holds.
    await send(owner, [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: SUITE_TREASURY, mint: WSOL })]);
    const freshRecipient = (await generateKeyPairSigner()).address;
    const paid = await createWallMarket(owner);
    const waiting = await createWallMarket(owner, { rewardsRecipient: freshRecipient });
    const keeper = await wallet();
    const made = testRunner(keeper, [], {
        env: { KEEPER_SWEEP_INTERVAL: '10m', KEEPER_SETTLE_INTERVAL: '1h' },
        dailyInMinutes: 90,
        products: [scopedWall([paid.token, waiting.token])],
    });
    runners.push(made);
    const { runner, clock, log } = made;

    // Freshly seeded, the markets owe nothing at the start. The walls go up after the swaps
    // that make them due, and the hourly pass settles, which leaves rewards owed.
    const started = await runner.start();
    assert.equal(started.markets, 2);
    assert.equal(started.sent, 0);
    for (const market of [paid, waiting]) {
        await makeWallDue(market);
        await swap(market, 'sell', 1_000_000_000n);
    }
    await until(() => [paid, waiting].every((market) => jobRows(made, market, 'place_wall').some((row) => row.outcome === 'sent')), 'both walls placed', 60_000);
    await clock.advance(60 * 60_000, () => runner.idle());
    for (const market of [paid, waiting]) {
        assert.equal(jobRows(made, market, 'settle').filter((row) => row.outcome === 'sent').length, 1);
        const state = await wallState(market);
        assert.ok(state.rewardsOwed > 0n && state.fees[0] > 0n && state.fees[1] > 0n && state.fees[2] > 0n);
    }
    assert.ok(log.of('pass').every((row) => row.pass !== 'daily'));
    const before = { paid: await wallState(paid), waiting: await wallState(waiting), suite: await tokenBalance(SUITE_TREASURY, WSOL) };
    const ownerRewards = await tokenBalance(owner.address, paid.token);

    await clock.advance(30 * 60_000, () => runner.idle());
    const daily = (market: WallMarket) => jobRows(made, market).filter((row) => row.job === 'pay_rewards' || row.job === 'sweep_fees');

    // The market whose recipients have accounts: rewards paid, slots 0 and 2 swept, slot 1 never tried.
    assert.deepEqual(
        daily(paid).map((row) => [row.job, row.slot, row.outcome]),
        [
            ['pay_rewards', null, 'sent'],
            ['sweep_fees', 0, 'sent'],
            ['sweep_fees', 2, 'sent'],
        ],
    );
    const after = await wallState(paid);
    assert.equal(after.rewardsOwed, 0n);
    assert.equal((await tokenBalance(owner.address, paid.token)) - ownerRewards, before.paid.rewardsOwed);
    assert.deepEqual(after.fees, [0n, before.paid.fees[1], 0n]);

    // The market whose rewards recipient has no token account: its rewards, worth less than
    // that account's rent, wait at no cost; its fees are swept.
    const waited = daily(waiting);
    assert.deepEqual(
        waited.map((row) => [row.job, row.slot, row.outcome]),
        [
            ['pay_rewards', null, 'nothing-to-do'],
            ['sweep_fees', 0, 'sent'],
            ['sweep_fees', 2, 'sent'],
        ],
    );
    assert.match(String(waited[0]!.reason), /rent/);
    assert.equal((await wallState(waiting)).rewardsOwed, before.waiting.rewardsOwed);
    assert.equal(await exists(await tokenAccount(freshRecipient, waiting.token)), false);
    assert.equal((await tokenBalance(SUITE_TREASURY, WSOL)) - before.suite, before.paid.fees[2] + before.waiting.fees[2]);
    // Five payouts, five transactions: the skipped one sent nothing.
    const [dailyPass] = log.of('pass').filter((row) => row.pass === 'daily');
    assert.equal(dailyPass!.sent, 5);
    assert.equal(dailyPass!.skipped, 1);
    assert.equal(waited[0]!.signature, undefined);
});
