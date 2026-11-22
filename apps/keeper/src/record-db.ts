// The runner's writer to Aviary's Postgres (docs/spec/keeper-runner.md, "What it records"): each
// recorded pass and its jobs in one transaction, straight to the database DATABASE_URL names, as
// the explainer's approve command writes from the Mac, never through Aviary's public API.
//
// The connection closes after LIMITS.databaseIdleSeconds idle, so it never keeps Neon awake between passes. A
// database that cannot be reached, or that refuses the write, never stops the runner: the pass is
// logged as the log recorder would log it, with the reason, and the runner goes on.

import { createDb, recordKeeperPass } from 'terminal-db';

import type { Logger } from './log.ts';
import type { KeeperPassRecord, Recorder } from './record.ts';
import { LIMITS } from './settings.ts';

/** An error's message with any connection string's password hidden. */
const redacted = (error: unknown) => String((error as Error)?.message ?? error).replace(/(\/\/[^/:@\s]+:)[^@/\s]+@/g, '$1<password>@');

export function databaseRecorder(url: string, log: Logger): Recorder {
    const { db, close } = createDb(url, { idleTimeoutSeconds: LIMITS.databaseIdleSeconds, connectTimeoutSeconds: LIMITS.databaseConnectSeconds });
    return {
        async record(pass: KeeperPassRecord) {
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    recordKeeperPass(db, pass),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error(`no answer in ${LIMITS.databaseWriteMs / 1000} s`)), LIMITS.databaseWriteMs);
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
