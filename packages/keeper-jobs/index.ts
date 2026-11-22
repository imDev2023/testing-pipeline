// Every keeper job of our strategies, in one place (docs/spec/keeper-runner.md, "One
// definition of due"): for each product, how to recognise and read its market state, and for
// each job its due rule as a pure function of that state, its instruction builder and the
// refusals that mean "nothing to do" or "try again in a later slot".
//
// The keeper runner and Aviary's panels both read this, so a button shows in Aviary exactly
// when the runner would act. A product adds its entry to `products`; the runner does not
// change.

import type { Address, GetAccountInfoApi, Instruction, ReadonlyUint8Array, Rpc, TransactionSigner } from '@solana/kit';

import { buyWallAmm } from './buy-wall-amm.ts';
import { taxAmm } from './tax-amm.ts';

/** When the runner checks a job: after each transaction and in every sweep, hourly, or daily. */
export type Pass = 'sweep' | 'hourly' | 'daily';

/** One thing a job would do on one market: a whole job, or one slot of it. */
export type JobUnit = {
    /** The job's name, as its instruction is called. */
    job: string;
    /** Names this unit within its market, for retries and parking: `distribute:4`. */
    key: string;
    /** The slot, for jobs sent once per slot. */
    slot?: number;
    /** What the unit would move, in the market's own units, for logs and panels. */
    owed?: bigint;
};

export type BuildInput<State> = {
    /** Reads the accounts a builder needs beyond the market state, such as a mint's token program. */
    rpc: Rpc<GetAccountInfoApi>;
    marketState: Address;
    state: State;
    unit: JobUnit;
    /** Signs and pays: the keeper wallet, or the viewer's wallet in Aviary. */
    payer: TransactionSigner;
};

export type KeeperJob<State> = {
    name: string;
    pass: Pass;
    /**
     * The first bytes of the job's own instruction's data, so the runner can tell, from the
     * keeper wallet's past transactions, when the job last ran on each market.
     */
    discriminator: ReadonlyUint8Array;
    /** What is due on a market in this state, in the order it should be sent. */
    due(state: State): JobUnit[];
    /** The instructions of one unit's transaction. */
    build(input: BuildInput<State>): Promise<Instruction[]>;
    /**
     * Why sending a due unit now would not be worth it, or null to send it: the runner skips it
     * at no cost and checks again in its next pass. A payout into an account it would create
     * waits until what it pays is worth that account's rent.
     */
    skipReason?(input: BuildInput<State>): Promise<string | null>;
    /** The program's custom error codes that mean nothing to do, and try again in a later slot. */
    refusals: { nothingToDo: readonly number[]; laterSlot: readonly number[] };
    /**
     * For a job whose program succeeds without effect rather than refusing when there is
     * nothing to do: whether a successful simulation's logs show it did nothing.
     */
    didNothing?(logs: readonly string[]): boolean;
};

export type KeeperProduct<State> = {
    name: string;
    programAddress: Address;
    /** Whether an account of the program is one of its market states. */
    isMarket(data: Uint8Array): boolean;
    decode(data: Uint8Array): State;
    jobs: readonly KeeperJob<State>[];
};

// Each entry keeps its own state type; the runner only passes a product's state back to it.
export type AnyKeeperProduct = KeeperProduct<any>;

export const products: readonly AnyKeeperProduct[] = [taxAmm, buyWallAmm];

/** What a simulation of a job's transaction means for the runner. */
export type SimulationOutcome = 'send' | 'nothing-to-do' | 'later-slot' | 'failure';

/**
 * Reads a simulation, or a landed transaction's result: `customError` is the program's custom
 * error code when it refused with one, `failed` whether it failed at all.
 */
export function outcomeOf(
    job: KeeperJob<unknown>,
    result: { failed: boolean; customError: number | null; logs: readonly string[] },
): SimulationOutcome {
    if (result.failed) {
        if (result.customError !== null && job.refusals.nothingToDo.includes(result.customError)) return 'nothing-to-do';
        if (result.customError !== null && job.refusals.laterSlot.includes(result.customError)) return 'later-slot';
        return 'failure';
    }
    if (job.didNothing?.(result.logs)) return 'nothing-to-do';
    return 'send';
}

export { buyWallAmm, buyWallAmmWith, converted, type BuyWallMarket } from './buy-wall-amm.ts';
export { taxAmm };
