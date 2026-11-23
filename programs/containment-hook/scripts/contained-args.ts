// How `contained.ts` reads its command line: a subcommand, `list`, `trade` or `unlock`, then
// its flags (docs/toolchain.md, "Containment hook").

import { parseArgs } from 'node:util';

import { isAddress } from '@solana/kit';

import { UsageError } from './args.ts';
import { clusterUrl, type Cluster } from './chain.ts';

const U64_MAX = 2n ** 64n - 1n;

export const USAGE = [
    'Usage: node contained.ts list --cluster <localnet|devnet|URL> [--record <file.json>]',
    '       node contained.ts trade --cluster <localnet|devnet|URL> --mint <contained mint> --wallet <keypair.json> --buy <quote-mint base units> [--record <file.json>]',
    '       node contained.ts unlock --cluster <localnet|devnet|URL> --mint <contained mint> --payer <keypair.json> [--record <file.json>]',
].join('\n');

/** What one run of `contained.ts` is asked to do. */
export type ContainedCommand =
    | { command: 'list'; cluster: Cluster; record?: string }
    | { command: 'trade'; cluster: Cluster; record?: string; mint: string; wallet: string; buy: bigint }
    | { command: 'unlock'; cluster: Cluster; record?: string; mint: string; payer: string };

/** The flags each subcommand takes, beside `--cluster` and `--record`, which every one takes. */
const FLAGS = { list: [], trade: ['mint', 'wallet', 'buy'], unlock: ['mint', 'payer'] } as const;

function usage(message: string): never {
    throw new UsageError(message);
}

function isCommand(name: string | undefined): name is keyof typeof FLAGS {
    return name !== undefined && Object.hasOwn(FLAGS, name);
}

/** The subcommand and its flags from `argv` (without node and the script); throws `UsageError`. */
export function parseContainedArgs(argv: string[]): ContainedCommand {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            options: {
                cluster: { type: 'string' },
                record: { type: 'string' },
                mint: { type: 'string' },
                wallet: { type: 'string' },
                buy: { type: 'string' },
                payer: { type: 'string' },
            },
            allowPositionals: true,
            strict: true,
        });
    } catch (error) {
        // node:util's own message for an unknown flag or a flag without its value.
        usage(error instanceof Error ? error.message : String(error));
    }
    const { values, positionals } = parsed;
    const [command, ...rest] = positionals;
    if (!isCommand(command)) usage(command === undefined ? 'give a subcommand: list, trade or unlock' : `the subcommand must be list, trade or unlock, not "${command}"`);
    if (rest.length > 0) usage(`${command} takes no other arguments, not "${rest.join(' ')}"`);
    const allowed: readonly string[] = FLAGS[command];
    for (const flag of ['mint', 'wallet', 'buy', 'payer'] as const) {
        if (values[flag] !== undefined && !allowed.includes(flag)) usage(`--${flag} is not a flag of ${command}`);
    }
    const cluster = clusterUrl(values.cluster, usage);
    const record = values.record;
    if (command === 'list') return { command, cluster, record };
    const mint = values.mint ?? usage(`${command} needs --mint: the contained token's mint`);
    if (!isAddress(mint)) usage(`--mint must be an address, not "${mint}"`);
    if (command === 'unlock') {
        const payer = values.payer ?? usage('unlock needs --payer: the keypair that pays its transaction fee (unlock is permissionless)');
        return { command, cluster, record, mint, payer };
    }
    const wallet = values.wallet ?? usage('trade needs --wallet: the keypair that buys and sells');
    const buy = values.buy ?? usage('trade needs --buy: how much of the quote mint to spend, in its base units');
    if (!/^\d+$/.test(buy)) usage(`--buy must be a whole number of quote-mint base units, not "${buy}"`);
    if (BigInt(buy) === 0n) usage('--buy must be above zero');
    if (BigInt(buy) > U64_MAX) usage(`--buy must fit in a u64 (at most ${U64_MAX}), not ${buy}`);
    return { command, cluster, record, mint, wallet, buy: BigInt(buy) };
}
