// The buy wall AMM's values in Aviary, in one place (docs/spec/pool4-for-solana.md, Constants, "each
// policy value lives in exactly one place"; #57): the create form's pre-filled values and how often
// the panel reads the market again. Each is a default MetalLegBob may change (POOL4-53, POOL4-54).

/**
 * What the create form starts with, in the units of the strategy's create form (basis points). The
 * fee, the reward share, the cap floor and the cap decay are IMD's own launch values for Pool4: a 1%
 * fee, a 15% reward share, a cap floor of 20% and a cap decay of 20% a day (POOL4-53). The buy wall
 * split has no IMD value, since IMD's hook sends the market's part elsewhere; half to the wall is the
 * worked example's (POOL4-54). The recipients and the seeder start as the connected wallet.
 */
export const CREATE_FORM_DEFAULTS = {
  fee_bps: 100,
  wall_split_bps: 5_000,
  reward_share_bps: 1_500,
  cap_floor_bps: 2_000,
  cap_decay_bps: 2_000,
} as const;

/** The panel and the forms read the market's state again this often while the page is open, besides after each trade and each of their own transactions. */
export const BUY_WALL_REFRESH_MS = 30_000;
/** Trades arriving together are answered by one read, this long after the last of them. */
export const BUY_WALL_TRADE_PAUSE_MS = 1_500;
