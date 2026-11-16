//! The stateful invariant fuzzer (docs/spec/README.md, "Test layers" 3): Proptest generates
//! markets holding cTokens of the Kamino reserve dumped from the cluster this build lends on
//! (none, or up to several times the buffer's worth, given directly since no instruction lends
//! yet), and sequences of swaps, deposits, donations of tokens and cTokens and clock jumps,
//! sent as real transactions
//! through the router copied from devnet in LiteSVM, and after every step checks the bar's
//! three shared invariants and the lending AMM's own that this build makes checkable
//! (docs/spec/lending-pool.md, "Invariants for test layer 3"):
//!
//! - value is conserved: every token any step created is held by a known account, and each
//!   vault holds exactly what the market has recorded plus what was donated to it;
//! - every holder can exit: every trader can sell all they hold of either mint, Pipeline's
//!   fee included (a holding too small to buy one unit is refused as dust, cleanly, and a sell
//!   paying out more of the lent side than the buffer holds is refused until
//!   [the in-swap redeem](https://github.com/imDev2023/testing-pipeline/issues/81) pays it from
//!   Kamino); an LP's exit arrives with
//!   [remove liquidity](https://github.com/imDev2023/testing-pipeline/issues/82), which adds
//!   it here;
//! - each quote equals its swap;
//! - what the market has recorded never exceeds what it holds: the buffer and the other side
//!   against their vaults, the cTokens against the cToken account;
//! - no swap lowers `R x L`, and no step lowers the value of an LP share (`R x L / N^2`), with
//!   `L = B + V`, the cTokens valued at the reserve's stored rate, which no step moves;
//! - the share count changes only by `add_liquidity`;
//! - no step deposits into or redeems from Kamino, and none moves the recorded cTokens.
//!
//! Each case runs in a fresh VM. `PROPTEST_CASES` sets how many cases run (default 24, of
//! up to 32 steps each).

mod common;

use common::*;
use lending_amm::config::MINIMUM_LIQUIDITY;
use lending_amm::StrategyError;
use pipeline_client::{pda, Pubkey};
use pipeline_strategy_interface::fees::amount_for_budget;
use proptest::prelude::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[derive(Clone, Debug)]
enum Step {
    /// A trader swaps `fraction` (in millionths) of what they hold of `input`.
    Swap {
        trader: usize,
        input: usize,
        fraction: u32,
    },
    /// An LP adds up to `fraction` (in millionths) of what they hold of each mint.
    Deposit { lp: usize, fraction: [u32; 2] },
    /// A stranger sends `amount` of mint `side` straight to its vault.
    Donate { side: usize, amount: u64 },
    /// A stranger sends `amount` cTokens straight to the market's cToken account.
    DonateCtokens { amount: u64 },
    /// Time passes.
    Wait { slots: u64 },
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        5 => (0..2usize, 0..2usize, 1..1_000_000u32)
            .prop_map(|(trader, input, fraction)| Step::Swap { trader, input, fraction }),
        2 => (0..2usize, [1..1_000_000u32, 1..1_000_000u32])
            .prop_map(|(lp, fraction)| Step::Deposit { lp, fraction }),
        1 => (0..2usize, 1..1_000_000_000u64).prop_map(|(side, amount)| Step::Donate { side, amount }),
        1 => (1..100_000_000_000u64).prop_map(|amount| Step::DonateCtokens { amount }),
        1 => (1..1_000_000u64).prop_map(|slots| Step::Wait { slots }),
    ]
}

/// What the fuzzer knows about one market's world.
struct World {
    env: Env,
    market: Market,
    traders: Vec<Keypair>,
    lps: Vec<Keypair>,
    /// Every token of each mint the test created, by mint index.
    created: [u128; 2],
    /// Every token donated to each vault.
    donated: [u64; 2],
    /// Tokens held by donors, whom the world does not enumerate.
    with_donors: [u128; 2],
    /// The cTokens the market recorded when it was given them.
    ctokens: u64,
    /// Every cToken donated to the cToken account.
    donated_ctokens: u64,
    /// The share count the market should have.
    shares: u64,
}

const SEED: [u64; 2] = [2_000_000_000_000, 40 * SOL];
const HOLDING: [u64; 2] = [5_000_000_000_000, 100 * SOL];

impl World {
    fn new(lp_fee_bps: u16, ctokens: u64) -> Self {
        let mut env = Env::new();
        let spec = env.wsol_market_spec(lp_fee_bps);
        let (market, first) = env.create_funded_market(&spec, SEED).unwrap();
        env.give_ctokens(&market, ctokens);
        let shares = env.share_count(&market);
        let traders: Vec<Keypair> = (0..2)
            .map(|_| env.funded_wallet(&market, HOLDING))
            .collect();
        let second = env.funded_wallet(&market, HOLDING);
        // The first LP spent everything on the seed; give them more to add later.
        for ((mint, token_program), amount) in
            market.mints.iter().zip(&market.token_programs).zip(HOLDING)
        {
            write_token_account(&mut env.svm, mint, token_program, &first.pubkey(), amount)
                .unwrap();
        }
        // The seed, two traders, a second LP and the first LP's top-up.
        let created = [0, 1].map(|i| (SEED[i] + 4 * HOLDING[i]) as u128);
        World {
            env,
            market,
            traders,
            lps: vec![first, second],
            created,
            donated: [0, 0],
            with_donors: [0, 0],
            ctokens,
            donated_ctokens: 0,
            shares,
        }
    }

    /// The reserve as the program reads it.
    fn reserve(&self) -> lending_amm::kamino::Reserve {
        let entry = &lending_amm::config::LENT_MINTS[self.env.lent_entry_of(&self.market)];
        let data = self.env.data(&ck(&entry.reserve));
        lending_amm::kamino::read_reserve(
            &entry.reserve,
            &lending_amm::config::KLEND_PROGRAM,
            &data,
            entry,
        )
        .unwrap()
    }

    /// The effective reserves `[R, L]`, with `L = B + V`.
    fn effective(&self) -> [u64; 2] {
        let state = self.env.market_state(&self.market.market_state);
        let value = self.reserve().lent_value(state.ctokens).unwrap();
        [state.reserves[0], state.reserves[1] + value]
    }

    fn holding(&self, wallet: &Pubkey, i: usize) -> u64 {
        self.env
            .balance_or_zero(&self.env.wallet_token_account(&self.market, wallet, i))
    }

    fn reserves(&self) -> [u64; 2] {
        self.env.market_state(&self.market.market_state).reserves
    }

    fn run(&mut self, step: &Step) -> Result<(), TestCaseError> {
        let before = self.reserves();
        let effective_before = self.effective();
        match *step {
            Step::Swap {
                trader,
                input,
                fraction,
            } => {
                let output = 1 - input;
                let wallet = self.traders[trader].pubkey();
                // What the trader can spend, Pipeline's fee included.
                let budget =
                    (self.holding(&wallet, input) as u128 * fraction as u128 / 1_000_000) as u64;
                let amount = amount_for_budget(budget, 0);
                let quote = self
                    .env
                    .quote(&self.market, &exact_in(input, output, amount));
                let trader = self.traders[trader].insecure_clone();
                let swapped = self
                    .env
                    .swap(&self.market, &trader, (input, output), amount);
                match quote {
                    Ok(quote) => {
                        let swapped = swapped.map_err(TestCaseError::fail)?;
                        // Each quote equals its swap.
                        prop_assert_eq!(swapped.received, quote.amount_out);
                        let after = self.reserves();
                        prop_assert_eq!(after[input], before[input] + amount);
                        prop_assert_eq!(after[output], before[output] - quote.amount_out);
                        // No swap lowers R x L, with L = B + V.
                        let (now, was) = (self.effective(), effective_before);
                        prop_assert!(
                            now[0] as u128 * now[1] as u128 >= was[0] as u128 * was[1] as u128
                        );
                    }
                    Err(refusal) => {
                        // Only dust, and a payout beyond the buffer, are refused, and the
                        // swap is refused with them.
                        prop_assert!(
                            refusal.contains("ZeroOutput")
                                || (output == 1 && refusal.contains("BeyondBuffer")),
                            "an unexpected refusal of {} of mint {}: {}",
                            amount,
                            input,
                            refusal
                        );
                        prop_assert!(swapped.is_err());
                        prop_assert_eq!(self.reserves(), before);
                    }
                }
            }
            Step::Deposit { lp, fraction } => {
                let wallet = self.lps[lp].pubkey();
                let max = [0, 1].map(|i| {
                    (self.holding(&wallet, i) as u128 * fraction[i] as u128 / 1_000_000) as u64
                });
                let lp = self.lps[lp].insecure_clone();
                let shares_before = self.env.share_count(&self.market);
                match self.env.add_liquidity(&self.market, &lp, max, 0) {
                    Ok(_) => {
                        self.shares = self.env.share_count(&self.market);
                        prop_assert!(self.shares > shares_before);
                    }
                    Err(refusal) => {
                        let expected = format!("{:?}", StrategyError::ZeroShares);
                        prop_assert!(refusal.contains(&expected), "{}", refusal);
                        prop_assert_eq!(self.reserves(), before);
                    }
                }
            }
            Step::Donate { side, amount } => {
                let vault = self.market.vaults[side];
                self.env.donate(&self.market, side, &vault, amount);
                self.donated[side] += amount;
                // `donate` funds a fresh donor with `amount` of each mint, and the donor
                // keeps the other mint's.
                self.created[0] += amount as u128;
                self.created[1] += amount as u128;
                self.with_donors[1 - side] += amount as u128;
                prop_assert_eq!(self.reserves(), before);
            }
            Step::DonateCtokens { amount } => {
                let account = self.market.addresses.ctoken_account;
                let held = self.env.balance(&account);
                self.env.patch(&account, 64, &(held + amount).to_le_bytes());
                self.donated_ctokens += amount;
                prop_assert_eq!(self.reserves(), before);
            }
            Step::Wait { slots } => {
                let mut clock: solana_clock::Clock = self.env.svm.get_sysvar();
                clock.slot += slots;
                clock.unix_timestamp += (slots * 2 / 5) as i64;
                self.env.svm.set_sysvar(&clock);
                prop_assert_eq!(self.reserves(), before);
            }
        }
        Ok(())
    }

    fn check(&self, value_per_share: &mut (u128, u128)) -> Result<(), TestCaseError> {
        let env = &self.env;
        let market = &self.market;
        let state = env.market_state(&market.market_state);

        // Value conserved: each vault holds what is recorded plus what was donated, and no
        // token went anywhere but known holders and Pipeline's fee accounts.
        for i in 0..2 {
            let vault = env.balance(&market.vaults[i]);
            prop_assert_eq!(vault, state.reserves[i] + self.donated[i], "vault {}", i);
            // What was recorded never exceeds what is held.
            prop_assert!(state.reserves[i] <= vault);
            let fees = env.balance_or_zero(&pda::fee_account(
                &market.market,
                &market.mints[i],
                &market.token_programs[i],
            ));
            let mut held = vault as u128 + fees as u128;
            for wallet in self.traders.iter().chain(&self.lps) {
                held += self.holding(&wallet.pubkey(), i) as u128;
            }
            held += self.with_donors[i];
            prop_assert_eq!(held, self.created[i], "mint {} conserved", i);
        }

        // Nothing deposited into or redeemed from Kamino, the recorded cTokens never move, and
        // the cToken account holds them plus what was donated: recorded never exceeds held.
        prop_assert_eq!(state.ctokens, self.ctokens);
        prop_assert_eq!((state.deposited, state.redeemed), (0, 0));
        let ctokens_held = env.balance(&market.addresses.ctoken_account);
        prop_assert_eq!(ctokens_held, self.ctokens + self.donated_ctokens);
        prop_assert!(state.ctokens <= ctokens_held);

        // The share count changes only by add_liquidity.
        let n = env.share_count(market);
        prop_assert_eq!(n, self.shares);
        prop_assert!(n > MINIMUM_LIQUIDITY);

        // The value of an LP share, R x L / N^2, never falls: compare
        // R'L' x N^2 >= R L x N'^2 in 256 bits.
        let effective = self.effective();
        let product = effective[0] as u128 * effective[1] as u128;
        let square = n as u128 * n as u128;
        let (old_product, old_square) = *value_per_share;
        prop_assert!(
            wide_mul(product, old_square) >= wide_mul(old_product, square),
            "an LP share lost value"
        );
        *value_per_share = (product, square);

        // Every holder can exit: every trader can sell everything they hold of each mint.
        for trader in &self.traders {
            for input in 0..2 {
                // All they hold, less Pipeline's fee on top.
                let amount = amount_for_budget(self.holding(&trader.pubkey(), input), 0);
                if amount == 0 {
                    continue;
                }
                if let Err(refusal) = env.quote(market, &exact_in(input, 1 - input, amount)) {
                    prop_assert!(
                        refusal.contains("ZeroOutput")
                            || (input == 0 && refusal.contains("BeyondBuffer")),
                        "a trader can't exit: {}",
                        refusal
                    );
                }
            }
        }
        Ok(())
    }
}

/// `a x b` as a 256-bit number, high half first, so two products compare correctly.
fn wide_mul(a: u128, b: u128) -> (u128, u128) {
    let mask = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & mask);
    let (b1, b0) = (b >> 64, b & mask);
    let (mid, mid_carry) = (a1 * b0).overflowing_add(a0 * b1);
    let (lo, lo_carry) = (a0 * b0).overflowing_add(mid << 64);
    let hi = a1 * b1 + (mid >> 64) + ((mid_carry as u128) << 64) + lo_carry as u128;
    (hi, lo)
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: std::env::var("PROPTEST_CASES").ok().and_then(|c| c.parse().ok()).unwrap_or(24),
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn the_invariants_hold_after_every_step(
        lp_fee_bps in prop_oneof![Just(0u16), Just(30), Just(200), 0u16..=200],
        ctokens in prop_oneof![Just(0u64), 1..200 * SOL],
        steps in proptest::collection::vec(step(), 1..32),
    ) {
        let mut world = World::new(lp_fee_bps, ctokens);
        let reserves = world.effective();
        let n = world.env.share_count(&world.market);
        let mut value = (reserves[0] as u128 * reserves[1] as u128, n as u128 * n as u128);
        world.check(&mut value)?;
        for step in &steps {
            world.run(step)?;
            world.check(&mut value)?;
        }
    }
}

#[test]
fn wide_mul_compares_products_beyond_128_bits() {
    assert_eq!(wide_mul(u128::MAX, 2), (1, u128::MAX - 1));
    assert!(wide_mul(u128::MAX, 3) > wide_mul(u128::MAX, 2));
    assert_eq!(wide_mul(1 << 64, 1 << 64), (1, 0));
}
