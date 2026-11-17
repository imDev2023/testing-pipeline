//! Stateful invariant fuzzing (docs/spec/README.md, "Test layers" 3): Proptest generates
//! sequences of the instructions built so far (creation with any parameters, the seed by
//! the seeder or anyone else with any amounts, a launchpad's graduation through
//! `pipeline_seed_liquidity` with any parameters and amounts, donations to the vaults, buys
//! and sells through the router, `place_wall` by a keeper or by a trader, a buy sold
//! straight back with or without `place_wall` in between, by a stranger, the fee recipient
//! sweeping its fees or the rewards recipient settling and paying itself its rewards inside
//! the round trip, a sell bought straight back with `place_wall` in between, `settle`,
//! `pay_rewards` and `sweep_fees` for any slot to the right wallet or another, a
//! recipient's handover signed by it or by anyone else to a wallet or the default key, and a
//! recipient's token account handed to someone else) and clock jumps, from seconds to
//! across the cap's decay window, several trades often landing in one slot, sends each
//! through the router in LiteSVM, and checks after every step:
//!
//! - value is conserved: no token unit or lamport of wrapped SOL is created or lost, across
//!   every wallet, every vault and the router's fee accounts, with burns counted, and a
//!   token's supply falls by exactly what `settle` burned;
//! - every holder can exit: each trader holding a market's token can sell all of it, unless
//!   it is worth less than one lamport, or is more than the curve can take before its price
//!   bound and the most the curve can take sells (`common::exit`, `POOL4-36`);
//! - each quote equals its swap, to the unit, and a refused quote is a refused swap;
//! - the invariants of docs/spec/pool4-for-solana.md, "Ledgers", that apply so far: each
//!   vault holds at least the sum of its ledgers, the pool ledgers cover what the curve
//!   could pay out, the curve and the wall together, the curve holds no more tokens than
//!   the cap after a swap except where `MIN_LIQUIDITY` stopped a trim, the cap never rises
//!   and never falls below the cap floor, the wall's floor is never above the price, and a
//!   placed wall's top is never above the floor it was placed under;
//! - `place_wall` succeeds exactly when the program's own `wall::place` allows it, leaves
//!   the books it computes, tips exactly what it computes, and moves value only between the
//!   ledgers of each vault but for the tip;
//! - the reference never moves on a trade in the slot it was last updated in, and in a later
//!   slot moves only toward the last close, by at most `REF_STEP_BPS / 2` of itself;
//! - the decay credit never exceeds one day's allowance;
//! - a trim never changes `sqrt_price`: after a swap the price is exactly where the pricing
//!   function, run on the market as it was, put it;
//! - a swap's trades move the pool and retired token ledgers together by exactly their
//!   token flow, and the SOL ledgers by exactly their SOL flow, so a trim only moves value
//!   between ledgers, and its totals count exactly what it moved;
//! - self-dealing never profits (`INV-WG-7`, the named invariants below): a buy sold
//!   straight back never returns more than it cost once everything the trader received is
//!   counted, the SOL it sold for, the keeper tip it took and, as a recipient, the fees it
//!   swept and the rewards it paid itself (sold too), less only the part of the tip that was
//!   already there before its buy; and a sell bought straight back with `place_wall` in
//!   between, spending what it sold for and its own share of the tip, never buys back more
//!   than it sold;
//! - no instruction other than `pipeline_swap` changes `sqrt_price`, the counters, the
//!   cap, the curve's liquidity or the wall's guard, and a swap changes the counters by
//!   exactly the trade it made;
//! - every lifetime total (the tokens and SOL trimmed, the tokens the wall bought, burned
//!   and paid as rewards, the tips, the fees, both volumes and the swap count) never falls,
//!   and grows by exactly what moved (`INV-FB-15`): the burn measured on the mint, the
//!   rewards and tips measured in the accounts paid, the tokens each closed wall bought, and
//!   in a swap, the trim measured as the retired tokens and the idle SOL and fee ledgers it
//!   added;
//! - `settle`, `pay_rewards` and `sweep_fees` succeed exactly when the program's own
//!   `payouts` functions allow them with the right wallet and that wallet's account is still
//!   its own, and are otherwise refused with exactly the error those functions, the wallet
//!   check or the account check give; they leave the ledgers those functions compute, burn
//!   or pay exactly what they compute into exactly that account, and otherwise change
//!   nothing; every retired token is accounted for as burned, owed or paid as rewards;
//! - `place_wall` and a handover are refused with exactly the error the program's own
//!   `wall::place` and `payouts::handover` give;
//! - a handover succeeds exactly when the role's current recipient signs it to a wallet,
//!   recipients change only so, and what a role is owed follows it.
//!
//! Later tickets add their instructions and invariants here. `PROPTEST_CASES` sets how many
//! sequences run (256 by default, of up to 31 steps each). The self-dealing invariants are
//! named (`NAMED`): `FUZZ_INVARIANTS=<name>,...` checks only the ones it names, and a plain
//! run checks all but those `KNOWN_FAILING` lists, which fail on today's code; every other
//! invariant is checked on every run.

mod common;

use buy_wall_amm::config::{DECAY_CREDIT_WINDOW, KEEPER_TIP_CAP, MIN_LIQUIDITY, REF_STEP_BPS};
use buy_wall_amm::errors::StrategyError;
use buy_wall_amm::params::BPS;
use buy_wall_amm::state::{MarketState, STATUS_CREATED, STATUS_OPEN};
use buy_wall_amm::wall::Placement;
use common::*;
use pipeline_client::{pda, Pubkey, TradeMode};
use proptest::prelude::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[derive(Clone, Debug)]
enum Step {
    /// Create a market; `valid` picks parameters that pass, otherwise any parameters.
    Create {
        token_2022: bool,
        valid: bool,
        fee_bps: u16,
        wall_split_bps: u16,
        reward_share_bps: u16,
        cap_floor_bps: u16,
        cap_decay_bps: u16,
    },
    /// Seed market `market` (modulo the number created) with these amounts, signed by the
    /// seeder or by someone else.
    Seed {
        market: usize,
        tokens: u64,
        lamports: u64,
        by_seeder: bool,
    },
    /// Graduate a new token through the stand-in launchpad's `pipeline_seed_liquidity`,
    /// recording the market with the router in the same transaction; parameters as for
    /// `Create`, and any amounts.
    Graduate {
        token_2022: bool,
        valid: bool,
        fee_bps: u16,
        wall_split_bps: u16,
        reward_share_bps: u16,
        cap_floor_bps: u16,
        cap_decay_bps: u16,
        tokens: u64,
        lamports: u64,
    },
    /// Send tokens or wrapped SOL straight to a vault.
    Donate {
        market: usize,
        sol: bool,
        amount: u64,
    },
    /// Quote and swap through the router.
    Trade {
        market: usize,
        buy: bool,
        amount: u64,
    },
    /// Buy with `amount` lamports and sell everything bought straight back, in one slot,
    /// with `place_wall` in between when `place_wall` says so (by the trader when
    /// `by_trader`, so the trader also takes the tip), as `role`: a recipient first claims
    /// what it is already owed, then after the sell claims again (the rewards recipient
    /// settling, paying itself and selling its rewards; the fee recipient sweeping slot 0).
    RoundTrip {
        market: usize,
        amount: u64,
        place_wall: bool,
        by_trader: bool,
        role: Role,
    },
    /// Sell `amount` tokens, `place_wall` (by the trader when `by_trader`), and buy straight
    /// back with what the sell paid and the trader's own share of the tip, in one slot.
    DumpBuyBack {
        market: usize,
        amount: u64,
        by_trader: bool,
    },
    /// `place_wall`, by a fresh keeper or by a trader who already holds wrapped SOL.
    PlaceWall { market: usize, by_trader: bool },
    /// `settle`.
    Settle { market: usize },
    /// `pay_rewards`, to the rewards recipient or, without `right_wallet`, to a stranger.
    PayRewards { market: usize, right_wallet: bool },
    /// `sweep_fees { slot }` for any slot, to the slot's wallet or, without `right_wallet`,
    /// to a stranger.
    Sweep {
        market: usize,
        slot: u8,
        right_wallet: bool,
    },
    /// A handover of the fee role or the rewards role, signed by its recipient or by a
    /// stranger, to a fresh wallet or to the default key.
    Handover {
        market: usize,
        rewards: bool,
        by_recipient: bool,
        to_default: bool,
    },
    /// A recipient hands the ownership of its associated token account for its payouts (the
    /// rewards recipient's for the token, the fee recipient's for wrapped SOL) to someone
    /// else, which SPL Token allows, so its payouts must be refused until it hands its role
    /// over.
    BreakRecipient { market: usize, rewards: bool },
    /// Move the clock forward.
    Warp { seconds: i64, slots: u64 },
}

/// Who trades a round trip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    /// A fresh wallet.
    Stranger,
    /// The market's fee recipient, which sweeps fee slot 0 inside the round trip.
    FeeRecipient,
    /// The market's rewards recipient, which settles and pays itself its rewards inside the
    /// round trip (SOS hypothesis H002, the wash trade of the decay credit).
    RewardsRecipient,
}

impl Role {
    /// The named invariant a round trip by this role checks.
    fn invariant(self) -> &'static str {
        match self {
            Role::Stranger => "round-trip",
            Role::FeeRecipient => "round-trip-fee-recipient",
            Role::RewardsRecipient => "round-trip-rewards-recipient",
        }
    }
}

/// The invariants `FUZZ_INVARIANTS` can name; every other invariant is checked on every run.
const NAMED: &[&str] = &[
    "round-trip",
    "round-trip-fee-recipient",
    "round-trip-rewards-recipient",
    "dump-buy-back",
];

/// Named invariants that fail on today's code, so a plain run leaves them out; each runs
/// when `FUZZ_INVARIANTS` names it, and the test below its counterexample replays it.
const KNOWN_FAILING: &[&str] = &["round-trip-rewards-recipient"];

/// Whether the named invariant `name` is checked in this run: those `FUZZ_INVARIANTS` names,
/// or without it all but `KNOWN_FAILING`. Naming one that does not exist fails, so a typo
/// can't make a run check nothing.
fn enabled(name: &str) -> bool {
    static SELECTED: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    assert!(NAMED.contains(&name), "{name} is not a named invariant");
    SELECTED
        .get_or_init(|| match std::env::var("FUZZ_INVARIANTS") {
            Ok(names) => {
                let names: Vec<String> = names.split(',').map(|n| n.trim().to_string()).collect();
                for name in &names {
                    assert!(
                        NAMED.contains(&name.as_str()),
                        "FUZZ_INVARIANTS names {name}, which is not an invariant: {NAMED:?}"
                    );
                }
                names
            }
            Err(_) => NAMED
                .iter()
                .filter(|name| !KNOWN_FAILING.contains(name))
                .map(|name| name.to_string())
                .collect(),
        })
        .iter()
        .any(|selected| selected == name)
}

fn role() -> impl Strategy<Value = Role> {
    prop_oneof![
        2 => Just(Role::Stranger),
        1 => Just(Role::FeeRecipient),
        1 => Just(Role::RewardsRecipient),
    ]
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        2 => (any::<bool>(), prop::bool::weighted(0.8), 0..400u16, 0..10_500u16, 0..3_500u16, 0..10_500u16, 0..10_500u16)
            .prop_map(|(token_2022, valid, fee_bps, wall_split_bps, reward_share_bps, cap_floor_bps, cap_decay_bps)| {
                Step::Create { token_2022, valid, fee_bps, wall_split_bps, reward_share_bps, cap_floor_bps, cap_decay_bps }
            }),
        1 => ((any::<bool>(), prop::bool::weighted(0.8), 0..400u16, 0..10_500u16, 0..3_500u16, 0..10_500u16, 0..10_500u16), seed_tokens(), seed_lamports())
            .prop_map(|((token_2022, valid, fee_bps, wall_split_bps, reward_share_bps, cap_floor_bps, cap_decay_bps), tokens, lamports)| {
                Step::Graduate { token_2022, valid, fee_bps, wall_split_bps, reward_share_bps, cap_floor_bps, cap_decay_bps, tokens, lamports }
            }),
        3 => (any::<usize>(), seed_tokens(), seed_lamports(), prop::bool::weighted(0.85))
            .prop_map(|(market, tokens, lamports, by_seeder)| Step::Seed { market, tokens, lamports, by_seeder }),
        1 => (any::<usize>(), any::<bool>(), 1..1_000_000_000u64)
            .prop_map(|(market, sol, amount)| Step::Donate { market, sol, amount }),
        5 => (any::<usize>(), any::<bool>(), trade_amount())
            .prop_map(|(market, buy, amount)| Step::Trade { market, buy, amount }),
        2 => (any::<usize>(), trade_amount(), any::<bool>(), any::<bool>(), role())
            .prop_map(|(market, amount, place_wall, by_trader, role)| Step::RoundTrip { market, amount, place_wall, by_trader, role }),
        1 => (any::<usize>(), trade_amount(), prop::bool::weighted(0.8))
            .prop_map(|(market, amount, by_trader)| Step::DumpBuyBack { market, amount, by_trader }),
        3 => (any::<usize>(), any::<bool>())
            .prop_map(|(market, by_trader)| Step::PlaceWall { market, by_trader }),
        2 => (clock_jump(), 0..1_000u64).prop_map(|(seconds, slots)| Step::Warp { seconds, slots }),
        3 => any::<usize>().prop_map(|market| Step::Settle { market }),
        3 => (any::<usize>(), prop::bool::weighted(0.85))
            .prop_map(|(market, right_wallet)| Step::PayRewards { market, right_wallet }),
        3 => (any::<usize>(), 0..4u8, prop::bool::weighted(0.85))
            .prop_map(|(market, slot, right_wallet)| Step::Sweep { market, slot, right_wallet }),
        2 => (any::<usize>(), any::<bool>(), prop::bool::weighted(0.7), prop::bool::weighted(0.15))
            .prop_map(|(market, rewards, by_recipient, to_default)| Step::Handover { market, rewards, by_recipient, to_default }),
        1 => (any::<usize>(), any::<bool>())
            .prop_map(|(market, rewards)| Step::BreakRecipient { market, rewards }),
    ]
}

/// Clock jumps from a second to several days, many of them around the cap's decay window,
/// where the decay credit stops building up.
fn clock_jump() -> impl Strategy<Value = i64> {
    let window = DECAY_CREDIT_WINDOW;
    prop_oneof![
        0..120i64,
        120..window,
        window - 60..window + 60,
        window..4 * window,
    ]
}

/// Trade sizes from zero and dust to more than a whole pool: lamports for a buy and token
/// units for a sell, including sells of 0.1% to twice the default market's seeded tokens,
/// which reach into and through the buy wall.
fn trade_amount() -> impl Strategy<Value = u64> {
    prop_oneof![
        0..1_000u64,
        1_000..10 * SOL,
        1_000_000_000..2_000_000_000_000u64,
        10 * SOL..u64::MAX / 8,
    ]
}

/// Seed sizes around every bound: tiny, typical and huge.
fn seed_tokens() -> impl Strategy<Value = u64> {
    prop_oneof![0..10u64, 1..1_000_000_000u64, 1_000_000_000..u64::MAX / 4]
}

fn seed_lamports() -> impl Strategy<Value = u64> {
    prop_oneof![
        0..buy_wall_amm::config::MIN_SEED_LAMPORTS,
        buy_wall_amm::config::MIN_SEED_LAMPORTS..1_000 * SOL,
        Just(buy_wall_amm::config::MIN_SEED_LAMPORTS),
    ]
}

/// What the test knows about one market, to check the program against.
struct Tracked {
    market: Market,
    seeder: Keypair,
    /// The market state when last checked, to compare with after the next step.
    last: MarketState,
    /// The floor the placed wall was placed under.
    placed_under: Option<u128>,
    /// Dust tokens `place_wall` has retired so far, which no lifetime total counts.
    dust_tokens: u128,
    /// The fee recipient and the rewards recipient, as the test expects them; `None` for a
    /// role the market was created without.
    fee_recipient: Option<Keypair>,
    rewards_recipient: Option<Keypair>,
    /// Token units `settle` burned, by the test's own count, measured on the vault and the
    /// mint's supply: in all, and when last checked.
    burned: u128,
    burned_checked: u128,
    /// Lamports `sweep_fees` paid out, by the recipients' balances: in all, and when last
    /// checked.
    swept: u128,
    swept_checked: u128,
    /// Token units `pay_rewards` paid out, by the recipients' balances: in all, and when last
    /// checked.
    paid: u128,
    paid_checked: u128,
    /// Lamports `place_wall` tipped, by the callers' balances: in all, and when last checked.
    tipped: u128,
    tipped_checked: u128,
}

impl Tracked {
    fn new(market: Market, seeder: Keypair, last: MarketState, recipients: Recipients) -> Self {
        Tracked {
            market,
            seeder,
            last,
            placed_under: None,
            dust_tokens: 0,
            fee_recipient: recipients.fee,
            rewards_recipient: recipients.rewards,
            burned: 0,
            burned_checked: 0,
            swept: 0,
            swept_checked: 0,
            paid: 0,
            paid_checked: 0,
            tipped: 0,
            tipped_checked: 0,
        }
    }

    fn recipient(&self, rewards: bool) -> Option<&Keypair> {
        if rewards {
            self.rewards_recipient.as_ref()
        } else {
            self.fee_recipient.as_ref()
        }
    }

    fn key(recipient: Option<&Keypair>) -> Pubkey {
        recipient.map(|k| k.pubkey()).unwrap_or_default()
    }
}

/// A market's recipients, chosen with its creation parameters.
struct Recipients {
    fee: Option<Keypair>,
    rewards: Option<Keypair>,
}

/// The supply every token starts with: the harness funds wallets by writing their accounts
/// straight into the VM, so the fuzzer sets a supply that covers every balance, and checks
/// that only `settle` lowers it.
const SUPPLY: u64 = u64::MAX / 2;

struct World {
    env: Env,
    markets: Vec<Tracked>,
    /// Token units and lamports given out to wallets so far, per mint.
    minted: std::collections::HashMap<Pubkey, u128>,
    /// Every token account the test ever funded, per mint.
    holders: std::collections::HashMap<Pubkey, Vec<Pubkey>>,
    /// Traders who bought a market's token: (market, wallet).
    buyers: Vec<(usize, Pubkey)>,
    /// The last trader to buy each market's token, who can then place its wall.
    traders: std::collections::HashMap<usize, Keypair>,
    /// The swaps the last step made, in order: (market, trade), checked against the
    /// counters, the ledgers and the price.
    swapped: Vec<(usize, Swapped)>,
    /// What each `place_wall` since the last check did: (market, placement).
    placed: Vec<(usize, Placement)>,
}

/// What a successful swap did, from the trader's side, and the price the pricing function
/// gave it on the market as it was before it.
#[derive(Clone, Copy, Debug)]
struct Swapped {
    buy: bool,
    amount_in: u64,
    amount_out: u64,
    fee: u64,
    sqrt_price: u128,
}

/// What the curve holds at its price, `floor(L × Q / s)`, with the program's own function.
fn held(state: &MarketState) -> u128 {
    buy_wall_amm::cap::held(state.liquidity(), state.sqrt_price())
        .expect("a seeded market's price is above 0")
}

impl World {
    fn new() -> Self {
        World {
            env: Env::new(),
            markets: vec![],
            minted: Default::default(),
            holders: Default::default(),
            buyers: vec![],
            traders: Default::default(),
            swapped: vec![],
            placed: vec![],
        }
    }

    /// Gives `owner` more of `mint` (topping up their associated token account).
    fn give(&mut self, owner: &Pubkey, mint: &Pubkey, program: &Pubkey, amount: u64) {
        let account = pda::associated_token(owner, mint, program);
        let current = self
            .env
            .svm
            .get_account(&account)
            .map(|_| self.env.balance(&account))
            .unwrap_or(0);
        let total = current
            .checked_add(amount)
            .expect("test funding fits in u64");
        write_token_account(&mut self.env.svm, mint, program, owner, total).unwrap();
        *self.minted.entry(*mint).or_default() += amount as u128;
        let holders = self.holders.entry(*mint).or_default();
        if !holders.contains(&account) {
            holders.push(account);
        }
    }

    fn pick(&self, index: usize) -> Option<usize> {
        (!self.markets.is_empty()).then(|| index % self.markets.len())
    }

    fn apply(&mut self, step: &Step) {
        match *step {
            Step::Create {
                token_2022,
                valid,
                fee_bps,
                wall_split_bps,
                reward_share_bps,
                cap_floor_bps,
                cap_decay_bps,
            } => {
                let program = if token_2022 { TOKEN_2022 } else { TOKEN };
                let token = self.env.seedable_token(&program);
                common::payouts::set_supply(&mut self.env, &token, SUPPLY);
                let seeder = Keypair::new();
                self.env.svm.airdrop(&seeder.pubkey(), SOL).unwrap();
                let (params, recipients) = creation_params(
                    seeder.pubkey(),
                    valid,
                    [
                        fee_bps,
                        wall_split_bps,
                        reward_share_bps,
                        cap_floor_bps,
                        cap_decay_bps,
                    ],
                );
                let accepted = params.validate().is_ok();
                let result = self.env.create_market(token, program, &params);
                assert_eq!(
                    result.is_ok(),
                    accepted,
                    "creation of {params:?}: {result:?}"
                );
                if let Ok(market) = result {
                    let last = self.env.state(&market);
                    assert_eq!(last.status, STATUS_CREATED);
                    self.markets
                        .push(Tracked::new(market, seeder, last, recipients));
                }
            }
            Step::Seed {
                market,
                tokens,
                lamports,
                by_seeder,
            } => {
                let Some(i) = self.pick(market) else { return };
                let tracked = &self.markets[i];
                let (m, seeder_key) = (tracked.market.clone(), tracked.seeder.pubkey());
                let signer = if by_seeder {
                    tracked.seeder.insecure_clone()
                } else {
                    Keypair::new()
                };
                self.env.svm.airdrop(&signer.pubkey(), SOL).unwrap();
                self.give(&signer.pubkey(), &m.token_mint, &m.token_program, tokens);
                self.give(&signer.pubkey(), &WSOL, &TOKEN, lamports);
                let before = self.env.state(&m);
                let expected = buy_wall_amm::opening::open(
                    tokens,
                    lamports,
                    before.cap_floor_bps(),
                    before.cap_decay_bps(),
                );
                let ix = seed_ix(&m, &signer.pubkey(), tokens, lamports, vec![]);
                let result = self.env.send(&[ix], &[&signer]);
                let should_open = by_seeder
                    && signer.pubkey() == seeder_key
                    && before.status == STATUS_CREATED
                    && expected.is_ok();
                assert_eq!(
                    result.is_ok(),
                    should_open,
                    "seed {tokens}/{lamports}: {result:?}"
                );
                if let Ok(opened) = expected {
                    if should_open {
                        let after = self.env.state(&m);
                        assert_eq!(after.sqrt_price(), opened.sqrt_price);
                        assert_eq!(after.liquidity(), opened.liquidity);
                        assert_eq!((after.pool_tokens(), after.pool_sol()), (tokens, lamports));
                        assert_eq!(after.cap(), tokens);
                    }
                }
            }
            Step::Graduate {
                token_2022,
                valid,
                fee_bps,
                wall_split_bps,
                reward_share_bps,
                cap_floor_bps,
                cap_decay_bps,
                tokens,
                lamports,
            } => {
                let program = if token_2022 { TOKEN_2022 } else { TOKEN };
                let token = self.env.seedable_token(&program);
                common::payouts::set_supply(&mut self.env, &token, SUPPLY);
                let launch = self.env.launch(token, program, 0, 0);
                self.give(&launch.seeder, &token, &program, tokens);
                self.give(&launch.seeder, &WSOL, &TOKEN, lamports);
                // The seeder named here is ignored for the launchpad's PDA.
                let (params, recipients) = creation_params(
                    Pubkey::new_unique(),
                    valid,
                    [
                        fee_bps,
                        wall_split_bps,
                        reward_share_bps,
                        cap_floor_bps,
                        cap_decay_bps,
                    ],
                );
                let expected = params.validate().ok().map(|()| {
                    buy_wall_amm::opening::open(
                        tokens,
                        lamports,
                        params.cap_floor_bps,
                        params.cap_decay_bps,
                    )
                });
                let result = self.env.graduate(&launch, &params, tokens, lamports);
                match (&result, expected) {
                    (Ok(graduated), Some(Ok(opened))) => {
                        assert_eq!(graduated.graduation.taken, vec![tokens, lamports]);
                        assert_eq!(graduated.graduation.lp_amount, 0);
                        let m = graduated.market.clone();
                        let after = self.env.state(&m);
                        assert_eq!(after.status, STATUS_OPEN);
                        assert_eq!(after.seeder, launch.seeder);
                        assert_eq!(after.sqrt_price(), opened.sqrt_price);
                        assert_eq!(after.liquidity(), opened.liquidity);
                        assert_eq!((after.pool_tokens(), after.pool_sol()), (tokens, lamports));
                        assert_eq!(after.cap(), tokens);
                        // The launch's creator stands in for the seeder, which is a PDA:
                        // a later `Seed` step by it is refused, as by anyone.
                        self.markets
                            .push(Tracked::new(m, launch.creator, after, recipients));
                    }
                    (Err(_), None | Some(Err(_))) => {
                        assert!(self.env.svm.get_account(&launch.market_state()).is_none());
                    }
                    _ => panic!(
                        "graduation of {params:?} with {tokens}/{lamports}: {:?}",
                        result.map(|_| ())
                    ),
                }
            }
            Step::Donate {
                market,
                sol,
                amount,
            } => {
                let Some(i) = self.pick(market) else { return };
                let m = self.markets[i].market.clone();
                let donor = Keypair::new();
                self.env.svm.airdrop(&donor.pubkey(), SOL).unwrap();
                let (mint, program, vault) = if sol {
                    (WSOL, TOKEN, m.sol_vault)
                } else {
                    (m.token_mint, m.token_program, m.token_vault)
                };
                self.give(&donor.pubkey(), &mint, &program, amount);
                let from = pda::associated_token(&donor.pubkey(), &mint, &program);
                let ix = spl_token_2022_interface::instruction::transfer_checked(
                    &program,
                    &from,
                    &mint,
                    &vault,
                    &donor.pubkey(),
                    &[],
                    amount,
                    if sol { 9 } else { 6 },
                )
                .unwrap();
                self.env.send(&[ix], &[&donor]).unwrap();
            }
            Step::Trade {
                market,
                buy,
                amount,
            } => {
                let Some(i) = self.pick(market) else { return };
                self.trade(i, buy, amount, Keypair::new());
            }
            Step::RoundTrip {
                market,
                amount,
                place_wall,
                by_trader,
                role,
            } => {
                let Some(i) = self.pick(market) else { return };
                self.round_trip(i, amount, place_wall, by_trader, role);
            }
            Step::DumpBuyBack {
                market,
                amount,
                by_trader,
            } => {
                let Some(i) = self.pick(market) else { return };
                self.dump_buy_back(i, amount, by_trader);
            }
            Step::PlaceWall { market, by_trader } => {
                let Some(i) = self.pick(market) else { return };
                let keeper = match self.traders.get(&i) {
                    Some(trader) if by_trader => trader.insecure_clone(),
                    _ => Keypair::new(),
                };
                self.place_wall(i, &keeper);
            }
            Step::Warp { seconds, slots } => {
                let clock = self.env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
                self.env
                    .set_clock(clock.slot + slots + 1, clock.unix_timestamp + seconds);
            }
            Step::Settle { market } => {
                let Some(i) = self.pick(market) else { return };
                self.settle(i);
            }
            Step::PayRewards {
                market,
                right_wallet,
            } => {
                let Some(i) = self.pick(market) else { return };
                self.pay_rewards(i, right_wallet);
            }
            Step::Sweep {
                market,
                slot,
                right_wallet,
            } => {
                let Some(i) = self.pick(market) else { return };
                self.sweep(i, slot, right_wallet);
            }
            Step::Handover {
                market,
                rewards,
                by_recipient,
                to_default,
            } => {
                let Some(i) = self.pick(market) else { return };
                self.handover(i, rewards, by_recipient, to_default);
            }
            Step::BreakRecipient { market, rewards } => {
                let Some(i) = self.pick(market) else { return };
                let tracked = &self.markets[i];
                let Some(recipient) = tracked.recipient(rewards) else {
                    return;
                };
                let recipient = recipient.insecure_clone();
                let (mint, program) = if rewards {
                    (tracked.market.token_mint, tracked.market.token_program)
                } else {
                    (WSOL, TOKEN)
                };
                // Token-2022's associated accounts have immutable owners.
                if program != TOKEN {
                    return;
                }
                let account = pda::associated_token(&recipient.pubkey(), &mint, &program);
                if self.env.svm.get_account(&account).is_none() {
                    self.give(&recipient.pubkey(), &mint, &program, 0);
                }
                if !self.own_account(&recipient.pubkey(), &mint, &program) {
                    return;
                }
                self.env.svm.airdrop(&recipient.pubkey(), SOL).unwrap();
                let ix = spl_token_2022_interface::instruction::set_authority(
                    &TOKEN,
                    &account,
                    Some(&Pubkey::new_unique()),
                    spl_token_2022_interface::instruction::AuthorityType::AccountOwner,
                    &recipient.pubkey(),
                    &[],
                )
                .unwrap();
                self.env.send(&[ix], &[&recipient]).unwrap();
            }
        }
    }

    /// A buy of `amount` lamports on market `i` sold straight back, in one slot, with
    /// `place_wall` in between when `place_wall` says so, as `role` (`INV-WG-7`). Whatever
    /// the trader receives, the SOL its sells pay, the tip it takes and what it claims as a
    /// recipient, never exceeds what its buy cost plus the part of the tip that was already
    /// there before its buy (`tip_free`): the naive bound without it is false, since a small
    /// buy can lift `idle_sol` over `WALL_THRESHOLD` and so unlock a tip earned by others.
    /// A recipient first claims what it is already owed, so all it claims inside the round
    /// trip its own trades created. Every invariant is checked after each instruction.
    fn round_trip(&mut self, i: usize, amount: u64, place_wall: bool, by_trader: bool, role: Role) {
        let m = self.markets[i].market.clone();
        let recipient = match role {
            Role::Stranger => None,
            Role::FeeRecipient => self.markets[i].fee_recipient.as_ref(),
            Role::RewardsRecipient => self.markets[i].rewards_recipient.as_ref(),
        }
        .map(Keypair::insecure_clone);
        // A market without the role is traded by a stranger.
        let role = if recipient.is_some() {
            role
        } else {
            Role::Stranger
        };
        let trader = recipient.unwrap_or_else(Keypair::new);
        if self.env.svm.get_account(&trader.pubkey()).is_none() {
            self.env.svm.airdrop(&trader.pubkey(), SOL).unwrap();
        }
        // Accounts of its own for both mints (one a `BreakRecipient` step handed away is
        // handed back, as its owner can).
        self.give(&trader.pubkey(), &m.token_mint, &m.token_program, 0);
        self.give(&trader.pubkey(), &WSOL, &TOKEN, 0);
        match role {
            Role::Stranger => {}
            Role::FeeRecipient => {
                self.sweep(i, 0, true);
                self.check_markets();
                assert_eq!(self.env.state(&m).fees_recipient(), 0, "slot 0 swept");
            }
            Role::RewardsRecipient => {
                self.settle(i);
                self.check_markets();
                self.pay_rewards(i, true);
                self.check_markets();
                let state = self.env.state(&m);
                assert_eq!(
                    (state.retired_tokens(), state.rewards_owed()),
                    (0, 0),
                    "every reward already earned paid"
                );
            }
        }
        let free = tip_free(&self.env.state(&m));
        let Some(bought) = self.trade(i, true, amount, trader.insecure_clone()) else {
            return;
        };
        let mut tip = 0;
        if place_wall {
            self.check_markets();
            let keeper = if by_trader {
                trader.insecure_clone()
            } else {
                Keypair::new()
            };
            let tipped = self.place_wall(i, &keeper);
            if by_trader {
                tip = tipped.unwrap_or(0);
            }
            self.check_markets();
        }
        let Some(sold) = self.trade(i, false, bought, trader.insecure_clone()) else {
            return;
        };
        let mut claimed = 0u64;
        match role {
            Role::Stranger => {}
            Role::FeeRecipient => {
                self.check_markets();
                claimed = self.sweep(i, 0, true).unwrap_or(0);
            }
            Role::RewardsRecipient => {
                self.check_markets();
                self.settle(i);
                self.check_markets();
                if let Some(paid) = self.pay_rewards(i, true) {
                    self.check_markets();
                    // The rewards are worth what they sell for.
                    claimed = self.trade(i, false, paid, trader).unwrap_or(0);
                }
            }
        }
        let received = sold as u128 + claimed as u128 + tip as u128;
        let free = tip.min(free);
        let name = role.invariant();
        if enabled(name) {
            assert!(
                received <= amount as u128 + free as u128,
                "{name}: self-dealing profited: a buy of {amount} lamports returned {sold} sold, \
                 {claimed} claimed and a tip of {tip} (of which {free} was there before the buy)"
            );
        }
    }

    /// A sell of `amount` tokens on market `i`, `place_wall` (by the trader when
    /// `by_trader`), and a buy straight back with what the sell paid and the part of the
    /// tip the trader's own trade created, in one slot (`INV-WG-7` (b)): never more tokens
    /// back than it sold.
    fn dump_buy_back(&mut self, i: usize, amount: u64, by_trader: bool) {
        let trader = Keypair::new();
        let free = tip_free(&self.env.state(&self.markets[i].market));
        let Some(out) = self.trade(i, false, amount, trader.insecure_clone()) else {
            return;
        };
        self.check_markets();
        let keeper = if by_trader {
            trader.insecure_clone()
        } else {
            Keypair::new()
        };
        let tipped = self.place_wall(i, &keeper);
        self.check_markets();
        let tip = if by_trader { tipped.unwrap_or(0) } else { 0 };
        let spend = out + (tip - tip.min(free));
        let Some(back) = self.trade(i, true, spend, trader) else {
            return;
        };
        if enabled("dump-buy-back") {
            assert!(
                back <= amount,
                "dump-buy-back: self-dealing profited: a sell of {amount} tokens for {out} \
                 lamports and a tip of {tip} (of which {free} was there before the sell) \
                 bought back {back}"
            );
        }
    }

    /// Whether `owner`'s associated token account for `mint` is missing or still `owner`'s,
    /// read from the account itself: a payout into it may go ahead.
    fn own_account(&self, owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> bool {
        let account = pda::associated_token(owner, mint, program);
        match self.env.svm.get_account(&account) {
            None => true,
            Some(account) => account.data[32..64] == owner.to_bytes(),
        }
    }

    /// Counts a token account the program paid into, once it exists, as a holder.
    fn count_holder(&mut self, mint: &Pubkey, account: Pubkey) {
        if self.env.svm.get_account(&account).is_none() {
            return;
        }
        let holders = self.holders.entry(*mint).or_default();
        if !holders.contains(&account) {
            holders.push(account);
        }
    }

    /// The balance of a token account, 0 when it does not exist.
    fn held(&self, account: &Pubkey) -> u64 {
        self.env
            .svm
            .get_account(account)
            .map(|_| self.env.balance(account))
            .unwrap_or(0)
    }

    /// `settle` on market `i`: checked against the program's own `payouts` on an open
    /// market, accepted or refused with exactly its error, with the burn measured on the vault and the mint's
    /// supply.
    fn settle(&mut self, i: usize) {
        let m = self.markets[i].market.clone();
        let before = self.env.state(&m);
        let expected = open(&before).and_then(|()| {
            before
                .owed()
                .settle(before.reward_share_bps())
                .map_err(StrategyError::from)
        });
        let (vault, supply) = (
            self.env.balance(&m.token_vault),
            supply_of(&self.env, &m.token_mint),
        );
        let result = self.env.send_logged(&[common::payouts::settle_ix(&m)], &[]);
        assert_outcome("settle", &expected, &result);
        let (Ok((owed, split)), Ok((_, logs))) = (expected, &result) else {
            return;
        };
        let after = self.env.state(&m);
        // The spec's split, stated here independently of the program's maths.
        let retired = before.retired_tokens() as u128;
        let to_rewards = retired * before.reward_share_bps() as u128 / 10_000;
        assert_eq!(
            (split.to_rewards as u128, split.burned as u128),
            (to_rewards, retired - to_rewards)
        );
        assert_eq!(after.owed(), owed);
        assert_eq!(self.env.balance(&m.token_vault), vault - split.burned);
        assert_eq!(supply_of(&self.env, &m.token_mint), supply - split.burned);
        assert_eq!(
            events::<buy_wall_amm::events::Settled>(logs).len(),
            1,
            "settle emits Settled"
        );
        self.markets[i].burned += split.burned as u128;
    }

    /// `pay_rewards` on market `i`, to the rewards recipient or a stranger: it succeeds
    /// exactly when `payouts` allows it, the wallet is the recipient and its account is its
    /// own, and then pays exactly what was owed into exactly that account; otherwise it is
    /// refused with exactly the error of the first check that fails, in the program's order
    /// (the market is open, `payouts`, the wallet, its account). Returns what it paid.
    fn pay_rewards(&mut self, i: usize, right_wallet: bool) -> Option<u64> {
        let m = self.markets[i].market.clone();
        let before = self.env.state(&m);
        let recipient = if right_wallet {
            Tracked::key(self.markets[i].rewards_recipient.as_ref())
        } else {
            Pubkey::new_unique()
        };
        let payer = Keypair::new();
        self.env.svm.airdrop(&payer.pubkey(), SOL).unwrap();
        let account = pda::associated_token(&recipient, &m.token_mint, &m.token_program);
        let held = self.held(&account);
        let own = self.own_account(&recipient, &m.token_mint, &m.token_program);
        let expected = open(&before)
            .and_then(|()| {
                before
                    .owed()
                    .pay_rewards(&before.rewards_recipient)
                    .map_err(StrategyError::from)
            })
            .and_then(|paid| {
                if recipient.to_bytes() != before.rewards_recipient.to_bytes() {
                    Err(StrategyError::WrongAccount)
                } else if !own {
                    Err(StrategyError::RecipientAccountNotTheirs)
                } else {
                    Ok(paid)
                }
            });
        let ix = common::payouts::pay_rewards_ix(&m, &payer.pubkey(), &recipient, vec![]);
        let result = self.env.send_logged(&[ix], &[&payer]);
        assert_outcome("pay_rewards", &expected, &result);
        let (Ok((owed, amount)), Ok((_, logs))) = (expected, &result) else {
            return None;
        };
        assert_eq!(self.env.state(&m).owed(), owed);
        let paid = self.held(&account) - held;
        assert_eq!(paid, amount);
        assert_eq!(events::<buy_wall_amm::events::RewardsPaid>(logs).len(), 1);
        self.count_holder(&m.token_mint, account);
        self.markets[i].paid += paid as u128;
        Some(paid)
    }

    /// `sweep_fees { slot }` on market `i`, to the slot's wallet or a stranger, checked as
    /// `pay_rewards` is. Returns what it paid.
    fn sweep(&mut self, i: usize, slot: u8, right_wallet: bool) -> Option<u64> {
        let m = self.markets[i].market.clone();
        let before = self.env.state(&m);
        let fee_recipient = before.fee_recipient;
        let wallet = buy_wall_amm::payouts::slot_wallet(slot, &fee_recipient);
        let recipient: Pubkey = match (right_wallet, wallet) {
            (true, Ok(wallet)) => wallet.to_bytes().into(),
            (true, Err(_)) => Pubkey::default(),
            (false, _) => Pubkey::new_unique(),
        };
        let payer = Keypair::new();
        self.env.svm.airdrop(&payer.pubkey(), SOL).unwrap();
        let account = pda::associated_token(&recipient, &WSOL, &TOKEN);
        let held = self.held(&account);
        let own = self.own_account(&recipient, &WSOL, &TOKEN);
        let expected = open(&before)
            .and_then(|()| {
                before
                    .owed()
                    .sweep(slot, &fee_recipient)
                    .map_err(StrategyError::from)
            })
            .and_then(|(owed, wallet, amount)| {
                if recipient.to_bytes() != wallet.to_bytes() {
                    Err(StrategyError::WrongAccount)
                } else if !own {
                    Err(StrategyError::RecipientAccountNotTheirs)
                } else {
                    Ok((owed, amount))
                }
            });
        let ix = common::payouts::sweep_fees_ix(&m, &payer.pubkey(), &recipient, slot);
        let result = self.env.send_logged(&[ix], &[&payer]);
        assert_outcome(&format!("sweep_fees {slot}"), &expected, &result);
        let (Ok((owed, amount)), Ok((_, logs))) = (expected, &result) else {
            return None;
        };
        assert_eq!(self.env.state(&m).owed(), owed);
        let paid = self.held(&account) - held;
        assert_eq!(paid, amount);
        assert_eq!(events::<buy_wall_amm::events::FeesSwept>(logs).len(), 1);
        self.count_holder(&WSOL, account);
        self.markets[i].swept += paid as u128;
        Some(paid)
    }

    /// A handover on market `i`: it succeeds exactly when the role's current recipient signs
    /// it to a wallet that is not the default key, and is otherwise refused with exactly the
    /// error `payouts::handover` gives.
    fn handover(&mut self, i: usize, rewards: bool, by_recipient: bool, to_default: bool) {
        let m = self.markets[i].market.clone();
        let current = self.markets[i]
            .recipient(rewards)
            .map(|k| k.insecure_clone());
        let signer = match &current {
            Some(recipient) if by_recipient => recipient.insecure_clone(),
            _ => Keypair::new(),
        };
        self.env.svm.airdrop(&signer.pubkey(), SOL).unwrap();
        let new = Keypair::new();
        let new_key = if to_default {
            Pubkey::default()
        } else {
            new.pubkey()
        };
        let state = self.env.state(&m);
        let held = if rewards {
            state.rewards_recipient
        } else {
            state.fee_recipient
        };
        let expected = buy_wall_amm::payouts::handover(
            &held,
            &signer.pubkey().to_bytes().into(),
            &new_key.to_bytes().into(),
        )
        .map_err(StrategyError::from);
        let ix = common::payouts::handover_ix(&m, rewards, &signer.pubkey(), &new_key);
        let result = self.env.send(&[ix], &[&signer]);
        assert_outcome("handover", &expected, &result);
        let allowed = current.is_some() && by_recipient && !to_default;
        assert_eq!(result.is_ok(), allowed, "handover: {result:?}");
        if result.is_ok() {
            let tracked = &mut self.markets[i];
            if rewards {
                tracked.rewards_recipient = Some(new);
            } else {
                tracked.fee_recipient = Some(new);
            }
        }
    }

    /// `place_wall` on market `i` by `keeper`, tipping its wrapped SOL account: checked
    /// against the program's own `wall::place` on the market as it was, which it must equal
    /// exactly, accepted or refused with exactly its error. Returns the tip, measured on the
    /// keeper's account.
    fn place_wall(&mut self, i: usize, keeper: &Keypair) -> Option<u64> {
        let m = self.markets[i].market.clone();
        if self.env.svm.get_account(&keeper.pubkey()).is_none() {
            self.env.svm.airdrop(&keeper.pubkey(), SOL).unwrap();
        }
        self.give(&keeper.pubkey(), &WSOL, &TOKEN, 0);
        let before = self.env.state(&m);
        let expected = if before.status == STATUS_OPEN {
            buy_wall_amm::wall::place(before.wall_books(), before.wall_at())
                .map_err(StrategyError::from)
        } else {
            Err(StrategyError::MarketNotOpen)
        };
        let result = self.env.place_wall(&m, keeper);
        assert_outcome("place_wall", &expected, &result);
        let (Ok((books, placement)), Ok((tip, logs))) = (expected, &result) else {
            return None;
        };
        let after = self.env.state(&m);
        assert_eq!(after.wall_books(), books);
        assert_eq!(*tip, placement.tip);
        assert_eq!(events::<buy_wall_amm::events::WallPlaced>(logs).len(), 1);
        // Never above the floor, and so never above the price.
        assert!(after.wall_top() <= before.floor());
        assert!(after.wall_top() <= after.sqrt_price());
        self.placed.push((i, placement));
        let tracked = &mut self.markets[i];
        tracked.placed_under = Some(before.floor());
        tracked.dust_tokens += placement.dust_tokens as u128;
        tracked.tipped += *tip as u128;
        Some(*tip)
    }

    /// Quotes and swaps `amount` of market `i` through the router, as `trader` (funded here
    /// with the input, Pipeline's fee on top, and on top of what they hold already), and
    /// checks the swap paid exactly the quote; returns what it paid.
    fn trade(&mut self, i: usize, buy: bool, amount: u64, trader: Keypair) -> Option<u64> {
        let m = self.markets[i].market.clone();
        let (input, output) = if buy { (1, 0) } else { (0, 1) };
        let request = trade(TradeMode::ExactIn, input, output, amount);
        let quote = self.env.quote(&m, &request);
        let before = self.env.state(&m);
        let priced = buy_wall_amm::pricing::quote(
            &before,
            &buy_wall_amm::interface::TradeRequest {
                mode: buy_wall_amm::interface::TradeMode::ExactIn,
                input_index: input as u8,
                output_index: output as u8,
                amount,
                trader: None,
                extra: vec![],
            },
        );
        if self.env.svm.get_account(&trader.pubkey()).is_none() {
            self.env.svm.airdrop(&trader.pubkey(), SOL).unwrap();
        }
        // Enough for the trade and Pipeline's 0.25% on top, and an output account.
        let funding = amount.saturating_add(amount / 300 + 1);
        let (input_mint, input_program) = (m.mints()[input], m.token_programs()[input]);
        let (output_mint, output_program) = (m.mints()[output], m.token_programs()[output]);
        self.give(&trader.pubkey(), &input_mint, &input_program, funding);
        self.give(&trader.pubkey(), &output_mint, &output_program, 0);
        let swap = self
            .env
            .swap(&m, &trader, (input, output), TradeMode::ExactIn, amount);
        match (&quote, &swap) {
            (Ok(quote), Ok(swap)) => {
                assert_eq!(
                    swap.received, quote.amount_out,
                    "quote {quote:?}, swap {swap:?}"
                );
                assert_eq!(swap.net_sent, amount);
                let priced = priced.expect("the program quoted it");
                assert_eq!(priced.amount_out, quote.amount_out);
                self.swapped.push((
                    i,
                    Swapped {
                        buy,
                        amount_in: amount,
                        amount_out: swap.received,
                        fee: priced.fee,
                        sqrt_price: priced.sqrt_price,
                    },
                ));
                if buy {
                    self.buyers.push((i, trader.pubkey()));
                    self.traders.insert(i, trader.insecure_clone());
                }
                Some(swap.received)
            }
            (Err(_), Err(_)) => None,
            _ => panic!("{amount} ({input}->{output}): quote {quote:?}, swap {swap:?}"),
        }
    }

    /// Every invariant, on every market, after a step.
    fn check(&mut self) {
        self.check_value();
        self.check_markets();
        self.check_exits();
    }

    /// Value conserved, across every wallet and vault, after a step.
    fn check_value(&mut self) {
        // Value conserved: every unit given out is in some account the test funded or in a
        // market's vault.
        for (mint, minted) in &self.minted {
            let mut total: u128 = self.holders[mint]
                .iter()
                .map(|a| self.env.balance(a) as u128)
                .sum();
            for tracked in &self.markets {
                let m = &tracked.market;
                if m.token_mint == *mint {
                    total += self.env.balance(&m.token_vault) as u128;
                }
                if *mint == WSOL {
                    total += self.env.balance(&m.sol_vault) as u128;
                }
                // Pipeline's fee on each trade waits in the router's fee account.
                for (market_mint, program) in m.mints().iter().zip(m.token_programs()) {
                    if market_mint == mint {
                        let fees = pda::fee_account(&m.market, mint, &program);
                        if self.env.svm.get_account(&fees).is_some() {
                            total += self.env.balance(&fees) as u128;
                        }
                    }
                }
            }
            // Burned units left every account, and the mint's supply, for good.
            let burned: u128 = self
                .markets
                .iter()
                .filter(|tracked| tracked.market.token_mint == *mint)
                .map(|tracked| tracked.burned)
                .sum();
            assert_eq!(total + burned, *minted, "units of {mint} created or lost");
            if *mint != WSOL {
                assert_eq!(
                    supply_of(&self.env, mint) as u128,
                    SUPPLY as u128 - burned,
                    "only settle burns"
                );
            }
        }
    }

    /// Every invariant of each market's own state, after a step or, inside a step of several
    /// instructions, after each of them, so each instruction's moves are measured alone.
    fn check_markets(&mut self) {
        let swapped = std::mem::take(&mut self.swapped);
        let placed = std::mem::take(&mut self.placed);
        let slot = self
            .env
            .svm
            .get_sysvar::<anchor_lang::prelude::Clock>()
            .slot;
        for (index, tracked) in self.markets.iter_mut().enumerate() {
            let m = &tracked.market;
            let state = self.env.state(m);
            let last = &tracked.last;
            let token_vault = self.env.balance(&m.token_vault) as u128;
            let sol_vault = self.env.balance(&m.sol_vault) as u128;
            let token_ledgers = state.pool_tokens() as u128
                + state.retired_tokens() as u128
                + state.rewards_owed() as u128;
            let sol_ledgers = state.pool_sol() as u128
                + state.idle_sol() as u128
                + state.fees_recipient() as u128
                + state.fees_designer() as u128
                + state.fees_suite() as u128;
            assert!(
                token_vault >= token_ledgers,
                "token vault below its ledgers"
            );
            assert!(sol_vault >= sol_ledgers, "SOL vault below its ledgers");
            // No instruction but `pipeline_swap` moves the price, the counters, the cap or the
            // curve's liquidity (the seed sets them once), and a swap moves the counters by
            // exactly its trades.
            let trades: Vec<Swapped> = swapped
                .iter()
                .filter(|(market, _)| *market == index)
                .map(|(_, trade)| *trade)
                .collect();
            let token_ledgers_before = last.pool_tokens() as u128 + last.retired_tokens() as u128;
            let sol_ledgers_before = last.pool_sol() as u128
                + last.idle_sol() as u128
                + last.fees_recipient() as u128
                + last.fees_designer() as u128
                + last.fees_suite() as u128;
            // INV-FB-15: no lifetime total ever falls.
            let totals = [
                (
                    "tokens_trimmed",
                    last.tokens_trimmed(),
                    state.tokens_trimmed(),
                ),
                ("sol_trimmed", last.sol_trimmed(), state.sol_trimmed()),
                (
                    "wall_tokens_bought",
                    last.wall_tokens_bought(),
                    state.wall_tokens_bought(),
                ),
                ("tokens_burned", last.tokens_burned(), state.tokens_burned()),
                ("rewards_paid", last.rewards_paid(), state.rewards_paid()),
                ("tips_paid", last.tips_paid(), state.tips_paid()),
                (
                    "fees_collected",
                    last.fees_collected(),
                    state.fees_collected(),
                ),
                (
                    "volume[0]",
                    last.volume(0).unwrap(),
                    state.volume(0).unwrap(),
                ),
                (
                    "volume[1]",
                    last.volume(1).unwrap(),
                    state.volume(1).unwrap(),
                ),
                (
                    "swap_count",
                    last.swap_count() as u128,
                    state.swap_count() as u128,
                ),
            ];
            for (name, before, after) in totals {
                assert!(
                    after >= before,
                    "the lifetime total {name} fell from {before} to {after}"
                );
            }
            // The only value that leaves a market's ledgers outside a swap is a tip, out of
            // the SOL vault, a burn or rewards paid out of the token vault, and fees swept.
            let tips = state.tips_paid() - last.tips_paid();
            let burned = state.tokens_burned() - last.tokens_burned();
            let rewards_paid = state.rewards_paid() - last.rewards_paid();
            let swept = tracked.swept - tracked.swept_checked;
            tracked.swept_checked = tracked.swept;
            assert_eq!(state.tokens_burned(), tracked.burned, "the burned total");
            // INV-FB-15: each total grows by exactly what moved, measured outside the
            // program: the burn on the mint's supply, rewards and tips in the accounts paid.
            let measured = |total: u128, checked: &mut u128| {
                let moved = total - *checked;
                *checked = total;
                moved
            };
            let burned_measured = measured(tracked.burned, &mut tracked.burned_checked);
            let paid_measured = measured(tracked.paid, &mut tracked.paid_checked);
            let tipped_measured = measured(tracked.tipped, &mut tracked.tipped_checked);
            assert_eq!(
                burned, burned_measured,
                "tokens_burned grew by {burned}, but {burned_measured} burned"
            );
            assert_eq!(
                rewards_paid, paid_measured,
                "rewards_paid grew by {rewards_paid}, but {paid_measured} was paid"
            );
            assert_eq!(
                tips, tipped_measured,
                "tips_paid grew by {tips}, but {tipped_measured} was tipped"
            );
            // The wall's total grows only when `place_wall` closes a wall, by the tokens it
            // had bought.
            let placements: Vec<&Placement> = placed
                .iter()
                .filter(|(market, _)| *market == index)
                .map(|(_, placement)| placement)
                .collect();
            let closed: u128 = placements.iter().map(|p| p.closed_tokens as u128).sum();
            assert_eq!(
                state.wall_tokens_bought() - last.wall_tokens_bought(),
                closed,
                "wall_tokens_bought grew by other than the tokens closed walls bought"
            );
            match trades.as_slice() {
                [] => {
                    if last.status == STATUS_OPEN {
                        assert_eq!(state.sqrt_price(), last.sqrt_price());
                        assert_eq!(state.liquidity(), last.liquidity());
                        assert_eq!(state.cap(), last.cap());
                        assert_eq!(state.decay_credit(), last.decay_credit());
                        assert_eq!(
                            (
                                token_ledgers + burned + rewards_paid,
                                sol_ledgers + tips + swept
                            ),
                            (
                                token_ledgers_before + last.rewards_owed() as u128,
                                sol_ledgers_before
                            )
                        );
                        assert_eq!(state.guard(), last.guard());
                        assert_eq!(
                            (state.tokens_trimmed(), state.sol_trimmed()),
                            (last.tokens_trimmed(), last.sol_trimmed())
                        );
                    }
                    assert_eq!(state.counters(), last.counters());
                }
                [.., final_trade] => {
                    // A swap pays nothing out.
                    assert_eq!((burned, rewards_paid, swept), (0, 0, 0));
                    assert_eq!(state.rewards_owed(), last.rewards_owed());
                    // The harness checks between a `place_wall` and a swap, so a trim is
                    // measured on its own.
                    assert!(placements.is_empty(), "a place_wall checked with a swap");
                    // INV-FB-15: a trim's totals count exactly what it moved, the tokens into
                    // `retired_tokens` and the SOL into `idle_sol`, where the fee's wall share
                    // also goes, the rest of the fee going to the fee ledgers.
                    let fees: u128 = trades.iter().map(|t| t.fee as u128).sum();
                    let idle_and_fees = |s: &MarketState| {
                        s.idle_sol() as u128
                            + s.fees_recipient() as u128
                            + s.fees_designer() as u128
                            + s.fees_suite() as u128
                    };
                    assert_eq!(
                        state.tokens_trimmed() - last.tokens_trimmed(),
                        state.retired_tokens() as u128 - last.retired_tokens() as u128,
                        "tokens_trimmed grew by other than the tokens a trim retired"
                    );
                    assert_eq!(
                        state.sol_trimmed() - last.sol_trimmed() + fees,
                        idle_and_fees(&state) - idle_and_fees(last),
                        "sol_trimmed grew by other than the SOL a trim idled"
                    );
                    let (mut tokens_in, mut sol_in) = (0i128, 0i128);
                    let (mut volume_in, mut volume_out) = ([0u128; 2], [0u128; 2]);
                    for trade in &trades {
                        let (input, output) = if trade.buy { (1, 0) } else { (0, 1) };
                        volume_in[input] += trade.amount_in as u128;
                        volume_out[output] += trade.amount_out as u128;
                        if trade.buy {
                            tokens_in -= trade.amount_out as i128;
                            sol_in += trade.amount_in as i128;
                        } else {
                            tokens_in += trade.amount_in as i128;
                            sol_in -= trade.amount_out as i128;
                        }
                    }
                    // Each trade's fee is the spec's, charged on its SOL side and rounded up,
                    // and the counter adds them all.
                    let fee_bps = state.fee_bps() as u128;
                    for trade in &trades {
                        let charged_on = if trade.buy {
                            trade.amount_in as u128
                        } else {
                            trade.amount_out as u128 + trade.fee as u128
                        };
                        assert_eq!(trade.fee as u128, (charged_on * fee_bps).div_ceil(10_000));
                    }
                    let fee = state.fees_collected() - last.fees_collected();
                    assert_eq!(fee, trades.iter().map(|t| t.fee as u128).sum::<u128>());
                    assert_eq!(state.swap_count(), last.swap_count() + trades.len() as u64);
                    for mint in 0..2 {
                        assert_eq!(
                            state.volume(mint).unwrap() - last.volume(mint).unwrap(),
                            volume_in[mint] + volume_out[mint]
                        );
                    }
                    if let [trade] = trades.as_slice() {
                        if trade.buy {
                            assert!(state.sqrt_price() > last.sqrt_price());
                        } else {
                            assert!(state.sqrt_price() < last.sqrt_price());
                        }
                    }
                    // A trim never moves the price: it is exactly where the last swap's
                    // pricing put it.
                    assert_eq!(state.sqrt_price(), final_trade.sqrt_price);
                    assert_eq!(state.last_close(), state.sqrt_price());
                    // The trades' token flow moves the pool and retired ledgers together,
                    // and their SOL flow the SOL ledgers (the fee stays in the vault): a
                    // trim only moves value from the pool to the retired tokens and idle SOL.
                    assert_eq!(
                        (state.pool_tokens() as u128 + state.retired_tokens() as u128) as i128
                            - token_ledgers_before as i128,
                        tokens_in
                    );
                    assert_eq!(
                        sol_ledgers as i128 + tips as i128 - sol_ledgers_before as i128,
                        sol_in
                    );
                    assert!(state.liquidity() <= last.liquidity());
                    // The reference: every trade of a step lands in the step's one slot, so
                    // in the slot it was last updated in it never moves; in a later slot the
                    // first trade moves it toward the last close, by at most
                    // `REF_STEP_BPS / 2` of itself, and the rest of the slot's trades never.
                    let (reference, before) = (state.reference(), last.reference());
                    if slot <= last.last_slot() {
                        assert_eq!(
                            (reference, state.ref_time(), state.last_slot()),
                            (before, last.ref_time(), last.last_slot()),
                            "the reference moved on a trade in its own slot"
                        );
                    } else {
                        let close = last.last_close();
                        assert!(reference >= before.min(close) && reference <= before.max(close));
                        assert!(
                            reference.abs_diff(before) * 2 * BPS as u128
                                <= before * REF_STEP_BPS as u128
                        );
                        assert_eq!(state.last_slot(), slot);
                    }
                }
            }
            // Parameters never change.
            assert_eq!(
                (
                    state.fee_bps(),
                    state.wall_split_bps(),
                    state.reward_share_bps(),
                    state.cap_floor_bps(),
                    state.cap_decay_bps()
                ),
                (
                    last.fee_bps(),
                    last.wall_split_bps(),
                    last.reward_share_bps(),
                    last.cap_floor_bps(),
                    last.cap_decay_bps()
                ),
            );
            // Recipients change only by their own handovers.
            assert_eq!(state.seeder, last.seeder);
            assert_eq!(
                (
                    state.fee_recipient.to_bytes(),
                    state.rewards_recipient.to_bytes()
                ),
                (
                    Tracked::key(tracked.fee_recipient.as_ref()).to_bytes(),
                    Tracked::key(tracked.rewards_recipient.as_ref()).to_bytes()
                )
            );
            match state.status {
                STATUS_CREATED => {
                    assert_eq!(state.sqrt_price(), 0);
                    assert_eq!((token_ledgers, sol_ledgers), (0, 0));
                }
                STATUS_OPEN => {
                    let (s, l) = (state.sqrt_price(), state.liquidity());
                    // The pool ledgers cover what the curve and the wall could ever pay out,
                    // compared exactly, an overflow counting as not covered.
                    let (w, top) = (state.wall_liquidity(), state.wall_top());
                    assert!(
                        buy_wall_amm::wall::covers(
                            l,
                            s,
                            state.wall(),
                            state.pool_tokens(),
                            state.pool_sol()
                        ),
                        "the pool ledgers cover the curve and the wall"
                    );
                    // The wall's floor is never above the price, and a placed wall's top is
                    // never above the floor it was placed under.
                    assert!(state.floor() <= s, "the floor is above the price");
                    if w > 0 {
                        let under = tracked.placed_under.expect("placed by place_wall");
                        assert!(top <= under, "the wall's top is above its floor");
                    }
                    // The cap never rises and never falls below the floor.
                    if last.status == STATUS_OPEN {
                        assert!(state.cap() <= last.cap());
                    }
                    assert!(state.cap() >= state.cap_floor() && state.cap_floor() >= 1);
                    assert!(state.cap_floor() <= state.seeded_tokens());
                    // The curve holds no more than the cap, except where MIN_LIQUIDITY
                    // stopped a trim.
                    assert!(
                        held(&state) <= state.cap() as u128 || l == MIN_LIQUIDITY,
                        "the curve holds {} over a cap of {} at liquidity {l}",
                        held(&state),
                        state.cap()
                    );
                    // The decay credit never exceeds one day's allowance.
                    assert!(
                        state.decay_credit()
                            <= state.cap_decay_per_day() as u128 * DECAY_CREDIT_WINDOW as u128
                    );
                    // Every token a trim, a closed wall or the dust retired is still retired,
                    // burned, owed as rewards or paid as rewards, and the totals count each.
                    assert_eq!(
                        state.retired_tokens() as u128
                            + state.tokens_burned()
                            + state.rewards_owed() as u128
                            + state.rewards_paid(),
                        state.tokens_trimmed() + state.wall_tokens_bought() + tracked.dust_tokens
                    );
                    assert!(l >= MIN_LIQUIDITY);
                }
                other => panic!("status {other}"),
            }
            assert!(
                state.reserve.iter().all(|&b| b == 0),
                "the reserve stays zeroed"
            );
            tracked.last = state;
        }
    }

    /// Every holder can exit, after a step.
    fn check_exits(&mut self) {
        // Every holder can exit, as `exit::can_exit` defines it (`POOL4-36`): a buyer's whole
        // token balance sells, unless it is worth less than one lamport or is more than the
        // curve can take before its price bound, when the most it can take sells (and every
        // quote equals its swap, checked on each trade).
        for &(market, buyer) in &self.buyers {
            let m = &self.markets[market].market;
            let account = pda::associated_token(&buyer, &m.token_mint, &m.token_program);
            let held = self.env.balance(&account);
            if held == 0 {
                continue;
            }
            if let Err(why) = exit::can_exit(&self.env, m, held) {
                panic!("{why}");
            }
        }
    }
}

/// Creation parameters from generated values, with fresh recipients: with `valid`, folded
/// into the ranges the rules accept (a reward share of 0 with no rewards recipient, and the
/// whole market share to the wall with no fee recipient for an even fee), otherwise as they
/// come. In order: the fee, the wall split, the reward share, the cap floor and the cap
/// decay, in basis points.
fn creation_params(
    seeder: Pubkey,
    valid: bool,
    bps: [u16; 5],
) -> (buy_wall_amm::InitParams, Recipients) {
    let [fee_bps, wall_split_bps, reward_share_bps, cap_floor_bps, cap_decay_bps] = bps;
    let mut params = launch_params(seeder);
    let (fee, rewards) = (Keypair::new(), Keypair::new());
    params.fee_recipient = fee.pubkey();
    params.rewards_recipient = rewards.pubkey();
    if valid {
        params.fee_bps = 25 + fee_bps % 276;
        params.wall_split_bps = wall_split_bps % 10_001;
        params.reward_share_bps = reward_share_bps % 3_001;
        params.cap_floor_bps = 10 + cap_floor_bps % 9_991;
        params.cap_decay_bps = cap_decay_bps % 10_001;
        if params.reward_share_bps == 0 {
            params.rewards_recipient = Pubkey::default();
        }
        if params.wall_split_bps == 10_000 && fee_bps % 2 == 0 {
            params.fee_recipient = Pubkey::default();
        }
    } else {
        params.fee_bps = fee_bps;
        params.wall_split_bps = wall_split_bps;
        params.reward_share_bps = reward_share_bps;
        params.cap_floor_bps = cap_floor_bps;
        params.cap_decay_bps = cap_decay_bps;
    }
    let recipients = Recipients {
        fee: (params.fee_recipient != Pubkey::default()).then_some(fee),
        rewards: (params.rewards_recipient != Pubkey::default()).then_some(rewards),
    };
    (params, recipients)
}

/// `INV-WG-7`'s `tip_free`: the tip `place_wall` would pay on `state` with its threshold
/// ignored, stated from the spec's `place_wall` steps 1 to 4 rather than with the program's
/// `wall::place`: `min(KEEPER_TIP_CAP, floor(work × fee_bps / 10,000), idle + closed + dust)`,
/// where `closed` is what the wall holds at the price, `work` the larger of the SOL the wall
/// has spent and `idle_sol`, and `dust` the SOL the pool holds beyond the curve's own,
/// rounded up. It is the part of a tip that a trader's own trades did not create.
fn tip_free(state: &MarketState) -> u64 {
    if state.status != STATUS_OPEN {
        return 0;
    }
    let s = state.sqrt_price();
    let wall = state.wall();
    let (closed, converted) = if state.wall_liquidity() > 0 {
        let closed = wall.sol_at(s).expect("the wall's SOL fits");
        (closed, state.wall_sol_placed().saturating_sub(closed))
    } else {
        (0, 0)
    };
    let (_, curve_sol) = buy_wall_amm::cap::held_rounded_up(state.liquidity(), s)
        .expect("a seeded market's curve fits");
    let dust = (state.pool_sol().saturating_sub(closed) as u128).saturating_sub(curve_sol);
    let idle = state.idle_sol() as u128;
    let work = (converted as u128).max(idle);
    let earned = work * state.fee_bps() as u128 / BPS as u128;
    (KEEPER_TIP_CAP as u128)
        .min(earned)
        .min(idle + closed as u128 + dust) as u64
}

/// The keeper jobs' first check (`state::check_vault_accounts`): the market is open.
fn open(state: &MarketState) -> Result<(), StrategyError> {
    if state.status == STATUS_OPEN {
        Ok(())
    } else {
        Err(StrategyError::MarketNotOpen)
    }
}

/// The custom error code on the first line of a failed transaction's message, if any.
fn custom_code(message: &str) -> Option<u32> {
    let line = message.lines().next()?;
    let start = line.find("Custom(")? + "Custom(".len();
    line[start..].split(')').next()?.parse().ok()
}

/// Asserts that an instruction did what the model predicted: succeeded when it predicted
/// success, and was refused with exactly the error it predicted otherwise, so a refusal for
/// the wrong reason fails.
#[track_caller]
fn assert_outcome<T: std::fmt::Debug, U>(
    what: &str,
    expected: &Result<T, StrategyError>,
    result: &Result<U, String>,
) {
    match (expected, result) {
        (Ok(_), Ok(_)) => {}
        (Err(error), Err(message)) => {
            let code: u32 = (*error).into();
            assert_eq!(
                custom_code(message),
                Some(code),
                "{what}: expected {error:?} ({code}), got:\n{message}"
            );
        }
        (Ok(expected), Err(message)) => {
            panic!("{what}: expected {expected:?}, but it was refused:\n{message}")
        }
        (Err(error), Ok(_)) => panic!("{what}: expected {error:?}, but it succeeded"),
    }
}

/// A mint's supply (SPL Token's and Token-2022's mint layout: the supply at 36).
fn supply_of(env: &Env, mint: &Pubkey) -> u64 {
    let data = env.svm.get_account(mint).expect("the mint").data;
    u64::from_le_bytes(data[36..44].try_into().unwrap())
}

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(256)
}

/// A world with the default market every sequence starts with, after `steps`, every
/// invariant checked after each.
fn replay(steps: &[Step]) {
    let mut world = World::new();
    // Always start with a seeded market, so the other steps have something to trade.
    world.apply(&Step::Create {
        token_2022: false,
        valid: true,
        fee_bps: 75,
        wall_split_bps: 5_000,
        reward_share_bps: 1_499,
        cap_floor_bps: 1_990,
        cap_decay_bps: 2_000,
    });
    world.check();
    world.apply(&Step::Seed {
        market: 0,
        tokens: 1_000_000_000_000,
        lamports: 10 * SOL,
        by_seeder: true,
    });
    world.check();
    for step in steps {
        world.apply(step);
        world.check();
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), ..ProptestConfig::default() })]

    #[test]
    fn invariants_hold_after_every_step(steps in prop::collection::vec(step(), 1..32)) {
        replay(&steps);
    }
}

/// The fuzzer's counterexample to `round-trip-rewards-recipient` (2026-11-16), minimised,
/// and the same wash trade at a day's decay credit: SOS hypothesis H002, which today's code
/// fails, so a plain run checks every other invariant on it and `FUZZ_INVARIANTS=
/// round-trip-rewards-recipient` shows it failing. On the default market (a 75 basis point
/// fee and a 14.99% reward share), one second after the seed the rewards recipient buys
/// with 35 lamports, sells it all straight back for 32, settles and pays itself the rewards
/// that the sell's trim retired, and sells them for 4: 36 lamports back for 35. The buy
/// spends the decay credit to lower the cap to what the curve then holds, so the sell back
/// is trimmed and its tokens retired, and the reward share of them comes back to the
/// trader, more than the two fees it paid. A day after the seed the same round trip with
/// 1 SOL sells back for 980,099,999 lamports and claims rewards that sell for 131,727,578:
/// 0.11 SOL more than it cost, in one transaction's worth of instructions.
#[test]
fn the_rewards_recipients_wash_trade_counterexample() {
    replay(&[
        Step::Warp {
            seconds: 1,
            slots: 0,
        },
        Step::RoundTrip {
            market: 0,
            amount: 35,
            place_wall: false,
            by_trader: false,
            role: Role::RewardsRecipient,
        },
    ]);
    replay(&[
        Step::Warp {
            seconds: DECAY_CREDIT_WINDOW,
            slots: 0,
        },
        Step::RoundTrip {
            market: 0,
            amount: SOL,
            place_wall: false,
            by_trader: false,
            role: Role::RewardsRecipient,
        },
    ]);
}
