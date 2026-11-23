// Adapted from Top-pad b833a7b, tests/devnet/src/indexer-restart.test.ts; owned here since.
// The restart test (docs/spec/pipescope-architecture.md, Indexer): `terminal-api` runs under
// `wrangler dev` on a throwaway database; the tax AMM's devnet demo market is traded once while the
// indexer runs, then three times while its process is stopped; once it runs again, the indexer must
// hold exactly the swaps the chain has for the market, read back from the chain itself. It spends a
// little devnet SOL in fees from the project's devnet wallet. Run it as
// `direnv exec "<main checkout>" pnpm --filter terminal-devnet devnet` with the Docker Postgres up.
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { Trade } from "terminal-api/contract";
import { DEMO_MARKET, swapOnDemoMarket, swapsOnChain, WALLET_FILE, wallet, type ChainSwap } from "./devnet";
import { LocalApi, until } from "./localApi";

const ready = Boolean(process.env.RPC_URL && process.env.TEST_DATABASE_URL && existsSync(WALLET_FILE));

const comparable = (t: Trade | ChainSwap) => ({
  signature: t.signature,
  slot: t.slot,
  trader: t.trader,
  input_mint: t.input_mint,
  output_mint: t.output_mint,
  net_sent: t.net_sent,
  received: t.received,
  pipeline_fee: t.pipeline_fee,
});
const ordered = <T extends { signature: string; net_sent: string }>(list: T[]) => [...list].sort((a, b) => `${a.signature}${a.net_sent}`.localeCompare(`${b.signature}${b.net_sent}`));

describe.skipIf(!ready)("the indexer stopped and started again", () => {
  const api = new LocalApi(8822);
  afterAll(() => api.dispose());

  it("indexes every swap made while it was down, as the chain has them", async () => {
    const payer = await wallet();
    await api.start();
    await api.reconcile();

    // While it runs: a swap is indexed on the next reconciliation.
    const live = await swapOnDemoMarket(payer, "sell", 1_000_000_000n);
    await until("the live swap", async () => (await api.reconcile()) && (await api.trades({ market: DEMO_MARKET })).some((t) => t.signature === live), 120_000);

    // Stopped: three swaps land on devnet with no indexer running.
    await api.stop();
    const missed = [
      await swapOnDemoMarket(payer, "sell", 1_000_000_000n),
      await swapOnDemoMarket(payer, "buy", 1_000_000n),
      await swapOnDemoMarket(payer, "sell", 500_000_000n),
    ];

    // Started again: the next reconciliation finds them.
    await api.start();
    const indexed = await until(
      "the missed swaps",
      async () => {
        await api.reconcile();
        const all = await api.trades({ market: DEMO_MARKET });
        return missed.every((s) => all.some((t) => t.signature === s)) && all;
      },
      240_000,
    );

    // Checked against the chain: every swap of the market, decoded from its transactions, is indexed, and nothing else.
    const onChain = await swapsOnChain(DEMO_MARKET);
    for (const s of [live, ...missed]) expect(onChain.map((c) => c.signature)).toContain(s);
    expect(ordered(indexed.map(comparable))).toEqual(ordered(onChain.map(comparable)));
    console.log(`indexed while running: ${live}; while stopped: ${missed.join(", ")}; the demo market's ${indexed.length} swaps equal the chain's`);
  });
});
