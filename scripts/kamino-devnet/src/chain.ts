// JSON-RPC access: reading accounts and balances, and sending transactions that are confirmed by polling their
// status (no WebSockets, which public devnet drops under Node 26, docs/toolchain.md). Every transaction sent is
// recorded in the journal with a label, so a run can list its signatures.
import { setTimeout as sleep } from "node:timers/promises";

import { fromCode } from "@kamino-finance/klend-sdk/dist/@codegen/klend/errors/custom.js";
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";

import { KLEND_PROGRAM } from "./policy.ts";
import { tokenAmount } from "./tokens.ts";

export interface AccountData {
  address: Address;
  owner: Address;
  lamports: bigint;
  data: Uint8Array;
}

export interface JournalEntry {
  label: string;
  signature: Signature;
  ok: boolean;
  error?: string;
}

export interface FailedTransaction {
  signature: Signature;
  /** klend's error name when Kamino refused it, else the raw transaction error. */
  error: string;
  logs: string[];
}

export interface TransactionDetails {
  /** Every account the transaction loaded, static and from lookup tables. */
  accounts: Address[];
  /** The program and first eight data bytes of each top-level instruction. */
  instructions: { programId: Address; discriminator: Uint8Array }[];
  fee: bigint;
}


const base58 = getBase58Encoder();
const POLL_MS = 500;
const RETRY_FOR_MS = 5 * 60_000;
const FEE_READS_AT_ONCE = 8;
const RESEND_MS = 2_000;

export class Chain {
  readonly url: string;
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly journal: JournalEntry[] = [];
  private readonly log: (line: string) => void;

  constructor(url: string, log: (line: string) => void) {
    this.url = url;
    this.log = log;
    this.rpc = createSolanaRpc(url) as unknown as Rpc<SolanaRpcApi>;
  }

  async accounts(addresses: Address[]): Promise<(AccountData | null)[]> {
    const out: (AccountData | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const { value } = await this.retry(() =>
        this.rpc.getMultipleAccounts(chunk, { encoding: "base64", commitment: "confirmed" }).send(),
      );
      value.forEach((account, j) =>
        out.push(
          account && {
            address: chunk[j]!,
            owner: account.owner,
            lamports: account.lamports,
            data: Buffer.from(account.data[0], "base64"),
          },
        ),
      );
    }
    return out;
  }

  async account(address: Address): Promise<AccountData | null> {
    const [account] = await this.accounts([address]);
    return account ?? null;
  }

  async balance(address: Address): Promise<bigint> {
    const { value } = await this.retry(() => this.rpc.getBalance(address, { commitment: "confirmed" }).send());
    return value;
  }

  /** A token account's balance in base units, or 0 when it does not exist. */
  async tokenBalance(tokenAccount: Address): Promise<bigint> {
    const account = await this.account(tokenAccount);
    return account ? tokenAmount(account.data) : 0n;
  }

  async mintSupply(mint: Address): Promise<bigint> {
    const account = await this.account(mint);
    if (!account) throw new Error(`mint ${mint} does not exist`);
    return new DataView(account.data.buffer, account.data.byteOffset).getBigUint64(36, true);
  }

  async rent(space: number): Promise<bigint> {
    return this.retry(() => this.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send());
  }

  /** Local validators only: devnet SOL comes from `devnet-airdrop`, never from the RPC faucet. */
  async airdrop(recipient: Address, amount: bigint) {
    const signature = await this.rpc.requestAirdrop(recipient, lamports(amount), { commitment: "confirmed" }).send();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { value } = await this.rpc.getSignatureStatuses([signature]).send();
      const status = value[0];
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
      await sleep(POLL_MS);
    }
    throw new Error("airdrop did not confirm");
  }

  /** Sends one transaction paid by `feePayer` and waits until it is confirmed; throws with klend's error and logs. */
  async send(label: string, instructions: Instruction[], feePayer: TransactionSigner): Promise<Signature> {
    const { signature, wire, lastValidBlockHeight } = await this.sign(instructions, feePayer);
    await this.submit(label, signature, wire, false);
    const failure = await this.confirm(signature, wire, lastValidBlockHeight);
    this.journal.push({ label, signature, ok: !failure, ...(failure && { error: failure.error }) });
    if (failure) throw new Error(`${label}: ${failure.error} (${signature})\n${failure.logs.join("\n")}`);
    this.log(`  ${label}: ${signature}`);
    return signature;
  }

  /**
   * Sends a transaction expected to fail, without a preflight simulation, so the refusal lands on chain with a
   * signature anyone can look up. Throws if it succeeds.
   */
  async sendExpectingFailure(
    label: string,
    instructions: Instruction[],
    feePayer: TransactionSigner,
  ): Promise<FailedTransaction> {
    const { signature, wire, lastValidBlockHeight } = await this.sign(instructions, feePayer);
    await this.submit(label, signature, wire, true);
    const failure = await this.confirm(signature, wire, lastValidBlockHeight);
    this.journal.push({ label, signature, ok: !failure, ...(failure && { error: failure.error }) });
    if (!failure) throw new Error(`${label}: expected a refusal, but it succeeded (${signature})`);
    this.log(`  ${label}: refused with ${failure.error}: ${signature}`);
    return failure;
  }

  async transaction(signature: Signature): Promise<TransactionDetails> {
    const tx = await this.retry(() =>
      this.rpc
        .getTransaction(signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 })
        .send(),
    );
    if (!tx) throw new Error(`transaction ${signature} not found`);
    const message = tx.transaction.message;
    const loaded = tx.meta?.loadedAddresses;
    const accounts = [...message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
    return {
      accounts,
      instructions: message.instructions.map((ix) => ({
        programId: accounts[ix.programIdIndex]!,
        discriminator: new Uint8Array(base58.encode(ix.data)).subarray(0, 8),
      })),
      fee: tx.meta?.fee ?? 0n,
    };
  }

  /** The fee each transaction paid, read from the cluster a few at a time. */
  async fees(signatures: Signature[]): Promise<bigint> {
    let total = 0n;
    for (let i = 0; i < signatures.length; i += FEE_READS_AT_ONCE) {
      const details = await Promise.all(signatures.slice(i, i + FEE_READS_AT_ONCE).map((s) => this.transaction(s)));
      total += details.reduce((sum, d) => sum + d.fee, 0n);
    }
    return total;
  }

  /** The slot a confirmed transaction landed in, as the cluster reports its status. */
  async slotOf(signature: Signature): Promise<bigint> {
    const { value } = await this.retry(() => this.rpc.getSignatureStatuses([signature]).send());
    const status = value[0];
    if (!status) throw new Error(`no status for ${signature}`);
    return status.slot;
  }

  async genesisHash(): Promise<string> {
    return this.retry(() => this.rpc.getGenesisHash().send());
  }

  /**
   * Sends a signed transaction once. When the RPC answers with a refusal (a failed preflight simulation) it throws
   * with the reason; when the network fails, the transaction may still land, so it is resent while its status is
   * polled.
   */
  private async submit(label: string, signature: Signature, wire: Base64EncodedWireTransaction, skipPreflight: boolean) {
    try {
      await this.rpc
        .sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed", skipPreflight, maxRetries: 0n })
        .send();
    } catch (error) {
      if (isRpcRefusal(error)) throw new Error(`${label}: ${describeSendError(error)}`);
      this.log(`  ${label}: sending failed (${describe(error)}), resending while waiting for ${signature}`);
    }
  }

  private async sign(instructions: Instruction[], feePayer: TransactionSigner) {
    const { value: blockhash } = await this.retry(() =>
      this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
    );
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    return {
      signature: getSignatureFromTransaction(transaction),
      wire: getBase64EncodedWireTransaction(transaction),
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    };
  }

  /** Polls until the transaction is confirmed, resending it meanwhile; returns its failure, if it failed. */
  private async confirm(
    signature: Signature,
    wire: Base64EncodedWireTransaction,
    lastValidBlockHeight: bigint,
  ): Promise<FailedTransaction | null> {
    let lastSend = Date.now();
    for (;;) {
      const { value } = await this.retry(() =>
        this.rpc.getSignatureStatuses([signature], { searchTransactionHistory: false }).send(),
      );
      const status = value[0];
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        if (!status.err) return null;
        const logs = await this.logs(signature);
        return { signature, error: describeTransactionError(status.err, logs), logs };
      }
      const height = await this.retry(() => this.rpc.getBlockHeight({ commitment: "confirmed" }).send());
      if (height > lastValidBlockHeight) throw new Error(`transaction ${signature} expired before it was confirmed`);
      if (Date.now() - lastSend > RESEND_MS) {
        lastSend = Date.now();
        await this.rpc
          .sendTransaction(wire, { encoding: "base64", skipPreflight: true, maxRetries: 0n })
          .send()
          .catch(() => {});
      }
      await sleep(POLL_MS);
    }
  }

  private async logs(signature: Signature): Promise<string[]> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const tx = await this.retry(() =>
        this.rpc
          .getTransaction(signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 })
          .send(),
      );
      if (tx) return [...(tx.meta?.logMessages ?? [])];
      await sleep(POLL_MS);
    }
    return [];
  }

  /**
   * Retries reads through public devnet's rate limits, connect timeouts and outages, for up to `RETRY_FOR_MS`; an
   * RPC that answers with an error is not retried.
   */
  private async retry<T>(call: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + RETRY_FOR_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (isRpcRefusal(error) || Date.now() > deadline) throw error;
        if (attempt === 2) this.log(`  the RPC did not serve a read (${describe(error)}); retrying for up to ${RETRY_FOR_MS / 60_000} minutes`);
        await sleep(Math.min(500 * 2 ** attempt, 15_000));
      }
    }
  }
}

function describeTransactionError(err: unknown, logs: string[]): string {
  const instructionError = (err as { InstructionError?: [number, unknown] }).InstructionError;
  const custom = (instructionError?.[1] as { Custom?: number | bigint } | undefined)?.Custom;
  if (custom !== undefined) {
    const failingProgram = logs.findLast((line) => / failed: /.test(line))?.split(" ")[1];
    if (failingProgram === undefined || failingProgram === KLEND_PROGRAM) {
      const named = fromCode(Number(custom));
      if (named) return named.name;
    }
    return `custom program error ${custom} in instruction ${instructionError![0]}`;
  }
  return JSON.stringify(err, (_, value) => (typeof value === "bigint" ? value.toString() : value));
}

/** Whether the RPC answered with a JSON-RPC error, as opposed to not answering at all. */
function isRpcRefusal(error: unknown): boolean {
  const code = (error as { context?: { __code?: unknown } }).context?.__code;
  return typeof code === "number" && code < 0;
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { message?: string } }).cause?.message;
  const message = error instanceof Error ? error.message : String(error);
  return cause ? `${message}: ${cause}` : message;
}

function describeSendError(error: unknown): string {
  const context = (error as { context?: { logs?: string[] }; cause?: unknown }).context;
  const logs = context?.logs ?? [];
  const cause = (error as { cause?: unknown }).cause;
  const message = error instanceof Error ? error.message : String(error);
  const reason = cause ? describeTransactionError(cause, logs) : "";
  return [message, reason, ...logs].filter(Boolean).join("\n");
}
