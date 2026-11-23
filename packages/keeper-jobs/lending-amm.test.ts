// The lending AMM's keeper jobs: `rebalance`'s due rule at the band's edges, at MIN_REBALANCE and
// at withdraw mode's thresholds and exit delay, `refresh_reserve`'s at half of
// TRADE_MAX_RESERVE_AGE_SLOTS, and the transactions both build (docs/spec/keeper-runner.md, "The
// jobs"; docs/spec/lending-pool.md, "The buffer and `rebalance`").

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { AccountRole, address, generateKeyPairSigner, type Address, type GetAccountInfoApi, type Rpc } from '@solana/kit';
import {
    findAuthorityPda,
    getLendingAmmMarketDecoder,
    getLendingAmmMarketEncoder,
    getLendingAmmMarketSize,
    LENDING_AMM_ERROR__BELOW_MIN_REBALANCE,
    LENDING_AMM_ERROR__KAMINO_DEPOSITS_BLOCKED,
    LENDING_AMM_ERROR__KAMINO_STOPPED,
    LENDING_AMM_ERROR__WITHIN_BAND,
    LENDING_AMM_MARKET_DISCRIMINATOR,
    LENDING_AMM_PROGRAM_ADDRESS,
    REBALANCE_DISCRIMINATOR,
    WITHDRAW_MODE_ENTER,
    WITHDRAW_MODE_EXIT,
    WITHDRAW_MODE_EXIT_DELAY_SLOTS,
    type LendingAmmMarket,
} from 'lending-amm-scripts/client/index.ts';

import { outcomeOf, products, type Watched } from './index.ts';
import { CLOCK_SYSVAR, KAMINO_RATE_HEADROOM_BPS, KLEND_PROGRAM, LENT_RESERVES, lendingAmm, REFRESH_AFTER_SLOTS, REFRESH_RESERVE_DISCRIMINATOR, type LendingMarket } from './lending-amm.ts';

const fixture = (name: string) =>
    new Uint8Array(Buffer.from(JSON.parse(readFileSync(new URL(`../../programs/lending-amm/tests/fixtures/kamino/devnet/${name}.json`, import.meta.url), 'utf8')).account.data[0], 'base64'));

/** Our devnet WSOL reserve and its lending market, from deployments/kamino-devnet.json. */
const RESERVE = address('5vJJ1sQi972Qcf6oUy3gHEx6prijjSj31CWo5He85Hjw');
const LENDING_MARKET = address('DCKrWS5G3YEcrRP1Ayu8S8nBR4QfgFsSaRzRdPrjqzj3');
const COLLATERAL_MINT = address('8gdtrmgc9QmintdEgJbZhRaqh286ti4wUHMUZw54pLr8');
const LIQUIDITY_SUPPLY = address('GEEjB2HWqjXXTPzceyjzhk3wwD1rwLjAPfiEoBAd9Tzv');
const PYTH_PRICE = address('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
const WSOL = address('So11111111111111111111111111111111111111112');
const TOKEN = address('4gqiCkoxxD72nbXGc7XtxQx4UjBHD3KiJyXpMvEZ6u8c');
const MARKET_STATE = address('GJaWKKtnFXs8CiVDz3WqFwK6hdAZ2VLwh4vpBbEAb9EU');
const VAULT_0 = address('ACrn3UD4DLgyCKbNMiqx6Vcs2d49RSbHdbLJ82uw61s8');
const VAULT_1 = address('C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w');
const CTOKEN_ACCOUNT = address('FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB');
/** WSOL's MIN_REBALANCE on devnet, as LENT_RESERVES gives it. */
const MIN = 50_000_000n;
const SOL = 1_000_000_000n;
const SLOT = 600_000_000n;

type MarketFields = { buffer: bigint; ctokens: bigint; withdrawMode?: boolean; exitSeenSlot?: bigint; other?: bigint };

/** A WSOL-lent market's account bytes (the lent side is mint 1), with the given buffer and cTokens. */
function marketBytes(fields: MarketFields): Uint8Array {
    const empty = new Uint8Array(getLendingAmmMarketSize());
    empty.set(LENDING_AMM_MARKET_DISCRIMINATOR);
    const base: LendingAmmMarket = getLendingAmmMarketDecoder().decode(empty);
    return new Uint8Array(
        getLendingAmmMarketEncoder().encode({
            ...base,
            lentIndex: 1,
            withdrawMode: fields.withdrawMode ?? false,
            mints: [TOKEN, WSOL],
            vaults: [VAULT_0, VAULT_1],
            ctokenAccount: CTOKEN_ACCOUNT,
            reserve: RESERVE,
            collateralMint: COLLATERAL_MINT,
            reserves: [fields.other ?? 1_000_000n, fields.buffer],
            ctokens: fields.ctokens,
            exitSeenSlot: fields.exitSeenSlot ?? 0n,
        }),
    );
}

type ReserveFields = {
    /** Freely available liquidity, `total_available_amount` with nothing queued. */
    free: bigint;
    /** Borrowed, so the cToken supply can be `free + borrowed` at a rate of exactly 1. */
    borrowed?: bigint;
    lastUpdateSlot?: bigint;
    emergencyMode?: boolean;
    blockCtokenUsage?: boolean;
    /** The withdrawal cap's capacity, with an interval of a day starting at Unix time 0; none if unset. */
    withdrawalCap?: bigint;
};

function setU64(data: Uint8Array, offset: number, value: bigint) {
    new DataView(data.buffer, data.byteOffset).setBigUint64(offset, value, true);
}

/** The devnet WSOL reserve's bytes, its numbers set so a cToken is worth exactly one lamport. */
function reserveBytes(fields: ReserveFields): Uint8Array {
    const data = fixture('reserve-sol').slice();
    const borrowed = fields.borrowed ?? 1_000n * SOL;
    setU64(data, 16, fields.lastUpdateSlot ?? SLOT);
    setU64(data, 224, fields.free);
    // borrowed_amount_sf, then the three fee fields at 0: S_total = (free + borrowed) << 60.
    data.fill(0, 232, 248);
    setU64(data, 232, (borrowed << 60n) & ((1n << 64n) - 1n));
    setU64(data, 240, borrowed >> 4n);
    data.fill(0, 344, 392);
    setU64(data, 2592, fields.free + borrowed);
    setU64(data, 6968, 0n);
    data[4862] = fields.blockCtokenUsage ? 1 : 0;
    data[4864] = fields.emergencyMode ? 1 : 0;
    data.fill(0, 5416, 5448);
    if (fields.withdrawalCap !== undefined) {
        setU64(data, 5416, fields.withdrawalCap);
        setU64(data, 5440, 86_400n);
    }
    return data;
}

function lendingMarketBytes(emergencyMode = false): Uint8Array {
    const data = fixture('lending-market').slice();
    data[122] = emergencyMode ? 1 : 0;
    return data;
}

function clockBytes(slot: bigint, unixTime = 1_800_000_000n): Uint8Array {
    const data = new Uint8Array(40);
    setU64(data, 0, slot);
    new DataView(data.buffer).setBigInt64(32, unixTime, true);
    return data;
}

type Chain = { reserve: ReserveFields; emergency?: boolean; slot?: bigint };

function watched({ reserve, emergency, slot }: Chain): Watched {
    return new Map<Address, Uint8Array | null>([
        [RESERVE, reserveBytes(reserve)],
        [LENDING_MARKET, lendingMarketBytes(emergency)],
        [CLOCK_SYSVAR, clockBytes(slot ?? SLOT)],
    ]);
}

const [rebalance, refreshReserve] = lendingAmm.jobs as [(typeof lendingAmm.jobs)[number], (typeof lendingAmm.jobs)[number]];

function state(market: MarketFields, chain: Chain): LendingMarket {
    return lendingAmm.decode(marketBytes(market), watched(chain));
}

/** Whether `rebalance` is due, and what it would move. */
function rebalanceDue(market: MarketFields, chain: Chain) {
    const units = rebalance.due(state(market, chain));
    assert.ok(units.length <= 1);
    return units[0] ?? null;
}

/** Free liquidity far above 10 times any exposure in these tests, so withdraw mode stays out of the way. */
const PLENTY = 1_000_000n * SOL;

describe('rebalance: the band', () => {
    // L = 10 SOL: the band's edges are a buffer of exactly 1 SOL (10%) and 3 SOL (30%).
    test('is not due with the buffer exactly on either edge, nor one unit inside', () => {
        for (const buffer of [SOL, SOL + 1n, 3n * SOL - 1n, 3n * SOL]) {
            assert.equal(rebalanceDue({ buffer, ctokens: 10n * SOL - buffer }, { reserve: { free: PLENTY } }), null, `buffer ${buffer}`);
        }
    });

    test('redeems with the buffer one unit below BUFFER_MIN_BPS', () => {
        // B = 1 SOL - 1 out of L = 10 SOL - 1: B x 10,000 < L x 1,000.
        const due = rebalanceDue({ buffer: SOL - 1n, ctokens: 9n * SOL }, { reserve: { free: PLENTY } });
        // The target floor(L / 5) less B.
        assert.deepEqual(due, { job: 'rebalance', key: 'rebalance', owed: (10n * SOL - 1n) / 5n - (SOL - 1n) });
    });

    test('deposits with the buffer one unit above BUFFER_MAX_BPS', () => {
        const due = rebalanceDue({ buffer: 3n * SOL + 1n, ctokens: 7n * SOL }, { reserve: { free: PLENTY } });
        assert.deepEqual(due, { job: 'rebalance', key: 'rebalance', owed: 3n * SOL + 1n - (10n * SOL + 1n) / 5n });
    });

    test('a market that is not seeded yet has nothing due', () => {
        assert.equal(rebalanceDue({ buffer: SOL, ctokens: 0n, other: 0n }, { reserve: { free: PLENTY } }), null);
    });
});

describe('rebalance: MIN_REBALANCE', () => {
    // L = 0.1 SOL, target 0.02 SOL: a buffer of 0.07 SOL deposits exactly MIN_REBALANCE.
    test('a deposit of exactly MIN_REBALANCE is due, and one unit less is not', () => {
        assert.equal(rebalanceDue({ buffer: 70_000_000n, ctokens: 30_000_000n }, { reserve: { free: PLENTY } })?.owed, MIN);
        assert.equal(rebalanceDue({ buffer: 70_000_000n - 1n, ctokens: 30_000_000n + 1n }, { reserve: { free: PLENTY } }), null);
    });

    test('a redeem capped below MIN_REBALANCE by what Kamino can pay is not due, and is at exactly it', () => {
        // Below the band by 1 SOL, but the withdrawal cap leaves only what its headroom allows.
        const market = { buffer: 0n, ctokens: 10n * SOL };
        const afterHeadroom = (cap: bigint) => cap - (cap * KAMINO_RATE_HEADROOM_BPS + 9_999n) / 10_000n;
        const capFor = (want: bigint) => {
            let cap = want;
            while (afterHeadroom(cap) < want) cap++;
            return cap;
        };
        assert.equal(rebalanceDue(market, { reserve: { free: PLENTY, withdrawalCap: capFor(MIN) } })?.owed, MIN);
        assert.equal(rebalanceDue(market, { reserve: { free: PLENTY, withdrawalCap: capFor(MIN) - 1n } }), null);
    });

    test('in withdraw mode the last cTokens are redeemed even below MIN_REBALANCE', () => {
        // Kamino's free liquidity is short of 5 X, and the market holds less than MIN_REBALANCE.
        const due = rebalanceDue({ buffer: 10n * SOL, ctokens: 1_000n, withdrawMode: true }, { reserve: { free: SOL } });
        assert.equal(due?.owed, 1_000n);
    });
});

describe('rebalance: withdraw mode', () => {
    // B = 2 SOL, V = 8 SOL: inside the band, and X = max(V, T) = 8 SOL.
    const inBand = { buffer: 2n * SOL, ctokens: 8n * SOL };
    const x = 8n * SOL;

    test(`enters below WITHDRAW_MODE_ENTER (${WITHDRAW_MODE_ENTER}) times X, not at exactly it`, () => {
        assert.equal(rebalanceDue(inBand, { reserve: { free: WITHDRAW_MODE_ENTER * x } }), null);
        // Entering redeems everything: all of V, which Kamino can pay.
        assert.equal(rebalanceDue(inBand, { reserve: { free: WITHDRAW_MODE_ENTER * x - 1n } })?.owed, 8n * SOL);
    });

    test('enters even with nothing Kamino can pay, which only records the mode', () => {
        assert.deepEqual(rebalanceDue(inBand, { reserve: { free: 0n } }), { job: 'rebalance', key: 'rebalance', owed: 0n });
    });

    // A market in withdraw mode that has redeemed everything: V = 0, so X is its target lent value T = 8 SOL.
    const redeemed = { buffer: 10n * SOL, ctokens: 0n, withdrawMode: true };

    test(`starts the wait to leave above WITHDRAW_MODE_EXIT (${WITHDRAW_MODE_EXIT}) times X, and has nothing to do at exactly it`, () => {
        assert.equal(rebalanceDue(redeemed, { reserve: { free: WITHDRAW_MODE_EXIT * x } }), null);
        assert.deepEqual(rebalanceDue(redeemed, { reserve: { free: WITHDRAW_MODE_EXIT * x + 1n } }), { job: 'rebalance', key: 'rebalance', owed: 0n });
    });

    test('leaves only once WITHDRAW_MODE_EXIT_DELAY_SLOTS have passed since the sighting, and lends at once', () => {
        const seen = SLOT - WITHDRAW_MODE_EXIT_DELAY_SLOTS;
        const above = { free: WITHDRAW_MODE_EXIT * x + 1n };
        // One slot early: the sighting is already recorded and nothing is left to redeem.
        assert.equal(rebalanceDue({ ...redeemed, exitSeenSlot: seen + 1n }, { reserve: above }), null);
        // On time: it leaves and deposits the surplus above the target, 8 SOL.
        assert.equal(rebalanceDue({ ...redeemed, exitSeenSlot: seen }, { reserve: above })?.owed, 8n * SOL);
    });

    test('forgets the wait when the free liquidity is back at or below the exit threshold', () => {
        assert.deepEqual(rebalanceDue({ ...redeemed, exitSeenSlot: SLOT - 10n }, { reserve: { free: WITHDRAW_MODE_EXIT * x } }), { job: 'rebalance', key: 'rebalance', owed: 0n });
    });

    test('while Kamino redeems nothing it is due only to forget a wait to leave', () => {
        const below = { buffer: 0n, ctokens: 10n * SOL };
        assert.equal(rebalanceDue(below, { reserve: { free: PLENTY }, emergency: true }), null);
        assert.equal(rebalanceDue(below, { reserve: { free: PLENTY, emergencyMode: true } }), null);
        assert.ok(rebalanceDue({ ...redeemed, exitSeenSlot: SLOT - 10n }, { reserve: { free: PLENTY }, emergency: true }));
    });

    test('skips a deposit while Kamino blocks cToken deposits', () => {
        assert.equal(rebalanceDue({ buffer: 5n * SOL, ctokens: 5n * SOL }, { reserve: { free: PLENTY, blockCtokenUsage: true } }), null);
    });
});

describe('rebalance: what it reads and builds', () => {
    test('watches the reserve, its lending market and the clock', () => {
        assert.deepEqual(lendingAmm.watches!(marketBytes({ buffer: 0n, ctokens: 0n })), [RESERVE, LENDING_MARKET, CLOCK_SYSVAR]);
    });

    test('has nothing due until the watched accounts are read, or when one is missing', () => {
        const market = { buffer: 0n, ctokens: 10n * SOL };
        assert.deepEqual(rebalance.due(lendingAmm.decode(marketBytes(market))), []);
        const missing = new Map(watched({ reserve: { free: PLENTY } }));
        missing.set(LENDING_MARKET, null);
        assert.deepEqual(rebalance.due(lendingAmm.decode(marketBytes(market), missing)), []);
    });

    test("builds klend's refresh_reserve and then rebalance, with the reserve's own oracle and accounts", async () => {
        const payer = await generateKeyPairSigner();
        const input = { rpc: {} as Rpc<GetAccountInfoApi>, marketState: MARKET_STATE, state: state({ buffer: 0n, ctokens: 10n * SOL }, { reserve: { free: PLENTY } }), unit: { job: 'rebalance', key: 'rebalance' }, payer };
        const [refresh, call, ...rest] = await rebalance.build(input);
        assert.equal(rest.length, 0);
        assert.equal(refresh!.programAddress, KLEND_PROGRAM);
        assert.deepEqual([...refresh!.data!], [...REFRESH_RESERVE_DISCRIMINATOR]);
        assert.deepEqual(
            refresh!.accounts!.map((account) => [account.address, account.role]),
            [
                [RESERVE, AccountRole.WRITABLE],
                [LENDING_MARKET, AccountRole.READONLY],
                [PYTH_PRICE, AccountRole.READONLY],
                [KLEND_PROGRAM, AccountRole.READONLY],
                [KLEND_PROGRAM, AccountRole.READONLY],
                [KLEND_PROGRAM, AccountRole.READONLY],
            ],
        );
        assert.equal(call!.programAddress, LENDING_AMM_PROGRAM_ADDRESS);
        assert.deepEqual([...call!.data!.slice(0, 8)], [...REBALANCE_DISCRIMINATOR]);
        const [authority] = await findAuthorityPda({ marketState: MARKET_STATE });
        assert.deepEqual(
            call!.accounts!.slice(0, 11).map((account) => account.address),
            [payer.address, MARKET_STATE, authority, VAULT_1, CTOKEN_ACCOUNT, WSOL, RESERVE, LENDING_MARKET, address('CaiCuUSWJvXwt7iYjP48NfmjasJeLTYFySahCHfEDxne'), LIQUIDITY_SUPPLY, COLLATERAL_MINT],
        );
    });

    test("sends rebalance alone while the lending market's emergency mode is on, when klend refuses the refresh", async () => {
        const payer = await generateKeyPairSigner();
        const input = {
            rpc: {} as Rpc<GetAccountInfoApi>,
            marketState: MARKET_STATE,
            state: state({ buffer: 10n * SOL, ctokens: 0n, withdrawMode: true, exitSeenSlot: 5n }, { reserve: { free: PLENTY }, emergency: true }),
            unit: { job: 'rebalance', key: 'rebalance' },
            payer,
        };
        const instructions = await rebalance.build(input);
        assert.deepEqual(instructions.map((instruction) => instruction.programAddress), [LENDING_AMM_PROGRAM_ADDRESS]);
    });

    test("takes the program's band, floor and Kamino refusals for nothing to do, and any other as a failure", () => {
        const refused = (code: number) => outcomeOf(rebalance, { failed: true, customError: code, logs: [] });
        for (const code of [LENDING_AMM_ERROR__WITHIN_BAND, LENDING_AMM_ERROR__BELOW_MIN_REBALANCE, LENDING_AMM_ERROR__KAMINO_STOPPED, LENDING_AMM_ERROR__KAMINO_DEPOSITS_BLOCKED]) {
            assert.equal(refused(code), 'nothing-to-do');
        }
        assert.equal(refused(6049), 'failure');
        assert.equal(outcomeOf(rebalance, { failed: false, customError: null, logs: [] }), 'send');
    });

    test('is in the products the runner and Aviary read', () => {
        assert.ok(products.includes(lendingAmm));
    });
});

describe('refresh_reserve', () => {
    const holding = { buffer: 2n * SOL, ctokens: 8n * SOL };
    const aged = (age: bigint, extra: Partial<Chain> = {}) => refreshReserve.due(state(holding, { reserve: { free: PLENTY, lastUpdateSlot: SLOT - age }, ...extra }));

    test('is due once the reserve was last refreshed more than half of TRADE_MAX_RESERVE_AGE_SLOTS ago, not at exactly half', () => {
        assert.equal(REFRESH_AFTER_SLOTS, 4_500n);
        assert.deepEqual(aged(REFRESH_AFTER_SLOTS), []);
        assert.deepEqual(aged(REFRESH_AFTER_SLOTS + 1n), [{ job: 'refresh_reserve', key: 'refresh_reserve', owed: REFRESH_AFTER_SLOTS + 1n }]);
    });

    test("is not due for a market holding no cTokens, nor while the lending market's emergency mode is on", () => {
        assert.deepEqual(refreshReserve.due(state({ buffer: SOL, ctokens: 0n }, { reserve: { free: PLENTY, lastUpdateSlot: 0n } })), []);
        assert.deepEqual(aged(9_000n, { emergency: true }), []);
    });

    test("builds klend's refresh_reserve alone", async () => {
        const payer = await generateKeyPairSigner();
        const input = { rpc: {} as Rpc<GetAccountInfoApi>, marketState: MARKET_STATE, state: state(holding, { reserve: { free: PLENTY, lastUpdateSlot: 0n } }), unit: { job: 'refresh_reserve', key: 'refresh_reserve' }, payer };
        const instructions = await refreshReserve.build(input);
        assert.deepEqual(instructions.map((instruction) => instruction.programAddress), [KLEND_PROGRAM]);
    });
});

describe("the program's values this entry repeats", () => {
    const config = readFileSync(new URL('../../programs/lending-amm/src/config.rs', import.meta.url), 'utf8');

    test('LENT_RESERVES is every LENT_MINTS row of both clusters, with its lending market and MIN_REBALANCE', () => {
        const rows = [...config.matchAll(/lending_market: pubkey!\("(\w+)"\),\s*reserve: pubkey!\("(\w+)"\),[\s\S]*?min_rebalance: ([\d_]+),/g)].map(([, lendingMarket, reserve, min]) => ({
            reserve,
            lendingMarket,
            minRebalance: BigInt(min!.replaceAll('_', '')),
        }));
        assert.equal(rows.length, 4);
        assert.deepEqual(
            [...LENT_RESERVES].sort((a, b) => a.reserve.localeCompare(b.reserve)),
            rows.sort((a, b) => a.reserve!.localeCompare(b.reserve!)),
        );
    });

    test('KAMINO_RATE_HEADROOM_BPS is config.rs\'s', () => {
        assert.equal(`${KAMINO_RATE_HEADROOM_BPS}`, /pub const KAMINO_RATE_HEADROOM_BPS: u16 = ([\d_]+);/.exec(config)![1]!.replaceAll('_', ''));
    });
});
