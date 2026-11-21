// What the runner has spent today, per market and in all (docs/spec/keeper-runner.md,
// "Spending caps"). It is never stored: whenever the runner starts, and when a UTC day begins,
// it is rebuilt from the keeper wallet's own transactions since 00:00 UTC, so a restart can
// never reset a cap. That holds because the keeper wallet is used by the runner alone.
//
// A transaction's spend is what left the wallet: its balance change, and at least the fee, so
// a transaction that brings lamports back (unwrapping tips) still counts its fee and never
// counts net of tips. A send is counted with the same function once it lands, so the spend
// the runner tracks and the spend a restart rebuilds are the same sum.

import { setTimeout as sleep } from 'node:timers/promises';

import type { Address, Signature } from '@solana/kit';

import { ChainError, type Chain, type LandedTransaction } from './chain.ts';

const DAY_MS = 86_400_000;

/** 00:00 UTC of the day `ms` falls in. */
export const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
export const utcDay = (ms: number) => new Date(dayStart(ms)).toISOString().slice(0, 10);

/** What a landed transaction cost the keeper wallet: nothing unless it paid the fee. */
export function spendOf(transaction: LandedTransaction, keeper: Address): bigint {
    if (transaction.feePayer !== keeper) return 0n;
    const out = transaction.payerLamportsBefore - transaction.payerLamportsAfter;
    return out > transaction.fee ? out : transaction.fee;
}

/**
 * Today's spend. Each transaction keeps its accounts, so it is put to its market (the first of
 * its accounts that is a known market) whenever asked: a market found after the rebuild, as
 * when discovery failed at start, still gets its share and a restart never resets its cap.
 */
export class Spend {
    readonly day: string;
    private readonly isMarket: (address: Address) => boolean;
    private readonly entries: { accounts: readonly Address[]; amount: bigint }[] = [];

    constructor(day: string, isMarket: (address: Address) => boolean) {
        this.day = day;
        this.isMarket = isMarket;
    }

    add(accounts: readonly Address[], amount: bigint) {
        this.entries.push({ accounts, amount });
    }

    get total(): bigint {
        return this.entries.reduce((sum, entry) => sum + entry.amount, 0n);
    }

    /** What was spent today on `market`. */
    of(market: Address): bigint {
        return this.entries.reduce((sum, entry) => (entry.accounts.find(this.isMarket) === market ? sum + entry.amount : sum), 0n);
    }

    byMarket(): Map<Address, bigint> {
        const found = new Map<Address, bigint>();
        for (const { accounts, amount } of this.entries) {
            const market = accounts.find(this.isMarket);
            if (market !== undefined) found.set(market, (found.get(market) ?? 0n) + amount);
        }
        return found;
    }

    toJSON() {
        return { day: this.day, total: this.total, byMarket: Object.fromEntries(this.byMarket()) };
    }
}

/** A landed transaction, asking again while the node has its signature but not yet its details. */
export async function landed(chain: Chain, signature: Signature): Promise<LandedTransaction> {
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            const transaction = await chain.transaction(signature);
            if (transaction !== null) return transaction;
        } catch (error) {
            // A passing transport error: ask again, until the attempts run out.
            if (!(error instanceof ChainError)) throw error;
        }
        await sleep(500);
    }
    throw new ChainError(`the node has no details of ${signature} after 10 s`);
}

/** Today's spend, from the keeper wallet's transactions since 00:00 UTC of `nowMs`. */
export async function rebuildSpend(chain: Chain, keeper: Address, nowMs: number, isMarket: (address: Address) => boolean): Promise<Spend> {
    const spend = new Spend(utcDay(nowMs), isMarket);
    const since = dayStart(nowMs) / 1000;
    for (const signature of await chain.signaturesSince(keeper, since)) {
        // A missing transaction would undercount, so a rebuild that cannot read one fails.
        const transaction = await landed(chain, signature);
        if (transaction.blockTime !== null && transaction.blockTime < since) continue;
        spend.add(transaction.accountKeys, spendOf(transaction, keeper));
    }
    return spend;
}
