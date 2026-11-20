//! Token helpers every instruction that moves tokens shares (from Pipeline's strategy
//! template).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::errors::StrategyError;

/// The size of an SPL Token account, and of a Token-2022 account with no extensions.
const TOKEN_ACCOUNT_LEN: usize = 165;
/// The size of an SPL Token mint, and of a Token-2022 mint with no extensions.
const MINT_LEN: usize = 82;
/// Token-2022's account type byte, at `TOKEN_ACCOUNT_LEN` in an account with extensions.
const ACCOUNT_TYPE_MINT: u8 = 1;
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;
/// The length of an SPL Token or Token-2022 multisig account, which carries no account type.
const MULTISIG_LEN: usize = 355;

/// Whether `data`, owned by `owner`, is laid out as a token program's account of `kind`
/// (`ACCOUNT_TYPE_MINT` or `ACCOUNT_TYPE_ACCOUNT`): owned by SPL Token or Token-2022, of the
/// base size, or for Token-2022 longer with the account type byte saying so. A mint with
/// extensions is as long as a token account, so only that byte tells them apart.
fn is_token_layout(owner: &Pubkey, data: &[u8], kind: u8) -> bool {
    let base = if kind == ACCOUNT_TYPE_MINT {
        MINT_LEN
    } else {
        TOKEN_ACCOUNT_LEN
    };
    if *owner == anchor_spl::token::ID {
        return data.len() == base;
    }
    // A Token-2022 account or mint with extensions is longer than a token account and says
    // what it is at byte 165; a multisig is exactly `MULTISIG_LEN` bytes and has no such byte
    // (review finding R2-05), as `mint-rules` also refuses.
    *owner == anchor_spl::token_2022::ID
        && (data.len() == base
            || (data.len() > TOKEN_ACCOUNT_LEN
                && data.len() != MULTISIG_LEN
                && data[TOKEN_ACCOUNT_LEN] == kind))
}

/// The amount field of an SPL Token or Token-2022 account, at byte 64. Refused as
/// `WrongAccount` unless the account is one: owned by a token program and laid out as a
/// token account, so the bytes read are an amount whatever account a caller names.
pub fn token_balance(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(
        is_token_layout(account.owner, &data, ACCOUNT_TYPE_ACCOUNT),
        StrategyError::WrongAccount
    );
    let amount = data
        .get(64..72)
        .ok_or(StrategyError::WrongAccount)?
        .try_into()
        .map_err(|_| StrategyError::WrongAccount)?;
    Ok(u64::from_le_bytes(amount))
}

/// The decimals of an SPL Token or Token-2022 mint, byte 44 of both layouts. Refused as
/// `WrongAccount` unless the account is a mint: owned by a token program and laid out as
/// one.
pub fn mint_decimals(mint: &AccountInfo) -> Result<u8> {
    let data = mint.try_borrow_data()?;
    require!(
        is_token_layout(mint.owner, &data, ACCOUNT_TYPE_MINT),
        StrategyError::WrongAccount
    );
    data.get(44)
        .copied()
        .ok_or_else(|| error!(StrategyError::WrongAccount))
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
    // A balance that fell while receiving means `to` is not the account it should be (the
    // source itself, say), not an arithmetic fault.
    after
        .checked_sub(before)
        .ok_or_else(|| error!(StrategyError::WrongAccount))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `f` on an account of `owner` holding `data`.
    fn with_account<T>(owner: &Pubkey, mut data: Vec<u8>, f: impl FnOnce(&AccountInfo) -> T) -> T {
        let key = Pubkey::new_unique();
        let mut lamports = 1;
        let account = AccountInfo::new(&key, false, false, &mut lamports, &mut data, owner, false);
        f(&account)
    }

    /// An account of `len` bytes with `byte` at `at` (an amount's first byte, or a mint's
    /// decimals), and the account type byte at 165 set to `kind` when it is long enough to
    /// have one.
    fn layout(len: usize, at: usize, byte: u8, kind: u8) -> Vec<u8> {
        let mut data = vec![0; len];
        data[at] = byte;
        if len > TOKEN_ACCOUNT_LEN {
            data[TOKEN_ACCOUNT_LEN] = kind;
        }
        data
    }

    fn token_account(len: usize, amount: u8, kind: u8) -> Vec<u8> {
        layout(len, 64, amount, kind)
    }

    fn mint(len: usize, decimals: u8, kind: u8) -> Vec<u8> {
        layout(len, 44, decimals, kind)
    }

    /// The raw reads refuse any account that is not a token program's account of the kind
    /// they read, whatever its bytes say: owned by another program, of the wrong size, or a
    /// Token-2022 mint with extensions (as long as a token account) read as a token account,
    /// and the other way round. Every caller pins the account's key today; this keeps a
    /// future caller from trusting attacker data.
    #[test]
    fn sos_h076_raw_reads_refuse_accounts_that_are_not_token_accounts_or_mints() {
        let (token, token_2022) = (anchor_spl::token::ID, anchor_spl::token_2022::ID);
        let stranger = Pubkey::new_unique();
        let balance = |owner: &Pubkey, data| with_account(owner, data, token_balance).ok();
        let decimals = |owner: &Pubkey, data| with_account(owner, data, mint_decimals).ok();

        // Token accounts of either program are read.
        assert_eq!(balance(&token, token_account(165, 7, 0)), Some(7));
        assert_eq!(balance(&token_2022, token_account(165, 8, 0)), Some(8));
        assert_eq!(
            balance(&token_2022, token_account(175, 9, ACCOUNT_TYPE_ACCOUNT)),
            Some(9)
        );
        // Anything else is refused.
        assert_eq!(balance(&stranger, token_account(165, 7, 0)), None);
        assert_eq!(balance(&crate::ID, token_account(165, 7, 0)), None);
        assert_eq!(balance(&token, token_account(164, 7, 0)), None);
        assert_eq!(
            balance(&token, token_account(175, 7, ACCOUNT_TYPE_ACCOUNT)),
            None
        );
        assert_eq!(
            balance(&token_2022, token_account(175, 7, ACCOUNT_TYPE_MINT)),
            None
        );
        assert_eq!(balance(&token_2022, token_account(166, 7, 0)), None);
        assert_eq!(balance(&token, mint(82, 6, 0)), None);

        // Mints of either program are read.
        assert_eq!(decimals(&token, mint(82, 6, 0)), Some(6));
        assert_eq!(decimals(&token_2022, mint(82, 9, 0)), Some(9));
        assert_eq!(
            decimals(&token_2022, mint(250, 2, ACCOUNT_TYPE_MINT)),
            Some(2)
        );
        // Anything else is refused.
        assert_eq!(decimals(&stranger, mint(82, 6, 0)), None);
        assert_eq!(decimals(&token, mint(81, 6, 0)), None);
        assert_eq!(decimals(&token, token_account(165, 6, 0)), None);
        assert_eq!(
            decimals(&token_2022, mint(250, 6, ACCOUNT_TYPE_ACCOUNT)),
            None
        );
        assert_eq!(decimals(&token_2022, token_account(165, 6, 0)), None);
        // And the refusal is `WrongAccount`.
        let error = with_account(&stranger, mint(82, 6, 0), mint_decimals).unwrap_err();
        assert_eq!(error, error!(StrategyError::WrongAccount));
    }

    /// Round 2 finding R2-05: a Token-2022 multisig account is 355 bytes, longer than a token
    /// account, so its byte 165 could read as an account type; the raw reads refuse that
    /// length whatever byte 165 holds, as `mint-rules` does.
    #[test]
    fn sos_r2_05_raw_reads_refuse_a_token_2022_multisig() {
        let token_2022 = anchor_spl::token_2022::ID;
        let balance = |data| with_account(&token_2022, data, token_balance).ok();
        let decimals = |data| with_account(&token_2022, data, mint_decimals).ok();
        assert_eq!(balance(token_account(355, 7, ACCOUNT_TYPE_ACCOUNT)), None);
        assert_eq!(decimals(mint(355, 6, ACCOUNT_TYPE_MINT)), None);
        // One byte either side, a token account or a mint with extensions, is read.
        assert_eq!(
            balance(token_account(354, 7, ACCOUNT_TYPE_ACCOUNT)),
            Some(7)
        );
        assert_eq!(
            balance(token_account(356, 7, ACCOUNT_TYPE_ACCOUNT)),
            Some(7)
        );
    }
}
