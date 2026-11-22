import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Bindings } from "../src/env";

/** What a Worker's request handler is given besides its bindings; `waitUntil` work is awaited by `settle`. */
export function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
  };
}

/** The Workers rate-limiting binding as Cloudflare documents it: `limit` per key, counted in this process. */
export function rateLimiter(limit: number) {
  const counts = new Map<string, number>();
  return {
    limit: async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

/** The bindings of the local run, with the database and the RPC the test names. */
export function bindings(overrides: Partial<Bindings> & { databaseUrl: string; rpcUrl: string }): Bindings {
  const { databaseUrl, rpcUrl, ...rest } = overrides;
  return {
    CLUSTER: "devnet",
    HYPERDRIVE: { connectionString: databaseUrl } as Hyperdrive,
    RPC_URL: rpcUrl,
    CF_VERSION_METADATA: { id: "7f0c1a5e-0000-4000-8000-000000000001", tag: "", timestamp: "2026-11-22T10:00:00.000Z" },
    READS: rateLimiter(300),
    TRADES: rateLimiter(60),
    REPORTS: rateLimiter(10),
    TERMINAL_CACHE: {} as KVNamespace,
    ...rest,
  };
}

/** A Solana JSON-RPC endpoint on localhost that answers `getSlot` with the slot given, or fails as asked. */
export async function fakeRpc(answer: { slot: number } | { status: number }): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if ("status" in answer) {
        res.writeHead(answer.status).end("unavailable");
        return;
      }
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(method === "getSlot" ? { jsonrpc: "2.0", id, result: answer.slot } : { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/?api-key=secret-in-the-url`, close: () => new Promise((done) => server.close(() => done())) };
}
