// Every policy value of the keeper runner, in one place (docs/spec/keeper-runner.md,
// "Spending caps"; SUITE-02, SUITE-26). Each is overridable by an environment variable of the
// same name prefixed KEEPER_ (the key's path is KEEPER_KEYPAIR itself), and no other file
// repeats a value: the README and the logs show what this module says.
//
// A default is written as its variable would be, so a default and an override go through the
// same parser. Amounts are in SOL, durations take s, m or h, and the daily pass is HH:MM UTC.

import { homedir } from 'node:os';
import { join } from 'node:path';

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Alchemy's free devnet endpoint, for reads, simulations and sends (SUITE-36). */
const alchemyDevnet = (key: string) => `https://solana-devnet.g.alchemy.com/v2/${key}`;
/**
 * Solana's public devnet endpoint: free and keyless, it serves the two methods Alchemy's free
 * tier refuses (`logsSubscribe` on its socket and `getProgramAccounts`), until Aviary's own
 * Helius key exists (SUITE-49).
 */
const PUBLIC_DEVNET = 'https://api.devnet.solana.com';

type Env = Readonly<Record<string, string | undefined>>;

type Definition<T> = {
    /** The default, written as its variable would be, or computed from the environment. */
    fallback: string | ((env: Env) => string | null);
    parse(value: string): T;
    show(value: T): string;
};

const sol: Pick<Definition<bigint>, 'parse' | 'show'> = {
    parse(value) {
        const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value.trim());
        if (!match) throw new Error('an amount of SOL with at most 9 decimals, such as 0.003');
        return BigInt(match[1]!) * LAMPORTS_PER_SOL + BigInt((match[2] ?? '').padEnd(9, '0'));
    },
    show(value) {
        const whole = value / LAMPORTS_PER_SOL;
        const fraction = (value % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
        return `${whole}${fraction ? `.${fraction}` : ''} SOL`;
    },
};

const UNITS = { h: 3_600_000, m: 60_000, s: 1_000 } as const;
const MAX_TIMER_MS = 2 ** 31 - 1;
function parseDuration(value: string): number {
    const match = /^(\d+)(s|m|h)$/.exec(value.trim());
    if (!match || Number(match[1]) === 0) throw new Error('a duration above 0 such as 30s, 2m or 1h');
    const ms = Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
    // A timer holds at most 2^31 - 1 ms; a longer one would fire at once, and again, and again.
    if (ms > MAX_TIMER_MS) throw new Error('a duration of at most 596h (24 days), the longest timer Node holds');
    return ms;
}
function showDuration(ms: number): string {
    for (const [unit, size] of Object.entries(UNITS)) if (ms % size === 0) return `${ms / size}${unit}`;
    return `${ms}ms`;
}
const duration: Pick<Definition<number>, 'parse' | 'show'> = { parse: parseDuration, show: showDuration };

const text: Pick<Definition<string>, 'parse' | 'show'> = {
    parse(value) {
        if (value.trim() === '') throw new Error('a value');
        return value.trim();
    },
    show: (value) => value,
};

/** A URL with any key in it (a path segment after /v2/, an api-key, a password) hidden. */
function redact(url: string): string {
    return url
        .replace(/(\/v2\/)[^/?#]+/, '$1<key>')
        .replace(/([?&](?:api-key|api_key|key|token)=)[^&#]+/gi, '$1<key>')
        .replace(/(\/\/[^/:@]+:)[^@/]+@/, '$1<password>@');
}
const url: Pick<Definition<string>, 'parse' | 'show'> = {
    parse(value) {
        new URL(value.trim());
        return value.trim();
    },
    show: redact,
};

/** Aviary's own Helius URL, from the project's .env (docs/spec/pipescope-architecture.md, "RPC"). */
const aviaryRpc = (env: Env) => (env.RPC_URL?.trim() ? env.RPC_URL.trim() : null);

const DEFINITIONS = {
    FLOAT_TARGET: { fallback: '2', ...sol },
    LOW_BALANCE: { fallback: '0.5', ...sol },
    MIN_BALANCE: { fallback: '0.1', ...sol },
    MAX_TX_COST: { fallback: '0.003', ...sol },
    MARKET_DAILY_CAP: { fallback: '0.01', ...sol },
    DAILY_CAP: { fallback: '0.1', ...sol },
    PRIORITY_FEE_MICROLAMPORTS: {
        fallback: '0',
        parse(value: string) {
            if (!/^\d+$/.test(value.trim())) throw new Error('a whole number of micro-lamports per compute unit');
            return BigInt(value.trim());
        },
        show: (value: bigint) => `${value} micro-lamports per compute unit`,
    },
    TIP_UNWRAP_AT: { fallback: '0.05', ...sol },
    RETRY_DELAYS: {
        fallback: '30s,2m,10m',
        parse: (value: string) => value.split(',').map(parseDuration),
        show: (value: number[]) => value.map(showDuration).join(', '),
    },
    SWEEP_INTERVAL: { fallback: '10m', ...duration },
    SETTLE_INTERVAL: { fallback: '1h', ...duration },
    DAILY_PASS_UTC: {
        fallback: '00:00',
        parse(value: string) {
            const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
            if (!match) throw new Error('a time of day in UTC, HH:MM');
            return { hour: Number(match[1]), minute: Number(match[2]) };
        },
        show: ({ hour, minute }: { hour: number; minute: number }) =>
            `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`,
    },
    KEYPAIR: { fallback: () => join(homedir(), '.config/testing-pipeline/devnet/keeper.json'), ...text },
    RPC_URL: { fallback: (env: Env) => (env.ALCHEMY_API_KEY?.trim() ? alchemyDevnet(env.ALCHEMY_API_KEY.trim()) : null), ...url },
    WS_URL: { fallback: (env: Env) => (aviaryRpc(env) ?? PUBLIC_DEVNET).replace(/^http/, 'ws'), ...url },
    DISCOVERY_RPC_URL: { fallback: (env: Env) => aviaryRpc(env) ?? PUBLIC_DEVNET, ...url },
    DATABASE_URL: { fallback: () => null, ...url },
} as const satisfies Record<string, Definition<any>>;

export type SettingName = keyof typeof DEFINITIONS;
export const SETTING_NAMES = Object.keys(DEFINITIONS) as SettingName[];

type Parsed<N extends SettingName> = ReturnType<(typeof DEFINITIONS)[N]['parse']>;

export type Settings = {
    floatTarget: bigint;
    lowBalance: bigint;
    minBalance: bigint;
    maxTxCost: bigint;
    marketDailyCap: bigint;
    dailyCap: bigint;
    priorityFeeMicrolamports: bigint;
    tipUnwrapAt: bigint;
    retryDelaysMs: number[];
    sweepIntervalMs: number;
    settleIntervalMs: number;
    dailyPassUtc: { hour: number; minute: number };
    keypair: string;
    rpcUrl: string;
    wsUrl: string;
    discoveryRpcUrl: string;
    databaseUrl: string | null;
};

/** The variable that overrides a setting: KEEPER_ and its name, KEEPER_KEYPAIR for the key. */
const variableOf = (name: SettingName) => `KEEPER_${name}`;

/** Reads every setting from the environment, refusing an unknown KEEPER_ variable or a bad value. */
export function loadSettings(env: Env = process.env): Settings {
    const known = new Set(SETTING_NAMES.map(variableOf));
    const unknown = Object.keys(env).filter((key) => key.startsWith('KEEPER_') && !known.has(key));
    if (unknown.length > 0) throw new Error(`${unknown.join(', ')} names no keeper setting; the settings are ${[...known].join(', ')}`);

    function read<N extends SettingName>(name: N): Parsed<N> | null {
        const definition = DEFINITIONS[name] as Definition<Parsed<N>>;
        const variable = variableOf(name);
        const value = env[variable] ?? (typeof definition.fallback === 'string' ? definition.fallback : definition.fallback(env));
        if (value === null) return null;
        try {
            return definition.parse(value);
        } catch (error) {
            throw new Error(`${variable} must be ${(error as Error).message}, not ${JSON.stringify(variable.endsWith('_URL') ? redact(value) : value)}`);
        }
    }
    function required<N extends SettingName>(name: N, why = ''): Parsed<N> {
        const value = read(name);
        if (value === null) throw new Error(`${variableOf(name)} is not set${why}`);
        return value;
    }

    return {
        floatTarget: required('FLOAT_TARGET'),
        lowBalance: required('LOW_BALANCE'),
        minBalance: required('MIN_BALANCE'),
        maxTxCost: required('MAX_TX_COST'),
        marketDailyCap: required('MARKET_DAILY_CAP'),
        dailyCap: required('DAILY_CAP'),
        priorityFeeMicrolamports: required('PRIORITY_FEE_MICROLAMPORTS'),
        tipUnwrapAt: required('TIP_UNWRAP_AT'),
        retryDelaysMs: required('RETRY_DELAYS'),
        sweepIntervalMs: required('SWEEP_INTERVAL'),
        settleIntervalMs: required('SETTLE_INTERVAL'),
        dailyPassUtc: required('DAILY_PASS_UTC'),
        keypair: required('KEYPAIR'),
        rpcUrl: required('RPC_URL', ', and neither is ALCHEMY_API_KEY, which its default is built from'),
        wsUrl: required('WS_URL'),
        discoveryRpcUrl: required('DISCOVERY_RPC_URL'),
        databaseUrl: read('DATABASE_URL'),
    };
}

const FIELDS: Record<SettingName, keyof Settings> = {
    FLOAT_TARGET: 'floatTarget',
    LOW_BALANCE: 'lowBalance',
    MIN_BALANCE: 'minBalance',
    MAX_TX_COST: 'maxTxCost',
    MARKET_DAILY_CAP: 'marketDailyCap',
    DAILY_CAP: 'dailyCap',
    PRIORITY_FEE_MICROLAMPORTS: 'priorityFeeMicrolamports',
    TIP_UNWRAP_AT: 'tipUnwrapAt',
    RETRY_DELAYS: 'retryDelaysMs',
    SWEEP_INTERVAL: 'sweepIntervalMs',
    SETTLE_INTERVAL: 'settleIntervalMs',
    DAILY_PASS_UTC: 'dailyPassUtc',
    KEYPAIR: 'keypair',
    RPC_URL: 'rpcUrl',
    WS_URL: 'wsUrl',
    DISCOVERY_RPC_URL: 'discoveryRpcUrl',
    DATABASE_URL: 'databaseUrl',
};

/** Every setting by its name, as the runner logs them when it starts: no key or password shown. */
export function describeSettings(settings: Settings): Record<SettingName, string> {
    return Object.fromEntries(
        SETTING_NAMES.map((name) => {
            const value = settings[FIELDS[name]];
            const definition = DEFINITIONS[name] as Definition<unknown>;
            return [name, value === null ? 'unset' : definition.show(value)];
        }),
    ) as Record<SettingName, string>;
}
