// The lending AMM's endpoints in Aviary's contract (#88; docs/spec/lending-pool.md, "Aviary's panel"):
// the panel's figures read at one slot, the market's history of the strategy's events, and the
// create form's one-transaction create and first deposit. Amounts are base units as decimal strings,
// as everywhere in the contract.
import { z } from "zod";
import { ResolvedAccount, TransactionSimulation } from "../../contract";

const amount = z.string().regex(/^-?\d+$/);
const address = z.string();

export const LendingKamino = z.object({
  /** Why the program would refuse to read the reserve or its lending market, or null when it reads them. */
  problem: z.string().nullable(),
  utilisation_bps: z.number().nullable(),
  free_liquidity: amount.nullable(),
  supply_rate_bps: z.number().nullable(),
  borrow_rate_bps: z.number().nullable(),
  reserve_emergency: z.boolean().nullable(),
  lending_market_emergency: z.boolean().nullable(),
  block_ctoken_usage: z.boolean().nullable(),
  deprecated: z.boolean().nullable(),
  redeems_stopped: z.boolean().nullable(),
  last_refresh_slot: z.number().nullable(),
  refresh_age_slots: z.number().nullable(),
  withdrawal_cap_remaining: amount.nullable(),
  can_pay: amount,
});

export const LendingSells = z.object({
  refused: z.enum(["market-closed", "reserve-unreadable", "reserve-stale"]).nullable(),
  /** In base units of the other mint, as typed in the trade box (fees on the input included where they are taken there). */
  buffer_alone: amount.nullable(),
  buffer_pays_all: z.boolean(),
  with_kamino: amount.nullable(),
  with_kamino_pays_all: z.boolean(),
  /** The same edges as the strategy is credited them, what goes into the market. */
  into_market: z.object({ buffer_alone: amount.nullable(), with_kamino: amount.nullable() }),
});

export const LendingWallet = z.object({
  wallet: address,
  shares_account: address,
  shares: amount,
  other: amount,
  buffer_part: amount,
  ctoken_part: amount,
  ctoken_value: amount.nullable(),
  cash: z.enum(["yes", "kamino-cannot-pay", "kamino-stopped", "reserve-unreadable", "nothing"]),
  cash_max_shares: amount,
});

export const LendingKeeperRun = z.object({ at: z.string(), outcome: z.string(), signature: z.string().nullable() });

export const LendingPanel = z.object({
  market: address,
  market_state: address,
  program: address,
  slot: z.number(),
  lent_index: z.union([z.literal(0), z.literal(1)]),
  lent_mint: address,
  other_mint: address,
  reserve: address,
  lending_market: address.nullable(),
  collateral_mint: address,
  lp_mint: address,
  ctoken_account: address,
  lock_account: address,
  vaults: z.array(address).length(2),
  reserve_liquidity_supply: address.nullable(),
  /** The launchpad that seeded the market, or null for one created through the router. */
  seeder: address.nullable(),
  lp_fee_bps: z.number(),
  withdraw_mode: z.boolean(),
  exit_seen: z.object({ slot: z.number(), leave_from: z.number() }).nullable(),
  open: z.boolean(),
  buffer: amount,
  other_reserve: amount,
  ctokens: amount,
  lent_value: amount.nullable(),
  lent_total: amount.nullable(),
  buffer_share_bps: z.number().nullable(),
  band: z.enum(["below", "within", "above"]).nullable(),
  band_bps: z.object({ min: z.number(), target: z.number(), max: z.number() }),
  kamino: LendingKamino,
  sells: LendingSells,
  lp: z.object({
    supply: amount.nullable(),
    share_count: amount.nullable(),
    locked: amount,
    minimum_liquidity: amount,
    decimals: z.number(),
    /** What one whole LP share is worth of each side. */
    value_other: amount.nullable(),
    value_lent: amount.nullable(),
  }),
  deposited: amount,
  redeemed: amount,
  yield_so_far: amount.nullable(),
  rebalance: z.object({
    due: z.boolean(),
    deposit: amount.nullable(),
    redeem: amount.nullable(),
    withdraw_mode_after: z.boolean().nullable(),
    refusal: z.string().nullable(),
    /** The keeper runner's last `rebalance` on this market, from its records. */
    keeper_last: LendingKeeperRun.nullable(),
  }),
  wallet: LendingWallet.nullable(),
  created_slot: z.number(),
  created_at: z.string(),
});
export type LendingPanel = z.infer<typeof LendingPanel>;

/** One of the strategy's events on a market (docs/spec/lending-pool.md, "Custom actions and metadata"). */
export const LendingEvent = z.object({
  signature: z.string(),
  slot: z.number(),
  block_time: z.string().nullable(),
  kind: z.enum(["market-created", "market-seeded", "liquidity-added", "liquidity-removed", "lent-side-removed", "shares-locked", "rebalanced", "withdraw-mode-entered", "withdraw-mode-left", "shortfall-redeemed"]),
  /** Who signed for it, where the event names them. */
  account: address.nullable(),
  /** The event's fields as the program emitted them, amounts as decimal strings. */
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
});
export type LendingEvent = z.infer<typeof LendingEvent>;

export const LendingHistory = z.object({ market: address, events: z.array(LendingEvent), next_before: z.string().nullable() });
export type LendingHistory = z.infer<typeof LendingHistory>;

/** The create form (docs/spec/lending-pool.md, "Creating a market"): the router's create_market, its two fee accounts and the first deposit, in one transaction. */
export const PrepareLendingCreate = z.object({
  trader: address,
  other_mint: address,
  lent_mint: address,
  lp_fee_bps: z.number().int().min(0).max(65_535),
  /** The first deposit, which sets the price: base units of each. */
  other_amount: amount,
  lent_amount: amount,
});
export type PrepareLendingCreate = z.infer<typeof PrepareLendingCreate>;

export const PreparedLendingCreate = z.object({
  market: address,
  market_state: address,
  lp_fee_bps: z.number(),
  lent_index: z.number(),
  first_shares: amount,
  wrapped_sol: amount,
  /** The router's `create_market` accounts, as the review lists them. */
  accounts: z.array(ResolvedAccount),
  transaction: z.string().nullable(),
  simulation: TransactionSimulation,
});
export type PreparedLendingCreate = z.infer<typeof PreparedLendingCreate>;

/** `POST /v1/lending-amm/refresh/prepare`: klend's `refresh_reserve` for the market's reserve, which anyone may send. */
export const PrepareRefresh = z.object({ market: address, trader: address }).strict();

export const PreparedRefresh = z.object({
  market: address,
  /** klend's `refresh_reserve` accounts, as the review lists them. */
  accounts: z.array(ResolvedAccount),
  wrapped_sol: amount,
  transaction: z.string().nullable(),
  simulation: TransactionSimulation,
});
export type PreparedRefresh = z.infer<typeof PreparedRefresh>;

/** `GET /v1/lending-amm/create`: what the create form is pre-filled with, from `terminal-api`'s config, and the mints the program lends on this cluster. */
export const LendingCreateForm = z.object({
  program: address,
  lp_fee_bps: z.number(),
  max_lp_fee_bps: z.number(),
  lent_index: z.number(),
  lent_mints: z.array(z.object({ mint: address, decimals: z.number(), reserve: address, collateral_mint: address })),
  minimum_liquidity: amount,
});
export type LendingCreateForm = z.infer<typeof LendingCreateForm>;
