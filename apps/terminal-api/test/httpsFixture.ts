// A local HTTPS server for the metadata fetcher's tests: a self-signed certificate made with
// openssl for this run, routes the test sets, and every request it was sent, so a test can say what
// the fetcher asked for and what it never asked for. `fetch` trusts only this server's certificate.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";

export type Route = (req: IncomingMessage, res: ServerResponse) => void;

export type HttpsFixture = {
  origin: string;
  /** Sets what a path answers. */
  route: (path: string, handler: Route) => void;
  /** Every path asked for, in order. */
  requests: string[];
  /** A fetch that trusts this server's certificate, as the Worker's global fetch trusts the public ones. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
};

export async function startHttpsFixture(): Promise<HttpsFixture> {
  const dir = mkdtempSync(join(tmpdir(), "metadata-fixture-"));
  const [key, cert] = [join(dir, "key.pem"), join(dir, "cert.pem")];
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  const ca = readFileSync(cert);
  const routes = new Map<string, Route>();
  const requests: string[] = [];
  const server: Server = createServer({ key: readFileSync(key), cert: ca }, (req, res) => {
    const path = req.url ?? "/";
    requests.push(path);
    const handler = routes.get(path.split("?")[0]!);
    if (handler) handler(req, res);
    else res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dispatcher = new Agent({ connect: { ca } });
  return {
    origin,
    route: (path, handler) => routes.set(path, handler),
    requests,
    fetch: (url, init) => undiciFetch(url, { ...(init as object), dispatcher }) as unknown as Promise<Response>,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await dispatcher.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Answers with `body` and the headers given. */
export const answer =
  (body: string | Buffer, headers: Record<string, string> = { "content-type": "application/json" }, status = 200): Route =>
  (_req, res) =>
    res.writeHead(status, headers).end(body);

export const redirect =
  (location: string, status = 302): Route =>
  (_req, res) =>
    res.writeHead(status, { location }).end();
