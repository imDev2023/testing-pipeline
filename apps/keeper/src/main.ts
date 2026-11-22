// The keeper runner's entry point (docs/spec/keeper-runner.md, "Running it"):
//
//   keeper run      runs until stopped: what the launchd agent and the Docker image run
//   keeper once     one full pass of every job, then exits (`pnpm keeper:once`)
//   keeper status   the keeper wallet's balance, today's spend and the last pass (`pnpm keeper:status`)
//
// Settings come from the environment (src/settings.ts); the key from the file KEEPER_KEYPAIR names.

import { existsSync, readFileSync } from 'node:fs';

import { products } from 'keeper-jobs';

import { LOG_FILE } from './agent.ts';
import { ChainError, rpcChain } from './chain.ts';
import { systemClock } from './clock.ts';
import { heartbeatSender } from './heartbeat.ts';
import { loadKeypair } from './keypair.ts';
import { streamLogger, toJson, type Logger } from './log.ts';
import { logRecorder } from './record.ts';
import { databaseRecorder } from './record-db.ts';
import { Runner } from './runner.ts';
import { describeSettings, loadSettings } from './settings.ts';
import { rebuildSpend } from './spend.ts';

/** How long a stopping runner waits for a record or a heartbeat on its way. */
const STOP_WAIT_MS = 5_000;

async function main(command: string | undefined) {
    if (command !== 'run' && command !== 'once' && command !== 'status') {
        console.error('usage: keeper run | once | status');
        process.exit(2);
    }
    const settings = loadSettings();
    const log: Logger = streamLogger(process.stdout, systemClock.now);
    const { signer, warnings } = await loadKeypair(settings.keypair);
    for (const warning of warnings) log.write({ row: 'warning', warning });
    const chain = rpcChain(settings);

    if (command === 'status') {
        const markets = new Set<string>();
        for (const product of products) {
            for (const { address, data } of await chain.programAccounts(product.programAddress)) if (product.isMarket(data)) markets.add(address);
        }
        const { spend } = await rebuildSpend(chain, signer.address, systemClock.now(), (account) => markets.has(account));
        const lastPass = lastPassRow();
        console.log(
            toJson(
                {
                    wallet: signer.address,
                    balance: `${Number(await chain.balance(signer.address)) / 1e9} SOL`,
                    markets: markets.size,
                    spend,
                    caps: { MARKET_DAILY_CAP: describeSettings(settings).MARKET_DAILY_CAP, DAILY_CAP: describeSettings(settings).DAILY_CAP },
                    lastPass: lastPass ?? `no pass in ${LOG_FILE}`,
                },
            ),
        );
        return;
    }

    // Recorded passes go to Aviary's database when DATABASE_URL is set, else to the log (SUITE-37).
    const recorder = settings.databaseUrl !== null ? databaseRecorder(settings.databaseUrl, log) : logRecorder(log);
    const heartbeat = settings.heartbeatUrl !== null ? heartbeatSender({ url: settings.heartbeatUrl, signer, log }) : null;
    const runner = new Runner({ settings, chain, clock: systemClock, wallet: signer, log, recorder, heartbeat });
    /** Lets queued work, a record being written and a heartbeat on its way finish, for at most a few seconds. */
    const finish = async () => {
        await Promise.race([runner.idle(), new Promise((done) => setTimeout(done, STOP_WAIT_MS))]);
        await recorder.close();
    };
    if (command === 'once') {
        await runner.once();
        await finish();
        process.exit(0);
    }
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            log.write({ row: 'stop', signal });
            runner.stop();
            void finish().finally(() => process.exit(0));
        });
    }
    await runner.start();
}

/** The last pass row in the Mac's log file, if there is one. */
function lastPassRow(): unknown {
    if (!existsSync(LOG_FILE)) return null;
    const lines = readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').reverse();
    for (const line of lines) {
        try {
            const row = JSON.parse(line);
            if (row.row === 'pass') {
                delete row.settings;
                return row;
            }
        } catch {
            // Not a row: skip it.
        }
    }
    return null;
}

main(process.argv[2]).catch((error) => {
    // The message names what failed; a stack would add nothing a user can act on for a chain error.
    console.error(error instanceof ChainError ? `keeper: ${error.message}` : error);
    process.exit(1);
});
