//! Token helpers shared by the instructions that move tokens, from Pipeline's strategy
//! template: a vault's balance, and `transfer_checked` forwarding transfer-hook accounts.

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

/// The owner field of an SPL Token or Token-2022 account.
pub fn token_owner(account: &AccountInfo) -> Result<Pubkey> {
    let data = account.try_borrow_data()?;
    let owner: [u8; 32] = data
        .get(32..64)
        .ok_or(StrategyError::WrongAccount)?
        .try_into()
        .map_err(|_| StrategyError::WrongAccount)?;
    Ok(Pubkey::new_from_array(owner))
}

/// SPL Token's `TransferChecked` (tag 12), with `hook_accounts` appended so Token-2022
/// mints with transfer hooks work: Token-2022 picks out the accounts its hook needs.
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    hook_accounts: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
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
