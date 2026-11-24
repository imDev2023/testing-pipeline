// The views the API serves of markets and trades, built in one place, so the feed's endpoints and the
// live rooms (./liveRoom) send exactly the same thing: each market with its pair by the quote mint
// order (PIPESCOPE-74), its mints' own names and images (PIPESCOPE-22), what its vaults hold and its
// last 24 hours, its strategy's name and its trust flags (./facts); each trade with its pair and side.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { markets} from "terminal-db";
import { marketMints, mints, strategies, trades, type Db } from "terminal-db";
import { AVIARY_MINT_NAMES, VOLUME_WINDOW_SECONDS } from "./config";
import type { Market, MintName, Trade } from "./contract";
import { orderedFlags, strategyFacts } from "./facts";
import { marketPair, tradePair } from "./pairs";
import { keptImages, tokenNameOf } from "./tokenImages";

type MarketRow = typeof markets.$inferSelect;

/** Each market's mints in order, with their vaults and decimals, and its last 24 hours, read for a page of markets at once. */
export async function marketViews(database: Db, rows: MarketRow[]): Promise<Market[]> {
  if (!rows.length) return [];
  const addresses = rows.map((m) => m.address);
  const held = await database
    .select({
      market: marketMints.market,
      position: marketMints.position,
      mint: marketMints.mint,
      vault: marketMints.vault,
      liquidity: marketMints.vaultAmount,
      decimals: mints.decimals,
      flags: mints.flags,
      symbol: mints.symbol,
      name: mints.name,
      tokenUri: mints.tokenUri,
    })
    .from(marketMints)
    .leftJoin(mints, eq(mints.address, marketMints.mint))
    .where(inArray(marketMints.market, addresses))
    .orderBy(marketMints.market, marketMints.position);
  const since = BigInt(Math.floor(Date.now() / 1000) - VOLUME_WINDOW_SECONDS);
  const recent = await database
    .select({
      market: trades.market,
      inputMint: trades.inputMint,
      outputMint: trades.outputMint,
      trades: sql<number>`count(*)::int`,
      netSent: sql<string>`sum(${trades.netSent})::text`,
      received: sql<string>`sum(${trades.received})::text`,
    })
    .from(trades)
    .where(and(inArray(trades.market, addresses), gte(trades.unixTimestamp, since)))
    .groupBy(trades.market, trades.inputMint, trades.outputMint);
  const images = await keptImages(database, held.map((h) => h.tokenUri));
  const owners = [...new Set(rows.map((m) => m.strategyProgram))];
  const facts = await strategyFacts(database, await database.select({ program: strategies.program, metadataUri: strategies.metadataUri }).from(strategies).where(inArray(strategies.program, owners)));

  return rows.map((m) => {
    const own = held.filter((h) => h.market === m.address);
    const strategy = facts.get(m.strategyProgram);
    const { quote, base } = marketPair(own.map((h) => h.mint));
    let count = 0;
    let volume = 0n;
    for (const r of recent.filter((r) => r.market === m.address)) {
      count += r.trades;
      if (r.inputMint === quote) volume += BigInt(r.netSent);
      else if (r.outputMint === quote) volume += BigInt(r.received);
    }
    return {
      address: m.address,
      strategy: m.strategyProgram,
      market_state: m.marketState,
      created_at: m.createdAt.toISOString(),
      created_by: m.createdBy,
      created_signature: m.createdSignature,
      fee_mint: m.feeMint,
      supports_exact_out: m.supportsExactOut,
      mints: own.map((h) => ({
        mint: h.mint,
        symbol: AVIARY_MINT_NAMES[h.mint] ?? null,
        token: tokenNameOf(h.mint, h, images),
        decimals: h.decimals,
        vault: h.vault,
        liquidity: h.liquidity,
        flags: h.flags === null ? null : orderedFlags(h.flags),
      })),
      quote_mint: quote,
      base_mint: base,
      stats_24h: { trades: count, volume_quote: String(volume) },
      strategy_name: strategy?.name ?? null,
      strategy_metadata: strategy?.metadata.status ?? "not-fetched",
      flags: orderedFlags([...(strategy?.flags ?? []), ...own.flatMap((h) => h.flags ?? [])]),
    };
  });
}

type TradeRow = typeof trades.$inferSelect;

/** Trades as the API serves them, each with its pair by its market's order of mints and whether it bought or sold the base mint. */
export async function tradeViews(database: Db, rows: TradeRow[]): Promise<Trade[]> {
  const marketsOf = [...new Set(rows.map((t) => t.market))];
  const held = marketsOf.length
    ? await database.select({ market: marketMints.market, mint: marketMints.mint }).from(marketMints).where(inArray(marketMints.market, marketsOf)).orderBy(marketMints.market, marketMints.position)
    : [];
  return rows.map((t): Trade => {
    const { quote, base, side } = tradePair(held.filter((h) => h.market === t.market).map((h) => h.mint), t.inputMint, t.outputMint);
    return {
      signature: t.signature,
      event_index: t.eventIndex,
      slot: Number(t.slot),
      block_index: t.blockIndex,
      block_time: t.blockTime?.toISOString() ?? null,
      market: t.market,
      trader: t.trader,
      input_mint: t.inputMint,
      output_mint: t.outputMint,
      mode: t.mode === 1 ? "exact_out" : "exact_in",
      net_sent: t.netSent,
      received: t.received,
      pipeline_fee: t.pipelineFee,
      fee_mint: t.feeMint,
      integrator: t.integrator,
      integrator_fee: t.integratorFee,
      quote_mint: quote,
      base_mint: base,
      side,
    };
  });
}

/** Each mint named as a list shows it, Aviary's own name or the token's with its kept image, and its decimals; in address order. */
export async function mintNames(database: Db, addresses: readonly string[]): Promise<MintName[]> {
  const wanted = [...new Set(addresses)].sort();
  if (!wanted.length) return [];
  const rows = await database.select({ address: mints.address, decimals: mints.decimals, symbol: mints.symbol, name: mints.name, tokenUri: mints.tokenUri }).from(mints).where(inArray(mints.address, wanted));
  const images = await keptImages(database, rows.map((r) => r.tokenUri));
  return wanted.map((mint) => {
    const read = rows.find((r) => r.address === mint);
    return { mint, symbol: AVIARY_MINT_NAMES[mint] ?? null, token: tokenNameOf(mint, read, images), decimals: read?.decimals ?? null };
  });
}
