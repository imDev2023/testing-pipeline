// Before any test: the indexer has run on the local run, so the pages have devnet's markets and
// strategies to show. It fires the every-minute cron, as Cloudflare would (the router's
// reconciliation is due on every minute, and its first run backfills the router's whole history),
// then waits until the indexer says it has reconciled.
import { API } from "./target";

const TIMEOUT_MS = 180_000;

type Status = { reconciledAt: string | null; lastError: string | null };

export default async function globalSetup() {
  const fired = await fetch(`${API}/__scheduled?cron=${encodeURIComponent("* * * * *")}`);
  if (!fired.ok) throw new Error(`the local API refused the cron: ${fired.status}`);
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const status = (await (await fetch(`${API}/v1/indexer`)).json()) as Status;
    if (status.reconciledAt) return;
    if (status.lastError) throw new Error(`the indexer failed: ${status.lastError}`);
    if (Date.now() > deadline) throw new Error(`the indexer had not reconciled after ${TIMEOUT_MS / 1000} s`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}
