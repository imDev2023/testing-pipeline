// Token images in Aviary's own keeping (docs/spec/pipescope-architecture.md, Data; PIPESCOPE-82,
// PIPESCOPE-88). Each token metadata URI a mint names is fetched once (./tokenImageFetch), and again
// only when a mint names another, so mints sharing a URI share its outcome. A kept image's bytes go
// to KV (`TERMINAL_CACHE`) under their SHA-256, and the outcome of every fetch to Postgres
// (`token_images`), the record; KV holds only bytes a re-fetch could replace.
//
// `/images/<hash>` serves the bytes from KV alone, so serving an image never wakes the database: the
// page is given the hash with the mint. The answer's type is fixed to the one the first bytes said,
// with `nosniff`, and a policy under which nothing in it can run, so a reader's browser never asks an
// author's server for anything and never runs what an author sent.
import { and, inArray, isNotNull, notExists, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { mints, tokenImages, type Db } from "terminal-db";
import { AVIARY_MINT_NAMES, METADATA_FETCH, TOKEN_IMAGE } from "./config";
import type { ApiError, TokenName } from "./contract";
import type { AppEnv } from "./index";
import { fetchTokenImage, type TokenImageType } from "./tokenImageFetch";
import type { FetchLike } from "./webFetch";

/** Where kept images' bytes live, by the SHA-256 of the bytes. */
export type ImageStore = {
  put(sha256: string, bytes: Uint8Array, type: TokenImageType): Promise<void>;
  get(sha256: string): Promise<{ bytes: ArrayBuffer; type: TokenImageType } | null>;
};

const keyOf = (sha256: string) => `image:${sha256}`;
const KEPT_TYPES = new Set<string>(TOKEN_IMAGE.types);

/** The image store over the `TERMINAL_CACHE` KV namespace: the bytes as the value, their type as its metadata. */
export function kvImageStore(kv: KVNamespace): ImageStore {
  return {
    put: (sha256, bytes, type) => kv.put(keyOf(sha256), bytes as Uint8Array<ArrayBuffer>, { metadata: { type } }),
    get: async (sha256) => {
      const { value, metadata } = await kv.getWithMetadata<{ type?: string }>(keyOf(sha256), "arrayBuffer");
      const type = metadata?.type;
      if (!value || !type || !KEPT_TYPES.has(type)) return null;
      return { bytes: value, type: type as TokenImageType };
    },
  };
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function inTurns<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

/**
 * Fetches the image of every token metadata URI a mint that names itself names and that has not been
 * fetched, other than those of the mints Aviary names itself (SOL, USDC), whose marks ship with the
 * app; with `retryUnreachable` (the hourly read of every mint), also each URI that could not be
 * reached last time, since a host can be down for a moment (PIPESCOPE-123). What was kept, found
 * naming no image or refused is never fetched again until a mint names another URI. A kept image is
 * written to the store before its record, so a record never names bytes that are not there. Returns
 * how many URIs it fetched and how many images it kept.
 */
export async function fetchTokenImages(
  db: Db,
  store: ImageStore,
  { fetch, now, retryUnreachable = false }: { fetch: FetchLike; now?: Date; retryUnreachable?: boolean },
): Promise<{ fetched: number; kept: number }> {
  const settled = retryUnreachable ? sql`and ${tokenImages.status} <> 'unreachable'` : sql``;
  const due = await db
    .selectDistinct({ uri: mints.tokenUri })
    .from(mints)
    .where(
      and(
        isNotNull(mints.tokenUri),
        or(isNotNull(mints.symbol), isNotNull(mints.name)),
        sql`${mints.address} not in (${sql.join(Object.keys(AVIARY_MINT_NAMES).map((m) => sql`${m}`), sql`, `)})`,
        notExists(db.select({ one: sql`1` }).from(tokenImages).where(sql`${tokenImages.uri} = ${mints.tokenUri} ${settled}`)),
      ),
    );
  let kept = 0;
  await inTurns(
    due.map((d) => d.uri!),
    METADATA_FETCH.concurrency,
    async (uri) => {
      const outcome = await fetchTokenImage(uri, { fetch });
      const fetchedAt = now ?? new Date();
      if (outcome.status === "kept") {
        await store.put(outcome.sha256, outcome.bytes, outcome.type);
        kept++;
      }
      const row =
        outcome.status === "kept"
          ? { uri, status: "kept", reason: null, imageUrl: outcome.url, sha256: outcome.sha256, contentType: outcome.type, size: outcome.bytes.byteLength, fetchedAt }
          : { uri, status: outcome.status, reason: outcome.reason, imageUrl: outcome.status === "refused" ? outcome.url : null, sha256: null, contentType: null, size: null, fetchedAt };
      await db
        .insert(tokenImages)
        .values(row)
        .onConflictDoUpdate({ target: tokenImages.uri, set: { status: row.status, reason: row.reason, imageUrl: row.imageUrl, sha256: row.sha256, contentType: row.contentType, size: row.size, fetchedAt: row.fetchedAt } });
    },
  );
  return { fetched: due.length, kept };
}

/** The kept image's hash for each token metadata URI named, read with the mints a page shows. */
export async function keptImages(db: Db, uris: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(uris.filter((u): u is string => !!u))];
  if (!wanted.length) return new Map();
  const rows = await db.select({ uri: tokenImages.uri, sha256: tokenImages.sha256 }).from(tokenImages).where(and(inArray(tokenImages.uri, wanted), sql`${tokenImages.status} = 'kept'`));
  return new Map(rows.flatMap((r) => (r.sha256 ? [[r.uri, r.sha256] as const] : [])));
}

/**
 * A mint's token name as the API serves it (`TokenName`): the author's symbol and name with its kept
 * image, or null when the mint names neither, and always null for SOL and USDC, which Aviary names
 * itself, so no author's claim ever stands beside Aviary's own name.
 */
export function tokenNameOf(mint: string, read: { symbol: string | null; name: string | null; tokenUri: string | null } | null | undefined, images: Map<string, string>): TokenName | null {
  if (AVIARY_MINT_NAMES[mint] || !read || (!read.symbol && !read.name)) return null;
  return { symbol: read.symbol, name: read.name, image: (read.tokenUri && images.get(read.tokenUri)) || null };
}

/** `GET /images/<hash>`: a kept image, from KV alone. */
export const imageRoutes = new Hono<AppEnv>();

const HASH = /^[0-9a-f]{64}$/;

imageRoutes.get("/images/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!HASH.test(hash)) return c.json<ApiError>({ error: "An image's address is the SHA-256 of its bytes, in lowercase hex." }, 400);
  const image = await kvImageStore(c.env.TERMINAL_CACHE).get(hash);
  if (!image) return c.json<ApiError>({ error: "Aviary keeps no image with this hash." }, 404);
  return c.body(image.bytes, 200, {
    "content-type": image.type,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    // Its address is its hash, so what is served there never changes.
    "cache-control": "public, max-age=31536000, immutable",
  });
});
