// A swap prepared and simulated (docs/spec/pipescope-architecture.md, Trading path, steps 2 and 3, and
// Simulation before every signature; PIPESCOPE-09, PIPESCOPE-33). The transaction is built with
// Pipeline's SDK: the trader's output token account created if missing, SOL wrapped into the trader's
// wrapped-SOL account when they pay in it, the market's fee account for the mint Pipeline's fee is
// taken in created when it does not exist yet (`init_fee_account`), the router's `swap` with our
// integrator fee only when the input is a fee mint, and the wrapped-SOL account closed again so SOL
// in and out is plain SOL. That exact transaction is then simulated with the trader as fee payer,
// signature checks off and the blockhash replaced, and returned with its outcome, compute units and
// what it would change in the wallet. Nothing here signs anything: Aviary holds no keys.
import { decodeMarketLookupTable, feeAccountPda, initFeeAccount, lookupTableRecordPda, NATIVE_MINT_ADDRESS, swap, TradeMode, TOKEN_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getSyncNativeInstruction } from "@solana-program/token";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  getAddressDecoder,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Instruction,
  type ReadonlyUint8Array,
  type Rpc,
  type SolanaRpcApi,
  type TransactionMessageBytesBase64,
} from "@solana/kit";
import type { BalanceChange, PreparedSwap, Simulation } from "../contract";
import type { IntegratorFeeVar } from "../env";
import { minimumReceived } from "./amounts";
import { decodeFailure } from "./failure";
import type { TradeMarket } from "./market";
import { COMMITMENT, quoteTyped, Refused } from "./quote";

const base64 = getBase64Encoder();
/** A token account's amount: a u64 after its mint and owner. */
const AMOUNT_OFFSET = 64;

const tokenAmount = (data: readonly [string, string] | undefined): bigint => {
  if (!data) return 0n;
  const bytes = new Uint8Array(base64.encode(data[0]));
  return bytes.length >= AMOUNT_OFFSET + 8 ? new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(AMOUNT_OFFSET, true) : 0n;
};

export type PrepareInput = { market: TradeMarket; inputMint: string; outputMint: string; typed: bigint; slippageBps: number; trader: Address };

export async function prepareSwap(rpc: Rpc<SolanaRpcApi>, setting: IntegratorFeeVar, input: PrepareInput): Promise<PreparedSwap> {
  const { market, trader } = input;
  const { quote, trade, strategyAccounts, feeSide, integratorAccount } = await quoteTyped(rpc, setting, { ...input, trader });
  const mintOf = (mint: string) => market.mints.find((m) => m.address === mint)!;
  const [inputMint, outputMint] = [mintOf(input.inputMint), mintOf(input.outputMint)];
  const ata = async (mint: Address, tokenProgram: Address) => (await findAssociatedTokenPda({ owner: trader, mint, tokenProgram }))[0];
  const traderInput = await ata(inputMint.address, inputMint.tokenProgram);
  const traderOutput = await ata(outputMint.address, outputMint.tokenProgram);
  const paysSol = inputMint.address === NATIVE_MINT_ADDRESS;
  const receivesSol = outputMint.address === NATIVE_MINT_ADDRESS;
  const feeMint = feeSide === "output" ? outputMint : inputMint;
  const feeAccount = await feeAccountPda(market.address, feeMint.address, feeMint.tokenProgram);
  const minAmountOut = minimumReceived(BigInt(quote.expected_out), input.slippageBps);
  const signer = createNoopSigner(trader);

  // What the wallet holds before, and whether the market's fee account exists, in one read.
  const watched = [trader, traderInput, traderOutput, feeAccount] as const;
  const before = (await rpc.getMultipleAccounts([...watched], { encoding: "base64", commitment: COMMITMENT }).send()).value;
  const feeAccountMissing = before[3] === null;

  const instructions: Instruction[] = [
    getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: traderOutput, owner: trader, mint: outputMint.address, tokenProgram: outputMint.tokenProgram }),
  ];
  if (paysSol) {
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: traderInput, owner: trader, mint: inputMint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      getTransferSolInstruction({ source: signer, destination: traderInput, amount: BigInt(quote.total_spend) }),
      getSyncNativeInstruction({ account: traderInput }),
    );
  }
  if (feeAccountMissing) instructions.push(await initFeeAccount({ payer: trader, market: market.address, mint: feeMint.address, tokenProgram: feeMint.tokenProgram }));
  instructions.push(
    await swap(
      {
        trader,
        strategyProgram: market.view.strategyProgram,
        marketState: market.view.marketState,
        traderInput,
        traderOutput,
        inputVault: market.view.vaults[trade.inputIndex]!,
        inputMint: inputMint.address,
        outputMint: outputMint.address,
        inputTokenProgram: inputMint.tokenProgram,
        outputTokenProgram: outputMint.tokenProgram,
        integratorFeeAccount: integratorAccount,
        strategyAccounts,
      },
      // Exact-in reads only `amountIn`; `amountOut` carries the strategy's quoted output, as Pipeline's own builder sets it.
      { mode: TradeMode.ExactIn, amountIn: trade.amount, amountOut: BigInt(quote.strategy_amount_out), minAmountOut, integratorFeeBps: quote.integrator_fee_bps, extra: trade.extra },
      feeSide,
    ),
  );
  // SOL in and out is plain SOL: the wrapped-SOL account is closed back into the wallet.
  if (paysSol || receivesSol) instructions.push(getCloseAccountInstruction({ account: paysSol ? traderInput : traderOutput, destination: trader, owner: signer }));

  const [{ value: lifetime }, table] = await Promise.all([rpc.getLatestBlockhash({ commitment: COMMITMENT }).send(), marketLookupTable(rpc, market.address)]);
  let fitted: Fitted;
  try {
    fitted = fitTransaction(instructions, trader, lifetime, table);
  } catch (e) {
    if (e instanceof TooLarge) throw new Refused({ class: "too_large", sentence: e.message, name: null, number: null, message: null, program: null, raw: e.message });
    throw e;
  }
  const { wire, messageBytes } = fitted;
  const simulation = await simulate(rpc, wire, messageBytes, {
    strategy: market.view.strategyProgram,
    watched,
    before,
    mints: [null, inputMint.address, outputMint.address],
    paysSol,
    receivesSol,
  });

  // A failure the wallet's own balances explain is told as that, whatever program raised it.
  if (!simulation.ok && simulation.failure && simulation.failure.class !== "too_little") {
    const sol = before[0]?.lamports ?? 0n;
    const short = paysSol ? sol < BigInt(quote.total_spend) : tokenAmount(before[1]?.data) < BigInt(quote.total_spend);
    if (short) simulation.failure = { ...simulation.failure, class: "too_little", sentence: "Your wallet holds too little for this swap." };
  }
  return { quote, slippage_bps: input.slippageBps, min_amount_out: String(minAmountOut), transaction: simulation.ok ? wire : null, simulation };
}

/** The most bytes one transaction may be on the wire. */
const TRANSACTION_MAX_BYTES = 1232;

/** A swap that does not fit in one transaction. */
export class TooLarge extends Error {}

export type LookupTable = { address: Address; addresses: readonly Address[] };
type Fitted = { wire: Base64EncodedWireTransaction; messageBytes: ReadonlyUint8Array; version: "legacy" | 0 };

/**
 * The swap as one transaction, paid by the trader: a legacy transaction when it fits, as Pipeline's own
 * builder makes it, else a version 0 one shortened by the market's recorded address lookup table
 * (Pipeline 0.3's `record_lookup_table`); a swap that fits neither way is refused.
 */
export function fitTransaction(instructions: readonly Instruction[], trader: Address, lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint }, table: LookupTable | null): Fitted {
  const signer = createNoopSigner(trader);
  const legacyMessage = () =>
    pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
  const versionedMessage = () =>
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
  const fits = (compiled: ReturnType<typeof compileTransaction>) => base64.encode(getBase64EncodedWireTransaction(compiled)).length <= TRANSACTION_MAX_BYTES;
  // Too many accounts can fail to compile at all; that is too large as well.
  const attempt = (make: () => ReturnType<typeof compileTransaction>) => {
    try {
      const compiled = make();
      return fits(compiled) ? compiled : null;
    } catch {
      return null;
    }
  };
  const legacy = attempt(() => compileTransaction(legacyMessage()));
  if (legacy) return { wire: getBase64EncodedWireTransaction(legacy), messageBytes: legacy.messageBytes, version: "legacy" };
  if (!table) throw new TooLarge("This swap needs more accounts than one transaction can carry, and its market has recorded no address lookup table to shorten it.");
  const shortened = attempt(() => compileTransaction(compressTransactionMessageUsingAddressLookupTables(versionedMessage(), { [table.address]: [...table.addresses] })));
  if (shortened) return { wire: getBase64EncodedWireTransaction(shortened), messageBytes: shortened.messageBytes, version: 0 };
  throw new TooLarge("This swap needs more accounts than one transaction can carry, even with its market's address lookup table.");
}

/** An address lookup table's addresses follow its 56-byte header, 32 bytes each. */
const LOOKUP_TABLE_HEADER = 56;

/** The market's recorded address lookup table and its addresses, or null when it has none. */
async function marketLookupTable(rpc: Rpc<SolanaRpcApi>, market: Address): Promise<LookupTable | null> {
  const [record] = (await rpc.getMultipleAccounts([await lookupTableRecordPda(market)], { encoding: "base64", commitment: COMMITMENT }).send()).value;
  const decoded = record ? decodeMarketLookupTable(new Uint8Array(base64.encode(record.data[0]))) : null;
  if (!decoded) return null;
  const [tableAccount] = (await rpc.getMultipleAccounts([decoded.table], { encoding: "base64", commitment: COMMITMENT }).send()).value;
  if (!tableAccount) return null;
  const bytes = new Uint8Array(base64.encode(tableAccount.data[0]));
  const decoder = getAddressDecoder();
  const addresses: Address[] = [];
  for (let at = LOOKUP_TABLE_HEADER; at + 32 <= bytes.length; at += 32) addresses.push(decoder.decode(bytes.subarray(at, at + 32)));
  return { address: decoded.table, addresses };
}

type Held = { lamports: bigint; data: readonly [string, string] } | null;

export type Measured = Pick<Simulation, "changes" | "new_accounts" | "market_rent" | "paid" | "received">;

/**
 * What a passed simulation says the swap takes from the wallet and gives it, from the accounts read
 * before and simulated after: the wallet, its input and output token accounts, and the market's fee
 * account for the mint Pipeline's fee is taken in. SOL is the wallet's own balance, less the network
 * fee, the rent of the token accounts the swap creates and keeps (the wallet's, and the market's fee
 * account, which its first swap in that mint pays for), and what closing a wrapped-SOL account the
 * wallet already held hands back, which is the wallet's own SOL and no part of the swap.
 */
export function measure(input: {
  watched: readonly [string, string, string, string];
  mints: readonly [null, string, string];
  before: readonly Held[];
  after: readonly Held[];
  networkFee: bigint;
  paysSol: boolean;
  receivesSol: boolean;
}): Measured {
  const was = (i: number): Held => input.before[i] ?? null;
  const now = (i: number): Held => input.after[i] ?? null;
  const created: Simulation["new_accounts"] = [];
  const changes: BalanceChange[] = [{ mint: null, account: input.watched[0], before: String(was(0)?.lamports ?? 0n), after: String(now(0)?.lamports ?? 0n) }];
  let handedBack = 0n;
  for (const i of [1, 2] as const) {
    // A temporary account (the wrapped SOL, created and closed in the same transaction) changed nothing that stays.
    if (!was(i) && !now(i)) continue;
    if (!was(i)) created.push({ account: input.watched[i], mint: input.mints[i], rent: String(now(i)!.lamports) });
    if (was(i) && !now(i)) handedBack += was(i)!.lamports;
    changes.push({ mint: input.mints[i], account: input.watched[i], before: String(tokenAmount(was(i)?.data)), after: String(tokenAmount(now(i)?.data)) });
  }
  const marketRent = !was(3) && now(3) ? now(3)!.lamports : 0n;
  const keptRent = created.reduce((n, a) => n + BigInt(a.rent), 0n);
  const swapSol = (now(0)?.lamports ?? 0n) - (was(0)?.lamports ?? 0n) + input.networkFee + keptRent + marketRent - handedBack;
  const tokenChange = (i: 1 | 2) => tokenAmount(now(i)?.data) - tokenAmount(was(i)?.data);
  return {
    changes,
    new_accounts: created,
    market_rent: String(marketRent),
    paid: String(input.paysSol ? -swapSol : -tokenChange(1)),
    received: String(input.receivesSol ? swapSol : tokenChange(2)),
  };
}

type Watch = {
  strategy: string;
  /** The wallet, its input and output token accounts, and the market's fee account for the fee mint. */
  watched: readonly [Address, Address, Address, Address];
  before: readonly Held[];
  /** Each watched token account's mint: null for the wallet's SOL. */
  mints: readonly [null, Address, Address];
  /** Whether the input or the output is SOL, wrapped and unwrapped in the transaction, so the wallet's SOL shows it. */
  paysSol: boolean;
  receivesSol: boolean;
};

async function simulate(rpc: Rpc<SolanaRpcApi>, wire: Base64EncodedWireTransaction, messageBytes: ReadonlyUint8Array, watch: Watch): Promise<Simulation> {
  const message = getBase64Decoder().decode(messageBytes) as TransactionMessageBytesBase64;
  let answers;
  try {
    answers = await Promise.all([
    rpc
      .simulateTransaction(wire, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: COMMITMENT,
        accounts: { addresses: [...watch.watched], encoding: "base64" },
      })
      .send(),
    rpc.getFeeForMessage(message, { commitment: COMMITMENT }).send(),
  ]);
  } catch (e) {
    // The RPC refused the simulation itself (the transaction malformed, or the RPC unavailable): told plainly, never with its URL.
    const raw = (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, "the RPC");
    throw new Refused({ class: "unavailable", sentence: "The swap could not be simulated, so there is nothing to sign. Try again in a moment.", name: null, number: null, message: null, program: null, raw });
  }
  const [{ value }, fee] = answers;
  const logs = [...(value.logs ?? [])];
  const networkFee = fee.value ?? 0n;
  const units = value.unitsConsumed === undefined ? null : Number(value.unitsConsumed);
  if (value.err !== null) {
    return { ok: false, failure: decodeFailure(value.err, logs, { strategy: watch.strategy }), logs, compute_units: units, changes: [], network_fee: String(networkFee), new_accounts: [], market_rent: "0", paid: null, received: null };
  }
  // A closed account comes back holding no lamports: it is gone.
  const after: Held[] = (value.accounts ?? []).map((a) => (a && a.lamports > 0n ? { lamports: a.lamports, data: a.data as readonly [string, string] } : null));
  const measured = measure({ watched: watch.watched, mints: watch.mints, before: watch.before, after, networkFee, paysSol: watch.paysSol, receivesSol: watch.receivesSol });
  return { ok: true, failure: null, logs, compute_units: units, network_fee: String(networkFee), ...measured };
}
