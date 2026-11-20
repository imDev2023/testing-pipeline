//! `settle`: the permissionless keeper job that splits the retired tokens
//! (docs/spec/pool4-for-solana.md, "`settle`"). The reward share of their rewardable part, the
//! trimmed tokens the cap's fall matched (`POOL4-49`), joins `rewards_owed` and the rest is
//! burned from the token vault; refused when nothing is retired; no tip.
//!
//! A burn calls no transfer hook, so no hook can refuse it, and it pays nobody, so no
//! recipient's account can block it. Nobody signs but whoever pays the transaction fee.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn_checked, BurnChecked, Mint, TokenInterface};

use crate::errors::StrategyError;
use crate::events::Settled;
use crate::state::{check_vault_accounts, is_market_state, MarketState, VaultSide, AUTHORITY_SEED};

/// The order is part of `metadata.json`'s `settle` action; keep them in step.
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// CHECK: compared with the market state's token vault.
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    /// Written by the burn, which lowers its supply.
    #[account(mut, mint::token_program = token_program)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: compared with the vault authority from the stored bump.
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_settle(ctx: Context<Settle>) -> Result<()> {
    let accounts = &ctx.accounts;
    let market_state = accounts.market_state.key();
    let (owed, split, retired, rewardable, authority_bump) = {
        let state = accounts.market_state.load()?;
        let authority_bump = check_vault_accounts(
            &state,
            &market_state,
            VaultSide::Token,
            &accounts.token_vault.key(),
            &accounts.token_mint.key(),
            &accounts.vault_authority.key(),
        )?;
        let (owed, split) = state
            .owed()
            .settle(state.reward_share_bps())
            .map_err(|refusal| error!(StrategyError::from(refusal)))?;
        (
            owed,
            split,
            state.retired_tokens(),
            state.retired_rewardable(),
            authority_bump,
        )
    };

    if split.burned > 0 {
        let bump = [authority_bump];
        let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_state.as_ref(), &bump];
        burn_checked(
            CpiContext::new_with_signer(
                accounts.token_program.key(),
                BurnChecked {
                    mint: accounts.token_mint.to_account_info(),
                    from: accounts.token_vault.to_account_info(),
                    authority: accounts.vault_authority.to_account_info(),
                },
                &[authority_seeds],
            ),
            split.burned,
            accounts.token_mint.decimals,
        )?;
    }

    accounts.market_state.load_mut()?.set_owed(&owed);
    emit!(Settled {
        market_state,
        retired,
        rewardable,
        burned: split.burned,
        to_rewards: split.to_rewards,
        rewards_owed: owed.rewards_owed,
        tokens_burned: owed.tokens_burned,
    });
    Ok(())
}
