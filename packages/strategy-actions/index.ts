// The custom actions our strategies describe in their metadata under `aviary_actions`
// (decision BAR-42 in docs/decisions.md): every instruction that is not a swap or the market's
// creation, such as a seed, a payout or a tax authority's change, which users sign directly
// on the strategy and which never goes through the router.
//
// Pipeline described these under `actions` until its 0.2.0 (e9fbf1a), which dropped custom
// actions from its metadata standard and SDK: a document with `actions` is still valid but
// draws a warning, and the SDK's buildActionInstruction is gone. Its validator allows unknown
// keys with no warning, so our strategies keep the same descriptions under a key of our own,
// and this package validates and builds them.
//
// Ported from Pipeline's TypeScript SDK at 5ad130d (sdk/ts/src/actions.ts and metadata.ts,
// Apache-2.0, https://github.com/MetalLegBob/pipeline), on the account-source and argument
// helpers its 0.2 SDK still exports, so an action resolves its accounts exactly as `init` does.

import { AccountRole, type Address, type GetAccountInfoApi, type Instruction, type Rpc } from '@solana/kit';
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
    type SourceContext,
} from '@pipeline-placeholder/sdk';

/** The top-level metadata key our strategies describe their custom actions under. */
export const AVIARY_ACTIONS_KEY = 'aviary_actions';

/** What an action does, for grouping in a UI; any other kind draws a warning. */
export const ACTION_KINDS = ['add_liquidity', 'remove_liquidity', 'claim', 'create_market', 'other'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** A custom instruction on a strategy, as Pipeline's metadata described one before 0.2.0. */
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

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates `metadata.aviary_actions`, which may be absent (no actions). Never throws: the
 * result lists every error found, each with the path of what is wrong.
 */
export function parseAviaryActions(metadata: unknown): ParseActionsResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const value = isObject(metadata) ? metadata[AVIARY_ACTIONS_KEY] : undefined;
    if (value === undefined) return { ok: true, actions: [], warnings };
    if (!Array.isArray(value)) return { ok: false, errors: [`${AVIARY_ACTIONS_KEY}: must be an array`] };
    if (value.length > 64) errors.push(`${AVIARY_ACTIONS_KEY}: at most 64 actions`);
    const names = new Set<string>();
    value.forEach((action, i) => {
        const p = `${AVIARY_ACTIONS_KEY}[${i}]`;
        if (!isObject(action)) {
            errors.push(`${p}: must be an object`);
            return;
        }
        if (typeof action.name !== 'string' || !NAME.test(action.name)) {
            errors.push(`${p}.name: must be an identifier (letters, digits, _)`);
        } else if (names.has(action.name)) {
            errors.push(`${p}.name: duplicate action "${action.name}"`);
        } else {
            names.add(action.name);
        }
        checkString(errors, action.label, `${p}.label`, 64, true);
        checkString(errors, action.description, `${p}.description`, 2000, false);
        if (action.kind !== undefined) {
            if (typeof action.kind !== 'string') errors.push(`${p}.kind: must be a string`);
            else if (!(ACTION_KINDS as readonly string[]).includes(action.kind)) warnings.push(`${p}.kind: unknown kind "${action.kind}"`);
        }
        if (action.discriminator !== undefined && (typeof action.discriminator !== 'string' || !/^[0-9a-fA-F]{16}$/.test(action.discriminator))) {
            errors.push(`${p}.discriminator: must be 16 hex digits`);
        }
        const argNames = checkArgs(errors, action.args, `${p}.args`);
        checkAccounts(errors, action.accounts, `${p}.accounts`, argNames);
    });
    return errors.length > 0 ? { ok: false, errors } : { ok: true, actions: value as AviaryAction[], warnings };
}

function checkString(errors: string[], value: unknown, path: string, max: number, required: boolean) {
    if (value === undefined) {
        if (required) errors.push(`${path}: required`);
        return false;
    }
    if (typeof value !== 'string') {
        errors.push(`${path}: must be a string`);
        return false;
    }
    if (value.length > max) errors.push(`${path}: at most ${max} characters`);
    return true;
}

function checkArgs(errors: string[], value: unknown, path: string): Set<string> {
    const names = new Set<string>();
    if (value === undefined) return names;
    if (!Array.isArray(value)) {
        errors.push(`${path}: must be an array`);
        return names;
    }
    value.forEach((arg, i) => {
        const p = `${path}[${i}]`;
        if (!isObject(arg)) {
            errors.push(`${p}: must be an object`);
            return;
        }
        if (typeof arg.name !== 'string' || !NAME.test(arg.name)) errors.push(`${p}.name: must be an identifier (letters, digits, _)`);
        else if (names.has(arg.name)) errors.push(`${p}.name: duplicate argument "${arg.name}"`);
        else names.add(arg.name);
        if (!(ARG_TYPES as readonly unknown[]).includes(arg.type)) errors.push(`${p}.type: must be one of ${ARG_TYPES.join(', ')}`);
        checkString(errors, arg.label, `${p}.label`, 64, false);
        checkString(errors, arg.description, `${p}.description`, 1000, false);
        if (checkString(errors, arg.decimals_of, `${p}.decimals_of`, 256, false)) {
            checkSource(errors, arg.decimals_of as string, `${p}.decimals_of`, names);
        }
    });
    return names;
}

function checkSource(errors: string[], text: string, path: string, argNames: Set<string>) {
    const source = parseAccountSource(text);
    if (typeof source === 'string') {
        errors.push(`${path}: ${source}`);
        return;
    }
    if (source.kind === 'pda') {
        for (const seed of source.seeds) {
            if (seed.kind === 'arg' && !argNames.has(seed.name)) errors.push(`${path}: seed refers to unknown argument "${seed.name}"`);
        }
    }
}

function checkAccounts(errors: string[], value: unknown, path: string, argNames: Set<string>) {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
        errors.push(`${path}: must be an array`);
        return;
    }
    value.forEach((account, i) => {
        const p = `${path}[${i}]`;
        if (!isObject(account)) {
            errors.push(`${p}: must be an object`);
            return;
        }
        checkString(errors, account.name, `${p}.name`, 64, true);
        if (checkString(errors, account.source, `${p}.source`, 512, true)) checkSource(errors, account.source as string, `${p}.source`, argNames);
        for (const flag of ['signer', 'writable'] as const) {
            if (account[flag] !== undefined && typeof account[flag] !== 'boolean') errors.push(`${p}.${flag}: must be a boolean`);
        }
    });
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
 * Anchor's from its name), its arguments Borsh-encoded in order, and its accounts resolved
 * from their sources against the market, the wallet and `inputs`. The user signs it directly.
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
    const specs = input.action.args ?? [];
    const args = encodeArgs(specs, input.args ?? {});
    const context: SourceContext = {
        strategyProgram: input.market.strategyProgram,
        wallet: input.wallet,
        market: input.market,
        marketState: input.market.marketState,
        inputs: input.inputs,
        args,
        tokenPrograms: input.tokenPrograms,
        rpc: input.rpc,
    };
    const discriminator = input.action.discriminator
        ? hexToBytes(input.action.discriminator)
        : await anchorDiscriminator(input.action.name);
    const parts = [discriminator, ...specs.map((spec) => args[spec.name]!)];
    const data = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    parts.reduce((offset, part) => (data.set(part, offset), offset + part.length), 0);
    const accounts = await resolveMetadataAccounts(input.action.accounts ?? [], context);
    return { programAddress: input.market.strategyProgram, accounts, data };
}

export { AccountRole };
