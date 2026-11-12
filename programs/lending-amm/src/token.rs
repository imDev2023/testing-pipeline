//! Token plumbing the instructions share: creating the market's PDA accounts idempotently,
//! reading a token account's balance, and transfers that forward transfer-hook accounts.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::token_2022::{self, GetAccountDataSize, InitializeAccount3, InitializeMint2};

use crate::errors::StrategyError;

/// SPL Token's mint size, which the LP mint has.
pub const MINT_LEN: u64 = 82;

/// Creates an account at a PDA of this program, owned by `owner`, as Anchor's `init` does:
/// `create_account` when it holds nothing, otherwise topping it up to rent exemption and
/// allocating and assigning it, so lamports someone sent to the address beforehand can't
/// block creation. An address already allocated or assigned fails, so nothing is ever
/// created twice.
pub fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    space: u64,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(space as usize);
    let signer_seeds = &[seeds];
    let program = system_program.key();
    let lamports = account.lamports();
    if lamports == 0 {
        return system_program::create_account(
            CpiContext::new_with_signer(
                program,
                system_program::CreateAccount {
                    from: payer.clone(),
                    to: account.clone(),
                },
                signer_seeds,
            ),
            rent,
            space,
            owner,
        );
    }
    let top_up = rent.saturating_sub(lamports);
    if top_up > 0 {
        system_program::transfer(
            CpiContext::new(
                program,
                system_program::Transfer {
                    from: payer.clone(),
                    to: account.clone(),
                },
            ),
            top_up,
        )?;
    }
    system_program::allocate(
        CpiContext::new_with_signer(
            program,
            system_program::Allocate {
                account_to_allocate: account.clone(),
            },
            signer_seeds,
        ),
        space,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            program,
            system_program::Assign {
                account_to_assign: account.clone(),
            },
            signer_seeds,
        ),
        owner,
    )
}

/// Creates a token account of `mint` at its PDA, owned by `authority`, sized by the token
/// program for the mint's extensions.
pub fn create_token_account<'info>(
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    let space = token_2022::get_account_data_size(
        CpiContext::new(
            token_program.key(),
            GetAccountDataSize { mint: mint.clone() },
        ),
        &[],
    )?;
    create_pda_account(
        payer,
        system_program,
        account,
        space,
        &token_program.key(),
        seeds,
    )?;
    token_2022::initialize_account3(CpiContext::new(
        token_program.key(),
        InitializeAccount3 {
            account: account.clone(),
            mint: mint.clone(),
            authority: authority.clone(),
        },
    ))
}

/// Creates an SPL Token mint at its PDA with `authority` as mint authority and no freeze
/// authority.
pub fn create_mint<'info>(
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    authority: &Pubkey,
    decimals: u8,
    token_program: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    create_pda_account(
        payer,
        system_program,
        mint,
        MINT_LEN,
        &token_program.key(),
        seeds,
    )?;
    token_2022::initialize_mint2(
        CpiContext::new(token_program.key(), InitializeMint2 { mint: mint.clone() }),
        decimals,
        authority,
        None,
    )
}

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

/// `transfer_checked` that forwards transfer-hook accounts to the token program, so
/// Token-2022 mints with transfer hooks work.
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
    // SPL Token's `TransferChecked` instruction: tag 12, amount, decimals.
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
        let meta = if account.is_writable {
            AccountMeta::new(account.key(), false)
        } else {
            AccountMeta::new_readonly(account.key(), false)
        };
        metas.push(meta);
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
