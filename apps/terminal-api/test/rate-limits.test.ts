import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/contract";
import { RATE_LIMIT_PERIOD_SECONDS } from "../src/config";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const env = () => bindings({ databaseUrl: "postgres://unused@127.0.0.1:1/unused", rpcUrl: "http://127.0.0.1:1/" });

async function read(e: ReturnType<typeof env>, ip: string) {
  const { ctx } = executionContext();
  return app.request("/an-unknown-read", { headers: { "cf-connecting-ip": ip } }, e, ctx);
}

describe("the public API's rate limits (PIPESCOPE-90)", () => {
  it("refuses the 301st read in a minute from one IP with a 429 that names the wait", async () => {
    const e = env();
    for (let i = 1; i <= 300; i++) expect((await read(e, "203.0.113.7")).status).not.toBe(429);
    const refused = await read(e, "203.0.113.7");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    const body = ApiError.parse(await refused.json());
    expect(body).toEqual({ error: "Too many requests from your address. Try again in 60 seconds.", retryAfterSeconds: 60 });
  });

  it("counts each IP on its own", async () => {
    const e = env();
    for (let i = 1; i <= 301; i++) await read(e, "203.0.113.7");
    expect((await read(e, "198.51.100.2")).status).not.toBe(429);
  });

  it("tells a refused browser the wait across origins too", async () => {
    const e = env();
    for (let i = 1; i <= 300; i++) await read(e, "203.0.113.7");
    const { ctx } = executionContext();
    const refused = await app.request("/health", { headers: { "cf-connecting-ip": "203.0.113.7", origin: "https://example.com" } }, e, ctx);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");
    expect(refused.headers.get("access-control-expose-headers")).toContain("Retry-After");
  });

  it("waits exactly the period of every rate-limiting binding in wrangler.jsonc, where the limits live", () => {
    const config = parse(readFileSync(`${import.meta.dirname}/../wrangler.jsonc`, "utf8")) as {
      ratelimits: { name: string; simple: { limit: number; period: number } }[];
    };
    expect(Object.fromEntries(config.ratelimits.map((r) => [r.name, r.simple]))).toEqual({
      READS: { limit: 300, period: RATE_LIMIT_PERIOD_SECONDS },
      TRADES: { limit: 60, period: RATE_LIMIT_PERIOD_SECONDS },
      REPORTS: { limit: 10, period: RATE_LIMIT_PERIOD_SECONDS },
    });
  });
});

describe("CORS (PIPESCOPE-32)", () => {
  it("lets any origin read, with no credentials", async () => {
    const { ctx } = executionContext();
    const response = await app.request("/an-unknown-read", { headers: { origin: "https://someone-elses.app", "cf-connecting-ip": "192.0.2.1" } }, env(), ctx);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
