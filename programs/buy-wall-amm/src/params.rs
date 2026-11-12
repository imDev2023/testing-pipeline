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
