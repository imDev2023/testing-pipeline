//! `pipeline_swap`: settles a trade the router sends (docs/spec/tax-amm.md, "Pricing and
//! the tax", "Where the tax goes" and "Counters for the containment hook").
//!
//! Only this market's router market may call it, so every trade pays Pipeline's fee,
//! emits a swap event and counts in the market's counters (bypass is refused: ADR 0001).
//! The router has just moved the trader's input into the input vault; this credits what
//! arrived beyond what the market had recorded there, prices it with the same function as
//! `pipeline_quote`, pays the trader from the output vault and books the tax to its slots.
//! The input and the tax stay in the vaults: nothing is refunded, and no tax is paid out
//! during a swap.
//!
//! Remaining accounts: the output vault and the vault authority, as
//! `pipeline_resolve_accounts` lists them, then any transfer-hook accounts of the output
//! mint, which the output transfer forwards.

use anchor_lang::prelude::*;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::instructions::SwapAccounts;
use crate::interface::{SwapRequest, TradeMode};
use crate::pricing;
use crate::split::split_tax;
use crate::state::{vault_authority, TaxMarket, AUTHORITY_SEED};
use crate::token::{token_balance, transfer_checked};

pub fn swap<'info>(ctx: Context<'info, SwapAccounts<'info>>, request: SwapRequest) -> Result<()> {
    let market = &ctx.accounts.market_state;
    require_keys_eq!(
        ctx.accounts.market_signer.key(),
        market.market_signer,
        StrategyError::NotPipeline
    );
    let trade = &request.trade;
    require!(
        trade.mode == TradeMode::ExactIn,
        StrategyError::ExactOutNotSupported
    );
    let (input, output) = TaxMarket::direction(trade.input_index, trade.output_index)
        .ok_or(StrategyError::WrongAccount)?;
    let (input_vault, output_vault) = (market.vaults[input], market.vaults[output]);
    require_keys_eq!(
        ctx.accounts.input_vault.key(),
        input_vault,
        StrategyError::WrongAccount
    );
    require_keys_eq!(
        ctx.accounts.input_mint.key(),
        market.mints[input],
        StrategyError::WrongAccount
    );
    require_keys_eq!(
        ctx.accounts.output_mint.key(),
        market.mints[output],
        StrategyError::WrongAccount
    );
    let [output_vault_info, authority, hook_accounts @ ..] = ctx.remaining_accounts else {
        return err!(StrategyError::WrongAccount);
    };
    require_keys_eq!(
        output_vault_info.key(),
        output_vault,
        StrategyError::WrongAccount
    );
    // Paying the vault itself would move nothing while the market booked a payout, so the
    // trader would get 0 and the reserves and counters would drift from the vault.
    require_keys_neq!(
        ctx.accounts.trader_output.key(),
        output_vault,
        StrategyError::WrongAccount
    );
    // Signing with the wrong account would fail in the token program anyway; checking it
    // here costs a PDA derivation and names the mistake.
    let market_state = market.key();
    let authority_key =
        vault_authority(&market_state, market.authority_bump).ok_or(StrategyError::WrongAccount)?;
    require_keys_eq!(authority.key(), authority_key, StrategyError::WrongAccount);
    let bump = [market.authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_state.as_ref(), &bump];

    // Credit what arrived beyond what the market has recorded in the input vault, capped
    // at what the router sent in this call, so tokens sent to the vault outside a swap are
    // never credited. The market has recorded its real reserve there, plus every tax owed
    // when it is the tax-side vault.
    let owed_here = if market.tax_side as usize == input {
        market
            .owed
            .iter()
            .try_fold(0u64, |total, &owed| total.checked_add(owed))
            .ok_or(StrategyError::Overflow)?
    } else {
        0
    };
    let recorded = market.reserves[input]
        .checked_add(owed_here)
        .ok_or(StrategyError::Overflow)?;
    let vault_balance = token_balance(&ctx.accounts.input_vault.to_account_info())?;
    let credited = psi::credited_input(vault_balance, recorded, request.amount_sent);

    // The same function as `pipeline_quote`, so quotes and swaps agree.
    let fill = pricing::fill(market, trade.input_index, trade.output_index, credited)?;
    let slots = split_tax(fill.tax, &market.shares, market.burn_share_bps)?;

    transfer_checked(
        &ctx.accounts.output_token_program.to_account_info(),
        output_vault_info,
        &ctx.accounts.output_mint.to_account_info(),
        &ctx.accounts.trader_output.to_account_info(),
        authority,
        hook_accounts,
        fill.amount_out,
        ctx.accounts.output_mint.decimals,
        &[authority_seeds],
    )?;

    let state = &mut ctx.accounts.market_state;
    state.reserves[input] = fill.reserve_in;
    state.reserves[output] = fill.reserve_out;
    for (owed, part) in state.owed.iter_mut().zip(slots) {
        *owed = owed.checked_add(part).ok_or(StrategyError::Overflow)?;
    }
    state.tax_collected = state
        .tax_collected
        .checked_add(fill.tax as u128)
        .ok_or(StrategyError::Overflow)?;
    state.volume[input] = state.volume[input]
        .checked_add(fill.amount_in as u128)
        .ok_or(StrategyError::Overflow)?;
    state.volume[output] = state.volume[output]
        .checked_add(fill.amount_out as u128)
        .ok_or(StrategyError::Overflow)?;
    state.swap_count = state
        .swap_count
        .checked_add(1)
        .ok_or(StrategyError::Overflow)?;
    Ok(())
}
