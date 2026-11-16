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
    /// `floor(retired × reward_share_bps / 10,000)`, joining `rewards_owed`.
    pub to_rewards: u64,
    /// The rest, burned from the token vault.
    pub burned: u64,
}

/// Splits `retired` token units: the reward share joins `rewards_owed` and the rest is
/// burned, so the two always add up to `retired`. `None` for a reward share above 10,000
/// basis points, which creation refuses.
pub fn settle(retired: u64, reward_share_bps: u16) -> Option<Settlement> {
    let to_rewards = share(retired, reward_share_bps)?;
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
    /// `settle`: the whole of `retired_tokens` split, the reward share into `rewards_owed`
    /// and the rest burned. Returns the ledgers after and the split.
    pub fn settle(self, reward_share_bps: u16) -> Result<(Owed, Settlement), Refusal> {
        if self.retired_tokens == 0 {
            return Err(Refusal::NothingToSettle);
        }
        let split = settle(self.retired_tokens, reward_share_bps).ok_or(Refusal::Overflow)?;
        let after = Owed {
            retired_tokens: 0,
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

    /// Bound of the default tier, for the retired tokens, as Pipeline bounds its own
    /// `ceil_bps`: below 2^12 CBMC ran over 13 minutes without finishing, and below 2^10 it
    /// verified the harness in 764 seconds, beside a test run, on the owner's Mac
    /// (2026-11-16).
    const SMALL: u64 = 1 << 10;

    /// The split for every reward share a market may choose, below `SMALL` retired, where
    /// every product fits in 64 bits: nothing is created or lost, the reward share is exactly
    /// `floor(retired × bps / 10,000)` (stated without a division, which CBMC handles slowly:
    /// `to_rewards × 10,000 <= retired × bps < (to_rewards + 1) × 10,000`), and anything
    /// retired burns something, since a market's reward share never takes it all.
    #[kani::proof]
    fn the_settlement_split_adds_up_and_always_burns_bounded() {
        let (retired, bps): (u64, u16) = (kani::any(), kani::any());
        kani::assume(retired < SMALL && bps <= MAX_REWARD_SHARE_BPS);
        let split = settle(retired, bps).unwrap();
        assert!(split.to_rewards + split.burned == retired);
        let product = retired * bps as u64;
        assert!(split.to_rewards * 10_000 <= product && product < (split.to_rewards + 1) * 10_000);
        assert!(retired == 0 || split.burned > 0);
    }

    /// The same for every u64 retired.
    #[cfg(kani_full)]
    #[kani::proof]
    fn the_settlement_split_adds_up_and_always_burns() {
        let (retired, bps): (u64, u16) = (kani::any(), kani::any());
        kani::assume(bps <= MAX_REWARD_SHARE_BPS);
        let split = settle(retired, bps).unwrap();
        assert!(split.to_rewards as u128 + split.burned as u128 == retired as u128);
        let (product, floor) = (
            retired as u128 * bps as u128,
            split.to_rewards as u128 * 10_000,
        );
        assert!(floor <= product && product < floor + 10_000);
        assert!(retired == 0 || split.burned > 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MAX_REWARD_SHARE_BPS;
    use proptest::prelude::*;

    #[test]
    fn the_worked_examples_settlement() {
        assert_eq!(
            settle(8_333_333_340, 1_500),
            Some(Settlement {
                to_rewards: 1_250_000_001,
                burned: 7_083_333_339
            })
        );
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

        /// The split adds up, is exactly the reward share, and always burns something.
        #[test]
        fn the_settlement_split(retired in any::<u64>(), bps in 0..=MAX_REWARD_SHARE_BPS) {
            let split = settle(retired, bps).unwrap();
            prop_assert_eq!(split.to_rewards as u128 + split.burned as u128, retired as u128);
            prop_assert_eq!(split.to_rewards as u128, retired as u128 * bps as u128 / 10_000);
            prop_assert!(retired == 0 || split.burned > 0);
        }

        /// `settle`, `pay_rewards` and `sweep` only move value out of a ledger, each by
        /// exactly what they report, and keep the lifetime totals.
        #[test]
        fn payouts_move_exactly_what_they_report(
            retired in any::<u32>(), owed in any::<u32>(), fees in any::<[u32; 3]>(),
            bps in 0..=MAX_REWARD_SHARE_BPS, slot in 0..4u8,
        ) {
            let before = Owed {
                retired_tokens: retired as u64,
                rewards_owed: owed as u64,
                fees_recipient: fees[0] as u64,
                fees_designer: fees[1] as u64,
                fees_suite: fees[2] as u64,
                tokens_burned: 7,
                rewards_paid: 11,
            };
            match before.settle(bps) {
                Ok((after, split)) => {
                    prop_assert_eq!(after.retired_tokens, 0);
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
