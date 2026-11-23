// Fetching a token's image (docs/spec/pipescope-screens.md, "Token names and images"; PIPESCOPE-82):
// the image a mint's on-chain token metadata names, under the metadata fetcher's limits (./webFetch)
// and at most `TOKEN_IMAGE.maxBytes`, kept only when its first bytes say PNG, JPEG or WebP, whatever
// the server says it is; SVG is never kept, since it can carry script.
//
// The token metadata URI names a JSON document whose `image` is the picture, as Metaplex's token
// standard lays it out, or names the image itself (PIPESCOPE-123). So the URI is fetched once; if
// what it serves is an image, that is the image; if it is a JSON document of at most the metadata
// fetcher's 64 KB, its `image`, when an `https:` URL, is fetched once more under the same limits.
// Nothing else is ever fetched, and nothing else in the document is read.
import { METADATA_FETCH, TOKEN_IMAGE } from "./config";
import { fetchLimited, httpsUrl, jsonType, sha256Hex, type FetchLike, type Fetched, type UnreachableReason } from "./webFetch";

export type TokenImageType = (typeof TOKEN_IMAGE.types)[number];

export type TokenImageOutcome =
  | { status: "kept"; url: string; bytes: Uint8Array; type: TokenImageType; sha256: string }
  /** No URI, or a document that names no image. */
  | { status: "missing"; reason: "no-uri" | "no-image"; url: string | null; error: string }
  | { status: "unreachable"; reason: UnreachableReason; url: string | null; error: string }
  /** Something was read and is no image Aviary keeps: another type, larger than its cap, or a document that is not JSON. */
  | { status: "refused"; reason: "type" | "too-large" | "not-json"; url: string; error: string };

const startsWith = (bytes: Uint8Array, prefix: number[], at = 0) => prefix.every((b, i) => bytes[at + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** The image type the first bytes say, or null for anything else (SVG, HTML, GIF...). */
export function sniffImage(bytes: Uint8Array): TokenImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

const IMAGE_TYPES = TOKEN_IMAGE.types.join(", ");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The answer as an outcome when it is an image (kept) or nothing it could be (refused), or null to read it as a document. */
async function asImage(fetched: Fetched, documentAllowed: boolean): Promise<TokenImageOutcome | null> {
  const type = sniffImage(fetched.body);
  if (type) return { status: "kept", url: fetched.url, bytes: fetched.body, type, sha256: await sha256Hex(fetched.body) };
  if (documentAllowed && jsonType(fetched.contentType)) return null;
  return { status: "refused", reason: "type", url: fetched.url, error: `not a PNG, JPEG or WebP by its first bytes (served as ${fetched.contentType?.split(";")[0]!.trim() || "no type"})` };
}

async function fetchCapped(url: URL, fetch: FetchLike, accept: string): Promise<Fetched | TokenImageOutcome> {
  const fetched = await fetchLimited(url, { fetch, maxBytes: TOKEN_IMAGE.maxBytes, accept });
  if (fetched.ok) return fetched;
  if ("refused" in fetched) return { status: "refused", reason: "type", url: fetched.url, error: fetched.refused };
  if (fetched.reason === "too-large") return { status: "refused", reason: "too-large", url: fetched.url ?? url.href, error: fetched.error };
  return { status: "unreachable", reason: fetched.reason, url: fetched.url, error: fetched.error };
}

/** Fetches the image the token metadata URI `uri` names. `fetch` is the Worker's, or a test's. It never throws. */
export async function fetchTokenImage(uri: string, { fetch }: { fetch: FetchLike }): Promise<TokenImageOutcome> {
  if (uri.trim() === "") return { status: "missing", reason: "no-uri", url: null, error: "the token names no metadata URI" };
  const start = httpsUrl(uri.trim());
  if (!start) return { status: "unreachable", reason: "unsupported-uri", url: null, error: "unsupported URI: only https: is fetched" };

  const first = await fetchCapped(start, fetch, `application/json, ${IMAGE_TYPES}`);
  if (!("ok" in first)) return first;
  const image = await asImage(first, true);
  if (image) return image;

  if (first.body.byteLength > METADATA_FETCH.maxBytes) return { status: "refused", reason: "too-large", url: first.url, error: `a document larger than ${METADATA_FETCH.maxBytes} bytes` };
  let named: unknown;
  try {
    named = (JSON.parse(utf8.decode(first.body)) as { image?: unknown } | null)?.image;
  } catch {
    return { status: "refused", reason: "not-json", url: first.url, error: "the document is not UTF-8 JSON" };
  }
  if (typeof named !== "string" || named.trim() === "") return { status: "missing", reason: "no-image", url: first.url, error: "the document names no image" };
  const imageUrl = httpsUrl(named.trim(), first.url);
  if (!imageUrl) return { status: "unreachable", reason: "unsupported-uri", url: null, error: "the image's URL is not https:" };

  const second = await fetchCapped(imageUrl, fetch, IMAGE_TYPES);
  if (!("ok" in second)) return second;
  return (await asImage(second, false))!;
}
