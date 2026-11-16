// The containment hook's launch script: launches contained tokens on their tax AMM home
// markets (docs/spec/containment-hook.md, "Launch in v1"), step by step, building each market
// creation from the tax AMM's metadata.json with Pipeline's TypeScript SDK, as Aviary will,
// and reading the binding back with the generated client (client/). Each `--goal` and
// `--deadline` pair launches one token, one after another in one run, each through every step
// below:
//
//   1. check both programs are deployed and the tax AMM is registered with the router;
//   2. compute, before sending anything, every address the launch will use;
//   3. create the mint with the hook as its transfer hook and its unlock PDA as hook
//      authority, no freeze authority and no other extension, and mint the supply;
//   4. create the tax market with its tax on the quote mint and a fee account for each mint,
//      and `bind` with the goal and the deadline, in the same transaction when it fits
//      (measured each run), otherwise in the next one;
//   5. check the mint, and read back from the config exactly the market, market state,
//      vault, fee account, quote mint, goal and deadline expected;
//   6. seed the market through the metadata's `seed` action, single-sided on its virtual
//      quote reserve, with the hook accounts after the action's own, and show in simulation
//      `unlock` refused while neither the goal nor the deadline is reached;
//   7. buy the token through the router with the SDK, the hook accounts after the strategy's
//      accounts, and stop unless the buy delivered its quote;
//   8. sell some of it back the same way, the hook accounts as the router's input hook
//      accounts, and stop unless it delivered its quote and Pipeline's fee, in the token,
//      went into the market's fee account;
//   9. sweep Pipeline's fee from the fee account to its treasury with the router's
//      `sweep_fees`, the hook accounts after its own, and stop unless the treasury got exactly
//      what the fee account held;
//  10. show, in simulation, the hook refusing a wallet-to-wallet `transfer_checked` and a sell
//      that carries an integrator fee above zero.
//
// With `--unlock`, it goes on to unlock the token (docs/spec/containment-hook.md, "Unlock"):
//
//  11. wait for the unlock to fall due: with `--unlock goal`, buy and sell back through the
//      router until the home market's `tax_collected` reaches the goal; with
//      `--unlock deadline`, wait until the cluster's clock reaches the deadline;
//  12. send `unlock` from a fresh wallet with no tie to the token, and stop unless it was
//      unlocked by what step 11 waited for, the mint's transfer hook program and hook
//      authority are both unset, the config records the unlock time, and a second `unlock`
//      is refused in simulation;
//  13. show the token free of the hook: a wallet-to-wallet `transfer_checked`, a buy and a
//      sell, each sent without hook accounts, all succeed without the hook running.
//
// The hook accounts (the config, the hook program and the validation account) are resolved
// from the validation account with Token-2022's own client, `resolveExtraAccountMetasForExecute`
// from @solana-program/token-2022, because neither Pipeline client resolves them. Revoking the mint authority, an optional last step, must come after `bind`. Deploy
// both programs and register the tax AMM first; docs/toolchain.md says how, on a local
// validator and on devnet.
//
// Usage, from this directory after `pnpm install` (docs/toolchain.md, "Containment hook"):
//
//   node launch.ts --cluster <localnet|devnet|URL> --launcher <keypair.json> \
//     --goal <quote-mint base units> --deadline <ISO 8601 time or Unix seconds> \
//     [--unlock <goal|deadline>] [--goal ... --deadline ... [--unlock ...]] \
//     [--quote-mint <address>]
//
//   --cluster     localnet (http://127.0.0.1:8899), devnet, or an RPC URL of either; the
//                 cluster's genesis hash must be devnet's, or the URL a local validator's
//   --launcher    pays for everything, is the mint authority, signs `bind`, is the market's
//                 seeder, tax authority and tax recipient, and makes the buy and the sell
//   --goal        the unlock goal: tax the home market must collect, in quote-mint base
//                 units (lamports for wrapped SOL); required, no default
//   --deadline    the unlock deadline; required, no default; the hook refuses one that is
//                 not in the future or too far away
//   --quote-mint  the SPL Token mint the token trades against and its tax is taken in
//                 (default: wrapped SOL)
//   --unlock      unlock the token after the launch, by the goal (the script trades until
//                 it is reached) or by the deadline (the script waits for it); without it,
//                 the script stops after step 10 and the token stays contained
//
// Giving `--goal` and `--deadline` again launches another token after the first, the nth of
// each flag being the nth token's; `--unlock` is then given for every token or for none. The
// rehearsal of the devnet launch gives two: one unlocked by a small goal, one by a short
// deadline (docs/toolchain.md, "Containment hook").
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
    type AccountMeta,
    type Address,
    type Instruction,
    type KeyPairSigner,
    type Signature,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getInitializeMint2Instruction,
    getMintToInstruction,
    getSyncNativeInstruction,
    getTransferCheckedInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { resolveExtraAccountMetasForExecute } from '@solana-program/token-2022';
import * as pipeline from '@pipeline-placeholder/sdk';

import {
    CONTAINMENT_HOOK_ERROR__ALREADY_UNLOCKED,
    CONTAINMENT_HOOK_ERROR__TRANSFER_REFUSED,
    CONTAINMENT_HOOK_ERROR__UNLOCK_NOT_DUE,
    CONTAINMENT_HOOK_PROGRAM_ADDRESS,
    fetchConfig,
    findConfigPda,
    findExtraAccountMetasPda,
    findUnlockPda,
    getBindInstructionAsync,
    getUnlockInstructionAsync,
    MAX_UNLOCK_DEADLINE_SECS,
} from './client/index.ts';
import { fetchTaxMarket, findAuthorityPda, findVault0Pda, findVault1Pda, MarketStatus, TAX_AMM_PROGRAM_ADDRESS } from '../../tax-amm/scripts/client/index.ts';

const TOKEN_2022_PROGRAM_ADDRESS = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const WRAPPED_SOL = address('So11111111111111111111111111111111111111112');
const DEFAULT_ADDRESS = address('11111111111111111111111111111111');
const U64_MAX = 2n ** 64n - 1n;

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
    // The seed: this much of the token, and no quote mint, which the virtual reserve prices.
    seed: [800_000_000_000_000n, 0n],
} as const;
// The trades the launch makes after the seed: a buy spending this many whole units of the
// quote mint (1 SOL with wrapped SOL), then a sell of half of what it bought; and the
// integrator fee of the sell the hook refuses.
const TRADES = { buyUnits: 1n, integratorFeeBps: 50 } as const;
// How `--unlock` waits for the unlock and sends it. By the goal, the script buys with
// `TRADES.buyUnits` and sells the same amount of the token back, round after round, and
// refuses up front a goal that would take more rounds than `maxGoalRounds`, counting only each
// round's buy tax; each round's cost is estimated as both taxes plus `roundMarginBps` for
// Pipeline's fees. By the deadline, it refuses up front a deadline less than
// `minDeadlineLeadSecs` away, which the launch's setup could outlast, or further than
// `maxDeadlineWaitSecs`, and a goal the launch's own buy and sell could reach, both taxes on
// the whole buy. The unlock is sent by a fresh wallet the launcher gives `unlockerLamports`,
// enough for its fee and a system account's rent.
const UNLOCKING = {
    maxGoalRounds: 10,
    roundMarginBps: 100n,
    minDeadlineLeadSecs: 60n,
    maxDeadlineWaitSecs: 600n,
    unlockerLamports: 2_000_000n,
} as const;
// What the launch's rents and fees may cost beyond the market's setup and the buy, which the
// launcher must hold before anything is sent, so a launch never stops halfway for want of SOL.
const RENT_AND_FEES = 200_000_000n;
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
        goal: { type: 'string', multiple: true },
        deadline: { type: 'string', multiple: true },
        'quote-mint': { type: 'string', default: WRAPPED_SOL },
        unlock: { type: 'string', multiple: true },
    },
    strict: true,
});

function usage(message: string): never {
    console.error(`${message}\n`);
    console.error(
        'Usage: node launch.ts --cluster <localnet|devnet|URL> --launcher <keypair.json> --goal <quote-mint base units> --deadline <ISO 8601 time or Unix seconds> [--unlock <goal|deadline>] [--goal ... --deadline ... [--unlock ...]] [--quote-mint <address>]',
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

const cluster = clusterUrl(options.cluster);
const launcherPath = options.launcher ?? usage('--launcher is required');
/** One token's terms: its `--goal`, its `--deadline` and its `--unlock`, if any. */
type Terms = { unlockGoal: bigint; unlockDeadline: bigint; unlockBy: 'goal' | 'deadline' | undefined };
const goals = options.goal ?? [];
const deadlines = options.deadline ?? [];
const unlocks = options.unlock ?? [];
if (goals.length === 0) parseGoal(undefined);
if (deadlines.length > goals.length) usage('give one --goal for each --deadline: each pair launches one token');
if (unlocks.length > 0 && unlocks.length !== goals.length) usage('give --unlock for every token or for none');
for (const unlock of unlocks) {
    if (unlock !== 'goal' && unlock !== 'deadline') usage(`--unlock must be goal or deadline, not "${unlock}"`);
}
const tokens: Terms[] = goals.map((goal, i) => ({
    unlockGoal: parseGoal(goal),
    unlockDeadline: parseDeadline(deadlines[i]),
    unlockBy: unlocks[i] as Terms['unlockBy'],
}));
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

/** Names the token being launched in each step's title, when the run launches several. */
let stepPrefix = '';

function step(title: string) {
    console.log(`\n== ${stepPrefix}${title}`);
}

function info(message: string) {
    console.log(`   ${message}`);
}

/** Why the launch stopped; `main` prints it and exits. */
class Stopped extends Error {}

function fail(message: string): never {
    throw new Stopped(message);
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

type Blockhash = Awaited<ReturnType<ReturnType<typeof rpc.getLatestBlockhash>['send']>>['value'];

async function latestBlockhash(): Promise<Blockhash> {
    return (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value;
}

/** A version 0 transaction message of `instructions`, paid for by `feePayer`. */
function message(feePayer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[], blockhash: Blockhash) {
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
    const signed = await signTransactionMessageWithSigners(message(feePayer, instructions, extra, await latestBlockhash()));
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

const show = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/** A token account's balance. */
async function tokenBalance(account: Address): Promise<bigint> {
    const { value } = await rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send();
    return BigInt(value.amount);
}

type HookAccountsFor = (source: Address, destination: Address, authority: Address) => Promise<AccountMeta[]>;

/**
 * The router's `swap` of `amount` of mint `input` for mint `output` by `trader`, built with
 * the SDK as a terminal builds it, with the contained token's hook accounts: after the
 * strategy's accounts when it is the output, which the tax AMM moves out of its vault, and as
 * the router's input hook accounts when it is the input, which the router moves into the
 * vault and, for its fee, into the fee account. Quoted at `confirmed`, the commitment the
 * launch confirms at.
 */
async function swapInstruction(
    trader: KeyPairSigner,
    view: pipeline.MarketView,
    input: number,
    output: number,
    amount: bigint,
    tokenHolder: Address,
    quoteHolder: Address,
    hookAccounts: HookAccountsFor,
    options: { integratorFeeAccount?: Address; integratorFeeBps?: number; minAmountOut?: bigint } = {},
) {
    const holders = input === CONTAINED_INDEX ? [tokenHolder, quoteHolder] : [quoteHolder, tokenHolder];
    const [traderInput, traderOutput] = holders as [Address, Address];
    const request = { mode: pipeline.TradeMode.ExactIn, inputIndex: input, outputIndex: output, amount, trader: trader.address, extra: new Uint8Array() };
    const simulation = { commitment: 'confirmed' } as const;
    const strategyAccounts = await pipeline.resolveAccounts(rpc, view, request, trader.address, simulation);
    const { quote } = await pipeline.quoteStrategy(rpc, view, request, strategyAccounts, trader.address, simulation);
    const buying = output === CONTAINED_INDEX;
    // On a buy the tax AMM pays out of its vault, signed by its vault authority.
    const tail = buying
        ? await hookAccounts(view.vaults[output]!, traderOutput, (await findAuthorityPda({ marketState: view.marketState }))[0])
        : await hookAccounts(traderInput, view.vaults[input]!, trader.address);
    const instruction = await pipeline.swap(
        {
            trader: trader.address,
            strategyProgram: view.strategyProgram,
            marketState: view.marketState,
            traderInput,
            traderOutput,
            inputVault: view.vaults[input]!,
            inputMint: view.mints[input]!,
            outputMint: view.mints[output]!,
            inputTokenProgram: view.tokenPrograms[input]!,
            outputTokenProgram: view.tokenPrograms[output]!,
            integratorFeeAccount: options.integratorFeeAccount ?? null,
            strategyAccounts: buying ? [...strategyAccounts, ...tail] : strategyAccounts,
            inputHookAccounts: buying ? [] : tail,
        },
        {
            mode: pipeline.TradeMode.ExactIn,
            amountIn: amount,
            amountOut: 0n,
            minAmountOut: options.minAmountOut ?? quote.amountOut,
            integratorFeeBps: options.integratorFeeBps ?? 0,
            extra: new Uint8Array(),
        },
    );
    return { instruction, quote, traderOutput };
}

/**
 * Swaps through the router with [`swapInstruction`], and stops unless the swap delivered its
 * quote; returns what it delivered, Pipeline's fee and what the hook's `Execute` cost on each
 * hooked transfer, from the transaction's logs.
 */
async function trade(
    trader: KeyPairSigner,
    view: pipeline.MarketView,
    input: number,
    output: number,
    amount: bigint,
    tokenHolder: Address,
    quoteHolder: Address,
    hookAccounts: HookAccountsFor,
    hooked = true,
) {
    const label = `swap ${amount} of ${input === CONTAINED_INDEX ? 'the token' : 'the quote mint'} for ${output === CONTAINED_INDEX ? 'the token' : 'the quote mint'}`;
    const { instruction, quote, traderOutput } = await swapInstruction(trader, view, input, output, amount, tokenHolder, quoteHolder, hookAccounts);
    info(`${label}: quoted ${quote.amountOut}`);
    const before = await tokenBalance(traderOutput);
    const signature = await send(label, trader, [instruction]);
    const received = (await tokenBalance(traderOutput)) - before;
    const tx = await rpc
        .getTransaction(signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        .send();
    if (!tx?.meta?.innerInstructions) fail(`transaction ${signature} not found`);
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    const event = pipeline.extractEventsFromInnerInstructions(keys, tx.meta.innerInstructions).find((candidate) => candidate.type === 'Swap');
    if (!event || event.type !== 'Swap') fail(`transaction ${signature} has no swap event`);
    if (received !== quote.amountOut || event.data.received !== quote.amountOut) {
        fail(`${label}: received ${received} (event: ${event.data.received}), quoted ${quote.amountOut}`);
    }
    const hookUnits = hookCompute(tx.meta.logMessages ?? []);
    // While contained, the hook runs on the vault's transfer of a buy, and on both of a sell's
    // transfers into the vault and the fee account; after the unlock, never.
    const expected = hooked ? (output === CONTAINED_INDEX ? 1 : 2) : 0;
    if (hookUnits.length !== expected) fail(`${label}: the hook ran ${hookUnits.length} times, not ${expected}`);
    const hook = hooked ? `the hook's Execute took ${hookUnits.join(' and ')} CU` : 'the hook did not run';
    info(`${label}: received exactly the quote, Pipeline's fee ${event.data.pipelineFee}; ${hook}`);
    return { received, pipelineFee: event.data.pipelineFee, hookUnits };
}

/** The compute units each invocation of the hook consumed, in order, from a transaction's logs. */
function hookCompute(logs: readonly string[]): number[] {
    const consumed = `Program ${CONTAINMENT_HOOK_PROGRAM_ADDRESS} consumed `;
    return logs.filter((line) => line.startsWith(consumed)).map((line) => Number(line.slice(consumed.length).split(' ')[0]));
}

/** Simulates `instruction` and returns whether it failed, with its logs. */
async function simulate(feePayer: KeyPairSigner, instruction: Instruction) {
    const signed = await signTransactionMessageWithSigners(message(feePayer, [instruction], [], await latestBlockhash()));
    const { value } = await rpc
        .simulateTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', commitment: 'confirmed' })
        .send();
    return { err: value.err, logs: value.logs ?? [] };
}

/** Whether `logs` show the hook failing with the error `name`, number `code`. */
function refusedByTheHook(logs: readonly string[], name: string, code: number) {
    return (
        logs.some((line) => line.includes(`Error Code: ${name}. Error Number: ${code}.`)) &&
        logs.some((line) => line.startsWith(`Program ${CONTAINMENT_HOOK_PROGRAM_ADDRESS} failed`))
    );
}

/** Simulates `instruction` and stops unless the hook refuses it with the error `name`. */
async function expectRefused(
    label: string,
    feePayer: KeyPairSigner,
    instruction: Instruction,
    [name, code]: [string, number] = ['TransferRefused', CONTAINMENT_HOOK_ERROR__TRANSFER_REFUSED],
) {
    const { err, logs } = await simulate(feePayer, instruction);
    if (!err || !refusedByTheHook(logs, name, code)) fail(`${label} was not refused by the hook: ${show(err)}\n${logs.join('\n')}`);
    info(`${label}: refused by the hook with ${name} (${code})`);
}

/** The cluster's clock, as the latest confirmed block's time. */
async function clusterTime(): Promise<bigint> {
    const time = await rpc.getBlockTime(await rpc.getSlot({ commitment: 'confirmed' }).send()).send();
    if (time === null) fail('the cluster did not give its time');
    return BigInt(time);
}

async function main() {
    const launcher = await loadKey(launcherPath);
    const hookProgram = CONTAINMENT_HOOK_PROGRAM_ADDRESS;
    const taxAmm = TAX_AMM_PROGRAM_ADDRESS;
    console.log(`Pipeline router ${pipeline.PIPELINE_PROGRAM_ADDRESS} on ${cluster.url}`);
    console.log(`Containment hook ${hookProgram}, tax AMM ${taxAmm}`);
    console.log(`Launcher ${launcher.address}`);
    for (const [i, { unlockGoal, unlockDeadline, unlockBy }] of tokens.entries()) {
        console.log(
            `Token ${i + 1}: unlock goal ${unlockGoal} quote-mint base units, unlock deadline ${new Date(Number(unlockDeadline) * 1000).toISOString()} (${unlockDeadline})${unlockBy ? `, unlocked by the ${unlockBy}` : ''}`,
        );
    }
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
    // The buy is sized in whole units of the quote mint; a mint's decimals are its byte 44.
    const buy = TRADES.buyUnits * 10n ** BigInt(quote.data[44]!);
    const buySpend = pipeline.maxTotalSpend(buy, 0) ?? fail('the buy overflows');
    const [quoteHolder] = await findAssociatedTokenPda({ owner: launcher.address, mint: quoteMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    // By the goal, the rounds of trades each token takes, counting only each round's buy tax,
    // and what they may cost: both taxes and Pipeline's fees on each round's buy.
    const buyTax = (buy * BigInt(HOME_MARKET.buyTaxBps)) / 10_000n;
    const goalRounds = tokens.map(({ unlockGoal, unlockBy }, i) => {
        if (unlockBy === 'goal') {
            if (buyTax === 0n) fail(`a buy of ${buy} base units of the quote mint pays no tax, so --unlock goal could never reach the goal; use --unlock deadline`);
            const rounds = Number((unlockGoal + buyTax - 1n) / buyTax);
            if (rounds > UNLOCKING.maxGoalRounds) {
                fail(`token ${i + 1}: --goal ${unlockGoal} would take about ${rounds} rounds of trades of ${buy} to collect, more than the ${UNLOCKING.maxGoalRounds} --unlock goal makes; give a smaller goal or use --unlock deadline`);
            }
            return rounds;
        }
        if (unlockBy === 'deadline') {
            const launchTax = (buy * BigInt(HOME_MARKET.buyTaxBps + HOME_MARKET.sellTaxBps)) / 10_000n;
            if (unlockGoal <= launchTax) {
                fail(`token ${i + 1}: --unlock deadline needs a goal the launch's own buy and sell cannot reach, above ${launchTax}, not ${unlockGoal}`);
            }
        }
        return 0;
    });
    const roundsCost = goalRounds.map(
        (rounds) => (BigInt(rounds) * buySpend * (BigInt(HOME_MARKET.buyTaxBps + HOME_MARKET.sellTaxBps) + UNLOCKING.roundMarginBps)) / 10_000n,
    );
    for (const [i, rounds] of goalRounds.entries()) {
        if (rounds > 0) info(`token ${i + 1}, --unlock goal: at most ${rounds} rounds of a buy of ${buy} and a sell back, costing about ${roundsCost[i]} of the quote mint`);
    }
    // Everything the launches spend is checked before anything is sent: a binding and a seed
    // cannot be undone, so a launch that ran out halfway would leave a market untraded.
    const quoteNeeded = tokens.reduce((sum, _, i) => sum + buySpend + roundsCost[i]!, 0n);
    let solNeeded = tokens.reduce(
        (sum, { unlockBy }) => sum + MAX_CREATOR_LAMPORTS + RENT_AND_FEES + (unlockBy ? UNLOCKING.unlockerLamports : 0n),
        0n,
    );
    if (quoteMint === WRAPPED_SOL) {
        solNeeded += quoteNeeded;
    } else {
        const held = (await account(quoteHolder)) ? await tokenBalance(quoteHolder) : 0n;
        if (held < quoteNeeded) fail(`the launcher's ${quoteMint} account ${quoteHolder} holds ${held}, but the trades need ${quoteNeeded} with Pipeline's fee`);
    }
    const { value: solHeld } = await rpc.getBalance(launcher.address, { commitment: 'confirmed' }).send();
    if (solHeld < solNeeded) fail(`the launcher holds ${Number(solHeld) / 1e9} SOL, but the launch needs ${Number(solNeeded) / 1e9}`);
    info(`the launcher holds ${Number(solHeld) / 1e9} SOL of the ${Number(solNeeded) / 1e9} the launch needs`);
    const metadata = pipeline.parseStrategyMetadata(
        JSON.parse(readFileSync(new URL('../../tax-amm/metadata.json', import.meta.url), 'utf8')),
    );
    if (!metadata.ok || !metadata.value.init) fail("the tax AMM's metadata.json has no valid `init` form");
    const init = metadata.value.init;
    // The hook enforces the terms; these checks only stop a launch that would leave an
    // unbound mint behind. The longest deadline is the hook's own constant, read from its IDL
    // through the client.
    const startTime = await clusterTime();
    for (const [i, { unlockGoal, unlockDeadline, unlockBy }] of tokens.entries()) {
        const which = tokens.length > 1 ? `token ${i + 1}: ` : '';
        if (unlockGoal === 0n) fail(`${which}--goal must be above zero`);
        if (unlockDeadline <= startTime) {
            fail(`${which}--deadline must be later than the cluster's time, ${new Date(Number(startTime) * 1000).toISOString()}`);
        }
        if (unlockDeadline > startTime + MAX_UNLOCK_DEADLINE_SECS) {
            fail(`${which}--deadline may be at most ${MAX_UNLOCK_DEADLINE_SECS} seconds after the binding (MAX_UNLOCK_DEADLINE_SECS), ${new Date(Number(startTime + MAX_UNLOCK_DEADLINE_SECS) * 1000).toISOString()} at the cluster's time now`);
        }
        if (unlockBy === 'deadline') {
            const lead = unlockDeadline - startTime;
            if (lead < UNLOCKING.minDeadlineLeadSecs || lead > UNLOCKING.maxDeadlineWaitSecs) {
                fail(`${which}--unlock deadline needs a deadline ${UNLOCKING.minDeadlineLeadSecs} to ${UNLOCKING.maxDeadlineWaitSecs} seconds away, so the launch finishes before it and the wait stays short, not ${lead}`);
            }
        }
    }

    for (const [i, terms] of tokens.entries()) {
        stepPrefix = tokens.length > 1 ? `Token ${i + 1}, ` : '';
        if (tokens.length > 1) {
            record.push([`token ${i + 1}`, `goal ${terms.unlockGoal}, deadline ${terms.unlockDeadline}${terms.unlockBy ? `, unlocked by the ${terms.unlockBy}` : ''}`]);
        }
        await launchToken(launcher, terms, { buy, buySpend, quoteHolder, init, metadata: metadata.value, goalRounds: goalRounds[i]! });
    }

    stepPrefix = '';
    step(`Done on ${cluster.url}`);
    const width = Math.max(...record.map(([label]) => label.length));
    for (const [label, value] of record) info(`${label.padEnd(width)}  ${value}`);
}

/** What every token's launch shares, worked out once before anything is sent. */
type Shared = {
    buy: bigint;
    buySpend: bigint;
    quoteHolder: Address;
    init: NonNullable<pipeline.StrategyMetadata['init']>;
    metadata: pipeline.StrategyMetadata;
    goalRounds: number;
};

/** Steps 2 to 13 for one token. */
async function launchToken(
    launcher: KeyPairSigner,
    { unlockGoal, unlockDeadline, unlockBy }: Terms,
    { buy, buySpend, quoteHolder, init, metadata, goalRounds }: Shared,
) {
    const hookProgram = CONTAINMENT_HOOK_PROGRAM_ADDRESS;
    const taxAmm = TAX_AMM_PROGRAM_ADDRESS;

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
    const { value: existing } = await rpc
        .getMultipleAccounts(computed.map(([, address]) => address), { encoding: 'base64', commitment: 'confirmed' })
        .send();
    for (const [i, [label, address]] of computed.entries()) {
        if (existing[i]) fail(`the ${label} ${address} exists before the launch`);
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
    // Measured with one blockhash, which does not change a message's size.
    const blockhash = await latestBlockhash();
    const together = message(launcher, [...creation, bind], [marketStateKey], blockhash);
    const size = getTransactionMessageSize(together);
    const limit = getTransactionMessageSizeLimit(together);
    const alone = getTransactionMessageSize(message(launcher, creation, [marketStateKey], blockhash));
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
        try {
            await send('bind', launcher, [bind]);
        } catch (error) {
            // A bind whose confirmation timed out may still have landed: the config says.
            if (await account(config)) {
                info(`bind landed after all: the config ${config} exists`);
            } else {
                const why = error instanceof Error ? error.message : String(error);
                fail(`${why}\n   The market ${market} exists and the mint ${mint} is not bound: send bind again with valid terms.`);
            }
        }
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

    // Every hooked transfer of the token from here on carries the hook accounts, resolved
    // from the validation account just read.
    const hookAccounts: HookAccountsFor = (source, destination, owner) =>
        resolveExtraAccountMetasForExecute({ rpc, transferHookProgramAddress: hookProgram, source, mint, destination, owner, amount: 0n });
    const view: pipeline.MarketView = {
        market,
        strategyProgram: taxAmm,
        marketState,
        mints: mints.map(({ mint }) => mint),
        vaults,
        tokenPrograms: mints.map(({ tokenProgram }) => tokenProgram),
        supportsExactOut: false,
    };

    step("6. Seeding the home market through the metadata's seed action, with the hook accounts");
    const seedAction = metadata.actions?.find((action) => action.name === 'seed') ?? fail('metadata.json has no seed action');
    const seed = await pipeline.buildActionInstruction({
        action: seedAction,
        market: view,
        wallet: launcher.address,
        args: { amount_0: HOME_MARKET.seed[0], amount_1: HOME_MARKET.seed[1] },
    });
    const seedTail = await hookAccounts(holder, vaults[CONTAINED_INDEX]!, launcher.address);
    await send('seed', launcher, [{ ...seed, accounts: [...(seed.accounts ?? []), ...seedTail] }]);
    const { data: seeded } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    if (seeded.status !== MarketStatus.Open || show(seeded.reserves) !== show(HOME_MARKET.seed)) {
        fail(`the market state's status is ${seeded.status} and its reserves ${show(seeded.reserves)} after the seed`);
    }
    if ((await tokenBalance(vaults[CONTAINED_INDEX]!)) !== HOME_MARKET.seed[CONTAINED_INDEX]) fail("the token's vault does not hold the seed");
    info(`the token's vault holds the seed, ${HOME_MARKET.seed[CONTAINED_INDEX]}, and the market is open`);
    info(`hook accounts: ${seedTail.map((meta) => meta.address).join(', ')}`);
    record.push(['seeded', `${HOME_MARKET.seed[CONTAINED_INDEX]} of the token into its vault, through the hook`]);
    // Nothing collected yet; the deadline is what could have passed, if it was very close.
    const unlockInstruction = await getUnlockInstructionAsync({ mint, marketState });
    if ((await clusterTime()) >= unlockDeadline) fail('the deadline passed before the unlock could be shown refused; give a later --deadline');
    await expectRefused('unlock before the goal or the deadline', launcher, unlockInstruction, ['UnlockNotDue', CONTAINMENT_HOOK_ERROR__UNLOCK_NOT_DUE]);
    record.push(['unlock before either', 'refused by the hook with UnlockNotDue']);

    step('7. Buying the token through the router with the SDK');
    if (quoteMint === WRAPPED_SOL) {
        // Wrap the buy and Pipeline's fee on it.
        const wrap = buySpend;
        await send(`wrap ${Number(wrap) / 1e9} SOL`, launcher, [
            await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: launcher, owner: launcher.address, mint: WRAPPED_SOL }),
            getTransferSolInstruction({ source: launcher, destination: quoteHolder, amount: wrap }),
            getSyncNativeInstruction({ account: quoteHolder }),
        ]);
    }
    const bought = await trade(launcher, view, QUOTE_INDEX, CONTAINED_INDEX, buy, holder, quoteHolder, hookAccounts);
    record.push(['buy', `${buy} of the quote mint bought ${bought.received} of the token, its quote; Execute ${bought.hookUnits.join(' and ')} CU`]);

    step('8. Selling half of it back the same way');
    const feeBefore = await tokenBalance(feeAccounts[CONTAINED_INDEX]!);
    const sold = await trade(launcher, view, CONTAINED_INDEX, QUOTE_INDEX, bought.received / 2n, holder, quoteHolder, hookAccounts);
    const feeAfter = await tokenBalance(feeAccounts[CONTAINED_INDEX]!);
    if (sold.pipelineFee === 0n || feeAfter - feeBefore !== sold.pipelineFee) {
        fail(`the fee account grew by ${feeAfter - feeBefore}, but the sell paid Pipeline ${sold.pipelineFee}`);
    }
    info(`Pipeline's fee of ${sold.pipelineFee}, in the token, went into the fee account through the hook`);
    record.push(['sell', `${bought.received / 2n} of the token sold for ${sold.received}, its quote; fee ${sold.pipelineFee} into the fee account; Execute ${sold.hookUnits.join(' and ')} CU`]);

    step("9. Sweeping Pipeline's fee to its treasury with sweep_fees, with the hook accounts");
    const routerConfig = await account(await pipeline.configPda());
    const treasuryOwner = (routerConfig && pipeline.decodeConfig(routerConfig.data)?.treasuryOwner) ?? fail("the router's config cannot be read");
    const treasury = await pipeline.associatedTokenAddress(treasuryOwner, mint, TOKEN_2022_PROGRAM_ADDRESS);
    await send("create the treasury's token account", launcher, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: launcher, owner: treasuryOwner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    ]);
    const owed = await tokenBalance(feeAccounts[CONTAINED_INDEX]!);
    const treasuryBefore = await tokenBalance(treasury);
    const sweepTail = await hookAccounts(feeAccounts[CONTAINED_INDEX]!, treasury, await pipeline.feeAuthorityPda(market));
    const sweep = await pipeline.sweepFees({ market, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, treasuryOwner, hookAccounts: sweepTail });
    await send('sweep_fees', launcher, [sweep]);
    const swept = (await tokenBalance(treasury)) - treasuryBefore;
    if ((await tokenBalance(feeAccounts[CONTAINED_INDEX]!)) !== 0n || swept !== owed) {
        fail(`sweep_fees moved ${swept} of the ${owed} the fee account held`);
    }
    info(`sweep_fees moved all ${owed} of the token from the fee account to the treasury owner ${treasuryOwner}, through the hook`);
    record.push(['swept', `${owed} of the token from the fee account to Pipeline's treasury, through the hook`]);

    step('10. Showing the hook refusing what containment refuses, in simulation');
    const stranger = (await generateKeyPairSigner()).address;
    const [strangerAccount] = await findAssociatedTokenPda({ owner: stranger, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    await send("create another wallet's token account", launcher, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: launcher, owner: stranger, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    ]);
    const walletToWallet = getTransferCheckedInstruction(
        { source: holder, mint, destination: strangerAccount, authority: launcher, amount: 1_000_000n, decimals: TOKEN.decimals },
        { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
    );
    const transferTail = await hookAccounts(holder, strangerAccount, launcher.address);
    await expectRefused('a wallet-to-wallet transfer_checked', launcher, {
        ...walletToWallet,
        accounts: [...walletToWallet.accounts, ...transferTail],
    });
    const integrator = (await generateKeyPairSigner()).address;
    const [integratorAccount] = await findAssociatedTokenPda({ owner: integrator, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    await send("create an integrator's token account", launcher, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: launcher, owner: integrator, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    ]);
    const sellWithFee = await swapInstruction(launcher, view, CONTAINED_INDEX, QUOTE_INDEX, bought.received / 4n, holder, quoteHolder, hookAccounts, {
        integratorFeeAccount: integratorAccount,
        integratorFeeBps: TRADES.integratorFeeBps,
        minAmountOut: 0n,
    });
    await expectRefused(`a sell with an integrator fee of ${TRADES.integratorFeeBps} basis points`, launcher, sellWithFee.instruction);
    record.push(['refused by the hook', 'a wallet-to-wallet transfer_checked, and a sell with an integrator fee above zero']);

    if (unlockBy) {
        const taxCollected = async () => (await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' })).data.taxCollected;
        if (unlockBy === 'goal') {
            step('11. Trading until the home market has collected the goal in tax');
            for (let round = 1; (await taxCollected()) < unlockGoal; round++) {
                if (round > goalRounds) fail(`the home market collected ${await taxCollected()} of the goal ${unlockGoal} in ${goalRounds} rounds`);
                if ((await clusterTime()) >= unlockDeadline) fail('the deadline passed while trading, so the unlock would not show the goal');
                if (quoteMint === WRAPPED_SOL) {
                    const held = await tokenBalance(quoteHolder);
                    if (held < buySpend) {
                        await send(`wrap ${buySpend - held} lamports`, launcher, [
                            getTransferSolInstruction({ source: launcher, destination: quoteHolder, amount: buySpend - held }),
                            getSyncNativeInstruction({ account: quoteHolder }),
                        ]);
                    }
                }
                const roundBuy = await trade(launcher, view, QUOTE_INDEX, CONTAINED_INDEX, buy, holder, quoteHolder, hookAccounts);
                await trade(launcher, view, CONTAINED_INDEX, QUOTE_INDEX, roundBuy.received, holder, quoteHolder, hookAccounts);
                info(`round ${round}: tax collected ${await taxCollected()} of the goal ${unlockGoal}`);
            }
            if ((await clusterTime()) >= unlockDeadline) fail('the deadline passed while trading, so the unlock would not show the goal');
        } else {
            step('11. Waiting for the deadline');
            for (let time = await clusterTime(); time < unlockDeadline; time = await clusterTime()) {
                info(`the cluster's clock is ${new Date(Number(time) * 1000).toISOString()}, ${unlockDeadline - time} s before the deadline`);
                await sleep(Number(unlockDeadline - time > 10n ? 10_000n : (unlockDeadline - time) * 1000n));
            }
            if ((await taxCollected()) >= unlockGoal) fail('the home market has collected the goal, so the unlock would not show the deadline');
        }
        const collected = await taxCollected();
        info(`tax collected ${collected} of the goal ${unlockGoal}; the cluster's clock ${new Date(Number(await clusterTime()) * 1000).toISOString()}, the deadline ${new Date(Number(unlockDeadline) * 1000).toISOString()}`);

        step(`12. Unlocking by the ${unlockBy}, from a wallet with no tie to the token`);
        const unlocker = await generateKeyPairSigner();
        await send('fund a fresh wallet for its transaction fee', launcher, [
            getTransferSolInstruction({ source: launcher, destination: unlocker.address, amount: UNLOCKING.unlockerLamports }),
        ]);
        // A block can carry a clock a little behind the latest confirmed block's time: retry
        // a refusal for not being due, a few seconds at most, before sending it.
        for (let attempt = 0; ; attempt++) {
            const { err, logs } = await simulate(unlocker, unlockInstruction);
            if (!err) break;
            if (attempt >= 10 || !refusedByTheHook(logs, 'UnlockNotDue', CONTAINMENT_HOOK_ERROR__UNLOCK_NOT_DUE)) fail(`unlock fails in simulation: ${show(err)}\n${logs.join('\n')}`);
            await sleep(1_000);
        }
        const unlockSignature = await send('unlock', unlocker, [unlockInstruction]);
        const unlockTx = await rpc
            .getTransaction(unlockSignature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
            .send();
        const unlockLogs = unlockTx?.meta?.logMessages ?? [];
        const reason = unlockBy === 'goal' ? 'Program log: Unlocked by the goal' : 'Program log: Unlocked by the deadline';
        if (!unlockLogs.some((line) => line.startsWith(reason))) fail(`the unlock's logs do not say "${reason}":\n${unlockLogs.join('\n')}`);
        const [unlockUnits] = hookCompute(unlockLogs);
        info(`${unlockLogs.find((line) => line.startsWith(reason))!.slice('Program log: '.length)}; unlock took ${unlockUnits} CU`);
        const unlockedMint = await account(mint);
        const freed = unlockedMint && pipeline.decodeMint(mint, TOKEN_2022_PROGRAM_ADDRESS, unlockedMint.data);
        if (!freed) fail(`no mint at ${mint}`);
        if (freed.extensions.transferHook?.programId !== null || freed.extensions.transferHook.authority !== null) {
            fail(`after the unlock the mint's transfer hook is ${JSON.stringify(freed.extensions.transferHook)}`);
        }
        info(`mint: the transfer hook extension stays, with its program and its authority both unset; trust flags: ${freed.flags.join(', ') || 'none'}`);
        const { data: unlocked } = await fetchConfig(rpc, config, { commitment: 'confirmed' });
        if (unlocked.unlockedAt.__option !== 'Some') fail('the config does not record the unlock');
        const readAgain = { ...unlocked, unlockedAt: bound.unlockedAt };
        if (show(readAgain) !== show(bound)) fail(`the unlock changed more of the config than its unlock time: ${show(unlocked)}`);
        info(`config: unlocked at ${new Date(Number(unlocked.unlockedAt.value) * 1000).toISOString()}, and nothing else in it changed`);
        await expectRefused('a second unlock', launcher, unlockInstruction, ['AlreadyUnlocked', CONTAINMENT_HOOK_ERROR__ALREADY_UNLOCKED]);
        record.push(
            ['unlocked', `by the ${unlockBy}, by ${unlocker.address}, with ${collected} of the goal ${unlockGoal} collected; ${unlockUnits} CU`],
            ['mint after the unlock', 'transfer hook program and hook authority both unset'],
            ['a second unlock', 'refused by the hook with AlreadyUnlocked'],
        );

        step('13. Sending and trading the token without hook accounts');
        const before = await tokenBalance(strangerAccount);
        await send('a wallet-to-wallet transfer_checked without hook accounts', launcher, [walletToWallet]);
        if ((await tokenBalance(strangerAccount)) - before !== 1_000_000n) fail("the transfer did not reach the other wallet's account");
        info("1,000,000 of the token reached the other wallet's account");
        const noHookAccounts: HookAccountsFor = async () => [];
        const freeBuy = await trade(launcher, view, QUOTE_INDEX, CONTAINED_INDEX, buy / 10n, holder, quoteHolder, noHookAccounts, false);
        const freeSell = await trade(launcher, view, CONTAINED_INDEX, QUOTE_INDEX, freeBuy.received, holder, quoteHolder, noHookAccounts, false);
        record.push(
            ['transfer after the unlock', '1,000,000 of the token from the launcher to another wallet, without hook accounts'],
            ['swaps after the unlock', `a buy of ${buy / 10n} and a sell of ${freeBuy.received} (for ${freeSell.received}), without hook accounts; the hook never ran`],
        );
    }
}

main().catch((error) => {
    console.error(error instanceof Stopped ? `\nStopped: ${error.message}` : error);
    process.exit(1);
});
