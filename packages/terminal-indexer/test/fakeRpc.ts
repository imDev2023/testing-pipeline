// A Solana JSON-RPC endpoint on localhost that serves a list of transactions as one account's
// history, the way devnet's Helius endpoint does: `getTransactionsForAddress` (Helius's own, with
// each transaction's place in its block), and the standard `getSignaturesForAddress`,
// `getTransaction` and `getBlock`. Accounts are served from a map, and the cluster's clock
// (`getSlot`, `getEpochInfo`, `getBlockTime`, `getGenesisHash`) from fields a test can set. It
// records every request, so a test can say what was asked.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { accountKeysOf, type RawTransaction } from "../src/decode";

export type FakeAccount = { owner: string; data: Uint8Array; lamports?: number; executable?: boolean };

type DataSlice = { offset: number; length: number };

/** An account as the RPC encodes it in base64, cut to `dataSlice` when one is asked for. */
function accountInfo(account: FakeAccount | undefined, dataSlice?: DataSlice, rentEpoch = 0n) {
  if (!account) return null;
  const data = dataSlice ? account.data.subarray(dataSlice.offset, dataSlice.offset + dataSlice.length) : account.data;
  return { owner: account.owner, lamports: account.lamports ?? 1, data: [Buffer.from(data).toString("base64"), "base64"], executable: account.executable ?? false, rentEpoch: rentEpoch <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rentEpoch) : rentEpoch, space: account.data.length };
}

export type FakeRpc = {
  url: string;
  /** Every request, by method and params, in order. */
  requests: { method: string; params: unknown[] }[];
  /** The chain's transactions, oldest first; an account's history is those that name it. A test pushes to it as the chain moves on. */
  history: RawTransaction[];
  accounts: Map<string, FakeAccount>;
  /** The slot the RPC says it read accounts at, and `getSlot` answers. */
  slot: number;
  /** The epoch `getEpochInfo` answers. */
  epoch: number;
  /** What `getBlockTime` and `getGenesisHash` answer. */
  blockTime: number | null;
  genesisHash: string;
  /** The rent epoch every account is served with: 0, or u64's largest value as for a rent-exempt account. */
  rentEpoch: bigint;
  /** Signatures listed but not served by `getTransaction` yet, as a node behind the one that listed them. */
  unserved: Set<string>;
  /** Methods answered with "Method not found", as an RPC without Helius's methods answers. */
  refuse: Set<string>;
  /** Addresses whose `getAccountInfo` fails, as an RPC that times out on one account. */
  failing: Set<string>;
  close: () => Promise<void>;
};

const signatureOf = (t: RawTransaction) => t.transaction.signatures[0]!;
const tokenOf = (t: RawTransaction) => `${t.slot}:${t.transactionIndex}`;
const order = (a: RawTransaction, b: RawTransaction) => a.slot - b.slot || a.transactionIndex! - b.transactionIndex!;
const withoutIndex = ({ transactionIndex: _, ...rest }: RawTransaction) => rest;

export async function fakeRpc(history: RawTransaction[] = []): Promise<FakeRpc> {
  const fake: Omit<FakeRpc, "url" | "close"> = { requests: [], history: [...history], accounts: new Map(), slot: 525_200_000, epoch: 812, blockTime: 1_763_900_000, genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", rentEpoch: 0n, unserved: new Set(), refuse: new Set(), failing: new Set() };

  const answer = (method: string, params: unknown[]): { result?: unknown; error?: unknown } => {
    if (fake.refuse.has(method)) return { error: { code: -32601, message: "Method not found" } };
    const sorted = [...fake.history].sort(order);
    const historyOf = (account: string) => sorted.filter((t) => accountKeysOf(t).includes(account));
    switch (method) {
      case "getTransactionsForAddress": {
        const [account, opts] = params as [string, { transactionDetails: string; limit: number; paginationToken?: string; sortOrder: string }];
        if (opts.sortOrder !== "asc") throw new Error("the indexer reads history oldest first");
        const listed = historyOf(account);
        const start = opts.paginationToken ? listed.findIndex((t) => order(t, { slot: Number(opts.paginationToken!.split(":")[0]), transactionIndex: Number(opts.paginationToken!.split(":")[1]) } as RawTransaction) > 0) : 0;
        const page = (start < 0 ? [] : listed.slice(start)).slice(0, opts.limit);
        const data =
          opts.transactionDetails === "full"
            ? page
            : page.map((t) => ({ signature: signatureOf(t), slot: t.slot, transactionIndex: t.transactionIndex, err: t.meta?.err ?? null, blockTime: t.blockTime }));
        return { result: { data, paginationToken: page.length === opts.limit ? tokenOf(page.at(-1)!) : null } };
      }
      case "getSignaturesForAddress": {
        const [account, opts] = params as [string, { before?: string; until?: string; limit: number }];
        let newest = historyOf(account).reverse();
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
        const [addresses, opts] = params as [string[], { dataSlice?: DataSlice } | undefined];
        return { result: { context: { slot: fake.slot }, value: addresses.map((a) => accountInfo(fake.accounts.get(a), opts?.dataSlice, fake.rentEpoch)) } };
      }
      case "getSlot":
        return { result: fake.slot };
      case "getBlockTime":
        return fake.blockTime === null ? { error: { code: -32009, message: "Slot was skipped, or missing in long-term storage" } } : { result: fake.blockTime };
      case "getGenesisHash":
        return { result: fake.genesisHash };
      case "getAccountInfo": {
        const [address, opts] = params as [string, { dataSlice?: DataSlice } | undefined];
        if (fake.failing.has(address)) return { error: { code: -32000, message: `timed out reading ${address}` } };
        return { result: { context: { slot: fake.slot }, value: accountInfo(fake.accounts.get(address), opts?.dataSlice) } };
      }
      case "getEpochInfo":
        return { result: { epoch: fake.epoch, absoluteSlot: fake.slot, slotIndex: 0, slotsInEpoch: 432_000, blockHeight: fake.slot, transactionCount: null } };
      case "getProgramAccounts": {
        const [program, opts] = params as [string, { filters?: { memcmp: { offset: number; bytes: string } }[] }];
        const matches = [...fake.accounts].filter(([, account]) => account.owner === program && (opts.filters ?? []).every((f) => memcmpMatches(account.data, f.memcmp)));
        return { result: matches.map(([pubkey, account]) => ({ pubkey, account: accountInfo(account) })) };
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
      // A rent epoch past 2^53 is written whole, as the RPC writes u64s.
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...answer(method, params) }, (_key, value: unknown) => (typeof value === "bigint" ? (JSON as unknown as { rawJSON: (t: string) => unknown }).rawJSON(value.toString()) : value)));
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
