// The Solana RPC the local API reads in the end-to-end tests. CI has no RPC key and no network
// (PIPESCOPE-96), so the API reads recorded devnet answers from fixtures/devnet-rpc.json through this
// server; `pnpm --filter terminal-e2e record` runs the suite against devnet through it, passing each
// request on to RPC_URL and recording the answer.
//
// It also serves strategies' metadata documents and tokens' images (METADATA_PATH): the API's
// fetchers read each URL through it in these tests (terminal-api's `TEST_METADATA_FIXTURES`), and it answers what
// was recorded for that URL from fixtures/metadata.json, status, headers and body, redirects and all,
// so the fetcher's own rules run on them as on the web; recording fetches each from the web once.
//
// It also speaks the RPC's WebSocket: a `logsSubscribe` is answered with a subscription, and a POST to
// LIVE_EMIT_PATH announces a transaction on every subscription, as devnet's socket would once the
// transaction lands (src/live.ts says when the tests do this). The indexer then fetches the
// transaction through the recorded answers like any other.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { TOKEN_IMAGE } from "terminal-api/config";
import { WebSocketServer, type WebSocket } from "ws";

/** 8812, or E2E_RPC_PORT, beside E2E_API_PORT (./target). */
export const RPC_PORT = Number(process.env.E2E_RPC_PORT ?? 8812);
/** Where a test tells the fixture socket a transaction has landed: a POST of `{ signature, slot }`. */
export const LIVE_EMIT_PATH = "/__live/emit";
/** Where the API's metadata fetcher asks for a document: `GET /__metadata?url=<the document's URL>`. */
export const METADATA_PATH = "/__metadata";
const FIXTURES = `${import.meta.dirname}/../fixtures/devnet-rpc.json`;
const METADATA_FIXTURES = `${import.meta.dirname}/../fixtures/metadata.json`;
/**
 * The most of a document's body recorded: past the fetchers' own limits (64 KB for a document, 1 MB
 * for a token's image), so a too-large answer stays too large.
 */
const METADATA_RECORD_MAX_BYTES = TOKEN_IMAGE.maxBytes + 1;
/**
 * The answer headers recorded: the type and a redirect's location. Not the length: Node's fetch
 * hands back the body decompressed, beside the length of what was sent compressed, so the body
 * replayed carries its own length.
 */
const METADATA_HEADERS = ["content-type", "location"];

type RecordedDocument = { status: number; headers: Record<string, string>; body: string };

/** A document as the web answered it, asked for as the API asked (`accept`), without following a redirect. */
async function recordDocument(url: string, accept: string): Promise<RecordedDocument> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { accept } });
  const body = Buffer.from(await response.arrayBuffer()).subarray(0, METADATA_RECORD_MAX_BYTES);
  const headers = Object.fromEntries(METADATA_HEADERS.flatMap((h) => (response.headers.has(h) ? [[h, response.headers.get(h)!]] : [])));
  return { status: response.status, headers, body: body.toString("base64") };
}

/** Whether a request is a read pinned to a slot, as Canary's snapshots are (apps/terminal-api/src/canarySnapshot.ts). */
const pinnedToSlot = (params: unknown) => Array.isArray(params) && params.some((p) => typeof p === "object" && p !== null && "minContextSlot" in p);

/** A request's key: its method and parameters, which is all a recorded answer depends on. */
const keyOf = (method: string, params: unknown) => `${method} ${JSON.stringify(params ?? [])}`;

type Recording = Record<string, { result?: unknown; error?: unknown }>;

/**
 * The recording as JSON with one request per line, each answer compact: the router's whole history
 * is most of it, and pretty-printing would double its size; a line per request keeps a diff to the
 * requests that changed.
 */
const serialise = (recording: Recording) =>
  `{\n${Object.entries(recording)
    .map(([key, answer]) => `${JSON.stringify(key)}: ${JSON.stringify(answer)}`)
    .join(",\n")}\n}\n`;

/**
 * Serves recorded answers, or with `upstream` records them. A request with no recording is answered
 * with a JSON-RPC error naming it, so a test that needs a new answer fails until it is recorded.
 */
export function serveRpc(options: { upstream?: string } = {}): Promise<Server> {
  const recording: Recording = options.upstream ? {} : (JSON.parse(readFileSync(FIXTURES, "utf8")) as Recording);
  const documents: Record<string, RecordedDocument> = options.upstream ? {} : (JSON.parse(readFileSync(METADATA_FIXTURES, "utf8")) as Record<string, RecordedDocument>);
  const subscribed = new Map<WebSocket, number[]>();
  const sockets = new WebSocketServer({ noServer: true });
  sockets.on("connection", (socket: WebSocket) => {
    subscribed.set(socket, []);
    socket.on("message", (data) => {
      const { id, method } = JSON.parse(String(data)) as { id: number; method: string };
      if (method !== "logsSubscribe") return socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
      const subscription = 1000 + id;
      subscribed.get(socket)!.push(subscription);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: subscription }));
    });
    socket.on("close", () => subscribed.delete(socket));
  });
  /** Announces a landed transaction on every subscription, as devnet's `logsNotification`. */
  const emit = (signature: string, slot: number) => {
    let sent = 0;
    for (const [socket, subscriptions] of subscribed) {
      for (const subscription of subscriptions) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription, result: { context: { slot }, value: { signature, err: null, logs: [] } } } }));
        sent++;
      }
    }
    return sent;
  };

  const server = createServer(async (req, res) => {
    const asked = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && asked.pathname === METADATA_PATH) {
      const url = asked.searchParams.get("url") ?? "";
      let document = documents[url];
      if (!document && options.upstream) {
        try {
          document = await recordDocument(url, req.headers.accept ?? "application/json");
          documents[url] = document;
          writeFileSync(METADATA_FIXTURES, `${JSON.stringify(documents, null, 1)}\n`);
        } catch (e) {
          res.writeHead(502, { "content-type": "text/plain" }).end(`the web did not answer ${url}: ${e instanceof Error ? e.name : typeof e}`);
          return;
        }
      }
      if (!document) {
        res.writeHead(599, { "content-type": "text/plain" }).end(`no recorded document for ${url}`);
        return;
      }
      res.writeHead(document.status, document.headers).end(Buffer.from(document.body, "base64"));
      return;
    }
    // Playwright asks whether the server is up with a GET.
    if (req.method !== "POST") {
      res.writeHead(200).end("ok");
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      if (req.url === LIVE_EMIT_PATH) {
        const { signature, slot } = JSON.parse(body) as { signature: string; slot: number };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ subscriptions: emit(signature, slot) }));
        return;
      }
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params?: unknown };
      const key = keyOf(method, params);
      let answer = recording[key];
      if (!answer && options.upstream) {
        // Only a result is recorded: a refusal (a rate limit, a node behind) is passed on and asked again next time.
        try {
          const upstream = await fetch(options.upstream, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(20_000) });
          const { result, error } = (await upstream.json()) as { result?: unknown; error?: unknown };
          answer = error === undefined ? { result } : { error };
          // Nor is "not there yet": a transaction or block asked for just after it lands is served a moment later.
          // Nor a read pinned to a slot (`minContextSlot`): Canary's snapshots of a strategy's ProgramData,
          // a megabyte each, which no test reads and which would take the file past GitHub's 100 MB.
          if (error === undefined && result !== null && !pinnedToSlot(params)) {
            recording[key] = answer;
            writeFileSync(FIXTURES, serialise(recording));
          }
        } catch (e) {
          answer = { error: { code: -32000, message: `devnet did not answer ${key}: ${e instanceof Error ? e.name : typeof e}` } };
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer ? { jsonrpc: "2.0", id, ...answer } : { jsonrpc: "2.0", id, error: { code: -32000, message: `no recorded answer for ${key}` } }));
    });
  });
  server.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req)));
  return new Promise((done) => server.listen(RPC_PORT, "127.0.0.1", () => done(server)));
}
