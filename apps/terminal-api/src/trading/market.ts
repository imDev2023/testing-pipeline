// A market as a trade needs it, read from the chain on Aviary's RPC (docs/spec/pipescope-architecture.md,
// Trading path): the router's `Market` account, decoded by Pipeline's SDK, and each mint's owning
// token program and decimals. Read fresh for each quote and prepare, since a quote must be the
// strategy's answer now, not the indexer's last reading.
import { decodeMarket, marketMints, marketViewFromMarket, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, type Market, type MarketView } from "@pipeline-sol/sdk";
import { address, getBase64Encoder, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { HTTPException } from "hono/http-exception";

export type TradeMint = { address: Address; tokenProgram: Address; decimals: number };

export type TradeMarket = { address: Address; market: Market; view: MarketView; mints: TradeMint[] };

const base64 = getBase64Encoder();
const bytesOf = (data: readonly [string, string]) => new Uint8Array(base64.encode(data[0]));

/** A mint's decimals sit after its authority option and supply: byte 44 of the classic layout, which Token-2022 keeps. */
const DECIMALS_OFFSET = 44;
/** Token-2022 lays extensions after the 165 bytes of an account, its account type, then type-length-value entries. */
const EXTENSIONS_START = 166;
const TRANSFER_HOOK = 14;

/** Whether a Token-2022 mint carries the transfer-hook extension. */
export function hasTransferHook(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = EXTENSIONS_START; at + 4 <= data.length; ) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (type === TRANSFER_HOOK) return true;
    at += 4 + length;
  }
  return false;
}

const notTradable = (message: string) => new HTTPException(422, { message });

/** Reads `market` and its mints; refuses a market that is no market, a mint not read, and a mint with a transfer hook (#122). */
export async function readTradeMarket(rpc: Rpc<SolanaRpcApi>, marketAddress: string): Promise<TradeMarket> {
  const at = address(marketAddress);
  const [account] = (await rpc.getMultipleAccounts([at], { encoding: "base64", commitment: "confirmed" }).send()).value;
  const market = account ? decodeMarket(bytesOf(account.data)) : null;
  if (!market) throw new HTTPException(404, { message: "Aviary knows no market created through Pipeline at this address." });
  const addresses = marketMints(market);
  const accounts = (await rpc.getMultipleAccounts(addresses, { encoding: "base64", commitment: "confirmed" }).send()).value;
  const mints = addresses.map((mint, i): TradeMint => {
    const held = accounts[i];
    if (!held || (held.owner !== TOKEN_PROGRAM_ADDRESS && held.owner !== TOKEN_2022_PROGRAM_ADDRESS)) throw notTradable(`This market's mint ${mint} could not be read as a token, so it cannot be traded.`);
    const data = bytesOf(held.data);
    if (held.owner === TOKEN_2022_PROGRAM_ADDRESS && hasTransferHook(data)) {
      throw notTradable(`This market's mint ${mint} has a transfer hook, whose accounts Aviary does not resolve yet, so it quotes and builds no swap of it.`);
    }
    return { address: mint, tokenProgram: held.owner, decimals: data[DECIMALS_OFFSET]! };
  });
  return { address: at, market, view: marketViewFromMarket(at, market, mints.map((m) => m.tokenProgram)), mints };
}
