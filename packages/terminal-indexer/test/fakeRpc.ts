// A Solana JSON-RPC endpoint on localhost that serves a list of transactions as one account's
// history, the way devnet's Helius endpoint does: `getTransactionsForAddress` (Helius's own, with
// each transaction's place in its block), and the standard `getSignaturesForAddress`,
// `getTransaction` and `getBlock`. Accounts are served from a map. It records every request, so a
// test can say what was asked.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RawTransaction } from "../src/decode";

export type FakeAccount = { owner: string; data: Uint8Array; lamports?: number };

export type FakeRpc = {
  url: string;
  /** Every request, by method and params, in order. */
  requests: { method: string; params: unknown[] }[];
  /** The account's history, oldest first; a test pushes to it as the chain moves on. */
  history: RawTransaction[];
  accounts: Map<string, FakeAccount>;
  /** Signatures listed but not served by `getTransaction` yet, as a node behind the one that listed them. */
  unserved: Set<string>;
  /** Methods answered with "Method not found", as an RPC without Helius's methods answers. */
  refuse: Set<string>;
  close: () => Promise<void>;
};

const signatureOf = (t: RawTransaction) => t.transaction.signatures[0]!;
const tokenOf = (t: RawTransaction) => `${t.slot}:${t.transactionIndex}`;
const order = (a: RawTransaction, b: RawTransaction) => a.slot - b.slot || a.transactionIndex! - b.transactionIndex!;
const withoutIndex = ({ transactionIndex: _, ...rest }: RawTransaction) => rest;

export async function fakeRpc(history: RawTransaction[] = []): Promise<FakeRpc> {
  const fake: Omit<FakeRpc, "url" | "close"> = { requests: [], history: [...history], accounts: new Map(), unserved: new Set(), refuse: new Set() };

  const answer = (method: string, params: unknown[]): { result?: unknown; error?: unknown } => {
    if (fake.refuse.has(method)) return { error: { code: -32601, message: "Method not found" } };
    const sorted = [...fake.history].sort(order);
    switch (method) {
      case "getTransactionsForAddress": {
        const [, opts] = params as [string, { transactionDetails: string; limit: number; paginationToken?: string; sortOrder: string }];
        if (opts.sortOrder !== "asc") throw new Error("the indexer reads history oldest first");
        const start = opts.paginationToken ? sorted.findIndex((t) => order(t, { slot: Number(opts.paginationToken!.split(":")[0]), transactionIndex: Number(opts.paginationToken!.split(":")[1]) } as RawTransaction) > 0) : 0;
        const page = (start < 0 ? [] : sorted.slice(start)).slice(0, opts.limit);
        const data =
          opts.transactionDetails === "full"
            ? page
            : page.map((t) => ({ signature: signatureOf(t), slot: t.slot, transactionIndex: t.transactionIndex, err: t.meta?.err ?? null, blockTime: t.blockTime }));
        return { result: { data, paginationToken: page.length === opts.limit ? tokenOf(page.at(-1)!) : null } };
      }
      case "getSignaturesForAddress": {
        const [, opts] = params as [string, { before?: string; until?: string; limit: number }];
        let newest = [...sorted].reverse();
        if (opts.until) newest = newest.slice(0, Math.max(0, newest.findIndex((t) => signatureOf(t) === opts.until)));
        if (opts.before) newest = newest.slice(newest.findIndex((t) => signatureOf(t) === opts.before) + 1);
        return { result: newest.slice(0, opts.limit).map((t) => ({ signature: signatureOf(t), slot: t.slot, err: t.meta?.err ?? null, blockTime: t.blockTime })) };
      }
      case "getTransaction": {
        const [signature] = params as [string];
        const t = fake.unserved.has(signature) ? undefined : sorted.find((x) => signatureOf(x) === signature);
        return { result: t ? withoutIndex(t) : null };
      }
      case "getBlock": {
        const [slot] = params as [number];
        // The block's other transactions stand in as placeholders before each of ours.
        const ours = sorted.filter((t) => t.slot === slot);
        const signatures: string[] = [];
        for (const t of ours) {
          while (signatures.length < t.transactionIndex!) signatures.push(`other-${slot}-${signatures.length}`);
          signatures.push(signatureOf(t));
        }
        return { result: ours.length ? { signatures } : null };
      }
      case "getMultipleAccounts": {
        const [addresses] = params as [string[]];
        return {
          result: {
            context: { slot: 525_200_000 },
            value: addresses.map((a) => {
              const account = fake.accounts.get(a);
              return account ? { owner: account.owner, lamports: account.lamports ?? 1, data: [Buffer.from(account.data).toString("base64"), "base64"], executable: false, rentEpoch: 0, space: account.data.length } : null;
            }),
          },
        };
      }
      case "getProgramAccounts": {
        const [program, opts] = params as [string, { filters?: { memcmp: { offset: number; bytes: string } }[] }];
        const matches = [...fake.accounts].filter(([, account]) => account.owner === program && (opts.filters ?? []).every((f) => memcmpMatches(account.data, f.memcmp)));
        return { result: matches.map(([pubkey, account]) => ({ pubkey, account: { owner: account.owner, lamports: account.lamports ?? 1, data: [Buffer.from(account.data).toString("base64"), "base64"], executable: false, rentEpoch: 0, space: account.data.length } })) };
      }
      default:
        return { error: { code: -32601, message: "Method not found" } };
    }
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      fake.requests.push({ method, params });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...answer(method, params) }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, { url: `http://127.0.0.1:${port}/?api-key=secret-in-the-url`, close: () => new Promise<void>((done) => server.close(() => done())) });
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(BASE58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function memcmpMatches(data: Uint8Array, { offset, bytes }: { offset: number; bytes: string }): boolean {
  const want = base58Decode(bytes);
  return want.every((b, i) => data[offset + i] === b);
}
