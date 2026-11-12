//! Every policy value of a Canary run, in one place (`CANARY-28`;
//! `docs/spec/pipescope-canary.md`, "One place for every value").
//!
//! Nothing else in the crate writes these numbers: `tests/policy_values.rs` greps the
//! crate's sources for them. A change to any value changes [`HARNESS`], which every Canary
//! result carries, so results made under different rules can be told apart; the same test
//! fails until both change together. When a value changes, the constant, the spec's table,
//! the spec section that explains it and the decision's block in `docs/decisions.md`
//! change in one PR.

/// The Canary version that produced a result (`harness` on every record).
pub const HARNESS: &str = "canary/0.1.0";

// ---------------------------------------------------------------------------------------
// Units (not policy, but written only here so the policy grep has no false friends)
// ---------------------------------------------------------------------------------------

/// Lamports in one SOL.
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
/// The denominator of a parts-per-million figure.
pub const PPM: u64 = 1_000_000;
/// Hundredths in a whole: a percentage's denominator, and a small vault's size unit.
pub const HUNDREDTHS: u64 = 100;
/// Parts per million in one percentage point.
pub const PPM_PER_POINT: u64 = PPM / HUNDREDTHS;

// ---------------------------------------------------------------------------------------
// Sizes (`CANARY-06`, `CANARY-07`)
// ---------------------------------------------------------------------------------------

/// Sizes in a market with wrapped SOL, in lamports: 0.00001, 0.001, 0.01, 0.1, 1 and 10 SOL.
pub const SOL_SIZES: [u64; 6] = [
    LAMPORTS_PER_SOL / 100_000,
    LAMPORTS_PER_SOL / 1_000,
    LAMPORTS_PER_SOL / 100,
    LAMPORTS_PER_SOL / 10,
    LAMPORTS_PER_SOL,
    LAMPORTS_PER_SOL * 10,
];
/// The reference size with wrapped SOL: 0.01 SOL.
pub const SOL_REFERENCE_SIZE: u64 = LAMPORTS_PER_SOL / 100;

/// Sizes without wrapped SOL, in parts per million of the money vault.
pub const VAULT_SIZES_PPM: [u64; 5] = [1, 100, 1_000, 10_000, 50_000];
/// The reference size without wrapped SOL, in parts per million of the money vault.
pub const VAULT_REFERENCE_PPM: u64 = 1_000;

/// A money vault holding fewer units than this is sized in whole tokens instead.
pub const SMALL_VAULT_UNITS: u64 = 2_000_000;
/// Sizes for a small money vault, in hundredths of a whole token: 0.01, 0.1, 1, 10 and 100.
pub const SMALL_VAULT_SIZES_HUNDREDTHS: [u64; 5] = [1, 10, 100, 1_000, 10_000];
/// The reference size for a small money vault, in hundredths of a whole token: 1 token.
pub const SMALL_VAULT_REFERENCE_HUNDREDTHS: u64 = 100;

// ---------------------------------------------------------------------------------------
// Clock positions (`CANARY-08`, `CANARY-09`)
// ---------------------------------------------------------------------------------------

/// Slots a second, as a fraction: 2.5 slots a second is 5 slots every 2 seconds.
pub const SLOTS_PER_SECOND_NUMERATOR: u64 = 5;
pub const SLOTS_PER_SECOND_DENOMINATOR: u64 = 2;
/// Slots in an epoch.
pub const SLOTS_PER_EPOCH: u64 = 432_000;

/// A wait, as the seconds that pass; "the next slot" is a single slot with no seconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    SameSlot,
    NextSlot,
    Seconds(u64),
}

const MINUTE: u64 = 60;
const HOUR: u64 = 60 * MINUTE;
const DAY: u64 = 24 * HOUR;

/// The waits after which a buyer sells or a trader arrives.
pub const WAITS: [(&str, Wait); 9] = [
    ("same slot", Wait::SameSlot),
    ("next slot", Wait::NextSlot),
    ("10 seconds", Wait::Seconds(10)),
    ("1 minute", Wait::Seconds(MINUTE)),
    ("10 minutes", Wait::Seconds(10 * MINUTE)),
    ("1 hour", Wait::Seconds(HOUR)),
    ("1 day", Wait::Seconds(DAY)),
    ("3 days", Wait::Seconds(3 * DAY)),
    ("30 days", Wait::Seconds(30 * DAY)),
];

/// Launch-clock positions, as seconds after the market's creation.
pub const LAUNCH_CLOCK_SECONDS: [(&str, u64); 6] = [
    ("creation", 0),
    ("10 seconds", 10),
    ("1 minute", MINUTE),
    ("10 minutes", 10 * MINUTE),
    ("1 hour", HOUR),
    ("1 day", DAY),
];

// ---------------------------------------------------------------------------------------
// Outcomes (`CANARY-12`, `CANARY-13`)
// ---------------------------------------------------------------------------------------

/// The pass band: a round trip returning this share or more of what was put in.
pub const PASS_BAND_MIN_PPM: u64 = 950_000;
/// The fail band: a round trip returning less than this share of what was put in.
pub const FAIL_BAND_BELOW_PPM: u64 = 500_000;
/// The tolerance over time: a return more than this much less than the reference warns.
pub const TOLERANCE_PPM: u64 = PPM_PER_POINT;

// ---------------------------------------------------------------------------------------
// Wallets and token authorities (`CANARY-16`, `CANARY-17`)
// ---------------------------------------------------------------------------------------

/// Fresh wallets in `exit_wallets`.
pub const FRESH_WALLETS: usize = 5;
/// Buyers in `exit_queue`.
pub const QUEUE_BUYERS: usize = 5;
/// A mint authority mints this many times what the market's vault holds, then sells it.
pub const MINT_AUTHORITY_MULTIPLE: u64 = 100;
/// A transfer-fee authority sets this fee, in basis points, with no maximum.
pub const TRANSFER_FEE_ACTING_BPS: u16 = 10_000;
/// Epochs the clock moves on so a new transfer fee applies.
pub const TRANSFER_FEE_EPOCHS_ON: u64 = 2;

// ---------------------------------------------------------------------------------------
// Failures and snapshots (`CANARY-14`, `CANARY-25`)
// ---------------------------------------------------------------------------------------

/// The compute limit of a read-only strategy call (market info, account resolution and a
/// quote); running out of it is "out of compute".
pub const QUOTE_COMPUTE_LIMIT: u32 = 200_000;
/// The compute limit of a swap.
pub const SWAP_COMPUTE_LIMIT: u32 = 1_400_000;

/// Snapshots the endpoint is posted before checks that still lack accounts are "not run".
pub const SNAPSHOT_ROUNDS: u32 = 4;

/// The largest snapshot the endpoint accepts, in bytes: room for the router's and a large
/// strategy's ProgramData, base64, with every account a market's trades touch.
pub const SNAPSHOT_MAX_BYTES: usize = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------------------
// Operations (not policy: they change how a run reads, never what it finds)
// ---------------------------------------------------------------------------------------

/// Tries of a whole RPC read on a developer's machine, on top of the retries
/// `pipeline-check`'s RPC client makes itself: public devnet sometimes sends a body that
/// cannot be read, or drops the connection, which that client does not retry.
pub const RPC_READ_ATTEMPTS: u32 = 3;
/// Accounts in one `getMultipleAccounts`, as `pipeline-check`'s RPC client sends them; used
/// only to count the calls a run makes.
pub const RPC_ACCOUNTS_PER_CALL: usize = 100;
/// The wait before the first retry of a read, doubled before each later one.
pub const RPC_READ_RETRY_MS: u64 = 2_000;
