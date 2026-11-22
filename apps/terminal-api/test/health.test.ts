import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Health } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext, fakeRpc } from "./fakes";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.drop();
});

async function health(env: ReturnType<typeof bindings>) {
  const { ctx, settle } = executionContext();
  const response = await app.request("/health", {}, env, ctx);
  await settle();
  return { status: response.status, text: await response.text() };
}

describe("GET /health", () => {
  it("reports the database reachable through Hyperdrive, the cluster's slot through RPC_URL, and the Worker's version", async () => {
    const rpc = await fakeRpc({ slot: 525_142_117 });
    try {
      const { status, text } = await health(bindings({ databaseUrl: database.url, rpcUrl: rpc.url }));
      expect(status).toBe(200);
      const body = Health.parse(JSON.parse(text));
      expect(body).toMatchObject({
        ok: true,
        cluster: "devnet",
        database: { ok: true, migrations: 1, error: null },
        rpc: { ok: true, slot: 525_142_117, error: null },
        version: { id: "7f0c1a5e-0000-4000-8000-000000000001", timestamp: "2026-11-22T10:00:00.000Z" },
      });
    } finally {
      await rpc.close();
    }
  });

  it("is 503, naming the part that failed, when the RPC does not answer, and never shows the RPC's URL", async () => {
    const rpc = await fakeRpc({ status: 503 });
    try {
      const { status, text } = await health(bindings({ databaseUrl: database.url, rpcUrl: rpc.url }));
      expect(status).toBe(503);
      expect(JSON.parse(text)).toMatchObject({ ok: false, database: { ok: true }, rpc: { ok: false, slot: null, error: "the RPC did not answer" } });
      expect(text).not.toContain("secret-in-the-url");
      expect(text).not.toContain("127.0.0.1");
    } finally {
      await rpc.close();
    }
  });

  it("is 503 when the database does not answer, and never shows its connection string", async () => {
    const rpc = await fakeRpc({ slot: 1 });
    try {
      const unreachable = "postgres://terminal:hunter2@127.0.0.1:1/nowhere";
      const { status, text } = await health(bindings({ databaseUrl: unreachable, rpcUrl: rpc.url }));
      expect(status).toBe(503);
      expect(JSON.parse(text)).toMatchObject({ ok: false, database: { ok: false, migrations: null, error: "the database did not answer" }, rpc: { ok: true } });
      expect(text).not.toContain("hunter2");
    } finally {
      await rpc.close();
    }
  });
});
