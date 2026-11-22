// terminal-api on the local run: /health, the public read limit and CORS.
import { randomInt } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Health } from "terminal-api/contract";
import { API } from "./target";

test("/health reports the database reachable, devnet's slot through RPC_URL and the Worker's version", async ({ request }) => {
  const response = await request.get(`${API}/health`);
  expect(response.status()).toBe(200);
  const health = Health.parse(await response.json());
  expect(health).toMatchObject({ ok: true, cluster: "devnet", database: { ok: true, error: null }, rpc: { ok: true, error: null } });
  expect(health.database.migrations).toBeGreaterThanOrEqual(1);
  expect(health.rpc.slot).toBeGreaterThan(500_000_000);
  expect(health.version.id).not.toBe("");
});

test("the 301st read in a minute from one IP gets a 429 that names the wait", async ({ request }) => {
  test.setTimeout(120_000);
  // A client address of its own, so earlier reads from this machine never count against it.
  const ip = `198.18.${randomInt(256)}.${randomInt(1, 255)}`;
  // `wrangler dev`'s limiter counts in windows that start on each wall-clock minute, so the 301 reads
  // must fall inside one: start at the top of a minute unless enough of this one is left.
  const intoMinute = Date.now() % 60_000;
  if (intoMinute > 30_000) await new Promise((done) => setTimeout(done, 60_000 - intoMinute + 250));
  for (let i = 1; i <= 300; i++) {
    const response = await request.get(`${API}/no-such-read`, { headers: { "cf-connecting-ip": ip } });
    expect(response.status(), `read ${i}`).toBe(404);
  }
  const refused = await request.get(`${API}/no-such-read`, { headers: { "cf-connecting-ip": ip } });
  expect(refused.status()).toBe(429);
  expect(refused.headers()["retry-after"]).toBe("60");
  expect(await refused.json()).toEqual({ error: "Too many requests from your address. Try again in 60 seconds.", retryAfterSeconds: 60 });
});

test("any origin may read", async ({ request }) => {
  const response = await request.get(`${API}/health`, { headers: { origin: "https://someone-elses.app" } });
  expect(response.headers()["access-control-allow-origin"]).toBe("*");
});
