// A lending AMM market's history (docs/spec/lending-pool.md, "Custom actions and metadata"; #88): the
// strategy's own events on the market, newest first, as the indexer stored them (`strategy_events`),
// each decoded with the program's generated client: liquidity added and removed, the lent side taken
// alone, shares locked, rebalances, withdraw mode entered and left, and a swap's redeem. Values the
// panel shows come from the market state, never from these (the spec's rule); this is the record of
// what happened.
import { getAddressEncoder, type Address, type ReadonlyUint8Array } from "@solana/kit";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  getLentSideRemovedEventDecoder,
  getLiquidityAddedEventDecoder,
  getLiquidityRemovedEventDecoder,
  getMarketCreatedEventDecoder,
  getMarketSeededEventDecoder,
  getRebalancedEventDecoder,
  getSharesLockedEventDecoder,
  getShortfallRedeemedEventDecoder,
  getWithdrawModeEnteredEventDecoder,
  getWithdrawModeLeftEventDecoder,
  LENT_SIDE_REMOVED_EVENT_DISCRIMINATOR,
  LIQUIDITY_ADDED_EVENT_DISCRIMINATOR,
  LIQUIDITY_REMOVED_EVENT_DISCRIMINATOR,
  MARKET_CREATED_EVENT_DISCRIMINATOR,
  MARKET_SEEDED_EVENT_DISCRIMINATOR,
  REBALANCED_EVENT_DISCRIMINATOR,
  SHARES_LOCKED_EVENT_DISCRIMINATOR,
  SHORTFALL_REDEEMED_EVENT_DISCRIMINATOR,
  WITHDRAW_MODE_ENTERED_EVENT_DISCRIMINATOR,
  WITHDRAW_MODE_LEFT_EVENT_DISCRIMINATOR,
} from "lending-amm-scripts/client/index.ts";
import { strategyEvents, type Db } from "terminal-db";
import type { LendingEvent, LendingHistory } from "./contract";
import { LENDING_AMM_PROGRAM } from "./read";

type Kind = LendingEvent["kind"];
type Fields = LendingEvent["fields"];
type Decoded = { kind: Kind; account: string | null; fields: Fields };

const hex = (bytes: ReadonlyUint8Array) => Buffer.from(bytes).toString("hex");
const s = (value: bigint) => value.toString();

/** Each event the panel lists, by its discriminator in hex: its kind, the wallet it names, and its fields in the program's words. */
const DECODERS: Record<string, (data: Uint8Array) => Decoded> = {
  [hex(MARKET_CREATED_EVENT_DISCRIMINATOR)]: (data) => {
    const e = getMarketCreatedEventDecoder().decode(data);
    return { kind: "market-created", account: null, fields: { mints: [...e.mints], lent_index: e.params.lentIndex, lp_fee_bps: e.params.lpFeeBps, reserve: e.reserve, created_slot: s(e.createdSlot) } };
  },
  [hex(MARKET_SEEDED_EVENT_DISCRIMINATOR)]: (data) => {
    const e = getMarketSeededEventDecoder().decode(data);
    return { kind: "market-seeded", account: e.lpRecipient, fields: { seeder: e.seeder, amounts: e.amounts.map(s), shares: s(e.shares), share_count: s(e.shareCount) } };
  },
  [hex(LIQUIDITY_ADDED_EVENT_DISCRIMINATOR)]: (data) => {
    const e = getLiquidityAddedEventDecoder().decode(data);
    return { kind: "liquidity-added", account: e.lp, fields: { amounts: e.amounts.map(s), shares: s(e.shares), share_count: s(e.shareCount), first: e.first } };
  },
  [hex(LIQUIDITY_REMOVED_EVENT_DISCRIMINATOR)]: (data) => {
    const e = getLiquidityRemovedEventDecoder().decode(data);
    return { kind: "liquidity-removed", account: e.lp, fields: { shares: s(e.shares), share_count: s(e.shareCount), amounts: e.amounts.map(s), ctokens: s(e.ctokens), in_kind: e.inKind, redeemed: s(e.redeemed) } };
  },
  [hex(LENT_SIDE_REMOVED_EVENT_DISCRIMINATOR)]: (data) => {
    const e = getLentSideRemovedEventDecoder().decode(data);
    return { kind: "lent-side-removed", account: e.lp, fields: { shares: s(e.shares), share_count: s(e.shareCount), lent: s(e.lent), ctokens: s(e.ctokens), other_left: s(e.otherLeft) } };
  },
  [hex(SHARES_LOCKED_EVENT_DISCRIMINATOR)]: (data) => {
    const e = getSharesLockedEventDecoder().decode(data);
    return { kind: "shares-locked", account: e.lp, fields: { amount: s(e.amount), locked: s(e.locked), share_count: s(e.shareCount) } };
  },
  [hex(REBALANCED_EVENT_DISCRIMINATOR)]: (data) => {
    const e = getRebalancedEventDecoder().decode(data);
    return { kind: "rebalanced", account: null, fields: { direction: Number(e.direction) === 0 ? "deposit" : "redeem", liquidity: s(e.liquidity), ctokens: s(e.ctokens), buffer: s(e.buffer), ctokens_held: s(e.ctokensHeld) } };
  },
  [hex(WITHDRAW_MODE_ENTERED_EVENT_DISCRIMINATOR)]: (data) => {
    const e = getWithdrawModeEnteredEventDecoder().decode(data);
    return { kind: "withdraw-mode-entered", account: null, fields: { free_liquidity: s(e.freeLiquidity), exposure: s(e.exposure) } };
  },
  [hex(WITHDRAW_MODE_LEFT_EVENT_DISCRIMINATOR)]: (data) => {
    const e = getWithdrawModeLeftEventDecoder().decode(data);
    return { kind: "withdraw-mode-left", account: null, fields: { free_liquidity: s(e.freeLiquidity), exposure: s(e.exposure) } };
  },
  [hex(SHORTFALL_REDEEMED_EVENT_DISCRIMINATOR)]: (data) => {
    const e = getShortfallRedeemedEventDecoder().decode(data);
    return { kind: "shortfall-redeemed", account: null, fields: { shortfall: s(e.shortfall), ctokens: s(e.ctokens), liquidity: s(e.liquidity), buffer: s(e.buffer), ctokens_held: s(e.ctokensHeld) } };
  },
};

/** The 32 bytes after an event's discriminator, in hex: for every event above, the market state it is about. */
const subjectHex = (data: Uint8Array) => (data.length >= 40 ? Buffer.from(data.subarray(8, 40)).toString("hex") : null);

/** One stored event decoded, or null for one the program's client does not know, does not decode, or that is about another market state. */
export function decodeLendingEvent(data: Uint8Array, marketState: Address): Decoded | null {
  const decode = data.length >= 8 ? DECODERS[hex(data.subarray(0, 8))] : undefined;
  // The subject column found it; the event's own market state is the last word.
  if (!decode || subjectHex(data) !== hex(getAddressEncoder().encode(marketState))) return null;
  try {
    return decode(data);
  } catch {
    return null;
  }
}

/** The market's events, newest first, `limit` a page, from before the cursor `slot:block index:position:signature`, a total order. */
export async function readLendingHistory(db: Db, { market, marketState, before, limit }: { market: string; marketState: string; before: string | null; limit: number }): Promise<LendingHistory> {
  const blockIndex = sql`coalesce(${strategyEvents.blockIndex}, 0)`;
  const order = sql`(${strategyEvents.slot}, ${blockIndex}, ${strategyEvents.position}, ${strategyEvents.signature})`;
  const cursor = before ? before.split(":") : null;
  const rows = await db
    .select()
    .from(strategyEvents)
    .where(
      and(
        eq(strategyEvents.program, LENDING_AMM_PROGRAM),
        eq(strategyEvents.subject, marketState),
        cursor ? sql`${order} < (${BigInt(cursor[0]!)}, ${Number(cursor[1])}, ${Number(cursor[2])}, ${cursor[3]!})` : undefined,
      ),
    )
    .orderBy(desc(strategyEvents.slot), desc(blockIndex), desc(strategyEvents.position), desc(strategyEvents.signature))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const events: LendingEvent[] = page.flatMap((row) => {
    const decoded = decodeLendingEvent(new Uint8Array(Buffer.from(row.data, "base64")), marketState as Address);
    return decoded ? [{ signature: row.signature, position: row.position, slot: Number(row.slot), block_time: row.blockTime ? row.blockTime.toISOString() : null, ...decoded }] : [];
  });
  const last = page.at(-1);
  return { market, events, next_before: rows.length > limit && last ? `${last.slot}:${last.blockIndex ?? 0}:${last.position}:${last.signature}` : null };
}
