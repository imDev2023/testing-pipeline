//! A market's creation parameters (docs/spec/pool4-for-solana.md, "Creation parameters"):
//! everything a creator chooses, fixed for the market's life.

use anchor_lang::prelude::*;

use crate::config::{
    MAX_CAP_DECAY_BPS, MAX_FEE_BPS, MAX_REWARD_SHARE_BPS, MIN_CAP_FLOOR_BPS, MIN_FEE_BPS,
};
use crate::errors::StrategyError;

/// All of a basis-point share: 100%.
pub const BPS: u16 = 10_000;

/// `create_market`'s `init_data`: these fields, Borsh-encoded in this order (metadata
/// `init.args` lists them the same way).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct InitParams {
    /// The market's fee, `MIN_FEE_BPS` to `MAX_FEE_BPS`.
    pub fee_bps: u16,
    /// The part of the market's share of each fee that goes to the buy wall, 0 to 10,000.
    pub wall_split_bps: u16,
    /// A wallet; the default key only when `wall_split_bps` is 10,000.
    pub fee_recipient: Pubkey,
    /// 0 to `MAX_REWARD_SHARE_BPS` of the trimmed tokens.
    pub reward_share_bps: u16,
    /// A wallet; the default key exactly when `reward_share_bps` is 0.
    pub rewards_recipient: Pubkey,
    /// `MIN_CAP_FLOOR_BPS` to 10,000 of the seeded tokens.
    pub cap_floor_bps: u16,
    /// 0 to `MAX_CAP_DECAY_BPS` of the seeded tokens a day; 0 switches the ratchet off.
    pub cap_decay_bps: u16,
    /// The only signer `seed` accepts; not the default key.
    pub seeder: Pubkey,
}

impl InitParams {
    /// Decodes `init_data`, refusing anything that is not exactly one `InitParams`.
    pub fn decode(data: &[u8]) -> core::result::Result<Self, StrategyError> {
        Self::try_from_slice(data).map_err(|_| StrategyError::BadInitData)
    }

    /// Every rule of the creation parameters table, each with its own error.
    pub fn validate(&self) -> core::result::Result<(), StrategyError> {
        let unset = Pubkey::default();
        if !(MIN_FEE_BPS..=MAX_FEE_BPS).contains(&self.fee_bps) {
            return Err(StrategyError::FeeOutOfRange);
        }
        if self.wall_split_bps > BPS {
            return Err(StrategyError::WallSplitOutOfRange);
        }
        if self.fee_recipient == unset && self.wall_split_bps != BPS {
            return Err(StrategyError::FeeRecipientRequired);
        }
        if self.reward_share_bps > MAX_REWARD_SHARE_BPS {
            return Err(StrategyError::RewardShareOutOfRange);
        }
        if (self.rewards_recipient == unset) != (self.reward_share_bps == 0) {
            return Err(StrategyError::RewardsRecipientMismatch);
        }
        if !(MIN_CAP_FLOOR_BPS..=BPS).contains(&self.cap_floor_bps) {
            return Err(StrategyError::CapFloorOutOfRange);
        }
        if self.cap_decay_bps > MAX_CAP_DECAY_BPS {
            return Err(StrategyError::CapDecayOutOfRange);
        }
        if self.seeder == unset {
            return Err(StrategyError::SeederRequired);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// The spec's "Creation parameters" table, restated rule by rule in its own order
    /// (docs/spec/pool4-for-solana.md), apart from `validate`: the error of the first rule
    /// the parameters break, or none.
    fn first_broken_rule(p: &InitParams) -> Option<StrategyError> {
        let set = |key: &Pubkey| *key != Pubkey::new_from_array([0; 32]);
        let table = [
            (
                MIN_FEE_BPS <= p.fee_bps && p.fee_bps <= MAX_FEE_BPS,
                StrategyError::FeeOutOfRange,
            ),
            (
                p.wall_split_bps <= 10_000,
                StrategyError::WallSplitOutOfRange,
            ),
            (
                set(&p.fee_recipient) || p.wall_split_bps == 10_000,
                StrategyError::FeeRecipientRequired,
            ),
            (
                p.reward_share_bps <= MAX_REWARD_SHARE_BPS,
                StrategyError::RewardShareOutOfRange,
            ),
            (
                set(&p.rewards_recipient) == (p.reward_share_bps > 0),
                StrategyError::RewardsRecipientMismatch,
            ),
            (
                MIN_CAP_FLOOR_BPS <= p.cap_floor_bps && p.cap_floor_bps <= 10_000,
                StrategyError::CapFloorOutOfRange,
            ),
            (
                p.cap_decay_bps <= MAX_CAP_DECAY_BPS,
                StrategyError::CapDecayOutOfRange,
            ),
            (set(&p.seeder), StrategyError::SeederRequired),
        ];
        table
            .into_iter()
            .find_map(|(holds, error)| (!holds).then_some(error))
    }

    /// A u16 field: anything, or at or next to one of `edges`, where a rule turns.
    fn field(edges: &'static [u16]) -> impl Strategy<Value = u16> {
        let near: Vec<u16> = edges
            .iter()
            .flat_map(|edge| [edge.saturating_sub(1), *edge, edge.saturating_add(1)])
            .collect();
        prop_oneof![any::<u16>(), prop::sample::select(near)]
    }

    /// A key, unset (the default key) or set.
    fn key() -> impl Strategy<Value = Pubkey> {
        prop_oneof![
            Just(Pubkey::default()),
            any::<[u8; 32]>().prop_map(Pubkey::new_from_array)
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// `validate` accepts exactly the parameters the spec's table allows, and refuses the
        /// rest with the first broken rule's error, in the table's order (INV-FB-13).
        #[test]
        fn validate_accepts_exactly_the_specs_table(
            fee_bps in field(&[0, MIN_FEE_BPS, MAX_FEE_BPS, u16::MAX]),
            wall_split_bps in field(&[0, 10_000, u16::MAX]),
            fee_recipient in key(),
            reward_share_bps in field(&[0, MAX_REWARD_SHARE_BPS, 10_000, u16::MAX]),
            rewards_recipient in key(),
            cap_floor_bps in field(&[0, MIN_CAP_FLOOR_BPS, 10_000, u16::MAX]),
            cap_decay_bps in field(&[0, MAX_CAP_DECAY_BPS, u16::MAX]),
            seeder in key(),
        ) {
            let params = InitParams {
                fee_bps,
                wall_split_bps,
                fee_recipient,
                reward_share_bps,
                rewards_recipient,
                cap_floor_bps,
                cap_decay_bps,
                seeder,
            };
            let expected = first_broken_rule(&params).map(u32::from);
            prop_assert_eq!(params.validate().err().map(u32::from), expected);
        }
    }
}
