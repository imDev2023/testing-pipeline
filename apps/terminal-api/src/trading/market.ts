// A market as a trade needs it, read from the chain on Aviary's RPC (docs/spec/pipescope-architecture.md,
// Trading path): the router's `Market` account, decoded by Pipeline's SDK, and each mint's owning
// token program and decimals. Read fresh for each quote and prepare, since a quote must be the
// strategy's answer now, not the indexer's last reading.
import { decodeMarket, marketMints, marketViewFromMarket, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, type Market, type MarketView } from "@pipeline-sol/sdk";
import { address, getAddressDecoder, getBase64Encoder, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { HTTPException } from "hono/http-exception";

/** A mint as a trade needs it; `transferHook` is the program its transfer hook calls, or null when it has none. */
export type TradeMint = { address: Address; tokenProgram: Address; decimals: number; transferHook: Address | null };

export type TradeMarket = { address: Address; market: Market; view: MarketView; mints: TradeMint[] };

const base64 = getBase64Encoder();
const bytesOf = (data: readonly [string, string]) => new Uint8Array(base64.encode(data[0]));

/** A mint's decimals sit after its authority option and supply: byte 44 of the classic layout, which Token-2022 keeps. */
const DECIMALS_OFFSET = 44;
/** Token-2022 lays extensions after the 165 bytes of an account, its account type, then type-length-value entries. */
const EXTENSIONS_START = 166;
/**
 * The Token-2022 extensions Aviary quotes and builds no swap of (PIPESCOPE-135): a transfer moves
 * less than was sent, or may be refused outright. A quote and its review promise exactly what leaves
 * the wallet and what arrives, so such a mint gets none. A transfer hook is traded: its accounts are
 * resolved from the mint's own list (./hooks), and the simulation shows whether the hook allows it.
 */
const NOT_PLAIN: ReadonlyMap<number, string> = new Map([
  [1, "a transfer fee, so less arrives than is sent"],
  [9, "no transfers at all"],
  [26, "a pause switch that can refuse every transfer"],
]);
/** The transfer hook extension: its authority, then the program every transfer calls (both optional, zeroes for none). */
const TRANSFER_HOOK = 14;

/** The Token-2022 extension types a mint carries, read from its type-length-value entries. */
export function extensionTypes(data: Uint8Array): number[] {
  return extensions(data).map((e) => e.type);
}

/** The Token-2022 extensions a mint carries, each with where its value starts. */
function extensions(data: Uint8Array): { type: number; at: number; length: number }[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const found: { type: number; at: number; length: number }[] = [];
  for (let at = EXTENSIONS_START; at + 4 <= data.length; ) {
    const length = view.getUint16(at + 2, true);
    found.push({ type: view.getUint16(at, true), at: at + 4, length });
    at += 4 + length;
  }
  return found;
}

/** The program a Token-2022 mint's transfer hook calls, or null when it has no hook or no program set. */
export function transferHookProgram(data: Uint8Array): Address | null {
  const hook = extensions(data).find((e) => e.type === TRANSFER_HOOK && e.length >= 64);
  if (!hook) return null;
  const program = data.subarray(hook.at + 32, hook.at + 64);
  return program.every((b) => b === 0) ? null : getAddressDecoder().decode(program);
}

/** Why a mint is not plain, or null when it is. */
export function notPlain(data: Uint8Array): string | null {
  const found = extensionTypes(data).find((type) => NOT_PLAIN.has(type));
  return found === undefined ? null : NOT_PLAIN.get(found)!;
}

const notTradable = (message: string) => new HTTPException(422, { message });

/** Reads `market` and its mints; refuses a market that is no market, a mint not read, and a mint whose transfers move less than sent or may be refused (PIPESCOPE-135). */
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
    const why = held.owner === TOKEN_2022_PROGRAM_ADDRESS ? notPlain(data) : null;
    if (why) throw notTradable(`This market's mint ${mint} has ${why}, so Aviary quotes and builds no swap of it.`);
    return { address: mint, tokenProgram: held.owner, decimals: data[DECIMALS_OFFSET]!, transferHook: held.owner === TOKEN_2022_PROGRAM_ADDRESS ? transferHookProgram(data) : null };
  });
  return { address: at, market, view: marketViewFromMarket(at, market, mints.map((m) => m.tokenProgram)), mints };
}
