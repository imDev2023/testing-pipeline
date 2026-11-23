// The lending AMM's keeper jobs (docs/spec/keeper-runner.md, "The jobs"; docs/spec/lending-pool.md,
// "The buffer and `rebalance`"), built from its generated client:
//
// - `rebalance`, after each transaction on a market and in every sweep, whenever the program would
//   act: the buffer outside its band by at least the lent mint's MIN_REBALANCE, the market
//   entering or leaving withdraw mode, a redeem in withdraw mode, or a sighting of Kamino's free
//   liquidity above the exit threshold to record or forget (LENDING-93, LENDING-95). The rule is
//   the program's own (`withdraw_mode::decide_with_exit_delay` with `buffer::plan` and
//   `Reserve::can_pay_planned`), written again here on the market state, the Kamino reserve and
//   its lending market at their stored state, and the clock; the program's refusals that mean
//   nothing to do (`WithinBand`, `BelowMinRebalance`, `KaminoStopped`, `KaminoDepositsBlocked`)
//   stay the final word, so a simulation on a reserve that moved since it was read costs nothing.
//   klend's `refresh_reserve` goes first in the same transaction, so the call decides on Kamino's
//   state refreshed in that slot (finding S004), except while the lending market's emergency mode
//   is on, when klend refuses the refresh and `rebalance` goes alone (finding R2F-02). It must be
//   the only `rebalance` of its transaction, which one job a transaction gives.
// - `refresh_reserve`, klend's own, in the same passes, for a market holding cTokens whose reserve
//   was last refreshed more than half of TRADE_MAX_RESERVE_AGE_SLOTS ago, so the market keeps
//   quoting on a reserve Kamino's own users leave idle (LENDING-95); not while the lending
//   market's emergency mode is on, when klend refuses it. A reserve serves every market lending to
//   it, so after one market's refresh lands the next market's is no longer due.
//
// Both read accounts beyond the market state, which the entry's `watches` names, so the runner
// reads them with the market in one request: the reserve, its lending market and the clock.

import { address, getAddressEncoder, getProgramDerivedAddress, AccountRole, type Address, type Instruction, type ReadonlyUint8Array } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
    BUFFER_MAX_BPS,
    BUFFER_MIN_BPS,
    BUFFER_TARGET_BPS,
    findAuthorityPda,
    getLendingAmmMarketDecoder,
    getLendingAmmMarketSize,
    getRebalanceInstruction,
    LENDING_AMM_ERROR__BELOW_MIN_REBALANCE,
    LENDING_AMM_ERROR__KAMINO_DEPOSITS_BLOCKED,
    LENDING_AMM_ERROR__KAMINO_STOPPED,
    LENDING_AMM_ERROR__WITHIN_BAND,
    LENDING_AMM_MARKET_DISCRIMINATOR,
    LENDING_AMM_PROGRAM_ADDRESS,
    REBALANCE_DISCRIMINATOR,
    TRADE_MAX_RESERVE_AGE_SLOTS,
    WITHDRAW_MODE_ENTER,
    WITHDRAW_MODE_EXIT,
    WITHDRAW_MODE_EXIT_DELAY_SLOTS,
} from 'lending-amm-scripts/client/index.ts';
import { decodeLendingMarket, decodeReserve, RESERVE_VERSION, type ReserveView, type WithdrawalCap } from 'lending-amm-scripts/kamino.ts';

import type { KeeperJob, KeeperProduct, Watched } from './index.ts';

/** Kamino Lend, the same address on devnet and mainnet (the program's KLEND_PROGRAM). */
export const KLEND_PROGRAM = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
/** The clock sysvar, whose slot and Unix time the due rules read. */
export const CLOCK_SYSVAR = address('SysvarC1ock11111111111111111111111111111111');
/** klend's `refresh_reserve`, `sha256("global:refresh_reserve")[..8]`. */
export const REFRESH_RESERVE_DISCRIMINATOR: ReadonlyUint8Array = new Uint8Array([2, 218, 138, 235, 79, 201, 25, 102]);

/**
 * The reserves a lending AMM market may lend to, with each one's lending market and its lent
 * mint's MIN_REBALANCE: the `LENT_MINTS` of `programs/lending-amm/src/config.rs`, which the
 * program does not export in its IDL. `lending-amm.test.ts` checks every row against that file,
 * so the two cannot drift; the program refuses a market on any other reserve.
 */
export const LENT_RESERVES: readonly { reserve: Address; lendingMarket: Address; minRebalance: bigint }[] = [
    // devnet: our own Kamino lending market (deployments/kamino-devnet.json).
    { reserve: address('5vJJ1sQi972Qcf6oUy3gHEx6prijjSj31CWo5He85Hjw'), lendingMarket: address('DCKrWS5G3YEcrRP1Ayu8S8nBR4QfgFsSaRzRdPrjqzj3'), minRebalance: 50_000_000n },
    { reserve: address('72wAn7eQBbBSXQcb2eAMHz2SDxUgAM51LHhH3aGbY7T3'), lendingMarket: address('DCKrWS5G3YEcrRP1Ayu8S8nBR4QfgFsSaRzRdPrjqzj3'), minRebalance: 5_000_000n },
    // mainnet: Kamino's main market.
    { reserve: address('d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q'), lendingMarket: address('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'), minRebalance: 50_000_000n },
    { reserve: address('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59'), lendingMarket: address('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'), minRebalance: 5_000_000n },
];

/** The program's KAMINO_RATE_HEADROOM_BPS, which it does not export: `lending-amm.test.ts` checks it against config.rs. */
export const KAMINO_RATE_HEADROOM_BPS = 10n;

const BPS = 10_000n;
const FRACTION_BITS = 60n;
const U64_MAX = (1n << 64n) - 1n;

/** What `rebalance` reads of Kamino, and the clock, as the program reads them. */
export type KaminoView = {
    reserve: ReserveView;
    /** The lending market's emergency mode, which stops redeems and refreshes alike. */
    lendingMarketEmergency: boolean;
    slot: bigint;
    unixTime: bigint;
};

/** What the jobs read of a lending AMM market and the accounts it watches. */
export type LendingMarket = {
    /** Seeded: the other side's reserve is above 0 (the program's `is_open`). */
    open: boolean;
    withdrawMode: boolean;
    exitSeenSlot: bigint;
    lentMint: Address;
    bufferVault: Address;
    ctokenAccount: Address;
    reserve: Address;
    collateralMint: Address;
    /** The buffer `B`. */
    buffer: bigint;
    /** The cTokens the market holds, `c`. */
    ctokens: bigint;
    /** The reserve's lending market, as LENT_RESERVES names it, or null for a reserve it does not list. */
    lendingMarket: Address | null;
    minRebalance: bigint | null;
    /** Null until the watched accounts are read, or when one is missing or not what it should be. */
    kamino: KaminoView | null;
};

// The program's maths, as src/kamino.rs, src/buffer.rs and src/withdraw_mode.rs write it ----------

/** klend's total supply in 60-bit fixed point, or null where klend's maths would fail: negative, or beyond 128 bits. */
function totalSupplySf(reserve: ReserveView): bigint | null {
    const supply = reserve.totalSupplySf;
    return supply < 0n || supply >= 1n << 128n ? null : supply;
}

/** What `ctokens` cTokens are worth at the stored rate, or null when that does not fit in a u64: `collateral_value`. */
function collateralValue(ctokens: bigint, supply: bigint, mintTotalSupply: bigint): bigint | null {
    if (ctokens === 0n || supply === 0n || mintTotalSupply === 0n) return 0n;
    const value = (ctokens * supply) / (mintTotalSupply << FRACTION_BITS);
    return value > U64_MAX ? null : value;
}

/** The value `V` of the market's cTokens, or null where the program refuses to value them. */
export function lentValueOf(reserve: ReserveView, ctokens: bigint): bigint | null {
    if (ctokens === 0n) return 0n;
    const supply = totalSupplySf(reserve);
    return supply === null ? null : collateralValue(ctokens, supply, reserve.mintTotalSupply);
}

/** The reserve's freely available liquidity, `Reserve::freely_available`: 0 where klend could not compute it. */
export function freelyAvailable(reserve: ReserveView): bigint {
    const supply = totalSupplySf(reserve);
    if (supply === null) return 0n;
    const queued = collateralValue(reserve.queuedCollateralAmount, supply, reserve.mintTotalSupply);
    if (queued === null) return 0n;
    return reserve.totalAvailableAmount > queued ? reserve.totalAvailableAmount - queued : 0n;
}

/** `withdrawal_cap_remaining`: what may still leave the reserve at Unix time `now`. */
export function withdrawalCapRemaining(cap: WithdrawalCap, now: bigint): bigint {
    if (cap.intervalLength === 0n) return U64_MAX;
    if (cap.capacity < 0n || cap.intervalStart > now) return 0n;
    const current = now - cap.intervalStart >= cap.intervalLength ? 0n : cap.currentTotal;
    if (current > cap.capacity) return 0n;
    const remaining = cap.capacity - current;
    return remaining > U64_MAX ? U64_MAX : remaining;
}

/** `amount` less KAMINO_RATE_HEADROOM_BPS of it, the headroom rounded up. */
function withRateHeadroom(amount: bigint): bigint {
    return amount - (amount * KAMINO_RATE_HEADROOM_BPS + BPS - 1n) / BPS;
}

/** Whether klend redeems nothing from the reserve: either emergency mode, or a deprecated reserve. */
export function redeemsStopped(kamino: KaminoView): boolean {
    return kamino.lendingMarketEmergency || kamino.reserve.emergencyMode || kamino.reserve.version !== RESERVE_VERSION;
}

/** `Reserve::can_pay_planned`: what a redeem may plan to take for a market holding `ctokens`. */
export function canPayPlanned(kamino: KaminoView, ctokens: bigint): bigint {
    if (redeemsStopped(kamino)) return 0n;
    const supply = totalSupplySf(kamino.reserve);
    if (supply === null) return 0n;
    const own = collateralValue(ctokens, supply, kamino.reserve.mintTotalSupply) ?? U64_MAX;
    const now = kamino.unixTime < 0n ? 0n : kamino.unixTime;
    const free = withRateHeadroom(freelyAvailable(kamino.reserve));
    const cap = withRateHeadroom(withdrawalCapRemaining(kamino.reserve.withdrawalCap, now));
    return [free, cap, own].reduce((low, value) => (value < low ? value : low));
}

export type Band = 'below' | 'within' | 'above';

/** Where the buffer sits in the band, as a share of `L`, both edges inside: `buffer::band`. */
export function band(buffer: bigint, lentTotal: bigint): Band {
    const scaled = buffer * BPS;
    if (scaled < lentTotal * BigInt(BUFFER_MIN_BPS)) return 'below';
    if (scaled > lentTotal * BigInt(BUFFER_MAX_BPS)) return 'above';
    return 'within';
}

/** The target buffer, `floor(L x BUFFER_TARGET_BPS / 10,000)`. */
const target = (lentTotal: bigint) => (lentTotal * BigInt(BUFFER_TARGET_BPS)) / BPS;

/** What `rebalance` moves: a deposit into Kamino or a redeem from it, in the lent mint's base units. */
export type Move = { deposit: bigint } | { redeem: bigint };

/** Why `rebalance` would refuse, by its error's name. */
export type Refusal = 'WithinBand' | 'BelowMinRebalance' | 'KaminoStopped' | 'KaminoDepositsBlocked' | 'Overflow';

/** What `rebalance` would do: the mode afterwards, what it moves, and the `exit_seen_slot` it records. */
export type Decision = { withdrawMode: boolean; planned: Move | null; exitSeenSlot: bigint };

function plan(buffer: bigint, lentTotal: bigint, canPay: bigint, minRebalance: bigint): Move | Refusal {
    const t = target(lentTotal);
    const where = band(buffer, lentTotal);
    if (where === 'within') return 'WithinBand';
    // Above the band B > t; below it B < t (buffer.rs).
    const shortfall = t > buffer ? t - buffer : 0n;
    const amount = where === 'above' ? (buffer > t ? buffer - t : 0n) : shortfall < canPay ? shortfall : canPay;
    if (amount === 0n || amount < minRebalance) return 'BelowMinRebalance';
    return where === 'above' ? { deposit: amount } : { redeem: amount };
}

/** `exposure`: `X = max(V, T)`, where `T = L - target(L)`. */
const exposure = (lentValue: bigint, lentTotal: bigint) => {
    const targetLent = lentTotal - target(lentTotal);
    return lentValue > targetLent ? lentValue : targetLent;
};

/** `next_mode`: in withdraw mode below WITHDRAW_MODE_ENTER x X, out above WITHDRAW_MODE_EXIT x X, as it was between. */
export function nextMode(current: boolean, free: bigint, x: bigint): boolean {
    if (free < WITHDRAW_MODE_ENTER * x) return true;
    if (free > WITHDRAW_MODE_EXIT * x) return false;
    return current;
}

function redeemEverything(lentValue: bigint, canPay: bigint, minRebalance: bigint): Move | Refusal {
    const amount = lentValue < canPay ? lentValue : canPay;
    if (amount === 0n || (amount < minRebalance && amount < lentValue)) return 'BelowMinRebalance';
    return { redeem: amount };
}

type KaminoInputs = { free: bigint; canPay: bigint; stopped: boolean; depositsBlocked: boolean };

function decide(withdrawMode: boolean, buffer: bigint, lentValue: bigint, kamino: KaminoInputs, minRebalance: bigint): Omit<Decision, 'exitSeenSlot'> | Refusal {
    if (kamino.stopped) return 'KaminoStopped';
    const lentTotal = buffer + lentValue;
    if (lentTotal > U64_MAX) return 'Overflow';
    const mode = nextMode(withdrawMode, kamino.free, exposure(lentValue, lentTotal));
    let planned = mode ? redeemEverything(lentValue, kamino.canPay, minRebalance) : plan(buffer, lentTotal, kamino.canPay, minRebalance);
    if (typeof planned === 'object' && 'deposit' in planned && kamino.depositsBlocked) planned = 'KaminoDepositsBlocked';
    if (typeof planned === 'object') return { withdrawMode: mode, planned };
    if (mode !== withdrawMode) return { withdrawMode: mode, planned: null };
    return planned;
}

/**
 * What `rebalance` would do on this market now, or the refusal it would fail with: the program's
 * `decide_with_exit_delay`, on the reserve's stored state.
 */
export function decideRebalance(market: LendingMarket): Decision | Refusal | null {
    const { kamino, minRebalance } = market;
    if (!kamino || minRebalance === null) return null;
    const { withdrawMode, exitSeenSlot, buffer } = market;
    if (redeemsStopped(kamino)) {
        // While Kamino redeems nothing it refuses, except to forget a wait to leave (finding R2-04).
        return exitSeenSlot !== 0n ? { withdrawMode, planned: null, exitSeenSlot: 0n } : 'KaminoStopped';
    }
    const lentValue = lentValueOf(kamino.reserve, market.ctokens);
    if (lentValue === null) return null;
    const lentTotal = buffer + lentValue;
    if (lentTotal > U64_MAX) return 'Overflow';
    const inputs: KaminoInputs = {
        free: freelyAvailable(kamino.reserve),
        canPay: canPayPlanned(kamino, market.ctokens),
        stopped: false,
        depositsBlocked: kamino.reserve.blockCtokenUsage,
    };
    const x = exposure(lentValue, lentTotal);
    const wantsOut = withdrawMode && !nextMode(withdrawMode, inputs.free, x);
    const waited = exitSeenSlot !== 0n && kamino.slot >= exitSeenSlot + WITHDRAW_MODE_EXIT_DELAY_SLOTS;
    if (wantsOut && !waited) {
        const seen = exitSeenSlot === 0n ? (kamino.slot > 1n ? kamino.slot : 1n) : exitSeenSlot;
        const planned = redeemEverything(lentValue, inputs.canPay, minRebalance);
        if (typeof planned === 'object') return { withdrawMode: true, planned, exitSeenSlot: seen };
        return seen !== exitSeenSlot ? { withdrawMode: true, planned: null, exitSeenSlot: seen } : planned;
    }
    const decision = decide(withdrawMode, buffer, lentValue, inputs, minRebalance);
    if (typeof decision === 'object') return { ...decision, exitSeenSlot: 0n };
    return exitSeenSlot !== 0n ? { withdrawMode, planned: null, exitSeenSlot: 0n } : decision;
}

// The jobs ---------------------------------------------------------------------------------------

/** klend's lending market authority, the PDA `["lma", lending_market]`. */
async function lendingMarketAuthority(lendingMarket: Address): Promise<Address> {
    const [authority] = await getProgramDerivedAddress({
        programAddress: KLEND_PROGRAM,
        seeds: [new TextEncoder().encode('lma'), getAddressEncoder().encode(lendingMarket)],
    });
    return authority;
}

/** klend's `refresh_reserve` for the market's reserve, with the oracles its config names and klend's own id where it has none. */
export function refreshReserveInstruction(reserve: Address, lendingMarket: Address, view: ReserveView): Instruction {
    const optional = (account: Address | null) => ({ address: account ?? KLEND_PROGRAM, role: AccountRole.READONLY });
    return {
        programAddress: KLEND_PROGRAM,
        accounts: [
            { address: reserve, role: AccountRole.WRITABLE },
            { address: lendingMarket, role: AccountRole.READONLY },
            optional(view.oracles.pythPrice),
            optional(view.oracles.switchboardPrice),
            optional(view.oracles.switchboardTwap),
            optional(view.oracles.scopePrices),
        ],
        data: REFRESH_RESERVE_DISCRIMINATOR,
    };
}

/** The market's Kamino view, or a thrown error naming what is missing: a due job is built only on a complete one. */
function kaminoOf(market: LendingMarket): KaminoView & { lendingMarket: Address } {
    if (!market.kamino || market.lendingMarket === null) throw new Error(`the Kamino reserve ${market.reserve} of the market could not be read`);
    return { ...market.kamino, lendingMarket: market.lendingMarket };
}

/**
 * Whether klend would refresh the reserve: not while the lending market's emergency mode is on,
 * and not once a write-off has deprecated it.
 */
const refreshable = (kamino: KaminoView) => !kamino.lendingMarketEmergency && kamino.reserve.version === RESERVE_VERSION;

const REBALANCE = 'rebalance';
const REFRESH_RESERVE = 'refresh_reserve';

const rebalance: KeeperJob<LendingMarket> = {
    name: REBALANCE,
    discriminator: REBALANCE_DISCRIMINATOR,
    pass: 'sweep',

    due(market) {
        if (!market.open) return [];
        const decision = decideRebalance(market);
        if (decision === null || typeof decision === 'string') return [];
        const moved = decision.planned === null ? 0n : 'deposit' in decision.planned ? decision.planned.deposit : decision.planned.redeem;
        return [{ job: REBALANCE, key: REBALANCE, owed: moved }];
    },

    async build({ marketState, state, payer }) {
        const kamino = kaminoOf(state);
        const instruction = getRebalanceInstruction({
            caller: payer,
            marketState,
            authority: (await findAuthorityPda({ marketState }))[0],
            bufferVault: state.bufferVault,
            ctokenAccount: state.ctokenAccount,
            lentMint: state.lentMint,
            reserve: state.reserve,
            lendingMarket: kamino.lendingMarket,
            lendingMarketAuthority: await lendingMarketAuthority(kamino.lendingMarket),
            reserveLiquiditySupply: kamino.reserve.liquiditySupply,
            collateralMint: state.collateralMint,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
            klendProgram: KLEND_PROGRAM,
        });
        // klend refuses the refresh while the lending market's emergency mode is on (finding R2F-02),
        // and a deprecated reserve is never brought up to date again; a call while Kamino redeems
        // nothing only forgets a wait to leave withdraw mode, which reads no rate.
        return refreshable(kamino) && !redeemsStopped(kamino) ? [refreshReserveInstruction(state.reserve, kamino.lendingMarket, kamino.reserve), instruction] : [instruction];
    },

    refusals: {
        nothingToDo: [LENDING_AMM_ERROR__WITHIN_BAND, LENDING_AMM_ERROR__BELOW_MIN_REBALANCE, LENDING_AMM_ERROR__KAMINO_STOPPED, LENDING_AMM_ERROR__KAMINO_DEPOSITS_BLOCKED],
        laterSlot: [],
    },
};

/** How old a reserve's last refresh may get before the keeper refreshes it: half of TRADE_MAX_RESERVE_AGE_SLOTS (LENDING-95). */
export const REFRESH_AFTER_SLOTS = TRADE_MAX_RESERVE_AGE_SLOTS / 2n;

const refreshReserve: KeeperJob<LendingMarket> = {
    name: REFRESH_RESERVE,
    discriminator: REFRESH_RESERVE_DISCRIMINATOR,
    pass: 'sweep',

    due(market) {
        const { kamino } = market;
        if (!market.open || market.ctokens === 0n || !kamino || market.lendingMarket === null || !refreshable(kamino)) return [];
        const age = kamino.slot > kamino.reserve.lastUpdateSlot ? kamino.slot - kamino.reserve.lastUpdateSlot : 0n;
        return age > REFRESH_AFTER_SLOTS ? [{ job: REFRESH_RESERVE, key: REFRESH_RESERVE, owed: age }] : [];
    },

    async build({ state }) {
        const kamino = kaminoOf(state);
        return [refreshReserveInstruction(state.reserve, kamino.lendingMarket, kamino.reserve)];
    },

    // klend's own refusals are failures: the job is due only when klend should take it.
    refusals: { nothingToDo: [], laterSlot: [] },
};

/** The clock sysvar's slot and Unix time, or null if `data` is not it. */
function decodeClock(data: Uint8Array | null | undefined): { slot: bigint; unixTime: bigint } | null {
    if (!data || data.length < 40) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.length);
    return { slot: view.getBigUint64(0, true), unixTime: view.getBigInt64(32, true) };
}

/**
 * Reads what the jobs need of the watched accounts: the reserve the market names, in klend's
 * layout and naming the market's collateral mint and the lending market LENT_RESERVES gives it,
 * that lending market, and the clock; null if any is missing or not what it should be.
 */
function kaminoView(reserve: Address, collateralMint: Address, lendingMarket: Address | null, watched: Watched | undefined): KaminoView | null {
    if (!watched || lendingMarket === null) return null;
    const reserveData = watched.get(reserve);
    const marketData = watched.get(lendingMarket);
    const clock = decodeClock(watched.get(CLOCK_SYSVAR));
    if (!reserveData || !marketData || !clock) return null;
    const view = decodeReserve(reserveData);
    const lending = decodeLendingMarket(marketData);
    if (typeof view === 'string' || typeof lending === 'string') return null;
    if (view.lendingMarket !== lendingMarket || view.collateralMint !== collateralMint) return null;
    return { reserve: view, lendingMarketEmergency: lending.emergencyMode, slot: clock.slot, unixTime: clock.unixTime };
}

function decode(data: Uint8Array, watched?: Watched): LendingMarket {
    const state = getLendingAmmMarketDecoder().decode(data);
    const lent = state.lentIndex;
    const other = 1 - lent;
    const row = LENT_RESERVES.find((entry) => entry.reserve === state.reserve);
    const lendingMarket = row?.lendingMarket ?? null;
    return {
        open: (state.reserves[other] ?? 0n) > 0n,
        withdrawMode: state.withdrawMode,
        exitSeenSlot: state.exitSeenSlot,
        lentMint: state.mints[lent]!,
        bufferVault: state.vaults[lent]!,
        ctokenAccount: state.ctokenAccount,
        reserve: state.reserve,
        collateralMint: state.collateralMint,
        buffer: state.reserves[lent]!,
        ctokens: state.ctokens,
        lendingMarket,
        minRebalance: row?.minRebalance ?? null,
        kamino: kaminoView(state.reserve, state.collateralMint, lendingMarket, watched),
    };
}

export const lendingAmm: KeeperProduct<LendingMarket> = {
    name: 'lending-amm',
    programAddress: LENDING_AMM_PROGRAM_ADDRESS,
    isMarket(data) {
        return data.length === getLendingAmmMarketSize() && LENDING_AMM_MARKET_DISCRIMINATOR.every((byte, i) => data[i] === byte);
    },
    watches(data) {
        const state = getLendingAmmMarketDecoder().decode(data);
        const row = LENT_RESERVES.find((entry) => entry.reserve === state.reserve);
        return row ? [state.reserve, row.lendingMarket, CLOCK_SYSVAR] : [state.reserve, CLOCK_SYSVAR];
    },
    decode,
    jobs: [rebalance, refreshReserve],
};
