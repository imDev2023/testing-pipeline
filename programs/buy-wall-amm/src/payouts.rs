//! What a market owes leaving it, in pure functions that take no accounts
//! (docs/spec/pool4-for-solana.md, "`settle`", "`pay_rewards`", "`sweep_fees { slot }`",
//! "Recipients"), so the proofs and the invariant fuzzer check the instructions against them.
//!
//! None of these touch the price, the curve, the wall, the cap, the guard or the counters:
//! they move value only out of a ledger, to the burn or to a recipient.

use anchor_lang::prelude::Pubkey;

use crate::books::share;
use crate::config::{DESIGNER_RECIPIENT, SUITE_TREASURY};

/// What one `settle` does with the retired tokens.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Settlement {
    /// `floor(rewardable × reward_share_bps / 10,000)`, joining `rewards_owed`.
    pub to_rewards: u64,
    /// The rest of the retired tokens, burned from the token vault.
    pub burned: u64,
}

/// Splits `retired` token units, of which `rewardable` were matched by the cap's fall and
/// earn the reward share (`POOL4-49`): the reward share of `rewardable` joins
/// `rewards_owed` and the rest of `retired` is burned, so the two always add up to
/// `retired`. `None` for a reward share above 10,000 basis points, which creation refuses,
/// or a rewardable part above the retired tokens, which no market reaches.
pub fn settle(retired: u64, rewardable: u64, reward_share_bps: u16) -> Option<Settlement> {
    if rewardable > retired {
        return None;
    }
    let to_rewards = share(rewardable, reward_share_bps)?;
    Some(Settlement {
        to_rewards,
        burned: retired.checked_sub(to_rewards)?,
    })
}

/// The ledgers `settle`, `pay_rewards` and `sweep_fees` read and write, with the lifetime
/// totals they keep.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Owed {
    pub retired_tokens: u64,
    /// The part of `retired_tokens` that earns the reward share (`POOL4-49`).
    pub retired_rewardable: u64,
    pub rewards_owed: u64,
    pub fees_recipient: u64,
    pub fees_designer: u64,
    pub fees_suite: u64,
    /// Lifetime total of the token units burned.
    pub tokens_burned: u128,
    /// Lifetime total of the token units paid to rewards recipients.
    pub rewards_paid: u128,
}

/// Why a payout is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `settle` with no retired tokens.
    NothingToSettle,
    /// `pay_rewards` or `sweep_fees` with nothing owed.
    NothingOwed,
    /// The role or fee slot has no wallet: a market created with no recipient, or slot 1
    /// while `DESIGNER_RECIPIENT` is unset.
    RecipientUnset,
    /// A fee slot other than 0, 1 or 2.
    BadSlot,
    /// An overflow, which the ledgers' bounds rule out.
    Overflow,
}

impl From<Refusal> for crate::errors::StrategyError {
    fn from(refusal: Refusal) -> Self {
        use crate::errors::StrategyError;
        match refusal {
            Refusal::NothingToSettle => StrategyError::NothingToSettle,
            Refusal::NothingOwed => StrategyError::NothingOwed,
            Refusal::RecipientUnset => StrategyError::RecipientUnset,
            Refusal::BadSlot => StrategyError::BadFeeSlot,
            Refusal::Overflow => StrategyError::Overflow,
        }
    }
}

impl Owed {
    /// `settle`: the whole of `retired_tokens` split, the reward share of its rewardable part
    /// into `rewards_owed` and the rest burned, emptying both. Returns the ledgers after and
    /// the split.
    pub fn settle(self, reward_share_bps: u16) -> Result<(Owed, Settlement), Refusal> {
        if self.retired_tokens == 0 {
            return Err(Refusal::NothingToSettle);
        }
        let split = settle(
            self.retired_tokens,
            self.retired_rewardable,
            reward_share_bps,
        )
        .ok_or(Refusal::Overflow)?;
        let after = Owed {
            retired_tokens: 0,
            retired_rewardable: 0,
            rewards_owed: self
                .rewards_owed
                .checked_add(split.to_rewards)
                .ok_or(Refusal::Overflow)?,
            tokens_burned: self
                .tokens_burned
                .checked_add(split.burned as u128)
                .ok_or(Refusal::Overflow)?,
            ..self
        };
        Ok((after, split))
    }

    /// `pay_rewards` to `recipient`: all of `rewards_owed`. Returns the ledgers after and the
    /// amount paid.
    pub fn pay_rewards(self, recipient: &Pubkey) -> Result<(Owed, u64), Refusal> {
        if *recipient == Pubkey::default() {
            return Err(Refusal::RecipientUnset);
        }
        let amount = self.rewards_owed;
        if amount == 0 {
            return Err(Refusal::NothingOwed);
        }
        let after = Owed {
            rewards_owed: 0,
            rewards_paid: self
                .rewards_paid
                .checked_add(amount as u128)
                .ok_or(Refusal::Overflow)?,
            ..self
        };
        Ok((after, amount))
    }

    /// `sweep_fees { slot }`: the slot's whole ledger, to the slot's wallet (`slot_wallet`).
    /// Returns the ledgers after, the wallet and the amount paid.
    pub fn sweep(self, slot: u8, fee_recipient: &Pubkey) -> Result<(Owed, Pubkey, u64), Refusal> {
        let wallet = slot_wallet(slot, fee_recipient)?;
        let mut after = self;
        let ledger = match slot {
            0 => &mut after.fees_recipient,
            1 => &mut after.fees_designer,
            2 => &mut after.fees_suite,
            _ => return Err(Refusal::BadSlot),
        };
        let amount = core::mem::take(ledger);
        if amount == 0 {
            return Err(Refusal::NothingOwed);
        }
        Ok((after, wallet, amount))
    }
}

/// The wallet fee slot `slot` is paid to: 0 the market's fee recipient, 1
/// `DESIGNER_RECIPIENT`, 2 `SUITE_TREASURY`; refused for any other slot and for a slot whose
/// wallet is unset.
pub fn slot_wallet(slot: u8, fee_recipient: &Pubkey) -> Result<Pubkey, Refusal> {
    let wallet = match slot {
        0 => *fee_recipient,
        1 => DESIGNER_RECIPIENT,
        2 => SUITE_TREASURY,
        _ => return Err(Refusal::BadSlot),
    };
    if wallet == Pubkey::default() {
        return Err(Refusal::RecipientUnset);
    }
    Ok(wallet)
}

/// Whether `signer` may hand a role held by `current` to `new`: only the current holder may,
/// a role nobody holds (the default key) never gets one, and nobody may hand it to the
/// default key.
pub fn handover(current: &Pubkey, signer: &Pubkey, new: &Pubkey) -> Result<(), HandoverRefusal> {
    if *current == Pubkey::default() {
        return Err(HandoverRefusal::RecipientUnset);
    }
    if signer != current {
        return Err(HandoverRefusal::NotRecipient);
    }
    if *new == Pubkey::default() {
        return Err(HandoverRefusal::NewRecipientRequired);
    }
    Ok(())
}

/// Why a handover is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandoverRefusal {
    RecipientUnset,
    NotRecipient,
    NewRecipientRequired,
}

impl From<HandoverRefusal> for crate::errors::StrategyError {
    fn from(refusal: HandoverRefusal) -> Self {
        use crate::errors::StrategyError;
        match refusal {
            HandoverRefusal::RecipientUnset => StrategyError::RecipientUnset,
            HandoverRefusal::NotRecipient => StrategyError::NotRecipient,
            HandoverRefusal::NewRecipientRequired => StrategyError::NewRecipientRequired,
        }
    }
}

// Kani proofs of the settlement split, in the tiers Pipeline uses (see `opening.rs`): it
// needs no division loop, so like the fee split (`books.rs`) and the tip (`wall.rs`) it is
// bounded in the default tier and unbounded in the full tier. Z3 proves the same for every
// input (`proofs/payouts_z3.py`), Proptest checks it on 10,000 cases (below), and the
// invariant fuzzer states it independently after every `settle` through the router.
#[cfg(kani)]
mod proofs {
    use super::*;
    use crate::config::MAX_REWARD_SHARE_BPS;

    /// Bound of the bounded settlement harness, for the retired tokens, as Pipeline bounds
    /// its own `ceil_bps`: below 2^12 CBMC ran over 13 minutes without finishing, and below
    /// 2^10 it verified the harness in 764 seconds, beside a test run, on the owner's Mac
    /// (2026-11-16).
    #[cfg(kani_full)]
    const SMALL: u64 = 1 << 10;

    /// The split for every reward share a market may choose, below `SMALL` retired and any
    /// rewardable part of them, where every product fits in 64 bits: nothing is created or
    /// lost, the reward share is exactly `floor(rewardable × bps / 10,000)` (stated without
    /// a division, which CBMC handles slowly: `to_rewards × 10,000 <= rewardable × bps <
    /// (to_rewards + 1) × 10,000`), and anything retired burns something, since a market's
    /// reward share never takes it all. In the
    /// full tier (INV-FB-12): at 764 seconds it took most of CI's Kani budget to prove for
    /// `retired < 2^10` what `proofs/payouts_z3.py` proves for every input; the unit test
    /// `the_settlement_split_for_every_remainder` (below) keeps a fast check of the compiled
    /// split in its place, over every remainder modulo 10,000, the only place it rounds.
    #[cfg(kani_full)]
    #[kani::proof]
    fn the_settlement_split_adds_up_and_always_burns_bounded() {
        let (retired, rewardable, bps): (u64, u64, u16) = (kani::any(), kani::any(), kani::any());
        kani::assume(retired < SMALL && rewardable <= retired && bps <= MAX_REWARD_SHARE_BPS);
        let split = settle(retired, rewardable, bps).unwrap();
        assert!(split.to_rewards + split.burned == retired);
        let product = rewardable * bps as u64;
        assert!(split.to_rewards * 10_000 <= product && product < (split.to_rewards + 1) * 10_000);
        assert!(retired == 0 || split.burned > 0);
    }

    /// The same for every u64 retired and rewardable part of it.
    #[cfg(kani_full)]
    #[kani::proof]
    fn the_settlement_split_adds_up_and_always_burns() {
        let (retired, rewardable, bps): (u64, u64, u16) = (kani::any(), kani::any(), kani::any());
        kani::assume(rewardable <= retired && bps <= MAX_REWARD_SHARE_BPS);
        let split = settle(retired, rewardable, bps).unwrap();
        assert!(split.to_rewards as u128 + split.burned as u128 == retired as u128);
        let (product, floor) = (
            rewardable as u128 * bps as u128,
            split.to_rewards as u128 * 10_000,
        );
        assert!(floor <= product && product < floor + 10_000);
        assert!(retired == 0 || split.burned > 0);
    }

    fn any_owed() -> Owed {
        Owed {
            retired_tokens: kani::any(),
            retired_rewardable: kani::any(),
            rewards_owed: kani::any(),
            fees_recipient: kani::any(),
            fees_designer: kani::any(),
            fees_suite: kani::any(),
            tokens_burned: kani::any(),
            rewards_paid: kani::any(),
        }
    }

    /// Any key, the default key among them.
    fn any_key() -> Pubkey {
        Pubkey::new_from_array(kani::any())
    }

    /// `pay_rewards` moves exactly one ledger and touches nothing else, for every ledger and
    /// lifetime total (INV-FB-10): on success the ledgers after are the ledgers before with
    /// `rewards_owed` emptied into `rewards_paid`, and the amount is everything owed; it
    /// refuses in the spec's order, an unset recipient first, then nothing owed, and
    /// overflows only past a u128 of lifetime rewards. No division: verified in 3 seconds on
    /// the owner's Mac (2026-11-16).
    #[kani::proof]
    fn paying_rewards_empties_its_own_ledger_and_nothing_else() {
        let before = any_owed();
        let recipient = any_key();
        match before.pay_rewards(&recipient) {
            Ok((after, amount)) => {
                assert!(recipient != Pubkey::default());
                assert!(amount == before.rewards_owed && amount > 0);
                let expected = Owed {
                    rewards_owed: 0,
                    rewards_paid: before.rewards_paid + amount as u128,
                    ..before
                };
                assert_eq!(after, expected);
            }
            Err(Refusal::RecipientUnset) => assert!(recipient == Pubkey::default()),
            Err(Refusal::NothingOwed) => {
                assert!(recipient != Pubkey::default() && before.rewards_owed == 0)
            }
            Err(Refusal::Overflow) => assert!(
                recipient != Pubkey::default()
                    && before.rewards_owed > 0
                    && before
                        .rewards_paid
                        .checked_add(before.rewards_owed as u128)
                        .is_none()
            ),
            Err(_) => panic!("pay_rewards refuses only as above"),
        }
    }

    /// `sweep` moves exactly one ledger and touches nothing else, for every ledger, lifetime
    /// total, slot and recipient (INV-FB-10): on success the ledgers after are the ledgers
    /// before with the slot's own fee ledger emptied, the amount is all of it and the wallet
    /// is the slot's; it refuses a slot past 2 or a slot with no wallet as `slot_wallet`
    /// does, then an empty ledger, and never overflows. No division: verified in 6 seconds
    /// on the owner's Mac (2026-11-16).
    #[kani::proof]
    fn a_sweep_empties_its_own_ledger_and_nothing_else() {
        let before = any_owed();
        let (slot, recipient): (u8, Pubkey) = (kani::any(), any_key());
        // The slot's ledger, stated independently of `sweep`'s own match.
        let own = match slot {
            0 => Some(before.fees_recipient),
            1 => Some(before.fees_designer),
            2 => Some(before.fees_suite),
            _ => None,
        };
        match before.sweep(slot, &recipient) {
            Ok((after, wallet, amount)) => {
                assert_eq!(Ok(wallet), slot_wallet(slot, &recipient));
                assert!(wallet != Pubkey::default());
                assert!(Some(amount) == own && amount > 0);
                let expected = match slot {
                    0 => Owed {
                        fees_recipient: 0,
                        ..before
                    },
                    1 => Owed {
                        fees_designer: 0,
                        ..before
                    },
                    _ => Owed {
                        fees_suite: 0,
                        ..before
                    },
                };
                assert_eq!(after, expected);
            }
            Err(Refusal::NothingOwed) => {
                assert!(slot_wallet(slot, &recipient).is_ok() && own == Some(0))
            }
            Err(refusal) => {
                assert!(refusal == Refusal::BadSlot || refusal == Refusal::RecipientUnset);
                assert_eq!(slot_wallet(slot, &recipient), Err(refusal));
                assert_eq!(refusal == Refusal::BadSlot, own.is_none());
            }
        }
    }

    /// `settle` empties `retired_tokens` and `retired_rewardable` and leaves every other
    /// ledger alone, for every ledger, lifetime total and reward share a market may choose
    /// (INV-FB-11): on success the ledgers after are the ledgers before with both emptied,
    /// the split's reward share added to `rewards_owed` and its burn to `tokens_burned`, and
    /// the split adds up to what was retired, so the token ledgers fall by exactly the burn;
    /// it refuses as `NothingToSettle` exactly when nothing is retired, and otherwise only
    /// for a rewardable part above the retired tokens, which no market reaches, or an
    /// overflow. That the split is the spec's is `the_settlement_split_for_every_remainder`'s
    /// and `proofs/payouts_z3.py`'s to prove. Verified in 12 seconds on the owner's Mac
    /// (2026-11-17), beside other sessions' builds.
    #[kani::proof]
    fn settling_empties_the_retired_ledger_and_nothing_else() {
        let before = any_owed();
        let bps: u16 = kani::any();
        kani::assume(bps <= MAX_REWARD_SHARE_BPS);
        match before.settle(bps) {
            Ok((after, split)) => {
                assert!(before.retired_tokens > 0);
                assert_eq!(
                    split.to_rewards as u128 + split.burned as u128,
                    before.retired_tokens as u128
                );
                assert!(before.retired_rewardable <= before.retired_tokens);
                let expected = Owed {
                    retired_tokens: 0,
                    retired_rewardable: 0,
                    rewards_owed: before.rewards_owed + split.to_rewards,
                    tokens_burned: before.tokens_burned + split.burned as u128,
                    ..before
                };
                assert_eq!(after, expected);
            }
            Err(refusal) => {
                assert_eq!(
                    refusal == Refusal::NothingToSettle,
                    before.retired_tokens == 0
                );
                assert!(refusal == Refusal::NothingToSettle || refusal == Refusal::Overflow);
                // Stated without a division, which CBMC handles slowly: the reward share is at
                // most the rewardable part and the burn at most the retired tokens, so an
                // overflow needs one of these.
                if refusal == Refusal::Overflow {
                    assert!(
                        before.retired_rewardable > before.retired_tokens
                            || before
                                .rewards_owed
                                .checked_add(before.retired_rewardable)
                                .is_none()
                            || before
                                .tokens_burned
                                .checked_add(before.retired_tokens as u128)
                                .is_none()
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MAX_REWARD_SHARE_BPS;
    use proptest::prelude::*;

    /// The worked example's `settle`: 8,333,333,340 units retired, of which the trim's
    /// 8,333,333,329 were matched by the cap's fall and the 11 of dust were not (POOL4-49).
    #[test]
    fn the_worked_examples_settlement() {
        assert_eq!(
            settle(8_333_333_340, 8_333_333_329, 1_500),
            Some(Settlement {
                to_rewards: 1_249_999_999,
                burned: 7_083_333_341
            })
        );
    }

    /// The settlement split for every remainder modulo 10,000, the only place `share`
    /// rounds (INV-FB-12, in the default tier's place of the 764-second Kani harness, now in
    /// the full tier): for a rewardable part `q × 10,000 + r` with every `r` from 0 to
    /// 9,999, at the least, the next and the greatest quotient a u64 holds, of retired tokens
    /// that are all rewardable or have 11 units more (or as many more as a u64 holds), and
    /// at the reward shares at and around every edge, the reward share is exactly
    /// `floor(rewardable × bps / 10,000)`, the split adds up, and anything retired burns
    /// something at every share a market may choose. `proofs/payouts_z3.py` proves the same
    /// for every input.
    #[test]
    fn the_settlement_split_for_every_remainder() {
        let shares = [
            0,
            1,
            1_000,
            1_500,
            2_999,
            MAX_REWARD_SHARE_BPS,
            5_000,
            9_999,
            10_000,
        ];
        for q in [0, 1, u64::MAX / 10_000] {
            for r in 0..10_000u64 {
                let Some(rewardable) = q.checked_mul(10_000).and_then(|v| v.checked_add(r)) else {
                    continue;
                };
                for retired in [rewardable, rewardable.saturating_add(11)] {
                    for bps in shares {
                        let split = settle(retired, rewardable, bps).unwrap();
                        let exact = rewardable as u128 * bps as u128 / 10_000;
                        assert_eq!(split.to_rewards as u128, exact, "{rewardable} at {bps}");
                        assert_eq!(
                            split.to_rewards as u128 + split.burned as u128,
                            retired as u128
                        );
                        if bps <= MAX_REWARD_SHARE_BPS {
                            assert!(retired == 0 || split.burned > 0, "{retired} at {bps}");
                        }
                    }
                }
            }
        }
        // Nothing rewardable: everything burns.
        assert_eq!(
            settle(u64::MAX, 0, MAX_REWARD_SHARE_BPS),
            Some(Settlement {
                to_rewards: 0,
                burned: u64::MAX
            })
        );
        // Past 10,000 basis points, or with more rewardable than retired, the split is
        // refused, never wrapped.
        assert_eq!(settle(1, 1, 10_001), None);
        assert_eq!(settle(u64::MAX, u64::MAX, u16::MAX), None);
        assert_eq!(settle(1, 2, 1_500), None);
    }

    #[test]
    fn slots_and_their_wallets() {
        let recipient = Pubkey::new_unique();
        assert_eq!(slot_wallet(0, &recipient), Ok(recipient));
        assert_eq!(
            slot_wallet(0, &Pubkey::default()),
            Err(Refusal::RecipientUnset)
        );
        assert_eq!(
            slot_wallet(1, &recipient),
            if DESIGNER_RECIPIENT == Pubkey::default() {
                Err(Refusal::RecipientUnset)
            } else {
                Ok(DESIGNER_RECIPIENT)
            }
        );
        assert_eq!(slot_wallet(2, &recipient), Ok(SUITE_TREASURY));
        assert_eq!(slot_wallet(3, &recipient), Err(Refusal::BadSlot));
    }

    #[test]
    fn handovers() {
        let (current, other) = (Pubkey::new_unique(), Pubkey::new_unique());
        let none = Pubkey::default();
        assert_eq!(handover(&current, &current, &other), Ok(()));
        assert_eq!(
            handover(&current, &other, &other),
            Err(HandoverRefusal::NotRecipient)
        );
        assert_eq!(
            handover(&current, &current, &none),
            Err(HandoverRefusal::NewRecipientRequired)
        );
        assert_eq!(
            handover(&none, &none, &other),
            Err(HandoverRefusal::RecipientUnset)
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// The split adds up, is exactly the reward share of the rewardable part, and always
        /// burns something.
        #[test]
        fn the_settlement_split(
            retired in any::<u64>(), part in any::<u64>(), bps in 0..=MAX_REWARD_SHARE_BPS,
        ) {
            let rewardable = retired.checked_add(1).map_or(part, |bound| part % bound);
            let split = settle(retired, rewardable, bps).unwrap();
            prop_assert_eq!(split.to_rewards as u128 + split.burned as u128, retired as u128);
            prop_assert_eq!(split.to_rewards as u128, rewardable as u128 * bps as u128 / 10_000);
            prop_assert!(retired == 0 || split.burned > 0);
        }

        /// `settle`, `pay_rewards` and `sweep` only move value out of a ledger, each by
        /// exactly what they report, and keep the lifetime totals.
        #[test]
        fn payouts_move_exactly_what_they_report(
            retired in any::<u32>(), part in any::<u32>(), owed in any::<u32>(),
            fees in any::<[u32; 3]>(), bps in 0..=MAX_REWARD_SHARE_BPS, slot in 0..4u8,
        ) {
            let before = Owed {
                retired_tokens: retired as u64,
                retired_rewardable: (part as u64) % (retired as u64 + 1),
                rewards_owed: owed as u64,
                fees_recipient: fees[0] as u64,
                fees_designer: fees[1] as u64,
                fees_suite: fees[2] as u64,
                tokens_burned: 7,
                rewards_paid: 11,
            };
            match before.settle(bps) {
                Ok((after, split)) => {
                    prop_assert_eq!((after.retired_tokens, after.retired_rewardable), (0, 0));
                    prop_assert_eq!(
                        split.to_rewards as u128,
                        before.retired_rewardable as u128 * bps as u128 / 10_000
                    );
                    prop_assert_eq!(after.rewards_owed, before.rewards_owed + split.to_rewards);
                    prop_assert_eq!(after.tokens_burned, 7 + split.burned as u128);
                    prop_assert_eq!(split.to_rewards + split.burned, before.retired_tokens);
                }
                Err(refusal) => {
                    prop_assert_eq!(refusal, Refusal::NothingToSettle);
                    prop_assert_eq!(retired, 0);
                }
            }
            let recipient = Pubkey::new_unique();
            match before.pay_rewards(&recipient) {
                Ok((after, amount)) => {
                    prop_assert_eq!(amount, before.rewards_owed);
                    prop_assert_eq!((after.rewards_owed, after.rewards_paid), (0, 11 + amount as u128));
                }
                Err(refusal) => {
                    prop_assert_eq!(refusal, Refusal::NothingOwed);
                    prop_assert_eq!(owed, 0);
                }
            }
            prop_assert_eq!(before.pay_rewards(&Pubkey::default()), Err(Refusal::RecipientUnset));
            let ledgers = |o: &Owed| [o.fees_recipient, o.fees_designer, o.fees_suite];
            match before.sweep(slot, &recipient) {
                Ok((after, wallet, amount)) => {
                    prop_assert_eq!(Ok(wallet), slot_wallet(slot, &recipient));
                    let mut expected = ledgers(&before);
                    prop_assert_eq!(amount, expected[slot as usize]);
                    expected[slot as usize] = 0;
                    prop_assert_eq!(ledgers(&after), expected);
                    prop_assert!(amount > 0);
                }
                Err(refusal) => match slot_wallet(slot, &recipient) {
                    Err(wallet_refusal) => prop_assert_eq!(refusal, wallet_refusal),
                    Ok(_) => {
                        prop_assert_eq!(refusal, Refusal::NothingOwed);
                        prop_assert_eq!(ledgers(&before)[slot as usize], 0);
                    }
                },
            }
        }
    }
}
