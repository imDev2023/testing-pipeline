// The metadata fetcher (docs/spec/pipescope-architecture.md, Metadata fetcher; PIPESCOPE-36): fetches
// the one document a strategy's metadata URI names, under the limits in ./config, and validates it
// with Pipeline's `parseStrategyMetadata`. It follows redirects itself, so each is checked before it
// is followed, and it never fetches anything else: a URL inside the document is author text.
//
// Its outcome is the SDK's metadata status (`MetadataFacts`), so the flag it gives (`metadata-missing`,
// `metadata-unreachable` or `metadata-invalid`) is the one Pipeline's SDK and hosted API give: what
// could not be fetched is unreachable, a document that is not strategy metadata (not JSON, of another
// content type, or refused by the validator) is invalid. It never throws.
import { parseStrategyMetadata, type StrategyMetadata } from "@pipeline-sol/sdk";
import { METADATA_FETCH } from "./config";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type UnreachableReason = "unsupported-uri" | "network" | "timeout" | "http-status" | "too-large" | "redirects" | "redirect-not-https";
export type InvalidReason = "content-type" | "not-json" | "invalid";

export type MetadataOutcome =
  | { status: "missing"; url: null; errors: string[] }
  | { status: "unreachable"; reason: UnreachableReason; url: string | null; errors: string[] }
  /** `sha256` is of the bytes fetched, or null when the body was not read (a refused content type). */
  | { status: "invalid"; reason: InvalidReason; url: string; errors: string[]; sha256: string | null }
  | { status: "valid"; url: string; value: StrategyMetadata; warnings: string[]; sha256: string };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The URI as an `https:` URL, or null for anything else. */
function httpsUrl(uri: string, base?: string): URL | null {
  try {
    const url = new URL(uri, base);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** A JSON content type: one the config names, or any `+json` type; parameters such as a charset are ignored. */
function jsonType(header: string | null): boolean {
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

const hex = (digest: ArrayBuffer) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Fetches and validates the metadata document at `uri`. `fetch` is the Worker's, or a test's. */
export async function fetchMetadata(uri: string, { fetch = globalThis.fetch }: { fetch?: FetchLike } = {}): Promise<MetadataOutcome> {
  if (uri.trim() === "") return { status: "missing", url: null, errors: ["no metadata URI"] };
  let url = httpsUrl(uri.trim());
  if (!url) return { status: "unreachable", reason: "unsupported-uri", url: null, errors: [`unsupported URI: only https: is fetched`] };
  const { maxBytes, timeoutMs, maxRedirects } = METADATA_FETCH;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const unreachable = (reason: UnreachableReason, error: string): MetadataOutcome => ({ status: "unreachable", reason, url: url!.href, errors: [error] });
  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url.href, { redirect: "manual", signal: deadline.signal, headers: { accept: "application/json" } });
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
    const type = response.headers.get("content-type");
    if (!jsonType(type)) {
      await response.body?.cancel().catch(() => {});
      const what = type ? `content type ${type.split(";")[0]!.trim()}` : "no content type";
      return { status: "invalid", reason: "content-type", url: url.href, errors: [`the document has ${what}, not JSON`], sha256: null };
    }
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      return unreachable("too-large", `larger than ${maxBytes} bytes`);
    }
    const body = await readCapped(response, maxBytes);
    if (!body) return unreachable("too-large", `larger than ${maxBytes} bytes`);
    const sha256 = hex(await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>));
    let json: unknown;
    try {
      json = JSON.parse(utf8.decode(body));
    } catch {
      return { status: "invalid", reason: "not-json", url: url.href, errors: ["the document is not UTF-8 JSON"], sha256 };
    }
    const parsed = parseStrategyMetadata(json);
    if (!parsed.ok) return { status: "invalid", reason: "invalid", url: url.href, errors: parsed.errors, sha256 };
    return { status: "valid", url: url.href, value: parsed.value, warnings: parsed.warnings, sha256 };
  } catch (e) {
    if (deadline.signal.aborted) return unreachable("timeout", `no answer within ${timeoutMs / 1000} s`);
    return unreachable("network", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fetch the metadata fetcher uses in a Worker: its own, or in the end-to-end tests one that asks
 * the fixture server for each URL (`TEST_METADATA_FIXTURES`), which answers what was recorded for it,
 * redirects and all, so every rule above still runs on the URLs themselves.
 */
export function metadataFetchFor(env: { TEST_METADATA_FIXTURES?: string }): FetchLike {
  const fixtures = env.TEST_METADATA_FIXTURES;
  if (!fixtures) return (url, init) => fetch(url, init);
  return (url, init) => fetch(`${fixtures}?url=${encodeURIComponent(url)}`, init);
}
