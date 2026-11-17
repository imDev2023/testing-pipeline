//! The stateful invariant fuzzer (docs/spec/README.md, "Test layers" 3): Proptest generates
//! WSOL-lent markets, created through the router or seeded by a launchpad with their first
//! deposit's shares locked, which may lend from the start, and sequences of swaps (some redeeming
//! their shortfall from Kamino), deposits, removals in cash and in kind, locks and SPL burns of
//! LP shares, `rebalance` calls, donations of tokens and cTokens and clock jumps, and moves of
//! Kamino's own state (borrowers borrowing and repaying its free liquidity to anywhere from 0 to
//! 15 times the market's exposure, around withdraw mode's thresholds, and `block_ctoken_usage`
//! and both emergency modes switched on and off), sent as real transactions through the router
//! copied from devnet and klend's deployed bytes, against the Kamino reserve dumped from the
//! cluster this build lends on, in LiteSVM. A market holds only
//! the cTokens klend's own deposits minted it. After every step it checks the bar's three
//! shared invariants and the lending AMM's own that this build makes checkable
//! (docs/spec/lending-pool.md, "Invariants for test layer 3"):
//!
//! - value is conserved: every token any step created is held by a known account or was lent
//!   to Kamino by `rebalance` (net of what it redeemed), and each vault holds exactly what the
//!   market has recorded plus what was donated to it;
//! - every holder can exit: every trader can sell all they hold of either mint, Pipeline's
//!   fee included (a holding too small to buy one unit is refused as dust, cleanly, and so is a
//!   sell paying out more of the lent side than the buffer holds plus what Kamino can pay right
//!   now, by the spec's formula), and every LP can remove all their shares in kind;
//! - each quote equals its swap;
//! - what the market has recorded never exceeds what it holds: the buffer and the other side
//!   against their vaults, the cTokens against the cToken account;
//! - no swap lowers `R x L`, and no step lowers the value of an LP share (`R x L / N^2`), with
//!   `L = B + V`, the cTokens valued at the reserve's stored rate, which only klend's own calls
//!   move, and only up; a `rebalance`, and a swap that redeems, may lower `L` by Kamino's
//!   rounding, one unit, and a removal by the rounding down of the remaining cTokens' value, one
//!   unit, while per share none of `R`, `B` and `c` falls;
//! - a removal pays exactly `R x lp / N`, `B x lp / N` and `c x lp / N`, rounded down, the last
//!   redeemed by klend in cash for at least its value at the stored rate, or paid as cTokens in
//!   kind;
//! - the share count changes only by `add_liquidity`, `remove_liquidity`, seeding and SPL burns,
//!   and the lock account's balance never falls from what seeding and `lock_lp` put there;
//! - a swap never deposits into Kamino, never redeems when the buffer covers its output, and
//!   otherwise redeems exactly `ceil(s x S_ctoken / S_total)` cTokens for its shortfall `s`, never
//!   more than one cToken beyond what is worth `s`, receives at least `s` and keeps the rest in
//!   the buffer;
//! - only `rebalance`, a swap's redeem and a removal move the recorded cTokens, and outside
//!   withdraw mode `rebalance` only ever moves the buffer's share towards `BUFFER_TARGET_BPS`: a
//!   deposit only from above the band, landing on the target within Kamino's rounding, a redeem
//!   only from below it, never past the target by more than that rounding;
//! - withdraw mode (docs/spec/lending-pool.md, "Withdraw mode"): `rebalance` enters it below
//!   `WITHDRAW_MODE_ENTER` times `max(V, T)` of Kamino's free liquidity, leaves it above
//!   `WITHDRAW_MODE_EXIT` times, and keeps the mode it has between, so a market in withdraw mode
//!   stays in it across `rebalance` calls while the free liquidity is at or below the exit
//!   threshold; in withdraw mode it only redeems, everything Kamino can pay; it never deposits
//!   while cToken deposits are blocked; it refuses while Kamino redeems nothing; and refused,
//!   for the reason the rules give, it changed nothing;
//! - a removal in cash is refused while Kamino redeems nothing and the LP's part holds cTokens,
//!   and every LP can still remove in kind.
//!
//! Each case runs in a fresh VM. `PROPTEST_CASES` sets how many cases run (default 24, of
//! up to 32 steps each).

mod common;

use common::remove::Payout;
use common::*;
use lending_amm::config::{BUFFER_TARGET_BPS, MINIMUM_LIQUIDITY};
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
    /// Anyone calls `rebalance`; a keeper that sees the reserve's stored rate is stale puts
    /// klend's `refresh_reserve` first (`refresh_first`).
    Rebalance { refresh_first: bool },
    /// A trader sells the other mint for as much of the lent mint as pays out `fraction` (in
    /// millionths) of the buffer, which can take it below the band, or, beyond a whole buffer,
    /// redeem the rest from Kamino in the swap.
    DrainBuffer { trader: usize, fraction: u32 },
    /// An LP removes `fraction` (in millionths) of the shares they hold, in cash or in kind.
    Remove {
        lp: usize,
        fraction: u32,
        in_kind: bool,
    },
    /// An LP locks `fraction` (in millionths) of the shares they hold.
    Lock { lp: usize, fraction: u32 },
    /// An LP burns `fraction` (in millionths) of the shares they hold with SPL Token.
    Burn { lp: usize, fraction: u32 },
    /// Kamino's borrowers borrow or repay until its freely available liquidity is `tenths`
    /// tenths of the market's exposure `X = max(V, T)`, around withdraw mode's thresholds, as far
    /// as what they owe allows; the total supply, and so the rate, stays as it was.
    Liquidity { tenths: u64 },
    /// Kamino's admin or the lending market's owner sets one of its switches: `block_ctoken_usage`
    /// (0), the reserve's emergency mode (1) or the lending market's (2).
    Switch { which: u8, on: bool },
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
        3 => any::<bool>().prop_map(|refresh_first| Step::Rebalance { refresh_first }),
        2 => (0..2usize, 300_000..2_000_000u32)
            .prop_map(|(trader, fraction)| Step::DrainBuffer { trader, fraction }),
        3 => (0..2usize, 1..=1_000_000u32, any::<bool>())
            .prop_map(|(lp, fraction, in_kind)| Step::Remove { lp, fraction, in_kind }),
        1 => (0..2usize, 1..=1_000_000u32).prop_map(|(lp, fraction)| Step::Lock { lp, fraction }),
        1 => (0..2usize, 1..=1_000_000u32).prop_map(|(lp, fraction)| Step::Burn { lp, fraction }),
        2 => (0..=150u64).prop_map(|tenths| Step::Liquidity { tenths }),
        1 => (0..3u8, any::<bool>()).prop_map(|(which, on)| Step::Switch { which, on }),
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
    /// The cTokens the market should have recorded, from klend's deposits and redeems.
    ctokens: u64,
    /// The running totals the market should have recorded of the lent mint deposited into
    /// Kamino and redeemed from it.
    deposited: u128,
    redeemed: u128,
    /// Every cToken donated to the cToken account.
    donated_ctokens: u64,
    /// The share count the market should have.
    shares: u64,
    /// How the case's `rebalance` calls went: deposits, redeems, refusals inside the band, below
    /// the floor, while Kamino redeemed nothing and while it blocked deposits, and calls that
    /// changed withdraw mode, and redeems klend refused on a stale reserve and that landed with
    /// its refresh first, printed with `--nocapture` to show what the fuzzer reached.
    rebalances: [usize; 8],
    /// How many swaps redeemed their shortfall from Kamino.
    redeeming_swaps: usize,
    /// The LP shares the lock account should hold.
    locked: u64,
    /// The net amount lent that cTokens paid in kind took off the market's running totals, now
    /// held by LPs as cTokens.
    taken_in_kind: i128,
    /// How many removals went through in cash and in kind, and how many locks and burns.
    removals: [usize; 2],
    locks_and_burns: [usize; 2],
}

const SEED: [u64; 2] = [2_000_000_000_000, 40 * SOL];
const HOLDING: [u64; 2] = [5_000_000_000_000, 100 * SOL];

impl World {
    /// A market at `lp_fee_bps`, created through the router with its first deposit by the first
    /// LP, or, when `seeded`, seeded by the stand-in launchpad from its escrows with the shares
    /// locked (the vault authority as the LP recipient), and recorded with the router in the
    /// same transaction; it lends straight away when `lend_first`.
    fn new(lp_fee_bps: u16, lend_first: bool, seeded: bool) -> Self {
        let mut env = Env::new();
        env.load_klend();
        let spec = env.wsol_market_spec(lp_fee_bps);
        let (market, first, locked) = if seeded {
            let launch = env.launch(spec.mints, SEED);
            let authority = launch.addresses(&spec.params).authority;
            let graduated = env
                .graduate(&launch, &spec.params, SEED, &authority)
                .unwrap();
            let first = env.funded_wallet(&graduated.market, [0, 0]);
            (graduated.market, first, graduated.graduation.lp_amount)
        } else {
            let (market, first) = env.create_funded_market(&spec, SEED).unwrap();
            (market, first, 0)
        };
        if lend_first {
            env.rebalance(&market, None).unwrap();
        }
        let state = env.market_state(&market.market_state);
        let shares = env.share_count(&market);
        let traders: Vec<Keypair> = (0..2)
            .map(|_| env.funded_wallet(&market, HOLDING))
            .collect();
        let second = env.funded_wallet(&market, HOLDING);
        // The first LP spent everything on the seed, or holds nothing of a seeded market; give
        // them more to add later.
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
            ctokens: state.ctokens,
            deposited: state.deposited,
            redeemed: state.redeemed,
            donated_ctokens: 0,
            shares,
            rebalances: [0; 8],
            redeeming_swaps: 0,
            locked,
            taken_in_kind: 0,
            removals: [0; 2],
            locks_and_burns: [0; 2],
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

    /// Runs `step`, and returns how far it may have lowered the lent side's total by Kamino's
    /// rounding: one unit after a `rebalance` that moved or a swap that redeemed, and nothing
    /// after any other step.
    fn run(&mut self, step: &Step) -> Result<u64, TestCaseError> {
        // An LP who has never deposited has no shares account to remove, lock or burn from.
        if let Step::Remove { lp, .. } | Step::Lock { lp, .. } | Step::Burn { lp, .. } = *step {
            let shares_account =
                lp_shares_account(&self.lps[lp].pubkey(), &self.market.market_state);
            if self.env.svm.get_account(&shares_account).is_none() {
                return Ok(0);
            }
        }
        let before = self.reserves();
        let effective_before = self.effective();
        match *step {
            Step::Swap {
                trader,
                input,
                fraction,
            } => {
                let wallet = self.traders[trader].pubkey();
                // What the trader can spend, Pipeline's fee included.
                let budget =
                    (self.holding(&wallet, input) as u128 * fraction as u128 / 1_000_000) as u64;
                let amount = amount_for_budget(budget, 0);
                return self.swap(trader, input, amount);
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
            Step::Rebalance { refresh_first } => return self.rebalance(refresh_first),
            Step::Liquidity { tenths } => {
                let wanted = (self.exposure() as u128 * tenths as u128 / 10) as u64;
                let reserve = self.reserve();
                // Borrowers can repay only what they owe.
                let most =
                    reserve.total_available_amount + (reserve.borrowed_amount_sf >> 60) as u64;
                self.env.set_free_liquidity(&self.market, wanted.min(most));
                prop_assert_eq!(self.reserves(), before);
            }
            Step::Switch { which, on } => {
                use lending_amm::kamino::{lending_market_offsets, offsets};
                let reserve = self.env.reserve_of(&self.market);
                let lending_market = self.env.kamino.address("lending-market");
                match which {
                    0 => self
                        .env
                        .patch(&reserve, offsets::BLOCK_CTOKEN_USAGE, &[on as u8]),
                    1 => self
                        .env
                        .patch(&reserve, offsets::EMERGENCY_MODE, &[on as u8]),
                    _ => self.env.patch(
                        &lending_market,
                        lending_market_offsets::EMERGENCY_MODE,
                        &[on as u8],
                    ),
                }
                prop_assert_eq!(self.reserves(), before);
            }
            Step::Remove {
                lp,
                fraction,
                in_kind,
            } => {
                let held = self.env.lp_shares_of(&self.market, &self.lps[lp].pubkey());
                let shares = (held as u128 * fraction as u128 / 1_000_000) as u64;
                return self.remove(lp, shares, in_kind);
            }
            Step::Lock { lp, fraction } => {
                let wallet = self.lps[lp].insecure_clone();
                let held = self.env.lp_shares_of(&self.market, &wallet.pubkey());
                let amount = (held as u128 * fraction as u128 / 1_000_000) as u64;
                let lock = self.env.lock_account(&self.market);
                match self.env.lock_lp(&self.market, &wallet, amount) {
                    Ok(_) => {
                        self.locked += amount;
                        prop_assert_eq!(self.env.balance(&lock), self.locked);
                        prop_assert_eq!(
                            self.env.lp_shares_of(&self.market, &wallet.pubkey()),
                            held - amount
                        );
                        self.locks_and_burns[0] += 1;
                    }
                    Err(refusal) => {
                        prop_assert_eq!(amount, 0, "{}", refusal);
                        prop_assert!(refusal.contains("ZeroLock"), "{}", refusal);
                    }
                }
                prop_assert_eq!(self.reserves(), before);
            }
            Step::Burn { lp, fraction } => {
                let wallet = self.lps[lp].insecure_clone();
                let held = self.env.lp_shares_of(&self.market, &wallet.pubkey());
                let amount = (held as u128 * fraction as u128 / 1_000_000) as u64;
                self.env
                    .burn_shares(&self.market, &wallet, amount)
                    .map_err(TestCaseError::fail)?;
                self.shares -= amount;
                self.locks_and_burns[1] += 1;
                prop_assert_eq!(self.reserves(), before);
            }
            Step::DrainBuffer { trader, fraction } => {
                // out = L x a_net / (R + a_net), so a_net = out x R / (L - out), and the input
                // a is a_net plus the LP fee on it, rounded up; then it is an ordinary swap.
                let lent = self.market.lent_index;
                let other = self.market.other_index();
                let state = self.env.market_state(&self.market.market_state);
                let total = effective_before[lent] as u128;
                // Up to twice the buffer, which redeems the rest from Kamino, and short of the
                // whole lent side.
                let out = (state.reserves[lent] as u128 * fraction as u128 / 1_000_000)
                    .min(total * 9 / 10);
                let net = (out * effective_before[other] as u128).div_ceil(total - out);
                let fee = state.lp_fee_bps as u128;
                let amount = (net * 10_000).div_ceil(10_000 - fee);
                let budget = self.holding(&self.traders[trader].pubkey(), other);
                let fraction = (amount * 1_000_000 / (budget as u128).max(1)).min(999_999) as u32;
                return self.run(&Step::Swap {
                    trader,
                    input: other,
                    fraction: fraction.max(1),
                });
            }
        }
        Ok(0)
    }

    /// What Kamino can pay the market right now for a swap's redeem, as the program plans it.
    fn kamino_can_pay(&self) -> u64 {
        let ctokens = self.env.market_state(&self.market.market_state).ctokens;
        self.kamino_can_pay_for(ctokens)
    }

    /// Whether a quote of `amount` of mint `input` may be refused: dust that pays out nothing,
    /// or a lent-side payout beyond the buffer plus what Kamino can pay right now, by the
    /// spec's formula on the market as it is.
    fn refusal_expected(&self, input: usize, amount: u64, refusal: &str) -> bool {
        let lent = self.market.lent_index;
        let effective = self.effective();
        let state = self.env.market_state(&self.market.market_state);
        let fee = (amount as u128 * state.lp_fee_bps as u128).div_ceil(10_000);
        let net = amount as u128 - fee;
        let out = effective[1 - input] as u128 * net / (effective[input] as u128 + net);
        if out == 0 {
            return refusal.contains("ZeroOutput");
        }
        let buffer = state.reserves[lent] as u128;
        1 - input == lent
            && out > buffer + self.kamino_can_pay() as u128
            && refusal.contains("BeyondBuffer")
    }

    /// A trader swaps `amount` of mint `input` through the router; checks it paid exactly its
    /// quote, never deposited into Kamino, never redeemed while the buffer covered its output,
    /// and otherwise redeemed exactly `ceil(s x S_ctoken / S_total)` cTokens for its shortfall
    /// `s`, no more than one cToken beyond what is worth `s`, receiving at least `s`; or that
    /// its quote and the swap were refused alike, for a reason the spec gives, changing nothing.
    /// Returns how far it may have lowered the lent side's total by Kamino's rounding: one unit
    /// after a redeem, as after a `rebalance`.
    fn swap(&mut self, trader: usize, input: usize, amount: u64) -> Result<u64, TestCaseError> {
        use lending_amm::events::ShortfallRedeemed;
        let output = 1 - input;
        let lent = self.market.lent_index;
        let before = self.env.market_state(&self.market.market_state);
        let effective_before = self.effective();
        let reserve = self.reserve();
        let ctokens_held = self.env.balance(&self.market.addresses.ctoken_account);
        let quote = self
            .env
            .quote(&self.market, &exact_in(input, output, amount));
        let trader = self.traders[trader].insecure_clone();
        let swapped = self
            .env
            .swap_meta(&self.market, &trader, (input, output), amount);
        let quote = match quote {
            Ok(quote) => quote,
            Err(refusal) => {
                prop_assert!(
                    self.refusal_expected(input, amount, &refusal),
                    "an unexpected refusal of {} of mint {}: {}",
                    amount,
                    input,
                    refusal
                );
                prop_assert!(swapped.is_err());
                prop_assert_eq!(self.env.market_state(&self.market.market_state), before);
                return Ok(0);
            }
        };
        let meta = swapped.map_err(TestCaseError::fail)?;
        let result: pipeline_client::SwapResult =
            borsh::from_slice(&meta.return_data.data).unwrap();
        // Each quote equals its swap.
        prop_assert_eq!(result.received, quote.amount_out);
        let after = self.env.market_state(&self.market.market_state);
        prop_assert_eq!(after.reserves[input], before.reserves[input] + amount);
        // A swap never deposits into Kamino.
        prop_assert_eq!(after.deposited, before.deposited);
        let redeems = events::<ShortfallRedeemed>(&meta.logs);
        let buffer = before.reserves[lent];
        let shortfall = if output == lent {
            quote.amount_out.saturating_sub(buffer)
        } else {
            0
        };
        let rounding = if shortfall == 0 {
            // A swap the buffer covers, or one paying out the other side, never redeems.
            prop_assert!(redeems.is_empty());
            prop_assert_eq!(after.ctokens, before.ctokens);
            prop_assert_eq!(after.redeemed, before.redeemed);
            prop_assert_eq!(
                after.reserves[output],
                before.reserves[output] - quote.amount_out
            );
            0
        } else {
            prop_assert_eq!(redeems.len(), 1);
            let redeem = &redeems[0];
            prop_assert_eq!(redeem.shortfall, shortfall);
            // It burns ceil(s x S_ctoken / S_total) at the stored rate, never more than one
            // cToken beyond what is worth s, and klend pays at least s.
            let burned = redeem.ctokens;
            prop_assert_eq!(
                burned,
                common::redeem::ctokens_for_shortfall(&reserve, shortfall)
            );
            let worth = lending_amm::kamino::ctokens_for_value(
                shortfall,
                reserve.total_supply_sf().unwrap(),
                reserve.mint_total_supply,
            )
            .unwrap();
            prop_assert!(burned <= worth + 1);
            prop_assert!(redeem.liquidity >= shortfall);
            prop_assert_eq!(after.ctokens, before.ctokens - burned);
            prop_assert_eq!(
                self.env.balance(&self.market.addresses.ctoken_account),
                ctokens_held - burned
            );
            prop_assert_eq!(after.redeemed, before.redeemed + redeem.liquidity as u128);
            // What klend paid above the shortfall stays in the buffer.
            prop_assert_eq!(after.reserves[lent], redeem.liquidity - shortfall);
            self.ctokens = after.ctokens;
            self.redeemed = after.redeemed;
            self.redeeming_swaps += 1;
            1
        };
        // No swap lowers R x L, with L = B + V, but for Kamino's rounding of a redeem.
        let (now, was) = (self.effective(), effective_before);
        prop_assert!(
            now[0] as u128 * (now[1] + rounding) as u128 >= was[0] as u128 * was[1] as u128,
            "a swap lowered R x L: {:?} -> {:?}",
            was,
            now
        );
        Ok(rounding)
    }

    /// What Kamino can pay right now for `ctokens` of the market's cTokens, as a cash removal
    /// plans its redeem.
    fn kamino_can_pay_for(&self, ctokens: u64) -> u64 {
        self.reserve().can_pay_planned(
            &self.lending_market(),
            ctokens,
            self.env.clock().unix_timestamp,
        )
    }

    /// An LP removes `shares` in cash or in kind; checks it paid exactly the spec's parts, the
    /// cTokens' part redeemed by klend for at least its value or paid as cTokens, and that per
    /// share none of the three sides fell; or that it was refused for a reason the spec gives,
    /// changing nothing. Returns how far it may have lowered the lent side's total by rounding
    /// down the remaining cTokens' value: one unit.
    fn remove(&mut self, lp: usize, shares: u64, in_kind: bool) -> Result<u64, TestCaseError> {
        use lending_amm::events::LiquidityRemoved;
        let (o, l) = (self.market.other_index(), self.market.lent_index);
        let before = self.env.market_state(&self.market.market_state);
        let n = self.env.share_count(&self.market);
        let reserve = self.reserve();
        // The spec's parts, computed here on their own.
        let part = |whole: u64| (whole as u128 * shares as u128 / n as u128) as u64;
        let (other, buffer, ctokens) = (
            part(before.reserves[o]),
            part(before.reserves[l]),
            part(before.ctokens),
        );
        let worth = reserve.lent_value(ctokens).unwrap();
        let wallet = self.lps[lp].insecure_clone();
        let payout = if in_kind {
            Payout::InKind
        } else {
            Payout::Cash
        };
        let lp_ctoken = self.env.lp_ctoken_account(&self.market, &wallet.pubkey());
        let ctokens_before = self.env.balance_or_zero(&lp_ctoken);
        match self
            .env
            .remove_liquidity(&self.market, &wallet, shares, [0, 0], payout)
        {
            Ok(meta) => {
                let removed = events::<LiquidityRemoved>(&meta.logs);
                prop_assert_eq!(removed.len(), 1);
                let event = &removed[0];
                prop_assert_eq!(event.shares, shares);
                prop_assert_eq!(event.amounts[o], other);
                let after = self.env.market_state(&self.market.market_state);
                prop_assert_eq!(after.reserves[o], before.reserves[o] - other);
                prop_assert_eq!(after.reserves[l], before.reserves[l] - buffer);
                if in_kind {
                    prop_assert_eq!(event.amounts[l], buffer);
                    prop_assert_eq!((event.ctokens, event.redeemed), (ctokens, 0));
                    prop_assert_eq!(
                        self.env.balance_or_zero(&lp_ctoken),
                        ctokens_before + ctokens
                    );
                    prop_assert_eq!(after.ctokens, before.ctokens - ctokens);
                    // The cTokens take their part of the net amount lent, rounded towards zero,
                    // off whichever running total is the larger.
                    let net = before.deposited as i128 - before.redeemed as i128;
                    let take = if ctokens == 0 {
                        0
                    } else {
                        net * ctokens as i128 / before.ctokens as i128
                    };
                    let (deposited, redeemed) = if net >= 0 {
                        (before.deposited as i128 - take, before.redeemed as i128)
                    } else {
                        (before.deposited as i128, before.redeemed as i128 + take)
                    };
                    prop_assert_eq!(
                        (after.deposited as i128, after.redeemed as i128),
                        (deposited, redeemed)
                    );
                    self.taken_in_kind += take;
                } else {
                    // Redeemed only when worth a unit at the stored rate; then klend pays at least
                    // that, and the LP receives it with the buffer's part.
                    let burned = if worth > 0 { ctokens } else { 0 };
                    prop_assert_eq!(event.ctokens, burned);
                    prop_assert!(event.redeemed >= worth);
                    prop_assert_eq!(event.amounts[l], buffer + event.redeemed);
                    prop_assert_eq!(after.ctokens, before.ctokens - burned);
                    prop_assert_eq!(after.redeemed, before.redeemed + event.redeemed as u128);
                    prop_assert_eq!(self.env.balance_or_zero(&lp_ctoken), ctokens_before);
                    prop_assert_eq!(after.deposited, before.deposited);
                }
                // Per share, none of R, B and c falls: X' x N >= X x N'.
                let n_after = n - shares;
                for (now, was) in [
                    (after.reserves[o], before.reserves[o]),
                    (after.reserves[l], before.reserves[l]),
                    (after.ctokens, before.ctokens),
                ] {
                    prop_assert!(now as u128 * n as u128 >= was as u128 * n_after as u128);
                }
                self.shares = n_after;
                self.deposited = after.deposited;
                self.ctokens = after.ctokens;
                self.redeemed = after.redeemed;
                self.removals[in_kind as usize] += 1;
                Ok(1)
            }
            Err(refusal) => {
                let expected = if shares == 0 || (other == 0 && buffer == 0 && ctokens == 0) {
                    "ZeroRemoval"
                } else if !in_kind && ctokens > 0 && self.redeems_stopped() {
                    // klend redeems nothing: the cTokens' part goes in kind only.
                    "KaminoCannotPay"
                } else if !in_kind && worth == 0 && other == 0 && buffer == 0 {
                    "ZeroRemoval"
                } else if !in_kind && worth > 0 && worth > self.kamino_can_pay_for(ctokens) {
                    "KaminoCannotPay"
                } else {
                    "an unexpected refusal"
                };
                prop_assert!(
                    refusal.contains(&format!("Error Code: {expected}.")),
                    "{} of {} shares, in kind {}: {}",
                    expected,
                    shares,
                    in_kind,
                    refusal
                );
                prop_assert_eq!(self.env.market_state(&self.market.market_state), before);
                Ok(0)
            }
        }
    }

    /// The lending market as the program reads it.
    fn lending_market(&self) -> lending_amm::kamino::LendingMarket {
        let entry = &lending_amm::config::LENT_MINTS[self.env.lent_entry_of(&self.market)];
        let data = self.env.data(&ck(&entry.lending_market));
        lending_amm::kamino::read_lending_market(
            &entry.lending_market,
            &lending_amm::config::KLEND_PROGRAM,
            &data,
            entry,
        )
        .unwrap()
    }

    /// Whether klend redeems nothing right now: either emergency mode, or a deprecated reserve.
    fn redeems_stopped(&self) -> bool {
        let reserve = self.reserve();
        self.lending_market().emergency_mode
            || reserve.emergency_mode
            || reserve.version != lending_amm::kamino::RESERVE_VERSION
    }

    /// The market's exposure, `X = max(V, T)` with `T = L - floor(L x BUFFER_TARGET_BPS /
    /// 10,000)`, by the spec's formula on the market as it is.
    fn exposure(&self) -> u64 {
        let lent = self.market.lent_index;
        let total = self.effective()[lent];
        let value = total - self.env.market_state(&self.market.market_state).reserves[lent];
        let target = (total as u128 * BUFFER_TARGET_BPS as u128 / 10_000) as u64;
        value.max(total - target)
    }

    /// Anyone calls `rebalance`; checks it did what the spec's rules give for Kamino's state,
    /// stated here on their own: while Kamino redeems nothing it refuses; withdraw mode is
    /// entered below `WITHDRAW_MODE_ENTER x X` of free liquidity, left above
    /// `WITHDRAW_MODE_EXIT x X` and kept between, so a market in withdraw mode stays in it while
    /// the free liquidity is at or below the exit threshold; in withdraw mode it only redeems,
    /// everything Kamino can pay; outside it it moves the buffer's share only towards its target;
    /// it never deposits while Kamino blocks cToken deposits; a call that changes the mode
    /// succeeds even when it moves nothing; and a refused call changes nothing.
    ///
    /// klend pays at the rate it refreshes to, so a redeem planned right up to Kamino's free
    /// liquidity or withdrawal cap on a reserve whose stored rate is older than
    /// `KAMINO_RATE_HEADROOM_BPS` covers overshoots it, and klend refuses it; then nothing
    /// changed, and the keeper's way, klend's `refresh_reserve` first, lands it
    /// (docs/spec/lending-pool.md, "The rule").
    fn rebalance(&mut self, refresh_first: bool) -> Result<u64, TestCaseError> {
        use lending_amm::buffer::{band, plan, target, Band, Move};
        use lending_amm::config::{WITHDRAW_MODE_ENTER, WITHDRAW_MODE_EXIT};
        // klend refuses a refresh in emergency mode, where `rebalance` refuses anyway.
        if refresh_first && !self.redeems_stopped() {
            let refresh = self.env.refresh_reserve_instruction(&self.market);
            self.env.send(&[refresh], &[]).unwrap();
        }
        let refreshed_slot = {
            let reserve = self.env.reserve_of(&self.market);
            u64::from_le_bytes(self.env.data(&reserve)[16..24].try_into().unwrap())
        };
        let stale = refreshed_slot != self.env.clock().slot;
        let lent = self.market.lent_index;
        let before = self.env.market_state(&self.market.market_state);
        let reserve = self.reserve();
        let total = self.effective()[lent];
        let buffer = before.reserves[lent];
        let value = total - buffer;
        let entry = &lending_amm::config::LENT_MINTS[self.env.lent_entry_of(&self.market)];
        let can_pay = reserve.can_pay_planned(
            &self.lending_market(),
            before.ctokens,
            self.env.clock().unix_timestamp,
        );
        let free = reserve.freely_available() as u128;
        let exposure = self.exposure() as u128;
        let stopped = self.redeems_stopped();
        let blocked = reserve.block_ctoken_usage;
        let mode = if free < WITHDRAW_MODE_ENTER as u128 * exposure {
            true
        } else if free > WITHDRAW_MODE_EXIT as u128 * exposure {
            false
        } else {
            before.withdraw_mode
        };
        // What the spec's rules give: a move, or no move with the mode changed, or a refusal.
        let planned: Result<Option<Move>, StrategyError> = if stopped {
            Err(StrategyError::KaminoStopped)
        } else {
            let moved = if mode {
                let asked = value.min(can_pay);
                if asked == 0 || (asked < entry.min_rebalance && asked < value) {
                    Err(StrategyError::BelowMinRebalance)
                } else {
                    Ok(Move::Redeem(asked))
                }
            } else {
                match plan(buffer, total, can_pay, entry.min_rebalance) {
                    Ok(Move::Deposit(_)) if blocked => Err(StrategyError::KaminoDepositsBlocked),
                    other => other,
                }
            };
            match moved {
                Ok(moved) => Ok(Some(moved)),
                Err(_) if mode != before.withdraw_mode => Ok(None),
                Err(rule) => Err(rule),
            }
        };
        let result = self.env.rebalance(&self.market, None);
        let after = self.env.market_state(&self.market.market_state);
        // A market in withdraw mode stays in it while Kamino's free liquidity is at or below the
        // exit threshold, however much it has redeemed.
        if before.withdraw_mode && free <= WITHDRAW_MODE_EXIT as u128 * exposure {
            prop_assert!(
                after.withdraw_mode,
                "left withdraw mode at {} free, X {}",
                free,
                exposure
            );
        }
        match (planned, result) {
            (Ok(planned), Ok(_)) => {
                prop_assert_eq!(after.withdraw_mode, mode);
                let total_after = self.effective()[lent];
                let buffer_after = after.reserves[lent];
                // Within Kamino's rounding: one cToken's worth, rounded up, and a unit.
                let one_ctoken = reserve
                    .total_supply_sf()
                    .unwrap()
                    .div_ceil((reserve.mint_total_supply as u128) << 60)
                    as u64
                    + 1;
                match planned {
                    None => {
                        // Only the mode changed.
                        prop_assert_ne!(mode, before.withdraw_mode);
                        prop_assert_eq!(
                            (
                                after.reserves,
                                after.ctokens,
                                after.deposited,
                                after.redeemed
                            ),
                            (
                                before.reserves,
                                before.ctokens,
                                before.deposited,
                                before.redeemed
                            )
                        );
                    }
                    Some(Move::Deposit(asked)) => {
                        prop_assert!(
                            !mode && !blocked,
                            "deposited in withdraw mode or while blocked"
                        );
                        prop_assert_eq!(band(buffer, total), Band::Above);
                        let taken = buffer - buffer_after;
                        prop_assert!(taken <= asked && asked - taken <= one_ctoken);
                        prop_assert!(after.ctokens > before.ctokens);
                        prop_assert_eq!(after.deposited, before.deposited + taken as u128);
                        prop_assert_eq!(after.redeemed, before.redeemed);
                        // On the target it was planned at, within klend's rounding; klend's
                        // refresh then accrues interest that raises L, and the target, a little.
                        let planned_target = target(total);
                        prop_assert!(buffer_after >= planned_target);
                        prop_assert!(buffer_after - planned_target <= one_ctoken);
                    }
                    Some(Move::Redeem(asked)) => {
                        if !mode {
                            prop_assert_eq!(band(buffer, total), Band::Below);
                        }
                        let received = buffer_after - buffer;
                        // klend pays at the rate it refreshes to, at most the rate it leaves:
                        // the cTokens it burned are worth at most what was asked at the stored
                        // rate, so it pays at most that, grown by the rate's rise.
                        let reserve_after = self.reserve();
                        let rate = |r: &lending_amm::kamino::Reserve| {
                            r.total_supply_sf().unwrap() as f64 / r.mint_total_supply as f64
                        };
                        let accrual = asked as f64 * (rate(&reserve_after) / rate(&reserve) - 1.0);
                        let allowed = asked + one_ctoken + accrual.max(0.0).ceil() as u64;
                        prop_assert!(received <= allowed, "{} > {}", received, allowed);
                        prop_assert!(after.ctokens < before.ctokens);
                        prop_assert_eq!(after.redeemed, before.redeemed + received as u128);
                        prop_assert_eq!(after.deposited, before.deposited);
                        if !mode {
                            prop_assert!(buffer_after <= target(total) + (allowed - asked));
                        }
                    }
                }
                // Outside withdraw mode, towards the target: the distance from it in basis
                // points of the lent side never grows.
                if !mode && planned.is_some() {
                    let distance = |b: u64, l: u64| {
                        (b as i128 * 10_000 - l as i128 * BUFFER_TARGET_BPS as i128).abs()
                            * 1_000_000
                            / (l as i128).max(1)
                    };
                    prop_assert!(distance(buffer_after, total_after) <= distance(buffer, total));
                }
                self.ctokens = after.ctokens;
                self.deposited = after.deposited;
                self.redeemed = after.redeemed;
                match planned {
                    Some(Move::Deposit(_)) => self.rebalances[0] += 1,
                    Some(Move::Redeem(_)) => self.rebalances[1] += 1,
                    None => {}
                }
                if mode != before.withdraw_mode {
                    self.rebalances[6] += 1;
                }
                Ok(planned.is_some() as u64)
            }
            (Ok(Some(Move::Redeem(asked))), Err(refusal))
                if stale
                    && asked == can_pay
                    && (refusal.contains("Error Code: InsufficientLiquidity.")
                        || refusal.contains("Error Code: WithdrawalCapReached.")) =>
            {
                prop_assert_eq!(after, before);
                self.rebalances[7] += 1;
                self.rebalance(true)
            }
            (Err(rule), Err(refusal)) => {
                prop_assert!(
                    refusal.contains(&format!("Error Code: {rule:?}.")),
                    "planned {:?}, refused with {}",
                    rule,
                    refusal
                );
                prop_assert_eq!(after, before);
                let slot = match rule {
                    StrategyError::WithinBand => 2,
                    StrategyError::BelowMinRebalance => 3,
                    StrategyError::KaminoStopped => 4,
                    _ => 5,
                };
                self.rebalances[slot] += 1;
                Ok(0)
            }
            (planned, result) => {
                prop_assert!(false, "planned {:?}, got {:?}", planned, result.map(|_| ()));
                Ok(0)
            }
        }
    }

    /// Checks every invariant; `rounding` is how far the last step may have lowered the lent
    /// side's total by Kamino's rounding.
    fn check(
        &self,
        value_per_share: &mut (u128, u128),
        rounding: u64,
    ) -> Result<(), TestCaseError> {
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
            // The lent mint `rebalance` deposited into Kamino and has not redeemed, the part
            // LPs took as cTokens included.
            let mut lent_to_kamino = 0i128;
            if i == market.lent_index {
                lent_to_kamino =
                    self.deposited as i128 - self.redeemed as i128 + self.taken_in_kind;
            }
            prop_assert_eq!(
                held as i128 + lent_to_kamino,
                self.created[i] as i128,
                "mint {} conserved",
                i
            );
        }

        // Only rebalance, a swap's redeem and a removal move the recorded cTokens and the running
        // totals, and the cToken account holds them plus what was donated: recorded never
        // exceeds held.
        prop_assert_eq!(state.ctokens, self.ctokens);
        prop_assert_eq!(
            (state.deposited, state.redeemed),
            (self.deposited, self.redeemed)
        );
        let ctokens_held = env.balance(&market.addresses.ctoken_account);
        prop_assert_eq!(ctokens_held, self.ctokens + self.donated_ctokens);
        prop_assert!(state.ctokens <= ctokens_held);

        // The share count changes only by add_liquidity, remove_liquidity and SPL burns, and the
        // lock account's balance never falls.
        let n = env.share_count(market);
        prop_assert_eq!(n, self.shares);
        prop_assert!(n >= MINIMUM_LIQUIDITY);
        prop_assert_eq!(env.balance_or_zero(&env.lock_account(market)), self.locked);

        // The value of an LP share, R x L / N^2, never falls, but for Kamino's rounding of the
        // lent side in a rebalance: compare R'(L' + rounding) x N^2 >= R L x N'^2 in 256 bits.
        let effective = self.effective();
        let product = effective[0] as u128 * effective[1] as u128;
        let allowed = effective[0] as u128 * (effective[1] + rounding) as u128;
        let square = n as u128 * n as u128;
        let (old_product, old_square) = *value_per_share;
        prop_assert!(
            wide_mul(allowed, old_square) >= wide_mul(old_product, square),
            "an LP share lost value"
        );
        *value_per_share = (product, square);

        // Every holder can exit: every LP can remove all their shares in kind, whatever Kamino's
        // state, unless they hold too few to pay out anything...
        for lp in &self.lps {
            let held = env.lp_shares_of(market, &lp.pubkey());
            if held == 0 {
                continue;
            }
            let remove = env.remove_liquidity_instruction(
                market,
                &lp.pubkey(),
                held,
                [0, 0],
                Payout::InKind,
            );
            if let Err(refusal) = env.simulate_signed(&[remove], &[lp]) {
                prop_assert!(
                    refusal.contains("Error Code: ZeroRemoval."),
                    "an LP can't exit: {}",
                    refusal
                );
            }
        }
        // ...and every trader can sell everything they hold of each mint.
        for trader in &self.traders {
            for input in 0..2 {
                // All they hold, less Pipeline's fee on top.
                let amount = amount_for_budget(self.holding(&trader.pubkey(), input), 0);
                if amount == 0 {
                    continue;
                }
                if let Err(refusal) = env.quote(market, &exact_in(input, 1 - input, amount)) {
                    prop_assert!(
                        self.refusal_expected(input, amount, &refusal),
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
        lend_first: bool,
        seeded: bool,
        steps in proptest::collection::vec(step(), 1..32),
    ) {
        let mut world = World::new(lp_fee_bps, lend_first, seeded);
        let reserves = world.effective();
        let n = world.env.share_count(&world.market);
        let mut value = (reserves[0] as u128 * reserves[1] as u128, n as u128 * n as u128);
        world.check(&mut value, 0)?;
        for step in &steps {
            let rounding = world.run(step)?;
            world.check(&mut value, rounding)?;
        }
        let [deposits, redeems, within, below, stopped, blocked, mode_changes, stale] =
            world.rebalances;
        let [cash, in_kind] = world.removals;
        let [locks, burns] = world.locks_and_burns;
        println!(
            "{}: rebalance: {deposits} deposits, {redeems} redeems, refused {within} inside the band, \
             {below} below the floor, {stopped} while Kamino redeemed nothing and {blocked} while it \
             blocked deposits, {mode_changes} withdraw mode changes, {stale} stale redeems retried with \
             klend's refresh first; {} swaps redeemed their \
             shortfall; removals: {cash} in cash, {in_kind} in kind; {locks} locks and {burns} burns",
            if seeded { "seeded" } else { "created" },
            world.redeeming_swaps
        );
    }
}

#[test]
fn wide_mul_compares_products_beyond_128_bits() {
    assert_eq!(wide_mul(u128::MAX, 2), (1, u128::MAX - 1));
    assert!(wide_mul(u128::MAX, 3) > wide_mul(u128::MAX, 2));
    assert_eq!(wide_mul(1 << 64, 1 << 64), (1, 0));
}
