// The runner calling the lending AMM's keeper jobs against a local validator running devnet's
// router and devnet's klend with our Kamino lending market cloned (docs/spec/keeper-runner.md,
// "Testing it"): `rebalance` sent from the runner's own socket after a swap pushes the buffer out
// of its band, both ways; a sweep catching a market that left its band while the socket was
// closed; `WithinBand` from a rival keeper's rebalance skipped with no transaction sent; and a
// reserve refreshed once half of TRADE_MAX_RESERVE_AGE_SLOTS has passed.
//
// Start the validator with fast slots (`--ticks-per-slot 8`), since the last test waits about
// 4,500 slots, and register the lending AMM first with its demo's `--register-only`.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { Address, KeyPairSigner, Signature } from '@solana/kit';
import { lendingAmm, type AnyKeeperProduct, type LendingMarket } from 'keeper-jobs';
import { REFRESH_AFTER_SLOTS } from 'keeper-jobs/lending-amm.ts';
import { BUFFER_MAX_BPS, BUFFER_MIN_BPS, BUFFER_TARGET_BPS } from 'lending-amm-scripts/client/index.ts';

import type { Chain } from '../../src/chain.ts';
import { balance, checkLocalHost, LOCAL_URL, rpc, send, signaturesOf, testRunner, until, wallet, type TestRunner } from './harness.ts';
import { bufferShareBps, checkLendingRegistered, createLentMarket, keepReserveFresh, lentState, rebalancedBy, RESERVE, scopedLending, shareAfter, swap, type LentMarket } from './lending.ts';

const runners: TestRunner[] = [];
/** A runner seeing only the given tokens' lending markets, its sweep every 10 minutes of its fake clock. */
const start = (keeper: KeyPairSigner, tokens: Set<Address>, options: { chain?: Chain; products?: readonly AnyKeeperProduct[] } = {}) => {
    const made = testRunner(keeper, [], { env: { KEEPER_SWEEP_INTERVAL: '10m' }, products: options.products ?? [scopedLending(tokens)], chain: options.chain });
    runners.push(made);
    return made;
};
const rowsOf = (made: TestRunner, market: LentMarket, job = 'rebalance') => made.log.of('job').filter((row) => row.market === market.marketState && row.job === job);
const sent = (made: TestRunner, market: LentMarket, job = 'rebalance') => rowsOf(made, market, job).filter((row) => row.outcome === 'sent');

/** The rebalance a keeper would send now, built from the entry with `payer` paying. */
async function rebalanceNow(market: LentMarket, payer: KeyPairSigner) {
    const job = lendingAmm.jobs.find((candidate) => candidate.name === 'rebalance')!;
    const state = await lentState(market);
    const [unit] = job.due(state);
    assert.ok(unit, 'rebalance is due');
    return send(payer, await job.build({ rpc, marketState: market.marketState, state, unit, payer }));
}

/** Within one cToken's worth plus klend's rounding of the target share. */
function assertAtTarget(bps: bigint, what: string) {
    assert.ok(bps >= BigInt(BUFFER_TARGET_BPS) - 1n && bps <= BigInt(BUFFER_TARGET_BPS), `${what}: the buffer's share is ${bps} bps`);
}

/** A sale of the token that pays out about 0.1 SOL, more than the buffer at its target holds: below the band afterwards. */
const SALE = 60_000_000_000n;
/** A buy with 0.25 SOL, which takes the buffer from its target to above the band. */
const BUY = 250_000_000n;

before(async () => {
    checkLocalHost();
    await checkLendingRegistered(LOCAL_URL);
});
after(() => runners.forEach(({ runner }) => runner.stop()));

test("rebalance is sent from the runner's own socket within a minute of a swap that pushes the buffer out of its band, both ways", async () => {
    const owner = await wallet(10n);
    const market = await createLentMarket(owner);
    // The market starts with the whole lent side in its buffer; a first keeper brings it to target.
    await rebalanceNow(market, owner);
    assertAtTarget((await bufferShareBps(market)).bps, 'after the first rebalance');
    const tokens = new Set([market.token]);
    const keeper = await wallet();
    const made = start(keeper, tokens);
    await made.runner.start();
    await made.runner.idle();
    assert.deepEqual(sent(made, market), []);

    // A buy takes the buffer above its band: the runner deposits into Kamino.
    const before = await bufferShareBps(market);
    const bought = await swap(market, 'buy', BUY);
    const swappedAt = Date.now();
    const above = await shareAfter(market, bought);
    assert.ok(above > BigInt(BUFFER_MAX_BPS), `after the buy: ${above} bps`);
    await until(() => sent(made, market).length === 1, 'the runner to deposit', 60_000);
    const deposited = Date.now() - swappedAt;
    await made.runner.idle();
    const deposit = await rebalancedBy(sent(made, market)[0]!.signature as Signature);
    assert.equal(deposit.direction, 'Deposit');
    const afterDeposit = await bufferShareBps(market);
    assertAtTarget(afterDeposit.bps, 'after the deposit');
    assert.ok(afterDeposit.lentValue > before.lentValue);

    // A sale beyond the buffer takes it below its band: the runner redeems from Kamino.
    const sold = await swap(market, 'sell', SALE);
    const soldAt = Date.now();
    const below = await shareAfter(market, sold);
    assert.ok(below < BigInt(BUFFER_MIN_BPS), `after the sale: ${below} bps`);
    await until(() => sent(made, market).length === 2, 'the runner to redeem', 60_000);
    const redeemed = Date.now() - soldAt;
    await made.runner.idle();
    const redeem = await rebalancedBy(sent(made, market)[1]!.signature as Signature);
    assert.equal(redeem.direction, 'Redeem');
    assertAtTarget((await bufferShareBps(market)).bps, 'after the redeem');
    assert.ok(deposited < 60_000 && redeemed < 60_000, `deposited ${deposited} ms and redeemed ${redeemed} ms after the swaps`);
});

test('a sweep catches a market that left its band while the socket was closed, both ways', async () => {
    const tokens = new Set<Address>();
    const keeper = await wallet();
    const real = testRunner(keeper, []).chain;
    // The socket never delivers anything, as while it is closed.
    const closed: Chain = { ...real, subscribeLogs: () => () => {} };
    const made = start(keeper, tokens, { chain: closed });
    await made.runner.start();
    await made.runner.idle();

    // A market created after the start pass: its whole lent side is in the buffer, above the band.
    const owner = await wallet(10n);
    const market = await createLentMarket(owner);
    tokens.add(market.token);
    assert.equal((await bufferShareBps(market)).bps, 10_000n);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await made.runner.idle();
    assert.deepEqual(rowsOf(made, market), [], 'nothing is sent before the sweep');

    // The sweep finds the market and lends its surplus.
    await made.clock.advance(10 * 60_000, () => made.runner.idle());
    assert.equal(sent(made, market).length, 1);
    assertAtTarget((await bufferShareBps(market)).bps, 'after the sweep');

    // A sale beyond the buffer while the socket stays closed, caught by the next sweep.
    await swap(market, 'sell', SALE);
    assert.ok((await bufferShareBps(market)).bps < BigInt(BUFFER_MIN_BPS));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await made.runner.idle();
    assert.equal(sent(made, market).length, 1, 'nothing is sent before the sweep');
    await made.clock.advance(10 * 60_000, () => made.runner.idle());
    assert.equal(sent(made, market).length, 2);
    assertAtTarget((await bufferShareBps(market)).bps, 'after the second sweep');
});

test("WithinBand, after a rival keeper's rebalance, is skipped in simulation with no transaction sent", async () => {
    const owner = await wallet(10n);
    const market = await createLentMarket(owner);
    const tokens = new Set([market.token]);
    const keeper = await wallet();
    const rival = await wallet();
    let raced = false;
    // Between the runner reading the market and simulating its rebalance, a rival keeper sends one.
    const racing = (real: Chain): Chain => ({
        ...real,
        async simulate(transaction, payer) {
            if (!raced) {
                raced = true;
                await rebalanceNow(market, rival);
            }
            return real.simulate(transaction, payer);
        },
    });
    const made = start(keeper, tokens, { chain: racing(testRunner(keeper, []).chain) });
    const lamportsBefore = await balance(keeper.address);
    const signaturesBefore = (await signaturesOf(keeper.address)).length;
    const summary = await made.runner.once();

    assert.equal(summary.sent, 0);
    const [row, ...rest] = rowsOf(made, market);
    assert.deepEqual(rest, []);
    assert.equal(row!.outcome, 'nothing-to-do');
    assert.equal(row!.reason, 'refused in simulation');
    assert.match(String(row!.error), /"Custom":6034|WithinBand/);
    assert.equal(await balance(keeper.address), lamportsBefore);
    assert.equal((await signaturesOf(keeper.address)).length, signaturesBefore);
    assertAtTarget((await bufferShareBps(market)).bps, "after the rival's rebalance");
});

test('a reserve a market lends to is refreshed once its last refresh is more than half of TRADE_MAX_RESERVE_AGE_SLOTS old', { timeout: 20 * 60_000 }, async () => {
    const owner = await wallet(10n);
    const market = await createLentMarket(owner);
    await rebalanceNow(market, owner);
    await keepReserveFresh(owner);
    const tokens = new Set([market.token]);
    const keeper = await wallet();
    const made = start(keeper, tokens);
    await made.runner.start();
    await made.runner.idle();
    assert.deepEqual(rowsOf(made, market, 'refresh_reserve'), [], 'a fresh reserve is not refreshed');

    // Wait in real time until the reserve's last refresh is REFRESH_AFTER_SLOTS old, then sweep.
    const reserveAge = async (state?: LendingMarket) => {
        const read = state ?? (await lentState(market));
        return read.kamino!.slot - read.kamino!.reserve.lastUpdateSlot;
    };
    await until(async () => (await reserveAge()) > REFRESH_AFTER_SLOTS, `${RESERVE} to age ${REFRESH_AFTER_SLOTS} slots`, 15 * 60_000);
    await made.clock.advance(10 * 60_000, () => made.runner.idle());
    assert.equal(sent(made, market, 'refresh_reserve').length, 1);
    assert.ok((await reserveAge()) < REFRESH_AFTER_SLOTS, 'the reserve was refreshed');
});
