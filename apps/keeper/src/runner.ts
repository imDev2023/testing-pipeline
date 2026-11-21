// The keeper runner (docs/spec/keeper-runner.md): finds every market of our strategies, learns
// when a keeper job is due from its own socket, a sweep, an hourly and a daily pass and one full
// pass whenever it starts, and sends each due job paid for by the keeper wallet: simulate, check
// the cost against every cap, send, one job at a time. A failed job is retried after each of
// RETRY_DELAYS and then parked until its market's state changes.
//
// What is due, how to build it and which refusals mean "nothing to do" come from
// packages/keeper-jobs; a product added there needs no change here. A job of the hourly pass
// runs at most once every SETTLE_INTERVAL on each market, a restart included: when each last
// ran is learned from the keeper wallet's own transactions, as today's spend is.
//
// Keeper tips land in the keeper wallet's wrapped-SOL account (each job that tips names it);
// once it holds more than TIP_UNWRAP_AT, the end of a pass closes it into the float.

import { address, getBase64Decoder, type Address, type Instruction, type Signature, type TransactionSigner } from '@solana/kit';
import { findAssociatedTokenPda, getCloseAccountInstruction, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { outcomeOf, products as allProducts, type AnyKeeperProduct, type JobUnit, type KeeperJob, type Pass } from 'keeper-jobs';

import { ChainError, type Chain, type LandedTransaction, type Result, type SignedTransaction } from './chain.ts';
import type { Clock, Timer } from './clock.ts';
import type { Logger } from './log.ts';
import { describeSettings, type Settings } from './settings.ts';
import { dayStart, landed, rebuildSpend, spendOf, utcDay, type Spend } from './spend.ts';

/** Which pass is running: `start` and `once` run every job; the others their own jobs. */
export type PassKind = 'start' | 'once' | 'sweep' | 'hourly' | 'daily' | 'transaction';

export type PassSummary = { pass: PassKind; markets: number; sent: number; held: number; parked: number; skipped: number; failed: number };

type Market = { address: Address; product: AnyKeeperProduct; data: Uint8Array };
type AnyJob = KeeperJob<unknown>;

const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
/** Wrapped SOL, the mint of the account keeper tips are paid into. */
const NATIVE_MINT = address('So11111111111111111111111111111111111111112');
const DAY_MS = 86_400_000;

/** The jobs each pass checks (docs/spec/keeper-runner.md, "Triggers"). */
const PASS_JOBS: Record<PassKind, readonly Pass[]> = {
    start: ['sweep', 'hourly', 'daily'],
    once: ['sweep', 'hourly', 'daily'],
    sweep: ['sweep'],
    transaction: ['sweep'],
    hourly: ['hourly'],
    daily: ['daily'],
};

/** ComputeBudget's SetComputeUnitPrice, for a priority fee above 0. */
function computeUnitPrice(microLamports: bigint): Instruction {
    const data = new Uint8Array(9);
    data[0] = 3;
    new DataView(data.buffer).setBigUint64(1, microLamports, true);
    return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

const base64 = getBase64Decoder();
const fingerprint = (data: Uint8Array) => base64.decode(data);

export type RunnerOptions = {
    settings: Settings;
    chain: Chain;
    clock: Clock;
    /** The keeper wallet. */
    wallet: TransactionSigner;
    log: Logger;
    products?: readonly AnyKeeperProduct[];
};

export class Runner {
    private readonly settings: Settings;
    private readonly chain: Chain;
    private readonly clock: Clock;
    private readonly wallet: TransactionSigner;
    private readonly log: Logger;
    private readonly products: readonly AnyKeeperProduct[];

    private readonly markets = new Map<Address, Market>();
    private spend: Spend | null = null;
    /** Failures so far of each job unit (market and unit key), until it succeeds or is parked. */
    private readonly failures = new Map<string, number>();
    private readonly retries = new Map<string, Timer>();
    /** Parked job units, with their market's state when parked. */
    private readonly parked = new Map<string, { state: string; error: string }>();
    /** When hourly jobs ran (ms), each with the accounts of its instruction, its market among them. */
    private runs: { job: AnyJob; accounts: readonly Address[]; at: number }[] = [];
    /** The wrapped-SOL account's data when its close last failed, so it is not tried again until that changes. */
    private unwrapParked: string | null = null;
    private tail: Promise<unknown> = Promise.resolve();
    private readonly timers = new Set<Timer>();
    private readonly unsubscribes: (() => void)[] = [];
    private stopped = false;

    constructor(options: RunnerOptions) {
        this.settings = options.settings;
        this.chain = options.chain;
        this.clock = options.clock;
        this.wallet = options.wallet;
        this.log = options.log;
        this.products = options.products ?? allProducts;
    }

    /** One full pass of every job, then done: `pnpm keeper:once`. */
    async once(): Promise<PassSummary> {
        this.logStart('once');
        return this.exclusive(() => this.pass('once'));
    }

    /** Runs until stopped: a full pass now, then the socket, the sweep and the hourly and daily passes. */
    async start(): Promise<PassSummary> {
        this.logStart('run');
        const first = await this.exclusive(() => this.pass('start'));
        for (const product of this.products) {
            this.unsubscribes.push(
                this.chain.subscribeLogs(product.programAddress, {
                    onSignature: (signature) => this.background(() => this.onTransaction(signature)),
                    onReconnect: () => {
                        this.log.write({ row: 'socket', event: 'reconnected', program: product.programAddress });
                        this.background(() => this.pass('sweep'));
                    },
                    onError: (error) => this.log.write({ row: 'socket', event: 'error', program: product.programAddress, error: String(error) }),
                }),
            );
        }
        this.every(this.settings.sweepIntervalMs, 'sweep');
        this.every(this.settings.settleIntervalMs, 'hourly');
        this.scheduleDaily();
        return first;
    }

    stop() {
        this.stopped = true;
        for (const timer of this.timers) this.clock.clearTimer(timer);
        for (const timer of this.retries.values()) this.clock.clearTimer(timer);
        this.timers.clear();
        this.retries.clear();
        for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    }

    /** Resolves once no work is queued or running. */
    async idle() {
        for (;;) {
            const tail = this.tail;
            await tail;
            if (tail === this.tail) return;
        }
    }

    /** Today's spend as the runner counts it, or null before it has been rebuilt. */
    spentToday(): Spend | null {
        return this.spend;
    }

    // Scheduling -------------------------------------------------------------------------

    private logStart(mode: 'run' | 'once') {
        this.log.write({ row: 'start', mode, wallet: this.wallet.address, settings: describeSettings(this.settings), products: this.products.map((p) => p.name) });
    }

    /** Runs `work` after everything queued before it, so passes and jobs never overlap. */
    private exclusive<T>(work: () => Promise<T>): Promise<T> {
        const run = this.tail.then(() => (this.stopped ? (undefined as T) : work()));
        this.tail = run.catch((error) => this.log.write({ row: 'error', error: String((error as Error)?.stack ?? error) }));
        return run;
    }

    /**
     * Queues work no caller waits for (a timer's, a retry's, the socket's): its failure is
     * logged by `exclusive` and goes no further, so it can never stop the process.
     */
    private background(work: () => Promise<unknown>, then?: () => void) {
        this.exclusive(work)
            .catch(() => {})
            .finally(() => !this.stopped && then?.());
    }

    private every(ms: number, kind: PassKind) {
        const timer = this.clock.setTimer(ms, () => {
            this.timers.delete(timer);
            this.background(() => this.pass(kind), () => this.every(ms, kind));
        });
        this.timers.add(timer);
    }

    /** The next DAILY_PASS_UTC after now. */
    private nextDaily(): number {
        const now = this.clock.now();
        const { hour, minute } = this.settings.dailyPassUtc;
        let at = dayStart(now) + (hour * 60 + minute) * 60_000;
        if (at <= now) at += DAY_MS;
        return at;
    }

    /** Arms the daily pass for `at`; a timer that fires early is armed again for the rest. */
    private scheduleDaily(at = this.nextDaily()) {
        const timer = this.clock.setTimer(at - this.clock.now(), () => {
            this.timers.delete(timer);
            if (this.clock.now() < at) return this.scheduleDaily(at);
            this.background(() => this.pass('daily'), () => this.scheduleDaily());
        });
        this.timers.add(timer);
    }

    // Markets ----------------------------------------------------------------------------

    private productOf(owner: Address, data: Uint8Array): AnyKeeperProduct | undefined {
        return this.products.find((product) => product.programAddress === owner && product.isMarket(data));
    }

    /** Every market of every product, with getProgramAccounts (start, once and each sweep). */
    private async discover(): Promise<string[]> {
        const warnings: string[] = [];
        for (const product of this.products) {
            try {
                for (const { address: account, data } of await this.chain.programAccounts(product.programAddress)) {
                    if (product.isMarket(data)) this.markets.set(account, { address: account, product, data });
                }
            } catch (error) {
                if (!(error instanceof ChainError)) throw error;
                warnings.push(`market discovery for ${product.name} failed, so only known markets were read: ${error.message}`);
            }
        }
        return warnings;
    }

    /** Re-reads the given markets' states; a market that is gone is forgotten. */
    private async refresh(addresses: readonly Address[]) {
        const found = await this.chain.accounts(addresses);
        for (const account of addresses) {
            const current = found.get(account);
            const market = this.markets.get(account);
            if (!market) continue;
            if (!current || !market.product.isMarket(current.data)) this.markets.delete(account);
            else market.data = current.data;
        }
    }

    /** A transaction named one of our programs: learn any new market, and check what it touched. */
    private async onTransaction(signature: Signature) {
        const transaction = await landed(this.chain, signature);
        const unknown = transaction.accountKeys.filter((key) => !this.markets.has(key));
        if (unknown.length > 0) {
            for (const [account, found] of await this.chain.accounts(unknown)) {
                const product = found && this.productOf(found.owner, found.data);
                if (found && product) {
                    this.markets.set(account, { address: account, product, data: found.data });
                    this.log.write({ row: 'market', event: 'found', market: account, product: product.name, signature });
                }
            }
        }
        const touched = transaction.accountKeys.filter((key) => this.markets.has(key));
        if (touched.length > 0) await this.pass('transaction', touched);
    }

    // Passes -----------------------------------------------------------------------------

    private async pass(kind: PassKind, only?: readonly Address[]): Promise<PassSummary> {
        const summary: PassSummary = { pass: kind, markets: 0, sent: 0, held: 0, parked: 0, skipped: 0, failed: 0 };
        const warnings: string[] = [];
        try {
            if (kind === 'start' || kind === 'once' || kind === 'sweep') warnings.push(...(await this.discover()));
            const addresses = only ?? [...this.markets.keys()];
            await this.refresh(addresses);
            if (this.spend === null || this.spend.day !== utcDay(this.clock.now())) {
                // Rebuilt after the markets are known, so each transaction is put to its market;
                // looking back SETTLE_INTERVAL too, for when each hourly job last ran.
                const { spend, transactions } = await rebuildSpend(this.chain, this.wallet.address, this.clock.now(), (key) => this.markets.has(key), this.settings.settleIntervalMs);
                this.spend = spend;
                this.learnRuns(transactions);
                this.log.write({ row: 'spend', event: 'rebuilt', spend: this.spend });
            }
            const passes = PASS_JOBS[kind];
            for (const account of addresses) {
                const market = this.markets.get(account);
                if (!market) continue;
                summary.markets++;
                for (const job of market.product.jobs as readonly AnyJob[]) {
                    if (!passes.includes(job.pass)) continue;
                    for (const unit of job.due(market.product.decode(market.data))) await this.runUnit(market, job, unit, summary);
                }
            }
            await this.unwrapTips(warnings);
        } catch (error) {
            if (!(error instanceof ChainError)) throw error;
            // Nothing is sent without knowing today's spend; the next pass tries again.
            warnings.push(`the pass stopped early, the chain could not be asked: ${error.message}`);
        }
        let balance: bigint | null = null;
        try {
            balance = await this.chain.balance(this.wallet.address);
            if (balance < this.settings.lowBalance) warnings.push(`low balance: the keeper wallet holds less than LOW_BALANCE; top it up with devnet-airdrop`);
        } catch (error) {
            if (!(error instanceof ChainError)) throw error;
            warnings.push(`the balance could not be read: ${error.message}`);
        }
        this.log.write({
            row: 'pass',
            ...summary,
            balance,
            spend: this.spend,
            caps: { maxTxCost: this.settings.maxTxCost, marketDailyCap: this.settings.marketDailyCap, dailyCap: this.settings.dailyCap, minBalance: this.settings.minBalance },
            settings: describeSettings(this.settings),
            warnings,
        });
        return summary;
    }

    // Jobs -------------------------------------------------------------------------------

    private jobRow(market: Market, unit: JobUnit, outcome: string, fields: Record<string, unknown> = {}) {
        this.log.write({ row: 'job', market: market.address, product: market.product.name, job: unit.job, slot: unit.slot ?? null, owed: unit.owed ?? null, outcome, ...fields });
    }

    /** Checks one due unit and, if every check passes, sends it. */
    private async runUnit(market: Market, job: AnyJob, unit: JobUnit, summary: PassSummary, fromRetry = false) {
        const key = `${market.address}:${unit.key}`;
        if (this.retries.has(key) && !fromRetry) {
            summary.skipped++;
            return;
        }
        if (job.pass === 'hourly') {
            const last = this.lastRun(market.address, job);
            if (last !== null && this.clock.now() - last < this.settings.settleIntervalMs) {
                this.jobRow(market, unit, 'not-yet', { lastRan: new Date(last).toISOString(), reason: 'it ran on this market less than SETTLE_INTERVAL ago' });
                summary.skipped++;
                return;
            }
        }
        const park = this.parked.get(key);
        if (park) {
            if (park.state === fingerprint(market.data)) {
                summary.parked++;
                return;
            }
            this.parked.delete(key);
            this.jobRow(market, unit, 'unparked', { reason: "the market's state changed" });
        }
        try {
            await this.attempt(market, job, unit, key, summary);
        } catch (error) {
            if (error instanceof ChainError) {
                // Not the job's failure: it is due again in the next pass.
                this.jobRow(market, unit, 'chain-error', { error: error.message });
                summary.skipped++;
                return;
            }
            this.failed(market, job, unit, key, String((error as Error)?.message ?? error), summary);
        }
    }

    private async attempt(market: Market, job: AnyJob, unit: JobUnit, key: string, summary: PassSummary) {
        // Due on the state just read, never on an older one.
        await this.refresh([market.address]);
        if (!this.markets.has(market.address)) return;
        const current = job.due(market.product.decode(market.data)).find((due) => due.key === unit.key);
        if (!current) {
            this.failures.delete(key);
            this.jobRow(market, unit, 'nothing-to-do', { reason: 'no longer due' });
            summary.skipped++;
            return;
        }
        const input = { rpc: this.chain.rpc, marketState: market.address, state: market.product.decode(market.data), unit: current, payer: this.wallet };
        const skip = (await job.skipReason?.(input)) ?? null;
        if (skip !== null) {
            this.failures.delete(key);
            this.jobRow(market, current, 'nothing-to-do', { reason: skip });
            summary.skipped++;
            return;
        }
        const balance = await this.chain.balance(this.wallet.address);
        if (balance < this.settings.minBalance) return this.hold(market, current, 'MIN_BALANCE', { balance, limit: this.settings.minBalance }, summary);

        const transaction = await this.chain.prepare(this.wallet, this.withPriority(await job.build(input)));
        const simulation = await this.chain.simulate(transaction, this.wallet.address);
        if (this.settled(market, job, current, key, simulation, summary, null)) return;

        // The fee and the rent of anything the job creates: what the simulation took from the wallet.
        const estimate = balance > simulation.payerLamportsAfter ? balance - simulation.payerLamportsAfter : 0n;
        const spend = this.spend;
        if (spend === null) throw new ChainError("today's spend is unknown until it is rebuilt from the chain");
        if (estimate > this.settings.maxTxCost) return this.hold(market, current, 'MAX_TX_COST', { estimate, limit: this.settings.maxTxCost }, summary);
        if (spend.of(market.address) + estimate > this.settings.marketDailyCap) {
            return this.hold(market, current, 'MARKET_DAILY_CAP', { estimate, spent: spend.of(market.address), limit: this.settings.marketDailyCap }, summary);
        }
        if (spend.total + estimate > this.settings.dailyCap) return this.hold(market, current, 'DAILY_CAP', { estimate, spent: spend.total, limit: this.settings.dailyCap }, summary);

        await this.send(market, job, current, key, transaction, estimate, summary);
    }

    private async send(market: Market, job: AnyJob, unit: JobUnit, key: string, transaction: SignedTransaction, estimate: bigint, summary: PassSummary) {
        let result;
        try {
            await this.chain.sendAndConfirm(transaction);
            result = await landed(this.chain, transaction.signature);
        } catch (error) {
            // Sent, but whether it landed (and what it cost) is unknown: today's spend is
            // rebuilt from the chain before anything else is sent, so a cap is never undercounted.
            this.spend = null;
            throw error;
        }
        const cost = spendOf(result, this.wallet.address);
        this.spend!.add(result.accountKeys, cost);
        if (this.settled(market, job, unit, key, result, summary, { signature: transaction.signature, cost })) return;
        if (job.pass === 'hourly') this.runs.push({ job, accounts: [market.address], at: this.clock.now() });
        this.failures.delete(key);
        this.jobRow(market, unit, 'sent', { signature: transaction.signature, cost, estimate });
        summary.sent++;
    }

    /**
     * Acts on a simulation, or a landed transaction's result, that did not plainly succeed:
     * a skip, a retry from a later slot, or a failure. Returns whether it acted.
     */
    private settled(market: Market, job: AnyJob, unit: JobUnit, key: string, result: Result, summary: PassSummary, sent: { signature: Signature; cost: bigint } | null): boolean {
        const outcome = outcomeOf(job, result);
        if (outcome === 'send') return false;
        if (outcome === 'nothing-to-do') {
            this.failures.delete(key);
            this.jobRow(market, unit, 'nothing-to-do', { reason: sent ? 'landed without effect' : 'refused in simulation', ...(sent ?? {}), error: result.error });
            summary.skipped++;
        } else if (outcome === 'later-slot') {
            this.jobRow(market, unit, 'later-slot', { ...(sent ?? {}), error: result.error });
            summary.skipped++;
            this.background(() => this.laterSlot(market.address, job, unit));
        } else {
            this.failed(market, job, unit, key, result.error ?? 'failed', summary, sent);
        }
        return true;
    }

    /** Sends a "try again in a later slot" refusal again, once the chain has moved a slot on. */
    private async laterSlot(account: Address, job: AnyJob, unit: JobUnit) {
        const market = this.markets.get(account);
        if (!market) return;
        // About one slot of real time: the chain's own pace, not the runner's clock.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const summary: PassSummary = { pass: 'transaction', markets: 1, sent: 0, held: 0, parked: 0, skipped: 0, failed: 0 };
        await this.runUnit(market, job, unit, summary, true);
    }

    private withPriority(instructions: Instruction[]): Instruction[] {
        const priority = this.settings.priorityFeeMicrolamports;
        return priority > 0n ? [computeUnitPrice(priority), ...instructions] : instructions;
    }

    /** When `job` last ran on `market`, as this runner sent it or the keeper wallet's transactions show, or null. */
    private lastRun(market: Address, job: AnyJob): number | null {
        let last: number | null = null;
        for (const run of this.runs) if (run.job === job && run.accounts.includes(market) && (last === null || run.at > last)) last = run.at;
        return last;
    }

    /** Learns when each hourly job ran from the keeper wallet's successful transactions. */
    private learnRuns(transactions: readonly LandedTransaction[]) {
        const since = this.clock.now() - this.settings.settleIntervalMs;
        this.runs = this.runs.filter((run) => run.at >= since);
        for (const transaction of transactions) {
            if (transaction.failed || transaction.blockTime === null) continue;
            for (const instruction of transaction.instructions) {
                const product = this.products.find((candidate) => candidate.programAddress === instruction.programAddress);
                const job = (product?.jobs as readonly AnyJob[] | undefined)?.find(
                    (candidate) => candidate.pass === 'hourly' && candidate.discriminator.every((byte, i) => instruction.data[i] === byte),
                );
                if (job) this.runs.push({ job, accounts: instruction.accounts, at: transaction.blockTime * 1000 });
            }
        }
    }

    /**
     * Closes the keeper wallet's wrapped-SOL account into the float once it holds more than
     * TIP_UNWRAP_AT; the next job that tips makes it again. It returns far more than its fee,
     * so no cap or MIN_BALANCE holds it, but its fee counts in today's spend (SUITE-55), so it
     * waits while today's spend is unknown. A close that fails is parked until the account
     * changes, as a job is parked until its market does; a chain that cannot be asked is
     * warned about and tried again in the next pass.
     */
    private async unwrapTips(warnings: string[]) {
        if (this.spend === null) return;
        const [account] = await findAssociatedTokenPda({ owner: this.wallet.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        try {
            const found = (await this.chain.accounts([account])).get(account);
            if (!found || found.owner !== TOKEN_PROGRAM_ADDRESS) return;
            const tips = getTokenDecoder().decode(found.data).amount;
            if (tips <= this.settings.tipUnwrapAt) return;
            if (this.unwrapParked === fingerprint(found.data)) return;
            const transaction = await this.chain.prepare(this.wallet, this.withPriority([getCloseAccountInstruction({ account, destination: this.wallet.address, owner: this.wallet })]));
            const simulation = await this.chain.simulate(transaction, this.wallet.address);
            if (simulation.failed) return this.unwrapFailed(warnings, found.data, { account, tips, error: simulation.error });
            let result;
            try {
                await this.chain.sendAndConfirm(transaction);
                result = await landed(this.chain, transaction.signature);
            } catch (error) {
                // Whether it landed is unknown: today's spend is rebuilt before anything else is sent.
                this.spend = null;
                throw error;
            }
            const cost = spendOf(result, this.wallet.address);
            this.spend?.add(result.accountKeys, cost);
            if (result.failed) return this.unwrapFailed(warnings, found.data, { account, tips, signature: transaction.signature, cost, error: result.error });
            this.unwrapParked = null;
            this.log.write({ row: 'unwrap', outcome: 'sent', account, tips, signature: transaction.signature, cost });
        } catch (error) {
            if (!(error instanceof ChainError)) throw error;
            warnings.push(`the tips could not be unwrapped, the chain could not be asked: ${error.message}`);
            this.log.write({ row: 'unwrap', outcome: 'chain-error', account, error: error.message });
        }
    }

    private unwrapFailed(warnings: string[], data: Uint8Array, fields: { account: Address; tips: bigint; error: string | null; signature?: Signature; cost?: bigint }) {
        this.unwrapParked = fingerprint(data);
        warnings.push(`the tips could not be unwrapped, so the unwrap waits until the account changes: ${fields.error}`);
        this.log.write({ row: 'unwrap', outcome: 'parked', ...fields });
    }

    private hold(market: Market, unit: JobUnit, cap: string, fields: Record<string, unknown>, summary: PassSummary) {
        this.jobRow(market, unit, 'held', { cap, ...fields });
        summary.held++;
    }

    private failed(market: Market, job: AnyJob, unit: JobUnit, key: string, error: string, summary: PassSummary, sent: { signature: Signature; cost: bigint } | null = null) {
        summary.failed++;
        const failures = (this.failures.get(key) ?? 0) + 1;
        const delays = this.settings.retryDelaysMs;
        if (failures <= delays.length) {
            this.failures.set(key, failures);
            const delay = delays[failures - 1]!;
            this.jobRow(market, unit, 'failed', { attempt: failures, retryInMs: delay, error, ...(sent ?? {}) });
            const timer = this.clock.setTimer(delay, () => {
                this.retries.delete(key);
                this.background(async () => {
                    const current = this.markets.get(market.address);
                    if (!current) return;
                    const retry: PassSummary = { pass: 'transaction', markets: 1, sent: 0, held: 0, parked: 0, skipped: 0, failed: 0 };
                    await this.runUnit(current, job, unit, retry, true);
                });
            });
            this.retries.set(key, timer);
            return;
        }
        this.failures.delete(key);
        this.parked.set(key, { state: fingerprint(market.data), error });
        this.jobRow(market, unit, 'parked', { attempt: failures, error, ...(sent ?? {}) });
    }
}
