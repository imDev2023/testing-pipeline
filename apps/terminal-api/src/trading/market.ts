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
/**
 * The Token-2022 extensions that make a mint other than plain (PIPESCOPE-135): a transfer moves less
 * than was sent, or needs accounts Aviary does not resolve yet, or may be refused outright. A quote
 * and its review promise exactly what leaves the wallet and what arrives, so such a mint gets none.
 */
const NOT_PLAIN: ReadonlyMap<number, string> = new Map([
  [1, "a transfer fee, so less arrives than is sent"],
  [9, "no transfers at all"],
  [14, "a transfer hook, whose accounts Aviary does not resolve yet"],
  [26, "a pause switch that can refuse every transfer"],
]);

/** The Token-2022 extension types a mint carries, read from its type-length-value entries. */
export function extensionTypes(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const types: number[] = [];
  for (let at = EXTENSIONS_START; at + 4 <= data.length; ) {
    types.push(view.getUint16(at, true));
    at += 4 + view.getUint16(at + 2, true);
  }
  return types;
}

/** Why a mint is not plain, or null when it is. */
export function notPlain(data: Uint8Array): string | null {
  const found = extensionTypes(data).find((type) => NOT_PLAIN.has(type));
  return found === undefined ? null : NOT_PLAIN.get(found)!;
}

const notTradable = (message: string) => new HTTPException(422, { message });

/**
 * Reads `market` and its mints, whatever their extensions, as a custom action needs them; refuses a
 * market that is no market and a mint that cannot be read as a token.
 */
export async function readMarketOnChain(rpc: Rpc<SolanaRpcApi>, marketAddress: string): Promise<TradeMarket & { data: Uint8Array[] }> {
  const at = address(marketAddress);
  const [account] = (await rpc.getMultipleAccounts([at], { encoding: "base64", commitment: "confirmed" }).send()).value;
  const market = account ? decodeMarket(bytesOf(account.data)) : null;
  if (!market) throw new HTTPException(404, { message: "Aviary knows no market created through Pipeline at this address." });
  const addresses = marketMints(market);
  const accounts = (await rpc.getMultipleAccounts(addresses, { encoding: "base64", commitment: "confirmed" }).send()).value;
  const data: Uint8Array[] = [];
  const mints = addresses.map((mint, i): TradeMint => {
    const held = accounts[i];
    if (!held || (held.owner !== TOKEN_PROGRAM_ADDRESS && held.owner !== TOKEN_2022_PROGRAM_ADDRESS)) throw notTradable(`This market's mint ${mint} could not be read as a token, so it cannot be traded.`);
    data.push(bytesOf(held.data));
    return { address: mint, tokenProgram: held.owner, decimals: data[i]![DECIMALS_OFFSET]! };
  });
  return { address: at, market, view: marketViewFromMarket(at, market, mints.map((m) => m.tokenProgram)), mints, data };
}

/** Reads `market` and its mints for a swap; refuses also a mint that is not plain (PIPESCOPE-135). */
export async function readTradeMarket(rpc: Rpc<SolanaRpcApi>, marketAddress: string): Promise<TradeMarket> {
  const { data, ...read } = await readMarketOnChain(rpc, marketAddress);
  read.mints.forEach((mint, i) => {
    const why = mint.tokenProgram === TOKEN_2022_PROGRAM_ADDRESS ? notPlain(data[i]!) : null;
    if (why) throw notTradable(`This market's mint ${mint.address} has ${why}, so Aviary quotes and builds no swap of it.`);
  });
  return read;
}
