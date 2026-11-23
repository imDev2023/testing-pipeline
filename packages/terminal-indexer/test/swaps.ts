// Swaps for tests: the real devnet swap of test/fixtures/swap.json, its router event re-encoded with
// the market, mints, amounts, clock and place in the chain a test names, so it runs through the
// real decoder and handler as any swap from the chain would.
import { readFileSync } from "node:fs";
import { encodeEvent, PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { address, getBase58Decoder } from "@solana/kit";
import { accountKeysOf, type RawTransaction } from "../src/decode";

const fixture = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/swap.json`, "utf8")) as RawTransaction;
const base58 = getBase58Decoder();

/** The fixture's market and its two mints, in the market's own order. */
export const SWAP_MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
export const SWAP_TOKEN = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";
export const WSOL = "So11111111111111111111111111111111111111112";

export type SwapSpec = {
  /** Makes the signature: one per transaction. */
  id: number;
  slot: number;
  blockIndex: number;
  /** The event's clock, in Unix seconds. */
  at: number;
  /** The block's time, in Unix seconds, when it differs from the event's clock; null for a block whose time is unknown. */
  blockTime?: number | null;
  market?: string;
  input: string;
  output: string;
  netSent: bigint;
  received: bigint;
  trader?: string;
};

/** A unique 87-character base58 signature for `id`. */
export const signatureFor = (id: number) => `${fixture.transaction.signatures[0]!.slice(0, 77)}${String(id).padStart(10, "1").replaceAll("0", "z")}`;

/** A successful router transaction holding one swap, as `getTransactionsForAddress` serves it. */
export function swapTransaction(spec: SwapSpec): RawTransaction {
  const raw = structuredClone(fixture);
  const keys = accountKeysOf(raw);
  const data = base58.decode(
    encodeEvent({
      type: "Swap",
      data: {
        market: address(spec.market ?? SWAP_MARKET),
        strategy: address("J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t"),
        trader: address(spec.trader ?? "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt"),
        inputMint: address(spec.input),
        outputMint: address(spec.output),
        mode: 0,
        netSent: spec.netSent,
        received: spec.received,
        pipelineFee: 0n,
        integrator: null,
        integratorFee: 0n,
        slot: BigInt(spec.slot),
        unixTimestamp: BigInt(spec.at),
        feeMint: address(WSOL),
      },
    }),
  );
  for (const group of raw.meta!.innerInstructions!) for (const ix of group.instructions) if (keys[ix.programIdIndex] === PIPELINE_PROGRAM_ADDRESS) ix.data = data;
  raw.slot = spec.slot;
  raw.blockTime = spec.blockTime === undefined ? spec.at : spec.blockTime;
  raw.transactionIndex = spec.blockIndex;
  raw.transaction.signatures[0] = signatureFor(spec.id);
  return raw;
}
