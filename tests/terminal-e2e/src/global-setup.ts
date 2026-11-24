// Before any test: the indexer has run on the local run, so the pages have devnet's markets,
// strategies and strategy versions to show. It fires the every-minute cron, as Cloudflare would, in
// a minute on which the router's reconciliation and the ProgramData watch are due and the jobs of
// five minutes and longer are not (`wrangler dev` fires it at the real time, so it waits for one), so
// every run asks the RPC the same questions and the recorded fixtures always hold the answers (the
// router's first reconciliation backfills its whole history, and the watch's first run records every
// strategy's versions); then it waits until both have run, and stores Canary's results for six
// markets, since the suite runs no Canary container (src/canary.ts), and explanations for two
// strategies, since it calls no model (src/explanation.ts).
import { seedCanaryResults } from "./canary";
import { seedExplanations } from "./explanation";
import { API } from "./target";

const TIMEOUT_MS = 180_000;

type Status = { reconciledAt: string | null; watchedAt: string | null; lastError: string | null };

/** Waits for a minute that is no multiple of five, with time left in it: the one-minute jobs are due then, and no others. */
async function oneMinuteJobsOnly(): Promise<void> {
  for (;;) {
    const now = Date.now();
    if (Math.floor(now / 60_000) % 5 !== 0 && now % 60_000 < 45_000) return;
    await new Promise((done) => setTimeout(done, 60_000 - (now % 60_000) + 250));
  }
}

export default async function globalSetup() {
  await oneMinuteJobsOnly();
  const fired = await fetch(`${API}/__scheduled?cron=${encodeURIComponent("* * * * *")}`);
  if (!fired.ok) throw new Error(`the local API refused the cron: ${fired.status}`);
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const status = (await (await fetch(`${API}/v1/indexer`)).json()) as Status;
    // Then Canary's results, which need the strategies' versions the watch records (src/canary.ts).
    // Then the explanations, whose keys hold Canary's outcomes (src/explanation.ts).
    if (status.reconciledAt && status.watchedAt) return seedCanaryResults().then(seedExplanations);
    if (status.lastError) throw new Error(`the indexer failed: ${status.lastError}`);
    if (Date.now() > deadline) throw new Error(`the indexer had not reconciled after ${TIMEOUT_MS / 1000} s`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}
