// The one way `terminal-api` fetches from the web (docs/spec/pipescope-architecture.md, Metadata
// fetcher; PIPESCOPE-36): strategies' metadata documents (./metadataFetch) and tokens' images
// (./tokenImageFetch). `https:` only; redirects followed by hand, at most `maxRedirects`, each checked
// to be `https:` before it is followed; one answer within `timeoutMs`, redirects and body included;
// and a body read no further than the cap the caller gives. It never throws.
import { METADATA_FETCH } from "./config";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type UnreachableReason = "unsupported-uri" | "network" | "timeout" | "http-status" | "too-large" | "redirects" | "redirect-not-https";

/** A body fetched: the URL it was finally read from, its declared content type, and its bytes. */
export type Fetched = { ok: true; url: string; contentType: string | null; body: Uint8Array };
/** What stopped a fetch, with the URL it had reached and a sentence saying why. */
export type NotFetched = { ok: false; reason: UnreachableReason; url: string | null; error: string };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The URI as an `https:` URL, resolved against `base` when relative, or null for anything else. */
export function httpsUrl(uri: string, base?: string): URL | null {
  try {
    const url = new URL(uri, base);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** A JSON content type: one the config names, or any `+json` type; parameters such as a charset are ignored. */
export function jsonType(header: string | null): boolean {
  const type = header?.split(";")[0]!.trim().toLowerCase();
  return !!type && ((METADATA_FETCH.contentTypes as readonly string[]).includes(type) || type.endsWith("+json"));
}

/** The body, or null once it passes `maxBytes`, when the rest is not read. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * GETs `start` under the limits above, with a body of at most `maxBytes`. `acceptBody`, given the
 * content type of the final answer, may refuse it before its body is read (returning why), so a
 * document of the wrong type is never downloaded.
 */
export async function fetchLimited(
  start: URL,
  { fetch, maxBytes, accept, acceptBody }: { fetch: FetchLike; maxBytes: number; accept: string; acceptBody?: (contentType: string | null) => string | null },
): Promise<Fetched | NotFetched | { ok: false; refused: string; url: string; contentType: string | null }> {
  const { timeoutMs, maxRedirects } = METADATA_FETCH;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let url = start;
  const unreachable = (reason: UnreachableReason, error: string): NotFetched => ({ ok: false, reason, url: url.href, error });
  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url.href, { redirect: "manual", signal: deadline.signal, headers: { accept } });
      if (!REDIRECTS.has(response.status)) break;
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location) return unreachable("http-status", `HTTP ${response.status} with no Location`);
      if (redirects >= maxRedirects) return unreachable("redirects", `more than ${maxRedirects} redirects`);
      const next = httpsUrl(location, url.href);
      if (!next) return unreachable("redirect-not-https", "redirected to a URL that is not https:");
      url = next;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return unreachable("http-status", `HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type");
    const refused = acceptBody?.(contentType) ?? null;
    if (refused) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, refused, url: url.href, contentType };
    }
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      return unreachable("too-large", `larger than ${maxBytes} bytes`);
    }
    const body = await readCapped(response, maxBytes);
    if (!body) return unreachable("too-large", `larger than ${maxBytes} bytes`);
    return { ok: true, url: url.href, contentType, body };
  } catch (e) {
    if (deadline.signal.aborted) return unreachable("timeout", `no answer within ${timeoutMs / 1000} s`);
    return unreachable("network", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fetch `terminal-api` uses for the web in a Worker: its own, or in the end-to-end tests one that
 * asks the fixture server for each URL (`TEST_METADATA_FIXTURES`), which answers what was recorded for
 * it, redirects and all, so every rule above still runs on the URLs themselves.
 */
export function webFetchFor(env: { TEST_METADATA_FIXTURES?: string }): FetchLike {
  const fixtures = env.TEST_METADATA_FIXTURES;
  if (!fixtures) return (url, init) => fetch(url, init);
  return (url, init) => fetch(`${fixtures}?url=${encodeURIComponent(url)}`, init);
}
