//! `set_fee_recipient { new }` and `set_rewards_recipient { new }`: a recipient hands its own
//! role to another wallet (docs/spec/pool4-for-solana.md, "Recipients").
//!
//! Signed only by the current recipient, never to the default key; what the role is owed
//! (its ledger) stays with the role and so follows it to the new wallet. A market created
//! with no recipient never gets one, nobody else can change a recipient, and nothing else
//! about a market can change.

use anchor_lang::prelude::*;

use crate::errors::StrategyError;
use crate::events::{RecipientChanged, RecipientRole};
use crate::payouts::handover;
use crate::state::{is_market_state, MarketState};

/// The order is part of `metadata.json`'s handover actions; keep them in step.
#[derive(Accounts)]
pub struct SetRecipient<'info> {
    /// The role's current recipient.
    pub recipient: Signer<'info>,
    #[account(mut, constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
}

pub fn handle_set_recipient(
    ctx: Context<SetRecipient>,
    role: RecipientRole,
    new: Pubkey,
) -> Result<()> {
    let market_state = ctx.accounts.market_state.key();
    let mut state = ctx.accounts.market_state.load_mut()?;
    let held = match role {
        RecipientRole::Fee => &mut state.fee_recipient,
        RecipientRole::Rewards => &mut state.rewards_recipient,
    };
    let old = *held;
    handover(&old, &ctx.accounts.recipient.key(), &new)
        .map_err(|refusal| error!(StrategyError::from(refusal)))?;
    *held = new;
    drop(state);
    emit!(RecipientChanged {
        market_state,
        role,
        old,
        new,
    });
    Ok(())
}
