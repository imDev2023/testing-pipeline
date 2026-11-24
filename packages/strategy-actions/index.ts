// The custom actions our strategies describe in their metadata under `aviary_actions`
// (decision BAR-41 in docs/decisions.md): every instruction that is not a swap or the market's
// creation, such as a seed, a payout or a tax authority's change, which users sign directly
// on the strategy and which never goes through the router.
//
// Pipeline described these under `actions` until its 0.2.0 (e9fbf1a), which dropped custom
// actions from its metadata standard and SDK: a document with `actions` stays valid but draws
// a warning, and the SDK no longer builds them. Its validator allows unknown keys with no
// warning, so our strategies keep the same descriptions under a key of our own, in the shape
// `actions` had, and this package checks and builds them. It is written for this repo, on the
// public functions Pipeline's SDK still exports for account sources and arguments, so an
// action's accounts resolve exactly as `init`'s do.

import type { Address, GetAccountInfoApi, Instruction, Rpc } from '@solana/kit';
import {
    anchorDiscriminator,
    ARG_TYPES,
    encodeArgs,
    hexToBytes,
    parseAccountSource,
    resolveMetadataAccounts,
    type ArgValue,
    type MarketView,
    type MetadataAccount,
    type MetadataArg,
} from '@pipeline-sol/sdk';

/** The top-level metadata key our strategies describe their custom actions under. */
export const AVIARY_ACTIONS_KEY = 'aviary_actions';

/** What an action does, for grouping in a UI; any other kind draws a warning. */
export const ACTION_KINDS = ['add_liquidity', 'remove_liquidity', 'claim', 'create_market', 'other'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** A custom instruction on a strategy. */
export type AviaryAction = {
    /** The instruction's name; for an Anchor program, its IDL name. */
    name: string;
    label: string;
    kind?: ActionKind;
    description?: string;
    /** 8-byte discriminator as 16 hex digits; Anchor's `sha256("global:<name>")[..8]` if absent. */
    discriminator?: string;
    args?: MetadataArg[];
    accounts?: MetadataAccount[];
    [key: string]: unknown;
};

export type ParseActionsResult =
    | { ok: true; actions: AviaryAction[]; warnings: string[] }
    | { ok: false; errors: string[] };

/** The most of each list one metadata document may hold. */
const LIMITS = { actions: 64, args: 32, accounts: 64 } as const;
/** The most characters each text field may hold. */
const LENGTHS = { name: 64, label: 64, actionDescription: 2000, argDescription: 1000, source: 512 } as const;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DISCRIMINATOR = /^[0-9a-fA-F]{16}$/;

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Collects what is wrong with a document, each problem with the path it is at. */
class Findings {
    readonly errors: string[] = [];
    readonly warnings: string[] = [];

    error(path: string, problem: string) {
        this.errors.push(`${path}: ${problem}`);
    }

    /** The items of a list at `path`, or none if it is absent or not a list. */
    list(value: unknown, path: string, most: number): unknown[] {
        if (value === undefined) return [];
        if (!Array.isArray(value)) {
            this.error(path, 'must be an array');
            return [];
        }
        if (value.length > most) this.error(path, `at most ${most} items`);
        return value;
    }

    /** Whether `value` is usable text: present when required, a string, not empty, short enough. */
    text(value: unknown, path: string, most: number, required: boolean): value is string {
        if (value === undefined) {
            if (required) this.error(path, 'required');
            return false;
        }
        if (typeof value !== 'string') {
            this.error(path, 'must be a string');
            return false;
        }
        if (required && value.length === 0) this.error(path, 'must not be empty');
        if (value.length > most) this.error(path, `at most ${most} characters`);
        return true;
    }

    /** Checks a name that must be an identifier, unique among `seen`. */
    identifier(value: unknown, path: string, seen: Set<string>, what: string) {
        if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
            this.error(path, 'must be an identifier (letters, digits, _)');
        } else if (seen.has(value)) {
            this.error(path, `duplicate ${what} "${value}"`);
        } else {
            seen.add(value);
        }
    }

    /** Checks an account source, whose PDA seeds may name only the action's arguments. */
    source(text: string, path: string, args: Set<string>) {
        const source = parseAccountSource(text);
        if (typeof source === 'string') {
            this.error(path, source);
            return;
        }
        if (source.kind !== 'pda') return;
        for (const seed of source.seeds) {
            if (seed.kind === 'arg' && !args.has(seed.name)) this.error(path, `seed refers to unknown argument "${seed.name}"`);
        }
    }
}

function checkAction(found: Findings, action: unknown, path: string, names: Set<string>) {
    if (!isFields(action)) {
        found.error(path, 'must be an object');
        return;
    }
    found.identifier(action.name, `${path}.name`, names, 'action');
    found.text(action.label, `${path}.label`, LENGTHS.label, true);
    found.text(action.description, `${path}.description`, LENGTHS.actionDescription, false);
    if (action.kind !== undefined) {
        if (typeof action.kind !== 'string') found.error(`${path}.kind`, 'must be a string');
        else if (!(ACTION_KINDS as readonly string[]).includes(action.kind)) found.warnings.push(`${path}.kind: unknown kind "${action.kind}"`);
    }
    if (action.discriminator !== undefined && (typeof action.discriminator !== 'string' || !DISCRIMINATOR.test(action.discriminator))) {
        found.error(`${path}.discriminator`, 'must be 16 hex digits');
    }
    const args = new Set<string>();
    found.list(action.args, `${path}.args`, LIMITS.args).forEach((arg, i) => checkArg(found, arg, `${path}.args[${i}]`, args));
    found
        .list(action.accounts, `${path}.accounts`, LIMITS.accounts)
        .forEach((account, i) => checkAccount(found, account, `${path}.accounts[${i}]`, args));
}

function checkArg(found: Findings, arg: unknown, path: string, args: Set<string>) {
    if (!isFields(arg)) {
        found.error(path, 'must be an object');
        return;
    }
    found.identifier(arg.name, `${path}.name`, args, 'argument');
    if (!(ARG_TYPES as readonly unknown[]).includes(arg.type)) found.error(`${path}.type`, `must be one of ${ARG_TYPES.join(', ')}`);
    found.text(arg.label, `${path}.label`, LENGTHS.label, false);
    found.text(arg.description, `${path}.description`, LENGTHS.argDescription, false);
    if (found.text(arg.decimals_of, `${path}.decimals_of`, LENGTHS.source, false)) found.source(arg.decimals_of, `${path}.decimals_of`, args);
}

function checkAccount(found: Findings, account: unknown, path: string, args: Set<string>) {
    if (!isFields(account)) {
        found.error(path, 'must be an object');
        return;
    }
    found.text(account.name, `${path}.name`, LENGTHS.name, true);
    if (found.text(account.source, `${path}.source`, LENGTHS.source, true)) found.source(account.source, `${path}.source`, args);
    for (const flag of ['signer', 'writable'] as const) {
        if (account[flag] !== undefined && typeof account[flag] !== 'boolean') found.error(`${path}.${flag}`, 'must be a boolean');
    }
}

/**
 * Checks `metadata.aviary_actions`, which may be absent (no actions). Never throws: the
 * result lists every problem found, each with the path of what is wrong.
 */
export function parseAviaryActions(metadata: unknown): ParseActionsResult {
    const found = new Findings();
    const value = isFields(metadata) ? metadata[AVIARY_ACTIONS_KEY] : undefined;
    const names = new Set<string>();
    const actions = found.list(value, AVIARY_ACTIONS_KEY, LIMITS.actions);
    actions.forEach((action, i) => checkAction(found, action, `${AVIARY_ACTIONS_KEY}[${i}]`, names));
    return found.errors.length > 0
        ? { ok: false, errors: found.errors }
        : { ok: true, actions: actions as AviaryAction[], warnings: found.warnings };
}

/**
 * The action named `name` in `metadata.aviary_actions`, or undefined when there is none;
 * throws if `aviary_actions` is invalid.
 */
export function findAction(metadata: unknown, name: string): AviaryAction | undefined {
    const parsed = parseAviaryActions(metadata);
    if (!parsed.ok) throw new Error(`${AVIARY_ACTIONS_KEY} is invalid: ${parsed.errors.join('; ')}`);
    return parsed.actions.find((action) => action.name === name);
}

/** The action named `name` in `metadata.aviary_actions`; throws if it is invalid or absent. */
export function actionNamed(metadata: unknown, name: string): AviaryAction {
    const action = findAction(metadata, name);
    if (!action) throw new Error(`metadata has no ${AVIARY_ACTIONS_KEY} entry named "${name}"`);
    return action;
}

/**
 * Builds an action as an instruction to the strategy program: its discriminator (given, or
 * Anchor's from its name), then its arguments Borsh-encoded in order, with its accounts
 * resolved from their sources against the market, the wallet and `inputs`. The user signs
 * it directly.
 */
export async function buildActionInstruction(input: {
    action: AviaryAction;
    market: MarketView;
    wallet: Address;
    args?: Record<string, ArgValue>;
    inputs?: Record<string, Address>;
    tokenPrograms?: Record<string, Address>;
    rpc?: Rpc<GetAccountInfoApi>;
}): Promise<Instruction> {
    const { action, market } = input;
    const specs = action.args ?? [];
    const encoded = encodeArgs(specs, input.args ?? {});
    const accounts = await resolveMetadataAccounts(action.accounts ?? [], {
        strategyProgram: market.strategyProgram,
        wallet: input.wallet,
        market,
        marketState: market.marketState,
        inputs: input.inputs,
        args: encoded,
        tokenPrograms: input.tokenPrograms,
        rpc: input.rpc,
    });
    const discriminator = action.discriminator ? hexToBytes(action.discriminator) : await anchorDiscriminator(action.name);
    const parts = [discriminator, ...specs.map((spec) => encoded[spec.name]!)];
    const data = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        data.set(part, offset);
        offset += part.length;
    }
    return { programAddress: market.strategyProgram, accounts, data };
}
