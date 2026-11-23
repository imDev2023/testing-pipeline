// Search (docs/spec/pipescope-screens.md, Search; PIPESCOPE-81, PIPESCOPE-124), from Postgres: what is
// registered with Pipeline that matches what was typed, grouped as strategies, markets and mints.
//
// - Names match anywhere and in any case: a strategy's name from the valid metadata it names now, a
//   token's symbol and name as the normaliser left them, and the names Aviary gives SOL and USDC.
// - Addresses match exactly as typed, from their start or their end, since base58 is case-sensitive:
//   a strategy's program, a market, a market state or a mint.
// - Only mints that trade on a Pipeline market are searched; a mint Aviary names is matched by
//   Aviary's name, never by its author's.
//
// What was typed is compared as text (`starts_with`, `right`, `strpos`), never as a pattern, so `%`
// and `_` match only themselves.
import { sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { marketMints, markets, metadataSnapshots, mints, strategies } from "terminal-db";
import { AVIARY_MINT_NAMES, PAGE_LIMITS, SEARCH_QUERY_MAX } from "./config";
import { SearchResults, type SearchMint } from "./contract";
import { strategyColumns, strategyViews } from "./facts";
import { limitOf } from "./feed";
import { dbOf, requestDb, type DbEnv } from "./requestDb";
import { keptImages, tokenNameOf } from "./tokenImages";
import { marketViews } from "./views";

export const searchRoutes = new Hono<DbEnv>();
searchRoutes.use("/v1/search", requestDb);

/** What was typed, trimmed, or a 400 for nothing or too much. */
function queryOf(c: Context<DbEnv>): string {
  const q = (c.req.query("q") ?? "").trim();
  if (!q || [...q].length > SEARCH_QUERY_MAX) throw new HTTPException(400, { message: `q is what to search for: 1 to ${SEARCH_QUERY_MAX} characters.` });
  return q;
}

/** An address column matching `q` exactly as typed, from its start or its end. */
const addressMatches = (column: SQL, q: string) => sql`(starts_with(${column}, ${q}) or right(${column}, ${[...q].length}) = ${q})`;
/** A name matching `q` anywhere, in any case. */
const nameMatches = (column: SQL, q: string) => sql`strpos(lower(${column}), lower(${q})) > 0`;

/** One match of a group, in the group's order: its key, and how many the group matched in all. */
type Hit = { key: string; total: number };

searchRoutes.get("/v1/search", async (c) => {
  const q = queryOf(c);
  const limit = limitOf(c, PAGE_LIMITS.search);
  const db = dbOf(c);

  // Strategies: by program, or by the name the valid metadata for its URI now gives.
  const strategyHits = (await db.execute<Hit>(sql`
    select s.program as key, count(*) over ()::int as total
    from ${strategies} s
    left join lateral (
      select ms.status, ms.uri, ms.normalised from ${metadataSnapshots} ms where ms.program = s.program order by ms.id desc limit 1
    ) newest on true
    where ${addressMatches(sql`s.program`, q)}
       or (newest.status = 'valid' and newest.uri = s.metadata_uri and ${nameMatches(sql`newest.normalised->>'name'`, q)})
    order by (s.program = ${q}) desc,
             (select count(*) from ${markets} m where m.strategy_program = s.program) desc,
             s.registered_at desc, s.program
    limit ${limit}
  `)) as unknown as Hit[];

  // Markets: by their own address or their market state's.
  const marketHits = (await db.execute<Hit>(sql`
    select m.address as key, count(*) over ()::int as total
    from ${markets} m
    where ${addressMatches(sql`m.address`, q)} or ${addressMatches(sql`m.market_state`, q)}
    order by (m.address = ${q} or m.market_state = ${q}) desc, m.created_at desc, m.address desc
    limit ${limit}
  `)) as unknown as Hit[];

  // Mints that trade on a Pipeline market: by address, by Aviary's own name, or else by the token's own.
  const aviaryNamed = Object.keys(AVIARY_MINT_NAMES);
  const aviaryMatching = Object.entries(AVIARY_MINT_NAMES).flatMap(([mint, name]) => (name.toLowerCase().includes(q.toLowerCase()) ? [mint] : []));
  const list = (values: string[]) => (values.length ? sql.join(values.map((v) => sql`${v}`), sql`, `) : sql`null`);
  const mintHits = (await db.execute<Hit>(sql`
    select mi.address as key, count(*) over ()::int as total
    from ${mints} mi
    where exists (select 1 from ${marketMints} mm where mm.mint = mi.address)
      and (${addressMatches(sql`mi.address`, q)}
        or mi.address in (${list(aviaryMatching)})
        or (mi.address not in (${list(aviaryNamed)}) and (${nameMatches(sql`mi.symbol`, q)} or ${nameMatches(sql`mi.name`, q)})))
    order by (mi.address = ${q}) desc,
             (select count(*) from ${marketMints} mm where mm.mint = mi.address) desc,
             mi.address
    limit ${limit}
  `)) as unknown as Hit[];

  const keys = (hits: Hit[]) => hits.map((h) => h.key);
  const totalOf = (hits: Hit[]) => hits[0]?.total ?? 0;
  const inOrder = <T>(hits: Hit[], rows: T[], keyOf: (row: T) => string) => keys(hits).map((k) => rows.find((r) => keyOf(r) === k)!);

  const strategyRows = strategyHits.length
    ? await db
        .select({ ...strategyColumns, marketCount: sql<number>`(select count(*)::int from ${markets} where ${markets.strategyProgram} = ${strategies.program})` })
        .from(strategies)
        .where(sql`${strategies.program} in (${list(keys(strategyHits))})`)
    : [];
  const marketRows = marketHits.length ? await db.select().from(markets).where(sql`${markets.address} in (${list(keys(marketHits))})`) : [];
  const mintRows = mintHits.length ? await db.select({ address: mints.address, symbol: mints.symbol, name: mints.name, tokenUri: mints.tokenUri }).from(mints).where(sql`${mints.address} in (${list(keys(mintHits))})`) : [];
  const tradedOn = mintHits.length
    ? await db
        .select({ mint: marketMints.mint, market: marketMints.market })
        .from(marketMints)
        .innerJoin(markets, sql`${markets.address} = ${marketMints.market}`)
        .where(sql`${marketMints.mint} in (${list(keys(mintHits))})`)
        .orderBy(sql`${markets.createdAt} desc`, sql`${markets.address} desc`)
    : [];
  const images = await keptImages(db, mintRows.map((m) => m.tokenUri));

  const mintResults: SearchMint[] = inOrder(mintHits, mintRows, (m) => m.address).map((m) => ({
    mint: m.address,
    symbol: AVIARY_MINT_NAMES[m.address] ?? null,
    token: tokenNameOf(m.address, m, images),
    markets: tradedOn.filter((t) => t.mint === m.address).map((t) => t.market),
  }));

  return c.json(
    SearchResults.parse({
      query: q,
      strategies: { total: totalOf(strategyHits), results: inOrder(strategyHits, await strategyViews(db, strategyRows), (s) => s.program) },
      markets: { total: totalOf(marketHits), results: inOrder(marketHits, await marketViews(db, marketRows), (m) => m.address) },
      mints: { total: totalOf(mintHits), results: mintResults },
    }),
  );
});
