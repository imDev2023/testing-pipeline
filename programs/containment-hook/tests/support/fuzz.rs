//! The containment hook under the invariant fuzzer (docs/spec/containment-hook.md,
//! "Invariants" and "Compute ceilings"; docs/spec/README.md, "Test layers" 3 and 5), built on
//! the tax AMM's product the way its harness says (`tax-amm/tests/common/fuzz/mod.rs`,
//! "Adding a product's steps and invariants").
//!
//! **Worlds**: every market shape the tax AMM's fuzzer builds, made the home market of a
//! contained token: the contained mint at either index, created with this hook as its
//! transfer hook and its unlock PDA as hook authority, and bound before the seed with an
//! unlock goal and deadline of the shape's choosing; the quote mint, which the tax is taken
//! in, SPL Token, Token-2022, Token-2022 with `test-hook`, or native SOL. Around the market: a
//! second token account of the contained mint for each trader and the stranger (a holder's
//! own accounts), another tax market for the token that nobody can fund, Pipeline's treasury's
//! account for it, and copies of the config and the validation account at other addresses.
//!
//! **Steps**: every tax AMM step on the home market (buys and sells through the router with
//! the hook accounts, `seed`, `distribute`, the tax authority's actions, tokens sent to a
//! vault, clock jumps, a bypass); `transfer_checked` from any holder's account to any account
//! (another wallet, the holder's own other account, the other market's vault, the treasury,
//! the home vault, the fee account), with the hook accounts whole, left out or substituted;
//! buys and sells through the router with the hook accounts left out or substituted; a sell
//! paying an integrator fee; `sweep_fees`; `bind` again, by the launcher or anyone; `unlock`
//! by anyone with any market state; `Execute` called directly; and the clock set around the
//! unlock deadline. Every sequence ends as the tax AMM's do, with every wallet selling all it
//! holds.
//!
//! **Invariants**, after every step: the tax AMM's, the bar's three first, each lifted; then
//! the hook's five in the spec's order ([`INVARIANTS`]); then two checks the bar adds: each
//! hook step's outcome is the spec's, and every invocation of the hook stays under its
//! compute ceiling (`support/ceilings.rs`).

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};

use anchor_lang::AccountDeserialize;
use containment_hook::mint::TransferHook;
use containment_hook::Config;
use pipeline_client::interface::fees::amount_for_budget;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use proptest::prelude::*;
use proptest::strategy::BoxedStrategy;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::state::MarketStatus;

use super::harness::fuzz::tax::{self, key, Size, Surroundings, TaxAmm, TaxWorld};
use super::harness::fuzz::{lift, Checked, Invariant, Product};
use super::*;

/// The names of the hook's five invariants, in the spec's order. The bar's three shared ones
/// are the tax AMM's first three, [`tax::INVARIANTS`].
pub const INVARIANTS: [&str; 5] = [
    "contained_tokens_move_only_through_the_home_market",
    "a_transfer_missing_a_hook_account_is_refused",
    "the_config_never_changes_but_the_unlock_time",
    "unlock_passes_exactly_when_due_and_clears_the_hook",
    "every_holder_can_sell_into_the_home_market",
];

/// Sequences a plain `cargo test` runs, and the most steps in one: the ticket's floor for
/// CI. `PROPTEST_CASES` and `FUZZ_STEPS` change them.
pub const DEFAULT_CASES: u32 = 1_000;
pub const DEFAULT_STEPS: usize = 50;

/// Wallets that get a second token account of the contained mint: the tax world's first
/// signers, its three traders and the stranger.
const OWN_ACCOUNTS: usize = 4;

/// The roles [`key`] derives this product's keys for, from 64 up as the tax AMM's product
/// asks.
mod role {
    pub const OWN_ACCOUNT: u8 = 64;
    pub const OTHER_MARKET: u8 = 65;
    pub const COPY: u8 = 66;
}

/// The containment hook's product for the harness.
pub struct ContainmentHook;

/// A contained token's world: the tax AMM's shape, with the contained mint at index
/// `contained` and the quote mint, which the tax is taken in, at the other, and the unlock
/// terms `bind` sets.
#[derive(Clone, Debug)]
pub struct HookShape {
    pub tax: tax::Shape,
    pub contained: u8,
    /// In quote-mint base units.
    pub unlock_goal: u64,
    /// The unlock deadline, in seconds after the binding.
    pub deadline_after: i64,
}

/// Which hook accounts a transfer of the contained token carries after Token-2022's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tail {
    /// The hook program, the validation account and the config.
    Complete,
    /// None of them.
    Missing,
    /// Only the hook program.
    ProgramOnly,
    /// The hook program and the validation account.
    NoConfig,
    /// The hook program and the config.
    NoValidation,
    /// The config replaced by a copy of it at another address.
    OtherConfig,
    /// The validation account replaced by a copy of it at another address.
    OtherValidation,
}

/// Where a transfer goes, or whose account `Execute` names as its destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum To {
    /// A signer's associated token account, by index (modulo how many there are).
    Holder(u8),
    /// One of the second token accounts, by index (modulo how many there are).
    OwnAccount(u8),
    HomeVault,
    HomeFees,
    /// The other tax market's vault for the token.
    OtherVault,
    /// Pipeline's treasury's account for the token.
    Treasury,
}

/// Who signs a `bind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Binder {
    /// The mint authority, which bound the token.
    Launcher,
    /// A signer of the tax world, by index.
    Anyone(u8),
}

/// The market a `bind` names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BindTo {
    HomeMarket,
    OtherMarket,
}

/// The market state an `unlock` passes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateGiven {
    /// The one recorded at binding.
    RecordedState,
    /// The other tax market's.
    OtherState,
    /// The router's `Market` account of the home market, not a market state at all.
    RouterMarket,
}

// The variants by their bare names, as the tax AMM's are: the harness prints a minimal
// failing case with `{:#?}`, which pastes into a regression test under
// `use fuzzing::fuzz::*` and `use fuzzing::harness::fuzz::tax::*` as printed. None of these
// names is one of the tax AMM's.
#[allow(unused_imports)]
pub use {BindTo::*, Binder::*, HookStep::*, StateGiven::*, Tail::*, To::*};

/// One thing anyone can do to a contained token or its home market.
#[derive(Clone, Debug)]
pub enum HookStep {
    /// One of the tax AMM's steps on the home market.
    Tax(tax::Step),
    /// A signer sends the token from their associated token account, or from their second
    /// account when `own`, with `transfer_checked`.
    Transfer {
        from: u8,
        own: bool,
        to: To,
        size: Size,
        tail: Tail,
    },
    /// A buy or a sell through the router whose hook accounts are left out or substituted.
    TailedSwap {
        wallet: u8,
        buy: bool,
        size: Size,
        tail: Tail,
    },
    /// A sell through the router paying an integrator fee, which the router pays in the
    /// token into the integrator's account.
    IntegratorSell { wallet: u8, size: Size, bps: u16 },
    /// The router's `sweep_fees` of the home market's fee account for the token.
    SweepFees { tail: Tail },
    /// `bind` again.
    Bind { by: Binder, market: BindTo },
    /// `unlock`, sent and paid for by a signer.
    Unlock { caller: u8, state: StateGiven },
    /// `Execute` called directly, as if `from` sent the token to `to`.
    Execute { from: u8, to: To },
    /// The clock set to the unlock deadline plus `offset` seconds, if that is later.
    ToDeadline { offset: i32 },
}

/// What a hook step tried.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookAction {
    /// The world as built, `bind` included.
    Start,
    Transfer {
        to_inside: bool,
    },
    TailedSwap,
    IntegratorSell,
    SweepFees,
    Bind,
    Unlock,
    Execute,
    ToDeadline,
    /// Nothing to do, such as a transfer from an empty account.
    Skip,
}

/// What the spec says a hook step does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Expected {
    Settles,
    /// Refused, for whatever reason: the hook's, Token-2022's or the runtime's.
    Refused,
    /// Refused with this error.
    RefusedWith(&'static str),
}

impl Expected {
    fn matches(&self, result: &Result<(), String>) -> bool {
        match (self, result) {
            (Expected::Settles, Ok(())) | (Expected::Refused, Err(_)) => true,
            (Expected::RefusedWith(name), Err(got)) => got == name,
            _ => false,
        }
    }
}

/// What a hook step did.
#[derive(Clone, Debug)]
pub struct HookResult {
    pub action: HookAction,
    pub expected: Expected,
    /// Success, or the error's name (the whole failure when it has none).
    pub result: Result<(), String>,
    /// Whether the step's transfer left out or substituted a hook account.
    pub broken_tail: bool,
}

impl HookResult {
    fn of(action: HookAction, expected: Expected, result: Result<(), String>) -> HookResult {
        HookResult {
            action,
            expected,
            result,
            broken_tail: false,
        }
    }

    fn skip() -> HookResult {
        HookResult::of(HookAction::Skip, Expected::Settles, Ok(()))
    }

    /// Such as `transfer to an outside account: TransferRefused`, for the run's tally.
    pub fn label(&self) -> String {
        let action = match self.action {
            HookAction::Start => "start",
            HookAction::Transfer { to_inside: true } => "transfer into the home market",
            HookAction::Transfer { to_inside: false } => "transfer to an outside account",
            HookAction::TailedSwap => "swap with hook accounts left out or substituted",
            HookAction::IntegratorSell => "sell with an integrator fee",
            HookAction::SweepFees => "sweep_fees",
            HookAction::Bind => "bind again",
            HookAction::Unlock => "unlock",
            HookAction::Execute => "Execute called directly",
            HookAction::ToDeadline => "clock set by the deadline",
            HookAction::Skip => "skipped",
        };
        let tail = if self.broken_tail {
            " (hook accounts broken)"
        } else {
            ""
        };
        match &self.result {
            Ok(()) => format!("{action}{tail}: settled"),
            Err(name) => format!(
                "{action}{tail}: {}",
                name.lines().next().unwrap_or_default()
            ),
        }
    }
}

/// What a step did: the tax AMM's outcome (for a step of the hook's own, one saying no tax
/// AMM instruction ran), the hook step's, and the compute each invocation of the hook took.
#[derive(Clone, Debug)]
pub struct HookOutcome {
    pub tax: tax::Outcome,
    pub hook: Option<HookResult>,
    pub hook_costs: Vec<(&'static str, u64)>,
}

/// What the invariants compare before and after a step.
#[derive(Clone, Debug)]
pub struct HookSnapshot {
    pub tax: tax::Snapshot,
    /// The config's and the validation account's bytes.
    pub config: Vec<u8>,
    pub validation: Vec<u8>,
    /// The mint's transfer hook fields.
    pub hook: Option<TransferHook>,
    /// What each of [`HookWorld::accounts`] holds of the contained token, the home vault and
    /// the fee account first.
    pub balances: Vec<u64>,
    pub clock: i64,
}

impl HookSnapshot {
    /// Whether the token is contained: its mint still names a transfer hook program.
    pub fn contained(&self) -> bool {
        self.hook.is_some_and(|hook| hook.program.is_some())
    }

    pub fn config(&self) -> Config {
        Config::try_deserialize(&mut self.config.as_slice()).expect("a config")
    }
}

/// How many of [`HookWorld::accounts`] are inside the home market: its vault for the token
/// and its fee account.
pub const INSIDE: usize = 2;

/// A contained token's world.
pub struct HookWorld {
    pub tax: TaxWorld,
    pub shape: HookShape,
    pub mint: Pubkey,
    pub contained: usize,
    pub quote: usize,
    /// The config as `bind` wrote it.
    pub bound: Config,
    /// The second token accounts of the contained mint, the `k`th owned by the tax world's
    /// `k`th signer.
    pub own_accounts: Vec<Pubkey>,
    /// Another tax market trading the token against the quote mint, never funded.
    pub other_market: Market,
    /// Pipeline's treasury's account for the token, where `sweep_fees` pays.
    pub treasury: Pubkey,
    /// Copies of the config and the validation account at other addresses, owned by the hook.
    pub config_copy: Pubkey,
    pub validation_copy: Pubkey,
    /// The config's and the validation account's addresses.
    pub config: Pubkey,
    pub validation: Pubkey,
    /// [`HookWorld::accounts`], which never changes once the world is built.
    known: Vec<Pubkey>,
    /// The most compute each hook instruction took.
    pub max_costs: BTreeMap<&'static str, u64>,
    /// How many hook steps did what, by [`HookResult::label`].
    pub tally: BTreeMap<String, u32>,
}

thread_local! {
    /// The tax AMM's base VM with the hook deployed, once per thread.
    static BASE: RefCell<Option<Env>> = const { RefCell::new(None) };
}

fn base_env() -> Env {
    BASE.with(|base| {
        let mut base = base.borrow_mut();
        let base = base.get_or_insert_with(|| {
            let mut env = tax::fresh_env();
            env.svm.add_program(hook_id(), &hook_so()).unwrap();
            env
        });
        Env {
            svm: base.svm.clone(),
            admin: base.admin.insecure_clone(),
        }
    })
}

/// What the hook adds while the tax world is built: the contained mint, and `bind` between
/// the market's creation and its seed, as the launch script does.
struct Containment<'a> {
    shape: &'a HookShape,
    /// What `bind` cost, less what its bump searches spent beyond each address's first
    /// bump, which its ceiling leaves out (`support/ceilings.rs`).
    bind_cost: Cell<Option<u64>>,
}

impl Surroundings for Containment<'_> {
    fn create_mint(&self, env: &mut Env, at: &Keypair) -> Pubkey {
        let options = MintOptions {
            mint_authority: true,
            transfer_hook: Some(hook_id()),
            transfer_hook_authority: Some(unlock_pda(&at.pubkey())),
            ..MintOptions::default()
        };
        env.create_mint_at(at, &TOKEN_2022, options)
    }

    fn before_seed(&self, env: &mut Env, market: &Market) -> Result<(), String> {
        let mint = market.mints[self.shape.contained as usize];
        let mut args = BindArgs::new(env, mint, market);
        args.unlock_goal = self.shape.unlock_goal;
        args.unlock_deadline = now(env) + self.shape.deadline_after;
        let meta = send_bind(env, &args, &[])?;
        let search = ceilings::bind_bump_search(&mint, market);
        self.bind_cost.set(
            hook_compute(&meta.logs)
                .first()
                .map(|cost| cost.saturating_sub(search)),
        );
        revoke_mint_authority(env, &mint);
        Ok(())
    }
}

fn read_only(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}

impl HookWorld {
    pub fn new(shape: &HookShape) -> Result<HookWorld, String> {
        let containment = Containment {
            shape,
            bind_cost: Cell::new(None),
        };
        let mut tax = TaxWorld::new_in(base_env(), &shape.tax, &containment)?;
        let (contained, quote) = (shape.contained as usize, 1 - shape.contained as usize);
        let mint = tax.market.mints[contained];
        let keys = shape.tax.keys;

        let owners: Vec<Pubkey> = tax
            .signers()
            .iter()
            .take(OWN_ACCOUNTS)
            .map(|k| k.pubkey())
            .collect();
        let own_accounts: Vec<Pubkey> = owners
            .iter()
            .enumerate()
            .map(|(k, owner)| {
                let at = key(keys, role::OWN_ACCOUNT, k);
                second_token_account_at(&mut tax.env, &at, owner, &mint)
            })
            .collect();

        // Another tax market for the token, against the same quote mint and taxed in it.
        let mut params =
            quote_taxed_params(&key(keys, role::OTHER_MARKET, 1).pubkey(), quote as u8);
        // Native SOL can't be burned.
        params.shares[0] += params.burn_share_bps;
        params.burn_share_bps = 0;
        let mut mints = [(mint, TOKEN_2022); 2];
        mints[quote] = (tax.market.mints[quote], tax.market.token_programs[quote]);
        let other_market = tax.env.create_tax_market_with(
            &key(keys, role::OTHER_MARKET, 0),
            mints,
            init_data(&params),
        )?;

        let owner = treasury_owner(&tax.env);
        let treasury = token_2022_account(&mut tax.env, &owner, &mint);
        let copy = |env: &mut Env, of: Pubkey, index: usize| {
            let at = key(keys, role::COPY, index).pubkey();
            let account = env.svm.get_account(&of).expect("account to copy");
            env.svm.set_account(at, account).unwrap();
            at
        };
        let config_copy = copy(&mut tax.env, config_pda(&mint), 0);
        let validation_copy = copy(&mut tax.env, validation_pda(&mint), 1);

        // Every account of the token outside the tax world's own, for value conservation.
        let other_fees = pda::fee_account(&other_market.market, &mint, &TOKEN_2022);
        for account in
            own_accounts
                .iter()
                .chain([&other_market.vaults[contained], &other_fees, &treasury])
        {
            tax.other_accounts.push((contained, *account));
        }

        let bound = config(&tax.env, &mint);
        let mut world = HookWorld {
            tax,
            shape: shape.clone(),
            mint,
            contained,
            quote,
            bound,
            own_accounts,
            other_market,
            treasury,
            config_copy,
            validation_copy,
            config: config_pda(&mint),
            validation: validation_pda(&mint),
            known: vec![],
            max_costs: BTreeMap::new(),
            tally: BTreeMap::new(),
        };
        world.known = world.list_accounts();
        let bind_cost = containment.bind_cost.get().ok_or("bind ran no hook")?;
        world.record(&[("bind", bind_cost)]);
        Ok(world)
    }

    /// Every account of the contained token the world knows, each once: the home vault and
    /// the fee account (the [`INSIDE`] ones), then every wallet's associated token account,
    /// the second accounts, the other market's vault and fee account, and the treasury's.
    pub fn accounts(&self) -> &[Pubkey] {
        &self.known
    }

    fn list_accounts(&self) -> Vec<Pubkey> {
        let mut seen = BTreeSet::new();
        let mut accounts = vec![];
        let market = &self.tax.market;
        let wallets = self.tax.wallets();
        let atas = wallets.iter().map(|wallet| self.ata(wallet));
        let others = self.tax.other_accounts.iter().map(|(_, account)| *account);
        for account in [market.vaults[self.contained], self.home_fees()]
            .into_iter()
            .chain(atas)
            .chain(others)
        {
            if seen.insert(account) {
                accounts.push(account);
            }
        }
        accounts
    }

    /// `owner`'s associated token account for the contained mint.
    pub fn ata(&self, owner: &Pubkey) -> Pubkey {
        pda::associated_token(owner, &self.mint, &TOKEN_2022)
    }

    pub fn home_fees(&self) -> Pubkey {
        pda::fee_account(&self.tax.market.market, &self.mint, &TOKEN_2022)
    }

    fn signer(&self, index: u8) -> Keypair {
        let signers = self.tax.signers();
        signers[index as usize % signers.len()].insecure_clone()
    }

    fn target(&self, to: To) -> Pubkey {
        match to {
            To::Holder(k) => self.ata(&self.signer(k).pubkey()),
            To::OwnAccount(k) => self.own_accounts[k as usize % self.own_accounts.len()],
            To::HomeVault => self.tax.market.vaults[self.contained],
            To::HomeFees => self.home_fees(),
            To::OtherVault => self.other_market.vaults[self.contained],
            To::Treasury => self.treasury,
        }
    }

    /// The hook accounts `tail` describes.
    fn tail(&self, tail: Tail) -> Vec<AccountMeta> {
        let program = read_only(hook_id());
        let validation = read_only(self.validation);
        let config = read_only(self.config);
        match tail {
            Tail::Complete => vec![program, validation, config],
            Tail::Missing => vec![],
            Tail::ProgramOnly => vec![program],
            Tail::NoConfig => vec![program, validation],
            Tail::NoValidation => vec![program, config],
            Tail::OtherConfig => vec![program, validation, read_only(self.config_copy)],
            Tail::OtherValidation => vec![program, read_only(self.validation_copy), config],
        }
    }

    fn mint_hook(&self) -> Option<TransferHook> {
        mint_hook(&self.tax.env, &self.mint)
    }

    fn contained_now(&self) -> bool {
        self.mint_hook().is_some_and(|hook| hook.program.is_some())
    }

    /// Records each hook instruction's compute in [`HookWorld::max_costs`].
    fn record(&mut self, costs: &[(&'static str, u64)]) {
        for &(name, cost) in costs {
            let max = self.max_costs.entry(name).or_default();
            *max = (*max).max(cost);
        }
    }

    /// The router's exact-in swap of `amount` of mint `input` by `owner` from their
    /// associated token accounts, with `tail` as the contained token's hook accounts (after
    /// the strategy's accounts on a buy, as the router's input hook accounts on a sell), the
    /// quote mint's resolved as a terminal resolves them, and an integrator fee if given.
    fn router_swap(
        &self,
        owner: &Pubkey,
        input: usize,
        amount: u64,
        tail: Vec<AccountMeta>,
        integrator: Option<(Pubkey, u16)>,
        min_amount_out: u64,
    ) -> Result<Instruction, String> {
        let env = &self.tax.env;
        let market = &self.tax.market;
        let output = 1 - input;
        let account =
            |i: usize| pda::associated_token(owner, &market.mints[i], &market.token_programs[i]);
        let (trader_input, trader_output) = (account(input), account(output));
        let mut strategy_accounts =
            env.resolve_accounts(market, &exact_in(input, output, amount))?;
        let quote_mint = market.mints[self.quote];
        let input_hook_accounts = if output == self.contained {
            strategy_accounts.extend(tail);
            env.hook_accounts(&quote_mint, trader_input, market.vaults[input], *owner)
        } else {
            strategy_accounts.extend(env.hook_accounts(
                &quote_mint,
                market.vaults[output],
                trader_output,
                market.authority,
            ));
            tail
        };
        let accounts = client::SwapAccounts {
            trader: *owner,
            strategy_program: strategy_id(),
            market_state: market.market_state,
            trader_input,
            trader_output,
            input_vault: market.vaults[input],
            input_mint: market.mints[input],
            output_mint: market.mints[output],
            input_token_program: market.token_programs[input],
            output_token_program: market.token_programs[output],
            integrator_fee_account: integrator.map(|(account, _)| account),
            strategy_accounts,
            input_hook_accounts: input_hook_accounts.clone(),
        };
        let args = client::SwapArgs {
            mode: client::TradeMode::ExactIn,
            amount_in: amount,
            amount_out: 0,
            min_amount_out,
            integrator_fee_bps: integrator.map_or(0, |(_, bps)| bps),
            input_hook_accounts: input_hook_accounts.len() as u8,
            extra: vec![],
        };
        Ok(client::swap(&accounts, &args))
    }

    /// The associated token program's `CreateIdempotent` of `owner`'s account for mint `i`,
    /// paid for by the admin, as a terminal puts it before a swap.
    fn create_account(&self, owner: &Pubkey, i: usize) -> Instruction {
        let market = &self.tax.market;
        create_token_account_idempotent(
            &self.tax.env.admin.pubkey(),
            owner,
            &market.mints[i],
            &market.token_programs[i],
        )
    }

    /// A sale of `amount` of the token by `seller` through the router with the whole hook
    /// tail and `min_amount_out`, in simulation: what it would deliver, or why it fails.
    fn simulate_sell(
        &self,
        seller: &Keypair,
        amount: u64,
        min_amount_out: u64,
    ) -> Result<u64, String> {
        let swap = self.router_swap(
            &seller.pubkey(),
            self.contained,
            amount,
            self.tail(Tail::Complete),
            None,
            min_amount_out,
        )?;
        let create = self.create_account(&seller.pubkey(), self.quote);
        let env = &self.tax.env;
        let tx = solana_transaction::Transaction::new_signed_with_payer(
            &[create, swap],
            Some(&env.admin.pubkey()),
            &[&env.admin, seller],
            env.svm.latest_blockhash(),
        );
        let meta = env
            .svm
            .simulate_transaction(tx)
            .map_err(|failed| format!("{:?}\n{}", failed.err, failed.meta.logs.join("\n")))?
            .meta;
        borsh::from_slice::<client::SwapResult>(&meta.return_data.data)
            .map(|result| result.received)
            .map_err(|e| e.to_string())
    }

    fn snapshot(&self) -> HookSnapshot {
        let env = &self.tax.env;
        let data = |address: &Pubkey| env.svm.get_account(address).expect("account").data;
        HookSnapshot {
            tax: TaxAmm::snapshot(&self.tax),
            config: data(&self.config),
            validation: data(&self.validation),
            hook: self.mint_hook(),
            balances: self
                .accounts()
                .iter()
                .map(|account| env.balance_or_zero(account))
                .collect(),
            clock: now(env),
        }
    }

    fn apply(&mut self, step: &HookStep) -> HookOutcome {
        let outcome = match *step {
            HookStep::Tax(ref step) => {
                let tax = TaxAmm::apply(&mut self.tax, step);
                let hook_costs = executes(&tax.logs);
                HookOutcome {
                    tax,
                    hook: None,
                    hook_costs,
                }
            }
            HookStep::TailedSwap {
                wallet,
                buy,
                size,
                tail,
            } if !self.contained_now() => {
                // Once the token is unlocked, integrators stop passing hook accounts: the
                // swap without them is the tax AMM's own (docs/spec/containment-hook.md,
                // "After the unlock"), and a tail left in is ignored.
                let _ = tail;
                let input = if buy { self.quote } else { self.contained };
                let step = tax::Step::Swap {
                    wallet,
                    input: input as u8,
                    size,
                };
                let tax = TaxAmm::apply(&mut self.tax, &step);
                HookOutcome {
                    tax,
                    hook: None,
                    hook_costs: vec![],
                }
            }
            ref step => {
                let (hook, logs) = self.hook_step(step);
                let hook_costs = match hook.action {
                    HookAction::Unlock if hook.result.is_ok() => hook_compute(&logs)
                        .into_iter()
                        .map(|cost| ("unlock", cost))
                        .collect(),
                    _ if hook.result.is_ok() => executes(&logs),
                    _ => vec![],
                };
                *self.tally.entry(hook.label()).or_default() += 1;
                HookOutcome {
                    tax: tax::Outcome::outside(),
                    hook: Some(hook),
                    hook_costs,
                }
            }
        };
        self.record(&outcome.hook_costs);
        outcome
    }

    /// A step of the hook's own, with the logs of the transaction it sent.
    fn hook_step(&mut self, step: &HookStep) -> (HookResult, Vec<String>) {
        let contained = self.contained_now();
        let outcome =
            |action, expected, sent: &Result<litesvm::types::TransactionMetadata, String>| {
                let result = match sent {
                    Ok(_) => Ok(()),
                    Err(failure) => Err(tax::refusal_by(failure, &super::hook_id())),
                };
                let logs = sent.as_ref().map(|m| m.logs.clone()).unwrap_or_default();
                (HookResult::of(action, expected, result), logs)
            };
        match *step {
            HookStep::Tax(_) => unreachable!("the tax AMM's steps are its own"),
            HookStep::Transfer {
                from,
                own,
                to,
                size,
                tail,
            } => {
                let owner = self.signer(from);
                let index = from as usize % self.tax.signers().len();
                let source = match self.own_accounts.get(index) {
                    Some(account) if own => *account,
                    _ => self.ata(&owner.pubkey()),
                };
                let holding = self.tax.env.balance_or_zero(&source);
                let amount = TaxWorld::sized(size, holding as u128, holding);
                if amount == 0 {
                    return (HookResult::skip(), vec![]);
                }
                let destination = self.target(to);
                let to_inside = to == To::HomeVault || to == To::HomeFees;
                let exists = self.tax.env.svm.get_account(&destination).is_some();
                // Token-2022 completes a transfer from an account to itself before it calls
                // any hook, moving nothing (docs/spec/containment-hook.md, "What this
                // allows").
                let moves = source != destination;
                let expected = if !exists {
                    Expected::Refused
                } else if !moves || !contained || (tail == Tail::Complete && to_inside) {
                    Expected::Settles
                } else if tail == Tail::Complete {
                    Expected::RefusedWith("TransferRefused")
                } else {
                    Expected::Refused
                };
                let instruction = transfer_checked(
                    &self.mint,
                    &source,
                    &destination,
                    &owner.pubkey(),
                    amount,
                    self.tail(tail),
                );
                let sent = self.tax.env.send_meta(&[instruction], &[&owner]);
                if sent.is_ok() && to == To::HomeVault {
                    // Sent straight to the vault: the tax AMM's surplus, as its donations.
                    self.tax.donated[self.contained] += amount as u128;
                }
                let (mut result, logs) =
                    outcome(HookAction::Transfer { to_inside }, expected, &sent);
                result.broken_tail = tail != Tail::Complete && moves;
                (result, logs)
            }
            HookStep::TailedSwap {
                wallet,
                buy,
                size,
                tail,
            } => {
                let trader = self.signer(wallet);
                let input = if buy { self.quote } else { self.contained };
                let budget = amount_for_budget(self.tax.holding(&trader.pubkey(), input), 0);
                let state = self.tax.state();
                let reserve = (state.reserves[input] as u128).max(1_000_000);
                let amount = TaxWorld::sized(size, reserve, budget);
                if amount == 0 {
                    return (HookResult::skip(), vec![]);
                }
                let sent = self
                    .router_swap(&trader.pubkey(), input, amount, self.tail(tail), None, 0)
                    .and_then(|swap| {
                        let create = self.create_account(&trader.pubkey(), 1 - input);
                        self.tax.env.send_meta(&[create, swap], &[&trader])
                    });
                let (mut result, logs) = outcome(HookAction::TailedSwap, Expected::Refused, &sent);
                result.broken_tail = true;
                (result, logs)
            }
            HookStep::IntegratorSell { wallet, size, bps } => {
                if !contained {
                    return (HookResult::skip(), vec![]);
                }
                let seller = wallet as usize % self.tax.signers().len();
                let trader = self.signer(wallet);
                let budget =
                    amount_for_budget(self.tax.holding(&trader.pubkey(), self.contained), bps);
                let state = self.tax.state();
                let reserve = (state.reserves[self.contained] as u128).max(1_000_000);
                let amount = TaxWorld::sized(size, reserve, budget);
                if amount == 0 {
                    return (HookResult::skip(), vec![]);
                }
                // A trader's or the stranger's account, which exists, and never the seller's
                // own, which the router refuses as the fee's destination.
                let other = (seller % OWN_ACCOUNTS + 1) % OWN_ACCOUNTS;
                let integrator = self.ata(&self.signer(other as u8).pubkey());
                // A sale the tax AMM would settle is refused by the hook, for the fee paid in
                // the token into the integrator's account; any other is refused anyway.
                let expected = match self.tax.quote(self.contained, amount).0 {
                    Ok(_) => Expected::RefusedWith("TransferRefused"),
                    Err(_) => Expected::Refused,
                };
                let sent = self
                    .router_swap(
                        &trader.pubkey(),
                        self.contained,
                        amount,
                        self.tail(Tail::Complete),
                        Some((integrator, bps)),
                        0,
                    )
                    .and_then(|swap| {
                        let create = self.create_account(&trader.pubkey(), self.quote);
                        self.tax.env.send_meta(&[create, swap], &[&trader])
                    });
                outcome(HookAction::IntegratorSell, expected, &sent)
            }
            HookStep::SweepFees { tail } => {
                if self.tax.env.balance_or_zero(&self.home_fees()) == 0 {
                    return (HookResult::skip(), vec![]);
                }
                let expected = if !contained || tail == Tail::Complete {
                    Expected::Settles
                } else {
                    Expected::Refused
                };
                let sweep = client::sweep_fees(
                    &self.tax.market.market,
                    &self.mint,
                    &TOKEN_2022,
                    &treasury_owner(&self.tax.env),
                    self.tail(tail),
                );
                let sent = self.tax.env.send_meta(&[sweep], &[]);
                let (mut result, logs) = outcome(HookAction::SweepFees, expected, &sent);
                result.broken_tail = tail != Tail::Complete;
                (result, logs)
            }
            HookStep::Bind { by, market } => {
                let market = match market {
                    BindTo::HomeMarket => &self.tax.market,
                    BindTo::OtherMarket => &self.other_market,
                };
                let mut args = BindArgs::new(&self.tax.env, self.mint, market);
                let signer = match by {
                    Binder::Launcher => None,
                    Binder::Anyone(k) => Some(self.signer(k)),
                };
                if let Some(signer) = &signer {
                    args.mint_authority = signer.pubkey();
                }
                let signers: Vec<&Keypair> = signer.iter().collect();
                let sent = send_bind(&mut self.tax.env, &args, &signers);
                outcome(HookAction::Bind, Expected::Refused, &sent)
            }
            HookStep::Unlock { caller, state } => {
                let caller = self.signer(caller);
                let recorded = self.tax.market.market_state;
                let market_state = match state {
                    StateGiven::RecordedState => recorded,
                    StateGiven::OtherState => self.other_market.market_state,
                    StateGiven::RouterMarket => self.tax.market.market,
                };
                let config = config(&self.tax.env, &self.mint);
                let due = self.tax.state().tax_collected >= config.unlock_goal as u128
                    || now(&self.tax.env) >= config.unlock_deadline;
                let expected = if config.unlocked_at.is_some() {
                    Expected::RefusedWith("AlreadyUnlocked")
                } else if market_state != recorded {
                    Expected::RefusedWith("WrongMarketState")
                } else if due {
                    Expected::Settles
                } else {
                    Expected::RefusedWith("UnlockNotDue")
                };
                let instruction = unlock_instruction(&self.mint, &market_state);
                let sent = send_as(&mut self.tax.env, &caller, &[instruction]);
                outcome(HookAction::Unlock, expected, &sent)
            }
            HookStep::Execute { from, to } => {
                let owner = self.signer(from).pubkey();
                let instruction = execute_instruction(
                    self.ata(&owner),
                    self.mint,
                    self.target(to),
                    owner,
                    self.validation,
                    self.config,
                );
                let sent = self.tax.env.send_meta(&[instruction], &[]);
                outcome(
                    HookAction::Execute,
                    Expected::RefusedWith("NotTransferring"),
                    &sent,
                )
            }
            HookStep::ToDeadline { offset } => {
                let at = self.bound.unlock_deadline + offset as i64;
                if at <= now(&self.tax.env) {
                    return (HookResult::skip(), vec![]);
                }
                let mut clock: solana_clock::Clock = self.tax.env.svm.get_sysvar();
                clock.slot += 1;
                clock.unix_timestamp = at;
                self.tax.env.svm.set_sysvar(&clock);
                (
                    HookResult::of(HookAction::ToDeadline, Expected::Settles, Ok(())),
                    vec![],
                )
            }
        }
    }
}

/// The compute of each `Execute` in a transaction's logs.
fn executes(logs: &[String]) -> Vec<(&'static str, u64)> {
    hook_compute(logs)
        .into_iter()
        .map(|cost| ("execute", cost))
        .collect()
}

/// `mantissa × 10^exp` for `exp` in the range, shrinking towards small numbers.
fn amount(exps: std::ops::RangeInclusive<u32>) -> impl Strategy<Value = u64> {
    (1u64..10, exps).prop_map(|(mantissa, exp)| mantissa * 10u64.pow(exp))
}

fn size() -> impl Strategy<Value = Size> {
    prop_oneof![
        1 => (1..=1_000u16).prop_map(Size::Dust),
        6 => (1..10u8, 0..=7u8).prop_map(|(mantissa, exp)| Size::Part { mantissa, exp }),
        2 => Just(Size::All),
    ]
}

fn tail() -> impl Strategy<Value = Tail> {
    prop_oneof![
        6 => Just(Tail::Complete),
        1 => broken_tail(),
    ]
}

fn broken_tail() -> impl Strategy<Value = Tail> {
    prop_oneof![
        Just(Tail::Missing),
        Just(Tail::ProgramOnly),
        Just(Tail::NoConfig),
        Just(Tail::NoValidation),
        Just(Tail::OtherConfig),
        Just(Tail::OtherValidation),
    ]
}

/// Mostly the traders and the stranger, who hold the token from the start.
fn wallet() -> impl Strategy<Value = u8> {
    prop_oneof![6 => 0..OWN_ACCOUNTS as u8, 1 => any::<u8>()]
}

fn to() -> impl Strategy<Value = To> {
    prop_oneof![
        3 => any::<u8>().prop_map(To::Holder),
        2 => any::<u8>().prop_map(To::OwnAccount),
        2 => Just(To::HomeVault),
        1 => Just(To::HomeFees),
        2 => Just(To::OtherVault),
        1 => Just(To::Treasury),
    ]
}

impl Product for ContainmentHook {
    type Shape = HookShape;
    type World = HookWorld;
    type Step = HookStep;
    type Snapshot = HookSnapshot;
    type Outcome = HookOutcome;

    fn shapes() -> BoxedStrategy<HookShape> {
        let goal = prop_oneof![amount(0..=7), amount(8..=13)];
        let deadline = prop_oneof![
            1 => 1..=3_600i64,
            1 => 1..=containment_hook::config::MAX_UNLOCK_DEADLINE_SECS,
        ];
        (TaxAmm::shapes(), 0..2u8, goal, deadline)
            .prop_map(|(mut tax, contained, unlock_goal, deadline_after)| {
                let (c, q) = (contained as usize, 1 - contained as usize);
                tax.mints[c] = tax::MintKind::Outside;
                tax.tax_side = q as u8;
                // Native SOL can't be burned.
                tax.burn &= tax.mints[q] != tax::MintKind::NativeSol;
                // A launchpad seeds in creation, before `bind` could run.
                if tax.creation == tax::Creation::Launchpad {
                    tax.creation = tax::Creation::CreateAndSeed;
                }
                HookShape {
                    tax,
                    contained,
                    unlock_goal,
                    deadline_after,
                }
            })
            .boxed()
    }

    fn steps() -> BoxedStrategy<HookStep> {
        prop_oneof![
            14 => TaxAmm::steps().prop_map(HookStep::Tax),
            6 => (wallet(), prop::bool::weighted(0.2), to(), size(), tail())
                .prop_map(|(from, own, to, size, tail)| HookStep::Transfer { from, own, to, size, tail }),
            2 => (wallet(), any::<bool>(), size(), broken_tail())
                .prop_map(|(wallet, buy, size, tail)| HookStep::TailedSwap { wallet, buy, size, tail }),
            1 => (wallet(), size(), 1..=100u16)
                .prop_map(|(wallet, size, bps)| HookStep::IntegratorSell { wallet, size, bps }),
            1 => tail().prop_map(|tail| HookStep::SweepFees { tail }),
            1 => (prop_oneof![Just(Binder::Launcher), any::<u8>().prop_map(Binder::Anyone)],
                  prop_oneof![Just(BindTo::HomeMarket), Just(BindTo::OtherMarket)])
                .prop_map(|(by, market)| HookStep::Bind { by, market }),
            3 => (any::<u8>(), prop_oneof![
                    6 => Just(StateGiven::RecordedState),
                    1 => Just(StateGiven::OtherState),
                    1 => Just(StateGiven::RouterMarket),
                ])
                .prop_map(|(caller, state)| HookStep::Unlock { caller, state }),
            1 => (wallet(), to()).prop_map(|(from, to)| HookStep::Execute { from, to }),
            2 => prop_oneof![3 => -2..=2i32, 1 => -100_000..=100_000i32]
                .prop_map(|offset| HookStep::ToDeadline { offset }),
        ]
        .boxed()
    }

    fn world(shape: &HookShape) -> Result<HookWorld, String> {
        HookWorld::new(shape)
    }

    fn snapshot(world: &HookWorld) -> HookSnapshot {
        world.snapshot()
    }

    fn apply(world: &mut HookWorld, step: &HookStep) -> HookOutcome {
        world.apply(step)
    }

    fn start(world: &HookWorld) -> HookOutcome {
        HookOutcome {
            tax: TaxAmm::start(&world.tax),
            hook: Some(HookResult::of(HookAction::Start, Expected::Settles, Ok(()))),
            hook_costs: world
                .max_costs
                .iter()
                .map(|(&name, &cost)| (name, cost))
                .collect(),
        }
    }

    /// The tax AMM's: every signer that holds anything sells all of it.
    fn closing_steps(world: &HookWorld) -> Vec<HookStep> {
        TaxAmm::closing_steps(&world.tax)
            .into_iter()
            .map(HookStep::Tax)
            .collect()
    }

    fn invariants() -> Vec<Invariant<ContainmentHook>> {
        invariants()
    }
}

/// The tax AMM's invariants lifted, the bar's three first; the hook's five; then each hook
/// step's outcome and the hook's compute ceilings.
pub fn invariants() -> Vec<Invariant<ContainmentHook>> {
    let mut all: Vec<Invariant<ContainmentHook>> = tax::invariants()
        .into_iter()
        .map(|inner| lift::<ContainmentHook, TaxAmm>(inner, |w| &w.tax, |s| &s.tax, |o| &o.tax))
        .collect();
    all.extend([
        Invariant::new(
            INVARIANTS[0],
            contained_tokens_move_only_through_the_home_market,
        ),
        Invariant::new(INVARIANTS[1], a_transfer_missing_a_hook_account_is_refused),
        Invariant::new(INVARIANTS[2], the_config_never_changes_but_the_unlock_time),
        Invariant::new(
            INVARIANTS[3],
            unlock_passes_exactly_when_due_and_clears_the_hook,
        ),
        Invariant::new(INVARIANTS[4], every_holder_can_sell_into_the_home_market),
        Invariant::new("each_hook_step_is_the_specs", each_hook_step_is_the_specs),
        Invariant::new(
            "hook_compute_stays_under_its_ceilings",
            hook_compute_stays_under_its_ceilings,
        ),
    ]);
    all
}

macro_rules! ensure {
    ($condition:expr, $($message:tt)+) => {
        if !$condition {
            return Err(format!($($message)+));
        }
    };
}

/// Spec 1: while the token is contained, no step moves it between two accounts that are both
/// outside the home vault and the fee account. Over every account of the token the world
/// knows, what left the outside accounts went into the vault or the fee account, and what
/// reached the outside accounts came out of them: a token moved from one outside account to
/// another would leave more than went in, and a token sent somewhere the world does not know
/// would leave without arriving.
fn contained_tokens_move_only_through_the_home_market(
    c: &Checked<'_, ContainmentHook>,
) -> Result<(), String> {
    if !c.before.contained() {
        return Ok(());
    }
    let [mut out_fell, mut out_rose, mut in_fell, mut in_rose] = [0u128; 4];
    for (k, (&before, &after)) in c.before.balances.iter().zip(&c.after.balances).enumerate() {
        let (fell, rose) = if k < INSIDE {
            (&mut in_fell, &mut in_rose)
        } else {
            (&mut out_fell, &mut out_rose)
        };
        if after < before {
            *fell += (before - after) as u128;
        } else {
            *rose += (after - before) as u128;
        }
    }
    ensure!(
        out_fell == in_rose && out_rose == in_fell,
        "outside accounts gave {out_fell} and got {out_rose}, the vault and the fee account got {in_rose} and gave {in_fell}"
    );
    Ok(())
}

/// Spec 2: while the token is contained, a transfer that leaves out or substitutes any hook
/// account is refused.
fn a_transfer_missing_a_hook_account_is_refused(
    c: &Checked<'_, ContainmentHook>,
) -> Result<(), String> {
    let Some(hook) = &c.outcome.hook else {
        return Ok(());
    };
    ensure!(
        !(c.before.contained() && hook.broken_tail && hook.result.is_ok()),
        "{:?} settled with a hook account left out or substituted",
        hook.action
    );
    Ok(())
}

/// Spec 3: the config never changes after binding, except the unlock time, which only a
/// successful `unlock` sets, once, to the clock's time; nor does the validation account.
fn the_config_never_changes_but_the_unlock_time(
    c: &Checked<'_, ContainmentHook>,
) -> Result<(), String> {
    let (before, after) = (c.before.config(), c.after.config());
    ensure!(
        c.after.config.len() == c.before.config.len(),
        "the config's size changed"
    );
    ensure!(
        Config {
            unlocked_at: None,
            ..after.clone()
        } == c.world.bound,
        "the config {after:?} where bind wrote {:?}",
        c.world.bound
    );
    ensure!(
        c.after.validation == c.before.validation,
        "the validation account changed"
    );
    let unlocked = c
        .outcome
        .hook
        .as_ref()
        .is_some_and(|hook| hook.action == HookAction::Unlock && hook.result.is_ok());
    match (before.unlocked_at, after.unlocked_at) {
        (Some(at), now) => ensure!(
            now == Some(at),
            "the unlock time changed from {at} to {now:?}"
        ),
        (None, None) => {}
        (None, Some(at)) => ensure!(
            unlocked && at == c.after.clock,
            "the unlock time became {at} by {:?} at {}",
            c.outcome.hook,
            c.after.clock
        ),
    }
    Ok(())
}

/// Spec 4: `unlock` succeeds exactly when the tax collected has reached the goal or the
/// deadline has passed (and is refused with the spec's error otherwise); a successful one
/// leaves both of the mint's hook fields unset, and nothing else ever changes them.
fn unlock_passes_exactly_when_due_and_clears_the_hook(
    c: &Checked<'_, ContainmentHook>,
) -> Result<(), String> {
    let unlock = c
        .outcome
        .hook
        .as_ref()
        .filter(|hook| hook.action == HookAction::Unlock);
    if let Some(hook) = unlock {
        ensure!(
            hook.expected.matches(&hook.result),
            "unlock: the spec gives {:?}, the program {:?}",
            hook.expected,
            hook.result
        );
    }
    let cleared = Some(TransferHook {
        authority: None,
        program: None,
    });
    if unlock.is_some_and(|hook| hook.result.is_ok()) {
        ensure!(
            c.after.hook == cleared,
            "after the unlock the mint's hook is {:?}",
            c.after.hook
        );
    } else {
        ensure!(
            c.after.hook == c.before.hook,
            "{:?} changed the mint's hook from {:?} to {:?}",
            c.outcome.hook.as_ref().map(|hook| hook.action),
            c.before.hook,
            c.after.hook
        );
    }
    if c.after.config().unlocked_at.is_some() {
        ensure!(
            c.after.hook == cleared,
            "unlocked, but the mint's hook is {:?}",
            c.after.hook
        );
    }
    Ok(())
}

/// Spec 5: every holder can still exit a contained token by selling into the home market.
/// While it is contained and its market open, every signer's whole holding of it, Pipeline's
/// fee on top, sells through the router with the hook accounts in simulation, delivering its
/// quote, whenever the quote is not refused for a reason of the tax AMM's own, which its
/// `every_holder_can_exit` checks against its spec. Tokens reach no other account of a
/// holder while contained. A step that changed neither the market, the holdings nor the
/// hook's accounts leaves the last check standing.
fn every_holder_can_sell_into_the_home_market(
    c: &Checked<'_, ContainmentHook>,
) -> Result<(), String> {
    let w = c.world;
    if !c.after.contained() || c.after.tax.state.status != MarketStatus::Open {
        return Ok(());
    }
    let start = c
        .outcome
        .hook
        .as_ref()
        .is_some_and(|hook| hook.action == HookAction::Start);
    let unchanged = c.before.tax.state_data == c.after.tax.state_data
        && c.before.balances == c.after.balances
        && c.before.config == c.after.config
        && c.before.validation == c.after.validation
        && c.before.hook == c.after.hook;
    if unchanged && !start {
        return Ok(());
    }
    for seller in w.tax.signers() {
        let holding = w.tax.holding(&seller.pubkey(), w.contained);
        let amount = amount_for_budget(holding, 0);
        if amount == 0 {
            continue;
        }
        let Ok(quote) = w.tax.quote(w.contained, amount).0 else {
            continue;
        };
        let sold = w.simulate_sell(seller, amount, quote.amount_out);
        ensure!(
            sold.as_ref() == Ok(&quote.amount_out),
            "{} can't sell {amount} of its {holding} into the home market, quoted {}: {sold:?}",
            seller.pubkey(),
            quote.amount_out
        );
    }
    Ok(())
}

/// Each hook step passes or is refused as the spec says: a transfer passes only into the
/// home vault or the fee account while the token is contained, and with every hook account;
/// a second `bind`, a sell paying an integrator fee in the token and `Execute` called
/// directly are refused; `sweep_fees` passes with the hook accounts.
fn each_hook_step_is_the_specs(c: &Checked<'_, ContainmentHook>) -> Result<(), String> {
    let Some(hook) = &c.outcome.hook else {
        return Ok(());
    };
    ensure!(
        hook.expected.matches(&hook.result),
        "{:?}: the spec gives {:?}, the program {:?}",
        hook.action,
        hook.expected,
        hook.result
    );
    Ok(())
}

/// The limits layer: every invocation of the hook a step ran stayed under its ceiling.
fn hook_compute_stays_under_its_ceilings(c: &Checked<'_, ContainmentHook>) -> Result<(), String> {
    for &(name, cost) in &c.outcome.hook_costs {
        let ceiling = match name {
            "execute" => ceilings::EXECUTE,
            "bind" => ceilings::BIND,
            "unlock" => ceilings::UNLOCK,
            other => return Err(format!("no ceiling for {other}")),
        };
        ensure!(
            cost <= ceiling,
            "{name} took {cost} CU, over its ceiling of {ceiling}"
        );
    }
    Ok(())
}
