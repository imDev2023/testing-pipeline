//! Stateful invariant fuzzing (docs/spec/README.md, "Test layers" 3): Proptest generates
//! sequences of the instructions built so far (creation with any parameters, the seed by
//! the seeder or anyone else with any amounts, a launchpad's graduation through
//! `pipeline_seed_liquidity` with any parameters and amounts, donations to the vaults, buys
//! and sells through the router, `place_wall` by a keeper or by a trader, and a buy sold
//! straight back with or without `place_wall` in between) and clock jumps, from seconds to
//! across the cap's decay window, several trades often landing in one slot, sends each
//! through the router in LiteSVM, and checks after every step:
//!
//! - value is conserved: no token unit or lamport of wrapped SOL is created or lost, across
//!   every wallet, every vault and the router's fee accounts;
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
//! - a buy sold straight back never returns more than it cost, whatever keeper jobs run in
//!   between;
//! - no instruction other than `pipeline_swap` changes `sqrt_price`, the counters, the
//!   cap, the curve's liquidity or the wall's guard, and a swap changes the counters by
//!   exactly the trade it made.
//!
//! Later tickets add their instructions and invariants here. `PROPTEST_CASES` sets how many
//! sequences run (64 by default).

mod common;

use buy_wall_amm::config::{DECAY_CREDIT_WINDOW, MIN_LIQUIDITY, REF_STEP_BPS};
use buy_wall_amm::params::BPS;
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
    /// `by_trader`, so the trader also takes the tip).
    RoundTrip {
        market: usize,
        amount: u64,
        place_wall: bool,
        by_trader: bool,
    },
    /// `place_wall`, by a fresh keeper or by a trader who already holds wrapped SOL.
    PlaceWall { market: usize, by_trader: bool },
    /// Move the clock forward.
    Warp { seconds: i64, slots: u64 },
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
        2 => (any::<usize>(), trade_amount(), any::<bool>(), any::<bool>())
            .prop_map(|(market, amount, place_wall, by_trader)| Step::RoundTrip { market, amount, place_wall, by_trader }),
        3 => (any::<usize>(), any::<bool>())
            .prop_map(|(market, by_trader)| Step::PlaceWall { market, by_trader }),
        2 => (clock_jump(), 0..1_000u64).prop_map(|(seconds, slots)| Step::Warp { seconds, slots }),
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
    /// The last trader to buy each market's token, who can then place its wall.
    traders: std::collections::HashMap<usize, Keypair>,
    /// The swaps the last step made, in order: (market, trade), checked against the
    /// counters, the ledgers and the price.
    swapped: Vec<(usize, Swapped)>,
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
                let params = creation_params(
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
                    self.markets.push(Tracked {
                        market,
                        seeder,
                        last,
                        placed_under: None,
                        dust_tokens: 0,
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
                let launch = self.env.launch(token, program, 0, 0);
                self.give(&launch.seeder, &token, &program, tokens);
                self.give(&launch.seeder, &WSOL, &TOKEN, lamports);
                // The seeder named here is ignored for the launchpad's PDA.
                let params = creation_params(
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
                        self.markets.push(Tracked {
                            market: m,
                            seeder: launch.creator,
                            last: after,
                            placed_under: None,
                            dust_tokens: 0,
                        });
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
            } => {
                let Some(i) = self.pick(market) else { return };
                let trader = Keypair::new();
                let Some(bought) = self.trade(i, true, amount, trader.insecure_clone()) else {
                    return;
                };
                if place_wall {
                    let keeper = if by_trader {
                        trader.insecure_clone()
                    } else {
                        Keypair::new()
                    };
                    self.place_wall(i, &keeper);
                }
                // Sold straight back, in the same slot, whatever keeper job ran in between:
                // never more than the buy cost.
                if let Some(sold) = self.trade(i, false, bought, trader) {
                    assert!(
                        sold <= amount,
                        "a buy of {amount} lamports sold straight back returned {sold}"
                    );
                }
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
        }
    }

    /// `place_wall` on market `i` by `keeper`, tipping its wrapped SOL account: checked
    /// against the program's own `wall::place` on the market as it was, which it must equal
    /// exactly, accepted or refused.
    fn place_wall(&mut self, i: usize, keeper: &Keypair) {
        let m = self.markets[i].market.clone();
        if self.env.svm.get_account(&keeper.pubkey()).is_none() {
            self.env.svm.airdrop(&keeper.pubkey(), SOL).unwrap();
        }
        self.give(&keeper.pubkey(), &WSOL, &TOKEN, 0);
        let before = self.env.state(&m);
        let expected = (before.status == STATUS_OPEN)
            .then(|| buy_wall_amm::wall::place(before.wall_books(), before.wall_at()));
        let result = self.env.place_wall(&m, keeper);
        match (expected, &result) {
            (Some(Ok((books, placement))), Ok((tip, logs))) => {
                let after = self.env.state(&m);
                assert_eq!(after.wall_books(), books);
                assert_eq!(*tip, placement.tip);
                assert_eq!(events::<buy_wall_amm::events::WallPlaced>(logs).len(), 1);
                // Never above the floor, and so never above the price.
                assert!(after.wall_top() <= before.floor());
                assert!(after.wall_top() <= after.sqrt_price());
                let tracked = &mut self.markets[i];
                tracked.placed_under = Some(before.floor());
                tracked.dust_tokens += placement.dust_tokens as u128;
            }
            (Some(Err(_)) | None, Err(_)) => {}
            (expected, _) => panic!(
                "place_wall on {:?}: expected {expected:?}, got {:?}",
                before.wall_books(),
                result.map(|(tip, _)| tip)
            ),
        }
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
        let swapped = std::mem::take(&mut self.swapped);
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
            if last.status == STATUS_OPEN {
                assert!(state.tokens_trimmed() >= last.tokens_trimmed());
                assert!(state.sol_trimmed() >= last.sol_trimmed());
                assert!(state.wall_tokens_bought() >= last.wall_tokens_bought());
            }
            // The only value that leaves a market's ledgers outside a swap is a tip, out of
            // the SOL vault.
            let tips = state.tips_paid() - last.tips_paid();
            match trades.as_slice() {
                [] => {
                    if last.status == STATUS_OPEN {
                        assert_eq!(state.sqrt_price(), last.sqrt_price());
                        assert_eq!(state.liquidity(), last.liquidity());
                        assert_eq!(state.cap(), last.cap());
                        assert_eq!(state.decay_credit(), last.decay_credit());
                        assert_eq!(
                            (token_ledgers, sol_ledgers + tips),
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
                    // Nothing is settled yet: every retired token is one a trim, a closed
                    // wall or the dust moved there, and the totals count each.
                    assert_eq!(state.rewards_owed(), 0);
                    assert_eq!(
                        state.retired_tokens() as u128,
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

/// Creation parameters from generated values: with `valid`, folded into the ranges the
/// rules accept, otherwise as they come. In order: the fee, the wall split, the reward share,
/// the cap floor and the cap decay, in basis points.
fn creation_params(seeder: Pubkey, valid: bool, bps: [u16; 5]) -> buy_wall_amm::InitParams {
    let [fee_bps, wall_split_bps, reward_share_bps, cap_floor_bps, cap_decay_bps] = bps;
    let mut params = launch_params(seeder);
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
    params
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
        // Always start with a seeded market, so the other steps have something to trade.
        world.apply(&Step::Create { token_2022: false, valid: true, fee_bps: 75, wall_split_bps: 5_000, reward_share_bps: 1_499, cap_floor_bps: 1_990, cap_decay_bps: 2_000 });
        world.check();
        world.apply(&Step::Seed { market: 0, tokens: 1_000_000_000_000, lamports: 10 * SOL, by_seeder: true });
        world.check();
        for step in &steps {
            world.apply(step);
            world.check();
        }
    }
}
