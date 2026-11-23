// The freeze gate's decisions (docs/spec/containment-hook.md, "Upgrade policy"; HOOK-51,
// hardening findings H016 to H018 of #74, Round 2 findings R2T-07 to R2T-09 and R2-B), kept free
// of any RPC so they are tested on their own (freeze.test.ts): whether a contained mint's transfer
// hook fields agree with its config, whether a config says what `bind` wrote (its home market,
// vault, fee account, quote mint, terms, bumps and validation account), what the BPF upgradeable
// loader's accounts say about a program's upgrade authority, bytes and deploy slot, whether the
// two programs are frozen together, the loader's `SetAuthority` instruction that freezes a
// program, and which recorded contained mints must still have their configs.

import { createHash } from 'node:crypto';

import { AccountRole, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address, type Instruction } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

import { findConfigPda, findExtraAccountMetasPda, findUnlockPda, type Config } from './client/index.ts';

/** The address Token-2022 stores for an unset transfer hook program or authority. */
export const UNSET = '11111111111111111111111111111111';
export const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;

/** A mint's transfer hook extension, or undefined when the mint carries none. */
export type MintHook = { programId: string; authority: string } | undefined;

export type MintVerdict = { ok: true; state: 'contained' | 'unlocked' } | { ok: false; reason: string };

/**
 * Judges one contained mint against its hook config. While the config's `unlocked_at` is none,
 * the mint's transfer hook program must be the hook and its authority the mint's unlock PDA
 * ["unlock", mint] under the hook, so only the hook's own `unlock` can ever change them; once
 * `unlocked_at` is set, both must be unset, as `unlock` leaves them. Anything else means the
 * fields were changed some other way, such as by an upgraded hook signing as the unlock PDA,
 * which a later freeze would not undo.
 */
export function judgeMint({ hook, unlockPda, mintHook, unlockedAt }: { hook: string; unlockPda: string; mintHook: MintHook; unlockedAt: bigint | null }): MintVerdict {
    if (mintHook === undefined) return { ok: false, reason: 'the mint carries no transfer hook extension' };
    const { programId, authority } = mintHook;
    if (unlockedAt === null) {
        const problems: string[] = [];
        if (programId !== hook) problems.push(`its transfer hook program is ${programId === UNSET ? 'unset' : programId}, not the hook ${hook}`);
        if (authority !== unlockPda) problems.push(`its transfer hook authority is ${authority === UNSET ? 'unset' : authority}, not its unlock PDA ${unlockPda}`);
        return problems.length > 0 ? { ok: false, reason: `contained (unlocked_at none), but ${problems.join(' and ')}` } : { ok: true, state: 'contained' };
    }
    const problems: string[] = [];
    if (programId !== UNSET) problems.push(`its transfer hook program is still ${programId}`);
    if (authority !== UNSET) problems.push(`its transfer hook authority is still ${authority}`);
    return problems.length > 0 ? { ok: false, reason: `unlocked at ${unlockedAt}, but ${problems.join(' and ')}` } : { ok: true, state: 'unlocked' };
}

/** The loader's `UpgradeableLoaderState` tags, a little-endian u32 at the start of each account. */
const PROGRAM_TAG = 2;
const PROGRAM_DATA_TAG = 3;
/** `SetAuthority`, the loader instruction's tag. */
const SET_AUTHORITY = 4;

/** The program data account a program account of the upgradeable loader points at. */
export function programDataAddressOf(programAccount: Uint8Array): Address {
    if (programAccount.length < 36 || new DataView(programAccount.buffer, programAccount.byteOffset).getUint32(0, true) !== PROGRAM_TAG) {
        throw new Error('not an upgradeable loader Program account');
    }
    return getAddressDecoder().decode(programAccount.subarray(4, 36));
}

/** The upgrade authority a program data account records, or null when the program is frozen. */
export function upgradeAuthorityOf(programData: Uint8Array): Address | null {
    // Tag (4), the slot it was last deployed in (8), then an Option<Pubkey>: a tag byte and 32 bytes.
    if (programData.length < 13 || new DataView(programData.buffer, programData.byteOffset).getUint32(0, true) !== PROGRAM_DATA_TAG) {
        throw new Error('not an upgradeable loader ProgramData account');
    }
    const tag = programData[12];
    if (tag === 0) return null;
    if (tag !== 1 || programData.length < 45) throw new Error(`ProgramData's upgrade authority option has tag ${tag}`);
    return getAddressDecoder().decode(programData.subarray(13, 45));
}

/**
 * The loader's `SetAuthority` with no new authority: it removes the program's upgrade
 * authority for good, signed by the current one (what `solana program set-upgrade-authority
 * --final` sends).
 */
export function freezeInstruction(programData: Address, currentAuthority: Address): Instruction {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setUint32(0, SET_AUTHORITY, true);
    return {
        programAddress: BPF_UPGRADEABLE_LOADER,
        accounts: [
            { address: programData, role: AccountRole.WRITABLE },
            { address: currentAuthority, role: AccountRole.READONLY_SIGNER },
        ],
        data,
    };
}


// ---------------------------------------------------------------------------------------------
// R2T-07: what each config says, against the chain
// ---------------------------------------------------------------------------------------------

/** The config version the gate reads (programs/containment-hook/src/state.rs, CONFIG_VERSION). */
export const CONFIG_VERSION = 1;
/**
 * The longest a binding may wait for its deadline, in seconds: programs/containment-hook/src/config.rs,
 * MAX_UNLOCK_DEADLINE_SECS (90 days), pinned by freeze.test.ts against that file.
 */
export const MAX_UNLOCK_DEADLINE_SECS = 7_776_000n;
/** Pipeline's router. */
export const ROUTER_PROGRAM = 'PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34' as Address;

/**
 * The validation account's whole data, as `bind` writes it for every mint
 * (programs/containment-hook/src/state.rs, VALIDATION_DATA): one type-length-value entry for the
 * transfer hook interface's `Execute` holding one extra account, the config, a read-only PDA of the
 * hook from the seeds ["config", <Execute's account 1, the mint>]. freeze.test.ts checks it
 * against a devnet validation account.
 */
export const VALIDATION_DATA = (() => {
    const data = new Uint8Array(51);
    data.set([105, 37, 101, 197, 75, 251, 102, 26], 0); // Execute's discriminator
    data.set([39, 0, 0, 0], 8); // the value's length: the count and one 35-byte extra account
    data.set([1, 0, 0, 0], 12); // one extra account
    data[16] = 1; // a PDA of the hook program
    data.set([1, 6, ...new TextEncoder().encode('config')], 17); // the literal seed "config"
    data.set([3, 1], 25); // then account 1's key, the mint; not a signer, not writable
    return data;
})();

/** The router `Market` account's discriminator and offsets (programs/containment-hook/src/router.rs). */
const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154];
const MAX_MARKET_MINTS = 4;
const MARKET = { strategy: 8, marketState: 40, mintCount: 72, mints: 73, vaults: 73 + 32 * MAX_MARKET_MINTS, len: 73 + 64 * MAX_MARKET_MINTS + 1 + 32 + 8 + 2 };

/** The fields of a router `Market` the gate checks a config against. */
export type RouterMarket = { strategy: Address; marketState: Address; mints: Address[]; vaults: Address[] };

/** Reads a router `Market` account's data, or null unless it carries the discriminator and is long enough. */
export function readRouterMarket(data: Uint8Array): RouterMarket | null {
    if (data.length < MARKET.len || !MARKET_DISCRIMINATOR.every((byte, i) => data[i] === byte)) return null;
    const count = data[MARKET.mintCount]!;
    if (count > MAX_MARKET_MINTS) return null;
    const key = (at: number) => getAddressDecoder().decode(data.subarray(at, at + 32));
    const range = (start: number) => Array.from({ length: count }, (_, i) => key(start + 32 * i));
    return { strategy: key(MARKET.strategy), marketState: key(MARKET.marketState), mints: range(MARKET.mints), vaults: range(MARKET.vaults) };
}

/** A config's fields as the gate judges them. */
export type ConfigFields = {
    version: number;
    mint: string;
    market: string;
    marketState: string;
    vault: string;
    feeAccount: string;
    quoteMint: string;
    unlockGoal: bigint;
    unlockDeadline: bigint;
    boundAt: bigint;
    configBump: number;
    extraAccountMetasBump: number;
    unlockBump: number;
    unlockedAt: bigint | null;
};

export function configFields(config: Config): ConfigFields {
    const { discriminator: _, unlockedAt, ...fields } = config;
    return { ...fields, unlockedAt: unlockedAt.__option === 'Some' ? unlockedAt.value : null };
}

/** What the chain says about one config's mint and home market, as `bind` checked it. */
export type ConfigChain = {
    /** The tax AMM the gate freezes (--tax-amm). */
    taxAmm: string;
    /** The owner of the account at the config's market, or null when it does not exist. */
    marketOwner: string | null;
    /** That account read as a router Market, or null when it is not one. */
    market: RouterMarket | null;
    /** The router's PDA ["market", strategy, market state] of the Market read, or null. */
    marketPda: string | null;
    /** The owner of the account at the config's market state, or null when it does not exist. */
    marketStateOwner: string | null;
    /** The market's fee account for the mint, derived as the router derives it, or null. */
    feeAccount: string | null;
    /** The canonical bumps of the config, validation account and unlock PDAs of the mint. */
    bumps: { config: number; extraAccountMetas: number; unlock: number };
    /** The validation account's data, or null when it does not exist. */
    validationData: Uint8Array | null;
};

/**
 * Everything derived for a config's chain facts (PDAs and the fee account), from the accounts the
 * gate read: the market's owner and data, the market state's owner and the validation account's data.
 */
export async function chainFacts({
    hook,
    taxAmm,
    mint,
    market,
    marketStateOwner,
    validationData,
}: {
    hook: Address;
    taxAmm: Address;
    mint: Address;
    market: { owner: string; data: Uint8Array } | null;
    marketStateOwner: string | null;
    validationData: Uint8Array | null;
}): Promise<ConfigChain> {
    const read = market && market.owner === ROUTER_PROGRAM ? readRouterMarket(market.data) : null;
    let marketPda: string | null = null;
    let feeAccount: string | null = null;
    if (read) {
        const encode = getAddressEncoder();
        [marketPda] = await getProgramDerivedAddress({ programAddress: ROUTER_PROGRAM, seeds: ['market', encode.encode(read.strategy), encode.encode(read.marketState)] });
        const [feeAuthority] = await getProgramDerivedAddress({ programAddress: ROUTER_PROGRAM, seeds: ['fees', encode.encode(marketPda as Address)] });
        [feeAccount] = await findAssociatedTokenPda({ owner: feeAuthority, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    }
    const [, config] = await findConfigPda({ mint }, { programAddress: hook });
    const [, extraAccountMetas] = await findExtraAccountMetasPda({ mint }, { programAddress: hook });
    const [, unlock] = await findUnlockPda({ mint }, { programAddress: hook });
    return { taxAmm, marketOwner: market?.owner ?? null, market: read, marketPda, marketStateOwner, feeAccount, bumps: { config, extraAccountMetas, unlock }, validationData };
}

/**
 * Judges one config against the chain, checking what `bind` checks and wrote
 * (programs/containment-hook/src/instructions/bind.rs): version 1; its market a router Market at
 * its PDA, on the tax AMM, trading its mint against one quote mint; its market state the one the
 * Market records, owned by the tax AMM; its vault the Market's vault for the mint; its fee account
 * the market's, derived as the router derives it; its quote mint the Market's other mint; a goal
 * above zero; a deadline after the binding and at most MAX_UNLOCK_DEADLINE_SECS after it; its three
 * bumps canonical; an unlock time, when set, not before the binding; and its validation account's
 * data the hook's VALIDATION_DATA. Returns every problem, none when the config holds. A hook
 * upgraded before the freeze could rewrite any of these (R2T-07), such as repointing the fee
 * account to an attacker's account, which Execute would then let the token leave through.
 */
export function judgeConfig(config: ConfigFields, chain: ConfigChain): string[] {
    const problems: string[] = [];
    if (config.version !== CONFIG_VERSION) problems.push(`config version ${config.version}, while the gate reads version ${CONFIG_VERSION}`);
    const { market } = chain;
    if (chain.marketOwner === null) problems.push(`its market ${config.market} does not exist`);
    else if (chain.marketOwner !== ROUTER_PROGRAM) problems.push(`its market ${config.market} is not owned by the router (owner ${chain.marketOwner})`);
    else if (market === null) problems.push(`its market ${config.market} is not a router Market`);
    if (market) {
        if (chain.marketPda !== config.market) problems.push(`its market ${config.market} is not at its PDA ${chain.marketPda}`);
        if (market.strategy !== chain.taxAmm) problems.push(`its market runs on ${market.strategy}, not the tax AMM ${chain.taxAmm}`);
        const index = market.mints.indexOf(config.mint as Address);
        if (market.mints.length !== 2 || index < 0) {
            problems.push(`its market does not trade the mint against one quote mint (it trades ${market.mints.join(', ')})`);
        } else {
            if (config.vault !== market.vaults[index]) problems.push(`its vault ${config.vault} is not the vault the Market records, ${market.vaults[index]}`);
            if (config.quoteMint !== market.mints[1 - index]) problems.push(`its quote mint ${config.quoteMint} is not the Market's other mint, ${market.mints[1 - index]}`);
        }
        if (config.marketState !== market.marketState) problems.push(`its market state ${config.marketState} is not the one the Market records, ${market.marketState}`);
        if (config.feeAccount !== chain.feeAccount) problems.push(`its fee account ${config.feeAccount} is not the market's fee account for the mint, ${chain.feeAccount}`);
    }
    if (chain.marketStateOwner === null) problems.push(`its market state ${config.marketState} does not exist`);
    else if (chain.marketStateOwner !== chain.taxAmm) problems.push(`its market state is owned by ${chain.marketStateOwner}, not the tax AMM ${chain.taxAmm}`);
    if (config.unlockGoal === 0n) problems.push('its unlock goal is 0');
    if (config.unlockDeadline <= config.boundAt) problems.push(`its deadline ${config.unlockDeadline} is not after the binding at ${config.boundAt}`);
    else if (config.unlockDeadline - config.boundAt > MAX_UNLOCK_DEADLINE_SECS) problems.push(`its deadline ${config.unlockDeadline} is more than MAX_UNLOCK_DEADLINE_SECS (${MAX_UNLOCK_DEADLINE_SECS} s) after the binding at ${config.boundAt}`);
    if (config.unlockedAt !== null && config.unlockedAt < config.boundAt) problems.push(`it was unlocked at ${config.unlockedAt}, before the binding at ${config.boundAt}`);
    const bumps: [string, number, number][] = [
        ['config bump', config.configBump, chain.bumps.config],
        ['validation account bump', config.extraAccountMetasBump, chain.bumps.extraAccountMetas],
        ['unlock bump', config.unlockBump, chain.bumps.unlock],
    ];
    for (const [name, recorded, canonical] of bumps) if (recorded !== canonical) problems.push(`its ${name} ${recorded} is not the canonical ${canonical}`);
    if (chain.validationData === null) problems.push('it has no validation account');
    else if (chain.validationData.length !== VALIDATION_DATA.length || !VALIDATION_DATA.every((byte, i) => chain.validationData![i] === byte)) {
        problems.push("its validation account's data is not the hook's VALIDATION_DATA");
    }
    return problems;
}

// ---------------------------------------------------------------------------------------------
// R2T-08 and R2T-09: which bytes are frozen, and both programs together
// ---------------------------------------------------------------------------------------------

/** A ProgramData account's header: the tag (4), the deploy slot (8) and the authority option (1 + 32). */
const PROGRAM_DATA_HEADER = 45;

function programDataBody(programData: Uint8Array): Uint8Array {
    if (programData.length < PROGRAM_DATA_HEADER || new DataView(programData.buffer, programData.byteOffset).getUint32(0, true) !== PROGRAM_DATA_TAG) {
        throw new Error('not an upgradeable loader ProgramData account');
    }
    return programData.subarray(PROGRAM_DATA_HEADER);
}

/**
 * A program's executable hash from its ProgramData account, as `solana-verify get-program-hash`
 * gives it and `scripts/deploy-devnet.sh` records it in deployments/<cluster>.json: the SHA-256 of
 * the bytes after the 45-byte header, without the trailing zeros the account pads them with.
 */
export function executableHash(programData: Uint8Array): string {
    const body = programDataBody(programData);
    let end = body.length;
    while (end > 0 && body[end - 1] === 0) end--;
    return createHash('sha256').update(body.subarray(0, end)).digest('hex');
}

/** The slot a ProgramData account says its program was last deployed in. */
export function deploySlotOf(programData: Uint8Array): bigint {
    programDataBody(programData);
    return new DataView(programData.buffer, programData.byteOffset).getBigUint64(4, true);
}

export type ProgramsVerdict = { ok: true; frozen: boolean } | { ok: false; reason: string };

/**
 * Judges the two programs' upgrade authorities together: both upgradeable or both frozen. Exactly
 * one frozen is the state HOOK-51 exists to prevent (an upgradeable tax AMM can forge the counter
 * a frozen hook's unlock reads, and an upgradeable hook can repoint a mint despite a frozen tax AMM).
 */
export function judgePrograms(programs: { name: string; authority: string | null }[]): ProgramsVerdict {
    const frozen = programs.filter(({ authority }) => authority === null);
    if (frozen.length === 0) return { ok: true, frozen: false };
    if (frozen.length === programs.length) return { ok: true, frozen: true };
    const upgradeable = programs.filter(({ authority }) => authority !== null);
    return {
        ok: false,
        reason: `${frozen.map(({ name }) => `the ${name}`).join(' and ')} ${frozen.length === 1 ? 'is' : 'are'} frozen but ${upgradeable.map(({ name, authority }) => `the ${name} is still upgradeable by ${authority}`).join(' and ')}`,
    };
}

// ---------------------------------------------------------------------------------------------
// R2-B: every contained mint ever recorded still has its config
// ---------------------------------------------------------------------------------------------

/** Each recorded mint and the records that name it, in the order given. */
export function recordedMints(sources: { source: string; mints: string[] }[]): Map<string, string[]> {
    const recorded = new Map<string, string[]>();
    for (const { source, mints } of sources) {
        for (const mint of mints) {
            const named = recorded.get(mint) ?? [];
            if (!named.includes(source)) named.push(source);
            recorded.set(mint, named);
        }
    }
    return recorded;
}

/**
 * A refusal for each recorded mint without a config in the census: an upgraded hook could repoint
 * a mint's hook fields and close its config, which a census of live configs alone would not see.
 */
export function missingRecorded(recorded: Map<string, string[]>, configMints: Set<string>): string[] {
    return [...recorded]
        .filter(([mint]) => !configMints.has(mint))
        .map(([mint, sources]) => `mint ${mint}, recorded in ${sources.join(' and ')}, has no config in the census`);
}

/** The contained mints `launch.ts` recorded in deployments/<cluster>-demo-containment-hook.json. */
export function mintsOfDemoRecord(record: { record?: unknown }): string[] {
    const rows = Array.isArray(record.record) ? record.record : [];
    return rows.filter((row): row is [string, string] => Array.isArray(row) && row[0] === 'mint' && typeof row[1] === 'string').map((row) => row[1]);
}

/** The mints of the configs a release gate report (deployments/release-gate/containment-hook/*.json) read. */
export function mintsOfGateReport(report: { configs?: unknown }): string[] {
    const configs = Array.isArray(report.configs) ? report.configs : [];
    return configs.map((config) => (config as { mint?: unknown }).mint).filter((mint): mint is string => typeof mint === 'string');
}

/**
 * The mints of the hook configs in a release gate snapshot folder's account files (the solana CLI's
 * account JSON; the committed fixture tests/fixtures/release-gate/devnet/): accounts the hook owns
 * of a config's 237 bytes, the mint at offset 9. Files that are not account records are skipped.
 */
export function mintsOfSnapshot(records: unknown[], hook: string): string[] {
    const mints: string[] = [];
    for (const record of records) {
        const account = (record as { account?: { owner?: unknown; data?: unknown } }).account;
        if (!account || account.owner !== hook || !Array.isArray(account.data) || typeof account.data[0] !== 'string') continue;
        const data = new Uint8Array(Buffer.from(account.data[0], 'base64'));
        if (data.length === 237) mints.push(getAddressDecoder().decode(data.subarray(9, 41)));
    }
    return mints.sort();
}
