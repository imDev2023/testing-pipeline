// The buy wall AMM's reading of a market (docs/spec/pool4-for-solana.md, Aviary's panel; #57): every
// value from the market state at the offsets the spec's table gives, never from vault balances or
// events, and what the panel and the explainer derive from them.
import { readFileSync } from "node:fs";
import { getAddressEncoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { readBuyWallState, readBuyWall, type BuyWallState } from "../src/products/buyWall";

const SPEC = readFileSync(`${import.meta.dirname}/../../../docs/spec/pool4-for-solana.md`, "utf8");
const DEMO = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/buy-wall-demo-market.json`, "utf8")) as { market_state: { data: string }; token_mint: { data: string } };
const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

/** The spec's "Byte offsets" table, as its rows say: field, offset, size and type. */
function specRows(): { field: string; offset: number; size: number; type: string }[] {
  const section = SPEC.slice(SPEC.indexOf("### Byte offsets"), SPEC.indexOf("### A release gate"));
  return [...section.matchAll(/^\| `([^`]+)` \| (\d+) \| (\d+) \| (\w+) \|$/gm)].map(([, field, offset, size, type]) => ({ field: field!, offset: Number(offset), size: Number(size), type: type! }));
}

/** The state's own name for a spec field: `volume[0]` is `volume0`, `fee_bps` is `feeBps`. */
const keyOf = (field: string) => field.replace(/\[(\d)\]/, "$1").replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe("reading a buy wall market state", () => {
  it("reads every field of the spec's table at its offset", () => {
    const rows = specRows().filter((r) => r.field !== "discriminator" && r.field !== "reserve");
    expect(rows.length).toBe(59);
    for (const row of rows) {
      // A market state holding only the discriminator and, at this one field, bytes that read as a value of its own.
      const bytes = new Uint8Array(1024);
      bytes.set(new TextEncoder().encode("BWMARKET"));
      const marker = Uint8Array.from({ length: row.size }, (_, i) => (row.offset + i * 7 + 1) % 251 || 1);
      bytes.set(marker, row.offset);
      const state = readBuyWallState(bytes) as Record<string, unknown> | null;
      // The state holds the spec's fields and nothing else.
      expect(Object.keys(state ?? {}).sort()).toEqual(rows.map((r) => keyOf(r.field)).sort());
      expect(state, row.field).not.toBeNull();
      const read = state![keyOf(row.field)];
      if (row.type === "pubkey") {
        expect(Buffer.from(getAddressEncoder().encode(read as Address)), row.field).toEqual(Buffer.from(marker));
      } else {
        const expected = marker.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
        expect(BigInt(read as bigint | number), row.field).toBe(row.type === "i64" && expected >= 1n << 63n ? expected - (1n << 64n) : expected);
      }
    }
  });

  it("refuses an account that is not a buy wall market state", () => {
    expect(readBuyWallState(new Uint8Array(1024))).toBeNull();
    expect(readBuyWallState(bytesOf(DEMO.token_mint.data))).toBeNull();
    expect(readBuyWallState(bytesOf(DEMO.market_state.data).subarray(0, 1000))).toBeNull();
  });

  it("reads the devnet demo market as the chain holds it", () => {
    const state = readBuyWallState(bytesOf(DEMO.market_state.data))!;
    expect(state.status).toBe(2);
    expect(state.tokenMint).toBe("9qTA6qhsFwpvDvqMmiQifnQK53ijsoFXYLpH2fJembd7");
    expect(state.feeBps).toBe(100n);
    expect(state.wallSplitBps).toBe(5000n);
    expect(state.rewardShareBps).toBe(1500n);
    expect(state.seededTokens).toBe(1_000_000_000_000n);
    expect(state.cap).toBe(864_268_710_755n);
    expect(state.feesDesigner).toBe(12_506_103n);
    expect(state.tokensBurned).toBe(175_371_595_870n);
    expect(state.swapCount).toBe(14n);
  });
});

describe("what the panel and the explainer read of a buy wall market", () => {
  const demo = readBuyWallState(bytesOf(DEMO.market_state.data))!;
  const supply = 1_124_628_404_130n;

  it("reads the wall's SOL, what it spent and the tokens it bought since placed, as the spec's worked example has them", () => {
    // The worked example's last row: after a sell of 20,000,000,000 units the wall has spent 1,770,941 lamports on 180,633,508 units.
    const state: BuyWallState = { ...demo, sqrtPrice: 1_808_529_293_214_755_428n, wallTop: 1_844_674_407_370_955_161n, wallLiquidity: 903_804_010n, wallSolPlaced: 90_380_400n };
    const { wall } = readBuyWall(state, { supply, now: 0n });
    expect(wall).toMatchObject({ placed: true, top: 1_844_674_407_370_955_161n, spent: 1_770_941n, sol: 90_380_400n - 1_770_941n, bought: 180_633_508n });
  });

  it("reads the demo market's wall, sitting just below the price, as having bought nothing", () => {
    const { wall, price } = readBuyWall(demo, { supply, now: demo.decayTime });
    expect(price).toBe(1_740_523_098_879_072_683n);
    expect(wall).toMatchObject({ placed: true, sol: 1_781_987_355n, spent: 0n, bought: 0n, floor: 1_740_523_098_879_072_683n });
  });

  it("reads a market with no wall placed as holding no wall", () => {
    const { wall } = readBuyWall({ ...demo, wallLiquidity: 0n, wallTop: 0n, wallSolPlaced: 0n }, { supply, now: 0n });
    expect(wall).toMatchObject({ placed: false, sol: 0n, spent: 0n, bought: 0n });
  });

  it("reads the cap against what the curve holds, and the allowance built up by now, at most one day's", () => {
    const at = (now: bigint) => readBuyWall(demo, { supply, now }).cap;
    expect(at(demo.decayTime)).toEqual({ cap: 864_268_710_755n, held: 864_268_710_744n, floor: 200_000_000_000n, decayPerDay: 200_000_000_000n, allowance: 51_479_358_903n });
    expect(at(demo.decayTime + 3_600n).allowance).toBe(59_812_692_236n);
    expect(at(demo.decayTime + 10n * 86_400n).allowance).toBe(200_000_000_000n);
    // A clock behind the stored time adds nothing.
    expect(at(demo.decayTime - 600n).allowance).toBe(51_479_358_903n);
  });

  it("reads the tokens burned as a share of the supply before those burns, in millionths", () => {
    const { tokens } = readBuyWall(demo, { supply, now: 0n });
    expect(tokens).toEqual({ retired: 0n, rewardsOwed: 0n, burned: 175_371_595_870n, burnedPpm: 134_901 });
  });

  it("splits the fee as the program does, and says the designer share waits while it has no wallet", () => {
    const { fee } = readBuyWall(demo, { supply, now: 0n });
    expect(fee).toEqual({
      bps: 100n,
      designerBps: 1000,
      suiteBps: 1000,
      wallSplitBps: 5000n,
      ledgers: { recipient: 0n, designer: 12_506_103n, suite: 0n },
      designerWallet: null,
      suiteWallet: "CbqE9TtDJf67xFnXybBrzV6Tg4Mw71hX2VhWcm4R9VZF",
    });
  });

  it("names a recipient left unset at creation as none", () => {
    const { recipients } = readBuyWall({ ...demo, rewardsRecipient: "11111111111111111111111111111111" as BuyWallState["rewardsRecipient"] }, { supply, now: 0n });
    expect(recipients).toEqual({ fee: demo.feeRecipient, rewards: null });
  });
});
