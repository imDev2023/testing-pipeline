//! `distribute`: anyone pays out what one tax slot is owed (docs/spec/tax-amm.md,
//! "Payout").
//!
//! Tax is never paid out during a swap: it is booked as owed per slot in the tax-side
//! vault, and this pays one slot at a time, so a recipient whose token account is closed,
//! frozen or missing never holds up a swap or another slot. A tax recipient or the suite
//! share is paid its whole owed amount to the associated token account of its wallet for
//! the tax-side mint, which this creates at the caller's expense when it is missing; the
//! burn slot's owed amount is burned from the vault. Nothing else changes: not the
//! reserves, not the counters, not another slot.
//!
//! Remaining accounts are the tax-side mint's transfer-hook accounts, which the payout
//! transfer forwards.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{
    self, get_associated_token_address_with_program_id, AssociatedToken,
};
use anchor_spl::token_2022;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::errors::StrategyError;
use crate::events::Distributed;
use crate::state::{vault_authority, TaxMarket, AUTHORITY_SEED, BURN_SLOT, STATE_VERSION};
use crate::token::transfer_checked;

/// The order is `metadata.json`'s `distribute` action; keep them in step. Transfer-hook
/// accounts follow.
#[derive(Accounts)]
pub struct Distribute<'info> {
    /// Anyone; pays for the slot wallet's token account when it is missing.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, constraint = market_state.version <= STATE_VERSION @ StrategyError::NewerStateVersion)]
    pub market_state: Account<'info, TaxMarket>,
    /// CHECK: compared with the PDA from the market state's stored bump by the handler.
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: the market's vault for its tax-side mint.
    #[account(
        mut,
        address = market_state.vaults[market_state.tax_side as usize] @ StrategyError::WrongAccount,
    )]
    pub tax_vault: UncheckedAccount<'info>,
    /// Read-only for a payout, so payouts never write-lock the mint (for wrapped SOL, the one
    /// native mint every SOL transfer reads); writable for the burn, which lowers its supply.
    #[account(
        address = market_state.mints[market_state.tax_side as usize] @ StrategyError::WrongAccount,
        mint::token_program = token_program,
    )]
    pub tax_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: the slot's wallet, checked by the handler.
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: the slot wallet's associated token account for the tax-side mint, checked
    /// and, when missing, created by the handler.
    #[account(mut)]
    pub recipient_token_account: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn distribute_slot<'info>(ctx: Context<'info, Distribute<'info>>, slot: u8) -> Result<()> {
    let accounts = &ctx.accounts;
    let market = &accounts.market_state;
    let slot = slot as usize;
    let wallet = market.slot_wallet(slot).ok_or(StrategyError::NoSuchSlot)?;
    // A tax recipient slot the market does not use has no wallet to pay.
    require!(
        slot == BURN_SLOT as usize || wallet != Pubkey::default(),
        StrategyError::UnusedSlot
    );
    require_keys_eq!(
        accounts.recipient.key(),
        wallet,
        StrategyError::NotSlotWallet
    );
    // Paid only to the wallet's associated token account for the tax-side mint. An SPL Token
    // account's owner may have handed it to another wallet; it is paid all the same, as its
    // owner chose, since refusing would strand the slot's tax (for good once the tax
    // authority renounces). Token-2022's associated token accounts can't change owner.
    let token_account = &accounts.recipient_token_account;
    require_keys_eq!(
        token_account.key(),
        get_associated_token_address_with_program_id(
            &wallet,
            &accounts.tax_mint.key(),
            &accounts.token_program.key(),
        ),
        StrategyError::NotSlotTokenAccount
    );
    let missing = token_account.data_is_empty();
    require!(
        missing || *token_account.owner == accounts.token_program.key(),
        StrategyError::NotSlotTokenAccount
    );

    let market_state = market.key();
    let authority_key =
        vault_authority(&market_state, market.authority_bump).ok_or(StrategyError::WrongAccount)?;
    require_keys_eq!(
        accounts.vault_authority.key(),
        authority_key,
        StrategyError::WrongAccount
    );
    let bump = [market.authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_state.as_ref(), &bump];

    let amount = market.owed[slot];
    // Nothing owed: nothing to move, and no account to create.
    if amount == 0 {
        return Ok(());
    }
    if slot == BURN_SLOT as usize {
        require!(
            accounts.tax_mint.to_account_info().is_writable,
            StrategyError::BurnNeedsWritableMint
        );
        token_2022::burn_checked(
            CpiContext::new(
                accounts.token_program.key(),
                token_2022::BurnChecked {
                    mint: accounts.tax_mint.to_account_info(),
                    from: accounts.tax_vault.to_account_info(),
                    authority: accounts.vault_authority.to_account_info(),
                },
            )
            .with_signer(&[authority_seeds]),
            amount,
            accounts.tax_mint.decimals,
        )?;
    } else {
        if missing {
            associated_token::create(CpiContext::new(
                accounts.associated_token_program.key(),
                associated_token::Create {
                    payer: accounts.payer.to_account_info(),
                    associated_token: token_account.to_account_info(),
                    authority: accounts.recipient.to_account_info(),
                    mint: accounts.tax_mint.to_account_info(),
                    system_program: accounts.system_program.to_account_info(),
                    token_program: accounts.token_program.to_account_info(),
                },
            ))?;
        }
        transfer_checked(
            &accounts.token_program.to_account_info(),
            &accounts.tax_vault.to_account_info(),
            &accounts.tax_mint.to_account_info(),
            &token_account.to_account_info(),
            &accounts.vault_authority.to_account_info(),
            ctx.remaining_accounts,
            amount,
            accounts.tax_mint.decimals,
            &[authority_seeds],
        )?;
    }

    // The slot is paid in full; nothing else in the market changes.
    ctx.accounts.market_state.owed[slot] = 0;
    emit!(Distributed {
        market_state,
        slot: slot as u8,
        recipient: wallet,
        amount,
    });
    Ok(())
}
