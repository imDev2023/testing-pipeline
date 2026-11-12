//! The creation parameters and every rule on them that needs no account
//! (docs/spec/lending-pool.md, "Creation parameters"). Every policy value that is not a
//! build-time constant (`crate::config`) is one of these, chosen per market and kept in its
//! market state.

use anchor_lang::prelude::*;

use crate::config::MAX_LP_FEE_BPS;
use crate::errors::StrategyError;

/// `create_market`'s `init_data`: these fields, Borsh-encoded in this order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitParams {
    /// Which of the two mints, 0 or 1, is lent; it must be on the cluster's `LENT_MINTS`.
    pub lent_index: u8,
    /// The LP fee in basis points, at most `MAX_LP_FEE_BPS`.
    pub lp_fee_bps: u16,
}

impl InitParams {
    /// Checks the rules on the parameters alone.
    pub fn validate(&self) -> core::result::Result<(), StrategyError> {
        if self.lent_index > 1 {
            return Err(StrategyError::BadLentIndex);
        }
        if self.lp_fee_bps > MAX_LP_FEE_BPS {
            return Err(StrategyError::LpFeeAboveCap);
        }
        Ok(())
    }
}
