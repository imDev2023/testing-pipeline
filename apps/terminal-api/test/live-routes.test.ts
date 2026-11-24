// The live rooms' addresses (docs/spec/pipescope-architecture.md, Live rooms): a browser opens a
// WebSocket on the feed's room or a market's, and the Worker hands the upgrade to that room, named.
import { readFileSync } from "node:fs";
import { createDb } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { indexTransactions, pipelineHandler, type RawTransaction } from "terminal-indexer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiError } from "../src/contract";
import type { Bindings } from "../src/env";
import { app } from "../src/index";
import { ROOM_HEADER } from "../src/roomCore";
import { bindings, executionContext } from "./fakes";

const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/../../../packages/terminal-indexer/test/fixtures/${name}.json`, "utf8")) as RawTransaction;
/** The market the fixtures create; another address is a well-formed one that is no market. */
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const NOT_A_MARKET = "C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
  const { db, close } = createDb(database.url);
  await indexTransactions(db, pipelineHandler({ candleSeconds: [] }), ["registered", "marketCreated"].map(fixture));
  await close();
});
afterAll(async () => {
  await database?.drop();
});

/** The rooms' namespace, recording which room each upgrade went to and under what name. */
function rooms() {
  const handed: { id: string; name: string | null }[] = [];
  const namespace = {
    idFromName: (name: string) => ({ toString: () => `id:${name}` }),
    get: (id: { toString(): string }) => ({
      fetch: async (request: Request) => {
        handed.push({ id: id.toString(), name: request.headers.get(ROOM_HEADER) });
        return new Response("joined", { status: 200 });
      },
    }),
  };
  return { handed, namespace: namespace as unknown as Bindings["LIVE_ROOMS"] };
}

/** A database no client can reach: nothing listens on port 9. */
const UNREACHABLE = "postgres://terminal:terminal@127.0.0.1:9/terminal";

async function open(path: string, upgrade = true, databaseUrl = database.url) {
  const { handed, namespace } = rooms();
  const env = bindings({ databaseUrl, rpcUrl: "http://127.0.0.1:9/never-called", LIVE_ROOMS: namespace });
  const { ctx, settle } = executionContext();
  const response = await app.request(path, { headers: upgrade ? { upgrade: "websocket" } : {} }, env, ctx);
  await settle();
  return { response, handed };
}

describe("the live rooms' addresses", () => {
  it("hand a market page's WebSocket to that market's room, and the feed's to the feed's", async () => {
    expect((await open(`/v1/live/markets/${MARKET}`)).handed).toEqual([{ id: `id:market:${MARKET}`, name: `market:${MARKET}` }]);
    expect((await open("/v1/live/feed")).handed).toEqual([{ id: "id:feed", name: "feed" }]);
  });

  it("refuse a request that is not a WebSocket upgrade, and an address that is none", async () => {
    const plain = await open("/v1/live/feed", false);
    expect(plain.response.status).toBe(426);
    expect(((await plain.response.json()) as ApiError).error).toBe("A live room is a WebSocket: open it with an upgrade.");
    const bad = await open("/v1/live/markets/not-an-address");
    expect(bad.response.status).toBe(400);
    expect(bad.handed).toEqual([]);
  });

  it("refuse a well-formed address that is no market Aviary knows, so no room is opened for it (#214)", async () => {
    const { response, handed } = await open(`/v1/live/markets/${NOT_A_MARKET}`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiError).error).toBe("Aviary knows no market at this address.");
    expect(handed).toEqual([]);
  });

  it("answer a request that is no upgrade without reading the database, and still join a room when the database cannot be read (#214)", async () => {
    const plain = await open(`/v1/live/markets/${MARKET}`, false, UNREACHABLE);
    expect(plain.response.status).toBe(426);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Live updates need no database: a viewer reconnecting while it is down still rejoins its room.
    expect((await open(`/v1/live/markets/${MARKET}`, true, UNREACHABLE)).handed).toEqual([{ id: `id:market:${MARKET}`, name: `market:${MARKET}` }]);
    log.mockRestore();
  });
});
