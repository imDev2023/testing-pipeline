// The metadata fetcher (docs/spec/pipescope-architecture.md, Metadata fetcher; PIPESCOPE-36): fetches
// the one document a strategy's metadata URI names, under the limits in ./config (./webFetch, which
// follows redirects itself, so each is checked before it is followed), and validates it with
// Pipeline's `parseStrategyMetadata`. It never fetches anything else: a URL inside the document is
// author text.
//
// Its outcome is the SDK's metadata status (`MetadataFacts`), so the flag it gives (`metadata-missing`,
// `metadata-unreachable` or `metadata-invalid`) is the one Pipeline's SDK and hosted API give: what
// could not be fetched is unreachable, a document that is not strategy metadata (not JSON, of another
// content type, or refused by the validator) is invalid. It never throws.
import { parseStrategyMetadata, type StrategyMetadata } from "@pipeline-sol/sdk";
import { METADATA_FETCH } from "./config";
import { fetchLimited, httpsUrl, jsonType, sha256Hex, type FetchLike, type UnreachableReason } from "./webFetch";

export type { FetchLike, UnreachableReason } from "./webFetch";
export type InvalidReason = "content-type" | "not-json" | "invalid";

export type MetadataOutcome =
  | { status: "missing"; url: null; errors: string[] }
  | { status: "unreachable"; reason: UnreachableReason; url: string | null; errors: string[] }
  /** `sha256` is of the bytes fetched, or null when the body was not read (a refused content type). */
  | { status: "invalid"; reason: InvalidReason; url: string; errors: string[]; sha256: string | null }
  | { status: "valid"; url: string; value: StrategyMetadata; warnings: string[]; sha256: string };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Fetches and validates the metadata document at `uri`. `fetch` is the Worker's, or a test's. */
export async function fetchMetadata(uri: string, { fetch = globalThis.fetch }: { fetch?: FetchLike } = {}): Promise<MetadataOutcome> {
  if (uri.trim() === "") return { status: "missing", url: null, errors: ["no metadata URI"] };
  const url = httpsUrl(uri.trim());
  if (!url) return { status: "unreachable", reason: "unsupported-uri", url: null, errors: [`unsupported URI: only https: is fetched`] };
  const fetched = await fetchLimited(url, {
    fetch,
    maxBytes: METADATA_FETCH.maxBytes,
    accept: "application/json",
    acceptBody: (type) => (jsonType(type) ? null : `the document has ${type ? `content type ${type.split(";")[0]!.trim()}` : "no content type"}, not JSON`),
  });
  if (!fetched.ok) {
    if ("refused" in fetched) return { status: "invalid", reason: "content-type", url: fetched.url, errors: [fetched.refused], sha256: null };
    return { status: "unreachable", reason: fetched.reason, url: fetched.url, errors: [fetched.error] };
  }
  const sha256 = await sha256Hex(fetched.body);
  let json: unknown;
  try {
    json = JSON.parse(utf8.decode(fetched.body));
  } catch {
    return { status: "invalid", reason: "not-json", url: fetched.url, errors: ["the document is not UTF-8 JSON"], sha256 };
  }
  const parsed = parseStrategyMetadata(json);
  if (!parsed.ok) return { status: "invalid", reason: "invalid", url: fetched.url, errors: parsed.errors, sha256 };
  return { status: "valid", url: fetched.url, value: parsed.value, warnings: parsed.warnings, sha256 };
}
