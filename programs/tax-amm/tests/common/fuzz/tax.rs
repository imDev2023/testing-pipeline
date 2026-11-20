//! The tax AMM under the invariant fuzzer (docs/spec/tax-amm.md, "Invariants"; docs/spec/
//! README.md, "Test layers" 3 and 5).
//!
//! **Markets** of every shape: the tax side at either index; SPL Token, Token-2022, a
//! Token-2022 mint with Pipeline's allow-all `test-hook` as its transfer hook, and SPL
//! Token's native SOL; any rates inside any ranges; one to four tax recipients, with and
//! without a burn share; with and without a tax authority; with and without a virtual
//! reserve, seeded on both sides or single-sided; created and seeded in one transaction,
//! created and left for a `seed` step, or created and seeded by the stand-in launchpad
//! through `pipeline_seed_liquidity`.
//!
//! **Steps**: swaps both ways through the router, from dust to many times a reserve and
//! every holder's whole holding; `seed`; `distribute` for every slot and slot numbers past
//! the last; `set_taxes`, `set_recipients` and `renounce_tax_authority`; tokens sent
//! straight to a vault; clock jumps; and the same calls from wallets with no right to make
//! them, a direct `pipeline_swap` that bypasses the router among them. Every sequence ends
//! with every wallet that holds anything selling all of it, one after another.
//!
//! **Invariants**, after every step: the bar's three shared ones and the tax AMM's seven, in
//! the spec's order ([`INVARIANTS`]), then two checks the bar adds: each step's outcome is
//! the one the spec gives, to the unit (`common/model.rs` writes the spec's formulas out
//! again), and each instruction's compute stays under its ceiling (`common/ceilings.rs`).

use std::cell::RefCell;
use std::collections::BTreeMap;

use pipeline_client::interface::fees::amount_for_budget;
use pipeline_client::interface::{QuoteResult, SwapRequest};
use pipeline_client::{pda, AccountMeta, Pubkey, SwapResult};
use proptest::prelude::*;
use proptest::strategy::BoxedStrategy;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::config::{MAX_RECIPIENTS, MAX_TAX_BPS, SUITE_TREASURY};
use tax_amm::params::NATIVE_MINTS;
use tax_amm::state::{MarketStatus, BURN_SLOT, OWED_SLOTS, SUITE_SLOT};
use tax_amm::{InitParams, TaxMarket};

use super::super::authority::{
    renounce_instruction, set_recipients_instruction, set_taxes_instruction, Split,
};
use super::super::model::{Model, Refusal};
use super::super::*;
use super::{Checked, Invariant, Product};

/// The names of the ten invariants, the bar's three then the spec's seven, in order.
pub const INVARIANTS: [&str; 10] = [
    "value_is_conserved",
    "every_holder_can_exit",
    "each_quote_equals_its_swap",
    "vaults_cover_the_market",
    "swaps_keep_the_curve",
    "every_tax_is_split_exactly",
    "rates_stay_in_range_and_creation_is_fixed",
    "only_swaps_move_reserves_and_counters",
    "counters_never_fall",
    "a_renounced_market_never_changes",
];

/// Sequences a plain `cargo test` runs, and the most steps in one: the ticket's floor for
/// CI. `PROPTEST_CASES` and `FUZZ_STEPS` change them.
pub const DEFAULT_CASES: u32 = 1_000;
pub const DEFAULT_STEPS: usize = 50;

/// Traders in every world, besides the stranger and the recipient wallets.
const TRADERS: usize = 3;
/// Wallets tax recipients are chosen from, at creation and by `set_recipients`.
const POOL: usize = 6;

/// The tax AMM's product for the harness.
pub struct TaxAmm;

/// What kind of mint one side of a market is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MintKind {
    SplToken,
    Token2022,
    /// Token-2022 with Pipeline's `test-hook`, which approves every transfer, as its hook.
    Hooked,
    /// SPL Token's native SOL mint, which can't be burned.
    NativeSol,
    /// A Token-2022 mint a product built on this one creates through its [`Surroundings`],
    /// such as the containment hook's contained mint; this product's shapes never choose it.
    Outside,
}

/// How the market comes to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Creation {
    /// The router's `create_market` and the seed, as Aviary's launch form sends them.
    CreateAndSeed,
    /// Created only; a `seed` step opens it, if one comes.
    CreateOnly,
    /// Created and seeded by the stand-in launchpad through `pipeline_seed_liquidity`, then
    /// recorded with the router's `register_existing_market`.
    Launchpad,
}

/// One market's shape.
#[derive(Clone, Debug)]
pub struct Shape {
    pub mints: [MintKind; 2],
    pub tax_side: u8,
    /// The buy tax's then the sell tax's `[min, max]`.
    pub ranges: [[u16; 2]; 2],
    /// The buy tax, then the sell tax.
    pub rates: [u16; 2],
    /// Tax recipients, 1 to 4.
    pub recipients: u8,
    /// Each recipient's weight, then the burn's, turned into shares that sum to 10,000.
    pub weights: [u16; 5],
    pub burn: bool,
    pub tax_authority: bool,
    pub virtual_side: u8,
    /// 0 for none.
    pub virtual_reserve: u64,
    /// What the seed brings, by mint; 0 on the virtual side for a single-sided launch.
    pub seed: [u64; 2],
    pub creation: Creation,
    /// Every key the world creates derives from this, so a printed case replays exactly.
    pub keys: u64,
}

/// Who signs an action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Who {
    /// The market's tax authority, or, on a market without one, a wallet with no rights.
    TaxAuthority,
    /// The market's seeder, or, on a launchpad's market, the launch's creator.
    Seeder,
    /// A trader, a stranger or a recipient wallet, by index (modulo how many there are).
    Wallet(u8),
}

/// How much of something a step moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Size {
    /// A few units.
    Dust(u16),
    /// `mantissa × 10^exp` millionths of the reserve it acts on: from a millionth to many
    /// times the reserve.
    Part { mantissa: u8, exp: u8 },
    /// Everything the wallet holds.
    All,
}

/// A rate `set_taxes` sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rate {
    /// So many thousandths of the way through the rate's current range.
    Within(u16),
    /// Exactly these basis points, inside the range or not.
    Exactly(u16),
}

/// How a `set_recipients` step breaks the split rules, if it does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flaw {
    /// It keeps every rule.
    Whole,
    /// A used recipient slot left empty before another used one.
    Gap,
    /// A used recipient's share moved to the first recipient, leaving it 0.
    ZeroShare,
    /// One basis point of the first recipient's share given to the slot after the used ones.
    StrayShare,
    /// So many basis points added to the first recipient's share, past the whole.
    Skew(u16),
}

// The variants by their bare names: the harness prints a minimal failing case with `{:#?}`,
// which leaves enum paths out, so it pastes into a regression test under
// `use harness::fuzz::tax::*` as printed.
#[allow(unused_imports)]
pub use {Creation::*, Flaw::*, MintKind::*, Rate::*, Size::*, Step::*, Who::*};

/// What a product built on this one adds to a world as [`TaxWorld::new_in`] builds it: the
/// mint of each side whose kind is [`MintKind::Outside`], and what happens between the
/// market's creation and its seed (for the containment hook, the contained mint and `bind`,
/// which must come before any of the token moves). A launchpad seeds its market in the
/// transaction that creates it, so a shape with an outside mint is never a launchpad's.
pub trait Surroundings {
    /// Creates the mint of a side whose kind is [`MintKind::Outside`] at `at`'s address, a
    /// Token-2022 mint.
    fn create_mint(&self, env: &mut Env, at: &Keypair) -> Pubkey;
    /// Runs once the market exists, before its seed.
    fn before_seed(&self, env: &mut Env, market: &Market) -> Result<(), String>;
}

/// The tax AMM's own worlds, with nothing built around them.
pub struct Nothing;

impl Surroundings for Nothing {
    fn create_mint(&self, _: &mut Env, _: &Keypair) -> Pubkey {
        panic!("the tax AMM's shapes never choose an outside mint")
    }

    fn before_seed(&self, _: &mut Env, _: &Market) -> Result<(), String> {
        Ok(())
    }
}

/// One thing anyone can do to a tax market.
#[derive(Clone, Debug)]
pub enum Step {
    /// A wallet quotes, then swaps through the router with the quote as its minimum.
    Swap {
        wallet: u8,
        input: u8,
        size: Size,
    },
    /// The seed action, with one side left empty when `empty_side` says so.
    Seed {
        who: Who,
        empty_side: Option<u8>,
    },
    /// `distribute` for `slot`, paid for by a wallet, to the slot's wallet or another one.
    Distribute {
        slot: u8,
        caller: u8,
        wrong_wallet: bool,
    },
    SetTaxes {
        who: Who,
        buy: Rate,
        sell: Rate,
    },
    /// `set_recipients` with the first `used` of `picks` from the recipient wallets, shares
    /// from `weights`, and a burn share when `burn`, broken as `flaw` says.
    SetRecipients {
        who: Who,
        used: u8,
        picks: [u8; MAX_RECIPIENTS],
        weights: [u16; 5],
        burn: bool,
        flaw: Flaw,
    },
    Renounce {
        who: Who,
    },
    /// The stranger sends tokens straight to a vault.
    Donate {
        side: u8,
        size: Size,
    },
    /// The clock moves on.
    Warp {
        slots: u32,
        seconds: u32,
    },
    /// The stranger calls `pipeline_swap` directly, signing as the market signer.
    Bypass {
        input: u8,
    },
}

/// What a step tried.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// The world as built.
    Start,
    Swap {
        input: usize,
        output: usize,
        amount: u64,
        all: bool,
    },
    Seed,
    Distribute {
        slot: u8,
    },
    SetTaxes,
    SetRecipients,
    Renounce,
    Donate {
        side: usize,
    },
    Warp,
    Bypass,
    /// Nothing to do, such as a swap by a wallet that holds nothing.
    Skip,
    /// A step of a product built on this one, which runs no tax AMM instruction.
    Outside,
}

/// A swap step's quote, swap and price by the spec.
#[derive(Clone, Debug)]
pub struct SwapOutcome {
    pub quote: Result<u64, String>,
    pub swap: Result<SwapResult, String>,
    /// The spec's price, or the name of the error it refuses with.
    pub model: Result<u64, String>,
}

/// What a step did.
#[derive(Clone, Debug)]
pub struct Outcome {
    pub action: Action,
    /// What the spec says happens: success, or the name of the error.
    pub expected: Result<(), String>,
    /// What happened: success, or the error's name (the whole failure when it has none).
    pub result: Result<(), String>,
    pub swap: Option<SwapOutcome>,
    /// The compute each tax AMM instruction the step ran consumed, less what its bump
    /// searches spent beyond each address's first bump, which the ceilings leave out.
    pub costs: Vec<(&'static str, u64)>,
    /// What those bump searches spent beyond each address's first bump.
    pub bump_search: u64,
    /// The logs of the last transaction the step sent, for a product built on this one to
    /// read (the containment hook reads its own compute from them).
    pub logs: Vec<String>,
}

impl Outcome {
    /// The outcome of a step of a product built on this one (see the harness's "Adding a
    /// product's steps and invariants").
    pub fn outside() -> Outcome {
        Outcome::of(Action::Outside, Ok(()), Ok(()))
    }

    fn of(action: Action, expected: Result<(), String>, result: Result<(), String>) -> Outcome {
        Outcome {
            action,
            expected,
            result,
            swap: None,
            costs: vec![],
            bump_search: 0,
            logs: vec![],
        }
    }

    /// What the step was and how it ended, such as `swap: settled` or `distribute:
    /// UnusedSlot`, for the run's tally.
    pub fn label(&self) -> String {
        let action = match self.action {
            Action::Start => "start",
            Action::Swap { all: true, .. } => "swap of a whole holding",
            Action::Swap { .. } => "swap",
            Action::Seed => "seed",
            Action::Distribute { slot } if slot == BURN_SLOT => "distribute to the burn",
            Action::Distribute { slot } if slot == SUITE_SLOT => "distribute to the suite share",
            Action::Distribute { .. } => "distribute",
            Action::SetTaxes => "set_taxes",
            Action::SetRecipients => "set_recipients",
            Action::Renounce => "renounce_tax_authority",
            Action::Donate { .. } => "donation",
            Action::Warp => "clock jump",
            Action::Bypass => "bypass",
            Action::Skip => "skipped",
            Action::Outside => "outside",
        };
        match &self.result {
            Ok(()) => format!("{action}: settled"),
            Err(name) => format!("{action}: {}", name.lines().next().unwrap_or_default()),
        }
    }

    /// Whether this step was a router swap that settled.
    pub fn swapped(&self) -> bool {
        matches!(self.action, Action::Swap { .. }) && self.result.is_ok()
    }
}

/// What the invariants compare before and after a step.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub state: TaxMarket,
    pub vaults: [u64; 2],
    /// Everything every known account holds, by mint: wallets, vaults, Pipeline's fee
    /// accounts, the launchpad's escrows and [`TaxWorld::other_accounts`].
    pub held: [u128; 2],
    pub supply: [u64; 2],
    /// What each of [`TaxWorld::wallets`] holds of each mint.
    pub holdings: Vec<[u64; 2]>,
    /// The market state account's bytes, to tell whether a step changed it.
    pub state_data: Vec<u8>,
}

/// One fuzzed market and everyone around it.
pub struct TaxWorld {
    pub env: Env,
    pub shape: Shape,
    pub market: Market,
    pub traders: Vec<Keypair>,
    /// A wallet with no role, which donates, bypasses and tries what it may not.
    pub stranger: Keypair,
    /// The tax authority if the market has one, else a wallet with no rights.
    pub tax_authority: Keypair,
    /// The seeder; on a launchpad's market, the launch's creator, who is not the seeder.
    pub seeder: Keypair,
    /// The launchpad's seeder PDA, which owns its escrows.
    pub launch_seeder: Option<Pubkey>,
    pub pool: Vec<Keypair>,
    /// Every token the world wrote into accounts, by mint.
    pub created: [u128; 2],
    /// What the burn slot was owed each time it was paid out, by mint.
    pub burned: [u128; 2],
    /// Every token sent straight to each vault.
    pub donated: [u128; 2],
    /// Every token `distribute` took out of the tax-side vault, burns included.
    pub paid_out: u128,
    /// The market state as created.
    pub created_state: TaxMarket,
    /// Token accounts a product built on this one adds, each with the index of its mint,
    /// counted among the known accounts that value conservation sums.
    pub other_accounts: Vec<(usize, Pubkey)>,
    /// The strategy accounts a swap in each direction needs, `[0 -> 1, 1 -> 0]`.
    resolved: [Vec<AccountMeta>; 2],
    /// The most compute each instruction took, but for invocations that called a transfer
    /// hook ([`own_compute`]).
    pub max_costs: BTreeMap<&'static str, u64>,
    /// How many quotes [`TaxWorld::quote`] has simulated.
    pub quotes_simulated: std::cell::Cell<u64>,
    /// How many steps did what, by [`Outcome::label`].
    pub tally: BTreeMap<String, u32>,
}

thread_local! {
    /// The router configured and the tax AMM, `test-hook` and the stand-in launchpad loaded
    /// and registered, once per thread; every world starts from a copy.
    static BASE: RefCell<Option<Env>> = const { RefCell::new(None) };
}

/// A copy of the thread's base VM.
pub fn fresh_env() -> Env {
    BASE.with(|base| {
        let mut base = base.borrow_mut();
        let base = base.get_or_insert_with(|| {
            let mut env = Env::new();
            env.add_test_hook();
            env.add_launchpad();
            env
        });
        Env {
            svm: base.svm.clone(),
            admin: base.admin.insecure_clone(),
        }
    })
}

/// The keypair a world of `keys` gives the `index`th holder of `role`. The roles below 64
/// are this product's ([`role`]); a product built on this one takes its own from 64 up.
pub fn key(keys: u64, role: u8, index: usize) -> Keypair {
    let mut secret = [0u8; 32];
    secret[..8].copy_from_slice(&keys.to_le_bytes());
    secret[8] = role;
    secret[9] = index as u8;
    secret[31] = 1;
    Keypair::new_from_array(secret)
}

/// The roles [`key`] derives keys for.
mod role {
    pub const TRADER: u8 = 0;
    pub const STRANGER: u8 = 1;
    pub const TAX_AUTHORITY: u8 = 2;
    pub const RECIPIENT: u8 = 3;
    pub const SEEDER: u8 = 4;
    pub const MINT: u8 = 5;
    pub const MARKET_STATE: u8 = 6;
    pub const LAUNCH_CREATOR: u8 = 7;
}

/// `mantissa × 10^exp` for `exp` in the range, shrinking towards small numbers.
fn amount(exps: std::ops::RangeInclusive<u32>) -> impl Strategy<Value = u64> {
    (1u64..10, exps).prop_map(|(mantissa, exp)| mantissa * 10u64.pow(exp))
}

fn size() -> impl Strategy<Value = Size> {
    prop_oneof![
        1 => (1..=1_000u16).prop_map(Size::Dust),
        6 => (1..10u8, 0..=7u8).prop_map(|(mantissa, exp)| Size::Part { mantissa, exp }),
        1 => Just(Size::All),
    ]
}

fn who() -> impl Strategy<Value = Who> {
    prop_oneof![
        6 => Just(Who::TaxAuthority),
        1 => Just(Who::Seeder),
        2 => any::<u8>().prop_map(Who::Wallet),
    ]
}

/// A rate for `set_taxes`: mostly inside its range, sometimes anything up to past the cap.
fn rate() -> impl Strategy<Value = Rate> {
    prop_oneof![
        4 => (0..=1_000u16).prop_map(Rate::Within),
        1 => (0..=MAX_TAX_BPS + 100).prop_map(Rate::Exactly),
    ]
}

/// Mostly a split that keeps every rule, sometimes one that breaks one.
fn flaw() -> impl Strategy<Value = Flaw> {
    prop_oneof![
        12 => Just(Flaw::Whole),
        1 => Just(Flaw::Gap),
        1 => Just(Flaw::ZeroShare),
        1 => Just(Flaw::StrayShare),
        1 => (1..500u16).prop_map(Flaw::Skew),
    ]
}

/// A tax range and a rate inside it.
fn range_and_rate() -> impl Strategy<Value = ([u16; 2], u16)> {
    (0..=MAX_TAX_BPS, 0..=MAX_TAX_BPS, 0..=100u16).prop_map(|(a, b, at)| {
        let (min, max) = (a.min(b), a.max(b));
        (
            [min, max],
            min + ((max - min) as u32 * at as u32 / 100) as u16,
        )
    })
}

/// Shares from weights: each used recipient's and the burn's (when it has one), in basis
/// points summing to exactly 10,000, the rounding remainder to the first recipient.
fn shares_of(used: usize, weights: &[u16; 5], burn: bool) -> ([u16; MAX_RECIPIENTS], u16) {
    let burn_weight = if burn { weights[4] as u32 } else { 0 };
    let total: u32 = weights[..used].iter().map(|&w| w as u32).sum::<u32>() + burn_weight;
    let mut shares = [0u16; MAX_RECIPIENTS];
    for k in 0..used {
        shares[k] = (10_000 * weights[k] as u32 / total) as u16;
    }
    let burn_share = (10_000 * burn_weight / total) as u16;
    let sum: u16 = shares.iter().sum::<u16>() + burn_share;
    shares[0] += 10_000 - sum;
    (shares, burn_share)
}

/// The tax AMM's refusal in a refused transaction, by the name the spec gives it
/// ([`refusal_by`]).
pub fn refusal(failure: &str) -> String {
    refusal_by(failure, &strategy_id())
}

/// The name of the error that refused a transaction, when `program` raised it: the program
/// whose failure comes first in the logs, the innermost, failed with that error's number.
/// An Anchor error another program raised is `<name> from <program>`, so it can never pass
/// for one of `program`'s under the same name (hardening finding T01, #67). A token
/// program's refusal of a transfer bigger than its source holds is `InsufficientFunds`;
/// anything else is the whole failure.
pub fn refusal_by(failure: &str, program: &Pubkey) -> String {
    let anchor = failure.split("Error Code: ").nth(1).and_then(|rest| {
        let name = rest.split('.').next()?;
        let number = rest
            .split("Error Number: ")
            .nth(1)?
            .split('.')
            .next()?
            .parse::<u32>()
            .ok()?;
        Some((name, number))
    });
    // `Program <id> failed: custom program error: 0x<code>`, from the innermost failure.
    let raised = failure.lines().find_map(|line| {
        let rest = line.strip_prefix("Program ")?;
        let (id, code) = rest.split_once(" failed: custom program error: 0x")?;
        Some((id, u32::from_str_radix(code.trim(), 16).ok()?))
    });
    match (anchor, raised) {
        (Some((name, number)), Some((id, code))) if number == code => {
            if id == program.to_string() {
                name.to_string()
            } else {
                format!("{name} from {id}")
            }
        }
        _ if failure.contains("Program log: Error: insufficient funds") => {
            "InsufficientFunds".to_string()
        }
        _ => failure.to_string(),
    }
}

fn named<T>(result: &Result<T, String>) -> Result<(), String> {
    match result {
        Ok(_) => Ok(()),
        Err(failure) => Err(refusal(failure)),
    }
}

/// The spec's order of refusals for the tax authority's actions ("Tax authority").
fn authorization(state: &TaxMarket, signer: &Pubkey) -> Result<(), String> {
    if state.tax_authority_renounced {
        Err("AlreadyRenounced".into())
    } else if state.tax_authority == Default::default() {
        Err("NoTaxAuthority".into())
    } else if ck(&state.tax_authority) != *signer {
        Err("NotTaxAuthority".into())
    } else {
        Ok(())
    }
}

/// The creation rules on a split, in the order "Creation parameters" and "Tax authority"
/// give them, then `set_recipients`' own rule on emptied slots still owed tax.
fn split_refusal(
    recipients: &[Pubkey; MAX_RECIPIENTS],
    shares: &[u16; MAX_RECIPIENTS],
    burn_share_bps: u16,
    native_tax_mint: bool,
    owed: &[u64; OWED_SLOTS],
) -> Result<(), String> {
    let used = recipients
        .iter()
        .take_while(|recipient| **recipient != Pubkey::default())
        .count();
    let total: u32 = shares.iter().map(|&share| share as u32).sum::<u32>() + burn_share_bps as u32;
    let refusal = if used == 0 {
        "NoRecipient"
    } else if recipients[used..].iter().any(|r| *r != Pubkey::default()) {
        "RecipientsOutOfOrder"
    } else if shares[..used].contains(&0) {
        "ZeroShare"
    } else if shares[used..].iter().any(|&share| share != 0) {
        "ShareWithoutRecipient"
    } else if total != 10_000 {
        "SharesNotWhole"
    } else if burn_share_bps > 0 && native_tax_mint {
        "BurnOnNativeSol"
    } else if owed[used..MAX_RECIPIENTS].iter().any(|&o| o > 0) {
        "OwedSlotLeftEmpty"
    } else {
        return Ok(());
    };
    Err(refusal.into())
}

/// The spec's price of a trade, or the name of the error it refuses with.
fn spec_price(state: &TaxMarket, input: usize, output: usize, amount: u64) -> Result<u64, String> {
    if state.status != MarketStatus::Open {
        return Err("MarketNotOpen".into());
    }
    match Model::of(state).price(input, output, amount) {
        Ok(trade) => Ok(trade.out),
        Err(Refusal::ZeroOutput) => Err("ZeroOutput".into()),
        Err(Refusal::BeyondRealReserve) => Err("InsufficientLiquidity".into()),
    }
}

/// The product of a market's effective reserves, in 256 bits.
fn curve_product(state: &TaxMarket) -> [u64; 8] {
    let effective = |side: usize| {
        let virtual_part = if state.virtual_side as usize == side {
            state.virtual_reserve
        } else {
            0
        };
        state.reserves[side] as u128 + virtual_part as u128
    };
    super::super::wide::wide_mul(effective(0), effective(1))
}

fn total_owed(state: &TaxMarket) -> u128 {
    state.owed.iter().map(|&owed| owed as u128).sum()
}

impl TaxWorld {
    /// Builds a world of `shape`.
    pub fn new(shape: &Shape) -> Result<TaxWorld, String> {
        Self::new_in(fresh_env(), shape, &Nothing)
    }

    /// Builds a world of `shape` in `env` (a copy of [`fresh_env`] with whatever else a
    /// product built on this one loads), with `surroundings` creating its outside mints and
    /// acting before the seed.
    pub fn new_in(
        mut env: Env,
        shape: &Shape,
        surroundings: &dyn Surroundings,
    ) -> Result<TaxWorld, String> {
        let keys = shape.keys;
        let mut mint_index = 0;
        let mints = shape.mints.map(|kind| {
            let at = key(keys, role::MINT, mint_index);
            mint_index += 1;
            match kind {
                MintKind::SplToken => (
                    env.create_mint_at(&at, &TOKEN, MintOptions::default()),
                    TOKEN,
                ),
                MintKind::Token2022 => (
                    env.create_mint_at(&at, &TOKEN_2022, MintOptions::default()),
                    TOKEN_2022,
                ),
                MintKind::Hooked => (env.create_mint_with_test_hook_at(&at), TOKEN_2022),
                MintKind::NativeSol => (env.write_native_mint(&NATIVE_MINTS[0], &TOKEN), TOKEN),
                MintKind::Outside => (surroundings.create_mint(&mut env, &at), TOKEN_2022),
            }
        });
        let traders: Vec<Keypair> = (0..TRADERS).map(|k| key(keys, role::TRADER, k)).collect();
        let stranger = key(keys, role::STRANGER, 0);
        let tax_authority = key(keys, role::TAX_AUTHORITY, 0);
        let pool: Vec<Keypair> = (0..POOL).map(|k| key(keys, role::RECIPIENT, k)).collect();
        let used = shape.recipients as usize;
        let (shares, burn_share_bps) = shares_of(used, &shape.weights, shape.burn);
        let mut recipients = [Default::default(); MAX_RECIPIENTS];
        for (k, recipient) in recipients.iter_mut().take(used).enumerate() {
            *recipient = ak(&pool[k].pubkey());
        }
        let mut seeder = key(keys, role::SEEDER, 0);
        let mut params = InitParams {
            tax_side: shape.tax_side,
            buy_tax_bps: shape.rates[0],
            sell_tax_bps: shape.rates[1],
            buy_tax_min_bps: shape.ranges[0][0],
            buy_tax_max_bps: shape.ranges[0][1],
            sell_tax_min_bps: shape.ranges[1][0],
            sell_tax_max_bps: shape.ranges[1][1],
            tax_authority: if shape.tax_authority {
                ak(&tax_authority.pubkey())
            } else {
                Default::default()
            },
            seeder: ak(&seeder.pubkey()),
            recipients,
            shares,
            burn_share_bps,
            virtual_side: shape.virtual_side,
            virtual_reserve: shape.virtual_reserve,
        };
        let mut created = shape.seed.map(|seed| seed as u128);
        let mut costs = vec![];
        let mut launch_seeder = None;
        let market = match shape.creation {
            Creation::CreateAndSeed | Creation::CreateOnly => {
                let market = env.create_tax_market_with(
                    &key(keys, role::MARKET_STATE, 0),
                    mints,
                    init_data(&params),
                )?;
                costs.extend(creation_costs(&market.created.logs, "pipeline_init_market"));
                surroundings.before_seed(&mut env, &market)?;
                env.fund(&seeder.pubkey(), &market, shape.seed);
                if shape.creation == Creation::CreateAndSeed {
                    let seeded = env.seed(&market, &seeder, shape.seed)?;
                    costs.extend(costs_of(&seeded.logs, "seed"));
                }
                market
            }
            Creation::Launchpad if shape.mints.contains(&MintKind::Outside) => {
                return Err(
                    "a launchpad seeds in creation, before an outside mint's surroundings can act"
                        .into(),
                );
            }
            Creation::Launchpad => {
                let launch = env.launch_by(key(keys, role::LAUNCH_CREATOR, 0), mints, shape.seed);
                params.seeder = ak(&launch.seeder);
                let graduated = env.graduate(&launch, &params, shape.seed)?;
                costs.extend(creation_costs(
                    &graduated.market.created.logs,
                    "pipeline_seed_liquidity",
                ));
                launch_seeder = Some(launch.seeder);
                seeder = launch.creator;
                graduated.market
            }
        };
        // Enough to trade many times either reserve, and never more of a mint than a u64.
        let holding = [0, 1].map(|i| {
            let side = shape.seed[i] as u128
                + if shape.virtual_side as usize == i {
                    shape.virtual_reserve as u128
                } else {
                    0
                };
            (side * 50).clamp(1_000_000, 100_000_000_000_000_000) as u64
        });
        for wallet in traders.iter().chain([&stranger]) {
            env.fund(&wallet.pubkey(), &market, holding);
            for i in 0..2 {
                created[i] += holding[i] as u128;
            }
        }
        // Recipient wallets and the tax authority pay for transactions and token accounts.
        for wallet in pool.iter().chain([&tax_authority, &seeder]) {
            // A second airdrop of the same amount in one blockhash would be the same
            // transaction again.
            env.svm.expire_blockhash();
            env.svm.airdrop(&wallet.pubkey(), SOL).unwrap();
        }
        // A burn needs a supply behind the balances the world wrote.
        for ((kind, mint), total) in shape.mints.iter().zip(&market.mints).zip(created) {
            if *kind != MintKind::NativeSol {
                env.set_supply(mint, total as u64);
            }
        }
        let resolved = [(0, 1), (1, 0)].map(|(i, o)| {
            env.resolve_accounts(&market, &exact_in(i, o, 1))
                .expect("the swap accounts")
                .into_iter()
                .map(|account| AccountMeta::new_readonly(account.pubkey, false))
                .collect()
        });
        let created_state = env.tax_market(&market.market_state);
        let mut world = TaxWorld {
            env,
            shape: shape.clone(),
            market,
            traders,
            stranger,
            tax_authority,
            seeder,
            launch_seeder,
            pool,
            created,
            burned: [0, 0],
            donated: [0, 0],
            paid_out: 0,
            created_state,
            other_accounts: vec![],
            resolved,
            max_costs: BTreeMap::new(),
            quotes_simulated: Default::default(),
            tally: BTreeMap::new(),
        };
        world.record(&costs);
        Ok(world)
    }

    /// Every wallet that can hold the market's tokens, signers first: the traders, the
    /// stranger, the recipient wallets and the seeder (or launch creator), then the tax
    /// authority, the suite treasury and the launchpad's seeder PDA.
    pub fn wallets(&self) -> Vec<Pubkey> {
        let mut wallets: Vec<Pubkey> = self.signers().iter().map(|k| k.pubkey()).collect();
        wallets.push(self.tax_authority.pubkey());
        wallets.push(ck(&SUITE_TREASURY));
        wallets.extend(self.launch_seeder);
        wallets
    }

    /// The wallets whose keys the world holds and that trade: the traders, the stranger, the
    /// recipient wallets and the seeder.
    pub fn signers(&self) -> Vec<&Keypair> {
        self.traders
            .iter()
            .chain([&self.stranger])
            .chain(&self.pool)
            .chain([&self.seeder])
            .collect()
    }

    fn signer(&self, who: Who) -> &Keypair {
        match who {
            Who::TaxAuthority => &self.tax_authority,
            Who::Seeder => &self.seeder,
            Who::Wallet(k) => {
                let signers = self.signers();
                signers[k as usize % signers.len()]
            }
        }
    }

    /// What `wallet` holds of mint `i`.
    pub fn holding(&self, wallet: &Pubkey, i: usize) -> u64 {
        let account = pda::associated_token(
            wallet,
            &self.market.mints[i],
            &self.market.token_programs[i],
        );
        self.env.balance_or_zero(&account)
    }

    /// Pipeline's fee account for mint `i`.
    pub fn fee_account(&self, i: usize) -> Pubkey {
        pda::fee_account(
            &self.market.market,
            &self.market.mints[i],
            &self.market.token_programs[i],
        )
    }

    pub fn state(&self) -> TaxMarket {
        self.env.tax_market(&self.market.market_state)
    }

    /// `pipeline_quote` of `amount` from `input`, in simulation, with its compute.
    pub fn quote(&self, input: usize, amount: u64) -> (Result<QuoteResult, String>, Option<u64>) {
        self.quotes_simulated.set(self.quotes_simulated.get() + 1);
        let trade = exact_in(input, 1 - input, amount);
        let mut accounts = self.env.read_accounts(&self.market, &trade);
        accounts.extend(self.resolved[input].iter().cloned());
        let call = strategy_call(
            pipeline_client::interface::discriminator::QUOTE,
            &trade,
            accounts,
        );
        match self.env.simulate_meta(call) {
            Ok(meta) => (
                borsh::from_slice(&meta.return_data.data).map_err(|e| e.to_string()),
                strategy_compute(&meta.logs).first().copied(),
            ),
            Err(failure) => (Err(failure), None),
        }
    }

    /// Records each instruction's compute in [`TaxWorld::max_costs`]; an invocation that
    /// called a transfer hook was never measured ([`own_compute`]).
    fn record(&mut self, costs: &[(&'static str, u64)]) {
        for &(name, cost) in costs {
            let max = self.max_costs.entry(name).or_default();
            *max = (*max).max(cost);
        }
    }

    /// The effective reserve of side `i`, or what the seed will make it before the seed.
    fn effective(&self, state: &TaxMarket, i: usize) -> u128 {
        let real = if state.status == MarketStatus::Open {
            state.reserves[i]
        } else {
            self.shape.seed[i]
        };
        let virtual_part = if state.virtual_side as usize == i {
            state.virtual_reserve
        } else {
            0
        };
        real as u128 + virtual_part as u128
    }

    /// How much `size` is of `reserve`, at most `holding`.
    pub fn sized(size: Size, reserve: u128, holding: u64) -> u64 {
        let amount = match size {
            Size::Dust(units) => units as u64,
            Size::Part { mantissa, exp } => {
                let millionths = mantissa as u128 * 10u128.pow(exp as u32);
                (reserve * millionths / 1_000_000).clamp(1, u64::MAX as u128) as u64
            }
            Size::All => holding,
        };
        amount.min(holding)
    }

    fn apply(&mut self, step: &Step) -> Outcome {
        let state = self.state();
        let market_state = self.market.market_state;
        let mut outcome = match *step {
            Step::Swap {
                wallet,
                input,
                size,
            } => self.swap(&state, wallet, input as usize % 2, size),
            Step::Seed { who, empty_side } => {
                let signer = self.signer(who).insecure_clone();
                let mut amounts = self.shape.seed;
                if let Some(side) = empty_side {
                    amounts[side as usize % 2] = 0;
                }
                let may_be_empty =
                    |i: usize| state.virtual_side as usize == i && state.virtual_reserve > 0;
                let expected = if ck(&state.seeder) != signer.pubkey() {
                    Err("NotSeeder".into())
                } else if state.status != MarketStatus::Created {
                    Err("AlreadySeeded".into())
                } else {
                    // Side by side, as the program takes them: a side's transfer, then its
                    // check that something arrived. A seeder holding less than its seed is
                    // refused by the token program, which only a product built on this one
                    // allows, as the containment hook's transfers let the seeder spend first.
                    (0..2)
                        .find_map(|i| {
                            if amounts[i] > 0 && self.holding(&signer.pubkey(), i) < amounts[i] {
                                Some("InsufficientFunds")
                            } else if amounts[i] == 0 && !may_be_empty(i) {
                                Some("ZeroSeed")
                            } else {
                                None
                            }
                        })
                        .map_or(Ok(()), |refusal| Err(refusal.into()))
                };
                let sent = self.env.seed(&self.market, &signer, amounts);
                let mut outcome = Outcome::of(Action::Seed, expected, named(&sent));
                if let Ok(meta) = &sent {
                    outcome.costs = costs_of(&meta.logs, "seed");
                    outcome.logs = meta.logs.clone();
                }
                outcome
            }
            Step::Distribute {
                slot,
                caller,
                wrong_wallet,
            } => {
                let caller = self.signer(Who::Wallet(caller)).insecure_clone();
                let tax_side = state.tax_side as usize;
                let mut wallet = slot_wallet(&state, slot);
                if wrong_wallet {
                    wallet = self.stranger.pubkey();
                }
                let unused = (slot as usize) < MAX_RECIPIENTS
                    && state.recipients[slot as usize] == Default::default();
                let expected = if slot as usize >= OWED_SLOTS {
                    Err("NoSuchSlot".into())
                } else if unused {
                    Err("UnusedSlot".into())
                } else if wrong_wallet {
                    Err("NotSlotWallet".into())
                } else {
                    Ok(())
                };
                let (mint, token_program) = (
                    self.market.mints[tax_side],
                    self.market.token_programs[tax_side],
                );
                let destination = pda::associated_token(&wallet, &mint, &token_program);
                let hooks = self.env.hook_accounts(
                    &mint,
                    self.market.vaults[tax_side],
                    destination,
                    self.market.authority,
                );
                let instruction = distribute_instruction(
                    &self.market,
                    tax_side,
                    &caller.pubkey(),
                    slot,
                    &wallet,
                    hooks,
                );
                let vault_before = self.env.balance(&self.market.vaults[tax_side]);
                // What the slot wallet's address costs beyond its first bump, which the
                // ceiling leaves out, from the accounts as they are before the payout.
                let search =
                    super::super::ceilings::distribute_bump_search(&self.env, &self.market, slot);
                let sent = self.env.send_meta(&[instruction], &[&caller]);
                let mut outcome = Outcome::of(Action::Distribute { slot }, expected, named(&sent));
                if let Ok(meta) = &sent {
                    outcome.costs = costs_of(&meta.logs, "distribute")
                        .into_iter()
                        .map(|(name, cost)| {
                            // A search counted beyond what the payout spent is a mistake in
                            // `distribute_bump_search`, never something to clamp away
                            // (hardening finding T03, #67).
                            let left = cost.checked_sub(search).unwrap_or_else(|| {
                                panic!("a bump search of {search} CU in a payout of {cost}")
                            });
                            (name, left)
                        })
                        .collect();
                    outcome.bump_search = search;
                    outcome.logs = meta.logs.clone();
                    let vault_after = self.env.balance(&self.market.vaults[tax_side]);
                    self.paid_out += vault_before.saturating_sub(vault_after) as u128;
                    if slot == BURN_SLOT {
                        self.burned[tax_side] += state.owed[BURN_SLOT as usize] as u128;
                    }
                }
                outcome
            }
            Step::SetTaxes { who, buy, sell } => {
                let signer = self.signer(who).insecure_clone();
                let ranges = state.tax_ranges();
                let bps = |rate: Rate, [min, max]: [u16; 2]| match rate {
                    Rate::Within(thousandths) => {
                        min + ((max - min) as u32 * thousandths.min(1_000) as u32 / 1_000) as u16
                    }
                    Rate::Exactly(bps) => bps,
                };
                let (buy, sell) = (bps(buy, ranges[0]), bps(sell, ranges[1]));
                let expected = authorization(&state, &signer.pubkey()).and_then(|()| {
                    let outside = [buy, sell]
                        .iter()
                        .zip(ranges)
                        .any(|(&rate, [min, max])| rate < min || rate > max);
                    if outside {
                        Err("RateOutsideRange".into())
                    } else {
                        Ok(())
                    }
                });
                let instruction = set_taxes_instruction(&market_state, &signer.pubkey(), buy, sell);
                self.authority_action(
                    Action::SetTaxes,
                    expected,
                    instruction,
                    &signer,
                    "set_taxes",
                )
            }
            Step::SetRecipients {
                who,
                used,
                picks,
                weights,
                burn,
                flaw,
            } => {
                let signer = self.signer(who).insecure_clone();
                let used = used as usize % (MAX_RECIPIENTS + 1);
                let (mut shares, burn_share_bps) = shares_of(used.max(1), &weights, burn);
                let mut recipients = [Pubkey::default(); MAX_RECIPIENTS];
                for k in 0..used {
                    recipients[k] = self.pool[picks[k] as usize % POOL].pubkey();
                }
                if used == 0 {
                    shares = [0; MAX_RECIPIENTS];
                }
                match flaw {
                    Flaw::Whole => {}
                    Flaw::Gap if (1..MAX_RECIPIENTS).contains(&used) => {
                        recipients[used] = recipients[used - 1];
                        recipients[used - 1] = Pubkey::default();
                    }
                    Flaw::ZeroShare if used >= 2 => {
                        shares[0] += shares[used - 1];
                        shares[used - 1] = 0;
                    }
                    Flaw::StrayShare if (1..MAX_RECIPIENTS).contains(&used) && shares[0] > 1 => {
                        shares[0] -= 1;
                        shares[used] = 1;
                    }
                    Flaw::Skew(extra) => shares[0] = shares[0].saturating_add(extra),
                    // A flaw the number of recipients leaves no room for.
                    _ => {}
                }
                let tax_mint = self.market.mints[state.tax_side as usize];
                let native = NATIVE_MINTS.iter().any(|native| ck(native) == tax_mint);
                let burn_share_bps = if used == 0 { 10_000 } else { burn_share_bps };
                let expected = authorization(&state, &signer.pubkey()).and_then(|()| {
                    split_refusal(&recipients, &shares, burn_share_bps, native, &state.owed)
                });
                let split = Split {
                    recipients,
                    shares,
                    burn_share_bps,
                };
                let instruction =
                    set_recipients_instruction(&market_state, &signer.pubkey(), &split);
                self.authority_action(
                    Action::SetRecipients,
                    expected,
                    instruction,
                    &signer,
                    "set_recipients",
                )
            }
            Step::Renounce { who } => {
                let signer = self.signer(who).insecure_clone();
                let expected = authorization(&state, &signer.pubkey());
                let instruction = renounce_instruction(&market_state, &signer.pubkey());
                self.authority_action(
                    Action::Renounce,
                    expected,
                    instruction,
                    &signer,
                    "renounce_tax_authority",
                )
            }
            Step::Donate { side, size } => {
                let side = side as usize % 2;
                let holding = self.holding(&self.stranger.pubkey(), side);
                let reserve = (state.reserves[side] as u128).max(1_000_000);
                let amount = Self::sized(size, reserve, holding);
                if amount == 0 {
                    return Outcome::of(Action::Skip, Ok(()), Ok(()));
                }
                let stranger = self.stranger.insecure_clone();
                let vault = self.market.vaults[side];
                let sent = self
                    .env
                    .transfer(&self.market, &stranger, side, vault, amount);
                let mut outcome = Outcome::of(Action::Donate { side }, Ok(()), named(&sent));
                if let Ok(meta) = &sent {
                    self.donated[side] += amount as u128;
                    outcome.logs = meta.logs.clone();
                }
                outcome
            }
            Step::Warp { slots, seconds } => {
                let mut clock: solana_clock::Clock = self.env.svm.get_sysvar();
                clock.slot += slots as u64;
                clock.unix_timestamp += seconds as i64;
                self.env.svm.set_sysvar(&clock);
                Outcome::of(Action::Warp, Ok(()), Ok(()))
            }
            Step::Bypass { input } => {
                let (i, o) = (input as usize % 2, 1 - input as usize % 2);
                let stranger = self.stranger.insecure_clone();
                let owner = stranger.pubkey();
                let market = &self.market;
                let accounts = vec![
                    AccountMeta::new_readonly(owner, true),
                    AccountMeta::new(market.market_state, false),
                    AccountMeta::new_readonly(owner, false),
                    AccountMeta::new(
                        pda::associated_token(&owner, &market.mints[i], &market.token_programs[i]),
                        false,
                    ),
                    AccountMeta::new(
                        pda::associated_token(&owner, &market.mints[o], &market.token_programs[o]),
                        false,
                    ),
                    AccountMeta::new(market.vaults[i], false),
                    AccountMeta::new_readonly(market.mints[i], false),
                    AccountMeta::new_readonly(market.mints[o], false),
                    AccountMeta::new_readonly(market.token_programs[i], false),
                    AccountMeta::new_readonly(market.token_programs[o], false),
                    AccountMeta::new(market.vaults[o], false),
                    AccountMeta::new_readonly(market.authority, false),
                ];
                let request = SwapRequest {
                    trade: exact_in(i, o, 1_000),
                    amount_sent: 1_000,
                    min_amount_out: 0,
                };
                let call = strategy_call(
                    pipeline_client::interface::discriminator::SWAP,
                    &request,
                    accounts,
                );
                let sent = self.env.send_meta(&[call], &[&stranger]);
                Outcome::of(Action::Bypass, Err("NotPipeline".into()), named(&sent))
            }
        };
        let costs = std::mem::take(&mut outcome.costs);
        self.record(&costs);
        outcome.costs = costs;
        *self.tally.entry(outcome.label()).or_default() += 1;
        outcome
    }

    fn authority_action(
        &mut self,
        action: Action,
        expected: Result<(), String>,
        instruction: pipeline_client::Instruction,
        signer: &Keypair,
        name: &'static str,
    ) -> Outcome {
        let sent = self.env.send_signed(instruction, signer);
        let mut outcome = Outcome::of(action, expected, named(&sent));
        if let Ok(meta) = &sent {
            outcome.costs = costs_of(&meta.logs, name);
            outcome.logs = meta.logs.clone();
        }
        outcome
    }

    fn swap(&mut self, state: &TaxMarket, wallet: u8, input: usize, size: Size) -> Outcome {
        let output = 1 - input;
        let trader = self.signer(Who::Wallet(wallet)).insecure_clone();
        // What the wallet can spend, Pipeline's fee on top.
        let budget = amount_for_budget(self.holding(&trader.pubkey(), input), 0);
        let amount = Self::sized(size, self.effective(state, input), budget);
        if amount == 0 {
            return Outcome::of(Action::Skip, Ok(()), Ok(()));
        }
        let model = spec_price(state, input, output, amount);
        let mut costs = vec![];
        if let Ok(meta) = self
            .env
            .resolve_meta(&self.market, &exact_in(input, output, amount))
        {
            costs.extend(costs_of(&meta.logs, "pipeline_resolve_accounts"));
        }
        let (quote, quote_cost) = self.quote(input, amount);
        costs.extend(quote_cost.map(|cost| ("pipeline_quote", cost)));
        let quote = quote.map(|q| q.amount_out);
        let options = SwapOptions {
            min_amount_out: *quote.as_ref().unwrap_or(&0),
            ..SwapOptions::default()
        };
        // As a terminal sends it: the trader's token account for the output created in the
        // same transaction when it is missing, as a recipient wallet paid in one mint lacks
        // one for the other.
        let sent = self
            .env
            .swap_instruction(
                &self.market,
                &trader.pubkey(),
                (input, output),
                amount,
                &options,
            )
            .and_then(|swap| {
                let create = create_token_account_idempotent(
                    &self.env.admin.pubkey(),
                    &trader.pubkey(),
                    &self.market.mints[output],
                    &self.market.token_programs[output],
                );
                self.env.send_meta(&[create, swap], &[&trader])
            });
        let logs = sent
            .as_ref()
            .map(|meta| meta.logs.clone())
            .unwrap_or_default();
        if let Ok(meta) = &sent {
            costs.extend(costs_of(&meta.logs, "pipeline_swap"));
        }
        let swap = sent.and_then(|meta| {
            borsh::from_slice::<SwapResult>(&meta.return_data.data).map_err(|e| e.to_string())
        });
        let all = size == Size::All;
        let mut outcome = Outcome::of(
            Action::Swap {
                input,
                output,
                amount,
                all,
            },
            model.clone().map(|_| ()),
            named(&swap),
        );
        outcome.swap = Some(SwapOutcome { quote, swap, model });
        outcome.costs = costs;
        outcome.logs = logs;
        outcome
    }

    fn snapshot(&self) -> Snapshot {
        let env = &self.env;
        let market = &self.market;
        let holdings: Vec<[u64; 2]> = self
            .wallets()
            .iter()
            .map(|wallet| [0, 1].map(|i| self.holding(wallet, i)))
            .collect();
        let vaults = [0, 1].map(|i| env.balance(&market.vaults[i]));
        let held = [0, 1].map(|i| {
            vaults[i] as u128
                + env.balance_or_zero(&self.fee_account(i)) as u128
                + holdings.iter().map(|h| h[i] as u128).sum::<u128>()
                + self
                    .other_accounts
                    .iter()
                    .filter(|(mint, _)| *mint == i)
                    .map(|(_, account)| env.balance_or_zero(account) as u128)
                    .sum::<u128>()
        });
        Snapshot {
            state: self.state(),
            vaults,
            held,
            supply: [0, 1].map(|i| env.supply(&market.mints[i])),
            holdings,
            state_data: env
                .svm
                .get_account(&market.market_state)
                .expect("market state")
                .data,
        }
    }
}

/// The two strategy invocations of a market's creation: `first`, then
/// `pipeline_market_info`, which the router calls when it records the market; each left out
/// when it called a transfer hook ([`own_compute`]).
fn creation_costs(logs: &[String], first: &'static str) -> Vec<(&'static str, u64)> {
    let costs = own_compute(logs);
    assert_eq!(costs.len(), 2, "{logs:?}");
    [first, "pipeline_market_info"]
        .into_iter()
        .zip(costs)
        .filter_map(|(name, cost)| Some((name, cost?)))
        .collect()
}

/// The compute of the one tax AMM instruction in a transaction, unless it called a transfer
/// hook ([`own_compute`]).
fn costs_of(logs: &[String], name: &'static str) -> Vec<(&'static str, u64)> {
    own_compute(logs)
        .into_iter()
        .flatten()
        .map(|cost| (name, cost))
        .collect()
}

/// The compute each tax AMM invocation in a transaction consumed, in order, or `None` for
/// one that called a program other than the token programs, the associated token program
/// and the system program: a mint's transfer hook, whose cost is the hook's own to bound
/// (docs/spec/tax-amm.md, "Compute ceilings"). So a market with a hooked mint has every
/// instruction that never calls the hook measured (hardening finding T02, #67).
pub fn own_compute(logs: &[String]) -> Vec<Option<u64>> {
    let strategy = strategy_id().to_string();
    let own_calls = [
        TOKEN.to_string(),
        TOKEN_2022.to_string(),
        pipeline_client::ASSOCIATED_TOKEN_PROGRAM_ID.to_string(),
        pipeline_client::SYSTEM_PROGRAM_ID.to_string(),
    ];
    let invoke = format!("Program {strategy} invoke [");
    let consumed = format!("Program {strategy} consumed ");
    let mut costs = vec![];
    let mut inside: Option<bool> = None;
    for line in logs {
        if line.starts_with(&invoke) {
            inside = Some(false);
        } else if let Some(rest) = line.strip_prefix(&consumed) {
            let cost = rest.split(' ').next().unwrap().parse().unwrap();
            let called_outside = inside.take().expect("an invocation before its cost");
            costs.push((!called_outside).then_some(cost));
        } else if let Some(called) = inside.as_mut() {
            if let Some((program, _)) = line
                .strip_prefix("Program ")
                .and_then(|rest| rest.split_once(" invoke ["))
            {
                *called |= !own_calls.iter().any(|own| own == program);
            }
        }
    }
    costs
}

impl Product for TaxAmm {
    type Shape = Shape;
    type World = TaxWorld;
    type Step = Step;
    type Snapshot = Snapshot;
    type Outcome = Outcome;

    fn shapes() -> BoxedStrategy<Shape> {
        let mint = prop_oneof![
            3 => Just(MintKind::SplToken),
            3 => Just(MintKind::Token2022),
            2 => Just(MintKind::Hooked),
            2 => Just(MintKind::NativeSol),
        ];
        let split = (
            1..=MAX_RECIPIENTS as u8,
            [1..=100u16, 1..=100, 1..=100, 1..=100, 1..=100],
            any::<bool>(),
        );
        let virtual_reserve = prop_oneof![
            2 => Just(None),
            1 => (0..2u8, amount(3..=15), any::<bool>()).prop_map(Some),
        ];
        let creation = prop_oneof![
            6 => Just(Creation::CreateAndSeed),
            2 => Just(Creation::CreateOnly),
            2 => Just(Creation::Launchpad),
        ];
        (
            [mint.clone(), mint],
            0..2u8,
            [range_and_rate(), range_and_rate()],
            split,
            // Most markets have a tax authority, so its actions run.
            prop::bool::weighted(0.75),
            virtual_reserve,
            [amount(3..=15), amount(3..=15)],
            (creation, any::<u64>()),
        )
            .prop_map(
                |(
                    mut mints,
                    tax_side,
                    [buy, sell],
                    (recipients, weights, burn),
                    tax_authority,
                    virtual_reserve,
                    mut seed,
                    (creation, keys),
                )| {
                    if mints == [MintKind::NativeSol; 2] {
                        mints[1] = MintKind::SplToken;
                    }
                    let (virtual_side, virtual_reserve) = match virtual_reserve {
                        Some((side, reserve, single_sided)) => {
                            if single_sided {
                                seed[side as usize] = 0;
                            }
                            (side, reserve)
                        }
                        None => (0, 0),
                    };
                    Shape {
                        mints,
                        tax_side,
                        ranges: [buy.0, sell.0],
                        rates: [buy.1, sell.1],
                        recipients,
                        weights,
                        // Native SOL can't be burned.
                        burn: burn && mints[tax_side as usize] != MintKind::NativeSol,
                        tax_authority,
                        virtual_side,
                        virtual_reserve,
                        seed,
                        creation,
                        keys,
                    }
                },
            )
            .boxed()
    }

    fn steps() -> BoxedStrategy<Step> {
        prop_oneof![
            // Mostly the traders and the stranger, who hold both mints from the start.
            10 => (prop_oneof![6 => 0..=TRADERS as u8, 1 => any::<u8>()], 0..2u8, size())
                .prop_map(|(wallet, input, size)| Step::Swap { wallet, input, size }),
            1 => (prop_oneof![6 => Just(Who::Seeder), 1 => any::<u8>().prop_map(Who::Wallet)],
                  prop_oneof![6 => Just(None), 1 => (0..2u8).prop_map(Some)])
                .prop_map(|(who, empty_side)| Step::Seed { who, empty_side }),
            4 => (0..=OWED_SLOTS as u8, any::<u8>(), prop::bool::weighted(0.1))
                .prop_map(|(slot, caller, wrong_wallet)| Step::Distribute { slot, caller, wrong_wallet }),
            2 => (who(), rate(), rate())
                .prop_map(|(who, buy, sell)| Step::SetTaxes { who, buy, sell }),
            2 => (who(), 0..=MAX_RECIPIENTS as u8, [any::<u8>(), any::<u8>(), any::<u8>(), any::<u8>()],
                  [1..=100u16, 1..=100, 1..=100, 1..=100, 1..=100], any::<bool>(), flaw())
                .prop_map(|(who, used, picks, weights, burn, flaw)| Step::SetRecipients { who, used, picks, weights, burn, flaw }),
            1 => who().prop_map(|who| Step::Renounce { who }),
            2 => (0..2u8, size()).prop_map(|(side, size)| Step::Donate { side, size }),
            1 => (0..1_000_000u32, 0..10_000_000u32).prop_map(|(slots, seconds)| Step::Warp { slots, seconds }),
            1 => (0..2u8).prop_map(|input| Step::Bypass { input }),
        ]
        .boxed()
    }

    fn world(shape: &Shape) -> Result<TaxWorld, String> {
        TaxWorld::new(shape)
    }

    fn snapshot(world: &TaxWorld) -> Snapshot {
        world.snapshot()
    }

    fn apply(world: &mut TaxWorld, step: &Step) -> Outcome {
        world.apply(step)
    }

    fn start(world: &TaxWorld) -> Outcome {
        let mut outcome = Outcome::of(Action::Start, Ok(()), Ok(()));
        outcome.costs = world
            .max_costs
            .iter()
            .map(|(&name, &cost)| (name, cost))
            .collect();
        outcome
    }

    /// Every signer that holds anything sells all of it, one after another.
    fn closing_steps(world: &TaxWorld) -> Vec<Step> {
        if world.state().status != MarketStatus::Open {
            return vec![];
        }
        let mut steps = vec![];
        for (k, signer) in world.signers().iter().enumerate() {
            for input in 0..2 {
                if world.holding(&signer.pubkey(), input) > 0 {
                    steps.push(Step::Swap {
                        wallet: k as u8,
                        input: input as u8,
                        size: Size::All,
                    });
                }
            }
        }
        steps
    }

    fn invariants() -> Vec<Invariant<TaxAmm>> {
        invariants()
    }
}

/// The ten invariants, then the spec's outcomes and the compute ceilings.
pub fn invariants() -> Vec<Invariant<TaxAmm>> {
    vec![
        Invariant::new(INVARIANTS[0], value_is_conserved),
        Invariant::new(INVARIANTS[1], every_holder_can_exit),
        Invariant::new(INVARIANTS[2], each_quote_equals_its_swap),
        Invariant::new(INVARIANTS[3], vaults_cover_the_market),
        Invariant::new(INVARIANTS[4], swaps_keep_the_curve),
        Invariant::new(INVARIANTS[5], every_tax_is_split_exactly),
        Invariant::new(INVARIANTS[6], rates_stay_in_range_and_creation_is_fixed),
        Invariant::new(INVARIANTS[7], only_swaps_move_reserves_and_counters),
        Invariant::new(INVARIANTS[8], counters_never_fall),
        Invariant::new(INVARIANTS[9], a_renounced_market_never_changes),
        Invariant::new("each_step_is_the_specs", each_step_is_the_specs),
        Invariant::new(
            "compute_stays_under_its_ceilings",
            compute_stays_under_its_ceilings,
        ),
    ]
}

macro_rules! ensure {
    ($condition:expr, $($message:tt)+) => {
        if !$condition {
            return Err(format!($($message)+));
        }
    };
}

/// Bar: value is conserved. Every token the world created is held by a known account, but
/// for what the burn slot was owed when it was burned; and every mint's supply, which the
/// world set to what it created, fell by exactly those burns.
fn value_is_conserved(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let w = c.world;
    for i in 0..2 {
        let left = w.created[i]
            .checked_sub(w.burned[i])
            .ok_or(format!("mint {i}: more was burned than was created"))?;
        ensure!(
            c.after.held[i] == left,
            "mint {i}: known accounts hold {} where {} were created and {} burned",
            c.after.held[i],
            w.created[i],
            w.burned[i]
        );
        if w.shape.mints[i] != MintKind::NativeSol {
            ensure!(
                c.after.supply[i] as u128 == left,
                "mint {i}: supply {} where {left} should remain",
                c.after.supply[i]
            );
        }
    }
    Ok(())
}

/// Bar: every holder can still exit. Every known wallet's whole holding of either mint,
/// Pipeline's fee on top, quotes, or is refused for a reason the spec gives: as dust, or
/// because the curve would pay out more than the output side's real reserve, which only a
/// virtual reserve allows, and then the largest sale the real reserve covers quotes. A sale
/// of a whole holding that actually ran (every sequence ends with them) settled unless the
/// spec refuses it.
fn every_holder_can_exit(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let w = c.world;
    let state = &c.after.state;
    if let (Action::Swap { all: true, .. }, Some(swap)) = (c.outcome.action, &c.outcome.swap) {
        ensure!(
            swap.model.is_err() || swap.swap.is_ok(),
            "selling a whole holding failed: {:?}",
            swap.swap
        );
    }
    if state.status != MarketStatus::Open {
        return Ok(());
    }
    // What a holder can sell depends only on the market state and the holdings, so a step
    // that changed neither leaves the last check standing.
    let unchanged =
        c.before.state_data == c.after.state_data && c.before.holdings == c.after.holdings;
    if unchanged && c.outcome.action != Action::Start {
        return Ok(());
    }
    // Every quote is of the same state, so wallets holding the same amounts share theirs
    // (hardening finding T08, #67).
    let quotes: RefCell<BTreeMap<(usize, u64), Result<(), String>>> = RefCell::default();
    let quote = |input: usize, amount: u64| -> Result<(), String> {
        quotes
            .borrow_mut()
            .entry((input, amount))
            .or_insert_with(|| w.quote(input, amount).0.map(|_| ()))
            .clone()
    };
    for wallet in w.wallets() {
        for input in 0..2 {
            let output = 1 - input;
            let amount = amount_for_budget(w.holding(&wallet, input), 0);
            if amount == 0 {
                continue;
            }
            let Err(failure) = quote(input, amount) else {
                continue;
            };
            let name = refusal(&failure);
            let model = spec_price(state, input, output, amount);
            ensure!(
                model.as_ref().err() == Some(&name),
                "{wallet} can't sell {amount} of mint {input}: {name}, where the spec gives {model:?}"
            );
            if name == "InsufficientLiquidity" {
                ensure!(
                    state.virtual_side as usize == output && state.virtual_reserve > 0,
                    "the real reserve refused a sale on a side without a virtual reserve"
                );
                // The largest sale the real reserve covers, by the spec: whether the curve pays
                // out more than the real reserve only grows with the amount, so a binary search
                // finds where it starts.
                let beyond = |amount: u64| {
                    spec_price(state, input, output, amount).err().as_deref()
                        == Some("InsufficientLiquidity")
                };
                let (mut covered, mut refused) = (0u64, amount);
                while refused - covered > 1 {
                    let middle = covered + (refused - covered) / 2;
                    if beyond(middle) {
                        refused = middle;
                    } else {
                        covered = middle;
                    }
                }
                let at_edge = refusal(&quote(input, refused).err().unwrap_or_default());
                ensure!(
                    at_edge == "InsufficientLiquidity",
                    "the spec refuses a sale of {refused} beyond the real reserve, the program gives {at_edge:?}"
                );
                if spec_price(state, input, output, covered).is_ok() {
                    ensure!(
                        quote(input, covered).is_ok(),
                        "{wallet} can't sell {covered} of mint {input}, the most the real reserve covers"
                    );
                }
            }
        }
    }
    Ok(())
}

/// Bar: each quote equals its swap. A swap sent with its quote as the minimum delivers
/// exactly the quote, and a refused quote's swap is refused too.
fn each_quote_equals_its_swap(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let Some(swap) = &c.outcome.swap else {
        return Ok(());
    };
    match (&swap.quote, &swap.swap) {
        (Ok(quote), Ok(result)) => ensure!(
            result.received == *quote,
            "quoted {quote}, the swap delivered {}",
            result.received
        ),
        (Err(_), Err(_)) => {}
        (quote, result) => return Err(format!("quote {quote:?} against swap {result:?}")),
    }
    Ok(())
}

/// Spec 1: each vault holds the market's real reserve of its mint, plus everything owed when
/// it is the tax-side vault, plus every donation to it, which only ever adds to the surplus.
fn vaults_cover_the_market(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let state = &c.after.state;
    for i in 0..2 {
        let owed = if state.tax_side as usize == i {
            total_owed(state)
        } else {
            0
        };
        let recorded = state.reserves[i] as u128 + owed;
        ensure!(
            c.after.vaults[i] as u128 == recorded + c.world.donated[i],
            "vault {i} holds {}, where the market recorded {recorded} and {} was donated",
            c.after.vaults[i],
            c.world.donated[i]
        );
    }
    Ok(())
}

/// Spec 2: a swap never lowers the product of the effective reserves, never pays out more
/// of a side than its real reserve, and no step changes the virtual reserve.
fn swaps_keep_the_curve(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let (before, after) = (&c.before.state, &c.after.state);
    ensure!(
        (after.virtual_side, after.virtual_reserve)
            == (before.virtual_side, before.virtual_reserve),
        "the virtual reserve changed"
    );
    if let (Action::Swap { output, .. }, true) = (c.outcome.action, c.outcome.swapped()) {
        ensure!(
            curve_product(after) >= curve_product(before),
            "the product of the effective reserves fell from {:?} to {:?}",
            before.reserves,
            after.reserves
        );
        let paid = c.before.vaults[output]
            .checked_sub(c.after.vaults[output])
            .ok_or("the output vault grew in a swap")?;
        ensure!(
            paid <= before.reserves[output],
            "paid out {paid} of side {output}, whose real reserve was {}",
            before.reserves[output]
        );
    }
    Ok(())
}

/// Spec 3: every tax is split exactly, and `tax_collected` equals what was paid out or
/// burned plus what is still owed.
fn every_tax_is_split_exactly(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let (before, after) = (&c.before.state, &c.after.state);
    if c.outcome.swapped() {
        let tax = after
            .tax_collected
            .checked_sub(before.tax_collected)
            .ok_or("tax_collected fell in a swap")?;
        let booked = total_owed(after)
            .checked_sub(total_owed(before))
            .ok_or("what is owed fell in a swap")?;
        ensure!(booked == tax, "a tax of {tax} booked {booked} to the slots");
    }
    let accounted = c.world.paid_out + total_owed(after);
    ensure!(
        after.tax_collected == accounted,
        "tax_collected {} where {} was paid out and {} is owed",
        after.tax_collected,
        c.world.paid_out,
        total_owed(after)
    );
    Ok(())
}

/// Spec 4: no rate ever leaves its range or passes `MAX_TAX_BPS`, and nothing fixed at
/// creation ever changes.
fn rates_stay_in_range_and_creation_is_fixed(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let (state, created) = (&c.after.state, &c.world.created_state);
    for (rate, [min, max]) in [state.buy_tax_bps, state.sell_tax_bps]
        .into_iter()
        .zip(state.tax_ranges())
    {
        ensure!(
            min <= rate && rate <= max && max <= MAX_TAX_BPS,
            "rate {rate} against its range [{min}, {max}] and the cap {MAX_TAX_BPS}"
        );
    }
    let fixed = |m: &TaxMarket| {
        (
            m.version,
            m.mints,
            m.vaults,
            m.market_signer,
            m.tax_side,
            m.tax_ranges(),
            m.seeder,
            m.virtual_side,
            m.virtual_reserve,
            m.authority_bump,
            (m.created_slot, m.created_at),
        )
    };
    ensure!(
        fixed(state) == fixed(created),
        "a value fixed at creation changed"
    );
    Ok(())
}

/// Spec 5: after the seed, only router swaps change the real reserves, and only router swaps
/// ever change the counters; `distribute` moves exactly what its slot is owed (so never more)
/// and changes no other slot.
fn only_swaps_move_reserves_and_counters(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let (before, after) = (&c.before.state, &c.after.state);
    if c.outcome.swapped() {
        return Ok(());
    }
    let counters = |m: &TaxMarket| (m.tax_collected, m.volume, m.swap_count);
    ensure!(
        counters(after) == counters(before),
        "{:?} changed the counters",
        c.outcome.action
    );
    let seeded = c.outcome.action == Action::Seed && c.outcome.result.is_ok();
    ensure!(
        seeded || after.reserves == before.reserves,
        "{:?} changed the real reserves from {:?} to {:?}",
        c.outcome.action,
        before.reserves,
        after.reserves
    );
    if let (Action::Distribute { slot }, Ok(())) = (c.outcome.action, &c.outcome.result) {
        let slot = slot as usize;
        let tax_side = before.tax_side as usize;
        let moved = c.before.vaults[tax_side]
            .checked_sub(c.after.vaults[tax_side])
            .ok_or("the tax-side vault grew in a payout")?;
        let (Some(&owed), Some(&left)) = (before.owed.get(slot), after.owed.get(slot)) else {
            return Err(format!(
                "distribute settled for slot {slot}, which does not exist"
            ));
        };
        ensure!(
            moved == owed && left == 0,
            "distribute moved {moved} for slot {slot}, which was owed {owed}"
        );
        for other in (0..OWED_SLOTS).filter(|&other| other != slot) {
            ensure!(
                after.owed[other] == before.owed[other],
                "distribute for slot {slot} changed slot {other}"
            );
        }
    } else {
        ensure!(
            after.owed == before.owed,
            "{:?} changed what is owed",
            c.outcome.action
        );
    }
    Ok(())
}

/// Spec 6: the counters never fall.
fn counters_never_fall(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let (before, after) = (&c.before.state, &c.after.state);
    ensure!(
        after.tax_collected >= before.tax_collected
            && after.volume[0] >= before.volume[0]
            && after.volume[1] >= before.volume[1]
            && after.swap_count >= before.swap_count,
        "a counter fell: {:?} -> {:?}",
        (before.tax_collected, before.volume, before.swap_count),
        (after.tax_collected, after.volume, after.swap_count)
    );
    Ok(())
}

/// Spec 7: once the tax authority has renounced, or on a market created without one, the
/// rates and the tax recipients never change, and the market never has an authority again.
fn a_renounced_market_never_changes(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let (before, after) = (&c.before.state, &c.after.state);
    if !before.tax_authority_renounced && before.tax_authority != Default::default() {
        return Ok(());
    }
    let changeable = |m: &TaxMarket| {
        (
            m.buy_tax_bps,
            m.sell_tax_bps,
            m.recipients,
            m.shares,
            m.burn_share_bps,
            m.tax_authority,
            m.tax_authority_renounced,
        )
    };
    ensure!(
        changeable(after) == changeable(before),
        "{:?} changed a market whose taxes and recipients may never change",
        c.outcome.action
    );
    Ok(())
}

/// Each step does what the spec says: it passes or is refused with the spec's error, and a
/// swap's quote is the spec's price and leaves the market state exactly as the spec's
/// formulas do, to the unit.
fn each_step_is_the_specs(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    let outcome = c.outcome;
    ensure!(
        outcome.result == outcome.expected,
        "{:?}: the spec gives {:?}, the program {:?}",
        outcome.action,
        outcome.expected,
        outcome.result
    );
    let (
        Action::Swap {
            input,
            output,
            amount,
            ..
        },
        Some(swap),
    ) = (outcome.action, &outcome.swap)
    else {
        return Ok(());
    };
    match (&swap.model, &swap.quote) {
        (Ok(price), Ok(quote)) => ensure!(
            quote == price,
            "quoted {quote}, the spec's price is {price}"
        ),
        (Err(name), Err(failure)) => ensure!(
            refusal(failure) == *name,
            "the quote was refused with {}, the spec refuses with {name}",
            refusal(failure)
        ),
        (model, quote) => return Err(format!("the spec gives {model:?}, the quote {quote:?}")),
    }
    if let Ok(result) = &swap.swap {
        ensure!(
            result.net_sent == amount,
            "net_sent {} for {amount}",
            result.net_sent
        );
        let mut model = Model::of(&c.before.state);
        model
            .swap(input, output, result.net_sent)
            .map_err(|refused| format!("the spec refuses a swap that settled: {refused:?}"))?;
        let after = Model::of(&c.after.state);
        ensure!(
            after == model,
            "the market state {after:?} where the spec gives {model:?}"
        );
    }
    Ok(())
}

/// The limits layer: every instruction a step ran stayed under its compute ceiling, but for
/// an invocation that called a transfer hook, whose cost is the hook's own to bound
/// ([`own_compute`]).
fn compute_stays_under_its_ceilings(c: &Checked<'_, TaxAmm>) -> Result<(), String> {
    for &(name, cost) in &c.outcome.costs {
        let ceiling = super::super::ceilings::of(name);
        ensure!(
            cost <= ceiling,
            "{name} took {cost} CU, over its ceiling of {ceiling}"
        );
    }
    Ok(())
}
