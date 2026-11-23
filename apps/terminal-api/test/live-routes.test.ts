// The live rooms' addresses (docs/spec/pipescope-architecture.md, Live rooms): a browser opens a
// WebSocket on the feed's room or a market's, and the Worker hands the upgrade to that room, named.
import { describe, expect, it } from "vitest";
import type { ApiError } from "../src/contract";
import type { Bindings } from "../src/env";
import { app } from "../src/index";
import { ROOM_HEADER } from "../src/roomCore";
import { bindings, executionContext } from "./fakes";

const MARKET = "C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w";

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

async function open(path: string, upgrade = true) {
  const { handed, namespace } = rooms();
  const env = bindings({ databaseUrl: "postgres://never", rpcUrl: "http://127.0.0.1:9/never-called", LIVE_ROOMS: namespace });
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
});
