//! `renounce_tax_authority`: the tax authority gives up its powers for good
//! (docs/spec/tax-amm.md, "Tax authority"). The market state's tax authority becomes the
//! default key, as on a market created without one, and its renounced flag is set, so
//! Aviary can tell the two apart; either way the taxes and recipients never change again.

use anchor_lang::prelude::*;

use crate::events::TaxAuthorityRenounced;
use crate::instructions::{Authorized, TaxAuthorityAction};

pub fn renounce(ctx: Context<TaxAuthorityAction>) -> Result<()> {
    let Authorized {
        tax_authority,
        market_state,
        market,
    } = ctx.accounts.authorize()?;
    market.tax_authority = Pubkey::default();
    market.tax_authority_renounced = true;
    emit!(TaxAuthorityRenounced {
        market_state,
        tax_authority,
    });
    Ok(())
}
