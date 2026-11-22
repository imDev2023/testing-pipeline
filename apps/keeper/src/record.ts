// What the runner records (docs/spec/keeper-runner.md, "What it records"; SUITE-37): a row per pass
// that sent, held or parked something, with a row per such job, in Aviary's Postgres when
// DATABASE_URL is set and as one `record` row in the log when it is not. A pass that did none of
// these records nothing, so Neon can sleep while devnet is quiet.
//
// Recorded: a job whose transaction landed (sent, or landed refused, or landed without effect, each
// with its signature and what it cost), a job held by a cap, a parked job, and a job unparked
// because its market changed (so the keeper page stops showing the park). A job held by the same
// cap pass after pass is one hold: it is recorded once each UTC day, again if another cap holds it,
// and again once it has been anything but held.

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

const ALWAYS_RECORDED = new Set(['parked', 'unparked']);

/** The recorded jobs of the pass under way, and the holds already recorded. */
export class PassRecords {
    private jobs: KeeperJobRecord[] = [];
    /** Each job unit held now, by `market:key`, with the day and cap its hold was recorded for. */
    private readonly holds = new Map<string, string>();

    private readonly clock: Clock;

    constructor(clock: Clock) {
        this.clock = clock;
    }

    /** Takes note of one job row, keeping it if it is one to record. */
    job(row: JobRow) {
        const unit = `${row.market ?? ''}:${row.key}`;
        let keep: boolean;
        if (row.outcome === 'held') {
            const hold = `${utcDay(this.clock.now())}:${row.cap ?? ''}`;
            keep = this.holds.get(unit) !== hold;
            this.holds.set(unit, hold);
        } else {
            this.holds.delete(unit);
            keep = Boolean(row.signature) || ALWAYS_RECORDED.has(row.outcome);
        }
        if (!keep) return;
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
            error: row.error ?? null,
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
