// The buy wall AMM's reading of a market (docs/spec/pool4-for-solana.md, Aviary's panel; #57): every
// value from the market state at the offsets the spec's table gives, never from vault balances or
// events, and what the panel and the explainer derive from them.
import { readFileSync } from "node:fs";
import { getAddressEncoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { BUY_WALL_RISKS, buyWallFacts, readBuyWallState, readBuyWall, type BuyWallState } from "../src/products/buyWall";

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

describe("the explainer's facts of a buy wall market", () => {
  const facts = buyWallFacts({ state: bytesOf(DEMO.market_state.data), mint: bytesOf(DEMO.token_mint.data), slot: 525_833_592, now: 1_795_228_910n });
  const value = (label: string) => facts.find((f) => f.label === label)?.value;

  it("carries what the panel shows, each read from the market state at one slot", () => {
    expect(facts.map((f) => f.label)).toEqual(["Price", "Buy wall", "Inventory cap", "Retired, owed and burned tokens", "Fee and its split", "Fee ledgers", "Parameters", "Recipients"]);
    for (const f of facts) expect(f).toMatchObject({ group: "Buy wall AMM", source: "the sampled market's state, read at slot 525833592" });
    expect(value("Price")).toBe("0.00000890267 SOL per token.");
    expect(value("Buy wall")).toBe("Placed, its top at 0.00000890267 SOL per token. It holds 1.781987355 SOL and has bought 0 tokens, spending 0 SOL, since it was placed. Its floor is 0.00000890267 SOL per token. 0 SOL is idle, waiting to be placed as the wall.");
    expect(value("Inventory cap")).toBe("864268.710755 tokens, against 864268.710744 tokens the curve holds. The cap floor is 200000 tokens (20% of the 1000000 tokens seeded); the cap decay is 200000 tokens a day (20% of the tokens seeded); 51479.358903 tokens of cap decay allowance are built up.");
    expect(value("Retired, owed and burned tokens")).toBe("0 tokens retired, waiting to be burned or kept for rewards; 0 tokens of rewards owed; 175371.59587 tokens burned so far, 13.49% of the supply before these burns.");
    expect(value("Fee and its split")).toBe("1% of every swap, taken in SOL on top of Pipeline's fee: 10% of it is the designer share for IMD and Adam, 10% the suite share, and the rest is the market's, 50% of it to the buy wall and 50% to the fee recipient.");
    expect(value("Fee ledgers")).toBe("Fee recipient: 0 SOL. Designer share: 0.012506103 SOL, waiting in the market, since its wallet is not set yet. Suite share: 0 SOL, paid to CbqE9TtDJf67xFnXybBrzV6Tg4Mw71hX2VhWcm4R9VZF.");
    expect(value("Parameters")).toBe("Fee 100 bps, buy wall split 5000 bps, reward share 1500 bps, cap floor 2000 bps and cap decay 2000 bps a day, none of which can change. 1000000 tokens seeded by 9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt; created 2026-11-20 04:13 UTC, seeded 2026-11-20 04:13 UTC.");
    expect(value("Recipients")).toBe("Fee recipient: 4Q3DcWHTGaN6d6vVdTUxW4KEsD5iZky5wtgxNzf3bUzu. Rewards recipient: 7GDwQsJpPZTR6CwgPZkuHQakhziAs1xRoYzdrmQyibjd. Each may hand its own role to another wallet; nobody else can change either.");
  });

  it("names the three risks of every buy wall market", () => {
    expect(BUY_WALL_RISKS.map((r) => r.label)).toEqual(["Risk: the curve thins as the cap falls", "Risk: the buy wall can sit well below the price", "Risk: the rewards recipient can trade the cap down"]);
    expect(BUY_WALL_RISKS.map((r) => r.value).join(" ")).toMatch(/about 4% a day/);
  });
});
