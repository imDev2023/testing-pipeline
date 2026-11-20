// What the runner records (docs/spec/keeper-runner.md, "What it records"): a row per pass and a
// row per job it sent, held or parked, plus what it skipped and why. Until Aviary's database
// exists (or without DATABASE_URL) the rows go to the log, one JSON object a line: standard
// output, which launchd sends to ~/Library/Logs/testing-pipeline-keeper.log and Docker keeps.
//
// The keeper wallet's key is never handed to the logger, so no row can carry it.

export type Row = { row: string; at?: string } & Record<string, unknown>;

export interface Logger {
    write(row: Row): void;
}

/** JSON with bigints as decimal strings. */
export function toJson(value: unknown): string {
    return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

export function streamLogger(out: { write(line: string): unknown }, now: () => number): Logger {
    return {
        write(row) {
            out.write(`${toJson({ at: new Date(now()).toISOString(), ...row })}\n`);
        },
    };
}

/** Keeps every row, for tests. */
export class MemoryLogger implements Logger {
    readonly rows: Row[] = [];
    write(row: Row) {
        this.rows.push(row);
    }
    of(kind: string): Row[] {
        return this.rows.filter((row) => row.row === kind);
    }
}
