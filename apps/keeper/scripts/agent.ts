// Installs, removes and describes the keeper's launchd agent on the owner's Mac:
//
//   node apps/keeper/scripts/agent.ts install     pnpm keeper:install: builds the runner, writes the agent and loads it
//   node apps/keeper/scripts/agent.ts uninstall   pnpm keeper:uninstall: unloads the agent and deletes it
//   node apps/keeper/scripts/agent.ts state       whether launchd has the agent, and its process

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LABEL, LOG_FILE, PLIST_FILE, plist } from '../src/agent.ts';

const repo = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
const domain = `gui/${process.getuid!()}`;

/** launchctl, quietly; returns whether it succeeded. */
const launchctl = (...args: string[]) => spawnSync('launchctl', args, { stdio: 'ignore' }).status === 0;

function loaded(): boolean {
    return launchctl('print', `${domain}/${LABEL}`);
}

const command = process.argv[2];
if (process.platform !== 'darwin') {
    console.error('the launchd agent is for macOS; elsewhere run the Docker image (apps/keeper/README.md)');
    process.exit(1);
}
if (command === 'install') {
    execFileSync('pnpm', ['--filter', 'keeper', 'build'], { cwd: repo, stdio: 'inherit' });
    mkdirSync(dirname(PLIST_FILE), { recursive: true });
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    if (loaded()) launchctl('bootout', `${domain}/${LABEL}`);
    writeFileSync(PLIST_FILE, plist(repo));
    if (!launchctl('bootstrap', domain, PLIST_FILE)) {
        console.error(`launchctl bootstrap ${domain} ${PLIST_FILE} failed`);
        process.exit(1);
    }
    console.log(`loaded ${LABEL} from ${PLIST_FILE}; its log is ${LOG_FILE}`);
} else if (command === 'uninstall') {
    if (loaded()) launchctl('bootout', `${domain}/${LABEL}`);
    if (existsSync(PLIST_FILE)) rmSync(PLIST_FILE);
    console.log(`${LABEL} is unloaded and ${PLIST_FILE} removed; the log stays at ${LOG_FILE}`);
} else if (command === 'state') {
    if (!loaded()) {
        console.log(`${LABEL} is not loaded`);
    } else {
        const printed = execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { encoding: 'utf8' });
        const field = (name: string) => new RegExp(`^\\s*${name} = (.*)$`, 'm').exec(printed)?.[1] ?? 'unknown';
        console.log(`${LABEL}: ${field('state')}, pid ${field('pid')}, last exit ${field('last exit code')}`);
    }
} else {
    console.error('usage: agent.ts install | uninstall | state');
    process.exit(2);
}
