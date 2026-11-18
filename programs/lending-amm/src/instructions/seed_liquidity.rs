//! `pipeline_seed_liquidity`: Pipeline's optional extension that lets another program, such
//! as a launchpad graduating a token, create and fund a lending AMM market in one call
//! (docs/spec/lending-pool.md, "Seeding" and "Addresses"; Pipeline's strategy guide,
//! section 9).
//!
//! `SeedRequest.data` is the creation parameters, [`InitParams`], under the same rules as
//! creation, with the mints in whichever order the launchpad gives them. The market state
//! lives at the PDA `["seeded", seeder, other_mint, lent_mint, lp_fee_bps]`, so nobody but the
//! seeder's own program can create or fund it, and a market created through the router for the
//! same mints and fee lives elsewhere. It is created by the same code as a market created
//! through the router ([`NewMarket`]), under every creation rule and mint rule, and stores the
//! router's market signer. Its first deposit is `add_liquidity`'s, taken from the seeder's
//! escrows: both amounts in full, both above 0, at the price they imply, with
//! `isqrt(other x lent) - MINIMUM_LIQUIDITY` shares minted to the LP recipient's associated
//! token account for the LP mint, created here from the payer's SOL. Naming the vault
//! authority as the LP recipient puts the shares straight into the lock account, for good. As
//! the first deposit does, it checks the Kamino reserve and refuses while it is deprecated.
//! It returns `SeedResult { taken, lp_amount }`, `taken` measured at the escrows; the caller
//! then records the market with the router's `register_existing_market` and `init_fee_account`
//! for each mint, in the same transaction.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::associated_token::{self, get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, MintTo, Token};
use anchor_spl::token_interface::TokenInterface;
use pipeline_strategy_interface as psi;

use super::init_market::{pipeline_market_signer, NewMarket};
use crate::errors::StrategyError;
use crate::events::MarketSeeded;
use crate::interface::SeedRequest;
use crate::kamino;
use crate::params::InitParams;
use crate::shares;
use crate::state::{AUTHORITY_SEED, CTOKEN_SEED, LP_MINT_SEED, VAULT_SEED};
use crate::token::{self as tokens, token_balance};

/// Pipeline's fixed seed accounts (`psi::seed_accounts`), three per mint, then the lending
/// AMM's own, in the order `metadata.json`'s `seed_liquidity.accounts` lists them. The other
/// mint's transfer-hook accounts follow.
#[derive(Accounts)]
pub struct SeedLiquidity<'info> {
    /// A PDA of the calling program, signing; it owns the escrows and becomes the seeder.
    pub seeder: Signer<'info>,
    /// CHECK: the market state PDA `["seeded", seeder, other_mint, lent_mint, lp_fee_bps]`,
    /// checked and created by [`NewMarket`].
    #[account(mut)]
    pub market_state: UncheckedAccount<'info>,
    /// A system account holding the SOL the caller allows for rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the owner of the first deposit's shares; any address, the vault authority to
    /// lock them.
    pub lp_recipient: UncheckedAccount<'info>,
    /// CHECK: checked against the mint rules by [`NewMarket`], before anything is created.
    pub mint_0: UncheckedAccount<'info>,
    /// CHECK: the seeder's escrow of mint 0; the token program checks it and the seeder's
    /// authority.
    #[account(mut)]
    pub escrow_0: UncheckedAccount<'info>,
    pub token_program_0: Interface<'info, TokenInterface>,
    /// CHECK: checked against the mint rules by [`NewMarket`], before anything is created.
    pub mint_1: UncheckedAccount<'info>,
    /// CHECK: the seeder's escrow of mint 1, checked as `escrow_0` is.
    #[account(mut)]
    pub escrow_1: UncheckedAccount<'info>,
    pub token_program_1: Interface<'info, TokenInterface>,
    /// CHECK: the vault authority PDA; it holds no data.
    #[account(seeds = [AUTHORITY_SEED, market_state.key().as_ref()], bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the vault PDA for mint 0, created by [`NewMarket`].
    #[account(mut, seeds = [VAULT_SEED, market_state.key().as_ref(), mint_0.key().as_ref()], bump)]
    pub vault_0: UncheckedAccount<'info>,
    /// CHECK: the vault PDA for mint 1, created by [`NewMarket`].
    #[account(mut, seeds = [VAULT_SEED, market_state.key().as_ref(), mint_1.key().as_ref()], bump)]
    pub vault_1: UncheckedAccount<'info>,
    /// CHECK: compared with the lent mint's collateral mint in `LENT_MINTS` by [`NewMarket`].
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: the cToken account PDA, created by [`NewMarket`].
    #[account(mut, seeds = [CTOKEN_SEED, market_state.key().as_ref()], bump)]
    pub ctoken_account: UncheckedAccount<'info>,
    /// CHECK: the LP mint PDA, created by [`NewMarket`].
    #[account(mut, seeds = [LP_MINT_SEED, market_state.key().as_ref()], bump)]
    pub lp_mint: UncheckedAccount<'info>,
    /// SPL Token, which owns the lent mint, the collateral mint and the LP mint.
    pub token_program: Program<'info, Token>,
    /// CHECK: the LP recipient's associated token account for the LP mint, created here; the
    /// lock account when the LP recipient is the vault authority.
    #[account(
        mut,
        address = get_associated_token_address(&lp_recipient.key(), &lp_mint.key())
            @ StrategyError::WrongAccount,
    )]
    pub recipient_shares: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// The Kamino reserve the lent mint lends to, read-only, checked before the first deposit
    /// as `add_liquidity` checks it.
    /// CHECK: checked by `kamino::reserve_of` against the lent mint's entry in `LENT_MINTS`.
    pub reserve: UncheckedAccount<'info>,
}

pub fn seed_liquidity<'info>(
    ctx: Context<'info, SeedLiquidity<'info>>,
    request: SeedRequest,
) -> Result<()> {
    let [amount_0, amount_1] = request.amounts[..] else {
        return err!(StrategyError::BadSeedAmounts);
    };
    let params =
        InitParams::try_from_slice(&request.data).map_err(|_| StrategyError::BadInitData)?;
    params.validate()?;
    let lent_index = params.lent_index as usize;
    let other_index = 1 - lent_index;
    let accounts = &ctx.accounts;

    // Everything the first deposit refuses that needs no new account, refused before the five
    // accounts are created: amounts of 0 or too small for a share, and a reserve that is not
    // the lent mint's, fails its check or is deprecated, exactly as `add_liquidity` refuses them.
    let amounts = [amount_0, amount_1];
    let deposit = shares::first_deposit(amounts[other_index], amounts[lent_index])?;
    let mints = [accounts.mint_0.key(), accounts.mint_1.key()];
    let reserve = kamino::reserve_of(&mints[lent_index], &accounts.reserve.to_account_info())?;
    require!(!reserve.deprecated(), StrategyError::ReserveDeprecated);

    let seeder = accounts.seeder.key();
    let market_state = accounts.market_state.key();
    let mut market = NewMarket {
        market_state: &accounts.market_state,
        payer: &accounts.payer,
        system_program: &accounts.system_program,
        mints: [&accounts.mint_0, &accounts.mint_1],
        token_programs: [&accounts.token_program_0, &accounts.token_program_1],
        authority: &accounts.authority,
        authority_bump: ctx.bumps.authority,
        vaults: [&accounts.vault_0, &accounts.vault_1],
        vault_bumps: [ctx.bumps.vault_0, ctx.bumps.vault_1],
        collateral_mint: &accounts.collateral_mint,
        ctoken_account: &accounts.ctoken_account,
        ctoken_bump: ctx.bumps.ctoken_account,
        lp_mint: &accounts.lp_mint,
        lp_mint_bump: ctx.bumps.lp_mint,
        token_program: &accounts.token_program,
    }
    .create(&params, Some(seeder), pipeline_market_signer(&market_state))?;

    let sides = [
        (
            &accounts.escrow_0,
            &accounts.mint_0,
            &accounts.vault_0,
            &accounts.token_program_0,
        ),
        (
            &accounts.escrow_1,
            &accounts.mint_1,
            &accounts.vault_1,
            &accounts.token_program_1,
        ),
    ];
    // What leaves each escrow is measured, for the caller to check against its own
    // measurement. Neither mint can charge a transfer fee (the mint rules refuse it), so what
    // is sent is what arrives; only the other side can have a transfer hook.
    let mut taken = vec![0u64; 2];
    for (i, (escrow, mint, vault, token_program)) in sides.into_iter().enumerate() {
        let hook_accounts: &[AccountInfo<'info>] = if i == other_index {
            ctx.remaining_accounts
        } else {
            &[]
        };
        let escrow = escrow.to_account_info();
        let before = token_balance(&escrow)?;
        tokens::transfer_checked(
            &token_program.to_account_info(),
            &escrow,
            &mint.to_account_info(),
            &vault.to_account_info(),
            &accounts.seeder.to_account_info(),
            hook_accounts,
            amounts[i],
            tokens::mint_decimals(&mint.to_account_info())?,
            &[],
        )?;
        taken[i] = before
            .checked_sub(token_balance(&escrow)?)
            .ok_or(StrategyError::Overflow)?;
    }

    // The shares go to the LP recipient's associated token account for the LP mint, which
    // can't exist yet, since the LP mint was created above.
    let recipient_shares = accounts.recipient_shares.to_account_info();
    associated_token::create_idempotent(CpiContext::new(
        accounts.associated_token_program.key(),
        associated_token::Create {
            payer: accounts.payer.to_account_info(),
            associated_token: recipient_shares.clone(),
            authority: accounts.lp_recipient.to_account_info(),
            mint: accounts.lp_mint.to_account_info(),
            system_program: accounts.system_program.to_account_info(),
            token_program: accounts.token_program.to_account_info(),
        },
    ))?;
    let market_key = accounts.market_state.key();
    let bump = [market.authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_key.as_ref(), &bump];
    token::mint_to(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            MintTo {
                mint: accounts.lp_mint.to_account_info(),
                to: recipient_shares,
                authority: accounts.authority.to_account_info(),
            },
            &[authority_seeds],
        ),
        deposit.shares,
    )?;

    market.reserves = amounts;
    market.write(&accounts.market_state)?;
    emit!(MarketSeeded {
        market_state: market_key,
        seeder,
        lp_recipient: accounts.lp_recipient.key(),
        shares_account: accounts.recipient_shares.key(),
        amounts,
        shares: deposit.shares,
        share_count: shares::share_count(deposit.shares)?,
    });
    let result = psi::SeedResult {
        taken,
        lp_amount: deposit.shares,
    };
    set_return_data(&crate::borsh_encode(&result)?);
    Ok(())
}
