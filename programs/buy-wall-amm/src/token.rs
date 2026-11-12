//! Token helpers every instruction that moves tokens shares (from Pipeline's strategy
//! template).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::errors::StrategyError;

/// The amount field of an SPL Token or Token-2022 account.
pub fn token_balance(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    let amount = data
        .get(64..72)
        .ok_or(StrategyError::WrongAccount)?
        .try_into()
        .map_err(|_| StrategyError::WrongAccount)?;
    Ok(u64::from_le_bytes(amount))
}

/// The accounts of one `transfer_checked`.
pub struct Transfer<'a, 'info> {
    pub token_program: &'a AccountInfo<'info>,
    pub from: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub to: &'a AccountInfo<'info>,
    pub authority: &'a AccountInfo<'info>,
    /// Transfer-hook accounts, forwarded to the token program so Token-2022 mints with a
    /// transfer hook work.
    pub hook_accounts: &'a [AccountInfo<'info>],
}

/// SPL Token's `TransferChecked` (tag 12), forwarding transfer-hook accounts.
pub fn transfer_checked(
    accounts: Transfer,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let Transfer {
        token_program,
        from,
        mint,
        to,
        authority,
        hook_accounts,
    } = accounts;
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let mut metas = vec![
        AccountMeta::new(from.key(), false),
        AccountMeta::new_readonly(mint.key(), false),
        AccountMeta::new(to.key(), false),
        AccountMeta::new_readonly(authority.key(), true),
    ];
    let mut infos = vec![from.clone(), mint.clone(), to.clone(), authority.clone()];
    for account in hook_accounts {
        metas.push(if account.is_writable {
            AccountMeta::new(account.key(), false)
        } else {
            AccountMeta::new_readonly(account.key(), false)
        });
        infos.push(account.clone());
    }
    infos.push(token_program.clone());
    let instruction = Instruction {
        program_id: token_program.key(),
        accounts: metas,
        data,
    };
    invoke_signed(&instruction, &infos, signer_seeds)?;
    Ok(())
}

/// Transfers `amount` and returns what actually arrived in `to`, measured by its balance.
pub fn transfer_measured(accounts: Transfer, amount: u64, decimals: u8) -> Result<u64> {
    let to = accounts.to;
    let before = token_balance(to)?;
    transfer_checked(
        Transfer {
            token_program: accounts.token_program,
            from: accounts.from,
            mint: accounts.mint,
            to,
            authority: accounts.authority,
            hook_accounts: accounts.hook_accounts,
        },
        amount,
        decimals,
        &[],
    )?;
    let after = token_balance(to)?;
    after
        .checked_sub(before)
        .ok_or_else(|| error!(StrategyError::Overflow))
}
