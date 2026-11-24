// The lending AMM's panel, history and forms as the market page draws them (#88; docs/spec/lending-pool.md,
// "Aviary's panel"): every figure the spec lists, named plainly and never as a verdict; the notices
// for Kamino's states; the history in sentences; the forms the panel fills in, with in kind offered
// whenever a cash removal would fail; and the forms' maths, a deposit at the market's ratio with
// room for the price and a removal's parts, as the program computes them.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Market } from "terminal-api/contract";
import type { LendingEvent, LendingHistory, LendingPanel } from "terminal-api/lending-amm";
import { describe, expect, it } from "vitest";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { HistoryList } from "@/products/lendingAmm/LendingHistory";
import { LendingFormsBody } from "@/products/lendingAmm/LendingForms";
import { LendingAmmBody, noticesOf } from "@/products/lendingAmm/LendingPanel";
import { cashRefusal, cashRefusalForForm, deposit, removal } from "@/products/lendingAmm/math";
import { LENDING_AMM_PROGRAM } from "@/products/lendingAmm/program";
import { PRODUCT_PANELS } from "@/products/registry";

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "LuZBpaL9LXZCrZXtqfgsbuxN2PSp42k1bkUEuzXwpCi";
const WALLET = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW";

const market: Market = {
  address: "AMJ4eVWMgqc9hZMmKDipbvwU6EQkmAvhUf4F42dNSDuu",
  strategy: LENDING_AMM_PROGRAM,
  market_state: "9M5mzsto7Wvj9tBNzAGwyFd84ASSFUh4kuPALhunkMJs",
  created_at: "2026-11-23T12:07:32.000Z",
  created_by: "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt",
  created_signature: null,
  fee_mint: WSOL,
  supports_exact_out: false,
  mints: [
    { mint: TOKEN, symbol: null, token: { symbol: "LDEMO", name: null, image: null }, decimals: 6, vault: null, liquidity: null, flags: [] },
    { mint: WSOL, symbol: "SOL", token: null, decimals: 9, vault: null, liquidity: null, flags: [] },
  ],
  quote_mint: WSOL,
  base_mint: TOKEN,
  stats_24h: { trades: 0, volume_quote: "0" },
  strategy_name: "Aviary Lending AMM",
  strategy_metadata: "valid",
  flags: [],
  canary: null,
};

/** The devnet demo market as the API read it on 2026-11-24 at slot 525,839,067, its reserve then refreshed. */
const read: LendingPanel = {
  market: market.address,
  market_state: market.market_state,
  program: LENDING_AMM_PROGRAM,
  slot: 525_839_067,
  lent_index: 1,
  lent_mint: WSOL,
  other_mint: TOKEN,
  reserve: "5vJJ1sQi972Qcf6oUy3gHEx6prijjSj31CWo5He85Hjw",
  lending_market: "DCKrWS5G3YEcrRP1Ayu8S8nBR4QfgFsSaRzRdPrjqzj3",
  collateral_mint: "8gdtrmgc9QmintdEgJbZhRaqh286ti4wUHMUZw54pLr8",
  lp_mint: "2vUChmDvwrLCahvgmaTrAexZK7RjMn2G5scN8vjs2Sqc",
  ctoken_account: "EdZiX4DoFrNDpVzLnnwM2ZCpo6z4UEbd2hwjyANrWuAL",
  lock_account: "AuXvWziSBbqAh1Cup5dJmsj4Ay7Xf1cQjEXzJeM9pQop",
  vaults: ["9SoEjsfnJa8JpGLDEpJswgzvZVq32e4n1JCMdRAUmosT", "7rphdBTsYCQMScHoqeMdaxkLfYPdZyqyGAswnKayhXGr"],
  reserve_liquidity_supply: "GEEjB2HWqjXXTPzceyjzhk3wwD1rwLjAPfiEoBAd9Tzv",
  seeder: null,
  lp_fee_bps: 30,
  withdraw_mode: false,
  exit_seen: null,
  open: true,
  buffer: "58068755",
  other_reserve: "539906653721",
  ctokens: "232271590",
  lent_value: "232275027",
  lent_total: "290343782",
  buffer_share_bps: 1999.99,
  band: "within",
  band_bps: { min: 1000, target: 2000, max: 3000 },
  kamino: {
    problem: null,
    utilisation_bps: 1250.5,
    free_liquidity: "5813800865",
    supply_rate_bps: 31.25,
    borrow_rate_bps: 250,
    reserve_emergency: false,
    lending_market_emergency: false,
    block_ctoken_usage: false,
    deprecated: false,
    redeems_stopped: false,
    last_refresh_slot: 525_839_000,
    refresh_age_slots: 67,
    withdrawal_cap_remaining: "10000000000000",
    can_pay: "232275027",
    trade_max_age_slots: 9_000,
    refresh_after_slots: 4_500,
  },
  sells: { refused: null, buffer_alone: "123456789", buffer_pays_all: false, with_kamino: "987654321", with_kamino_pays_all: false, into_market: { buffer_alone: "123456789", with_kamino: "987654321" } },
  lp: { supply: "12448825376", share_count: "12448826376", locked: "160189546", minimum_liquidity: "1000", decimals: 9, value_other: "43370084650", value_lent: "23322984" },
  deposited: "908209840",
  redeemed: "675935088",
  yield_so_far: "275",
  rebalance: { due: false, deposit: null, redeem: null, withdraw_mode_after: null, refusal: "WithinBand", keeper_last: null },
  wallet: { wallet: WALLET, shares_account: "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2", shares: "1000000000", other: "43370084650", buffer_part: "4664596", ctoken_part: "18658000", ctoken_value: "18658276", cash: "yes", cash_max_shares: "1000000000" },
  created_slot: 525_425_473,
  created_at: "2026-11-23T12:07:32.000Z",
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1");
const body = (panel: LendingPanel) => text(renderToStaticMarkup(<LendingAmmBody market={market} panel={panel} />));

describe("the lending AMM's place in Aviary", () => {
  it("is keyed by the program devnet.json records, with its panel, forms, create form and the metadata forms they fill in", () => {
    const devnet = JSON.parse(readFileSync(`${import.meta.dirname}/../../../deployments/devnet.json`, "utf8")) as { programs: Record<string, { programId: string }> };
    expect(LENDING_AMM_PROGRAM).toBe(devnet.programs["lending-amm"]!.programId);
    const place = PRODUCT_PANELS[LENDING_AMM_PROGRAM]!;
    expect(place.Panel && place.Forms && place.Create).toBeTruthy();
    expect(place.replaces).toEqual(["add_liquidity", "remove_liquidity", "remove_liquidity_in_kind", "lock_lp", "rebalance"]);
  });
});

describe("the panel", () => {
  it("shows every figure the spec's panel section lists", () => {
    const html = body(read);
    for (const words of [
      "Read from the market state and Kamino's reserve at slot 525,839,067.",
      "Lent to Kamino SOL",
      "Kamino reserve 5vJJ...5Hjw",
      "Lending market DCKr...qzj3",
      "Buffer 0.05807 SOL",
      "Lent value 0.2323 SOL",
      "20.00%, inside its band of 10.00% to 30.00% (target 20.00%)",
      "Withdraw mode Off",
      "Not due: the buffer is inside its band.",
      "Paid by the buffer alone Up to 123.5",
      "With Kamino on top Up to 987.7",
      "Kamino can pay 0.2323 SOL right now; a larger sell fails.",
      "Utilisation 12.51%",
      "Freely available 5.814 SOL",
      "Supply rate 0.31% a year",
      "Reserve emergency mode Off",
      "Lending market emergency mode Off",
      "block_ctoken_usage Off",
      "Last refreshed 67 slots ago",
      "LP fee 0.30% of every swap's input",
      "One LP share 43,370 LDEMO",
      "Locked shares 0.1602 LP shares in the lock account",
      "Lending yield so far 0.000000275 SOL",
    ]) expect(html, words).toContain(words);
  });

  it("reads as no verdict: no word of safety, risk scores or approval", () => {
    expect(body(read)).not.toMatch(/\b(safe|unsafe|risky|trusted|verified|recommended|good|bad|healthy)\b/i);
  });

  it("puts Kamino's emergency modes, withdraw mode and a stale reserve first, in sentences", () => {
    expect(noticesOf(read)).toEqual([]);
    const emergency = { ...read, kamino: { ...read.kamino, reserve_emergency: true, redeems_stopped: true } };
    expect(noticesOf(emergency)[0]).toMatch(/^Kamino's reserve emergency mode is on: .*only in kind\.$/);
    expect(body(emergency)).toContain("Reserve emergency mode On");
    const withdraw = { ...read, withdraw_mode: true, exit_seen: { slot: 525_830_000, leave_from: 525_839_000 } };
    expect(noticesOf(withdraw)[0]).toMatch(/^The market is in withdraw mode/);
    expect(body(withdraw)).toContain("a rebalance from slot 525,839,000 that still sees it leaves withdraw mode");
    const stale = { ...read, kamino: { ...read.kamino, refresh_age_slots: 342_509 }, sells: { ...read.sells, refused: "reserve-stale" as const, buffer_alone: null, with_kamino: null } };
    expect(body(stale)).toContain("None until someone refreshes Kamino's reserve, which anyone may do under Actions.");
  });

  it("says what a due rebalance would do", () => {
    const due = { ...read, band: "above" as const, rebalance: { ...read.rebalance, due: true, deposit: "100000000", refusal: null, withdraw_mode_after: false } };
    expect(body(due)).toContain("Due: it would deposit 0.1 SOL into Kamino. Anyone may send it, under Actions.");
  });
});

describe("the history", () => {
  const event = (over: Partial<LendingEvent>): LendingEvent => ({ signature: "5j7s3Gm8z1", position: 0, slot: 525_800_000, block_time: "2026-11-24T10:00:00.000Z", kind: "liquidity-added", account: WALLET, fields: {}, ...over });
  const history: LendingHistory = {
    market: market.address,
    next_before: null,
    events: [
      event({ kind: "shortfall-redeemed", account: null, fields: { shortfall: "1000", ctokens: "999", liquidity: "1001", buffer: "0", ctokens_held: "5" } }),
      event({ kind: "withdraw-mode-entered", account: null, fields: { free_liquidity: "1420000000", exposure: "290000000" } }),
      event({ kind: "rebalanced", account: null, fields: { direction: "deposit", liquidity: "80000000", ctokens: "79999990", buffer: "58068755", ctokens_held: "232271590" } }),
      event({ kind: "shares-locked", fields: { amount: "1000000000", locked: "1160189546", share_count: "12448826376" } }),
      event({ kind: "liquidity-removed", fields: { shares: "500000000", share_count: "1", amounts: ["21685042325", "11661492"], ctokens: "9329000", in_kind: true, redeemed: "0" } }),
      event({ kind: "liquidity-added", fields: { amounts: ["1000000", "500000"], shares: "700000", share_count: "1", first: false } }),
    ],
  };
  const html = text(renderToStaticMarkup(<HistoryList market={market} lentMint={WSOL} first={history} />));

  it("lists the strategy's events newest first, each in a sentence with who and the transaction", () => {
    expect(html).toContain("A sale beyond the buffer redeemed 0.000001001 SOL from Kamino for its shortfall of 0.000001 SOL.");
    expect(html).toContain("Entered withdraw mode: Kamino had 1.42 SOL free against an exposure of 0.29 SOL.");
    expect(html).toContain("Rebalanced: deposited 0.08 SOL into Kamino, leaving 0.05807 SOL in the buffer.");
    expect(html).toContain("1 LP share locked, 1.16 LP shares locked in all.");
    expect(html).toContain("Liquidity removed in kind: 0.5 LP shares for 21,690 LDEMO");
    expect(html).toContain("Liquidity added: 1 LDEMO LuZB...wpCi and 0.0005 SOL, for 0.0007 LP shares.");
    expect(html).toContain(`by E69P...JnAW`);
  });
});

describe("the forms' maths", () => {
  it("deposits at the market's ratio, each maximum the quoted amount plus 1% and the fewest shares 1% under", () => {
    const quote = deposit(read, "lent", 10_000_000n, 100)!;
    expect(quote.lent).toBeLessThanOrEqual(10_000_000n);
    // The shares are the smaller of each side's, as the program mints them.
    const n = 12_448_826_376n;
    expect(quote.shares).toBe([(quote.other * n) / 539_906_653_721n, (10_000_000n * n) / 290_343_782n].reduce((a, b) => (a < b ? a : b)));
    expect(quote.max[1]).toBe((quote.lent * 10_100n + 9_999n) / 10_000n);
    expect(quote.minLp).toBe((quote.shares * 9_900n) / 10_000n);
    expect(deposit({ ...read, lent_total: null }, "lent", 1n, 100)).toBeNull();
  });

  it("removes each part pro rata, the cTokens valued at the read's rate in cash and paid as cTokens in kind", () => {
    const cash = removal(read, 1_000_000_000n, false, 100)!;
    expect(cash.other).toBe((539_906_653_721n * 1_000_000_000n) / 12_448_826_376n);
    expect(cash.minLent).toBe(((cash.bufferPart + cash.ctokenValue) * 9_900n) / 10_000n);
    const kind = removal(read, 1_000_000_000n, true, 100)!;
    expect(kind.minLent).toBe((kind.bufferPart * 9_900n) / 10_000n);
  });

  it("says why a cash removal would fail, from the panel's reading of the wallet", () => {
    expect(cashRefusal(read, 1_000_000_000n)).toBeNull();
    const stopped = { ...read, kamino: { ...read.kamino, redeems_stopped: true }, wallet: { ...read.wallet!, cash: "kamino-stopped" as const, cash_max_shares: "0" } };
    expect(cashRefusal(stopped, 1n)).toMatch(/^Kamino redeems nothing right now/);
    const thin = { ...read, wallet: { ...read.wallet!, cash: "kamino-cannot-pay" as const, cash_max_shares: "400000000" } };
    expect(cashRefusal(thin, 400_000_000n)).toBeNull();
    expect(cashRefusal(thin, 400_000_001n)).toMatch(/^Kamino cannot pay this many shares' cTokens right now/);
  });
});

describe("the cash removal's check in the form", () => {
  // After a removal confirms the wallet holds fewer shares than the amount still typed: that is the
  // form's own refusal, never Kamino's, so the form must not flip to in kind (and drop the confirmed review).
  it("asks Kamino only about shares the wallet holds", () => {
    const after = { ...read, wallet: { ...read.wallet!, shares: "3816676447", cash: "yes" as const, cash_max_shares: "3816676447" } };
    expect(cashRefusalForForm(after, 10_000_000_000n)).toBeNull();
    expect(cashRefusalForForm(after, 1_000_000_000n)).toBeNull();
    const thin = { ...after, wallet: { ...after.wallet, cash: "kamino-cannot-pay" as const, cash_max_shares: "500000000" } };
    expect(cashRefusalForForm(thin, 400_000_000n)).toBeNull();
    expect(cashRefusalForForm(thin, 600_000_000n)).toMatch(/^Kamino cannot pay/);
    expect(cashRefusalForForm({ ...read, wallet: null }, 1n)).toBeNull();
  });
});

describe("the forms", () => {
  const render = (panel: LendingPanel) =>
    text(
      renderToStaticMarkup(
        <WalletProvider chain="solana:devnet">
          <LendingFormsBody market={market} panel={panel} onDone={() => {}} />
        </WalletProvider>,
      ),
    );

  it("offers adding, removing, locking and rebalancing, each calling the strategy's own instruction", () => {
    const html = render(read);
    for (const words of ["Add liquidity calls add_liquidity", "Remove liquidity calls remove_liquidity", "Lock LP shares calls lock_lp", "Rebalance calls rebalance"]) expect(html).toContain(words);
    expect(html).toContain("Not due now, so its simulation will show the program's refusal");
    expect(html).not.toContain("Refresh Kamino's reserve");
  });

  it("offers in kind, already chosen, when a cash removal would fail", () => {
    const stopped = { ...read, kamino: { ...read.kamino, reserve_emergency: true, redeems_stopped: true }, wallet: { ...read.wallet!, cash: "kamino-stopped" as const, cash_max_shares: "0" } };
    const html = renderToStaticMarkup(
      <WalletProvider chain="solana:devnet">
        <LendingFormsBody market={market} panel={stopped} onDone={() => {}} />
      </WalletProvider>,
    );
    expect(text(html)).toContain("Kamino redeems nothing right now (an emergency mode is on, or the reserve is deprecated), so a removal in cash would fail. In kind works whatever state Kamino is in");
    const radio = (words: string) => html.match(new RegExp(`<input type="radio"([^>]*)/> ${words}`))?.[1] ?? "";
    expect(radio("In cash")).toContain('disabled=""');
    expect(radio("In kind")).toContain('checked=""');
  });

  it("offers a refresh of Kamino's reserve once it is too stale for the keeper's liking", () => {
    expect(render({ ...read, kamino: { ...read.kamino, refresh_age_slots: 9_001 } })).toContain("Refresh Kamino's reserve calls klend refresh_reserve");
  });
});
