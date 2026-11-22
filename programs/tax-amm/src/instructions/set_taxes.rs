//! `set_taxes`: the tax authority moves the buy and sell tax, each inside the range fixed at
//! creation (docs/spec/tax-amm.md, "Rates", "Tax authority"). The new rates wait
//! `RATE_CHANGE_DELAY_SLOTS` slots as the market's pending rates, longer than any
//! transaction's lifetime, so a change can never reach a swap already signed (hardening
//! finding H010, #67); decreases wait too. Rates equal to those in force cancel a pending
//! change, and a second change replaces a pending one and waits again.

use anchor_lang::prelude::*;

use crate::config::RATE_CHANGE_DELAY_SLOTS;
use crate::errors::StrategyError;
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
    let slot = Clock::get()?.slot;
    market.apply_due_rates(slot);
    let from_slot = if [buy_tax_bps, sell_tax_bps] == [market.buy_tax_bps, market.sell_tax_bps] {
        market.clear_pending_rates();
        slot
    } else {
        let from_slot = slot
            .checked_add(RATE_CHANGE_DELAY_SLOTS)
            .ok_or(StrategyError::Overflow)?;
        market.pending_buy_tax_bps = buy_tax_bps;
        market.pending_sell_tax_bps = sell_tax_bps;
        market.pending_from_slot = from_slot;
        from_slot
    };
    emit!(TaxesChanged {
        market_state,
        tax_authority,
        buy_tax_bps,
        sell_tax_bps,
        from_slot,
    });
    Ok(())
}
