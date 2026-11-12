//! `set_taxes`: the tax authority moves the buy and sell tax, each inside the range fixed at
//! creation (docs/spec/tax-amm.md, "Rates", "Tax authority"). Swaps read the rates when they
//! run, so the next swap pays the new ones, and a trader's minimum output protects a swap
//! quoted before the change.

use anchor_lang::prelude::*;

use crate::events::TaxesChanged;
use crate::instructions::{Authorized, TaxAuthorityAction};
use crate::params::check_rates;

pub fn change_taxes(
    ctx: Context<TaxAuthorityAction>,
    buy_tax_bps: u16,
    sell_tax_bps: u16,
) -> Result<()> {
    let Authorized {
        tax_authority,
        market_state,
        market,
    } = ctx.accounts.authorize()?;
    check_rates([buy_tax_bps, sell_tax_bps], market.tax_ranges())?;
    market.buy_tax_bps = buy_tax_bps;
    market.sell_tax_bps = sell_tax_bps;
    emit!(TaxesChanged {
        market_state,
        tax_authority,
        buy_tax_bps,
        sell_tax_bps,
    });
    Ok(())
}
