//! A recipient's associated token account, for `pay_rewards` and `sweep_fees`
//! (docs/spec/pool4-for-solana.md, "`pay_rewards`", "`sweep_fees { slot }`").
//!
//! Payouts go only to the recipient's associated token account for the mint, the address
//! every wallet and Aviary compute. One that is missing, or was closed, is created at the
//! caller's expense; one whose owner was reassigned (SPL Token lets an account's owner hand
//! it to another wallet) is refused, since paying it would pay someone else. Either way only
//! that one payout is affected: nothing else a market does touches a recipient's account,
//! and the recipient can hand its role to another wallet.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{create_idempotent, Create};

use crate::errors::StrategyError;

/// The accounts one recipient's associated token account needs.
pub struct RecipientAccounts<'a, 'info> {
    pub payer: &'a AccountInfo<'info>,
    pub recipient: &'a AccountInfo<'info>,
    pub token_account: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

/// Checks that `token_account` is `recipient`'s associated token account for `mint` and
/// creates it if it does not exist; refuses one that belongs to anyone else.
pub fn ensure(accounts: RecipientAccounts) -> Result<()> {
    let RecipientAccounts {
        payer,
        recipient,
        token_account,
        mint,
        token_program,
        associated_token_program,
        system_program,
    } = accounts;
    let expected = Pubkey::find_program_address(
        &[
            recipient.key.as_ref(),
            token_program.key.as_ref(),
            mint.key.as_ref(),
        ],
        associated_token_program.key,
    )
    .0;
    require_keys_eq!(token_account.key(), expected, StrategyError::WrongAccount);

    if token_account.owner == token_program.key {
        // It exists: still the recipient's, for this mint (SPL Token's account layout, the
        // mint at 0 and the owner at 32, which Token-2022 shares).
        let data = token_account.try_borrow_data()?;
        let field =
            |range: core::ops::Range<usize>| data.get(range).ok_or(StrategyError::WrongAccount);
        require!(
            field(0..32)? == mint.key.as_ref(),
            StrategyError::WrongAccount
        );
        require!(
            field(32..64)? == recipient.key.as_ref(),
            StrategyError::RecipientAccountNotTheirs
        );
        return Ok(());
    }
    create_idempotent(CpiContext::new(
        associated_token_program.key(),
        Create {
            payer: payer.clone(),
            associated_token: token_account.clone(),
            authority: recipient.clone(),
            mint: mint.clone(),
            system_program: system_program.clone(),
            token_program: token_program.clone(),
        },
    ))
}
