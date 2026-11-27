// The containment hook's part of Aviary's API (docs/spec/containment-hook.md, "In Aviary"; #76). The
// hook is not a strategy and has no strategy metadata, so its panel and its one action, `unlock`, are
// Aviary's own: `GET /v1/markets/{market}/containment` reads a home market's contained tokens at one
// slot, and `POST /v1/containment/unlock/prepare` builds and simulates `unlock` for a wallet.
import { z } from "zod";
import { ResolvedAccount, TransactionSimulation } from "../../contract";

const Address = z.string().min(32).max(44);
const Amount = z.string().regex(/^\d+$/);

/** Which of the two made an unlock due: the goal when both hold, as the hook logs it. */
export const UnlockBy = z.enum(["goal", "deadline"]);
export type UnlockBy = z.infer<typeof UnlockBy>;

/** One tax recipient of the home market, its part of every tax, and whether it is the market's creator, who launched the token. */
export const ContainmentRecipient = z.object({ wallet: Address, of_tax_bps: z.number().int(), launcher: z.boolean() });

/**
 * Who the home market's tax goes to and whether that can change (`HOOK-49`): whoever receives the tax
 * gets most of it back, so can reach the goal for a fraction of it.
 */
export const ContainmentTax = z.object({
  recipients: z.array(ContainmentRecipient),
  /** The burn's and the suite share's parts of every tax, in basis points of the whole tax. */
  burn_of_tax_bps: z.number().int(),
  suite_of_tax_bps: z.number().int(),
  /** The sum of the parts the market's creator receives, in basis points of the whole tax. */
  launcher_of_tax_bps: z.number().int(),
  authority: z.discriminatedUnion("kind", [z.object({ kind: z.literal("address"), address: Address, launcher: z.boolean() }), z.object({ kind: z.literal("none") }), z.object({ kind: z.literal("renounced") })]),
  /** A change of rates waiting for its slot, in basis points. */
  pending: z.object({ buy_bps: z.number().int(), sell_bps: z.number().int(), from_slot: z.number().int() }).nullable(),
});

/**
 * The token's supply against what the home market's pool holds of it (`HOOK-50`): supply held outside
 * the pool can be sold into the real quote buyers paid in, which is `quote_in_pool`.
 */
export const ContainmentSupply = z.object({ total: Amount, in_pool: Amount, outside: Amount, quote_in_pool: Amount });

/** One contained token of a home market, or one its unlock freed, as the panel shows it. */
export const ContainedMint = z.object({
  mint: Address,
  /** "contained" while Token-2022 calls the hook on its transfers; "unlocked" once its unlock cleared both hook fields. */
  status: z.enum(["contained", "unlocked"]),
  /** The home market's quote mint, which the goal and the tax collected are counted in. */
  quote_mint: Address,
  goal: Amount,
  /** The home market's tax collected, in the quote mint's base units; null when its state cannot be read as the tax AMM's. */
  collected: Amount.nullable(),
  /** The unlock deadline, when it was bound and when it unlocked, in Unix seconds as the hook records them. */
  deadline: z.number().int(),
  bound_at: z.number().int(),
  unlocked_at: z.number().int().nullable(),
  /** Which of the two unlocked it; null while contained. */
  unlocked_by: UnlockBy.nullable(),
  /** Whether `unlock` would pass at the slot read, and by which; null while it is not due, and once unlocked. */
  due: UnlockBy.nullable(),
  tax: ContainmentTax.nullable(),
  supply: ContainmentSupply.nullable(),
  /** Terms so small the containment means little (hardening finding H049), by `CONTAINMENT.weakTerms`. */
  weak: z.object({ goal: z.boolean(), deadline: z.boolean() }),
  /** The Token-2022 group extensions the mint carries, by name: after its unlock some venues may still not accept it (`HOOK-11`). */
  group_extensions: z.array(z.string()),
});
export type ContainedMint = z.infer<typeof ContainedMint>;

/** `GET /v1/markets/{market}/containment`: the market's contained tokens, those whose home market it is, read at one slot. */
export const MarketContainment = z.object({
  market: Address,
  slot: z.number().int(),
  /** The cluster's clock at that slot, Unix seconds: what the deadline is measured against. */
  chain_time: z.number().int(),
  contained: z.array(ContainedMint),
  /** What counts as weak terms, so the panel can say it in words. */
  weak_terms: z.object({ goal_of_quote_reserve_bps: z.number().int(), deadline_min_seconds: z.number().int() }),
});
export type MarketContainment = z.infer<typeof MarketContainment>;

/** `POST /v1/containment/unlock/prepare`: unlock this contained mint, sent and paid for by `trader`. */
export const PrepareUnlockRequest = z.object({ mint: Address, trader: Address }).strict();
export type PrepareUnlockRequest = z.infer<typeof PrepareUnlockRequest>;

/** A prepared `unlock`: its accounts, and the unsigned transaction only when its simulation passed. */
export const PreparedUnlock = z.object({
  mint: Address,
  market: Address,
  accounts: z.array(ResolvedAccount),
  wrapped_sol: Amount,
  transaction: z.string().nullable(),
  simulation: TransactionSimulation,
});
export type PreparedUnlock = z.infer<typeof PreparedUnlock>;
