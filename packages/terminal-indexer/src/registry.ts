// The registry snapshot (docs/spec/pipescope-architecture.md, Indexer, "Registry snapshot"):
// `getProgramAccounts` on the router for its `Strategy` and `Market` accounts. Any account not yet
// indexed is an event the indexer missed, and is indexed from the account itself.
import { ACCOUNT_DISCRIMINATORS, decodeMarket, decodeStrategy, marketFeeMint, marketMints as mintsOf, PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { getBase58Decoder } from "@solana/kit";
import { marketMints, markets, strategies, type Db } from "terminal-db";
import { rpcCall } from "./rpc";

export type RegisteredStrategy = { program: string; metadataUri: string; registeredAt: Date };
export type RegisteredMarket = {
  address: string;
  strategyProgram: string;
  marketState: string;
  createdBy: string;
  createdAt: Date;
  supportsExactOut: boolean;
  feeMint: string | null;
  mints: { mint: string; vault: string }[];
};
export type Registry = { strategies: RegisteredStrategy[]; markets: RegisteredMarket[] };

const base58 = getBase58Decoder();

async function routerAccounts(rpcUrl: string, name: "Strategy" | "Market"): Promise<{ pubkey: string; data: Uint8Array }[]> {
  const accounts = await rpcCall<{ pubkey: string; account: { data: [string, "base64"] } }[]>(rpcUrl, "getProgramAccounts", [
    PIPELINE_PROGRAM_ADDRESS,
    { encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: base58.decode(ACCOUNT_DISCRIMINATORS[name]) } }] },
  ]);
  return accounts.map(({ pubkey, account }) => ({ pubkey, data: Uint8Array.from(Buffer.from(account.data[0], "base64")) }));
}

/** Every strategy and market registered with the router, read from its accounts; one that does not decode (a newer layout) is left out. */
export async function readRegistry(rpcUrl: string): Promise<Registry> {
  const [strategyAccounts, marketAccounts] = await Promise.all([routerAccounts(rpcUrl, "Strategy"), routerAccounts(rpcUrl, "Market")]);
  const registry: Registry = { strategies: [], markets: [] };
  for (const { data } of strategyAccounts) {
    const s = decodeStrategy(data);
    if (s) registry.strategies.push({ program: s.programId, metadataUri: s.metadataUri, registeredAt: new Date(Number(s.registeredAt) * 1000) });
  }
  for (const { pubkey, data } of marketAccounts) {
    const m = decodeMarket(data);
    if (!m) continue;
    registry.markets.push({
      address: pubkey,
      strategyProgram: m.strategyProgram,
      marketState: m.marketState,
      createdBy: m.createdBy,
      createdAt: new Date(Number(m.createdAt) * 1000),
      supportsExactOut: m.supportsExactOut,
      feeMint: marketFeeMint(m),
      mints: mintsOf(m).map((mint, i) => ({ mint, vault: m.vaults[i]! })),
    });
  }
  return registry;
}

/** Indexes each strategy and market of the registry not indexed yet, from its account, and names what was added. */
export async function indexRegistry(db: Db, registry: Registry): Promise<{ strategies: string[]; markets: string[] }> {
  return db.transaction(async (tx) => {
    const added = { strategies: [] as string[], markets: [] as string[] };
    for (const s of registry.strategies) {
      const [row] = await tx.insert(strategies).values(s).onConflictDoNothing().returning({ program: strategies.program });
      if (row) added.strategies.push(row.program);
    }
    for (const { mints, ...m } of registry.markets) {
      const [row] = await tx.insert(markets).values(m).onConflictDoNothing().returning({ address: markets.address });
      if (!row) continue;
      await tx.insert(marketMints).values(mints.map((x, position) => ({ market: m.address, position, mint: x.mint, vault: x.vault }))).onConflictDoNothing();
      added.markets.push(row.address);
    }
    return added;
  });
}
