// What the containment hook's scripts share for talking to a cluster: the launch script
// (`launch.ts`), which launches contained tokens, and `contained.ts`, which acts on contained
// tokens already on a cluster. Each refuses any cluster other than devnet or a local
// validator, sends and confirms at `confirmed`, and trades a contained token through the
// router with Pipeline's SDK and the hook accounts, which Token-2022's own client resolves from
// the validation account (`resolveExtraAccountMetasForExecute` from @solana-program/token-2022),
// since neither Pipeline client resolves them (docs/toolchain.md, "Containment hook").

import { readFileSync } from 'node:fs';

import {
    address,
    addSignersToTransactionMessage,
    appendTransactionMessageInstructions,
    createDefaultRpcTransport,
    createKeyPairSignerFromBytes,
    createSolanaRpcFromTransport,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type AccountMeta,
    type Address,
    type Blockhash,
    type Instruction,
    type KeyPairSigner,
    type Signature,
} from '@solana/kit';
import * as pipeline from '@pipeline-placeholder/sdk';

import { CONTAINMENT_HOOK_PROGRAM_ADDRESS } from './client/index.ts';
import { findAuthorityPda } from '../../tax-amm/scripts/client/index.ts';

export const TOKEN_2022_PROGRAM_ADDRESS = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// How long the scripts wait for the RPC to serve a transaction they have seen land.
const LANDED_TRANSACTION_WAIT_MS = 30_000;
export const LOCALNET_URL = 'http://127.0.0.1:8899';
export const DEVNET_URL = 'https://api.devnet.solana.com';
const GENESIS_HASHES = {
    devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
    mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'];

/** A cluster the scripts may act on: its RPC URL, and whether it is a local validator. */
export type Cluster = { url: string; local: boolean };

/**
 * `--cluster`: localnet, devnet or an RPC URL; `usage` reports a value that is none of them.
 * Whether an RPC URL is devnet's is only known from its genesis hash ([`connect`]'s
 * `checkCluster`).
 */
export function clusterUrl(cluster: string | undefined, usage: (message: string) => never): Cluster {
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

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function info(message: string) {
    console.log(`   ${message}`);
}

/** Why a script stopped; its `main` prints it and exits. */
export class Stopped extends Error {}

export function fail(message: string): never {
    throw new Stopped(message);
}

export const show = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

export async function loadKey(path: string): Promise<KeyPairSigner> {
    return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path, 'utf8'))));
}

/** The compute units each invocation of the hook consumed, in order, from a transaction's logs. */
export function hookCompute(logs: readonly string[]): number[] {
    const consumed = `Program ${CONTAINMENT_HOOK_PROGRAM_ADDRESS} consumed `;
    return logs.filter((line) => line.startsWith(consumed)).map((line) => Number(line.slice(consumed.length).split(' ')[0]));
}

/** Whether `logs` show the hook failing with the error `name`, number `code`. */
export function refusedByTheHook(logs: readonly string[], name: string, code: number) {
    return (
        logs.some((line) => line.includes(`Error Code: ${name}. Error Number: ${code}.`)) &&
        logs.some((line) => line.startsWith(`Program ${CONTAINMENT_HOOK_PROGRAM_ADDRESS} failed`))
    );
}

/** The hook accounts of one transfer of the contained token, after the transfer's own. */
export type HookAccountsFor = (source: Address, destination: Address, authority: Address) => Promise<AccountMeta[]>;

/** A home market as a terminal sees it, with the index of its contained token among its mints. */
export type ContainedView = pipeline.MarketView & { containedIndex: number };

/**
 * The helpers that act on `cluster`, each through one RPC client that retries a rate limit;
 * `send` adds each label and signature to `record`.
 */
export function connect(cluster: Cluster, record: [string, string][]) {
    const onDevnet = !cluster.local;
    const baseTransport = createDefaultRpcTransport({ url: cluster.url });
    const retryingTransport = (async (...args: Parameters<typeof baseTransport>) => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await baseTransport(...args);
            } catch (error) {
                if (attempt >= 8 || !isTransientRpcError(error)) throw error;
                await sleep(500 * 2 ** attempt);
            }
        }
    }) as typeof baseTransport;
    const rpc = createSolanaRpcFromTransport(retryingTransport);

    function explorer(kind: 'tx' | 'address', value: string) {
        return onDevnet ? `https://orbmarkets.io/${kind}/${value}?cluster=devnet` : value;
    }

    /** Stops unless the cluster is devnet or a local validator; `refusal` says what is refused elsewhere. */
    async function checkCluster(refusal: string) {
        const genesis = await rpc.getGenesisHash().send();
        if (genesis === GENESIS_HASHES.mainnet || genesis === GENESIS_HASHES.testnet) {
            fail(`${cluster.url} is ${genesis === GENESIS_HASHES.mainnet ? 'mainnet' : 'testnet'}; ${refusal}`);
        }
        if (!cluster.local && genesis !== GENESIS_HASHES.devnet) {
            fail(`${cluster.url} is not devnet (genesis hash ${genesis}); ${refusal}`);
        }
        info(`cluster: ${cluster.local ? 'a local validator' : 'devnet'} (genesis hash ${genesis})`);
    }

    /** Waits until `signature` has landed, and returns its error, if it failed. */
    async function landed(label: string, signature: Signature) {
        for (let i = 0; ; i++) {
            const { value } = await rpc.getSignatureStatuses([signature]).send();
            const status = value[0];
            if (status?.err) return status.err;
            if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return null;
            if (i > 120) fail(`${label}: not confirmed after 60 s (${explorer('tx', signature)})`);
            await sleep(500);
        }
    }

    /**
     * A landed transaction as the RPC returns it, at `confirmed`. A devnet RPC node can answer
     * `getSignatureStatuses` before `getTransaction` serves the transaction, so this asks again
     * for up to `LANDED_TRANSACTION_WAIT_MS` before it gives up.
     */
    async function landedTransaction(label: string, signature: Signature) {
        for (let waited = 0; ; waited += 1_000) {
            const tx = await rpc.getTransaction(signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).send();
            if (tx) return tx;
            if (waited >= LANDED_TRANSACTION_WAIT_MS) fail(`${label}: the RPC did not serve transaction ${signature} after ${LANDED_TRANSACTION_WAIT_MS / 1000} s (${explorer('tx', signature)})`);
            await sleep(1_000);
        }
    }

    async function waitFor(label: string, signature: Signature) {
        const err = await landed(label, signature);
        if (err) fail(`${label} failed: ${show(err)} (${explorer('tx', signature)})`);
    }

    type LatestBlockhash = Readonly<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>;

    async function latestBlockhash(): Promise<LatestBlockhash> {
        return (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value;
    }

    /** A version 0 transaction message of `instructions`, paid for by `feePayer`. */
    function message(feePayer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[], blockhash: LatestBlockhash) {
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

    /** Simulates `instruction` and returns whether it failed, with its logs. */
    async function simulate(feePayer: KeyPairSigner, instruction: Instruction) {
        const signed = await signTransactionMessageWithSigners(message(feePayer, [instruction], [], await latestBlockhash()));
        const { value } = await rpc
            .simulateTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', commitment: 'confirmed' })
            .send();
        return { err: value.err, logs: value.logs ?? [] };
    }

    /** On a local validator, airdrops `key` what it lacks of `amount`. */
    async function fundLocally(key: Address, amount: bigint, who = 'the launcher') {
        const { value: balance } = await rpc.getBalance(key, { commitment: 'confirmed' }).send();
        if (balance >= amount) return;
        for (let attempt = 0; ; attempt++) {
            try {
                const signature = await rpc.requestAirdrop(key, lamports(amount - balance)).send();
                await waitFor(`airdrop to ${who}`, signature);
                info(`airdropped ${Number(amount - balance) / 1e9} SOL to ${who}`);
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

    /** A token account's balance. */
    async function tokenBalance(account: Address): Promise<bigint> {
        const { value } = await rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send();
        return BigInt(value.amount);
    }

    /** The cluster's clock, as the latest confirmed block's time. */
    async function clusterTime(): Promise<bigint> {
        const time = await rpc.getBlockTime(await rpc.getSlot({ commitment: 'confirmed' }).send()).send();
        if (time === null) fail('the cluster did not give its time');
        return BigInt(time);
    }

    /**
     * The side a trade into `outputMint` pays Pipeline's fee on, from the market the router
     * recorded. Since Pipeline 0.3 it is the output when that is the market's fee mint: on a
     * home market quoted in wrapped SOL a sell pays the fee in SOL, out of what arrived, and the
     * token never moves into its fee account; on any other quote mint it is the token, as before.
     */
    async function routerFeeSide(market: Address, outputMint: Address): Promise<pipeline.FeeSide> {
        const recorded = await account(market);
        const decoded = recorded && pipeline.decodeMarket(recorded.data);
        if (!decoded) fail(`the router has no market at ${market}`);
        return pipeline.feeSideOf(decoded, outputMint);
    }

    /**
     * The router's `swap` of `amount` of mint `input` for mint `output` by `trader`, built with
     * the SDK as a terminal builds it, with the contained token's hook accounts: after the
     * strategy's accounts when it is the output, which the tax AMM moves out of its vault, and as
     * the router's input hook accounts when it is the input, which the router moves into the
     * vault and, when Pipeline's fee is taken in the token, into the fee account. Its minimum is
     * what the trader keeps of the quote. Quoted at `confirmed`, the commitment the scripts
     * confirm at.
     */
    async function swapInstruction(
        trader: KeyPairSigner,
        view: ContainedView,
        input: number,
        output: number,
        amount: bigint,
        tokenHolder: Address,
        quoteHolder: Address,
        hookAccounts: HookAccountsFor,
        options: { integratorFeeAccount?: Address; integratorFeeBps?: number; minAmountOut?: bigint } = {},
    ) {
        const holders = input === view.containedIndex ? [tokenHolder, quoteHolder] : [quoteHolder, tokenHolder];
        const [traderInput, traderOutput] = holders as [Address, Address];
        const request = { mode: pipeline.TradeMode.ExactIn, inputIndex: input, outputIndex: output, amount, trader: trader.address, extra: new Uint8Array() };
        const simulation = { commitment: 'confirmed' } as const;
        const strategyAccounts = await pipeline.resolveAccounts(rpc, view, request, trader.address, simulation);
        const { quote } = await pipeline.quoteStrategy(rpc, view, request, strategyAccounts, trader.address, simulation);
        const buying = output === view.containedIndex;
        const feeSide = await routerFeeSide(view.market, view.mints[output]!);
        const kept = feeSide === 'output' ? pipeline.keptAfterOutputFee(quote.amountOut) : quote.amountOut;
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
                minAmountOut: options.minAmountOut ?? kept,
                integratorFeeBps: options.integratorFeeBps ?? 0,
                extra: new Uint8Array(),
            },
            feeSide,
        );
        return { instruction, quote, kept, feeSide, traderOutput };
    }

    /**
     * Swaps through the router with [`swapInstruction`], and stops unless the swap delivered its
     * quote and the trader kept it, less Pipeline's fee when that is taken in the output; returns
     * what the trader kept, Pipeline's fee and the side it was taken on, what the hook's
     * `Execute` cost on each hooked transfer, from the transaction's logs, and the signature.
     */
    async function trade(
        trader: KeyPairSigner,
        view: ContainedView,
        input: number,
        output: number,
        amount: bigint,
        tokenHolder: Address,
        quoteHolder: Address,
        hookAccounts: HookAccountsFor,
        hooked = true,
    ) {
        const contained = view.containedIndex;
        const label = `swap ${amount} of ${input === contained ? 'the token' : 'the quote mint'} for ${output === contained ? 'the token' : 'the quote mint'}`;
        const { instruction, quote, kept, feeSide, traderOutput } = await swapInstruction(trader, view, input, output, amount, tokenHolder, quoteHolder, hookAccounts);
        info(`${label}: quoted ${quote.amountOut}`);
        const before = await tokenBalance(traderOutput);
        const signature = await send(label, trader, [instruction]);
        const received = (await tokenBalance(traderOutput)) - before;
        const tx = await landedTransaction(label, signature);
        if (!tx.meta?.innerInstructions) fail(`transaction ${signature} has no inner instructions`);
        const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
        const event = pipeline.extractEventsFromInnerInstructions(keys, tx.meta.innerInstructions).find((candidate) => candidate.type === 'Swap');
        if (!event || event.type !== 'Swap') fail(`transaction ${signature} has no swap event`);
        if (received !== kept || event.data.received !== quote.amountOut) {
            fail(`${label}: kept ${received} (event: ${event.data.received} arrived), quoted ${quote.amountOut} to keep ${kept}`);
        }
        const hookUnits = hookCompute(tx.meta.logMessages ?? []);
        // While contained, the hook runs on the vault's transfer of a buy, and on a sell's transfer
        // into the vault and, when Pipeline's fee is taken in the token, its transfer into the fee
        // account; after the unlock, never.
        const expected = hooked ? (output === contained ? 1 : feeSide === 'input' ? 2 : 1) : 0;
        if (hookUnits.length !== expected) fail(`${label}: the hook ran ${hookUnits.length} times, not ${expected}`);
        const hook = hooked ? `the hook's Execute took ${hookUnits.join(' and ')} CU` : 'the hook did not run';
        info(`${label}: the quote arrived and ${received} was kept, Pipeline's fee ${event.data.pipelineFee} in the ${feeSide}; ${hook}`);
        return { received, pipelineFee: event.data.pipelineFee, feeSide, hookUnits, signature };
    }

    return {
        rpc,
        onDevnet,
        explorer,
        checkCluster,
        landed,
        landedTransaction,
        waitFor,
        latestBlockhash,
        message,
        send,
        simulate,
        fundLocally,
        account,
        tokenBalance,
        clusterTime,
        routerFeeSide,
        swapInstruction,
        trade,
    };
}

/** The network error codes of a connection that dropped or never opened, which a retry can cure. */
const DROPPED_CONNECTION_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'];

/**
 * Whether an RPC request's failure is worth retrying: a rate limit (HTTP 429) or a connection
 * that dropped, which public devnet and some networks produce mid-run (a launch on devnet on
 * 2026-11-23 stopped on an `ECONNRESET` while confirming a transaction that had landed). An
 * answer the cluster gave is never retried. A retried send is safe: the cluster keeps one copy
 * of a signed transaction, by its signature.
 */
export function isTransientRpcError(error: unknown): boolean {
    if (String(error).includes('429')) return true;
    const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
    if (typeof cause?.code === 'string' && DROPPED_CONNECTION_CODES.includes(cause.code)) return true;
    return error instanceof TypeError && error.message === 'fetch failed';
}
