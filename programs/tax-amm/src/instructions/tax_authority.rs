//! The accounts of the tax authority's three actions, `set_taxes`, `set_recipients` and
//! `renounce_tax_authority` (docs/spec/tax-amm.md, "Tax authority"), each in its own
//! module. They only write the market state, and never a reserve, an owed amount or a
//! counter. Each handler starts from [`TaxAuthorityAction::authorize`], so the signer is
//! checked in one place, in one order, for every action.

use anchor_lang::prelude::*;

use crate::errors::StrategyError;
use crate::state::{TaxMarket, STATE_VERSION};

/// The order is `metadata.json`'s for each of the three actions; keep them in step.
#[derive(Accounts)]
pub struct TaxAuthorityAction<'info> {
    /// Checked against the market's tax authority by [`TaxAuthorityAction::authorize`], so a
    /// market that has none, or renounced, says so rather than naming the signer.
    pub tax_authority: Signer<'info>,
    #[account(mut, constraint = market_state.version <= STATE_VERSION @ StrategyError::NewerStateVersion)]
    pub market_state: Account<'info, TaxMarket>,
}

/// A tax authority action whose signer has been checked: the keys its event names, and the
/// market state to change.
pub struct Authorized<'a, 'info> {
    pub tax_authority: Pubkey,
    pub market_state: Pubkey,
    pub market: &'a mut Account<'info, TaxMarket>,
}

impl<'info> TaxAuthorityAction<'info> {
    /// Fails unless the signer is the market's tax authority
    /// ([`TaxMarket::authorize_tax_authority`]); otherwise hands over the market to change.
    pub fn authorize(&mut self) -> Result<Authorized<'_, 'info>> {
        let tax_authority = self.tax_authority.key();
        self.market_state.authorize_tax_authority(&tax_authority)?;
        Ok(Authorized {
            tax_authority,
            market_state: self.market_state.key(),
            market: &mut self.market_state,
        })
    }
}
