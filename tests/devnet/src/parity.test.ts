// The parity checks (docs/spec/pipescope-architecture.md, Indexer, "Parity checks"; PIPESCOPE-93):
// Pipeline's hosted devnet API is a test oracle, never a source. `terminal-api` backfills the
// router's history under `wrangler dev` on a throwaway database; then its markets and strategies
// must be the hosted API's, its trades the router's history, and for every market its trades the
// hosted API's, as the project's devnet wallet's swaps must be. The hosted API indexes finalized
// transactions only, so both sides are compared up to the slot both have reached.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Trade } from "terminal-api/contract";
import { decodeRouterEvents, heliusSource, type RawTransaction } from "terminal-indexer";
import { rpcUrl } from "./devnet";
import { LocalApi } from "./localApi";

const HOSTED = "https://pipeline-devnet.up.railway.app";
const ROUTER = "PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34";
const PROJECT_WALLET = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";
const ready = Boolean(process.env.RPC_URL && process.env.TEST_DATABASE_URL);

/**
 * Swaps the hosted API does not hold, each checked here to be in the router's history on chain, so
 * a gap of the oracle's is named rather than hidden. Found 2026-11-23: the market was created at
 * 15:36:09 UTC on 2026-11-21 and swapped three seconds later, as the hosted API was redeployed for
 * Pipeline 0.3 (its ingest stream connected again at 15:52:07), and it never indexed the swap.
 */
const HOSTED_API_GAPS = [{ market: "AHbdnffEQ7pmJHmAc1h2dTBnrX3ST8DiZhwSdBU6ouS7", signature: "5nut72Ntf2pnV5LpzrGAHmXXbFGnMNofwyzQLPbRmBtC9LSiQkBBir5rckmGMB619o745K4VMKbCafvoXk9rYyRL" }];

type HostedTrade = {
  signature: string;
  slot: number;
  market: string;
  trader: string;
  input_mint: string;
  output_mint: string;
  mode: string;
  net_sent: string;
  received: string;
  pipeline_fee: string;
  fee_mint: string;
  integrator: string | null;
  integrator_fee: string;
};

/** The hosted API, kept under its read limit of 20 requests a second. */
async function hosted<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await new Promise((done) => setTimeout(done, 100));
    const response = await fetch(`${HOSTED}${path}`);
    if (response.status === 429 && attempt < 5) {
      await new Promise((done) => setTimeout(done, 1_000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`the hosted API answered ${response.status} to ${path}`);
    return (await response.json()) as T;
  }
}

async function hostedTrades(path: string): Promise<HostedTrade[]> {
  const all: HostedTrade[] = [];
  let before: number | null = null;
  for (;;) {
    const { trades }: { trades: HostedTrade[] } = await hosted<{ trades: HostedTrade[] }>(`${path}?limit=1000${before === null ? "" : `&before_slot=${before}`}`);
    all.push(...trades);
    if (trades.length < 1000) return all;
    before = trades.at(-1)!.slot;
  }
}

const fields = (t: Trade | HostedTrade) => ({
  signature: t.signature,
  slot: t.slot,
  market: t.market,
  trader: t.trader,
  input_mint: t.input_mint,
  output_mint: t.output_mint,
  mode: t.mode,
  net_sent: t.net_sent,
  received: t.received,
  pipeline_fee: t.pipeline_fee,
  fee_mint: t.fee_mint,
  integrator: t.integrator,
  integrator_fee: t.integrator_fee,
});
const key = (t: { signature: string; market: string; net_sent: string; received: string }) => `${t.signature}:${t.market}:${t.net_sent}:${t.received}`;
const sorted = <T extends { signature: string; market: string; net_sent: string; received: string }>(list: T[]) => [...list].sort((a, b) => key(a).localeCompare(key(b)));

describe.skipIf(!ready)("parity with Pipeline's hosted devnet API", () => {
  const api = new LocalApi(8824);
  let cutoff = 0;
  beforeAll(async () => {
    await api.start();
    const { cursor } = await api.reconcile();
    const health = await hosted<{ last_indexed_slot: number }>("/health");
    // Up to the slot both have reached: the hosted API's newest indexed router transaction and our cursor.
    cutoff = Math.min(health.last_indexed_slot, cursor!.slot);
  });
  afterAll(() => api.dispose());

  it("lists every market and strategy registered with the router, as many as the hosted API counts", async () => {
    const [ours, theirs] = await Promise.all([api.markets(), hosted<{ markets: { address: string }[] }>("/v1/markets?limit=500&include_hidden=true")]);
    expect(ours.map((m) => m.address).sort()).toEqual(theirs.markets.map((m) => m.address).sort());
    const [strategies, hostedStrategies] = await Promise.all([api.strategies(), hosted<{ strategies: { program_id: string }[] }>("/v1/strategies?include_hidden=true")]);
    expect(strategies.map((s) => s.program).sort()).toEqual(hostedStrategies.strategies.map((s) => s.program_id).sort());
    for (const s of strategies) expect(s.market_count, s.program).toBe(ours.filter((m) => m.strategy === s.program).length);
    console.log(`${ours.length} markets and ${strategies.length} strategies, as the hosted API lists them`);
  });

  it("holds every swap of the router's history, decoded from the chain", async () => {
    const source = heliusSource(rpcUrl());
    const onChain: { signature: string; market: string; net_sent: string; received: string }[] = [];
    let cursor = null;
    for (;;) {
      const { transactions, more } = await source.after(ROUTER, cursor, 100);
      for (const raw of transactions as RawTransaction[]) {
        if (raw.meta?.err !== null || raw.slot > cutoff) continue;
        for (const { event } of decodeRouterEvents(raw).events) {
          if (event.type === "Swap") onChain.push({ signature: raw.transaction.signatures[0]!, market: event.data.market, net_sent: String(event.data.netSent), received: String(event.data.received) });
        }
      }
      const last = transactions.at(-1);
      if (!more || !last) break;
      cursor = { signature: last.transaction.signatures[0]!, slot: last.slot, blockIndex: last.transactionIndex ?? null };
    }
    const ours = (await Promise.all((await api.markets()).map((m) => api.trades({ market: m.address })))).flat().filter((t) => t.slot <= cutoff);
    expect(onChain.length).toBeGreaterThan(0);
    for (const gap of HOSTED_API_GAPS) expect(onChain.some((s) => s.signature === gap.signature && s.market === gap.market), gap.signature).toBe(true);
    expect(sorted(ours.map(({ signature, market, net_sent, received }) => ({ signature, market, net_sent, received })))).toEqual(sorted(onChain));
    console.log(`${ours.length} swaps up to slot ${cutoff}, equal to the router's history decoded from the chain`);
  });

  it("for every market, holds the hosted API's trades, and only the swaps it is known to lack besides", async () => {
    const markets = await api.markets();
    for (const market of markets) {
      const [ours, theirs] = await Promise.all([api.trades({ market: market.address }), hostedTrades(`/v1/markets/${market.address}/trades`)]);
      const gaps = new Set(HOSTED_API_GAPS.filter((g) => g.market === market.address).map((g) => g.signature));
      expect(theirs.filter((t) => gaps.has(t.signature)), `the hosted API now holds a swap listed as a gap on ${market.address}`).toEqual([]);
      expect(sorted(ours.filter((t) => t.slot <= cutoff && !gaps.has(t.signature)).map(fields)), market.address).toEqual(sorted(theirs.filter((t) => t.slot <= cutoff).map(fields)));
      expect(ours.filter((t) => gaps.has(t.signature)).map((t) => t.signature).sort(), market.address).toEqual([...gaps].sort());
    }
    console.log(`all ${markets.length} markets' trades equal the hosted API's, but for ${HOSTED_API_GAPS.length} swap it lacks`);
  });

  it("holds the project's devnet wallet's swaps as the hosted API has them", async () => {
    const [ours, theirs] = await Promise.all([api.trades({ trader: PROJECT_WALLET }), hostedTrades(`/v1/traders/${PROJECT_WALLET}/trades`)]);
    expect(ours.length).toBeGreaterThan(0);
    expect(sorted(ours.filter((t) => t.slot <= cutoff).map(fields))).toEqual(sorted(theirs.filter((t) => t.slot <= cutoff).map(fields)));
    console.log(`the project's devnet wallet: ${ours.length} swaps, equal to the hosted API's`);
  });
});
