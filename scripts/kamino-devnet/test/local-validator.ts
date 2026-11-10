// A solana-test-validator running devnet's own Kamino Lend: klend's program and its global config are cloned from
// devnet at start, and the two Pyth price accounts the reserves name are loaded with their publish time moved a day
// ahead, so every borrow in a run sees a fresh price (klend counts a price from the future as 0 seconds old).
// Needs `source scripts/toolchain-env.sh` (Agave 4.4.1, docs/toolchain.md).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DEVNET, KLEND_GLOBAL_CONFIG, KLEND_PROGRAM, PYTH_FEEDS } from "../src/policy.ts";

/** SIMD-0268's deeper call limit, which test validators turn on but devnet does not have yet (docs/toolchain.md). */
const SIMD_0268 = "6TkHkRmP7JZy1fdM6fg5uXn76wChQBWGokHBJzrLB3mj";

/** Offsets in a Pyth receiver `PriceUpdateV2` account with full verification (one byte for the level). */
const PYTH_PUBLISH_TIME = 8 + 32 + 1 + 32 + 8 + 8 + 4;
const PYTH_PREV_PUBLISH_TIME = PYTH_PUBLISH_TIME + 8;

export interface LocalValidator {
  url: string;
  dir: string;
  stop(): Promise<void>;
}

/** Cloning from public devnet fails now and then (rate limits, timeouts), so a failed start is tried again. */
const START_ATTEMPTS = 3;

export async function startLocalValidator(port: number): Promise<LocalValidator> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOnce(port);
    } catch (error) {
      if (attempt >= START_ATTEMPTS) throw error;
      await sleep(5_000 * attempt);
    }
  }
}

async function startOnce(port: number): Promise<LocalValidator> {
  const dir = mkdtempSync(join(tmpdir(), "kamino-devnet-"));
  const args = [
    "--reset",
    "--quiet",
    "--ledger",
    join(dir, "ledger"),
    "--rpc-port",
    String(port),
    "--faucet-port",
    String(port + 2),
    "--gossip-port",
    String(port + 3),
    "--dynamic-port-range",
    `${port + 10}-${port + 40}`,
    "--deactivate-feature",
    SIMD_0268,
    "--url",
    DEVNET,
    "--clone-upgradeable-program",
    KLEND_PROGRAM,
    "--clone",
    KLEND_GLOBAL_CONFIG,
  ];
  for (const feed of Object.values(PYTH_FEEDS)) {
    const file = join(dir, `${feed}.json`);
    writeFileSync(file, JSON.stringify(await freshPythAccount(feed)));
    args.push("--account", feed, file);
  }
  const child = spawn("solana-test-validator", args, { stdio: ["ignore", "pipe", "pipe"] });
  // The validator reports a failed clone on stdout; keep the tail of both streams for the error.
  let output = "";
  const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4_000));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, child, () => output);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    url,
    dir,
    async stop() {
      await stopProcess(child);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function freshPythAccount(feed: string) {
  const response = await rpcCall(DEVNET, "getAccountInfo", [feed, { encoding: "base64" }]);
  const value = response.value;
  if (!value) throw new Error(`Pyth feed ${feed} not found on devnet`);
  const data = Buffer.from(value.data[0], "base64");
  if (data[40] !== 1) throw new Error(`Pyth feed ${feed} is not fully verified`);
  const ahead = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  data.writeBigInt64LE(ahead, PYTH_PUBLISH_TIME);
  data.writeBigInt64LE(ahead - 1n, PYTH_PREV_PUBLISH_TIME);
  return {
    pubkey: feed,
    account: {
      lamports: value.lamports,
      data: [data.toString("base64"), "base64"],
      owner: value.owner,
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
}

async function waitForHealth(url: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`solana-test-validator exited: ${output()}`);
    try {
      const health = await rpcCall(url, "getHealth", [], 1);
      if (health === "ok") return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  await stopProcess(child);
  throw new Error(`solana-test-validator did not become healthy: ${output()}`);
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

/** One JSON-RPC call, retried through public devnet's rate limits, connect timeouts and resets. */
async function rpcCall(url: string, method: string, params: unknown[], attempts = 7) {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (response.status === 429 && attempt < attempts) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const json = (await response.json()) as { result?: any; error?: unknown };
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  }
}
