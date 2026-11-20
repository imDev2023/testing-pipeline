//! What a priced swap does to a market's books, in pure functions that take no accounts
//! (docs/spec/pool4-for-solana.md, "The fee", "After pricing" steps 2 and 3, "Counters").
//!
//! The fee is always in lamports, and nothing is paid out during a swap: every share of it
//! waits in its ledger in the SOL vault until a keeper job pays it.

use crate::config::{DESIGNER_SHARE_BPS, SUITE_SHARE_BPS};
use crate::params::BPS;
use crate::pricing::{Priced, Side};

/// One swap's fee, split (the spec's "The fee").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeSplit {
    /// `floor(fee × DESIGNER_SHARE_BPS / 10,000)`, for `fees_designer`.
    pub designer: u64,
    /// `floor(fee × SUITE_SHARE_BPS / 10,000)`, for `fees_suite`.
    pub suite: u64,
    /// `floor(rest × wall_split_bps / 10,000)` of the market's part, for `idle_sol`.
    pub wall: u64,
    /// The rest of the market's part, for `fees_recipient`.
    pub recipient: u64,
}

/// `floor(amount × bps / 10,000)`, for `bps` up to 10,000, in 64 bits: with `amount = q ×
/// 10,000 + r`, it is `q × bps + floor(r × bps / 10,000)` exactly, where `q × bps <= amount`
/// and `r × bps < 10,000²` both fit. As in Pipeline's `fees::ceil_bps`, avoiding 128-bit
/// division keeps it provable by Kani for every input.
pub(crate) fn share(amount: u64, bps: u16) -> Option<u64> {
    if bps > BPS {
        return None;
    }
    let (denominator, bps) = (BPS as u64, bps as u64);
    let (q, r) = (amount / denominator, amount % denominator);
    q.checked_mul(bps)?
        .checked_add(r.checked_mul(bps)? / denominator)
}

impl FeeSplit {
    /// Splits `fee` lamports; the four parts always add up to `fee`.
    pub fn of(fee: u64, wall_split_bps: u16) -> Option<FeeSplit> {
        let designer = share(fee, DESIGNER_SHARE_BPS)?;
        let suite = share(fee, SUITE_SHARE_BPS)?;
        let rest = fee.checked_sub(designer)?.checked_sub(suite)?;
        let wall = share(rest, wall_split_bps)?;
        let recipient = rest.checked_sub(wall)?;
        Some(FeeSplit {
            designer,
            suite,
            wall,
            recipient,
        })
    }
}

/// The ledgers a swap changes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Books {
    pub pool_tokens: u64,
    pub pool_sol: u64,
    pub idle_sol: u64,
    pub fees_recipient: u64,
    pub fees_designer: u64,
    pub fees_suite: u64,
}

impl Books {
    /// The books after `priced`, with its fee split by `wall_split_bps`: a sell adds its
    /// input to `pool_tokens` and takes what it freed (the trader's output and the fee) from
    /// `pool_sol`; a buy adds its input less the fee to `pool_sol` and takes its output from
    /// `pool_tokens`. `None` if a ledger would overflow or go below zero.
    pub fn after(self, priced: &Priced, wall_split_bps: u16) -> Option<Books> {
        self.after_split(priced, FeeSplit::of(priced.fee, wall_split_bps)?)
    }

    /// The books after `priced`, with its fee already split as `split` (`FeeSplit::of`):
    /// `after` without the split's divisions, so Kani proves it for every input in the
    /// default tier. `None` if a ledger would overflow or go below zero.
    pub fn after_split(self, priced: &Priced, split: FeeSplit) -> Option<Books> {
        let (pool_tokens, pool_sol) = match priced.side {
            Side::Sell => {
                let gross = priced.amount_out.checked_add(priced.fee)?;
                (
                    self.pool_tokens.checked_add(priced.amount_in)?,
                    self.pool_sol.checked_sub(gross)?,
                )
            }
            Side::Buy => {
                let to_curve = priced.amount_in.checked_sub(priced.fee)?;
                (
                    self.pool_tokens.checked_sub(priced.amount_out)?,
                    self.pool_sol.checked_add(to_curve)?,
                )
            }
        };
        Some(Books {
            pool_tokens,
            pool_sol,
            idle_sol: self.idle_sol.checked_add(split.wall)?,
            fees_recipient: self.fees_recipient.checked_add(split.recipient)?,
            fees_designer: self.fees_designer.checked_add(split.designer)?,
            fees_suite: self.fees_suite.checked_add(split.suite)?,
        })
    }
}

/// The counters a swap changes (the spec's "Counters").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    /// By mint index: 0 the token, 1 wrapped SOL.
    pub volume: [u128; 2],
    pub fees_collected: u128,
    pub swap_count: u64,
}

impl Counters {
    /// The counters after `priced`: the credited input on the input mint, the trader's
    /// output on the output mint, the fee and one more swap.
    pub fn after(self, priced: &Priced) -> Option<Counters> {
        let (input, output) = match priced.side {
            Side::Sell => (0, 1),
            Side::Buy => (1, 0),
        };
        let mut volume = self.volume;
        let input_volume = volume.get_mut(input)?;
        *input_volume = input_volume.checked_add(priced.amount_in as u128)?;
        let output_volume = volume.get_mut(output)?;
        *output_volume = output_volume.checked_add(priced.amount_out as u128)?;
        Some(Counters {
            volume,
            fees_collected: self.fees_collected.checked_add(priced.fee as u128)?,
            swap_count: self.swap_count.checked_add(1)?,
        })
    }
}

/// `Books::after` as it was written before it was split into `FeeSplit::of` and
/// `Books::after_split` (2026-11-16), kept for the proof and the test that the split changed
/// nothing.
#[cfg(any(test, kani_full))]
fn after_as_before_the_split(books: Books, priced: &Priced, wall_split_bps: u16) -> Option<Books> {
    let split = FeeSplit::of(priced.fee, wall_split_bps)?;
    let (pool_tokens, pool_sol) = match priced.side {
        Side::Sell => {
            let gross = priced.amount_out.checked_add(priced.fee)?;
            (
                books.pool_tokens.checked_add(priced.amount_in)?,
                books.pool_sol.checked_sub(gross)?,
            )
        }
        Side::Buy => {
            let to_curve = priced.amount_in.checked_sub(priced.fee)?;
            (
                books.pool_tokens.checked_sub(priced.amount_out)?,
                books.pool_sol.checked_add(to_curve)?,
            )
        }
    };
    Some(Books {
        pool_tokens,
        pool_sol,
        idle_sol: books.idle_sol.checked_add(split.wall)?,
        fees_recipient: books.fees_recipient.checked_add(split.recipient)?,
        fees_designer: books.fees_designer.checked_add(split.designer)?,
        fees_suite: books.fees_suite.checked_add(split.suite)?,
    })
}

// Kani proofs of the books, in the tiers Pipeline uses (see `opening.rs`): as for Pipeline's
// own `ceil_bps`, the default tier bounds the fee below 2^12: over every 64-bit fee the
// split's divisions kept CBMC busy for over 9 minutes on the owner's Mac (2026-11-12).
// The full tier drops the bound. Z3 proves the split for every fee (`proofs/pricing_z3.py`).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the default tier, for fees.
    const SMALL: u64 = 1 << 12;

    /// For fees below `SMALL` and every wall split a market may choose, the split never
    /// fails, its four parts add up to the fee, and neither share exceeds its basis points.
    #[kani::proof]
    fn the_split_adds_up_bounded() {
        let fee: u64 = kani::any();
        kani::assume(fee < SMALL);
        split_adds_up(fee);
    }

    /// The same for every fee.
    #[cfg(kani_full)]
    #[kani::proof]
    fn the_split_adds_up_for_every_fee() {
        split_adds_up(kani::any());
    }

    fn split_adds_up(fee: u64) {
        let wall_split_bps: u16 = kani::any();
        kani::assume(wall_split_bps <= BPS);
        let split = FeeSplit::of(fee, wall_split_bps).unwrap();
        let total = split.designer as u128
            + split.suite as u128
            + split.wall as u128
            + split.recipient as u128;
        assert_eq!(total, fee as u128);
        assert!(split.designer as u128 * 10_000 <= fee as u128 * DESIGNER_SHARE_BPS as u128);
        assert!(split.suite as u128 * 10_000 <= fee as u128 * SUITE_SHARE_BPS as u128);
    }

    /// A swap's book update moves value between ledgers without creating or losing any,
    /// or refuses: the token ledger changes by exactly the trade's token flow and the SOL
    /// ledgers together by exactly its SOL flow. In the full tier only: even bounded to
    /// ledgers below 2^20 it ran over 10 minutes on the owner's Mac (2026-11-12), the split
    /// inside it being proved in the default tier above; Proptest checks the same on 10,000
    /// cases (below), and the invariant fuzzer after every swap through the router.
    #[cfg(kani_full)]
    #[kani::proof]
    fn a_swap_conserves_the_ledgers() {
        let books = Books {
            pool_tokens: kani::any(),
            pool_sol: kani::any(),
            idle_sol: kani::any(),
            fees_recipient: kani::any(),
            fees_designer: kani::any(),
            fees_suite: kani::any(),
        };
        let priced = Priced {
            side: if kani::any() { Side::Sell } else { Side::Buy },
            amount_in: kani::any(),
            fee: kani::any(),
            amount_out: kani::any(),
            sqrt_price: 0,
        };

        let wall_split_bps: u16 = kani::any();
        kani::assume(wall_split_bps <= BPS);
        if let Some(after) = books.after(&priced, wall_split_bps) {
            let sol = |b: &Books| {
                b.pool_sol as i128
                    + b.idle_sol as i128
                    + b.fees_recipient as i128
                    + b.fees_designer as i128
                    + b.fees_suite as i128
            };
            let (tokens_in, sol_in) = match priced.side {
                Side::Sell => (priced.amount_in as i128, -(priced.amount_out as i128)),
                Side::Buy => (-(priced.amount_out as i128), priced.amount_in as i128),
            };
            assert_eq!(
                after.pool_tokens as i128 - books.pool_tokens as i128,
                tokens_in
            );
            assert_eq!(sol(&after) - sol(&books), sol_in);
        }
    }

    fn any_books() -> Books {
        Books {
            pool_tokens: kani::any(),
            pool_sol: kani::any(),
            idle_sol: kani::any(),
            fees_recipient: kani::any(),
            fees_designer: kani::any(),
            fees_suite: kani::any(),
        }
    }

    fn any_priced() -> Priced {
        Priced {
            side: if kani::any() { Side::Sell } else { Side::Buy },
            amount_in: kani::any(),
            fee: kani::any(),
            amount_out: kani::any(),
            sqrt_price: kani::any(),
        }
    }

    /// A swap's book update, given its fee split, for every input (INV-FB-4, INV-FB-5): for
    /// every six ledgers, every trade and every split of its fee that adds up to the fee, it
    /// either refuses or books each share in its own ledger: `pool_tokens` changes by
    /// exactly the trade's token flow, `pool_sol` by `-(out + fee)` on a sell and `in - fee`
    /// on a buy, and each fee ledger and `idle_sol` grow by exactly their share, so none
    /// falls on a swap. A sum alone could not tell the designer's share booked to the
    /// recipient. Conservation follows: the five SOL ledgers change by the `pool_sol` change
    /// plus the four shares, which add up to the fee, so by `-out` on a sell and `in` on a
    /// buy. Stated as that one sum, CBMC must reassociate ten 64-bit additions and ran past
    /// 7 minutes (2026-11-16); the full tier's `a_swap_conserves_the_ledgers` checks the sum
    /// end to end. With the split's divisions left to `FeeSplit::of` (proved above and by Z3
    /// for every fee), only additions and subtractions remain: verified in 5 seconds on the
    /// owner's Mac (2026-11-16).
    #[kani::proof]
    fn a_swap_books_each_share_in_its_own_ledger() {
        let books = any_books();
        let priced = any_priced();
        let split = FeeSplit {
            designer: kani::any(),
            suite: kani::any(),
            wall: kani::any(),
            recipient: kani::any(),
        };
        let total = split.designer as u128
            + split.suite as u128
            + split.wall as u128
            + split.recipient as u128;
        kani::assume(total == priced.fee as u128);
        if let Some(after) = books.after_split(&priced, split) {
            let (fee, amount_in, amount_out) = (
                priced.fee as i128,
                priced.amount_in as i128,
                priced.amount_out as i128,
            );
            let change = |a: u64, b: u64| a as i128 - b as i128;
            let (tokens_in, pool_sol_in) = match priced.side {
                Side::Sell => (amount_in, -(amount_out + fee)),
                Side::Buy => (-amount_out, amount_in - fee),
            };
            assert_eq!(change(after.pool_tokens, books.pool_tokens), tokens_in);
            assert_eq!(change(after.pool_sol, books.pool_sol), pool_sol_in);
            assert_eq!(
                after.idle_sol as u128,
                books.idle_sol as u128 + split.wall as u128
            );
            assert_eq!(
                after.fees_recipient as u128,
                books.fees_recipient as u128 + split.recipient as u128
            );
            assert_eq!(
                after.fees_designer as u128,
                books.fees_designer as u128 + split.designer as u128
            );
            assert_eq!(
                after.fees_suite as u128,
                books.fees_suite as u128 + split.suite as u128
            );
        }
    }

    /// `Books::after` is `FeeSplit::of` and then `Books::after_split`, exactly as it was
    /// before the two were split apart: it agrees with the unsplit body
    /// (`after_as_before_the_split`) for every six ledgers and every trade, with the fee
    /// below `SMALL` as the split's own harness is bounded. In the full tier: with the split's
    /// divisions on both sides it ran past a 10-minute limit on the owner's Mac (2026-11-16);
    /// the Proptest `after_is_the_split_then_after_split` (below) checks the same on 10,000
    /// cases in the default `cargo test`.
    #[cfg(kani_full)]
    #[kani::proof]
    fn after_is_the_split_then_after_split_bounded() {
        let books = any_books();
        let priced = any_priced();
        kani::assume(priced.fee < SMALL);
        let wall_split_bps: u16 = kani::any();
        assert_eq!(
            books.after(&priced, wall_split_bps),
            super::after_as_before_the_split(books, &priced, wall_split_bps)
        );
    }

    /// `Counters::after` adds exactly the trade to the right mint and nothing else, for
    /// every starting counter (INV-FB-7): the credited input on the input mint (0 for a sell,
    /// 1 for a buy), the trader's output on the other, the fee and one swap; and it refuses
    /// exactly when one of those additions would overflow. Additions only: verified in 3
    /// seconds on the owner's Mac (2026-11-16).
    #[kani::proof]
    fn the_counters_add_exactly_the_trade_to_the_right_mint() {
        let counters = Counters {
            volume: [kani::any(), kani::any()],
            fees_collected: kani::any(),
            swap_count: kani::any(),
        };
        let priced = any_priced();
        let (input, output) = match priced.side {
            Side::Sell => (0, 1),
            Side::Buy => (1, 0),
        };
        let input_volume = counters.volume[input].checked_add(priced.amount_in as u128);
        let output_volume = counters.volume[output].checked_add(priced.amount_out as u128);
        let fees = counters.fees_collected.checked_add(priced.fee as u128);
        let swaps = counters.swap_count.checked_add(1);
        match counters.after(&priced) {
            Some(after) => {
                assert_eq!(Some(after.volume[input]), input_volume);
                assert_eq!(Some(after.volume[output]), output_volume);
                assert_eq!(Some(after.fees_collected), fees);
                assert_eq!(Some(after.swap_count), swaps);
            }
            None => assert!(
                input_volume.is_none()
                    || output_volume.is_none()
                    || fees.is_none()
                    || swaps.is_none()
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{MAX_FEE_BPS, MIN_FEE_BPS};
    use proptest::prelude::*;

    #[test]
    fn the_worked_examples_fees_split_at_the_spec_numbers() {
        // The buy of 1 SOL: fee 10,000,000 at a wall split of 5,000.
        assert_eq!(
            FeeSplit::of(10_000_000, 5_000),
            Some(FeeSplit {
                designer: 1_000_000,
                suite: 1_000_000,
                wall: 4_000_000,
                recipient: 4_000_000,
            })
        );
        // The sell back: fee 9,900,000, 3,960,000 of it to the wall.
        let sell = FeeSplit::of(9_900_000, 5_000).unwrap();
        assert_eq!(sell.wall, 3_960_000);
        assert_eq!(
            sell.designer + sell.suite + sell.wall + sell.recipient,
            9_900_000
        );
    }

    #[test]
    fn a_wall_split_of_none_or_all_sends_the_whole_market_part_one_way() {
        let none = FeeSplit::of(1_000_003, 0).unwrap();
        assert_eq!(none.wall, 0);
        assert_eq!(none.recipient, 1_000_003 - none.designer - none.suite);
        let all = FeeSplit::of(1_000_003, 10_000).unwrap();
        assert_eq!(all.recipient, 0);
        assert_eq!(all.wall, 1_000_003 - all.designer - all.suite);
        assert_eq!(FeeSplit::of(1, 10_001), None);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// The four parts always add up to the fee, each share rounds down, and the
        /// designer and suite shares are exactly their basis points of the fee.
        #[test]
        fn the_split_adds_up(fee in any::<u64>(), wall_split_bps in 0..=BPS) {
            let split = FeeSplit::of(fee, wall_split_bps).unwrap();
            let total = split.designer as u128 + split.suite as u128 + split.wall as u128
                + split.recipient as u128;
            prop_assert_eq!(total, fee as u128);
            prop_assert_eq!(split.designer as u128, fee as u128 * DESIGNER_SHARE_BPS as u128 / 10_000);
            prop_assert_eq!(split.suite as u128, fee as u128 * SUITE_SHARE_BPS as u128 / 10_000);
            let rest = fee as u128 - split.designer as u128 - split.suite as u128;
            prop_assert_eq!(split.wall as u128, rest * wall_split_bps as u128 / 10_000);
        }

        /// A swap moves value between ledgers without creating or losing any: the token
        /// ledgers change by exactly the trade's token flow and the SOL ledgers by its SOL
        /// flow, the fee staying in the SOL vault.
        #[test]
        fn a_swap_conserves_the_ledgers(
            sell in any::<bool>(),
            amount_in in 1u64..1 << 40,
            amount_out in 1u64..1 << 40,
            fee_bps in MIN_FEE_BPS..=MAX_FEE_BPS,
            wall_split_bps in 0..=BPS,
        ) {
            let fee = pipeline_strategy_interface::fees::ceil_bps(
                if sell { amount_out } else { amount_in },
                fee_bps as u64,
            ).unwrap();
            prop_assume!(sell || fee < amount_in);
            let priced = Priced {
                side: if sell { Side::Sell } else { Side::Buy },
                amount_in,
                fee,
                amount_out,
                sqrt_price: 1 << 64,
            };
            let books = Books { pool_tokens: 1 << 50, pool_sol: 1 << 50, ..Books::default() };
            let after = books.after(&priced, wall_split_bps).unwrap();
            let tokens = |b: &Books| b.pool_tokens as i128;
            let sol = |b: &Books| (b.pool_sol + b.idle_sol + b.fees_recipient + b.fees_designer
                + b.fees_suite) as i128;
            let (token_in, sol_in) = if sell {
                (amount_in as i128, -(amount_out as i128))
            } else {
                (-(amount_out as i128), amount_in as i128)
            };
            prop_assert_eq!(tokens(&after) - tokens(&books), token_in);
            prop_assert_eq!(sol(&after) - sol(&books), sol_in);
            let counters = Counters::default().after(&priced).unwrap();
            prop_assert_eq!(counters.fees_collected, fee as u128);
            prop_assert_eq!(counters.swap_count, 1);
            let (i, o) = if sell { (0, 1) } else { (1, 0) };
            prop_assert_eq!((counters.volume[i], counters.volume[o]), (amount_in as u128, amount_out as u128));
        }

        /// Splitting `Books::after` into `FeeSplit::of` and `Books::after_split` changed
        /// nothing: it agrees with the unsplit body for any ledgers (near zero and near
        /// u64::MAX too, where a refusal shows), any trade and any wall split, valid or not.
        #[test]
        fn after_is_the_split_then_after_split(
            ledgers in prop::array::uniform6(ledger()),
            sell in any::<bool>(),
            amounts in prop::array::uniform3(ledger()),
            wall_split_bps in prop_oneof![0..=BPS, any::<u16>()],
        ) {
            let books = Books {
                pool_tokens: ledgers[0],
                pool_sol: ledgers[1],
                idle_sol: ledgers[2],
                fees_recipient: ledgers[3],
                fees_designer: ledgers[4],
                fees_suite: ledgers[5],
            };
            let priced = Priced {
                side: if sell { Side::Sell } else { Side::Buy },
                amount_in: amounts[0],
                fee: amounts[1],
                amount_out: amounts[2],
                sqrt_price: 1 << 64,
            };
            prop_assert_eq!(
                books.after(&priced, wall_split_bps),
                after_as_before_the_split(books, &priced, wall_split_bps)
            );
        }
    }

    /// A ledger or an amount: small, near u64::MAX, or anything.
    fn ledger() -> impl Strategy<Value = u64> {
        prop_oneof![0u64..1 << 20, u64::MAX - (1 << 20)..=u64::MAX, any::<u64>()]
    }
}
