//! `pipeline_resolve_accounts`: lists the accounts a swap needs after the router's ten fixed
//! trade accounts (docs/spec/lending-pool.md, "Accounts"):
//!
//! - always the output vault, the vault authority, which signs the payout, and the Kamino
//!   reserve the lent side lends to, from which quotes and swaps value the lent side;
//! - for a trade whose quote redeems a shortfall from Kamino, the reserve writable and then the
//!   redeem accounts: klend, the lending market, its authority, the reserve's liquidity supply,
//!   its collateral mint, the market's cToken account, SPL Token and the instructions sysvar.
//!
//! So ordinary swaps pass the reserve read-only and never write-lock it, since every Kamino user
//! of that mint shares it. A trade paying out the other side never redeems and resolves in one
//! round. One paying out the lent side needs the reserve's data to run the quote, so a round
//! that is not passed the reserve third among the strategy accounts lists the three accounts
//! and asks for another; the next receives them, runs the quote with the same pricing function
//! as quotes and swaps, counting what Kamino can pay from the reserve alone, and lists the redeem
//! accounts only if the quote redeems.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use pipeline_strategy_interface as psi;

use crate::config::{self, KLEND_PROGRAM};
use crate::errors::StrategyError;
use crate::instructions::ReadTrade;
use crate::interface::ResolveRequest;
use crate::kamino::{self, INSTRUCTIONS_SYSVAR, LENDING_MARKET_AUTHORITY_SEED};
use crate::pricing;

pub fn resolve_accounts(ctx: Context<ReadTrade>, request: ResolveRequest) -> Result<()> {
    let market = &ctx.accounts.market_state;
    let (_, output) = market
        .trade_sides(request.trade.input_index, request.trade.output_index)
        .ok_or(StrategyError::WrongAccount)?;
    // The reserve `LENT_MINTS` names for the lent mint, which the market also recorded.
    let lent = config::lent_mint(&market.lent_mint()).ok_or(StrategyError::LentMintNotListed)?;
    let mut accounts = vec![
        account(market.vaults[output], true),
        account(market.authority(&market.key())?, false),
        account(lent.reserve, false),
    ];
    let complete = if output != market.lent_side() {
        true
    } else if let Some(reserve_account) = ctx
        .remaining_accounts
        .get(2)
        .filter(|account| *account.key == lent.reserve)
    {
        // A round after the first, passed back the accounts listed so far, with the reserve
        // third; anything else in its place, or nothing, asks for another round with them. A
        // reserve that fails its check, and a trade the quote refuses, list no redeem accounts;
        // their quote and swap then report why. What Kamino can pay is counted from the reserve
        // alone, as a swap's redeem counts it: its emergency mode, deprecation, free liquidity
        // and withdrawal cap. The lending market's own emergency mode needs its account, which
        // this round does not have, so a trade only that refuses still gets the redeem accounts,
        // and its quote and swap, which read the lending market, refuse it.
        let now = Clock::get()?.unix_timestamp;
        let shortfall = kamino::reserve_of(&market.lent_mint(), reserve_account)
            .and_then(|reserve| {
                pricing::quote(market, &reserve, &request.trade, || {
                    Ok(reserve.can_pay_by_itself(market.ctokens, now))
                })
            })
            .map_or(0, |quote| quote.shortfall);
        if shortfall > 0 {
            let supply = kamino::liquidity_supply_of(&reserve_account.try_borrow_data()?)
                .ok_or(StrategyError::ReserveWrongSize)?;
            let (authority, _) = Pubkey::find_program_address(
                &[LENDING_MARKET_AUTHORITY_SEED, lent.lending_market.as_ref()],
                &KLEND_PROGRAM,
            );
            accounts[2].writable = true;
            accounts.extend([
                account(KLEND_PROGRAM, false),
                account(lent.lending_market, false),
                account(authority, false),
                account(supply, true),
                account(lent.collateral_mint, true),
                account(market.ctoken_account, true),
                account(anchor_spl::token::ID, false),
                account(INSTRUCTIONS_SYSVAR, false),
            ]);
        }
        true
    } else {
        false
    };
    let result = psi::ResolveResult { accounts, complete };
    set_return_data(&crate::borsh_encode(&result)?);
    Ok(())
}

fn account(address: Pubkey, writable: bool) -> psi::AccountRef {
    psi::AccountRef {
        address: address.to_bytes(),
        writable,
    }
}
