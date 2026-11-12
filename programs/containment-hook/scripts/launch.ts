// The containment hook's launch script: launches a contained token on its tax AMM home
// market (docs/spec/containment-hook.md, "Launch in v1"), step by step, building the market
// creation from the tax AMM's metadata.json with Pipeline's TypeScript SDK, as Aviary will,
// and reading the binding back with the generated client (client/):
//
//   1. check both programs are deployed and the tax AMM is registered with the router;
//   2. compute, before sending anything, every address the launch will use;
//   3. create the mint with the hook as its transfer hook and its unlock PDA as hook
//      authority, no freeze authority and no other extension, and mint the supply;
//   4. create the tax market with its tax on the quote mint and a fee account for each mint,
//      and `bind` with the goal and the deadline, in the same transaction when it fits
//      (measured each run), otherwise in the next one;
//   5. check the mint, and read back from the config exactly the market, market state,
//      vault, fee account, quote mint, goal and deadline expected.
//
// Seeding the market arrives with the tax AMM's seed; it comes after `bind`, which nothing
// can move the token before. Revoking the mint authority, an optional last step, must come
// after `bind` too. Deploy both programs and register the tax AMM first; docs/toolchain.md
// says how, on a local validator and on devnet.
//
// Usage, from this directory after `pnpm install` (docs/toolchain.md, "Containment hook"):
//
//   node launch.ts --cluster <localnet|devnet|URL> --launcher <keypair.json> \
//     --goal <quote-mint base units> --deadline <ISO 8601 time or Unix seconds> \
//     [--quote-mint <address>]
//
//   --cluster     localnet (http://127.0.0.1:8899), devnet, or an RPC URL of either; the
//                 cluster's genesis hash must be devnet's, or the URL a local validator's
//   --launcher    pays for everything, is the mint authority, signs `bind`, and is the
//                 market's seeder, tax authority and tax recipient
//   --goal        the unlock goal: tax the home market must collect, in quote-mint base
//                 units (lamports for wrapped SOL); required, no default
//   --deadline    the unlock deadline; required, no default; the hook refuses one that is
//                 not in the future or too far away
//   --quote-mint  the SPL Token mint the token trades against and its tax is taken in
//                 (default: wrapped SOL)
//
// On a local cluster the script airdrops the SOL the launcher needs; on devnet it never does
// (fund it with devnet-airdrop, docs/toolchain.md).

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
    address,
    addSignersToTransactionMessage,
    appendTransactionMessageInstructions,
    AccountRole,
    compressTransactionMessageUsingAddressLookupTables,
    createDefaultRpcTransport,
    createKeyPairSignerFromBytes,
    createSolanaRpcFromTransport,
    createTransactionMessage,
    generateKeyPairSigner,
    getAddressEncoder,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    getTransactionMessageSize,
    getTransactionMessageSizeLimit,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type Address,
    type Instruction,
    type KeyPairSigner,
    type Signature,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getInitializeMint2Instruction,
    getMintToInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import * as pipeline from '@pipeline-placeholder/sdk';

import {
    CONTAINMENT_HOOK_PROGRAM_ADDRESS,
    fetchConfig,
    findConfigPda,
    findExtraAccountMetasPda,
    findUnlockPda,
    getBindInstructionAsync,
} from './client/index.ts';
import { findVault0Pda, findVault1Pda, TAX_AMM_PROGRAM_ADDRESS } from '../../tax-amm/scripts/client/index.ts';

const TOKEN_2022_PROGRAM_ADDRESS = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const WRAPPED_SOL = address('So11111111111111111111111111111111111111112');
const DEFAULT_ADDRESS = address('11111111111111111111111111111111');

// The launch's own choices, in one place: the token and its home market. None of them is a
// policy value of the hook, whose limits live in its config module and are enforced on
// chain; the goal and the deadline are flags with no default (docs/spec/containment-hook.md,
// "Where its policy values live"). The contained token is the market's mint 0 and the quote
// mint its mint 1, which every tax is taken in.
const TOKEN = { decimals: 6, supply: 1_000_000_000_000_000n } as const;
const HOME_MARKET = {
    buyTaxBps: 300,
    sellTaxBps: 500,
    buyTaxRangeBps: [100, 800],
    sellTaxRangeBps: [0, 900],
    // All of the creator's part of the tax to the launcher; wrapped SOL cannot be burned.
    shares: [10_000, 0, 0, 0],
    burnShareBps: 0,
    // Prices the token against a virtual quote reserve until real quote liquidity arrives.
    virtualReserve: 30_000_000_000n,
} as const;
const CONTAINED_INDEX = 0;
const QUOTE_INDEX = 1;
// The most SOL the tax AMM's setup may spend on rent; the router returns the rest.
const MAX_CREATOR_LAMPORTS = 100_000_000n;
// What a local run airdrops when the launcher holds less.
const LOCAL_FUNDING = 10_000_000_000n;
// A Token-2022 mint with only the transfer hook extension: the base padded to a token
// account's length, the account type, then the extension's type, length and 64-byte value.
const HOOKED_MINT_SIZE = 165 + 1 + 4 + 64;
// Token-2022's `TransferHookExtension` instruction, and its `Initialize`.
const TRANSFER_HOOK_EXTENSION = 36;
const TRANSFER_HOOK_INITIALIZE = 0;

const LOCALNET_URL = 'http://127.0.0.1:8899';
const DEVNET_URL = 'https://api.devnet.solana.com';
const GENESIS_HASHES = {
    devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
    mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'];

const { values: options } = parseArgs({
    options: {
        cluster: { type: 'string' },
        launcher: { type: 'string' },
        goal: { type: 'string' },
        deadline: { type: 'string' },
        'quote-mint': { type: 'string', default: WRAPPED_SOL },
    },
    strict: true,
});

function usage(message: string): never {
    console.error(`${message}\n`);
    console.error(
        'Usage: node launch.ts --cluster <localnet|devnet|URL> --launcher <keypair.json> --goal <quote-mint base units> --deadline <ISO 8601 time or Unix seconds> [--quote-mint <address>]',
    );
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

/** `--goal`: a whole number of quote-mint base units. */
function parseGoal(goal: string | undefined): bigint {
    if (goal === undefined) usage('--goal is required: the tax the home market must collect for the unlock, in quote-mint base units');
    if (!/^\d+$/.test(goal)) usage(`--goal must be a whole number of quote-mint base units, not "${goal}"`);
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

const cluster = clusterUrl(options.cluster);
const launcherPath = options.launcher ?? usage('--launcher is required');
const unlockGoal = parseGoal(options.goal);
const unlockDeadline = parseDeadline(options.deadline);
const quoteMint = address(options['quote-mint']);
const onDevnet = !cluster.local;

const baseTransport = createDefaultRpcTransport({ url: cluster.url });
const retryingTransport = (async (...args: Parameters<typeof baseTransport>) => {
    for (let attempt = 0; ; attempt++) {
        try {
            return await baseTransport(...args);
        } catch (error) {
            if (attempt >= 8 || !String(error).includes('429')) throw error;
            await sleep(500 * 2 ** attempt);
        }
    }
}) as typeof baseTransport;
const rpc = createSolanaRpcFromTransport(retryingTransport);

const record: [string, string][] = [];

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function step(title: string) {
    console.log(`\n== ${title}`);
}

function info(message: string) {
    console.log(`   ${message}`);
}

function fail(message: string): never {
    console.error(`\nStopped: ${message}`);
    process.exit(1);
}

function explorer(kind: 'tx' | 'address', value: string) {
    return onDevnet ? `https://orbmarkets.io/${kind}/${value}?cluster=devnet` : value;
}

async function checkCluster() {
    const genesis = await rpc.getGenesisHash().send();
    if (genesis === GENESIS_HASHES.mainnet || genesis === GENESIS_HASHES.testnet) {
        fail(`${cluster.url} is ${genesis === GENESIS_HASHES.mainnet ? 'mainnet' : 'testnet'}; contained tokens launch only on devnet or a local validator`);
    }
    if (!cluster.local && genesis !== GENESIS_HASHES.devnet) {
        fail(`${cluster.url} is not devnet (genesis hash ${genesis}); contained tokens launch only on devnet or a local validator`);
    }
    info(`cluster: ${cluster.local ? 'a local validator' : 'devnet'} (genesis hash ${genesis})`);
}

async function loadKey(path: string): Promise<KeyPairSigner> {
    return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path, 'utf8'))));
}

async function waitFor(label: string, signature: Signature) {
    for (let i = 0; ; i++) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        const status = value[0];
        if (status?.err) fail(`${label} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))} (${explorer('tx', signature)})`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
        if (i > 120) fail(`${label}: not confirmed after 60 s (${explorer('tx', signature)})`);
        await sleep(500);
    }
}

/** A version 0 transaction message of `instructions`, paid for by `feePayer`. */
async function message(feePayer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[]) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    return pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => addSignersToTransactionMessage(extra, m),
    );
}

/** Sends a transaction and waits for confirmation by polling. */
async function send(label: string, feePayer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[] = []) {
    const signed = await signTransactionMessageWithSigners(await message(feePayer, instructions, extra));
    const signature = getSignatureFromTransaction(signed);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send();
    await waitFor(label, signature);
    info(`${label}: ${explorer('tx', signature)}`);
    record.push([label, signature]);
    return signature;
}

async function fundLocally(key: Address, amount: bigint) {
    const { value: balance } = await rpc.getBalance(key, { commitment: 'confirmed' }).send();
    if (balance >= amount) return;
    for (let attempt = 0; ; attempt++) {
        try {
            const signature = await rpc.requestAirdrop(key, lamports(amount - balance)).send();
            await waitFor('airdrop to the launcher', signature);
            info(`airdropped ${Number(amount - balance) / 1e9} SOL to the launcher`);
            return;
        } catch (error) {
            if (attempt >= 5) throw error;
            await sleep(2_000);
        }
    }
}

async function account(address: Address) {
    const { value } = await rpc.getAccountInfo(address, { encoding: 'base64', commitment: 'confirmed' }).send();
    return value && { owner: value.owner, executable: value.executable, data: new Uint8Array(Buffer.from(value.data[0], 'base64')) };
}

/** Token-2022's `InitializeTransferHook`: the hook authority and the hook program of `mint`. */
function initializeTransferHook(mint: Address, authority: Address, program: Address): Instruction {
    const encoder = getAddressEncoder();
    const data = new Uint8Array(2 + 32 + 32);
    data.set([TRANSFER_HOOK_EXTENSION, TRANSFER_HOOK_INITIALIZE]);
    data.set(encoder.encode(authority), 2);
    data.set(encoder.encode(program), 34);
    return {
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        accounts: [{ address: mint, role: AccountRole.WRITABLE }],
        data,
    };
}

async function main() {
    const launcher = await loadKey(launcherPath);
    const hookProgram = CONTAINMENT_HOOK_PROGRAM_ADDRESS;
    const taxAmm = TAX_AMM_PROGRAM_ADDRESS;
    console.log(`Pipeline router ${pipeline.PIPELINE_PROGRAM_ADDRESS} on ${cluster.url}`);
    console.log(`Containment hook ${hookProgram}, tax AMM ${taxAmm}`);
    console.log(`Launcher ${launcher.address}`);
    console.log(`Unlock goal ${unlockGoal} quote-mint base units, unlock deadline ${new Date(Number(unlockDeadline) * 1000).toISOString()} (${unlockDeadline})`);
    await checkCluster();
    if (cluster.local) {
        step('0. Funding the launcher on the local validator');
        await fundLocally(launcher.address, LOCAL_FUNDING);
    }

    step('1. Checking the programs');
    for (const [name, program] of [['containment hook', hookProgram], ['tax AMM', taxAmm]] as const) {
        const deployed = await pipeline.inspectProgram(rpc, program, { hashExecutable: false });
        if (!deployed.deployed) fail(`the ${name} is not deployed at ${program}. Deploy it first (docs/toolchain.md).`);
        info(`${name}: deployed (${deployed.loader} loader), upgrade authority ${deployed.upgradeAuthority ?? 'none'}`);
    }
    if (!(await account(await pipeline.strategyPda(taxAmm)))) {
        fail('the tax AMM is not registered with the router on this cluster; register it first (the tax AMM\'s demo does, docs/toolchain.md)');
    }
    info('the tax AMM is registered with the router');
    const quote = await account(quoteMint);
    if (quote?.owner !== TOKEN_PROGRAM_ADDRESS) fail(`the quote mint ${quoteMint} is not an SPL Token mint on this cluster`);
    const metadata = pipeline.parseStrategyMetadata(
        JSON.parse(readFileSync(new URL('../../tax-amm/metadata.json', import.meta.url), 'utf8')),
    );
    if (!metadata.ok || !metadata.value.init) fail("the tax AMM's metadata.json has no valid `init` form");
    const init = metadata.value.init;
    // The hook enforces the terms; these two checks only stop a launch that would leave an
    // unbound mint behind. The longest deadline is the hook's alone to check.
    if (unlockGoal === 0n) fail('--goal must be above zero');
    const clusterTime = await rpc.getBlockTime(await rpc.getSlot({ commitment: 'confirmed' }).send()).send();
    if (clusterTime !== null && unlockDeadline <= clusterTime) {
        fail(`--deadline must be later than the cluster's time, ${new Date(Number(clusterTime) * 1000).toISOString()}`);
    }

    step('2. Computing every address the launch will use, before sending anything');
    const mintKey = await generateKeyPairSigner();
    const mint = mintKey.address;
    const [unlock] = await findUnlockPda({ mint });
    const [config] = await findConfigPda({ mint });
    const [validation] = await findExtraAccountMetasPda({ mint });
    const [holder] = await findAssociatedTokenPda({ owner: launcher.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const marketStateKey = await generateKeyPairSigner();
    const marketState = marketStateKey.address;
    const market = await pipeline.marketPda(taxAmm, marketState);
    const mints = [
        { mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
        { mint: quoteMint, tokenProgram: TOKEN_PROGRAM_ADDRESS },
    ];
    const feeAccounts = await Promise.all(mints.map(({ mint, tokenProgram }) => pipeline.feeAccountPda(market, mint, tokenProgram)));
    const [vault0] = await findVault0Pda({ marketState, mint0: mint });
    const [vault1] = await findVault1Pda({ marketState, mint1: quoteMint });
    const vaults = [vault0, vault1];
    const computed: [string, Address][] = [
        ['contained mint', mint],
        ['unlock PDA', unlock],
        ['config', config],
        ['validation account', validation],
        ['launcher token account', holder],
        ['router market', market],
        ['market state', marketState],
        ['vault, contained', vaults[CONTAINED_INDEX]!],
        ['vault, quote', vaults[QUOTE_INDEX]!],
        ['fee account, contained', feeAccounts[CONTAINED_INDEX]!],
        ['fee account, quote', feeAccounts[QUOTE_INDEX]!],
    ];
    for (const [label, address] of computed) {
        if (await account(address)) fail(`the ${label} ${address} exists before the launch`);
        info(`${label.padEnd(23)} ${address}`);
    }

    step('3. Creating the mint with the hook, and minting the supply');
    const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(HOOKED_MINT_SIZE)).send();
    await send(
        'create the mint and mint the supply',
        launcher,
        [
            getCreateAccountInstruction({
                payer: launcher,
                newAccount: mintKey,
                lamports: rent,
                space: HOOKED_MINT_SIZE,
                programAddress: TOKEN_2022_PROGRAM_ADDRESS,
            }),
            initializeTransferHook(mint, unlock, hookProgram),
            getInitializeMint2Instruction(
                { mint, decimals: TOKEN.decimals, mintAuthority: launcher.address, freezeAuthority: null },
                { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
            ),
            await getCreateAssociatedTokenIdempotentInstructionAsync({
                payer: launcher,
                owner: launcher.address,
                mint,
                tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            }),
            getMintToInstruction(
                { mint, token: holder, mintAuthority: launcher, amount: TOKEN.supply },
                { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
            ),
        ],
        [mintKey],
    );

    step('4. Creating the home market with its fee accounts, and binding it');
    const recipients: Address[] = [launcher.address];
    while (recipients.length < HOME_MARKET.shares.length) recipients.push(DEFAULT_ADDRESS);
    const args: Record<string, number | bigint | Address> = {
        tax_side: QUOTE_INDEX,
        buy_tax_bps: HOME_MARKET.buyTaxBps,
        sell_tax_bps: HOME_MARKET.sellTaxBps,
        buy_tax_min_bps: HOME_MARKET.buyTaxRangeBps[0],
        buy_tax_max_bps: HOME_MARKET.buyTaxRangeBps[1],
        sell_tax_min_bps: HOME_MARKET.sellTaxRangeBps[0],
        sell_tax_max_bps: HOME_MARKET.sellTaxRangeBps[1],
        tax_authority: launcher.address,
        seeder: launcher.address,
        burn_share_bps: HOME_MARKET.burnShareBps,
        virtual_side: QUOTE_INDEX,
        virtual_reserve: HOME_MARKET.virtualReserve,
    };
    recipients.forEach((recipient, i) => (args[`recipient_${i}`] = recipient));
    HOME_MARKET.shares.forEach((share, i) => (args[`share_${i}`] = share));
    const { instruction: createMarket, resolved } = await pipeline.buildCreateMarketFromMetadata({
        init,
        strategyProgram: taxAmm,
        creator: launcher.address,
        marketState,
        args,
        inputs: { mint_0: mint, mint_1: quoteMint },
        tokenPrograms: Object.fromEntries(mints.map(({ mint, tokenProgram }) => [mint, tokenProgram])),
        maxCreatorLamports: MAX_CREATOR_LAMPORTS,
        rpc,
    });
    if (resolved.market !== market) fail('the SDK resolved a different market');
    const initFeeAccounts = await Promise.all(
        mints.map(({ mint, tokenProgram }) => pipeline.initFeeAccount({ payer: launcher.address, market, mint, tokenProgram })),
    );
    const bind = await getBindInstructionAsync({
        mintAuthority: launcher,
        payer: launcher,
        mint,
        market,
        marketState,
        unlockGoal,
        unlockDeadline,
    });
    const creation = [createMarket, ...initFeeAccounts];
    let bindSent = false;
    const together = await message(launcher, [...creation, bind], [marketStateKey]);
    const size = getTransactionMessageSize(together);
    const limit = getTransactionMessageSizeLimit(together);
    const alone = getTransactionMessageSize(await message(launcher, creation, [marketStateKey]));
    // With an address lookup table holding every account that does not sign, which would
    // cost a transaction of its own to create and a slot to wait before it can be used.
    const lookup = [...new Set([...creation, bind].flatMap((ix) => [ix.programAddress, ...(ix.accounts ?? []).map((a) => a.address)]))]
        .filter((key) => ![launcher.address, marketStateKey.address].includes(key));
    const withTable = getTransactionMessageSize(
        compressTransactionMessageUsingAddressLookupTables(together, { [DEFAULT_ADDRESS]: lookup }),
    );
    info(`the market's creation is ${alone} bytes; with bind, ${size} of the ${limit} a transaction may hold, ${withTable} with a lookup table`);
    if (size <= limit) {
        record.push(['bind in the creation transaction', `yes: ${size} of ${limit} bytes`]);
        await send('create_market + init_fee_account x2 + bind', launcher, [...creation, bind], [marketStateKey]);
    } else {
        record.push(['bind in the creation transaction', `no: ${size} of ${limit} bytes (${withTable} with a lookup table), so bind went in the next one`]);
        info('bind does not fit, so it goes in the next transaction, before the seed');
        await send('create_market + init_fee_account x2', launcher, creation, [marketStateKey]);
        process.on('exit', (code) => {
            if (code !== 0 && !bindSent) {
                console.error(`The market ${market} exists and the mint ${mint} is not bound: send bind again with valid terms.`);
            }
        });
        await send('bind', launcher, [bind]);
        bindSent = true;
    }
    record.push(['mint', mint], ['market', market], ['market state', marketState], ['config', config]);

    step('5. Checking the mint and reading the binding back');
    const mintAccount = await account(mint);
    const decoded = mintAccount && pipeline.decodeMint(mint, TOKEN_2022_PROGRAM_ADDRESS, mintAccount.data);
    if (!decoded) fail(`no mint at ${mint}`);
    if (decoded.extensionTypes.join() !== '14') fail(`the mint carries extensions ${decoded.extensionTypes.join(', ')}, not only the transfer hook`);
    if (decoded.extensions.transferHook?.programId !== hookProgram || decoded.extensions.transferHook.authority !== unlock) {
        fail(`the mint's transfer hook is ${JSON.stringify(decoded.extensions.transferHook)}`);
    }
    if (decoded.freezeAuthority !== null || decoded.mintAuthority !== launcher.address) {
        fail(`the mint's freeze authority is ${decoded.freezeAuthority} and its mint authority ${decoded.mintAuthority}`);
    }
    if (decoded.supply !== TOKEN.supply) fail(`the supply is ${decoded.supply}, not ${TOKEN.supply}`);
    info(`mint: Token-2022, only the transfer hook extension (program ${hookProgram}, authority the unlock PDA), no freeze authority, supply ${decoded.supply}`);
    info(`trust flags: ${decoded.flags.join(', ')}`);

    const validationAccount = await account(validation);
    if (validationAccount?.owner !== hookProgram) fail(`the validation account ${validation} is not the hook's`);
    const { data: bound } = await fetchConfig(rpc, config, { commitment: 'confirmed' });
    const expected = {
        mint,
        market,
        marketState,
        vault: vaults[CONTAINED_INDEX]!,
        feeAccount: feeAccounts[CONTAINED_INDEX]!,
        quoteMint,
        unlockGoal,
        unlockDeadline,
    };
    const readBack = {
        mint: bound.mint,
        market: bound.market,
        marketState: bound.marketState,
        vault: bound.vault,
        feeAccount: bound.feeAccount,
        quoteMint: bound.quoteMint,
        unlockGoal: bound.unlockGoal,
        unlockDeadline: bound.unlockDeadline,
    };
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
        if (String(expected[key]) !== String(readBack[key])) fail(`the config's ${key} is ${readBack[key]}, but ${expected[key]} was expected`);
        info(`${key.padEnd(14)} ${readBack[key]}`);
    }
    if (bound.unlockedAt.__option !== 'None') fail('the config says the token is already unlocked');
    info(`bound at ${new Date(Number(bound.boundAt) * 1000).toISOString()}; not unlocked`);
    record.push(['config read back', 'market, market state, vault, fee account, quote mint, goal and deadline as expected']);

    step(`Done on ${cluster.url}`);
    const width = Math.max(...record.map(([label]) => label.length));
    for (const [label, value] of record) info(`${label.padEnd(width)}  ${value}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
