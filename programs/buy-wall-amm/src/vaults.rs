//! Creating a market's vaults: token accounts at the PDAs `["vault", market_state, mint]`,
//! owned by the vault authority `["authority", market_state]` (docs/spec/pool4-for-solana.md,
//! "Addresses").
//!
//! `pipeline_init_market` creates them itself, after the creation parameters and the mint
//! rules are checked, rather than through Anchor's `init_if_needed`: Anchor would parse the
//! mint's extensions first and refuse an unrecognised one with its own error before the
//! mint rules could. Creation is idempotent, as Pipeline's guide asks: lamports someone sent
//! to a vault's address beforehand never block it, and a vault that already exists with the
//! right mint, owner and program is accepted as it is.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{allocate, assign, create_account, transfer};
use anchor_lang::system_program::{Allocate, Assign, CreateAccount, Transfer};
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::{
    Account as Token2022Account, Mint as Token2022Mint,
};
use anchor_spl::token_interface::{initialize_account3, InitializeAccount3};

use crate::errors::StrategyError;

/// The size of a plain SPL Token account.
const TOKEN_ACCOUNT_LEN: usize = 165;

/// The accounts one vault's creation needs.
pub struct VaultAccounts<'a, 'info> {
    pub payer: &'a AccountInfo<'info>,
    pub vault: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub authority: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

/// Creates the vault at `vault` (whose PDA seeds, bump included, are `vault_seeds`), or
/// accepts it if it already exists as this market's vault.
pub fn create_vault(accounts: VaultAccounts, vault_seeds: &[&[u8]]) -> Result<()> {
    let VaultAccounts {
        payer,
        vault,
        mint,
        authority,
        token_program,
        system_program,
    } = accounts;
    if vault.owner == token_program.key {
        return check_existing(vault, mint.key, authority.key);
    }
    require_keys_eq!(*vault.owner, System::id(), StrategyError::WrongAccount);

    let space = token_account_len(mint, token_program.key)?;
    let rent = Rent::get()?.minimum_balance(space);
    let signer: &[&[&[u8]]] = &[vault_seeds];
    if vault.lamports() == 0 {
        create_account(
            CpiContext::new_with_signer(
                system_program.key(),
                CreateAccount {
                    from: payer.clone(),
                    to: vault.clone(),
                },
                signer,
            ),
            rent,
            space as u64,
            token_program.key,
        )?;
    } else {
        // Someone sent lamports to the address first: top it up, then allocate and assign
        // it, which only the PDA's signature allows.
        let shortfall = rent.saturating_sub(vault.lamports());
        if shortfall > 0 {
            transfer(
                CpiContext::new(
                    system_program.key(),
                    Transfer {
                        from: payer.clone(),
                        to: vault.clone(),
                    },
                ),
                shortfall,
            )?;
        }
        allocate(
            CpiContext::new_with_signer(
                system_program.key(),
                Allocate {
                    account_to_allocate: vault.clone(),
                },
                signer,
            ),
            space as u64,
        )?;
        assign(
            CpiContext::new_with_signer(
                system_program.key(),
                Assign {
                    account_to_assign: vault.clone(),
                },
                signer,
            ),
            token_program.key,
        )?;
    }
    initialize_account3(CpiContext::new(
        token_program.key(),
        InitializeAccount3 {
            account: vault.clone(),
            mint: mint.clone(),
            authority: authority.clone(),
        },
    ))
}

/// The size of a token account for `mint`: Token-2022 accounts carry the account
/// extensions their mint's extensions require (a transfer-hook mint's accounts carry the
/// transfer-hook account extension).
fn token_account_len(mint: &AccountInfo, token_program: &Pubkey) -> Result<usize> {
    if *token_program != anchor_spl::token_2022::ID {
        return Ok(TOKEN_ACCOUNT_LEN);
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| StrategyError::WrongAccount)?;
    let mint_extensions = state
        .get_extension_types()
        .map_err(|_| StrategyError::MintExtensionNotAllowed)?;
    let required = ExtensionType::get_required_init_account_extensions(&mint_extensions);
    ExtensionType::try_calculate_account_len::<Token2022Account>(&required)
        .map_err(|_| error!(StrategyError::WrongAccount))
}

/// An existing vault is accepted only if it is a token account of `mint` owned by
/// `authority`.
fn check_existing(vault: &AccountInfo, mint: &Pubkey, authority: &Pubkey) -> Result<()> {
    let data = vault.try_borrow_data()?;
    let field = |range: core::ops::Range<usize>| data.get(range).ok_or(StrategyError::WrongAccount);
    require!(field(0..32)? == mint.as_ref(), StrategyError::WrongAccount);
    require!(
        field(32..64)? == authority.as_ref(),
        StrategyError::WrongAccount
    );
    Ok(())
}
