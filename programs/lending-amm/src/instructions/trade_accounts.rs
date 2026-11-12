//! The router's ten fixed trade accounts, which quotes, account resolution and swaps all
//! receive first, and the strategy's own accounts after them.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::errors::StrategyError;
use crate::kamino::{self, Reserve};
use crate::state::LendingAmmMarket;

/// The strategy accounts a quote or swap receives after the router's ten, in the order
/// `pipeline_resolve_accounts` lists them: the output vault, the vault authority and the
/// Kamino reserve the lent side lends to (read-only), then anything else, such as the output
/// mint's transfer-hook accounts.
pub struct StrategyAccounts<'a, 'info> {
    pub output_vault: &'a AccountInfo<'info>,
    pub authority: &'a AccountInfo<'info>,
    /// The reserve, checked and read.
    pub reserve: Reserve,
    pub rest: &'a [AccountInfo<'info>],
}

/// Splits `remaining` into [`StrategyAccounts`], checking the reserve before reading it. A
/// trade built without the reserve fails the check with `ReserveWrongAddress`, whatever account
/// sits in its place.
pub fn strategy_accounts<'a, 'info>(
    market: &LendingAmmMarket,
    remaining: &'a [AccountInfo<'info>],
) -> Result<StrategyAccounts<'a, 'info>> {
    let [output_vault, authority, rest @ ..] = remaining else {
        return err!(StrategyError::WrongAccount);
    };
    let (reserve, rest) = rest
        .split_first()
        .ok_or(StrategyError::ReserveWrongAddress)?;
    Ok(StrategyAccounts {
        output_vault,
        authority,
        reserve: kamino::reserve_of(&market.lent_mint(), reserve)?,
        rest,
    })
}

/// For quotes and account resolution, which run in simulation: only the market state (and,
/// for quotes, the reserve among the strategy accounts) is read, and the other accounts may be
/// placeholders.
#[derive(Accounts)]
pub struct ReadTrade<'info> {
    /// CHECK: unused in reads.
    pub market_signer: UncheckedAccount<'info>,
    pub market_state: Account<'info, LendingAmmMarket>,
    /// CHECK: unused in reads.
    pub trader: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub trader_input: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub trader_output: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub input_vault: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub input_mint: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub output_mint: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub input_token_program: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub output_token_program: UncheckedAccount<'info>,
}

/// As passed to `pipeline_swap`.
#[derive(Accounts)]
pub struct SwapAccounts<'info> {
    /// The router's market PDA; compared with the market state's `market_signer`.
    pub market_signer: Signer<'info>,
    #[account(mut)]
    pub market_state: Account<'info, LendingAmmMarket>,
    /// CHECK: the trader's wallet, for identity only. It never signs here.
    pub trader: UncheckedAccount<'info>,
    /// CHECK: receives refunds; the token program checks it.
    #[account(mut)]
    pub trader_input: UncheckedAccount<'info>,
    /// CHECK: receives the output; the token program checks it.
    #[account(mut)]
    pub trader_output: UncheckedAccount<'info>,
    /// CHECK: compared with the market's vault for the input mint.
    #[account(mut)]
    pub input_vault: UncheckedAccount<'info>,
    pub input_mint: InterfaceAccount<'info, Mint>,
    pub output_mint: InterfaceAccount<'info, Mint>,
    pub input_token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
}
