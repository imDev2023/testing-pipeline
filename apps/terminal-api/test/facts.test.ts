// The facts and the feed's filters in the API (docs/spec/pipescope.md, "Listing" and "Facts and Canary
// results"; docs/spec/pipescope-screens.md, Feed "Filters" and "Explanation, actions and facts"):
// strategies with their names from valid metadata, metadata status, trust flags and who can upgrade
// them; markets with their flags (their strategy's and every mint's, as Pipeline's SDK unites them);
// the four filters with the counts the line under them needs; and a market's facts panel.
import { address, getAddressEncoder } from "@solana/kit";
import { FLAG_DESCRIPTIONS, decodeMint } from "@pipeline-sol/sdk";
import { createDb, marketMints, markets, metadataSnapshots, mints, programFacts, programVersions, strategies, trades } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarketFacts, MarketsPage, StrategiesList, StrategyDetail, type ApiError, type Market } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const AUTHORITY = "Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe";
const CREATOR = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";

// Four strategies: valid metadata, a link that does not answer, an invalid document, and one not fetched yet.
const [A, B, C, D] = ["J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t", "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6", "Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG", "9jd6k8HQkcU2jxe2AcTZVLDGccbo3S8Py6e6E6Aee7QP"] as const;
// Three markets: A's with a SOL side and a hooked-fee token, B's with no SOL side, C's with a little SOL.
const [M1, M2, M3] = ["C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w", "4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD", "ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb"] as const;
const [T1, T2, T3, T4] = ["4gqiCkoxxD72nbXGc7XtxQx4UjBHD3KiJyXpMvEZ6u8c", "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDV", "2TmcmquxnCB8AHoLmLJFYxZnVQdm9pREMEsmHqByQq7G"] as const;

const bytesOf = (a: string) => getAddressEncoder().encode(address(a));

/** A mint's 82 bytes: its authorities as `COption`s, its supply and decimals. */
function mintBase({ supply, decimals, mintAuthority = null, freezeAuthority = null }: { supply: bigint; decimals: number; mintAuthority?: string | null; freezeAuthority?: string | null }): Uint8Array {
  const data = new Uint8Array(82);
  const view = new DataView(data.buffer);
  if (mintAuthority) {
    view.setUint32(0, 1, true);
    data.set(bytesOf(mintAuthority), 4);
  }
  view.setBigUint64(36, supply, true);
  data[44] = decimals;
  data[45] = 1;
  if (freezeAuthority) {
    view.setUint32(46, 1, true);
    data.set(bytesOf(freezeAuthority), 50);
  }
  return data;
}

/** A Token-2022 mint with a `TransferFeeConfig`: 1% of each transfer, at most 5,000,000, set by AUTHORITY. */
function transferFeeMint(base: Uint8Array): Uint8Array {
  const data = new Uint8Array(165 + 1 + 4 + 108);
  data.set(base, 0);
  data[165] = 1; // AccountType::Mint
  const view = new DataView(data.buffer);
  view.setUint16(166, 1, true); // ExtensionType::TransferFeeConfig
  view.setUint16(168, 108, true);
  data.set(bytesOf(AUTHORITY), 170);
  data.set(bytesOf(AUTHORITY), 202);
  for (const at of [242, 260]) {
    view.setBigUint64(at, 0n, true);
    view.setBigUint64(at + 8, 5_000_000n, true);
    view.setUint16(at + 16, 100, true);
  }
  return data;
}

const now = Date.now();
const ago = (ms: number) => new Date(now - ms);
const HOUR = 3_600_000;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let env: ReturnType<typeof bindings>;
beforeAll(async () => {
  database = await createTestDatabase();
  env = bindings({ databaseUrl: database.url, rpcUrl: "http://127.0.0.1:9/never-called" });
  const { db, close } = createDb(database.url);
  try {
    await db.insert(strategies).values([
      { program: A, metadataUri: "https://example.org/a.json", feePaid: "10000000", registeredAt: ago(72 * HOUR) },
      { program: B, metadataUri: "https://example.org/b.json", feePaid: "10000000", registeredAt: ago(71 * HOUR) },
      { program: C, metadataUri: "https://example.org/c.json", feePaid: "10000000", registeredAt: ago(70 * HOUR) },
      { program: D, metadataUri: "https://example.org/d.json", feePaid: "10000000", registeredAt: ago(69 * HOUR) },
    ]);
    const at = ago(HOUR);
    await db.insert(metadataSnapshots).values([
      // An older outcome of A's, which the newest one replaces.
      { program: A, uri: "https://example.org/a.json", status: "unreachable", reason: "http-status", errors: ["HTTP 404"], warnings: [], fetchedAt: ago(5 * HOUR), checkedAt: ago(5 * HOUR) },
      {
        program: A,
        uri: "https://example.org/a.json",
        status: "valid",
        errors: [],
        warnings: [],
        url: "https://example.org/a.json",
        sha256: "ab".repeat(32),
        document: { schema: "pipeline-strategy-metadata/1", name: "Tax‮ AMM" },
        normalised: { name: "Tax AMM", description: "Taxes each trade.", category: null, tags: [], init: null, audits: [] },
        removed: { characters: 1, truncated: [], images: 0, links: 0 },
        fetchedAt: at,
        checkedAt: at,
      },
      { program: B, uri: "https://example.org/b.json", status: "unreachable", reason: "http-status", errors: ["HTTP 404"], warnings: [], url: "https://example.org/b.json", fetchedAt: at, checkedAt: at },
      { program: C, uri: "https://example.org/c.json", status: "invalid", reason: "invalid", errors: ["name: must be at most 64 characters"], warnings: [], url: "https://example.org/c.json", sha256: "cd".repeat(32), fetchedAt: at, checkedAt: at },
    ]);
    await db.insert(programFacts).values([
      { program: A, upgradeAuthority: AUTHORITY, flags: ["upgradeable"] },
      { program: B, upgradeAuthority: null, flags: ["frozen"] },
    ]);
    await db.insert(programVersions).values([
      { program: A, deploySlot: 500n, role: "strategy", executableSha256: "11".repeat(32), blockTime: ago(60 * HOUR) },
      { program: A, deploySlot: 900n, role: "strategy", executableSha256: "22".repeat(32), signature: "upgrade-sig", blockTime: ago(10 * HOUR) },
    ]);
    await db.insert(markets).values([
      // Two hours old, clear of the last hour: the API floors its clock to whole seconds, so a market
      // made exactly an hour before this module's clock can still count as within the hour.
      { address: M1, strategyProgram: A, marketState: T4, createdBy: CREATOR, createdAt: ago(2 * HOUR), feeMint: WSOL, supportsExactOut: false },
      { address: M2, strategyProgram: B, marketState: T4, createdBy: CREATOR, createdAt: ago(48 * HOUR) },
      { address: M3, strategyProgram: C, marketState: T4, createdBy: CREATOR, createdAt: ago(HOUR / 2) },
    ]);
    await db.insert(marketMints).values([
      { market: M1, position: 0, mint: T1, vault: T3, vaultAmount: "250000000" },
      { market: M1, position: 1, mint: WSOL, vault: T2, vaultAmount: "2000000000" },
      { market: M2, position: 0, mint: T2, vault: T3, vaultAmount: "100" },
      { market: M2, position: 1, mint: T3, vault: T1, vaultAmount: "200" },
      { market: M3, position: 0, mint: T4, vault: T1, vaultAmount: "1000" },
      { market: M3, position: 1, mint: WSOL, vault: T2, vaultAmount: "50000000" },
    ]);
    const t1 = transferFeeMint(mintBase({ supply: 1_000_000_000n, decimals: 6, mintAuthority: AUTHORITY }));
    const mint = (address_: string, tokenProgram: string, data: Uint8Array) => {
      const decoded = decodeMint(address(address_), address(tokenProgram), data, 800n)!;
      return { address: address_, readable: true, tokenProgram, decimals: decoded.decimals, supply: String(decoded.supply), mintAuthority: decoded.mintAuthority, freezeAuthority: decoded.freezeAuthority, data: Buffer.from(data).toString("base64"), flags: decoded.flags, readEpoch: 800n, readSlot: 525_000_000n };
    };
    await db.insert(mints).values([
      mint(T1, TOKEN_2022, t1),
      mint(WSOL, TOKEN_PROGRAM, mintBase({ supply: 0n, decimals: 9 })),
      mint(T2, TOKEN_PROGRAM, mintBase({ supply: 1000n, decimals: 0, freezeAuthority: AUTHORITY })),
      mint(T3, TOKEN_PROGRAM, mintBase({ supply: 1000n, decimals: 0 })),
      mint(T4, TOKEN_PROGRAM, mintBase({ supply: 1000n, decimals: 0, mintAuthority: AUTHORITY })),
    ]);
    // M1's last 24 hours: 0.6 SOL in, then 0.3 SOL out; an older trade does not count.
    const trade = (signature: string, input: string, output: string, netSent: string, received: string, at: number) => ({
      signature, eventIndex: 0, slot: 1n, market: M1, strategy: A, trader: CREATOR, inputMint: input, outputMint: output, mode: 0, netSent, received, pipelineFee: "0", feeMint: WSOL, integratorFee: "0", unixTimestamp: BigInt(Math.floor(at / 1000)),
    });
    await db.insert(trades).values([
      trade("t-buy", WSOL, T1, "600000000", "1000", now - HOUR),
      trade("t-sell", T1, WSOL, "500", "300000000", now - HOUR / 2),
      trade("t-old", WSOL, T1, "9000000000", "1000", now - 30 * HOUR),
    ]);
  } finally {
    await close();
  }
});
afterAll(async () => {
  await database?.drop();
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const { ctx, settle } = executionContext();
  const response = await app.request(path, {}, env, ctx);
  await settle();
  return { status: response.status, body: await response.json() };
}
const page = async (query = "") => MarketsPage.parse((await get(`/v1/markets${query}`)).body);
const addresses = (markets: Market[]) => markets.map((m) => m.address);
const facts = (...flags: string[]) => flags.map((flag) => ({ flag, description: FLAG_DESCRIPTIONS[flag as keyof typeof FLAG_DESCRIPTIONS] }));

describe("strategies", () => {
  it("carry their name from valid metadata, their metadata's status, flags, upgrade authority and current version", async () => {
    const { strategies: list, flags_present } = StrategiesList.parse((await get("/v1/strategies")).body);
    const of = (program: string) => list.find((s) => s.program === program)!;
    expect(of(A)).toMatchObject({
      name: "Tax AMM",
      description: "Taxes each trade.",
      metadata: { status: "valid", uri: "https://example.org/a.json", sha256: "ab".repeat(32), errors: [], removed: { characters: 1 } },
      flags: ["upgradeable"],
      upgrade_authority: AUTHORITY,
      current_version: { deploy_slot: 900, executable_sha256: "22".repeat(32) },
      verified_build: null,
    });
    expect(of(B)).toMatchObject({ name: null, metadata: { status: "unreachable", errors: ["HTTP 404"] }, flags: ["frozen", "metadata-unreachable"], upgrade_authority: null, current_version: null });
    expect(of(C)).toMatchObject({ name: null, metadata: { status: "invalid", errors: ["name: must be at most 64 characters"] }, flags: ["metadata-invalid"] });
    expect(of(D)).toMatchObject({ name: null, metadata: { status: "not-fetched", uri: "https://example.org/d.json", errors: [] }, flags: [] });
    expect(flags_present).toEqual(facts("upgradeable", "frozen", "metadata-unreachable", "metadata-invalid"));
  });

  it("one strategy carries each of its flags with Pipeline's fixed description", async () => {
    const strategy = StrategyDetail.parse((await get(`/v1/strategies/${B}`)).body);
    expect(strategy.flag_facts).toEqual(facts("frozen", "metadata-unreachable"));
  });
});

describe("markets", () => {
  it("carry their strategy's name and every flag of their strategy and mints, in Pipeline's order", async () => {
    const { markets: list } = await page();
    const of = (address_: string) => list.find((m) => m.address === address_)!;
    expect(of(M1)).toMatchObject({ strategy_name: "Tax AMM", strategy_metadata: "valid", flags: ["upgradeable", "token-2022", "mint-authority", "transfer-fee", "transfer-fee-authority"] });
    expect(of(M1).mints.map((m) => m.flags)).toEqual([["token-2022", "mint-authority", "transfer-fee", "transfer-fee-authority"], []]);
    expect(of(M2)).toMatchObject({ strategy_name: null, strategy_metadata: "unreachable", flags: ["frozen", "metadata-unreachable", "freeze-authority"] });
    expect(of(M3)).toMatchObject({ strategy_name: null, strategy_metadata: "invalid", flags: ["metadata-invalid", "mint-authority"] });
  });

  it("with no filter on, are all listed, with the flags present and how many have no SOL side", async () => {
    const all = await page();
    expect(addresses(all.markets)).toEqual([M3, M1, M2]);
    expect(all).toMatchObject({ total: 3, matching: 3, no_sol_side: 1 });
    expect(all.flags_present).toEqual(facts("upgradeable", "frozen", "metadata-unreachable", "metadata-invalid", "token-2022", "mint-authority", "freeze-authority", "transfer-fee", "transfer-fee-authority"));
  });
});

describe("the feed's filters", () => {
  it("keep markets with at least that much SOL in their SOL vault, leaving out those with no SOL side", async () => {
    expect(addresses((await page("?min_sol_liquidity=1000000000")).markets)).toEqual([M1]);
    const small = await page("?min_sol_liquidity=10000000");
    expect(addresses(small.markets)).toEqual([M3, M1]);
    expect(small).toMatchObject({ total: 3, matching: 2, no_sol_side: 1 });
  });

  it("keep markets with at least that much SOL traded in the last 24 hours, counting both ways", async () => {
    expect(addresses((await page("?min_sol_volume_24h=900000000")).markets)).toEqual([M1]);
    expect(addresses((await page("?min_sol_volume_24h=900000001")).markets)).toEqual([]);
  });

  it("keep markets created within that many seconds", async () => {
    expect(addresses((await page("?created_within=86400")).markets)).toEqual([M3, M1]);
    expect(addresses((await page("?created_within=3600")).markets)).toEqual([M3]);
  });

  it("hide markets with any of the flags named, the strategy's or a mint's", async () => {
    expect(addresses((await page("?hide=mint-authority")).markets)).toEqual([M2]);
    expect(addresses((await page("?hide=frozen,metadata-invalid")).markets)).toEqual([M1]);
    expect(addresses((await page("?hide=transfer-fee")).markets)).toEqual([M3, M2]);
  });

  it("combine, count what they keep, and page through it", async () => {
    const first = await page("?min_sol_liquidity=10000000&hide=metadata-invalid&limit=1");
    expect(first).toMatchObject({ total: 3, matching: 1 });
    expect(addresses(first.markets)).toEqual([M1]);
    expect(first.next).toBeNull();
    const two = await page("?created_within=86400&limit=1");
    expect(addresses(two.markets)).toEqual([M3]);
    expect(addresses((await page(`?created_within=86400&limit=1&before=${encodeURIComponent(two.next!)}`)).markets)).toEqual([M1]);
  });

  it("count within one strategy's markets when asked for them", async () => {
    expect(await page(`?strategy=${A}&hide=transfer-fee`)).toMatchObject({ total: 1, matching: 0, markets: [] });
  });

  it.each([
    ["?hide=not-a-flag", "hide names Pipeline's trust flags, separated by commas."],
    ["?min_sol_liquidity=-1", "min_sol_liquidity is a whole number of lamports, at most 18446744073709551615."],
    ["?min_sol_volume_24h=0.5", "min_sol_volume_24h is a whole number of lamports, at most 18446744073709551615."],
    ["?created_within=soon", "created_within is a whole number of seconds of at least 1 and at most 3153600000."],
  ])("refuse %s with a sentence that says what it takes", async (query, error) => {
    const { status, body } = await get(`/v1/markets${query}`);
    expect(status).toBe(400);
    expect((body as ApiError).error).toBe(error);
  });
});

describe("GET /v1/markets/{market}/facts", () => {
  it("gives this market, its strategy with its flags described, and each mint's facts in the market's order", async () => {
    const answer = MarketFacts.parse((await get(`/v1/markets/${M1}/facts`)).body);
    expect(answer.market).toMatchObject({ address: M1, stats_24h: { trades: 2, volume_quote: "900000000" } });
    expect(answer.strategy).toMatchObject({ program: A, name: "Tax AMM", upgrade_authority: AUTHORITY, flag_facts: facts("upgradeable") });
    expect(answer.mints).toEqual([
      {
        mint: T1,
        symbol: null,
        token: null,
        readable: true,
        token_program: "Token-2022",
        decimals: 6,
        supply: "1000000000",
        mint_authority: AUTHORITY,
        freeze_authority: null,
        extensions: [{ name: "Transfer fee", detail: "1% of each transfer, at most 5000000 of its smallest units", address: null, authority: AUTHORITY }],
        vault_amount: "250000000",
        vault_share_percent: 25,
        flags: facts("token-2022", "mint-authority", "transfer-fee", "transfer-fee-authority"),
        read_slot: 525_000_000,
      },
      expect.objectContaining({ mint: WSOL, symbol: "SOL", token_program: "Token", extensions: [], vault_amount: "2000000000", vault_share_percent: null, flags: [] }),
    ]);
  });

  it("answers a 404 for an address that is no market", async () => {
    const { status, body } = await get(`/v1/markets/${A}/facts`);
    expect(status).toBe(404);
    expect((body as ApiError).error).toBe("Aviary knows no market created through Pipeline at this address.");
  });
});

describe("a mint's extensions in words", () => {
  it("say a transfer fee whose maximum is u64's largest has no maximum, and name a later fee", async () => {
    const { extensionsInWords } = await import("../src/facts");
    const fee = (epoch: bigint, basisPoints: number, maximumFee: bigint) => ({ epoch, basisPoints, maximumFee });
    const transferFee = { authority: null, withdrawWithheldAuthority: null, withheldAmount: 0n, older: fee(0n, 100, 2n ** 64n - 1n), newer: fee(0n, 100, 2n ** 64n - 1n), current: fee(0n, 100, 2n ** 64n - 1n) };
    expect(extensionsInWords({ transferFee }, [])).toEqual([{ name: "Transfer fee", detail: "1% of each transfer, with no maximum", address: null, authority: null }]);
    const later = { ...transferFee, newer: fee(900n, 250, 10n) };
    expect(extensionsInWords({ transferFee: later }, [])[0]!.detail).toBe("1% of each transfer, with no maximum; from epoch 900, 2.5%, at most 10 of its smallest units");
  });
});

describe("filter values out of range", () => {
  it.each([
    ["?created_within=99999999999999999999", "created_within is a whole number of seconds of at least 1 and at most 3153600000."],
    ["?min_sol_liquidity=18446744073709551616", "min_sol_liquidity is a whole number of lamports, at most 18446744073709551615."],
    ["?min_sol_volume_24h=99999999999999999999999", "min_sol_volume_24h is a whole number of lamports, at most 18446744073709551615."],
  ])("refuse %s with a 400 that says the most", async (query, error) => {
    const { status, body } = await get(`/v1/markets${query}`);
    expect(status).toBe(400);
    expect((body as ApiError).error).toBe(error);
  });

  it("take the largest u64 of lamports, which no market holds", async () => {
    expect(await page("?min_sol_liquidity=18446744073709551615")).toMatchObject({ matching: 0, markets: [] });
    expect(await page("?min_sol_volume_24h=18446744073709551615")).toMatchObject({ matching: 0, markets: [] });
  });
});

describe("a strategy whose metadata URI changed since its newest fetch", () => {
  const E = "EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b";
  const M4 = "7NWjaeqo1Nb6F3krxLdRhbevXQk4KU92XMZME83N3i8J";
  beforeAll(async () => {
    const { db, close } = createDb(database.url);
    try {
      await db.insert(strategies).values({ program: E, metadataUri: "https://example.org/e-v2.json", registeredAt: ago(60 * HOUR) });
      // Its newest fetch was of the URI before a MetadataUpdated, and found an invalid document.
      await db.insert(metadataSnapshots).values({ program: E, uri: "https://example.org/e-v1.json", status: "invalid", reason: "invalid", errors: ["name: must be a non-empty string"], warnings: [], fetchedAt: ago(HOUR), checkedAt: ago(HOUR) });
      await db.insert(markets).values({ address: M4, strategyProgram: E, marketState: T4, createdBy: CREATOR, createdAt: ago(5 * HOUR) });
      await db.insert(marketMints).values([
        { market: M4, position: 0, mint: T3, vault: T1, vaultAmount: "5" },
        { market: M4, position: 1, mint: WSOL, vault: T2, vaultAmount: "5" },
      ]);
    } finally {
      await close();
    }
  });

  it("reads as not fetched yet, with the URI its account names, and no metadata flag", async () => {
    const strategy = StrategyDetail.parse((await get(`/v1/strategies/${E}`)).body);
    expect(strategy).toMatchObject({ name: null, metadata: { status: "not-fetched", uri: "https://example.org/e-v2.json", errors: [] }, flags: [], flag_facts: [] });
  });

  it("and its markets are not hidden by the earlier document's flag", async () => {
    const hidden = await page("?hide=metadata-invalid");
    expect(addresses(hidden.markets)).toContain(M4);
    expect((await page()).markets.find((m) => m.address === M4)).toMatchObject({ strategy_metadata: "not-fetched", flags: [] });
  });
});
