// Everything the runner asks of the chain, over RPC (docs/spec/keeper-runner.md, "RPC"):
// reads, simulations and sends on KEEPER_RPC_URL, `getProgramAccounts` on
// KEEPER_DISCOVERY_RPC_URL and `logsSubscribe` on KEEPER_WS_URL, since Alchemy's free devnet
// tier serves neither of those two (SUITE-49).
//
// The runner reads only the chain. Waiting for the chain (confirmations, reconnects) uses real
// time, whatever clock the runner's passes run on.

import { setTimeout as sleep } from 'node:timers/promises';

import {
    appendTransactionMessageInstructions,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    getBase58Encoder,
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getSignatureFromTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type Address,
    type Base64EncodedWireTransaction,
    type GetAccountInfoApi,
    type Instruction,
    type Rpc,
    type Signature,
    type SolanaRpcApi,
    type TransactionSigner,
} from '@solana/kit';

/** The chain could not be asked: a transport error, a timeout, a dropped send. Not the job's fault. */
export class ChainError extends Error {}

export type AccountData = { owner: Address; data: Uint8Array };

export type SignedTransaction = {
    signature: Signature;
    wire: Base64EncodedWireTransaction;
    lastValidBlockHeight: bigint;
};

/**
 * How a transaction ended, simulated or landed: the custom error code if an instruction refused
 * with one, the index of the transaction's instruction that failed, and the program that raised
 * the code, which for a failure inside a cross-program call is the called program, not the
 * transaction's instruction's.
 */
export type Result = { failed: boolean; customError: number | null; failedInstruction: number | null; refusedBy: Address | null; error: string | null; logs: string[] };

export type Simulation = Result & {
    /** The fee payer's balance after the simulated transaction, its fee taken. */
    payerLamportsAfter: bigint;
};

/** One instruction of a landed transaction, its accounts and program resolved. */
export type LandedInstruction = { programAddress: Address; accounts: Address[]; data: Uint8Array };

export type LandedTransaction = Result & {
    signature: Signature;
    blockTime: number | null;
    /** The fee payer, the first account key. */
    feePayer: Address;
    fee: bigint;
    payerLamportsBefore: bigint;
    payerLamportsAfter: bigint;
    accountKeys: Address[];
    /** The transaction's own instructions (not the ones they invoked). */
    instructions: LandedInstruction[];
};

export interface Chain {
    /** For the jobs' instruction builders, which read mints and hook accounts. */
    readonly rpc: Rpc<GetAccountInfoApi>;
    balance(address: Address): Promise<bigint>;
    /** Many accounts at once, in batches of 100; a missing one is null. */
    accounts(addresses: readonly Address[]): Promise<Map<Address, AccountData | null>>;
    /** Every account the program owns. */
    programAccounts(program: Address): Promise<{ address: Address; data: Uint8Array }[]>;
    /** Signs a version 0 transaction of `instructions` paid for by `payer`, on a fresh blockhash. */
    prepare(payer: TransactionSigner, instructions: readonly Instruction[]): Promise<SignedTransaction>;
    simulate(transaction: SignedTransaction, payer: Address): Promise<Simulation>;
    /** Sends and waits for confirmation; throws ChainError if it cannot tell whether it landed. */
    sendAndConfirm(transaction: SignedTransaction): Promise<void>;
    /** A landed transaction, or null if the node does not have it (yet). */
    transaction(signature: Signature): Promise<LandedTransaction | null>;
    /** The address's transactions since `sinceUnixSeconds`, newest first. */
    signaturesSince(address: Address, sinceUnixSeconds: number): Promise<Signature[]>;
    /**
     * Calls `onSignature` for each successful transaction that names `program`, reconnecting on
     * its own and calling `onReconnect` after each reconnect; returns a function that stops it.
     */
    subscribeLogs(program: Address, handlers: { onSignature(signature: Signature): void; onReconnect(): void; onError(error: unknown): void }): () => void;
}

const COMMITMENT = 'confirmed' as const;
/** The most accounts one `getMultipleAccounts` reads. */
export const ACCOUNTS_PER_REQUEST = 100;
const BATCH = ACCOUNTS_PER_REQUEST;
/** How often a send's status is polled, and the longest a reconnect waits. */
const POLL_MS = 500;
const MAX_RECONNECT_MS = 60_000;

/** The custom error code in a transaction error, if its instruction refused with one. */
function customErrorOf(error: unknown): number | null {
    const failure = (error as { InstructionError?: [unknown, unknown] } | null)?.InstructionError?.[1];
    const custom = (failure as { Custom?: number | bigint } | undefined)?.Custom;
    return custom === undefined ? null : Number(custom);
}

/**
 * The program that raised a custom error: the first "Program <id> failed: custom program error"
 * line, since the innermost program fails first and each caller then repeats its code.
 */
function refusedByOf(logs: readonly string[] | null | undefined): Address | null {
    for (const line of logs ?? []) {
        const found = /^Program (\w{32,44}) failed: custom program error/.exec(line);
        if (found) return found[1] as Address;
    }
    return null;
}

/** The index of the instruction a transaction error names, if it names one. */
function failedInstructionOf(error: unknown): number | null {
    const index = (error as { InstructionError?: [unknown, unknown] } | null)?.InstructionError?.[0];
    return typeof index === 'number' || typeof index === 'bigint' ? Number(index) : null;
}

const show = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/** The error, with the log line that names it (such as "Error: Account is frozen") when there is one. */
export function resultOf(error: unknown, logs: readonly string[] | null | undefined): Result {
    const failed = error !== null && error !== undefined;
    const said = [...(logs ?? [])].reverse().find((line) => /error/i.test(line) && !/ failed: custom program error/.test(line));
    return { failed, customError: customErrorOf(error), failedInstruction: failedInstructionOf(error), refusedBy: failed ? refusedByOf(logs) : null, error: failed ? `${show(error)}${said ? `: ${said}` : ''}` : null, logs: [...(logs ?? [])] };
}

/** Wraps an RPC call, so a transport failure is told apart from a job's failure. */
async function ask<T>(what: string, call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (error) {
        throw new ChainError(`${what}: ${(error as Error).message}`, { cause: error });
    }
}

/**
 * The RPC handed to the jobs' builders, with every request's transport failure turned into a
 * ChainError, so an RPC hiccup while building is never taken for the job failing (SUITE-52).
 */
function guarded<T extends object>(rpc: T): T {
    return new Proxy(rpc, {
        get(target, method) {
            const call = Reflect.get(target, method);
            if (typeof call !== 'function') return call;
            return (...args: unknown[]) => {
                const request = call.apply(target, args) as { send(options?: unknown): Promise<unknown> };
                return { ...request, send: (options?: unknown) => ask(String(method), () => request.send(options)) };
            };
        },
    });
}

/** How long a sent transaction is followed when the RPC keeps failing, before giving up on knowing. */
const FOLLOW_MS = 120_000;

export function rpcChain(urls: { rpcUrl: string; discoveryRpcUrl: string; wsUrl: string }): Chain {
    const rpc: Rpc<SolanaRpcApi> = createSolanaRpc(urls.rpcUrl);
    const discovery: Rpc<SolanaRpcApi> = urls.discoveryRpcUrl === urls.rpcUrl ? rpc : createSolanaRpc(urls.discoveryRpcUrl);
    let subscriptions: ReturnType<typeof createSolanaRpcSubscriptions> | undefined;
    const base64 = getBase64Encoder();

    return {
        rpc: guarded(rpc),

        async balance(address) {
            return (await ask('getBalance', () => rpc.getBalance(address, { commitment: COMMITMENT }).send())).value;
        },

        async accounts(addresses) {
            const found = new Map<Address, AccountData | null>();
            for (let i = 0; i < addresses.length; i += BATCH) {
                const batch = addresses.slice(i, i + BATCH);
                const { value } = await ask('getMultipleAccounts', () =>
                    rpc.getMultipleAccounts(batch, { encoding: 'base64', commitment: COMMITMENT }).send(),
                );
                batch.forEach((address, j) => {
                    const account = value[j];
                    found.set(address, account ? { owner: account.owner, data: new Uint8Array(base64.encode(account.data[0])) } : null);
                });
            }
            return found;
        },

        async programAccounts(program) {
            const accounts = await ask('getProgramAccounts', () =>
                discovery.getProgramAccounts(program, { encoding: 'base64', commitment: COMMITMENT }).send(),
            );
            return accounts.map(({ pubkey, account }) => ({ address: pubkey, data: new Uint8Array(base64.encode(account.data[0])) }));
        },

        async prepare(payer, instructions) {
            const { value: blockhash } = await ask('getLatestBlockhash', () => rpc.getLatestBlockhash({ commitment: COMMITMENT }).send());
            const message = pipe(
                createTransactionMessage({ version: 0 }),
                (m) => setTransactionMessageFeePayerSigner(payer, m),
                (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
                (m) => appendTransactionMessageInstructions(instructions, m),
            );
            const signed = await signTransactionMessageWithSigners(message);
            return {
                signature: getSignatureFromTransaction(signed),
                wire: getBase64EncodedWireTransaction(signed),
                lastValidBlockHeight: blockhash.lastValidBlockHeight,
            };
        },

        async simulate(transaction, payer) {
            const { value } = await ask('simulateTransaction', () =>
                rpc
                    .simulateTransaction(transaction.wire, {
                        encoding: 'base64',
                        commitment: COMMITMENT,
                        accounts: { encoding: 'base64', addresses: [payer] },
                    })
                    .send(),
            );
            const after = value.accounts?.[0];
            return { ...resultOf(value.err, value.logs), payerLamportsAfter: after ? BigInt(after.lamports) : 0n };
        },

        async sendAndConfirm(transaction) {
            let dropped = false;
            try {
                await rpc.sendTransaction(transaction.wire, { encoding: 'base64', skipPreflight: true }).send();
            } catch {
                // The node may have taken it before the connection dropped: its status says.
                dropped = true;
            }
            // Followed until it is confirmed or its blockhash has expired; a failed poll is asked
            // again, so one hiccup never leaves a landed transaction uncounted.
            const giveUp = Date.now() + FOLLOW_MS;
            let lastError: unknown = null;
            for (;;) {
                await sleep(POLL_MS);
                try {
                    const { value } = await rpc.getSignatureStatuses([transaction.signature], { searchTransactionHistory: true }).send();
                    const status = value[0];
                    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return;
                    const height = await rpc.getBlockHeight({ commitment: COMMITMENT }).send();
                    if (height > transaction.lastValidBlockHeight) {
                        // One last look, in case it landed in the blockhash's final slots.
                        const last = (await rpc.getSignatureStatuses([transaction.signature], { searchTransactionHistory: true }).send()).value[0];
                        if (last?.confirmationStatus === 'confirmed' || last?.confirmationStatus === 'finalized') return;
                        throw new ChainError(`${transaction.signature} did not land before its blockhash expired${dropped ? ' (the send was dropped)' : ''}`);
                    }
                } catch (error) {
                    if (error instanceof ChainError) throw error;
                    lastError = error;
                }
                if (Date.now() > giveUp) {
                    throw new ChainError(`whether ${transaction.signature} landed is unknown: the RPC kept failing (${String((lastError as Error)?.message ?? lastError)})`);
                }
            }
        },

        async transaction(signature) {
            const landed = await ask('getTransaction', () =>
                rpc.getTransaction(signature, { encoding: 'json', commitment: COMMITMENT, maxSupportedTransactionVersion: 0 }).send(),
            );
            if (!landed?.meta) return null;
            const keys = landed.transaction.message.accountKeys;
            const accountKeys = [...keys, ...(landed.meta.loadedAddresses?.writable ?? []), ...(landed.meta.loadedAddresses?.readonly ?? [])];
            const base58 = getBase58Encoder();
            return {
                ...resultOf(landed.meta.err, landed.meta.logMessages),
                signature,
                blockTime: landed.blockTime === null ? null : Number(landed.blockTime),
                feePayer: keys[0]!,
                fee: BigInt(landed.meta.fee),
                payerLamportsBefore: BigInt(landed.meta.preBalances[0]!),
                payerLamportsAfter: BigInt(landed.meta.postBalances[0]!),
                accountKeys,
                instructions: landed.transaction.message.instructions.map((instruction) => ({
                    programAddress: accountKeys[instruction.programIdIndex]!,
                    accounts: instruction.accounts.map((index) => accountKeys[index]!),
                    data: new Uint8Array(base58.encode(instruction.data)),
                })),
            };
        },

        async signaturesSince(address, sinceUnixSeconds) {
            const found: Signature[] = [];
            let before: Signature | undefined;
            for (;;) {
                const page = await ask('getSignaturesForAddress', () =>
                    rpc.getSignaturesForAddress(address, { commitment: COMMITMENT, limit: 1000, ...(before ? { before } : {}) }).send(),
                );
                for (const entry of page) {
                    // A signature with no block time yet is newer than anything with one.
                    if (entry.blockTime !== null && Number(entry.blockTime) < sinceUnixSeconds) return found;
                    found.push(entry.signature);
                }
                if (page.length < 1000) return found;
                before = page[page.length - 1]!.signature;
            }
        },

        subscribeLogs(program, handlers) {
            subscriptions ??= createSolanaRpcSubscriptions(urls.wsUrl);
            const live = subscriptions;
            const abort = new AbortController();
            void (async () => {
                let connected = false;
                let wait = 1_000;
                while (!abort.signal.aborted) {
                    try {
                        const notifications = await live
                            .logsNotifications({ mentions: [program] }, { commitment: COMMITMENT })
                            .subscribe({ abortSignal: abort.signal });
                        // Whatever happened while the socket was down is caught by a sweep.
                        if (connected) handlers.onReconnect();
                        connected = true;
                        wait = 1_000;
                        for await (const notification of notifications) {
                            if (notification.value.err === null) handlers.onSignature(notification.value.signature);
                        }
                    } catch (error) {
                        if (abort.signal.aborted) return;
                        handlers.onError(error);
                    }
                    await sleep(wait).catch(() => {});
                    wait = Math.min(wait * 2, MAX_RECONNECT_MS);
                }
            })();
            return () => abort.abort();
        },
    };
}
