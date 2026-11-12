//! `pipeline_swap`: settles a trade the router sends.
//!
//! Only this market's router market may call it, so every trade pays Pipeline's fee and
//! emits a swap event (bypass is refused: ADR 0001). The router has just moved the trader's
//! input into the input vault; the swap credits it with Pipeline's `credited_input`, prices
//! it with the same function as `pipeline_quote`, pays the output from the output vault and
//! keeps the whole input in the input vault, where it joins its side.
//!
//! Remaining accounts: the output vault and the vault authority, as
//! `pipeline_resolve_accounts` listed them, then any transfer-hook accounts, which are
//! forwarded to the payout.

use anchor_lang::prelude::*;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::instructions::SwapAccounts;
use crate::interface::{SwapRequest, TradeMode};
use crate::pricing;
use crate::state::AUTHORITY_SEED;
use crate::token;

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
    let (input, output) = market
        .trade_sides(trade.input_index, trade.output_index)
        .ok_or(StrategyError::WrongAccount)?;
    require_keys_eq!(
        ctx.accounts.input_vault.key(),
        market.vaults[input],
        StrategyError::WrongAccount
    );
    let [output_vault, authority, hook_accounts @ ..] = ctx.remaining_accounts else {
        return err!(StrategyError::WrongAccount);
    };
    require_keys_eq!(
        output_vault.key(),
        market.vaults[output],
        StrategyError::WrongAccount
    );
    let market_key = market.key();
    require_keys_eq!(
        authority.key(),
        market.authority(&market_key)?,
        StrategyError::WrongAccount
    );

    // Credit what arrived in the vault beyond what the market has recorded there, capped at
    // what the router sent in this call, so tokens sent to the vault earlier stay a
    // donation.
    let vault_balance = token::token_balance(&ctx.accounts.input_vault.to_account_info())?;
    let credited = psi::credited_input(vault_balance, market.reserves[input], request.amount_sent);
    let priced = crate::interface::TradeRequest {
        amount: credited,
        ..trade.clone()
    };
    let quote = pricing::quote(market, &priced)?;

    let bump = [market.authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_key.as_ref(), &bump];
    token::transfer_checked(
        &ctx.accounts.output_token_program.to_account_info(),
        output_vault,
        &ctx.accounts.output_mint.to_account_info(),
        &ctx.accounts.trader_output.to_account_info(),
        authority,
        hook_accounts,
        quote.amount_out,
        ctx.accounts.output_mint.decimals,
        &[authority_seeds],
    )?;

    // Move the recorded reserves by exactly what the trade took in and paid out, never by
    // vault balances, so donations stay out of the price.
    let market = &mut ctx.accounts.market_state;
    market.reserves[input] = market.reserves[input]
        .checked_add(quote.amount_in)
        .ok_or(StrategyError::Overflow)?;
    market.reserves[output] = market.reserves[output]
        .checked_sub(quote.amount_out)
        .ok_or(StrategyError::Overflow)?;
    Ok(())
}
