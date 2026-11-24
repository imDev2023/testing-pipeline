// What the lending AMM's forms fill in (docs/spec/lending-pool.md, "Adding" and "Removing"; #88), from
// the panel's one-slot read: a deposit at the market's current ratio with each maximum the amount the
// ratio asks for plus the slippage accepted, never a whole balance (finding H024), and the fewest
// shares that protect it; a removal's parts with their minimums; and whether a removal may go in cash.
import type { LendingPanel } from "terminal-api/lending-amm";

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** `amount` raised by `bps` of itself, rounded up: a maximum's room for the price moving first. */
export const raised = (amount: bigint, bps: number) => ceilDiv(amount * (BPS + BigInt(bps)), BPS);
/** `amount` lowered by `bps` of itself, rounded down: a minimum's room for the price moving first. */
export const lowered = (amount: bigint, bps: number) => (amount * (BPS - BigInt(bps))) / BPS;

export type Deposit = {
  /** By mint index, as `add_liquidity` takes them. */
  max: [bigint, bigint];
  minLp: bigint;
  /** What the deposit is quoted to take of each side, and the shares it mints. */
  other: bigint;
  lent: bigint;
  shares: bigint;
};

/**
 * A later deposit (the program's `add_liquidity` after the first): the amount typed of one side, the
 * other at the current ratio `R : L`, the shares `min(other x N / R, lent x N / L)` rounded down, and
 * what those shares take of each side rounded up, as the program takes it. Null when the market
 * cannot be priced from the read (no liquidity, the lent side unreadable) or the amount mints nothing.
 */
export function deposit(panel: LendingPanel, side: "other" | "lent", amount: bigint, slippageBps: number): Deposit | null {
  if (panel.lent_total === null || panel.lp.share_count === null) return null;
  const r = BigInt(panel.other_reserve);
  const l = BigInt(panel.lent_total);
  const n = BigInt(panel.lp.share_count);
  if (r === 0n || l === 0n || amount <= 0n) return null;
  const other = side === "other" ? amount : ceilDiv(amount * r, l);
  const lent = side === "lent" ? amount : ceilDiv(amount * l, r);
  const byOther = (other * n) / r;
  const byLent = (lent * n) / l;
  const shares = byOther < byLent ? byOther : byLent;
  if (shares === 0n) return null;
  const takesOther = ceilDiv(shares * r, n);
  const takesLent = ceilDiv(shares * l, n);
  const maxOther = raised(takesOther, slippageBps);
  const maxLent = raised(takesLent, slippageBps);
  const max: [bigint, bigint] = panel.lent_index === 1 ? [maxOther, maxLent] : [maxLent, maxOther];
  return { max, minLp: lowered(shares, slippageBps) || 1n, other: takesOther, lent: takesLent, shares };
}

export type Removal = { other: bigint; bufferPart: bigint; ctokenPart: bigint; ctokenValue: bigint; minOther: bigint; minLent: bigint };

/**
 * A removal of `lp` shares (the program's `shares::removal`): each part `X x lp / N` rounded down, the
 * cTokens' part valued at the read's stored rate, which is what a cash removal is paid for it, and
 * the minimums lowered by the slippage accepted; in kind the lent mint paid is the buffer's part alone.
 */
export function removal(panel: LendingPanel, lp: bigint, inKind: boolean, slippageBps: number): Removal | null {
  if (panel.lp.share_count === null || lp <= 0n) return null;
  const n = BigInt(panel.lp.share_count);
  const other = (BigInt(panel.other_reserve) * lp) / n;
  const bufferPart = (BigInt(panel.buffer) * lp) / n;
  const ctokens = BigInt(panel.ctokens);
  const ctokenPart = (ctokens * lp) / n;
  const lentValue = panel.lent_value === null ? null : BigInt(panel.lent_value);
  const ctokenValue = lentValue === null || ctokens === 0n ? 0n : (lentValue * ctokenPart) / ctokens;
  return { other, bufferPart, ctokenPart, ctokenValue, minOther: lowered(other, slippageBps), minLent: lowered(inKind ? bufferPart : bufferPart + ctokenValue, slippageBps) };
}

/** Why a cash removal of `lp` shares would fail now, or null when it would go through: the panel's reading of the wallet's shares. */
export function cashRefusal(panel: LendingPanel, lp: bigint): string | null {
  const wallet = panel.wallet;
  if (!wallet) return null;
  if (lp <= BigInt(wallet.cash_max_shares)) return null;
  if (wallet.cash === "kamino-stopped" || panel.kamino.redeems_stopped) return "Kamino redeems nothing right now (an emergency mode is on, or the reserve is deprecated), so a removal in cash would fail.";
  if (wallet.cash === "reserve-unreadable" || panel.kamino.problem) return "The program refuses to read Kamino's reserve right now, so a removal in cash would fail.";
  return "Kamino cannot pay this many shares' cTokens right now, so a removal in cash would fail.";
}

/** The band's position on a 0-100% scale, for the buffer meter: each mark as a percentage of the lent side. */
export function bandMarks(panel: LendingPanel): { min: number; target: number; max: number; share: number | null } {
  const pct = (bps: number) => bps / 100;
  return { min: pct(panel.band_bps.min), target: pct(panel.band_bps.target), max: pct(panel.band_bps.max), share: panel.buffer_share_bps === null ? null : pct(panel.buffer_share_bps) };
}

/**
 * Why a cash removal the form holds would fail now: of `lp` shares when the wallet holds them, else of
 * every share it holds, since more than it holds is the form's own refusal, not Kamino's; null when
 * cash would go through or the wallet holds none.
 */
export function cashRefusalForForm(panel: LendingPanel, lp: bigint): string | null {
  const held = panel.wallet ? BigInt(panel.wallet.shares) : 0n;
  const asked = lp > 0n && lp <= held ? lp : held;
  return asked > 0n ? cashRefusal(panel, asked) : null;
}
