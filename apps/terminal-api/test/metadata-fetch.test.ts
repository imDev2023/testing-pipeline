// The metadata fetcher (docs/spec/pipescope-architecture.md, Metadata fetcher; PIPESCOPE-36), against
// a local HTTPS fixture server: `https:` only, at most 64 KB, a JSON content type (application/json,
// any +json type, or text/plain, as GitHub serves .json files), a 5 s limit, at most 3 redirects,
// each `https:`, and never a URL found inside the document. Each refusal is the status Pipeline's SDK
// gives for the same kind of failure: unreachable for what could not be fetched, invalid for a
// document that is not strategy metadata.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { METADATA_FETCH } from "../src/config";
import { fetchMetadata } from "../src/metadataFetch";
import { answer, redirect, startHttpsFixture, type HttpsFixture } from "./httpsFixture";

const DOCUMENT = JSON.stringify({ schema: "pipeline-strategy-metadata/1", name: "Fixture Strategy", description: "A document the fixture server serves." });

let server: HttpsFixture;
const url = (path: string) => `${server.origin}${path}`;
const fetchFrom = (uri: string) => fetchMetadata(uri, { fetch: server.fetch });

beforeAll(async () => {
  server = await startHttpsFixture();
});
afterAll(() => server.close());
beforeEach(() => {
  server.requests.length = 0;
});

describe("the limits", () => {
  it("are the config module's: 64 KB, 5 s and 3 redirects", () => {
    expect(METADATA_FETCH).toMatchObject({ maxBytes: 64 * 1024, timeoutMs: 5_000, maxRedirects: 3 });
  });
});

describe("what it accepts", () => {
  it("a valid document, with the SHA-256 of the bytes it fetched", async () => {
    server.route("/doc.json", answer(DOCUMENT));
    const outcome = await fetchFrom(url("/doc.json"));
    expect(outcome).toMatchObject({ status: "valid", url: url("/doc.json"), warnings: [], sha256: createHash("sha256").update(DOCUMENT).digest("hex") });
    expect(outcome.status === "valid" && outcome.value.name).toBe("Fixture Strategy");
  });

  it.each(["application/json", "application/json; charset=utf-8", "text/plain; charset=utf-8", "application/ld+json", "Application/JSON"])("the content type %s", async (type) => {
    server.route("/typed.json", answer(DOCUMENT, { "content-type": type }));
    expect((await fetchFrom(url("/typed.json"))).status).toBe("valid");
  });

  it("three redirects, each to https:", async () => {
    server.route("/r1", redirect(url("/r2"), 301));
    server.route("/r2", redirect("/r3", 307));
    server.route("/r3", redirect(url("/doc.json"), 308));
    server.route("/doc.json", answer(DOCUMENT));
    expect(await fetchFrom(url("/r1"))).toMatchObject({ status: "valid", url: url("/doc.json") });
    expect(server.requests).toEqual(["/r1", "/r2", "/r3", "/doc.json"]);
  });

  it("a body of exactly 64 KB", async () => {
    const padded = DOCUMENT + " ".repeat(64 * 1024 - DOCUMENT.length);
    server.route("/full.json", answer(padded));
    expect((await fetchFrom(url("/full.json"))).status).toBe("valid");
  });
});

describe("what it refuses", () => {
  it("an http: URL, without a request", async () => {
    const outcome = await fetchFrom(url("/doc.json").replace("https:", "http:"));
    expect(outcome).toMatchObject({ status: "unreachable", reason: "unsupported-uri" });
    expect(server.requests).toEqual([]);
  });

  it.each(["ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/meta.json", "ar://abc", "ftp://example.com/x.json", "javascript:alert(1)", "not a url"])("any other scheme, as %s", async (uri) => {
    expect(await fetchFrom(uri)).toMatchObject({ status: "unreachable", reason: "unsupported-uri" });
  });

  it("an empty URI as missing", async () => {
    expect(await fetchFrom("")).toEqual({ status: "missing", url: null, errors: ["no metadata URI"] });
    expect(await fetchFrom("   ")).toMatchObject({ status: "missing" });
  });

  it("a body over 64 KB, by its declared length", async () => {
    const big = DOCUMENT + " ".repeat(64 * 1024 + 1 - DOCUMENT.length);
    server.route("/big.json", answer(big, { "content-type": "application/json", "content-length": String(Buffer.byteLength(big)) }));
    expect(await fetchFrom(url("/big.json"))).toMatchObject({ status: "unreachable", reason: "too-large" });
  });

  it("a body over 64 KB with no declared length, reading no more than the limit", async () => {
    server.route("/chunked.json", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      for (let i = 0; i < 80; i++) res.write(" ".repeat(1024));
      res.end(DOCUMENT);
    });
    expect(await fetchFrom(url("/chunked.json"))).toMatchObject({ status: "unreachable", reason: "too-large" });
  });

  it.each([["text/html; charset=utf-8"], ["application/octet-stream"], ["image/png"], [null]])("a non-JSON content type (%s), as invalid, without parsing the body", async (type) => {
    server.route("/typed.json", answer(DOCUMENT, type === null ? {} : { "content-type": type }));
    const outcome = await fetchFrom(url("/typed.json"));
    expect(outcome).toMatchObject({ status: "invalid", reason: "content-type" });
    expect(outcome.status === "invalid" && outcome.errors[0]).toMatch(type === null ? /no content type/ : new RegExp(`content type ${type!.split(";")[0]!.replace("/", "\\/")}`));
  });

  it("a fourth redirect, without following it", async () => {
    server.route("/r1", redirect(url("/r2")));
    server.route("/r2", redirect(url("/r3")));
    server.route("/r3", redirect(url("/r4")));
    server.route("/r4", redirect(url("/doc.json")));
    server.route("/doc.json", answer(DOCUMENT));
    expect(await fetchFrom(url("/r1"))).toMatchObject({ status: "unreachable", reason: "redirects", errors: ["more than 3 redirects"] });
    expect(server.requests).toEqual(["/r1", "/r2", "/r3", "/r4"]);
  });

  it("a redirect to http:, without following it", async () => {
    server.route("/r1", redirect(url("/doc.json").replace("https:", "http:")));
    expect(await fetchFrom(url("/r1"))).toMatchObject({ status: "unreachable", reason: "redirect-not-https" });
    expect(server.requests).toEqual(["/r1"]);
  });

  it("a redirect with no Location", async () => {
    server.route("/r1", (_req, res) => res.writeHead(302).end());
    expect(await fetchFrom(url("/r1"))).toMatchObject({ status: "unreachable", reason: "http-status" });
  });

  it("a reply that starts after 5 seconds", async () => {
    server.route("/slow.json", (_req, res) => void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(DOCUMENT), 5_500));
    const started = Date.now();
    expect(await fetchFrom(url("/slow.json"))).toMatchObject({ status: "unreachable", reason: "timeout", errors: ["no answer within 5 s"] });
    expect(Date.now() - started).toBeLessThan(5_400);
  }, 15_000);

  it("a reply whose body is still arriving after 5 seconds", async () => {
    server.route("/trickle.json", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(DOCUMENT.slice(0, 10));
      setTimeout(() => res.end(DOCUMENT.slice(10)), 5_500);
    });
    expect(await fetchFrom(url("/trickle.json"))).toMatchObject({ status: "unreachable", reason: "timeout" });
  }, 15_000);

  it("an HTTP error, as unreachable", async () => {
    expect(await fetchFrom(url("/missing.json"))).toMatchObject({ status: "unreachable", reason: "http-status", errors: ["HTTP 404"] });
  });

  it("a body that is not JSON, as invalid", async () => {
    server.route("/text.json", answer("hello", { "content-type": "text/plain" }));
    expect(await fetchFrom(url("/text.json"))).toMatchObject({ status: "invalid", reason: "not-json" });
  });

  it("a JSON document that is not strategy metadata, as invalid with Pipeline's validator's errors", async () => {
    const body = JSON.stringify({ schema: "pipeline-strategy-metadata/1", name: "x".repeat(65) });
    server.route("/bad.json", answer(body));
    const outcome = await fetchFrom(url("/bad.json"));
    expect(outcome).toMatchObject({ status: "invalid", reason: "invalid", errors: ["name: must be at most 64 characters"], sha256: createHash("sha256").update(body).digest("hex") });
  });
});

describe("URLs inside the document", () => {
  it("are never fetched", async () => {
    const inside = (path: string) => url(`/inside/${path}`);
    const body = JSON.stringify({
      schema: "pipeline-strategy-metadata/1",
      name: "Links Everywhere",
      description: `See ${inside("description")}`,
      image: inside("image.png"),
      links: { website: inside("website"), docs: inside("docs"), idl: inside("idl.json"), github: inside("github") },
      source: { repository: inside("repo") },
      conformance: { report: inside("report.json") },
      security: { contact: "a@example.com", policy: inside("policy"), audits: [{ by: "Someone", url: inside("audit") }] },
    });
    server.route("/links.json", answer(body));
    expect((await fetchFrom(url("/links.json"))).status).toBe("valid");
    expect(server.requests).toEqual(["/links.json"]);
  });
});
