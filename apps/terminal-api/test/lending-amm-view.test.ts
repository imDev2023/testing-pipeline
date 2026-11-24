// The lending AMM's panel worked out from the accounts at one slot (docs/spec/lending-pool.md, "Aviary's
// panel"; #88): the buffer, the lent value and the band; the two largest sells, each the real edge of
// the program's pricing; Kamino's figures; the LP share's value, the locked shares and the yield; and
// `rebalance` due exactly as the keeper runner decides it.
import { describe, expect, it } from "vitest";
import { exactIn, kaminoRates, largestSellWithin, lendingView, type LendingAccounts } from "../src/products/lendingAmm/view";
import { clock, lendingMarket, MARKET_STATE, marketState, mint, reserve, tokenAccount, type ReserveFields, type StateFields } from "./lendingAmmAccounts";

const SLOT = 500_000n;

function accounts({ state = {}, reserveFields = {}, emergency = false, supply = 1_000_000_000n, locked = 0n, slot = SLOT, wallet }: { state?: StateFields; reserveFields?: ReserveFields; emergency?: boolean; supply?: bigint; locked?: bigint; slot?: bigint; wallet?: bigint } = {}): LendingAccounts {
  return {
    slot,
    marketState: MARKET_STATE,
    state: marketState(state),
    reserve: reserve({ lastUpdateSlot: slot - 10n, ...reserveFields }),
    lendingMarket: lendingMarket({ emergencyMode: emergency }),
    clock: clock(slot),
    lpMint: mint(supply),
    lockAccount: locked ? tokenAccount(locked) : null,
    ...(wallet === undefined ? {} : { walletShares: wallet ? tokenAccount(wallet) : null }),
  };
}

/** A market of 1,000,000 tokens (6 decimals) against 1 SOL, 0.2 SOL in its buffer and 0.8 SOL lent at a rate of 1. */
const LENT = { reserves: [1_000_000_000_000n, 200_000_000n], ctokens: 800_000_000n, deposited: 800_000_000n };

describe("the program's pricing, written again", () => {
  it("rounds the fee up and the output down, and refuses a zero output or an emptied side", () => {
    // The program's own vector (src/pricing.rs): the fee ceil(3) = 3, and 2,000,000 x 997 / 1,000,997 rounded down.
    expect(exactIn(1_000_000n, 2_000_000n, 1_000n, 30)).toBe(1_992n);
    expect(exactIn(1_000_000n, 2_000_000n, 0n, 30)).toBeNull();
    expect(exactIn(1_000_000_000n, 1n, 1n, 0)).toBeNull();
  });

  it("finds the largest sale paying at most a limit: one unit more pays more", () => {
    const { amount, all } = largestSellWithin(1_000_000_000_000n, 1_000_000_000n, 30, 200_000_000n);
    expect(all).toBe(false);
    expect(exactIn(1_000_000_000_000n, 1_000_000_000n, amount!, 30)!).toBeLessThanOrEqual(200_000_000n);
    expect(exactIn(1_000_000_000_000n, 1_000_000_000n, amount! + 1n, 30)!).toBeGreaterThan(200_000_000n);
  });

  it("says when every sale fits, and when none does", () => {
    expect(largestSellWithin(10n, 1_000n, 0, 1_000n)).toEqual({ amount: (1n << 64n) - 1n, all: true });
    expect(largestSellWithin(1_000n, 1_000_000n, 0, 0n)).toEqual({ amount: null, all: false });
  });
});

describe("the panel's figures", () => {
  it("values the lent side from the reserve's stored rate and places the buffer in its band", () => {
    const view = lendingView(accounts({ state: LENT }));
    expect(view.lentIndex).toBe(1);
    expect(view.buffer).toBe(200_000_000n);
    expect(view.lentValue).toBe(800_000_000n);
    expect(view.lentTotal).toBe(1_000_000_000n);
    expect(view.bufferShareBps).toBe(2_000);
    expect(view.band).toBe("within");
    expect(view.bandBps).toEqual({ min: 1_000, target: 2_000, max: 3_000 });
  });

  it("gives the largest sell the buffer pays alone, and with Kamino's free liquidity on top", () => {
    // Kamino holds 0.3 SOL free: a redeem may plan 0.3 SOL less its 0.1% headroom.
    const view = lendingView(accounts({ state: LENT, reserveFields: { available: 300_000_000n, borrowed: 99_700_000_000n } }));
    expect(view.kamino.freeLiquidity).toBe(300_000_000n);
    expect(view.kamino.canPay).toBe(299_700_000n);
    const { bufferAlone, withKamino } = view.sells;
    const out = (a: bigint) => exactIn(1_000_000_000_000n, view.lentTotal!, a, 30)!;
    expect(out(bufferAlone!)).toBeLessThanOrEqual(view.buffer);
    expect(out(bufferAlone! + 1n)).toBeGreaterThan(view.buffer);
    expect(out(withKamino!)).toBeLessThanOrEqual(view.buffer + 299_700_000n);
    expect(out(withKamino! + 1n)).toBeGreaterThan(view.buffer + 299_700_000n);
    expect(view.sells.refused).toBeNull();
  });

  it("counts nothing from Kamino while an emergency mode is on, so the buffer is the edge", () => {
    for (const view of [lendingView(accounts({ state: LENT, reserveFields: { emergencyMode: true } })), lendingView(accounts({ state: LENT, emergency: true }))]) {
      expect(view.kamino.redeemsStopped).toBe(true);
      expect(view.kamino.canPay).toBe(0n);
      expect(view.sells.withKamino).toBe(view.sells.bufferAlone);
      expect(view.rebalance).toMatchObject({ due: false, refusal: "KaminoStopped" });
    }
    expect(lendingView(accounts({ state: LENT, reserveFields: { emergencyMode: true } })).kamino.reserveEmergency).toBe(true);
    expect(lendingView(accounts({ state: LENT, emergency: true })).kamino.lendingMarketEmergency).toBe(true);
  });

  it("refuses every sell on a reserve refreshed too long ago once the market holds cTokens", () => {
    const stale = lendingView(accounts({ state: LENT, reserveFields: { lastUpdateSlot: SLOT - 9_001n } }));
    expect(stale.kamino.refreshAgeSlots).toBe(9_001n);
    expect(stale.sells).toMatchObject({ refused: "reserve-stale", bufferAlone: null, withKamino: null });
    const fresh = lendingView(accounts({ state: LENT, reserveFields: { lastUpdateSlot: SLOT - 9_000n } }));
    expect(fresh.sells.refused).toBeNull();
    const noCtokens = lendingView(accounts({ state: { reserves: [1_000_000_000_000n, 1_000_000_000n] }, reserveFields: { lastUpdateSlot: 0n } }));
    expect(noCtokens.sells.refused).toBeNull();
  });

  it("states Kamino's utilisation and supply rate as its SDK computes them from the curve", () => {
    const reserveFields: ReserveFields = { available: 50_000_000_000n, borrowed: 50_000_000_000n, protocolTakeRatePct: 15, curve: [[0, 0], [8_000, 1_000], [10_000, 5_000]] };
    const view = lendingView(accounts({ state: LENT, reserveFields }));
    expect(view.kamino.utilisationBps).toBe(5_000);
    expect(view.kamino.borrowRateBps).toBe(625);
    expect(view.kamino.supplyRateBps).toBe(265.62);
    // At a point of the curve, its rate exactly; above 100% utilisation, the last point.
    expect(kaminoRates(reserve({ available: 20_000_000_000n, borrowed: 80_000_000_000n, curve: [[0, 0], [8_000, 1_000], [10_000, 5_000]] }), 100_000_000_000n * (1n << 60n)).borrowRateBps).toBe(1_000);
  });

  it("values an LP share, counts the locked shares and measures the lending yield so far", () => {
    // The rate has risen to 1.1: Kamino's total supply is 110 SOL for 100 SOL of cTokens.
    const view = lendingView(accounts({ state: LENT, reserveFields: { available: 100_000_000_000n, borrowed: 10_000_000_000n }, supply: 14_141_213_562n, locked: 1_000_000_000n }));
    expect(view.lentValue).toBe(880_000_000n);
    expect(view.yieldSoFar).toBe(80_000_000n);
    expect(view.lp.shareCount).toBe(14_141_214_562n);
    expect(view.lp.locked).toBe(1_000_000_000n);
    expect(view.lp.valueOther).toBe((1_000_000_000_000n * 1_000_000_000n) / 14_141_214_562n);
    expect(view.lp.valueLent).toBe((1_080_000_000n * 1_000_000_000n) / 14_141_214_562n);
  });

  it("shows rebalance due exactly when the keeper runner would send it", () => {
    const above = lendingView(accounts({ state: { reserves: [1_000_000_000_000n, 500_000_000n], ctokens: 500_000_000n, deposited: 500_000_000n } }));
    expect(above.band).toBe("above");
    expect(above.rebalance).toEqual({ due: true, deposit: 300_000_000n, redeem: null, withdrawModeAfter: false, refusal: null });
    const within = lendingView(accounts({ state: LENT }));
    expect(within.rebalance).toMatchObject({ due: false, refusal: "WithinBand" });
  });

  it("enters withdraw mode when Kamino's free liquidity falls below five times the exposure", () => {
    const view = lendingView(accounts({ state: LENT, reserveFields: { available: 3_000_000_000n, borrowed: 97_000_000_000n } }));
    expect(view.rebalance).toMatchObject({ due: true, redeem: 800_000_000n, withdrawModeAfter: true });
  });

  it("says when a cash removal would fail and how many shares one can take", () => {
    const supply = 1_000_000_000n - 1_000n;
    // Half the shares; Kamino can pay 0.1 SOL, less headroom, of their 0.4 SOL of cTokens.
    const thin = lendingView(accounts({ state: LENT, supply, reserveFields: { available: 100_000_000n, borrowed: 99_900_000_000n }, wallet: 500_000_000n }));
    expect(thin.wallet).toMatchObject({ shares: 500_000_000n, other: 500_000_000_000n, bufferPart: 100_000_000n, ctokenPart: 400_000_000n, ctokenValue: 400_000_000n, cash: "kamino-cannot-pay" });
    const max = thin.wallet!.cashMaxShares;
    const canPay = thin.kamino.canPay;
    expect((800_000_000n * max) / 1_000_000_000n).toBeLessThanOrEqual(canPay);
    expect((800_000_000n * (max + 1n)) / 1_000_000_000n).toBeGreaterThan(canPay);
    const stopped = lendingView(accounts({ state: LENT, supply, reserveFields: { emergencyMode: true }, wallet: 500_000_000n }));
    expect(stopped.wallet).toMatchObject({ cash: "kamino-stopped", cashMaxShares: 1n });
    const fine = lendingView(accounts({ state: LENT, supply, wallet: 500_000_000n }));
    expect(fine.wallet).toMatchObject({ cash: "yes", cashMaxShares: 500_000_000n });
    expect(lendingView(accounts({ state: LENT, supply, wallet: 0n })).wallet).toMatchObject({ shares: 0n, cash: "nothing" });
  });

  it("names what the program would refuse to read, and still shows the market's own records", () => {
    const broken = { ...accounts({ state: LENT }), reserve: new Uint8Array(100) };
    const view = lendingView(broken);
    expect(view.kamino.problem).toMatch(/not the size the program reads/);
    expect(view.lentValue).toBeNull();
    expect(view.buffer).toBe(200_000_000n);
    expect(view.sells.refused).toBe("reserve-unreadable");
    const other = lendingView(accounts({ state: LENT, reserveFields: { version: 2n } }));
    expect(other.kamino.problem).toMatch(/version the program was not written for/);
  });
});
