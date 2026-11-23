// The Solana RPC the local API reads in the end-to-end tests. CI has no RPC key and no network
// (PIPESCOPE-96), so the API reads recorded devnet answers from fixtures/devnet-rpc.json through this
// server; `pnpm --filter terminal-e2e record` runs the suite against devnet through it, passing each
// request on to RPC_URL and recording the answer.
//
// It also speaks the RPC's WebSocket: a `logsSubscribe` is answered with a subscription, and a POST to
// LIVE_EMIT_PATH announces a transaction on every subscription, as devnet's socket would once the
// transaction lands (src/live.ts says when the tests do this). The indexer then fetches the
// transaction through the recorded answers like any other.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export const RPC_PORT = 8812;
/** Where a test tells the fixture socket a transaction has landed: a POST of `{ signature, slot }`. */
export const LIVE_EMIT_PATH = "/__live/emit";
const FIXTURES = `${import.meta.dirname}/../fixtures/devnet-rpc.json`;

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

  const server = createServer((req, res) => {
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
          if (error === undefined && result !== null) {
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
