// Each token's terms, read from the launch script's flags: the nth `--goal`, `--deadline`,
// `--unlock` and `--quote-mint` are the nth token's (docs/toolchain.md, "Containment hook").

import { isAddress } from '@solana/kit';

export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const U64_MAX = 2n ** 64n - 1n;

/** A flag the launch script cannot take; it prints the message with its usage and exits. */
export class UsageError extends Error {}

/**
 * One token's terms: the unlock goal and deadline it is bound with, what the script waits for
 * to unlock it (none leaves it contained), and the mint it is quoted in: an SPL Token mint's
 * address, or `new` for a fresh SPL Token mint the script creates and the launcher holds.
 */
export type TokenTerms = {
    unlockGoal: bigint;
    unlockDeadline: bigint;
    unlockBy: 'goal' | 'deadline' | undefined;
    quoteMint: string;
};

export type TokenFlags = { goal?: string[]; deadline?: string[]; unlock?: string[]; quoteMint?: string[] };

function usage(message: string): never {
    throw new UsageError(message);
}

/** `--goal`: a whole number of quote-mint base units. */
function parseGoal(goal: string): bigint {
    if (!/^\d+$/.test(goal)) usage(`--goal must be a whole number of quote-mint base units, not "${goal}"`);
    if (BigInt(goal) > U64_MAX) usage(`--goal must fit in a u64 (at most ${U64_MAX}), not ${goal}`);
    return BigInt(goal);
}

/** `--deadline`: Unix seconds, or an ISO 8601 time with its time zone. */
function parseDeadline(deadline: string | undefined): bigint {
    if (deadline === undefined) usage('--deadline is required: when the unlock is due whatever the tax collected');
    if (/^\d+$/.test(deadline)) return BigInt(deadline);
    if (!/(Z|[+-]\d\d:\d\d)$/.test(deadline)) usage(`--deadline must be Unix seconds or an ISO 8601 time with a time zone, not "${deadline}"`);
    const ms = Date.parse(deadline);
    if (Number.isNaN(ms)) usage(`--deadline is not a time: "${deadline}"`);
    return BigInt(Math.floor(ms / 1000));
}

/** Every token's terms, in order; throws `UsageError` for flags that do not pair up. */
export function parseTokens({ goal: goals = [], deadline: deadlines = [], unlock: unlocks = [], quoteMint: quotes = [] }: TokenFlags): TokenTerms[] {
    if (goals.length === 0) usage('--goal is required: the tax the home market must collect for the unlock, in quote-mint base units');
    if (deadlines.length > goals.length) usage('give one --goal for each --deadline: each pair launches one token');
    if (unlocks.length > 0 && unlocks.length !== goals.length) usage('give --unlock for every token or for none');
    for (const unlock of unlocks) {
        if (unlock !== 'goal' && unlock !== 'deadline' && unlock !== 'none') usage(`--unlock must be goal, deadline or none, not "${unlock}"`);
    }
    if (quotes.length > 1 && quotes.length !== goals.length) usage('give --quote-mint once for every token, or once for each');
    for (const quote of quotes) {
        if (quote !== 'new' && !isAddress(quote)) usage(`--quote-mint must be an address or "new", not "${quote}"`);
    }
    return goals.map((goal, i) => ({
        unlockGoal: parseGoal(goal),
        unlockDeadline: parseDeadline(deadlines[i]),
        unlockBy: unlocks[i] === 'none' ? undefined : (unlocks[i] as TokenTerms['unlockBy']),
        quoteMint: quotes.length === 0 ? WRAPPED_SOL : quotes.length === 1 ? quotes[0]! : quotes[i]!,
    }));
}
