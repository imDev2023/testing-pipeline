// A swap prepared and simulated (docs/spec/pipescope-architecture.md, Trading path, steps 2 and 3, and
// Simulation before every signature; PIPESCOPE-09, PIPESCOPE-33). The transaction is built with
// Pipeline's SDK: the trader's output token account created if missing, SOL wrapped into the trader's
// wrapped-SOL account when they pay in it, the market's fee account for the mint Pipeline's fee is
// taken in created when it does not exist yet (`init_fee_account`), the router's `swap` with our
// integrator fee only when the input is a fee mint, and the wrapped-SOL account closed again so SOL
// in and out is plain SOL. That exact transaction is then simulated with the trader as fee payer,
// signature checks off and the blockhash replaced, and returned with its outcome, compute units and
// what it would change in the wallet. Nothing here signs anything: Aviary holds no keys.
import { feeAccountPda, initFeeAccount, NATIVE_MINT_ADDRESS, swap, TradeMode, TOKEN_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getSyncNativeInstruction } from "@solana-program/token";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
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
import { COMMITMENT, quoteTyped } from "./quote";

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
  const watched: [Address, Address, Address] = [trader, traderInput, traderOutput];
  const before = (await rpc.getMultipleAccounts([...watched, feeAccount], { encoding: "base64", commitment: COMMITMENT }).send()).value;
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

  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: COMMITMENT }).send();
  const compiled = compileTransaction(
    pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  const wire = getBase64EncodedWireTransaction(compiled);
  const simulation = await simulate(rpc, wire, compiled.messageBytes, {
    strategy: market.view.strategyProgram,
    watched,
    before: before.slice(0, 3),
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

type Watch = {
  strategy: string;
  /** The wallet, then its input and output token accounts. */
  watched: [Address, Address, Address];
  before: ({ lamports: bigint; data: readonly [string, string] } | null)[];
  /** Each watched account's mint: null for the wallet's SOL. */
  mints: [null, Address, Address];
  /** Whether the input or the output is SOL, wrapped and unwrapped in the transaction, so the wallet's SOL shows it. */
  paysSol: boolean;
  receivesSol: boolean;
};

type Held = { lamports: bigint; data: readonly [string, string] } | null;

async function simulate(rpc: Rpc<SolanaRpcApi>, wire: Base64EncodedWireTransaction, messageBytes: ReadonlyUint8Array, watch: Watch): Promise<Simulation> {
  const message = getBase64Decoder().decode(messageBytes) as TransactionMessageBytesBase64;
  const [{ value }, fee] = await Promise.all([
    rpc
      .simulateTransaction(wire, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: COMMITMENT,
        accounts: { addresses: watch.watched, encoding: "base64" },
      })
      .send(),
    rpc.getFeeForMessage(message, { commitment: COMMITMENT }).send(),
  ]);
  const logs = [...(value.logs ?? [])];
  const networkFee = fee.value ?? 0n;
  const units = value.unitsConsumed === undefined ? null : Number(value.unitsConsumed);
  if (value.err !== null) {
    return { ok: false, failure: decodeFailure(value.err, logs, { strategy: watch.strategy }), logs, compute_units: units, changes: [], network_fee: String(networkFee), new_accounts: [], paid: null, received: null };
  }
  // A closed account comes back holding no lamports: it is gone.
  const after: Held[] = (value.accounts ?? []).map((a) => (a && a.lamports > 0n ? { lamports: a.lamports, data: a.data as readonly [string, string] } : null));
  const was = (i: number): Held => watch.before[i] ?? null;
  const now = (i: number): Held => after[i] ?? null;
  const created: Simulation["new_accounts"] = [];
  const changes: BalanceChange[] = [{ mint: null, account: watch.watched[0], before: String(was(0)?.lamports ?? 0n), after: String(now(0)?.lamports ?? 0n) }];
  for (const i of [1, 2] as const) {
    // A temporary account (the wrapped SOL, created and closed in the same transaction) changed nothing that stays.
    if (!was(i) && !now(i)) continue;
    if (!was(i)) created.push({ account: watch.watched[i], mint: watch.mints[i], rent: String(now(i)!.lamports) });
    changes.push({ mint: watch.mints[i], account: watch.watched[i], before: String(tokenAmount(was(i)?.data)), after: String(tokenAmount(now(i)?.data)) });
  }
  // What the swap itself took and gave: SOL is the wallet's own balance, less the network fee and the rent of accounts it keeps.
  const solChange = (now(0)?.lamports ?? 0n) - (was(0)?.lamports ?? 0n) + networkFee + created.reduce((n, a) => n + BigInt(a.rent), 0n);
  const tokenChange = (i: 1 | 2) => tokenAmount(now(i)?.data) - tokenAmount(was(i)?.data);
  const paid = watch.paysSol ? -solChange : -tokenChange(1);
  const received = watch.receivesSol ? solChange : tokenChange(2);
  return { ok: true, failure: null, logs, compute_units: units, changes, network_fee: String(networkFee), new_accounts: created, paid: String(paid), received: String(received) };
}
