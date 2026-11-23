import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Bindings } from "../src/env";
import type { TokenImageType } from "../src/tokenImageFetch";

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
    INDEXER: {} as Bindings["INDEXER"],
    LIVE_ROOMS: {} as Bindings["LIVE_ROOMS"],
    KEEPER_WALLET: "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2",
    ...rest,
  };
}

/** A KV namespace in memory, as much of one as the API uses: `get` as JSON and `put`, counting the writes. */
export function memoryKv() {
  const values = new Map<string, string>();
  const kv = {
    puts: 0,
    async get(key: string, type?: "json") {
      const value = values.get(key);
      return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      kv.puts++;
      values.set(key, value);
    },
  };
  return kv as unknown as KVNamespace & { puts: number };
}

/** A Solana JSON-RPC endpoint on localhost that answers `getSlot` and `getBalance` with the values given, or fails as asked. */
export async function fakeRpc(answer: { slot: number; balance?: number } | { status: number }): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if ("status" in answer) {
        res.writeHead(answer.status).end("unavailable");
        return;
      }
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const result = method === "getSlot" ? answer.slot : method === "getBalance" && answer.balance !== undefined ? { context: { slot: answer.slot }, value: answer.balance } : undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } } : { jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/?api-key=secret-in-the-url`, close: () => new Promise((done) => server.close(() => done())) };
}

/**
 * The web as the metadata fetcher sees it in a test: `documents` served as JSON by URL, anything
 * else 404, and every URL asked kept in `asked`.
 */
export function metadataWeb(documents: Record<string, string> = {}) {
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    const body = documents[url];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { headers: { "content-type": "application/json" } });
  };
  return { fetch, asked, documents };
}

/** An image store in memory (../src/tokenImages's `ImageStore`), with what it was given to keep. */
export function memoryImages() {
  const kept = new Map<string, { bytes: ArrayBuffer; type: TokenImageType }>();
  return {
    put: async (sha256: string, bytes: Uint8Array, type: TokenImageType) => void kept.set(sha256, { bytes: new Uint8Array(bytes).buffer, type }),
    get: async (sha256: string) => kept.get(sha256) ?? null,
    /** The type and size of each image kept. */
    kept: () => [...kept.values()].map(({ bytes, type }) => ({ type, size: bytes.byteLength })),
  };
}
