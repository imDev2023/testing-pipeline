// Fetching a token's image (docs/spec/pipescope-screens.md, "Token names and images"; PIPESCOPE-82),
// against a local HTTPS fixture server: under the metadata fetcher's limits (`https:` only, 5 s, at
// most 3 redirects, each `https:`) and at most 1 MB, kept only when its first bytes say PNG, JPEG or
// WebP, whatever the server claims, and never SVG. The image is the token metadata URI itself when it
// serves an image, or the `image` named by the JSON document it serves (PIPESCOPE-123).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TOKEN_IMAGE } from "../src/config";
import { fetchTokenImage } from "../src/tokenImageFetch";
import { answer, redirect, startHttpsFixture, type HttpsFixture } from "./httpsFixture";

const image = (name: string) => readFileSync(`${import.meta.dirname}/fixtures/images/${name}`);
const PNG = image("token.png");
const JPEG = image("token.jpg");
const WEBP = image("token.webp");
const SVG_WITH_SCRIPT = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(document.domain)</script><circle r="10"/></svg>');
const HTML = Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let server: HttpsFixture;
const url = (path: string) => `${server.origin}${path}`;
const fetchFrom = (uri: string) => fetchTokenImage(uri, { fetch: server.fetch });
const document = (imageUrl: unknown) => answer(JSON.stringify({ name: "Fixture Token", symbol: "FIX", image: imageUrl }));

beforeAll(async () => {
  server = await startHttpsFixture();
});
afterAll(() => server.close());
beforeEach(() => {
  server.requests.length = 0;
});

describe("the limits", () => {
  it("are the config module's: PNG, JPEG or WebP, at most 1 MB", () => {
    expect(TOKEN_IMAGE).toMatchObject({ types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 1024 * 1024 });
  });
});

describe("what it keeps", () => {
  it.each([
    ["a PNG", PNG, "image/png"],
    ["a JPEG", JPEG, "image/jpeg"],
    ["a WebP", WEBP, "image/webp"],
  ])("%s named by the token's JSON document, typed by its first bytes, with its SHA-256", async (_, bytes, type) => {
    server.route("/token.json", document(url("/image")));
    server.route("/image", answer(bytes, { "content-type": "application/octet-stream" }));
    const outcome = await fetchFrom(url("/token.json"));
    expect(outcome).toMatchObject({ status: "kept", url: url("/image"), type, sha256: sha256(bytes) });
    expect(outcome.status === "kept" && Buffer.from(outcome.bytes).equals(bytes)).toBe(true);
  });

  it("an image the token metadata URI serves itself, read once", async () => {
    server.route("/direct.png", answer(PNG, { "content-type": "image/png" }));
    expect(await fetchFrom(url("/direct.png"))).toMatchObject({ status: "kept", url: url("/direct.png"), type: "image/png" });
    expect(server.requests).toEqual(["/direct.png"]);
  });

  it("an image of exactly 1 MB", async () => {
    const full = Buffer.concat([PNG, Buffer.alloc(TOKEN_IMAGE.maxBytes - PNG.length)]);
    server.route("/token.json", document(url("/full.png")));
    server.route("/full.png", answer(full, { "content-type": "image/png" }));
    expect(await fetchFrom(url("/token.json"))).toMatchObject({ status: "kept", type: "image/png" });
  });

  it("an image behind redirects, each to https:", async () => {
    server.route("/token.json", document(url("/r1")));
    server.route("/r1", redirect("/r2", 301));
    server.route("/r2", redirect(url("/final.webp"), 308));
    server.route("/final.webp", answer(WEBP, { "content-type": "image/webp" }));
    expect(await fetchFrom(url("/token.json"))).toMatchObject({ status: "kept", url: url("/final.webp"), type: "image/webp" });
  });
});

describe("what it refuses", () => {
  it("an SVG with script", async () => {
    server.route("/token.json", document(url("/evil.svg")));
    server.route("/evil.svg", answer(SVG_WITH_SCRIPT, { "content-type": "image/svg+xml" }));
    expect(await fetchFrom(url("/token.json"))).toMatchObject({ status: "refused", reason: "type", url: url("/evil.svg") });
  });

  it("an SVG served as image/png", async () => {
    server.route("/token.json", document(url("/evil.png")));
    server.route("/evil.png", answer(SVG_WITH_SCRIPT, { "content-type": "image/png" }));
    expect(await fetchFrom(url("/token.json"))).toMatchObject({ status: "refused", reason: "type" });
  });

  it("HTML served as image/png", async () => {
    server.route("/token.json", document(url("/page.png")));
    server.route("/page.png", answer(HTML, { "content-type": "image/png" }));
    expect(await fetchFrom(url("/token.json"))).toMatchObject({ status: "refused", reason: "type" });
  });

  it("an SVG as the token metadata URI itself", async () => {
    server.route("/evil.svg", answer(SVG_WITH_SCRIPT, { "content-type": "image/svg+xml" }));
    expect(await fetchFrom(url("/evil.svg"))).toMatchObject({ status: "refused", reason: "type" });
  });

  it("1 MB plus one byte, read no further", async () => {
    const over = Buffer.concat([PNG, Buffer.alloc(TOKEN_IMAGE.maxBytes + 1 - PNG.length)]);
    server.route("/token.json", document(url("/big.png")));
    server.route("/big.png", answer(over, { "content-type": "image/png" }));
    expect(await fetchFrom(url("/token.json"))).toMatchObject({ status: "refused", reason: "too-large" });
  });

  it("a redirect to http:, never followed", async () => {
    server.route("/token.json", document(url("/hop")));
    server.route("/hop", redirect("http://127.0.0.1:9/image.png"));
    expect(await fetchFrom(url("/token.json"))).toMatchObject({ status: "unreachable", reason: "redirect-not-https" });
    expect(server.requests).toEqual(["/token.json", "/hop"]);
  });

  it("an image named by an http: or data: URL, never fetched", async () => {
    server.route("/token.json", document("http://127.0.0.1:9/image.png"));
    expect(await fetchFrom(url("/token.json"))).toMatchObject({ status: "unreachable", reason: "unsupported-uri" });
    server.route("/data.json", document(`data:image/png;base64,${PNG.toString("base64")}`));
    expect(await fetchFrom(url("/data.json"))).toMatchObject({ status: "unreachable", reason: "unsupported-uri" });
  });

  it("a token metadata URI that is not https:", async () => {
    expect(await fetchFrom("ipfs://QmdznmJXTyhKAJdzMUrchXaHxtuRs97n9YzF4geW8EeMZW")).toMatchObject({ status: "unreachable", reason: "unsupported-uri" });
  });

  it("a document past the metadata fetcher's 64 KB", async () => {
    server.route("/huge.json", answer(JSON.stringify({ image: url("/image"), pad: "x".repeat(70 * 1024) })));
    expect(await fetchFrom(url("/huge.json"))).toMatchObject({ status: "refused", reason: "too-large" });
  });

  it("a document of a type that is neither an image nor JSON", async () => {
    server.route("/page", answer(HTML, { "content-type": "text/html" }));
    expect(await fetchFrom(url("/page"))).toMatchObject({ status: "refused", reason: "type" });
  });

  it("a document that names no image, or not as a string, as missing", async () => {
    server.route("/none.json", answer(JSON.stringify({ name: "No Image" })));
    expect(await fetchFrom(url("/none.json"))).toMatchObject({ status: "missing", reason: "no-image" });
    server.route("/odd.json", document({ url: url("/image") }));
    expect(await fetchFrom(url("/odd.json"))).toMatchObject({ status: "missing", reason: "no-image" });
  });

  it("an image the server does not serve", async () => {
    server.route("/token.json", document(url("/gone.png")));
    expect(await fetchFrom(url("/token.json"))).toMatchObject({ status: "unreachable", reason: "http-status" });
  });

  it("an image that takes longer than 5 s", async () => {
    server.route("/token.json", document(url("/slow.png")));
    server.route("/slow.png", (_req, res) => void setTimeout(() => res.writeHead(200, { "content-type": "image/png" }).end(PNG), 6_000));
    expect(await fetchFrom(url("/token.json"))).toMatchObject({ status: "unreachable", reason: "timeout" });
  }, 10_000);
});
