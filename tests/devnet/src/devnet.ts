// Devnet for these tests: the project's devnet wallet (~/.config/testing-pipeline/devnet/), swaps on
// the tax AMM's devnet demo market through the router with Pipeline's SDK (as
// apps/keeper/scripts/demo-trade.ts makes them), and swaps read back from the chain itself.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as pipeline from "@pipeline-sol/sdk";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";

export const WALLET_FILE = `${homedir()}/.config/testing-pipeline/devnet/wallet.json`;
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const record = JSON.parse(readFileSync(fileURLToPath(new URL("../../../deployments/devnet-demo-tax-amm.json", import.meta.url)), "utf8")) as { record: [string, string][] };
const named = (label: string) => address(record.record.find(([name]) => name === label)![1]);
export const DEMO_MARKET = named("demo market: market");
const DEMO_MARKET_STATE = named("demo market: market state");
const TAX_AMM = named("strategy program");

export const rpcUrl = () => {
  const url = process.env.RPC_URL;
  if (!url) throw new Error("RPC_URL is not set: run with the project's .env loaded.");
  return url;
};
const rpc = () => createSolanaRpc(rpcUrl());

export async function wallet(): Promise<KeyPairSigner> {
  if ((await rpc().getGenesisHash().send()) !== DEVNET_GENESIS) throw new Error("the RPC is not devnet");
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(WALLET_FILE, "utf8")) as number[]));
}

/**
 * One swap on the demo market by `payer`, exact in, with its quote as the minimum: a sell of the
 * demo token (mint 0) for wrapped SOL (mint 1), or a buy back, keeping at least what the quote
 * leaves after any fee taken from the output. Resolves with its signature once confirmed.
 */
export async function swapOnDemoMarket(payer: KeyPairSigner, side: "buy" | "sell", amount: bigint): Promise<string> {
  const client = rpc();
  const account = (await client.getAccountInfo(DEMO_MARKET, { encoding: "base64" }).send()).value!;
  const market = pipeline.decodeMarket(new Uint8Array(getBase64Encoder().encode(account.data[0])))!;
  const view = pipeline.marketViewFromMarket(DEMO_MARKET, market, [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS]);
  const [inputIndex, outputIndex] = side === "sell" ? [0, 1] : [1, 0];
  const trade = { mode: pipeline.TradeMode.ExactIn, inputIndex, outputIndex, amount, trader: payer.address, extra: new Uint8Array() };
  const simulation = { commitment: "confirmed" } as const;
  const strategyAccounts = await pipeline.resolveAccounts(client, view, trade, payer.address, simulation);
  const { quote } = await pipeline.quoteStrategy(client, view, trade, strategyAccounts, payer.address, simulation);
  const ata = async (mint: Address) => (await findAssociatedTokenPda({ owner: payer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  // Since Pipeline 0.3, a market whose fee mint is the output takes the router's fee from it, so the trader keeps less than the quote.
  const feeSide = pipeline.feeSideOf(market, view.mints[outputIndex]!);
  const minAmountOut = feeSide === "output" ? pipeline.keptAfterOutputFee(quote.amountOut) : quote.amountOut;
  const swap = await pipeline.swap(
    {
      trader: payer.address,
      strategyProgram: TAX_AMM,
      marketState: DEMO_MARKET_STATE,
      traderInput: await ata(view.mints[inputIndex]!),
      traderOutput: await ata(view.mints[outputIndex]!),
      inputVault: view.vaults[inputIndex]!,
      inputMint: view.mints[inputIndex]!,
      outputMint: view.mints[outputIndex]!,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      strategyAccounts,
    },
    { mode: pipeline.TradeMode.ExactIn, amountIn: amount, amountOut: 0n, minAmountOut, integratorFeeBps: 0, extra: new Uint8Array() },
    feeSide,
  );
  const { value: blockhash } = await client.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions([swap], m),
    ),
  );
  await client.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
  const signature = getSignatureFromTransaction(signed);
  for (let i = 0; ; i++) {
    const status = (await client.getSignatureStatuses([signature]).send()).value[0];
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? `${v}` : v))}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    if (i > 120) throw new Error(`${signature} not confirmed after 60 s`);
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** A swap as the chain has it, from the router's event decoded by Pipeline's SDK, in the API's terms. */
export type ChainSwap = { signature: string; slot: number; trader: string; input_mint: string; output_mint: string; net_sent: string; received: string; pipeline_fee: string };

async function call<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Every swap of a market, read from the chain itself: each of its transactions fetched and its router events decoded. */
export async function swapsOnChain(market: string): Promise<ChainSwap[]> {
  const signatures: { signature: string; err: unknown }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [market, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }]);
    signatures.push(...page);
    if (page.length < 1000) break;
    before = page.at(-1)!.signature;
  }
  const swaps: ChainSwap[] = [];
  for (const { signature, err } of signatures) {
    if (err) continue;
    type Raw = { slot: number; transaction: { message: { accountKeys: Address[] } }; meta: { innerInstructions: { instructions: { programIdIndex: number; data: string }[] }[]; loadedAddresses?: { writable: Address[]; readonly: Address[] } } };
    const raw = await call<Raw>("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    const keys = [...raw.transaction.message.accountKeys, ...(raw.meta.loadedAddresses?.writable ?? []), ...(raw.meta.loadedAddresses?.readonly ?? [])];
    for (const event of pipeline.extractEventsFromInnerInstructions(keys, raw.meta.innerInstructions)) {
      if (event.type !== "Swap" || event.data.market !== market) continue;
      const s = event.data;
      swaps.push({ signature, slot: raw.slot, trader: s.trader, input_mint: s.inputMint, output_mint: s.outputMint, net_sent: String(s.netSent), received: String(s.received), pipeline_fee: String(s.pipelineFee) });
    }
  }
  return swaps;
}
