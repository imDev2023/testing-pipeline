//! `pipeline_swap`: settles a trade the router sends.
//!
//! Only this market's router market may call it, so every trade pays Pipeline's fee and
//! emits a swap event (bypass is refused: ADR 0001). The router has just moved the trader's
//! input into the input vault; the swap credits it with Pipeline's `credited_input`, prices
//! it with the same function as `pipeline_quote`, pays the output from the output vault and
//! keeps the whole input in the input vault, where it joins its side.
//!
//! A lent-side output beyond the buffer first redeems the shortfall `s = out - B` from Kamino
//! (docs/spec/lending-pool.md, "Redeeming the shortfall"): it burns
//! `ceil(s x S_ctoken / S_total)` of the market's cTokens with klend's
//! `redeem_reserve_collateral`, signed by the vault authority and paid into the market's own
//! lent-mint vault, measures what arrived there, at least `s`, and records it; anything above
//! `s` stays in the buffer. A swap never deposits into Kamino.
//!
//! Remaining accounts: the output vault, the vault authority and the Kamino reserve, then, for
//! a trade whose quote redeems, the redeem accounts, as `pipeline_resolve_accounts` listed them,
//! then any transfer-hook accounts, which are forwarded to the payout. The reserve is checked
//! before it is read, and values the market's cTokens at its stored rate, as the quote did. A
//! trade that needs a redeem but was built without the redeem accounts, because the buffer
//! shrank after it was resolved, fails with `RedeemAccountsMissing` and changes nothing.

use anchor_lang::prelude::*;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::events::ShortfallRedeemed;
use crate::instructions::{strategy_accounts, SwapAccounts};
use crate::interface::{SwapRequest, TradeMode};
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
    let accounts = strategy_accounts(market, ctx.remaining_accounts, output)?;
    let (output_vault, authority, hook_accounts) =
        (accounts.output_vault, accounts.authority, accounts.rest);
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
    let output_mint = ctx.accounts.output_mint.to_account_info();
    let quote = accounts.quote(market, &output_mint, &priced)?;

    let bump = [market.authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_key.as_ref(), &bump];
    if quote.shortfall > 0 {
        // The quote checked every redeem account, and that the output vault is the market's
        // own lent-mint vault, the only place a redeem can pay.
        let (kamino, ctoken_account) = accounts.kamino(&output_mint)?;
        let burn = accounts
            .reserve
            .ctokens_for_shortfall(quote.shortfall, market.ctokens)?;
        let vault_before = token::token_balance(output_vault)?;
        let ctokens_before = token::token_balance(ctoken_account)?;
        kamino.redeem(
            authority,
            ctoken_account,
            output_vault,
            burn,
            &[authority_seeds],
        )?;
        let received = token::token_balance(output_vault)?
            .checked_sub(vault_before)
            .ok_or(StrategyError::Overflow)?;
        let burned = ctokens_before
            .checked_sub(token::token_balance(ctoken_account)?)
            .ok_or(StrategyError::Overflow)?;
        require!(received >= quote.shortfall, StrategyError::RedeemPaidShort);

        // Record exactly what moved, as measured, never what was asked for.
        let market = &mut ctx.accounts.market_state;
        market.reserves[output] = market.reserves[output]
            .checked_add(received)
            .ok_or(StrategyError::Overflow)?;
        market.ctokens = market
            .ctokens
            .checked_sub(burned)
            .ok_or(StrategyError::Overflow)?;
        market.redeemed = market
            .redeemed
            .checked_add(received as u128)
            .ok_or(StrategyError::Overflow)?;
        emit!(ShortfallRedeemed {
            market_state: market_key,
            shortfall: quote.shortfall,
            ctokens: burned,
            liquidity: received,
            buffer: market.reserves[output]
                .checked_sub(quote.amount_out)
                .ok_or(StrategyError::Overflow)?,
            ctokens_held: market.ctokens,
            redeemed: market.redeemed,
        });
    }

    token::transfer_checked(
        &ctx.accounts.output_token_program.to_account_info(),
        output_vault,
        &output_mint,
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
