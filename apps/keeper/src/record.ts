// What the runner records (docs/spec/keeper-runner.md, "What it records"; SUITE-37): a row per pass
// that sent, held or parked something, with a row per such job, in Aviary's Postgres when
// DATABASE_URL is set and as one `record` row in the log when it is not. A pass that did none of
// these records nothing, so Neon can sleep while devnet is quiet.
//
// Recorded: a job whose transaction landed (sent, or landed refused, or landed without effect, each
// with its signature and what it cost), a job held by a cap, a parked job, and whatever ends a
// recorded hold or park: being unparked, any other outcome, or no longer being due at all (so the
// keeper page stops showing it waiting). A job held by the same cap pass after pass is one hold: it
// is recorded once each UTC day, again if another cap holds it, and again once it has been anything
// but held. Errors and warnings are cut to their URLs' hosts, since the page is public.

import type { KeeperJobRecord, KeeperPassRecord } from 'terminal-db/keeper';

import type { Clock } from './clock.ts';
import type { Logger } from './log.ts';
import { utcDay } from './spend.ts';

export type { KeeperJobRecord, KeeperPassRecord };

/** A job row as the runner logs it, with the key that names its unit within its market. */
export type JobRow = {
    key: string;
    market: string | null;
    product: string | null;
    job: string;
    slot: number | null;
    outcome: string;
    signature?: string | null;
    cost?: bigint | null;
    estimate?: bigint | null;
    cap?: string | null;
    error?: string | null;
    attempt?: number | null;
} & Record<string, unknown>;

/**
 * A text fit for Aviary's public page: every URL cut to its scheme and host (a path or query can
 * carry an API key, as Alchemy's and Helius's URLs do) and the whole cut to `max` characters.
 */
export function publicText(text: string, max: number): string {
    const clean = text.replace(/\b(https?|wss?):\/\/([^\s/?#"'<>]+)[^\s"'<>]*/g, '$1://$2');
    return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}

/** The longest error a record keeps. */
const ERROR_MAX = 1000;

/** A job unit the page shows waiting: held by a cap (with the day and cap its hold was recorded for) or parked. */
type Waiting = { market: string | null; product: string | null; job: string; slot: number | null; hold: string | null };

/** The recorded jobs of the pass under way, and the job units recorded as waiting. */
export class PassRecords {
    private jobs: KeeperJobRecord[] = [];
    /** Each job unit recorded as held or parked and not since recorded otherwise, by `market:key`. */
    private readonly waiting = new Map<string, Waiting>();
    private readonly clock: Clock;

    constructor(clock: Clock) {
        this.clock = clock;
    }

    /** Takes note of one job row, keeping it if it is one to record. */
    job(row: JobRow) {
        const unit = `${row.market ?? ''}:${row.key}`;
        const was = this.waiting.get(unit);
        let keep: boolean;
        if (row.outcome === 'held') {
            const hold = `${utcDay(this.clock.now())}:${row.cap ?? ''}`;
            keep = was?.hold !== hold;
            this.waiting.set(unit, { market: row.market, product: row.product, job: row.job, slot: row.slot, hold });
        } else if (row.outcome === 'parked') {
            keep = true;
            this.waiting.set(unit, { market: row.market, product: row.product, job: row.job, slot: row.slot, hold: null });
        } else {
            // A landed transaction is always recorded; anything else only when it ends a wait the page shows.
            keep = Boolean(row.signature) || row.outcome === 'unparked' || was !== undefined;
            this.waiting.delete(unit);
        }
        if (keep) this.push(row);
    }

    /**
     * Records the end of every wait of `job` on `market` whose unit is no longer due, as when
     * another keeper sent it or the market changed, since the runner never looks at that unit again.
     */
    stillDue(market: string, job: string, dueKeys: readonly string[]) {
        const due = new Set(dueKeys.map((key) => `${market}:${key}`));
        for (const [unit, waiting] of this.waiting) {
            if (waiting.market !== market || waiting.job !== job || due.has(unit)) continue;
            this.waiting.delete(unit);
            this.push({ key: unit, ...waiting, outcome: 'no-longer-due' });
        }
    }

    private push(row: JobRow) {
        this.jobs.push({
            at: new Date(this.clock.now()),
            market: row.market,
            product: row.product,
            job: row.job,
            slot: row.slot,
            outcome: row.outcome,
            signature: row.signature ?? null,
            cost: row.cost ?? null,
            estimate: row.estimate ?? null,
            cap: row.cap ?? null,
            error: row.error ? publicText(row.error, ERROR_MAX) : null,
            attempt: row.attempt ?? null,
        });
    }

    /** The pass's recorded jobs so far, emptied for the next pass. */
    take(): KeeperJobRecord[] {
        const jobs = this.jobs;
        this.jobs = [];
        return jobs;
    }
}

export interface Recorder {
    record(pass: KeeperPassRecord): Promise<void>;
    close(): Promise<void>;
}

/** Without DATABASE_URL: each recorded pass is one `record` row in the log, exactly as the database would hold it. */
export function logRecorder(log: Logger): Recorder {
    return {
        async record(pass) {
            log.write({ row: 'record', ...pass });
        },
        async close() {},
    };
}
