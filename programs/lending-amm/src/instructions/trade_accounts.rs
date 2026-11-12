//! The router's ten fixed trade accounts, which quotes, account resolution and swaps all
//! receive first.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::state::LendingAmmMarket;

/// For quotes and account resolution, which run in simulation: only the market state is
/// read, and the other accounts may be placeholders.
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
