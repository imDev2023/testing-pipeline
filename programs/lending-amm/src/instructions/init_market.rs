//! `pipeline_init_market`: creates a lending AMM market. The router calls it from
//! `create_market`, which anyone can call (docs/spec/lending-pool.md, "Markets").
//!
//! It refuses every market that breaks a rule, checks that the market state is the PDA of
//! its mints, lent side and fee, checks and stores the router's market signer, creates both
//! vaults, the cToken account and the LP mint, and records the reserve, the creation slot and
//! the time. Lamports anyone sent to those addresses beforehand never block the creation
//! (the spec's "idempotently"); an address already allocated fails it, so nothing is ever
//! created twice. The creator's own signature never reaches it, so it can't
//! take tokens from them; liquidity comes from `add_liquidity`, which the LP signs directly,
//! in the same transaction.

use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::TokenInterface;
use pipeline_strategy_interface as psi;

use crate::config::{self, LP_DECIMALS};
use crate::errors::StrategyError;
use crate::events::MarketCreated;
use crate::params::InitParams;
use crate::state::{
    market_state_address, LendingAmmMarket, AUTHORITY_SEED, CTOKEN_SEED, LP_MINT_SEED, MARKET_SEED,
    RESERVED_LEN, STATE_VERSION, VAULT_SEED,
};
use crate::token;

/// The router's four fixed accounts, then the lending AMM's own, in the order
/// `metadata.json`'s `init.accounts` lists them.
#[derive(Accounts)]
pub struct InitMarket<'info> {
    /// The router's market PDA for this market state.
    pub market_signer: Signer<'info>,
    /// CHECK: the market state PDA `["market", other_mint, lent_mint, lp_fee_bps]`, checked
    /// and created by the handler.
    #[account(mut)]
    pub market_state: UncheckedAccount<'info>,
    /// A router PDA holding the SOL the creator allowed for setup. Rent comes from it; the
    /// router returns what is left to the creator.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: checked by the handler, before anything is created.
    pub mint_0: UncheckedAccount<'info>,
    /// CHECK: checked by the handler, before anything is created.
    pub mint_1: UncheckedAccount<'info>,
    /// CHECK: the vault authority PDA; it holds no data.
    #[account(seeds = [AUTHORITY_SEED, market_state.key().as_ref()], bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the vault PDA for mint 0, created by the handler.
    #[account(mut, seeds = [VAULT_SEED, market_state.key().as_ref(), mint_0.key().as_ref()], bump)]
    pub vault_0: UncheckedAccount<'info>,
    /// CHECK: the vault PDA for mint 1, created by the handler.
    #[account(mut, seeds = [VAULT_SEED, market_state.key().as_ref(), mint_1.key().as_ref()], bump)]
    pub vault_1: UncheckedAccount<'info>,
    /// CHECK: compared with the lent mint's collateral mint in `LENT_MINTS` by the handler.
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: the cToken account PDA, created by the handler.
    #[account(mut, seeds = [CTOKEN_SEED, market_state.key().as_ref()], bump)]
    pub ctoken_account: UncheckedAccount<'info>,
    /// CHECK: the LP mint PDA, created by the handler.
    #[account(mut, seeds = [LP_MINT_SEED, market_state.key().as_ref()], bump)]
    pub lp_mint: UncheckedAccount<'info>,
    pub token_program_0: Interface<'info, TokenInterface>,
    pub token_program_1: Interface<'info, TokenInterface>,
    /// SPL Token, which owns the lent mint, the collateral mint and the LP mint.
    pub token_program: Program<'info, Token>,
}

pub fn init_market<'info>(ctx: Context<'info, InitMarket<'info>>, data: Vec<u8>) -> Result<()> {
    let params = InitParams::try_from_slice(&data).map_err(|_| StrategyError::BadInitData)?;

    // Only the router can sign as this market state's market PDA, so only a router market
    // can create it, and only that market may ever swap it.
    let market_state = ctx.accounts.market_state.key();
    let market_signer = pipeline_market_signer(&market_state);
    require_keys_eq!(
        ctx.accounts.market_signer.key(),
        market_signer,
        StrategyError::NotPipeline
    );

    let mints = [ctx.accounts.mint_0.key(), ctx.accounts.mint_1.key()];
    require_keys_neq!(mints[0], mints[1], StrategyError::EqualMints);
    params.validate()?;
    let lent_index = params.lent_index as usize;
    let other_index = 1 - lent_index;

    // Every creation parameter is in the seeds, so nobody can occupy a market's address
    // with other parameters.
    let (expected_state, state_bump) =
        market_state_address(&mints[other_index], &mints[lent_index], params.lp_fee_bps);
    require_keys_eq!(
        market_state,
        expected_state,
        StrategyError::WrongMarketState
    );

    let accounts = &ctx.accounts;
    let mint_accounts = [&accounts.mint_0, &accounts.mint_1];
    let token_programs = [&accounts.token_program_0, &accounts.token_program_1];
    let lent = config::lent_mint(&mints[lent_index]).ok_or(StrategyError::LentMintNotListed)?;
    check_lent_mint(mint_accounts[lent_index], token_programs[lent_index])?;
    check_other_mint(mint_accounts[other_index], token_programs[other_index])?;
    require_keys_eq!(
        accounts.collateral_mint.key(),
        lent.collateral_mint,
        StrategyError::WrongCollateralMint
    );

    let payer = accounts.payer.to_account_info();
    let system = accounts.system_program.to_account_info();
    let fee_seed = params.lp_fee_bps.to_le_bytes();
    let state_seeds: &[&[u8]] = &[
        MARKET_SEED,
        mints[other_index].as_ref(),
        mints[lent_index].as_ref(),
        &fee_seed,
        &[state_bump],
    ];
    token::create_pda_account(
        &payer,
        &system,
        &accounts.market_state.to_account_info(),
        LendingAmmMarket::SPACE as u64,
        &crate::ID,
        state_seeds,
    )?;

    let authority = accounts.authority.to_account_info();
    let vault_bumps = [ctx.bumps.vault_0, ctx.bumps.vault_1];
    let vaults = [&accounts.vault_0, &accounts.vault_1];
    for i in 0..2 {
        let bump = [vault_bumps[i]];
        let seeds: &[&[u8]] = &[VAULT_SEED, market_state.as_ref(), mints[i].as_ref(), &bump];
        token::create_token_account(
            &payer,
            &system,
            &vaults[i].to_account_info(),
            &mint_accounts[i].to_account_info(),
            &authority,
            &token_programs[i].to_account_info(),
            seeds,
        )?;
    }
    let spl_token = accounts.token_program.to_account_info();
    let ctoken_bump = [ctx.bumps.ctoken_account];
    token::create_token_account(
        &payer,
        &system,
        &accounts.ctoken_account.to_account_info(),
        &accounts.collateral_mint.to_account_info(),
        &authority,
        &spl_token,
        &[CTOKEN_SEED, market_state.as_ref(), &ctoken_bump],
    )?;
    let lp_mint_bump = [ctx.bumps.lp_mint];
    token::create_mint(
        &payer,
        &system,
        &accounts.lp_mint.to_account_info(),
        &authority.key(),
        LP_DECIMALS,
        &spl_token,
        &[LP_MINT_SEED, market_state.as_ref(), &lp_mint_bump],
    )?;

    let clock = Clock::get()?;
    let vault_keys = [accounts.vault_0.key(), accounts.vault_1.key()];
    let state = LendingAmmMarket {
        version: STATE_VERSION,
        bump: state_bump,
        authority_bump: ctx.bumps.authority,
        lent_index: params.lent_index,
        lp_fee_bps: params.lp_fee_bps,
        withdraw_mode: false,
        mints,
        vaults: vault_keys,
        market_signer,
        lp_mint: accounts.lp_mint.key(),
        ctoken_account: accounts.ctoken_account.key(),
        reserve: lent.reserve,
        collateral_mint: lent.collateral_mint,
        seeder: Pubkey::default(),
        reserves: [0; 2],
        ctokens: 0,
        deposited: 0,
        redeemed: 0,
        created_slot: clock.slot,
        created_at: clock.unix_timestamp,
        reserved: [0; RESERVED_LEN],
    };
    {
        let info = accounts.market_state.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        state.try_serialize(&mut &mut data[..])?;
    }
    emit!(MarketCreated {
        market_state,
        mints,
        vaults: vault_keys,
        params,
        reserve: lent.reserve,
        lp_mint: accounts.lp_mint.key(),
        ctoken_account: accounts.ctoken_account.key(),
        created_slot: clock.slot,
        created_at: clock.unix_timestamp,
    });
    Ok(())
}

/// The router's market PDA for a market state of this program: `["market", program,
/// market_state]` under the Pipeline program.
pub fn pipeline_market_signer(market_state: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            psi::seeds::MARKET,
            crate::ID.as_ref(),
            market_state.as_ref(),
        ],
        &Pubkey::new_from_array(psi::PIPELINE_PROGRAM_ID),
    )
    .0
}

/// The lent side is exactly the listed mint, owned by SPL Token.
fn check_lent_mint(
    mint: &UncheckedAccount,
    token_program: &Interface<TokenInterface>,
) -> Result<()> {
    require_keys_eq!(
        *mint.owner,
        anchor_spl::token::ID,
        StrategyError::LentMintNotSplToken
    );
    check_mint(mint, token_program)
}

/// The other side follows the suite's mint rules (docs/spec/tax-amm.md, "Mint rules").
fn check_other_mint(
    mint: &UncheckedAccount,
    token_program: &Interface<TokenInterface>,
) -> Result<()> {
    check_mint(mint, token_program)
}

/// Refuses a mint its token program doesn't own, or one the mint rules refuse.
fn check_mint(mint: &UncheckedAccount, token_program: &Interface<TokenInterface>) -> Result<()> {
    require_keys_eq!(
        *mint.owner,
        token_program.key(),
        StrategyError::WrongTokenProgram
    );
    let data = mint.try_borrow_data()?;
    mint_rules::check_mint(&mint.owner.to_bytes(), &data).map_err(|refusal| match refusal {
        mint_rules::MintRefusal::ExtensionNotAllowed(extension) => {
            msg!("Mint {} carries refused extension {}", mint.key, extension);
            error!(StrategyError::MintExtensionNotAllowed)
        }
        mint_rules::MintRefusal::NotATokenProgram | mint_rules::MintRefusal::NotAMint => {
            error!(StrategyError::NotAMint)
        }
    })
}
