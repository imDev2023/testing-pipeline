//! `set_recipients`: the tax authority replaces the market's tax recipients, their shares
//! and the burn share, under the rules of creation (docs/spec/tax-amm.md, "Tax authority").
//! Owed amounts belong to slots ("Payout"), so what a slot is already owed stays with it and
//! goes to whoever the slot names when it is paid out. A recipient slot still owed tax
//! can't be emptied, since nobody could then be paid what it holds; the burn slot needs no
//! wallet, so the burn share may drop to 0 whatever the burn is owed.

use anchor_lang::prelude::*;

use crate::config::MAX_RECIPIENTS;
use crate::errors::StrategyError;
use crate::events::RecipientsChanged;
use crate::instructions::{Authorized, TaxAuthorityAction};
use crate::params::{check_split, used_slots};

pub fn change_recipients(
    ctx: Context<TaxAuthorityAction>,
    recipients: [Pubkey; MAX_RECIPIENTS],
    shares: [u16; MAX_RECIPIENTS],
    burn_share_bps: u16,
) -> Result<()> {
    let Authorized {
        tax_authority,
        market_state,
        market,
    } = ctx.accounts.authorize()?;
    let tax_mint = market.mints[market.tax_side as usize];
    check_split(&recipients, &shares, burn_share_bps, &tax_mint)?;
    let used = used_slots(&recipients);
    require!(
        market.owed[used..MAX_RECIPIENTS]
            .iter()
            .all(|&owed| owed == 0),
        StrategyError::OwedSlotLeftEmpty
    );
    market.recipients = recipients;
    market.shares = shares;
    market.burn_share_bps = burn_share_bps;
    emit!(RecipientsChanged {
        market_state,
        tax_authority,
        recipients,
        shares,
        burn_share_bps,
    });
    Ok(())
}
