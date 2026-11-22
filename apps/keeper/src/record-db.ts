// The runner's writer to Aviary's Postgres (docs/spec/keeper-runner.md, "What it records"): each
// recorded pass and its jobs in one transaction, straight to the database DATABASE_URL names, as
// the explainer's approve command writes from the Mac, never through Aviary's public API.
//
// The connection closes after DB_IDLE_SECONDS idle, so it never keeps Neon awake between passes. A
// database that cannot be reached, or that refuses the write, never stops the runner: the pass is
// logged as the log recorder would log it, with the reason, and the runner goes on.

import { createDb, recordKeeperPass } from 'terminal-db';

import type { Logger } from './log.ts';
import type { KeeperPassRecord, Recorder } from './record.ts';

/** How long an idle connection stays open, and how long connecting and writing a pass may take. */
const DB_IDLE_SECONDS = 20;
const DB_CONNECT_SECONDS = 15;
const DB_WRITE_MS = 30_000;

/** An error's message with any connection string's password hidden. */
const redacted = (error: unknown) => String((error as Error)?.message ?? error).replace(/(\/\/[^/:@\s]+:)[^@/\s]+@/g, '$1<password>@');

export function databaseRecorder(url: string, log: Logger): Recorder {
    const { db, close } = createDb(url, { idleTimeoutSeconds: DB_IDLE_SECONDS, connectTimeoutSeconds: DB_CONNECT_SECONDS });
    return {
        async record(pass: KeeperPassRecord) {
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    recordKeeperPass(db, pass),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error(`no answer in ${DB_WRITE_MS / 1000} s`)), DB_WRITE_MS);
                    }),
                ]);
            } catch (error) {
                log.write({ row: 'record', ...pass, error: `the database could not record this pass: ${redacted(error)}` });
            } finally {
                clearTimeout(timer);
            }
        },
        close,
    };
}
