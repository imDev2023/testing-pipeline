//! A payout from one of a market's vaults to a recipient's associated token account, shared
//! by `pay_rewards` and `sweep_fees` (docs/spec/pool4-for-solana.md, "`pay_rewards`",
//! "`sweep_fees { slot }`", "The recipient's token account"), so the two can never check
//! their recipient differently.
//!
//! Payouts go only to the recipient's associated token account for the mint, the address
//! every wallet and Aviary compute. One that is missing, or was closed, is created at the
//! caller's expense; one whose owner was reassigned (SPL Token lets an account's owner hand
//! it to another wallet) is refused, since paying it would pay someone else. Either way only
//! that one payout is affected: nothing else a market does touches a recipient's account,
//! and the recipient can hand its role to another wallet.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{
    create_idempotent, get_associated_token_address_with_program_id, Create,
};

use crate::errors::StrategyError;
use crate::payouts::{Owed, Refusal};
use crate::state::{check_vault_accounts, MarketState, VaultSide, AUTHORITY_SEED};
use crate::token::{transfer_checked, Transfer};

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
/// creates it if it does not exist; refuses one that belongs to anyone else. The address is
/// derived under the associated token program's own id, and the program named must be it,
/// so a caller's account list can steer neither the address nor the create.
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
    require_keys_eq!(
        associated_token_program.key(),
        anchor_spl::associated_token::ID,
        StrategyError::WrongAccount
    );
    let expected =
        get_associated_token_address_with_program_id(recipient.key, mint.key, token_program.key);
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

/// The accounts one payout names: the caller, the market, the vault paid from with its mint
/// and authority, the recipient's wallet and token account, the programs, and the token's
/// transfer-hook accounts.
pub struct PayoutAccounts<'a, 'info> {
    pub payer: &'a AccountInfo<'info>,
    pub market_state: &'a AccountLoader<'info, MarketState>,
    pub vault: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub recipient: &'a AccountInfo<'info>,
    pub token_account: &'a AccountInfo<'info>,
    pub vault_authority: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub hook_accounts: &'a [AccountInfo<'info>],
}

/// What one payout paid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Paid {
    /// The ledgers after the payout, as written back to the market state.
    pub owed: Owed,
    /// The wallet paid, the one the caller named.
    pub wallet: Pubkey,
    pub amount: u64,
}

/// Pays out of the `side` vault what `payout` computes from the market state: the vault, its
/// mint and authority are checked, `payout` gives the ledgers after, the wallet and the
/// amount from that one snapshot, the caller's recipient must be that wallet, its associated
/// token account is ensured, the amount is transferred and the ledgers are written back.
/// Every check runs before any call out of the program, and nothing a call makes can change
/// the market state in between (the runtime refuses re-entry, and no other program owns it).
pub fn pay_out(
    accounts: PayoutAccounts,
    side: VaultSide,
    decimals: u8,
    payout: impl FnOnce(&MarketState) -> core::result::Result<(Owed, Pubkey, u64), Refusal>,
) -> Result<Paid> {
    let market_state = accounts.market_state.key();
    let (paid, authority_bump) = {
        let state = accounts.market_state.load()?;
        let authority_bump = check_vault_accounts(
            &state,
            &market_state,
            side,
            accounts.vault.key,
            accounts.mint.key,
            accounts.vault_authority.key,
        )?;
        let (owed, wallet, amount) =
            payout(&state).map_err(|refusal| error!(StrategyError::from(refusal)))?;
        require_keys_eq!(
            accounts.recipient.key(),
            wallet,
            StrategyError::WrongAccount
        );
        (
            Paid {
                owed,
                wallet,
                amount,
            },
            authority_bump,
        )
    };

    ensure(RecipientAccounts {
        payer: accounts.payer,
        recipient: accounts.recipient,
        token_account: accounts.token_account,
        mint: accounts.mint,
        token_program: accounts.token_program,
        associated_token_program: accounts.associated_token_program,
        system_program: accounts.system_program,
    })?;
    let bump = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_state.as_ref(), &bump];
    transfer_checked(
        Transfer {
            token_program: accounts.token_program,
            from: accounts.vault,
            mint: accounts.mint,
            to: accounts.token_account,
            authority: accounts.vault_authority,
            hook_accounts: accounts.hook_accounts,
        },
        paid.amount,
        decimals,
        &[authority_seeds],
    )?;

    accounts.market_state.load_mut()?.set_owed(&paid.owed);
    Ok(paid)
}
