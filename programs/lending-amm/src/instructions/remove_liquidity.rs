//! `remove_liquidity { lp, min_other, min_lent, in_kind }`: an LP burns `lp` shares and is paid
//! pro rata from the other side, the buffer and the market's cTokens, each part rounded down
//! (docs/spec/lending-pool.md, "Removing"; the maths is [`crate::shares::removal`]).
//!
//! - In cash (`in_kind = false`) the cTokens' part is redeemed from Kamino with klend's
//!   `redeem_reserve_collateral`, signed by the vault authority and paid into the market's own
//!   buffer vault, and the LP receives the buffer's part plus exactly what klend paid, in the
//!   lent mint. If Kamino cannot pay that part right now, by the same count a swap's redeem
//!   uses ([`crate::kamino::Reserve::can_pay_planned`]), the instruction fails with
//!   `KaminoCannotPay` before calling Kamino, and Aviary offers the removal in kind instead; so
//!   it does whenever klend redeems nothing (either emergency mode, or a deprecated reserve) and
//!   the LP's part holds any cTokens, even ones the stored rate values at nothing.
//! - In kind (`in_kind = true`) the cTokens' part is paid as cTokens into the LP's associated
//!   token account for the collateral mint, created at the LP's expense when missing. This path
//!   reads no Kamino account and calls no Kamino instruction, so LPs can leave whatever state
//!   Kamino is in: its Kamino accounts are left out, Anchor's way for optional accounts (the
//!   program's own id in their place), and are never read even when given.
//!
//! `min_other` bounds what the other side pays and `min_lent` what the lent mint pays, the
//! buffer's part plus, in cash, what klend paid for the cTokens' part. Either way the buffer
//! and the cTokens each lose only the burned shares' part of themselves, so the buffer's share
//! of the lent side is unchanged and one LP leaving never drains the buffer traders rely on.
//!
//! The LP signs the burn of their own shares, from any token account of the LP mint they own,
//! never one they are only a delegate of. Remaining accounts are the other mint's transfer-hook
//! accounts, forwarded to its payout; the lent mint has none.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, Burn, Mint as SplMint, Token, TokenAccount};
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::errors::StrategyError;
use crate::events::LiquidityRemoved;
use crate::kamino::KaminoAccounts;
use crate::shares;
use crate::state::{LendingAmmMarket, AUTHORITY_SEED};
use crate::token as tokens;

/// `remove_liquidity` accounts. The order is part of `metadata.json`, whose
/// `remove_liquidity` (in cash) and `remove_liquidity_in_kind` actions both build this
/// instruction; keep them in step.
#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    /// The LP, who burns their shares and pays for their cToken account if an in-kind removal
    /// creates it.
    #[account(mut)]
    pub lp: Signer<'info>,
    #[account(
        mut,
        has_one = lp_mint @ StrategyError::WrongAccount,
    )]
    pub market_state: Box<Account<'info, LendingAmmMarket>>,
    #[account(mut)]
    pub lp_mint: Box<Account<'info, SplMint>>,
    /// The token account of the LP mint the shares are burned from, which the LP owns.
    #[account(
        mut,
        constraint = lp_shares.mint == lp_mint.key() @ StrategyError::WrongAccount,
        constraint = lp_shares.owner == lp.key() @ StrategyError::WrongAccount,
    )]
    pub lp_shares: Box<Account<'info, TokenAccount>>,
    /// CHECK: where mint 0 is paid; the token program checks its mint.
    #[account(mut)]
    pub lp_token_0: UncheckedAccount<'info>,
    /// CHECK: where mint 1 is paid, likewise.
    #[account(mut)]
    pub lp_token_1: UncheckedAccount<'info>,
    /// CHECK: the market's vault for mint 0.
    #[account(mut, address = market_state.vaults[0] @ StrategyError::WrongAccount)]
    pub vault_0: UncheckedAccount<'info>,
    /// CHECK: the market's vault for mint 1.
    #[account(mut, address = market_state.vaults[1] @ StrategyError::WrongAccount)]
    pub vault_1: UncheckedAccount<'info>,
    #[account(
        address = market_state.mints[0] @ StrategyError::WrongAccount,
        mint::token_program = token_program_0,
    )]
    pub mint_0: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        address = market_state.mints[1] @ StrategyError::WrongAccount,
        mint::token_program = token_program_1,
    )]
    pub mint_1: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the vault authority PDA, which signs the payouts and the redeem.
    #[account(seeds = [AUTHORITY_SEED, market_state.key().as_ref()], bump = market_state.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the market's cToken account.
    #[account(mut, address = market_state.ctoken_account @ StrategyError::WrongAccount)]
    pub ctoken_account: UncheckedAccount<'info>,
    /// The reserve's collateral (cToken) mint, an SPL Token mint, read-only, so an in-kind
    /// removal never write-locks the mint every Kamino user of the reserve shares; a cash removal
    /// passes it again, writable, among the Kamino accounts.
    #[account(address = market_state.collateral_mint @ StrategyError::WrongAccount)]
    pub collateral_mint: Box<Account<'info, SplMint>>,
    /// CHECK: the LP's associated token account for the collateral mint, where an in-kind
    /// removal pays the cTokens, created there if missing; checked only in kind, since a cash
    /// removal never touches it.
    #[account(mut)]
    pub lp_ctoken: UncheckedAccount<'info>,
    pub token_program_0: Interface<'info, TokenInterface>,
    pub token_program_1: Interface<'info, TokenInterface>,
    /// SPL Token, the program of the LP mint, the lent mint and every cToken mint.
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// For a removal in cash, the lent mint's Kamino accounts, each checked before any is
    /// passed to klend ([`KaminoAccounts::check`]); left out in kind.
    /// CHECK: Kamino Lend, checked.
    pub klend_program: Option<UncheckedAccount<'info>>,
    /// CHECK: the Kamino reserve the lent mint lends to, checked before it is read.
    #[account(mut)]
    pub reserve: Option<UncheckedAccount<'info>>,
    /// CHECK: the reserve's lending market, checked.
    pub lending_market: Option<UncheckedAccount<'info>>,
    /// CHECK: the lending market's authority PDA, checked.
    pub lending_market_authority: Option<UncheckedAccount<'info>>,
    /// CHECK: the reserve's liquidity supply, checked against the reserve.
    #[account(mut)]
    pub reserve_liquidity_supply: Option<UncheckedAccount<'info>>,
    /// CHECK: the instructions sysvar klend takes, checked.
    pub instructions_sysvar: Option<UncheckedAccount<'info>>,
    /// CHECK: the collateral mint again, writable, since klend burns the cTokens' part from its
    /// supply; checked against the lent mint's entry in `LENT_MINTS`.
    #[account(mut)]
    pub reserve_collateral_mint: Option<UncheckedAccount<'info>>,
}

pub fn remove_liquidity_handler<'info>(
    ctx: Context<'info, RemoveLiquidity<'info>>,
    lp: u64,
    min_other: u64,
    min_lent: u64,
    in_kind: bool,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let market = &accounts.market_state;
    let (lent_index, other_index) = (market.lent_side(), market.other_index());
    let removal = shares::removal(
        lp,
        accounts.lp_mint.supply,
        market.reserves[other_index],
        market.reserves[lent_index],
        market.ctokens,
    )?;
    require!(removal.other >= min_other, StrategyError::BelowMinOther);

    let vaults = [&accounts.vault_0, &accounts.vault_1];
    let lp_tokens = [&accounts.lp_token_0, &accounts.lp_token_1];
    let mints = [&accounts.mint_0, &accounts.mint_1];
    let token_programs = [&accounts.token_program_0, &accounts.token_program_1];
    let lent_vault = vaults[lent_index].to_account_info();
    let lent_mint = mints[lent_index].to_account_info();
    let authority = accounts.authority.to_account_info();
    let ctoken_account = accounts.ctoken_account.to_account_info();
    let market_key = market.key();
    let bump = [market.authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_key.as_ref(), &bump];

    // In cash, check every Kamino account and that Kamino can pay the cTokens' part right now,
    // before burning anything or calling Kamino. cTokens worth less than one unit of the lent
    // mint at the stored rate are not redeemed, since klend pays nothing for them; they stay in
    // the market, as every part's rounding does.
    let klend_program;
    let reserve_account;
    let lending_market_account;
    let lending_market_authority;
    let liquidity_supply;
    let instructions_sysvar;
    let reserve_collateral_mint;
    let collateral_mint = accounts.collateral_mint.to_account_info();
    let token_program = accounts.token_program.to_account_info();
    let mut kamino = None;
    if !in_kind && removal.ctokens > 0 {
        let missing = || error!(StrategyError::KaminoAccountsMissing);
        let info = |account: &Option<UncheckedAccount<'info>>| {
            account
                .as_ref()
                .map(|a| a.to_account_info())
                .ok_or_else(missing)
        };
        klend_program = info(&accounts.klend_program)?;
        reserve_account = info(&accounts.reserve)?;
        lending_market_account = info(&accounts.lending_market)?;
        lending_market_authority = info(&accounts.lending_market_authority)?;
        liquidity_supply = info(&accounts.reserve_liquidity_supply)?;
        instructions_sysvar = info(&accounts.instructions_sysvar)?;
        reserve_collateral_mint = info(&accounts.reserve_collateral_mint)?;
        let calls = KaminoAccounts {
            klend_program: &klend_program,
            reserve: &reserve_account,
            lending_market: &lending_market_account,
            lending_market_authority: &lending_market_authority,
            liquidity_mint: &lent_mint,
            liquidity_supply: &liquidity_supply,
            collateral_mint: &reserve_collateral_mint,
            token_program: &token_program,
            instructions_sysvar: &instructions_sysvar,
        };
        let lent = crate::config::lent_mint(&market.lent_mint())
            .ok_or(StrategyError::LentMintNotListed)?;
        let (reserve, lending_market) = calls.check(lent)?;
        // While klend redeems nothing, the cTokens' part goes in kind, which hands the LP their
        // cTokens, even where the stored rate values them at nothing, as after a total write-off.
        require!(
            !reserve.redeems_stopped(&lending_market),
            StrategyError::KaminoCannotPay
        );
        let value = reserve.lent_value(removal.ctokens)?;
        // cTokens klend would pay nothing for are not redeemed, so a removal paying nothing else
        // would burn the shares for nothing.
        require!(
            value > 0 || removal.other > 0 || removal.buffer > 0,
            StrategyError::ZeroRemoval
        );
        if value > 0 {
            let can_pay = reserve.can_pay_planned(
                &lending_market,
                removal.ctokens,
                Clock::get()?.unix_timestamp,
            );
            require!(value <= can_pay, StrategyError::KaminoCannotPay);
            kamino = Some(calls);
        }
    }

    // The LP burns their shares, signing for their own account.
    token::burn(
        CpiContext::new(
            accounts.token_program.key(),
            Burn {
                mint: accounts.lp_mint.to_account_info(),
                from: accounts.lp_shares.to_account_info(),
                authority: accounts.lp.to_account_info(),
            },
        ),
        lp,
    )?;

    // In cash, redeem the cTokens' part into the buffer vault and measure what moved, as the
    // swap's redeem does: what klend paid is the LP's, at the rate it refreshed to.
    let (mut ctokens_out, mut redeemed) = (0u64, 0u64);
    if let Some(calls) = &kamino {
        let vault_before = tokens::token_balance(&lent_vault)?;
        let ctokens_before = tokens::token_balance(&ctoken_account)?;
        calls.redeem(
            &authority,
            &ctoken_account,
            &lent_vault,
            removal.ctokens,
            &[authority_seeds],
        )?;
        redeemed = tokens::token_balance(&lent_vault)?
            .checked_sub(vault_before)
            .ok_or(StrategyError::Overflow)?;
        ctokens_out = ctokens_before
            .checked_sub(tokens::token_balance(&ctoken_account)?)
            .ok_or(StrategyError::Overflow)?;
    }
    let lent_paid = removal
        .buffer
        .checked_add(redeemed)
        .ok_or(StrategyError::Overflow)?;
    require!(lent_paid >= min_lent, StrategyError::BelowMinLent);

    let mut amounts = [0u64; 2];
    amounts[other_index] = removal.other;
    amounts[lent_index] = lent_paid;
    for i in [other_index, lent_index] {
        if amounts[i] == 0 {
            continue;
        }
        // Only the other side can have a transfer hook: the lent mint is always SPL Token.
        let hook_accounts: &[AccountInfo<'info>] = if i == other_index {
            ctx.remaining_accounts
        } else {
            &[]
        };
        tokens::transfer_checked(
            &token_programs[i].to_account_info(),
            &vaults[i].to_account_info(),
            &mints[i].to_account_info(),
            &lp_tokens[i].to_account_info(),
            &authority,
            hook_accounts,
            amounts[i],
            mints[i].decimals,
            &[authority_seeds],
        )?;
    }

    // In kind, pay the cTokens' part as cTokens, into the LP's associated token account.
    if in_kind && removal.ctokens > 0 {
        require_keys_eq!(
            accounts.lp_ctoken.key(),
            get_associated_token_address(&accounts.lp.key(), &accounts.collateral_mint.key()),
            StrategyError::WrongAccount
        );
        // An account with data at the LP's associated token address was created by the
        // associated token program as the LP's token account for the collateral mint.
        if accounts.lp_ctoken.data_is_empty() {
            associated_token::create_idempotent(CpiContext::new(
                accounts.associated_token_program.key(),
                associated_token::Create {
                    payer: accounts.lp.to_account_info(),
                    associated_token: accounts.lp_ctoken.to_account_info(),
                    authority: accounts.lp.to_account_info(),
                    mint: collateral_mint.clone(),
                    system_program: accounts.system_program.to_account_info(),
                    token_program: token_program.clone(),
                },
            ))?;
        }
        tokens::transfer_checked(
            &token_program,
            &ctoken_account,
            &collateral_mint,
            &accounts.lp_ctoken.to_account_info(),
            &authority,
            &[],
            removal.ctokens,
            accounts.collateral_mint.decimals,
            &[authority_seeds],
        )?;
        ctokens_out = removal.ctokens;
    }

    let lp_key = accounts.lp.key();
    let share_count = shares::share_count(
        accounts
            .lp_mint
            .supply
            .checked_sub(lp)
            .ok_or(StrategyError::Overflow)?,
    )?;
    // Record exactly what left, as measured for a redeem: the buffer loses only its part, since
    // what klend paid passed through it to the LP.
    let market = &mut ctx.accounts.market_state;
    market.reserves[other_index] = market.reserves[other_index]
        .checked_sub(removal.other)
        .ok_or(StrategyError::Overflow)?;
    market.reserves[lent_index] = market.reserves[lent_index]
        .checked_sub(removal.buffer)
        .ok_or(StrategyError::Overflow)?;
    market.ctokens = market
        .ctokens
        .checked_sub(ctokens_out)
        .ok_or(StrategyError::Overflow)?;
    market.redeemed = market
        .redeemed
        .checked_add(redeemed as u128)
        .ok_or(StrategyError::Overflow)?;
    if in_kind && ctokens_out > 0 {
        // cTokens paid in kind take their part of the net amount lent with them, so that the
        // market's lending yield, `V + redeemed - deposited`, stays that of the cTokens it still
        // holds plus what it has redeemed, with no Kamino account read to value them.
        let (deposited, redeemed) = shares::totals_after_in_kind(
            market.deposited,
            market.redeemed,
            ctokens_out,
            market
                .ctokens
                .checked_add(ctokens_out)
                .ok_or(StrategyError::Overflow)?,
        )?;
        market.deposited = deposited;
        market.redeemed = redeemed;
    }
    emit!(LiquidityRemoved {
        market_state: market_key,
        lp: lp_key,
        shares: lp,
        share_count,
        amounts,
        ctokens: ctokens_out,
        in_kind,
        redeemed,
    });
    Ok(())
}
