// The containment hook's freeze gate (docs/spec/containment-hook.md, "Upgrade policy"; HOOK-51,
// answer 7a on #74, hardening findings H016 to H018). One key upgrades both the hook and the tax
// AMM. An upgraded hook could sign as any contained mint's unlock PDA and repoint its transfer
// hook, which a later freeze would not undo, and an upgraded tax AMM could forge the tax counter
// the unlock reads; so before mainnet both are frozen together, and every contained mint is
// checked before and after. The gate:
//
//   1. reads every account the hook owns on the cluster: each must be a config (237 bytes with
//      the Config discriminator, at its config PDA ["config", mint]) or the validation account
//      ["extra-account-metas", mint] of one;
//   2. for each config checks what it says against the chain, as `bind` checked and wrote it
//      (freeze.ts, judgeConfig; R2T-07, R2T-08): version 1, its market a router Market at its
//      PDA running on --tax-amm, its market state the Market's and owned by --tax-amm, its vault
//      the Market's for the mint, its fee account the router's for it, its quote mint the other
//      mint, a goal above zero, a deadline after the binding and at most MAX_UNLOCK_DEADLINE_SECS
//      after it, canonical bumps, an unlock time not before the binding, and its validation
//      account holding exactly the hook's VALIDATION_DATA;
//   3. for each config reads its mint's transfer hook extension, and refuses unless, while the
//      config's unlocked_at is none, the hook program is the hook and the hook authority the
//      mint's unlock PDA ["unlock", mint], or, once unlocked_at is set, both are unset
//      (freeze.ts, judgeMint);
//   4. refuses unless every contained mint ever recorded still has its config in the census
//      (R2-B): on devnet the mints of deployments/devnet-demo-containment-hook.json, of the
//      release gate's committed fixture (tests/fixtures/release-gate/devnet/) and of
//      deployments/release-gate/containment-hook/devnet*.json; on a local validator those of
//      --mints, when given;
//   5. reads both programs' upgrade authorities, deploy slots and executable hashes from their
//      program data accounts, and refuses unless each hash is the one deployments/devnet.json
//      records for it (on a local validator, --expect-hook-hash and --expect-tax-amm-hash, which
//      default to those records and are required with --freeze; R2T-08), and unless the two are
//      upgradeable or frozen together (freeze.ts, judgePrograms; R2T-09);
//   6. with `--freeze`, and only when steps 1 to 5 passed, reads both program data accounts again
//      immediately before signing and refuses if either's deploy slot or hash moved, then sends
//      ONE transaction with two BPF upgradeable loader `SetAuthority` instructions removing both
//      upgrade authorities, each signed by its current authority, then runs steps 1 to 5 again,
//      and refuses unless both programs have no upgrade authority and every mint holds.
//
// On devnet it runs as a check only, and reports both programs still upgradeable: the bar keeps
// devnet programs upgradeable, so `--freeze` is refused there. It is allowed on a local
// validator, to rehearse the mainnet freeze. It refuses mainnet and testnet outright until the
// mainnet launch effort, out of scope here, extends it.
//
// Usage, from this directory after `pnpm install`:
//
//   node freeze-gate.ts --cluster <localnet|devnet|URL> [--hook <id>] [--tax-amm <id>] \
//     [--expect-hook-hash <hex> --expect-tax-amm-hash <hex>] [--mints <mints.json>] \
//     [--freeze --authority <keypair.json> [--authority <keypair.json>] [--payer <keypair.json>]]
//
//   --cluster    localnet (http://127.0.0.1:8899), devnet, or an RPC URL of either; the RPC must
//                serve getProgramAccounts (the public devnet RPC does, Alchemy's free tier does not)
//   --hook       the containment hook's program id (default: deployments/devnet.json's)
//   --tax-amm    the tax AMM's program id (default: deployments/devnet.json's)
//   --expect-hook-hash, --expect-tax-amm-hash
//                each program's expected executable hash (solana-verify get-program-hash); local
//                only, required with --freeze (default: deployments/devnet.json's)
//   --mints      a JSON list of contained mints that must each still have a config; local only
//   --freeze     after the check passes, remove both programs' upgrade authorities; local only
//   --authority  the current upgrade authority's keypair; give it twice when the two programs
//                have different authorities
//   --payer      pays the transaction fee (default: the first --authority); on a local
//                validator it is airdropped what it needs
//
// It exits 0 when everything holds, 1 on any refusal, and 2 on a usage error.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
    address,
    addSignersToTransactionMessage,
    appendTransactionMessageInstructions,
    createKeyPairSignerFromBytes,
    createSolanaRpc,
    createTransactionMessage,
    fetchEncodedAccount,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type Address,
    type KeyPairSigner,
    type Signature,
} from '@solana/kit';
import { decodeMint, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

import { CONFIG_DISCRIMINATOR, findConfigPda, findExtraAccountMetasPda, findUnlockPda, getConfigDecoder } from './client/index.ts';
import {
    BPF_UPGRADEABLE_LOADER,
    chainFacts,
    configFields,
    deploySlotOf,
    executableHash,
    freezeInstruction,
    judgeConfig,
    judgeMint,
    judgePrograms,
    mintsOfDemoRecord,
    mintsOfGateReport,
    mintsOfSnapshot,
    missingRecorded,
    programDataAddressOf,
    recordedMints,
    upgradeAuthorityOf,
    UNSET,
    type MintHook,
} from './freeze.ts';

// The v1 config's size with its discriminator and the validation account's size
// (programs/containment-hook/src/state.rs, pinned by tests/release_gate.rs and tests/layout.rs).
const CONFIG_LEN = 237;
const CONFIG_VERSION = 1;
const VALIDATION_LEN = 51;

const LOCALNET_URL = 'http://127.0.0.1:8899';
const DEVNET_URL = 'https://api.devnet.solana.com';
const GENESIS_HASHES = {
    devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
    mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'];
// What the fee payer needs on a local validator, airdropped when it holds less.
const LOCAL_PAYER_LAMPORTS = 1_000_000_000n;
const DEVNET_FREEZE_REFUSED = '--freeze is refused on devnet: the bar keeps devnet programs upgradeable (docs/spec/README.md); run the check alone there, and rehearse the freeze on a local validator';

const { values: options } = parseArgs({
    options: {
        cluster: { type: 'string' },
        hook: { type: 'string' },
        'tax-amm': { type: 'string' },
        freeze: { type: 'boolean', default: false },
        authority: { type: 'string', multiple: true },
        payer: { type: 'string' },
        'expect-hook-hash': { type: 'string' },
        'expect-tax-amm-hash': { type: 'string' },
        mints: { type: 'string' },
    },
    strict: true,
});

function usage(message: string): never {
    console.error(`${message}\n`);
    console.error('Usage: node freeze-gate.ts --cluster <localnet|devnet|URL> [--hook <id>] [--tax-amm <id>] [--expect-hook-hash <hex> --expect-tax-amm-hash <hex>] [--mints <mints.json>] [--freeze --authority <keypair.json> [--authority <keypair.json>] [--payer <keypair.json>]]');
    process.exit(2);
}

function clusterUrl(cluster: string | undefined): { url: string; local: boolean } {
    if (!cluster) usage('--cluster is required');
    if (cluster === 'localnet') return { url: LOCALNET_URL, local: true };
    if (cluster === 'devnet') return { url: DEVNET_URL, local: false };
    let host: string;
    try {
        host = new URL(cluster).hostname;
    } catch {
        usage(`--cluster must be localnet, devnet or an RPC URL, not "${cluster}"`);
    }
    return { url: cluster, local: LOCAL_HOSTS.includes(host) };
}

function programId(flag: string, value: string | undefined, fallback: string): Address {
    const id = value ?? fallback;
    try {
        return address(id);
    } catch {
        usage(`--${flag} must be a program id, not "${id}"`);
    }
}

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(here, '../../..');
const devnetRecord = JSON.parse(readFileSync(join(ROOT, 'deployments/devnet.json'), 'utf8'));
const cluster = clusterUrl(options.cluster);
const hook = programId('hook', options.hook, devnetRecord.programs['containment-hook'].programId);
const taxAmm = programId('tax-amm', options['tax-amm'], devnetRecord.programs['tax-amm'].programId);
if (hook === taxAmm) usage('--hook and --tax-amm must be two programs');
if (options.freeze && !options.authority?.length) usage('--freeze needs --authority, the current upgrade authority of both programs');
if (!options.freeze && (options.authority || options.payer)) usage('--authority and --payer are only for --freeze');
if (!cluster.local && (options['expect-hook-hash'] || options['expect-tax-amm-hash'] || options.mints)) {
    usage('--expect-hook-hash, --expect-tax-amm-hash and --mints are for a local validator; devnet is checked against the deployments records');
}
if (options.freeze && (!options['expect-hook-hash'] || !options['expect-tax-amm-hash'])) {
    usage('--freeze needs --expect-hook-hash and --expect-tax-amm-hash, the executable hashes of the reviewed builds it may freeze');
}
for (const flag of ['expect-hook-hash', 'expect-tax-amm-hash'] as const) {
    const value = options[flag];
    if (value !== undefined && !/^[0-9a-f]{64}$/.test(value)) usage(`--${flag} must be a SHA-256 in hex, not "${value}"`);
}
/** Each program's expected executable hash (R2T-08). */
const expectedHash = {
    hook: options['expect-hook-hash'] ?? (devnetRecord.programs['containment-hook'].executableHash as string),
    taxAmm: options['expect-tax-amm-hash'] ?? (devnetRecord.programs['tax-amm'].executableHash as string),
};

const rpc = createSolanaRpc(cluster.url);

/** Why the gate refused; `main` prints it and exits 1. */
class Refused extends Error {}

function refuse(message: string): never {
    throw new Refused(message);
}

const show = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/** Which cluster this is; mainnet and testnet are refused, and so is a remote URL that is not devnet. */
async function checkCluster(): Promise<'devnet' | 'local'> {
    const genesis = await rpc.getGenesisHash().send();
    if (genesis === GENESIS_HASHES.mainnet || genesis === GENESIS_HASHES.testnet) {
        refuse(`${cluster.url} is ${genesis === GENESIS_HASHES.mainnet ? 'mainnet' : 'testnet'}; the freeze gate runs only on devnet or a local validator until the mainnet launch extends it`);
    }
    if (genesis === GENESIS_HASHES.devnet) return 'devnet';
    if (!cluster.local) refuse(`${cluster.url} is not devnet (genesis hash ${genesis}) and not a local validator`);
    return 'local';
}

type MintRow = { mint: Address; config: Address; state: string; hookProgram: string; hookAuthority: string; verdict: string; ok: boolean };

/**
 * Steps 1 and 2: every account the hook owns, and each config's mint judged against it.
 * Returns one row per config and the refusals, which name the mint or the account.
 */
async function checkMints(recorded: Map<string, string[]>): Promise<{ rows: MintRow[]; refusals: string[] }> {
    const owned = await rpc.getProgramAccounts(hook, { encoding: 'base64', commitment: 'confirmed' }).send();
    const refusals: string[] = [];
    const configs: { address: Address; data: Uint8Array }[] = [];
    const validations = new Set<string>();
    const validationData = new Map<string, Uint8Array>();
    for (const { pubkey, account } of owned) {
        const data = new Uint8Array(Buffer.from(account.data[0], 'base64'));
        const discriminated = data.length >= 8 && CONFIG_DISCRIMINATOR.every((byte, i) => data[i] === byte);
        if (data.length === CONFIG_LEN && discriminated) configs.push({ address: pubkey, data });
        else if (data.length === VALIDATION_LEN) {
            validations.add(pubkey);
            validationData.set(pubkey, data);
        }
        else refusals.push(`account ${pubkey}, owned by the hook, is neither a config nor a validation account (${data.length} bytes)`);
    }
    const rows: MintRow[] = [];
    const decoder = getConfigDecoder();
    for (const { address: configAddress, data } of configs.sort((a, b) => a.address.localeCompare(b.address))) {
        const config = decoder.decode(data);
        const { mint } = config;
        const row = (fields: Omit<MintRow, 'mint' | 'config'>) => rows.push({ mint, config: configAddress, ...fields });
        const fail = (reason: string, state = '-') => {
            refusals.push(`mint ${mint} (config ${configAddress}): ${reason}`);
            row({ state, hookProgram: '-', hookAuthority: '-', verdict: 'REFUSED (below)', ok: false });
        };
        if (config.version !== CONFIG_VERSION) {
            fail(`config version ${config.version}, while the gate reads version ${CONFIG_VERSION}`);
            continue;
        }
        const [expectedConfig] = await findConfigPda({ mint }, { programAddress: hook });
        if (expectedConfig !== configAddress) {
            fail(`the config is not at the mint's config PDA ${expectedConfig}`);
            continue;
        }
        const [validation] = await findExtraAccountMetasPda({ mint }, { programAddress: hook });
        if (!validations.delete(validation)) {
            fail(`no validation account at ${validation}`);
            continue;
        }
        const unlockedAt = config.unlockedAt.__option === 'Some' ? config.unlockedAt.value : null;
        const state = unlockedAt === null ? 'contained' : `unlocked ${new Date(Number(unlockedAt) * 1000).toISOString().replace('.000', '')}`;
        // What the config says, against the chain (R2T-07, R2T-08).
        const market = await fetchEncodedAccount(rpc, config.market, { commitment: 'confirmed' });
        const marketState = await fetchEncodedAccount(rpc, config.marketState, { commitment: 'confirmed' });
        const chain = await chainFacts({
            hook,
            taxAmm,
            mint,
            market: market.exists ? { owner: market.programAddress, data: new Uint8Array(market.data) } : null,
            marketStateOwner: marketState.exists ? marketState.programAddress : null,
            validationData: validationData.get(validation) ?? null,
        });
        const problems = judgeConfig(configFields(config), chain);
        if (problems.length > 0) {
            fail(problems.join('; '), state);
            continue;
        }
        const encoded = await fetchEncodedAccount(rpc, mint, { commitment: 'confirmed' });
        if (!encoded.exists) {
            fail('the mint does not exist', state);
            continue;
        }
        if (encoded.programAddress !== TOKEN_2022_PROGRAM_ADDRESS) {
            fail(`the mint is owned by ${encoded.programAddress}, not Token-2022`, state);
            continue;
        }
        let mintHook: MintHook;
        try {
            const extensions = decodeMint(encoded).data.extensions;
            const extension = extensions.__option === 'Some' ? extensions.value.find((e) => e.__kind === 'TransferHook') : undefined;
            mintHook = extension?.__kind === 'TransferHook' ? { programId: extension.programId, authority: extension.authority } : undefined;
        } catch (error) {
            fail(`the mint does not decode: ${error instanceof Error ? error.message : String(error)}`, state);
            continue;
        }
        const [unlockPda] = await findUnlockPda({ mint }, { programAddress: hook });
        const verdict = judgeMint({ hook, unlockPda, mintHook, unlockedAt });
        const named = (value: string | undefined) => (value === undefined ? '-' : value === hook ? 'the hook' : value === unlockPda ? 'unlock PDA' : value === UNSET ? 'unset' : value);
        if (!verdict.ok) refusals.push(`mint ${mint} (config ${configAddress}): ${verdict.reason}`);
        row({ state, hookProgram: named(mintHook?.programId), hookAuthority: named(mintHook?.authority), verdict: verdict.ok ? 'ok' : 'REFUSED (below)', ok: verdict.ok });
    }
    for (const orphan of [...validations].sort()) refusals.push(`account ${orphan}, owned by the hook, is a validation account with no config`);
    // Every contained mint ever recorded must still have its config (R2-B, R2T-09).
    const censused = new Set<string>();
    for (const { data } of configs) censused.add(decoder.decode(data).mint);
    for (const refusal of missingRecorded(recorded, censused)) {
        const mint = refusal.split(' ')[1]! as Address;
        const [configPda] = await findConfigPda({ mint }, { programAddress: hook });
        const exists = (await fetchEncodedAccount(rpc, configPda, { commitment: 'confirmed' })).exists;
        refusals.push(`${refusal} (its config PDA ${configPda} ${exists ? 'exists, so the census missed it' : 'does not exist'})`);
    }
    return { rows, refusals };
}

type ProgramState = { name: string; id: Address; programData: Address; authority: Address | null; slot: bigint; hash: string; expectedHash: string };

/** Step 5: a program's program data account, its upgrade authority, deploy slot and executable hash. */
async function readProgram(name: string, id: Address, expected: string): Promise<ProgramState> {
    const program = await fetchEncodedAccount(rpc, id, { commitment: 'confirmed' });
    if (!program.exists) refuse(`the ${name} ${id} is not deployed on ${cluster.url}`);
    if (program.programAddress !== BPF_UPGRADEABLE_LOADER || !program.executable) {
        refuse(`the ${name} ${id} is not a program of the BPF upgradeable loader (owner ${program.programAddress})`);
    }
    const programData = programDataAddressOf(new Uint8Array(program.data));
    const data = await fetchEncodedAccount(rpc, programData, { commitment: 'confirmed' });
    if (!data.exists || data.programAddress !== BPF_UPGRADEABLE_LOADER) refuse(`the ${name}'s program data account ${programData} is missing`);
    const bytes = new Uint8Array(data.data);
    return { name, id, programData, authority: upgradeAuthorityOf(bytes), slot: deploySlotOf(bytes), hash: executableHash(bytes), expectedHash: expected };
}

function printTable(headers: string[], rows: string[][]) {
    const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i]!.length)));
    const line = (cells: string[]) => `   ${cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ')}`;
    console.log(line(headers));
    console.log(line(widths.map((width) => '-'.repeat(width))));
    for (const row of rows) console.log(line(row));
}

/** Steps 1 to 3 with their tables; refuses on any mint refusal. */
async function check(title: string, recorded: Map<string, string[]>): Promise<ProgramState[]> {
    console.log(`\n== ${title}`);
    const { rows, refusals } = await checkMints(recorded);
    console.log(`\n   Hook configs (hook ${hook}): ${rows.length}`);
    printTable(
        ['mint', 'state', 'hook program', 'hook authority', 'verdict'],
        rows.map((row) => [row.mint, row.state, row.hookProgram, row.hookAuthority, row.verdict]),
    );
    const programs = [await readProgram('containment hook', hook, expectedHash.hook), await readProgram('tax AMM', taxAmm, expectedHash.taxAmm)];
    console.log('\n   Programs');
    printTable(
        ['program', 'id', 'deployed in slot', 'executable hash', 'upgrade authority'],
        programs.map(({ name, id, authority, slot, hash }) => [name, id, String(slot), hash, authority ?? 'none (frozen)']),
    );
    for (const { name, id, hash, expectedHash: expected } of programs) {
        if (hash !== expected) refusals.push(`the ${name} ${id} runs build ${hash}, not ${expected}, the build ${cluster.local ? 'given (or deployments/devnet.json records)' : 'deployments/devnet.json records'} (R2T-08)`);
    }
    const together = judgePrograms(programs);
    if (!together.ok) refusals.push(`${together.reason}; both are frozen together or not at all (HOOK-51, R2T-09)`);
    console.log(`\n   Recorded contained mints that must still have their configs: ${recorded.size}`);
    if (refusals.length > 0) refuse(`${refusals.length} refusal${refusals.length === 1 ? '' : 's'}:\n${refusals.map((r) => `  - ${r}`).join('\n')}`);
    const contained = rows.filter((r) => r.state === 'contained').length;
    console.log(`\n   All ${rows.length} hook configs agree with the chain and with their mints' transfer hook fields (${contained} contained, ${rows.length - contained} unlocked); all ${recorded.size} recorded contained mints have their configs; both programs run the expected builds.`);
    return programs;
}

async function loadKey(path: string): Promise<KeyPairSigner> {
    return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path, 'utf8'))));
}

async function landed(signature: Signature) {
    for (let i = 0; i < 120; i++) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        const status = value[0];
        if (status?.err) refuse(`the freeze transaction ${signature} failed: ${show(status.err)}`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    refuse(`the freeze transaction ${signature} was not confirmed after 60 s`);
}

/** Step 4: both programs frozen in one transaction, then everything checked again. */
async function freeze(programs: ProgramState[], where: 'devnet' | 'local', recorded: Map<string, string[]>) {
    if (where === 'devnet') {
        refuse(DEVNET_FREEZE_REFUSED);
    }
    const authorities = await Promise.all(options.authority!.map(loadKey));
    const signers = programs.map(({ name, id, authority }) => {
        if (authority === null) refuse(`the ${name} ${id} is already frozen; the gate freezes both programs together, so freeze the other one on its own deliberately`);
        const signer = authorities.find((key) => key.address === authority);
        if (!signer) refuse(`the ${name}'s upgrade authority is ${authority}, which no --authority holds (given: ${authorities.map((key) => key.address).join(', ')})`);
        return signer;
    });
    const payer = options.payer ? await loadKey(options.payer) : authorities[0]!;
    const { value: balance } = await rpc.getBalance(payer.address, { commitment: 'confirmed' }).send();
    if (balance < LOCAL_PAYER_LAMPORTS) {
        const airdrop = await rpc.requestAirdrop(payer.address, lamports(LOCAL_PAYER_LAMPORTS - balance)).send();
        await landed(airdrop);
    }

    // The bytes the check passed must be the bytes frozen: read both program data accounts again
    // immediately before signing, and refuse if either was redeployed since (R2T-08).
    for (const before of programs) {
        const now = await readProgram(before.name, before.id, before.expectedHash);
        if (now.slot !== before.slot || now.hash !== before.hash || now.authority !== before.authority) {
            refuse(`the ${before.name} changed since the check (deployed in slot ${now.slot}, build ${now.hash}, authority ${now.authority}; the check read slot ${before.slot}, build ${before.hash}, authority ${before.authority}); run the gate again`);
        }
    }

    console.log('\n== Freezing both programs in one transaction');
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const instructions = programs.map(({ programData }, i) => freezeInstruction(programData, signers[i]!.address));
    const signed = await signTransactionMessageWithSigners(
        pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
            (m) => appendTransactionMessageInstructions(instructions, m),
            // Each authority signs once, even when both programs share it.
            (m) => addSignersToTransactionMessage(signers, m),
        ),
    );
    const signature = getSignatureFromTransaction(signed);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send();
    await landed(signature);
    console.log(`   sent: ${signature}`);

    const after = await check('After the freeze: both programs and every contained mint again', recorded);
    const upgradeable = after.filter(({ authority }) => authority !== null);
    if (upgradeable.length > 0) refuse(`after the freeze, ${upgradeable.map(({ name, authority }) => `the ${name} is still upgradeable by ${authority}`).join(' and ')}`);
    console.log('\n   Both programs have no upgrade authority, and every contained mint holds: frozen.');
}

/**
 * The records of contained mints (R2-B): on devnet the launch record, the release gate's committed
 * fixture and its reports; on a local validator the --mints file, when given.
 */
function recordedSources(where: 'devnet' | 'local'): { source: string; mints: string[] }[] {
    const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
    if (where === 'local') {
        if (!options.mints) return [];
        const mints = JSON.parse(readFileSync(options.mints, 'utf8'));
        if (!Array.isArray(mints) || !mints.every((mint) => typeof mint === 'string')) usage(`--mints must be a JSON list of mints: ${options.mints}`);
        return [{ source: options.mints, mints: mints.map((mint) => address(mint)) }];
    }
    const sources = [];
    const demo = 'deployments/devnet-demo-containment-hook.json';
    if (existsSync(join(ROOT, demo))) sources.push({ source: demo, mints: mintsOfDemoRecord(json(demo)) });
    // The committed fixture: the configs its manifest lists when it has one, else every account file.
    const fixture = 'programs/containment-hook/tests/fixtures/release-gate/devnet';
    const manifest = join(ROOT, fixture, 'manifest.json');
    const files = existsSync(manifest)
        ? (json(`${fixture}/manifest.json`).configs as string[]).map((config) => `${config}.json`)
        : readdirSync(join(ROOT, fixture)).filter((name) => name.endsWith('.json'));
    sources.push({ source: `${fixture}/`, mints: mintsOfSnapshot(files.map((name) => json(`${fixture}/${name}`)), hook) });
    const reports = 'deployments/release-gate/containment-hook';
    if (existsSync(join(ROOT, reports))) {
        for (const name of readdirSync(join(ROOT, reports)).filter((name) => name.startsWith('devnet') && name.endsWith('.json')).sort()) {
            sources.push({ source: `${reports}/${name}`, mints: mintsOfGateReport(json(`${reports}/${name}`)) });
        }
    }
    return sources;
}

async function main() {
    const where = await checkCluster();
    console.log(`Freeze gate on ${where === 'devnet' ? 'devnet' : 'a local validator'} (${cluster.url}): hook ${hook}, tax AMM ${taxAmm}`);
    if (options.freeze && where === 'devnet') {
        refuse(DEVNET_FREEZE_REFUSED);
    }
    const recorded = recordedMints(recordedSources(where));
    const programs = await check('Before the freeze: every contained mint and both programs', recorded);
    if (!options.freeze) {
        const upgradeable = programs.filter(({ authority }) => authority !== null);
        console.log(
            upgradeable.length === 0
                ? '\n   Check passed; both programs are frozen.'
                : `\n   Check passed; ${upgradeable.map(({ name }) => `the ${name}`).join(' and ')} ${upgradeable.length === 1 ? 'is' : 'are'} still upgradeable${where === 'devnet' ? ', as the bar keeps devnet programs' : ''}. Nothing was sent.`,
        );
        return;
    }
    await freeze(programs, where, recorded);
}

main().catch((error) => {
    console.error(error instanceof Refused ? `\nRefused: ${error.message}` : error);
    process.exit(1);
});
