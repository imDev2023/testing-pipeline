// Landing a swap for the live tests (docs/spec/pipescope-architecture.md, Live rooms), by E2E_RPC:
// - `devnet`: a real swap on the tax AMM's devnet demo market, signed with the project's devnet
//   wallet (~/.config/testing-pipeline/devnet/), which devnet's own socket announces to the indexer;
// - `record`: the same real swap, announced on the fixture socket, and kept in fixtures/live-swaps.json;
// - `fixtures` (CI's): the recorded swap announced on the fixture socket, the indexer reading it
//   through the recorded answers like any other.
import { readFileSync, writeFileSync } from "node:fs";
import { DEMO_MARKET, rpcUrl, swapOnDemoMarket, wallet } from "terminal-devnet/devnet";
import { LIVE_EMIT_PATH, RPC_PORT } from "./rpc";
import { RPC_MODE } from "./target";

export const LIVE_MARKET: string = DEMO_MARKET;
const SWAPS = `${import.meta.dirname}/../fixtures/live-swaps.json`;
type Landed = { signature: string; slot: number };

async function slotOf(signature: string): Promise<number> {
  const response = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[signature]] }),
  });
  const { result } = (await response.json()) as { result: { value: ({ slot: number } | null)[] } };
  return result.value[0]!.slot;
}

async function announce({ signature, slot }: Landed) {
  const response = await fetch(`http://127.0.0.1:${RPC_PORT}${LIVE_EMIT_PATH}`, { method: "POST", body: JSON.stringify({ signature, slot }) });
  const { subscriptions } = (await response.json()) as { subscriptions: number };
  if (!subscriptions) throw new Error("the indexer holds no subscription on the fixture socket: its live socket is not open");
}

/** Lands the swap named `label` (a 0.001 SOL buy of the demo token) and resolves once it is confirmed and announced. */
export async function landSwap(label: string): Promise<Landed> {
  if (RPC_MODE === "fixtures") {
    const landed = (JSON.parse(readFileSync(SWAPS, "utf8")) as Record<string, Landed>)[label];
    if (!landed) throw new Error(`no swap "${label}" is recorded in fixtures/live-swaps.json: record it with pnpm --filter terminal-e2e record`);
    await announce(landed);
    return landed;
  }
  const signature = await swapOnDemoMarket(await wallet(), "buy", 1_000_000n);
  const landed = { signature, slot: await slotOf(signature) };
  if (RPC_MODE === "record") {
    const recorded = (() => {
      try {
        return JSON.parse(readFileSync(SWAPS, "utf8")) as Record<string, Landed>;
      } catch {
        return {};
      }
    })();
    writeFileSync(SWAPS, `${JSON.stringify({ ...recorded, [label]: landed }, null, 2)}\n`);
    await announce(landed);
  }
  return landed;
}
