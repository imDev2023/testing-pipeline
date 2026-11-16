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
    market_state_address, seeded_market_state_address, LendingAmmMarket, AUTHORITY_SEED,
    CTOKEN_SEED, LP_MINT_SEED, MARKET_SEED, RESERVED_LEN, SEEDED_SEED, STATE_VERSION, VAULT_SEED,
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

    let accounts = &ctx.accounts;
    let state = NewMarket {
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
    .create(&params, None, market_signer)?;
    state.write(&accounts.market_state)
}

/// Everything a new market is created from, whether through the router's `create_market`
/// or a launchpad's `pipeline_seed_liquidity`, so both refuse the same markets and create
/// the same accounts.
pub struct NewMarket<'a, 'info> {
    pub market_state: &'a UncheckedAccount<'info>,
    pub payer: &'a Signer<'info>,
    pub system_program: &'a Program<'info, System>,
    pub mints: [&'a UncheckedAccount<'info>; 2],
    pub token_programs: [&'a Interface<'info, TokenInterface>; 2],
    pub authority: &'a UncheckedAccount<'info>,
    pub authority_bump: u8,
    pub vaults: [&'a UncheckedAccount<'info>; 2],
    pub vault_bumps: [u8; 2],
    pub collateral_mint: &'a UncheckedAccount<'info>,
    pub ctoken_account: &'a UncheckedAccount<'info>,
    pub ctoken_bump: u8,
    pub lp_mint: &'a UncheckedAccount<'info>,
    pub lp_mint_bump: u8,
    pub token_program: &'a Program<'info, Token>,
}

impl<'info> NewMarket<'_, 'info> {
    /// Refuses a market that breaks a rule, checks the market state's address, and creates
    /// the market state, both vaults, the cToken account and the LP mint. The market state
    /// is `["market", other_mint, lent_mint, lp_fee_bps]`, or, for a market `seeder` seeds,
    /// `["seeded", seeder, other_mint, lent_mint, lp_fee_bps]`. Returns the new market's
    /// state, with nothing deposited, for the caller to complete and write. `market_signer` is
    /// the router's market PDA for the market state, [`pipeline_market_signer`], which the
    /// caller has already derived.
    pub fn create(
        &self,
        params: &InitParams,
        seeder: Option<Pubkey>,
        market_signer: Pubkey,
    ) -> Result<LendingAmmMarket> {
        let market_state = self.market_state.key();
        let mints = [self.mints[0].key(), self.mints[1].key()];
        require_keys_neq!(mints[0], mints[1], StrategyError::EqualMints);
        params.validate()?;
        let lent_index = params.lent_index as usize;
        let other_index = 1 - lent_index;
        let (other_mint, lent_mint) = (mints[other_index], mints[lent_index]);

        // Every creation parameter is in the seeds, so nobody can occupy a market's address
        // with other parameters; a seeded market's seeds also hold its seeder, so nobody but
        // the seeder's own program can create or fund it first.
        let fee_seed = params.lp_fee_bps.to_le_bytes();
        let (expected_state, state_bump) = match &seeder {
            None => market_state_address(&other_mint, &lent_mint, params.lp_fee_bps),
            Some(seeder) => {
                seeded_market_state_address(seeder, &other_mint, &lent_mint, params.lp_fee_bps)
            }
        };
        require_keys_eq!(
            market_state,
            expected_state,
            StrategyError::WrongMarketState
        );

        let lent = config::lent_mint(&lent_mint).ok_or(StrategyError::LentMintNotListed)?;
        check_lent_mint(self.mints[lent_index], self.token_programs[lent_index])?;
        check_other_mint(self.mints[other_index], self.token_programs[other_index])?;
        require_keys_eq!(
            self.collateral_mint.key(),
            lent.collateral_mint,
            StrategyError::WrongCollateralMint
        );

        let payer = self.payer.to_account_info();
        let system = self.system_program.to_account_info();
        let bump = [state_bump];
        let seeder_key = seeder.unwrap_or_default();
        let state_seeds: Vec<&[u8]> = match &seeder {
            None => vec![
                MARKET_SEED,
                other_mint.as_ref(),
                lent_mint.as_ref(),
                &fee_seed,
                &bump,
            ],
            Some(_) => vec![
                SEEDED_SEED,
                seeder_key.as_ref(),
                other_mint.as_ref(),
                lent_mint.as_ref(),
                &fee_seed,
                &bump,
            ],
        };
        token::create_pda_account(
            &payer,
            &system,
            &self.market_state.to_account_info(),
            LendingAmmMarket::SPACE as u64,
            &crate::ID,
            &state_seeds,
        )?;

        let authority = self.authority.to_account_info();
        for (((mint, vault), vault_bump), token_program) in self
            .mints
            .iter()
            .zip(self.vaults)
            .zip(self.vault_bumps)
            .zip(self.token_programs)
        {
            let bump = [vault_bump];
            let mint_key = mint.key();
            let seeds: &[&[u8]] = &[VAULT_SEED, market_state.as_ref(), mint_key.as_ref(), &bump];
            token::create_token_account(
                &payer,
                &system,
                &vault.to_account_info(),
                &mint.to_account_info(),
                &authority,
                &token_program.to_account_info(),
                seeds,
            )?;
        }
        let spl_token = self.token_program.to_account_info();
        let ctoken_bump = [self.ctoken_bump];
        token::create_token_account(
            &payer,
            &system,
            &self.ctoken_account.to_account_info(),
            &self.collateral_mint.to_account_info(),
            &authority,
            &spl_token,
            &[CTOKEN_SEED, market_state.as_ref(), &ctoken_bump],
        )?;
        let lp_mint_bump = [self.lp_mint_bump];
        token::create_mint(
            &payer,
            &system,
            &self.lp_mint.to_account_info(),
            &authority.key(),
            LP_DECIMALS,
            &spl_token,
            &[LP_MINT_SEED, market_state.as_ref(), &lp_mint_bump],
        )?;

        let clock = Clock::get()?;
        let vaults = [self.vaults[0].key(), self.vaults[1].key()];
        emit!(MarketCreated {
            market_state,
            mints,
            vaults,
            params: *params,
            reserve: lent.reserve,
            lp_mint: self.lp_mint.key(),
            ctoken_account: self.ctoken_account.key(),
            created_slot: clock.slot,
            created_at: clock.unix_timestamp,
        });
        Ok(LendingAmmMarket {
            version: STATE_VERSION,
            bump: state_bump,
            authority_bump: self.authority_bump,
            lent_index: params.lent_index,
            lp_fee_bps: params.lp_fee_bps,
            withdraw_mode: false,
            mints,
            vaults,
            market_signer,
            lp_mint: self.lp_mint.key(),
            ctoken_account: self.ctoken_account.key(),
            reserve: lent.reserve,
            collateral_mint: lent.collateral_mint,
            seeder: seeder_key,
            reserves: [0; 2],
            ctokens: 0,
            deposited: 0,
            redeemed: 0,
            created_slot: clock.slot,
            created_at: clock.unix_timestamp,
            reserved: [0; RESERVED_LEN],
        })
    }
}

impl LendingAmmMarket {
    /// Writes the market state, discriminator first, into its account.
    pub fn write(&self, account: &UncheckedAccount) -> Result<()> {
        let info = account.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        self.try_serialize(&mut &mut data[..])
    }
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
