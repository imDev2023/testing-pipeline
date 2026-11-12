//! Stateful invariant fuzzing (docs/spec/README.md, "Test layers" 3): Proptest generates
//! sequences of the instructions built so far (creation with any parameters, the seed by
//! the seeder or anyone else with any amounts, donations to the vaults, buys and sells
//! through the router) and clock jumps, several trades often landing in one slot, sends
//! each through the router in LiteSVM, and checks after every step:
//!
//! - value is conserved: no token unit or lamport of wrapped SOL is created or lost, across
//!   every wallet, every vault and the router's fee accounts;
//! - every holder can exit: each trader holding a market's token can sell all of it, unless
//!   it is worth less than one lamport;
//! - each quote equals its swap, to the unit, and a refused quote is a refused swap;
//! - the invariants of docs/spec/pool4-for-solana.md, "Ledgers", that apply so far: each
//!   vault holds at least the sum of its ledgers, the pool ledgers cover what the curve
//!   could pay out, and the cap never rises and never falls below the cap floor (the cap's
//!   bound on the curve and the wall's floor arrive with their tickets);
//! - no instruction other than `pipeline_swap` changes `sqrt_price` or the counters, and a
//!   swap changes them by exactly the trade it made.
//!
//! Later tickets add their instructions and invariants here. `PROPTEST_CASES` sets how many
//! sequences run (64 by default).

mod common;

use buy_wall_amm::math::U256;
use buy_wall_amm::state::{MarketState, STATUS_CREATED, STATUS_OPEN};
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
    /// Move the clock forward.
    Warp { seconds: i64, slots: u64 },
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        2 => (any::<bool>(), prop::bool::weighted(0.8), 0..400u16, 0..10_500u16, 0..3_500u16, 0..10_500u16, 0..10_500u16)
            .prop_map(|(token_2022, valid, fee_bps, wall_split_bps, reward_share_bps, cap_floor_bps, cap_decay_bps)| {
                Step::Create { token_2022, valid, fee_bps, wall_split_bps, reward_share_bps, cap_floor_bps, cap_decay_bps }
            }),
        3 => (any::<usize>(), seed_tokens(), seed_lamports(), prop::bool::weighted(0.85))
            .prop_map(|(market, tokens, lamports, by_seeder)| Step::Seed { market, tokens, lamports, by_seeder }),
        1 => (any::<usize>(), any::<bool>(), 1..1_000_000_000u64)
            .prop_map(|(market, sol, amount)| Step::Donate { market, sol, amount }),
        5 => (any::<usize>(), any::<bool>(), trade_amount())
            .prop_map(|(market, buy, amount)| Step::Trade { market, buy, amount }),
        1 => (0..200_000i64, 0..1_000u64).prop_map(|(seconds, slots)| Step::Warp { seconds, slots }),
    ]
}

/// Trade sizes from zero and dust to more than a whole pool.
fn trade_amount() -> impl Strategy<Value = u64> {
    prop_oneof![0..1_000u64, 1_000..10 * SOL, 10 * SOL..u64::MAX / 8]
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
}

struct World {
    env: Env,
    markets: Vec<Tracked>,
    /// Token units and lamports given out to wallets so far, per mint.
    minted: std::collections::HashMap<Pubkey, u128>,
    /// Every token account the test ever funded, per mint.
    holders: std::collections::HashMap<Pubkey, Vec<Pubkey>>,
    /// Traders who bought a market's token: (market, wallet).
    buyers: Vec<(usize, Pubkey)>,
    /// The swap the last step made: (market, priced trade), checked against the counters.
    swapped: Option<(usize, Swapped)>,
}

/// What a successful swap did, from the trader's side.
#[derive(Clone, Copy, Debug)]
struct Swapped {
    buy: bool,
    amount_in: u64,
    amount_out: u64,
}

impl World {
    fn new() -> Self {
        World {
            env: Env::new(),
            markets: vec![],
            minted: Default::default(),
            holders: Default::default(),
            buyers: vec![],
            swapped: None,
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
                let seeder = Keypair::new();
                self.env.svm.airdrop(&seeder.pubkey(), SOL).unwrap();
                let mut params = launch_params(seeder.pubkey());
                if valid {
                    params.fee_bps = 25 + fee_bps % 276;
                    params.wall_split_bps = wall_split_bps % 10_001;
                    params.reward_share_bps = 1 + reward_share_bps % 3_000;
                    params.cap_floor_bps = 10 + cap_floor_bps % 9_991;
                    params.cap_decay_bps = cap_decay_bps % 10_001;
                } else {
                    params.fee_bps = fee_bps;
                    params.wall_split_bps = wall_split_bps;
                    params.reward_share_bps = reward_share_bps;
                    params.cap_floor_bps = cap_floor_bps;
                    params.cap_decay_bps = cap_decay_bps;
                }
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
                    self.markets.push(Tracked {
                        market,
                        seeder,
                        last,
                    });
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
                let m = self.markets[i].market.clone();
                let (input, output) = if buy { (1, 0) } else { (0, 1) };
                let quote = self
                    .env
                    .quote(&m, &trade(TradeMode::ExactIn, input, output, amount));
                let trader = Keypair::new();
                self.env.svm.airdrop(&trader.pubkey(), SOL).unwrap();
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
                        self.swapped = Some((
                            i,
                            Swapped {
                                buy,
                                amount_in: amount,
                                amount_out: swap.received,
                            },
                        ));
                        if buy {
                            self.buyers.push((i, trader.pubkey()));
                        }
                    }
                    (Err(_), Err(_)) => {}
                    _ => panic!("{amount} ({input}->{output}): quote {quote:?}, swap {swap:?}"),
                }
            }
            Step::Warp { seconds, slots } => {
                let clock = self.env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
                self.env
                    .set_clock(clock.slot + slots + 1, clock.unix_timestamp + seconds);
            }
        }
    }

    /// Every invariant, on every market, after a step.
    fn check(&mut self) {
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
            assert_eq!(total, *minted, "units of {mint} created or lost");
        }
        let swapped = self.swapped.take();
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
            // No instruction but `pipeline_swap` moves the price or the counters (the seed
            // sets the price once), and a swap moves the counters by exactly its trade.
            match swapped.filter(|(market, _)| *market == index) {
                None => {
                    if last.status == STATUS_OPEN {
                        assert_eq!(state.sqrt_price(), last.sqrt_price());
                    }
                    assert_eq!(state.counters(), last.counters());
                }
                Some((_, trade)) => {
                    let (input, output) = if trade.buy { (1, 0) } else { (0, 1) };
                    let fee = state.fees_collected() - last.fees_collected();
                    assert_eq!(state.swap_count(), last.swap_count() + 1);
                    assert_eq!(
                        state.volume(input).unwrap() - last.volume(input).unwrap(),
                        trade.amount_in as u128
                    );
                    assert_eq!(
                        state.volume(output).unwrap() - last.volume(output).unwrap(),
                        trade.amount_out as u128
                    );
                    let fee_bps = state.fee_bps() as u128;
                    let charged_on = if trade.buy {
                        trade.amount_in as u128
                    } else {
                        trade.amount_out as u128 + fee
                    };
                    assert_eq!(fee, (charged_on * fee_bps).div_ceil(10_000));
                    if trade.buy {
                        assert!(state.sqrt_price() > last.sqrt_price());
                    } else {
                        assert!(state.sqrt_price() < last.sqrt_price());
                    }
                    assert_eq!(state.last_close(), state.sqrt_price());
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
            assert_eq!(
                (state.fee_recipient, state.rewards_recipient, state.seeder),
                (last.fee_recipient, last.rewards_recipient, last.seeder)
            );
            match state.status {
                STATUS_CREATED => {
                    assert_eq!(state.sqrt_price(), 0);
                    assert_eq!((token_ledgers, sol_ledgers), (0, 0));
                }
                STATUS_OPEN => {
                    let (s, l) = (state.sqrt_price(), state.liquidity());
                    let q = 1u128 << 64;
                    // The pool ledgers cover the curve: L × Q / s <= pool_tokens and
                    // L × s / Q <= pool_sol.
                    assert!(
                        U256::mul(l, q).unwrap()
                            <= U256::mul(state.pool_tokens() as u128, s).unwrap()
                    );
                    assert!(
                        U256::mul(l, s).unwrap() <= U256::mul(state.pool_sol() as u128, q).unwrap()
                    );
                    // The cap never rises and never falls below the floor. (Its bound on
                    // what the curve holds arrives with the trim, and the wall's floor with
                    // the wall: tickets #49 and #50.)
                    if last.status == STATUS_OPEN {
                        assert!(state.cap() <= last.cap());
                    }
                    assert!(state.cap() >= state.cap_floor() && state.cap_floor() >= 1);
                    assert!(state.cap_floor() <= state.seeded_tokens());
                    // No wall is placed yet, and nothing has been trimmed or retired.
                    assert_eq!(state.wall_liquidity(), 0);
                    assert_eq!((state.retired_tokens(), state.rewards_owed()), (0, 0));
                    assert!(l >= buy_wall_amm::config::MIN_LIQUIDITY);
                }
                other => panic!("status {other}"),
            }
            assert!(
                state.reserve.iter().all(|&b| b == 0),
                "the reserve stays zeroed"
            );
            tracked.last = state;
        }
        // Every holder can exit: a buyer's whole token balance sells, unless it is worth
        // less than one lamport (and every quote equals its swap, checked on each trade).
        for &(market, buyer) in &self.buyers {
            let m = &self.markets[market].market;
            let account = pda::associated_token(&buyer, &m.token_mint, &m.token_program);
            let held = self.env.balance(&account);
            if held == 0 {
                continue;
            }
            let quote = self.env.quote(m, &trade(TradeMode::ExactIn, 0, 1, held));
            if let Err(error) = &quote {
                let dust: u32 = buy_wall_amm::errors::StrategyError::ZeroOutput.into();
                assert!(
                    error.contains(&format!("Custom({dust})")),
                    "a holder of {held} cannot exit: {error}"
                );
            }
        }
    }
}

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(64)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), ..ProptestConfig::default() })]

    #[test]
    fn invariants_hold_after_every_step(steps in prop::collection::vec(step(), 1..16)) {
        let mut world = World::new();
        // Always start with a market, so the other steps have something to act on.
        world.apply(&Step::Create { token_2022: false, valid: true, fee_bps: 75, wall_split_bps: 5_000, reward_share_bps: 1_499, cap_floor_bps: 1_990, cap_decay_bps: 2_000 });
        world.check();
        for step in &steps {
            world.apply(step);
            world.check();
        }
    }
}
