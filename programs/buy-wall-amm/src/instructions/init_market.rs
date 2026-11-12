//! `pipeline_init_market`: the router calls it from `create_market`, which anyone can call,
//! with the creator's creation parameters (docs/spec/pool4-for-solana.md, "Creation
//! parameters" and "Addresses").
//!
//! The creator's own signature never reaches this instruction, so it cannot take tokens
//! from them; the seed comes from `seed`, which the seeder signs directly (usually in the
//! same transaction).

use anchor_lang::prelude::*;
use anchor_spl::token::{spl_token::native_mint, Token};
use anchor_spl::token_interface::{Mint, TokenInterface};
use pipeline_strategy_interface as psi;

use crate::config::MARKET_STATE_SIZE;
use crate::errors::StrategyError;
use crate::events::MarketCreated;
use crate::params::InitParams;
use crate::state::{MarketState, LAYOUT_VERSION, STATUS_CREATED};
use crate::vaults::{create_vault, VaultAccounts};

/// The router's four fixed accounts, then this strategy's own, in the order `metadata.json`'s
/// `init` lists them.
#[derive(Accounts)]
pub struct InitMarket<'info> {
    /// The router's market PDA for this market state; checked in the handler.
    pub market_signer: Signer<'info>,
    /// A fresh keypair the creator signs with (`init.market_state` is `new_keypair`).
    #[account(init, payer = payer, space = MARKET_STATE_SIZE)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// A router PDA holding the SOL the creator allowed for setup. Rent comes from it; the
    /// router returns what is left to the creator.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// The token, index 0. Its extensions are checked against the allowlist before the
    /// vaults are created.
    #[account(
        mint::token_program = token_program,
        constraint = !is_wrapped_sol(&token_mint.key()) @ StrategyError::SameMint,
    )]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Wrapped SOL, index 1.
    #[account(address = native_mint::ID @ StrategyError::WrongAccount, mint::token_program = sol_token_program)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the PDA `["authority", market_state]`, which owns both vaults and signs every
    /// transfer and burn out of them; it holds nothing itself.
    #[account(seeds = [b"authority", market_state.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: the token vault, the PDA `["vault", market_state, token_mint]`; created by the
    /// handler once the parameters and the mint rules have been checked (`vaults.rs`).
    #[account(mut, seeds = [b"vault", market_state.key().as_ref(), token_mint.key().as_ref()], bump)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: the SOL vault, the PDA `["vault", market_state, wsol_mint]`; created like the
    /// token vault.
    #[account(mut, seeds = [b"vault", market_state.key().as_ref(), wsol_mint.key().as_ref()], bump)]
    pub sol_vault: UncheckedAccount<'info>,
    /// The token's program, SPL Token or Token-2022.
    pub token_program: Interface<'info, TokenInterface>,
    /// SPL Token, wrapped SOL's program.
    pub sol_token_program: Program<'info, Token>,
}

pub fn handle_init_market(ctx: Context<InitMarket>, data: Vec<u8>) -> Result<()> {
    let params = InitParams::decode(&data)?;
    let accounts = &ctx.accounts;
    let market_state = accounts.market_state.key();
    let new_market = NewMarket {
        market_state,
        payer: accounts.payer.to_account_info(),
        system_program: accounts.system_program.to_account_info(),
        token_mint: accounts.token_mint.to_account_info(),
        wsol_mint: accounts.wsol_mint.to_account_info(),
        vault_authority: accounts.vault_authority.to_account_info(),
        token_vault: accounts.token_vault.to_account_info(),
        sol_vault: accounts.sol_vault.to_account_info(),
        token_program: accounts.token_program.to_account_info(),
        sol_token_program: accounts.sol_token_program.to_account_info(),
        bumps: MarketBumps {
            authority: ctx.bumps.vault_authority,
            token_vault: ctx.bumps.token_vault,
            sol_vault: ctx.bumps.sol_vault,
        },
    };
    new_market.check(&params)?;

    // Remember which router market may call `pipeline_swap` on this market (Pipeline's
    // rule 4). Only the router can sign as this PDA.
    require_keys_eq!(
        accounts.market_signer.key(),
        pipeline_market_signer(&market_state),
        StrategyError::NotPipeline
    );

    new_market.create_vaults()?;
    let mut state = accounts.market_state.load_init()?;
    new_market.record(&mut state, &params, &Clock::get()?);
    Ok(())
}

/// The bumps of a new market's PDAs.
pub struct MarketBumps {
    pub authority: u8,
    pub token_vault: u8,
    pub sol_vault: u8,
}

/// A market being created, through the router (`pipeline_init_market`) or by another
/// program (`pipeline_seed_liquidity`): both run exactly this code, so a seeded market is
/// held to every creation rule and mint rule a created one is, and is recorded the same way.
/// Each instruction's own constraints check the accounts first.
pub struct NewMarket<'info> {
    pub market_state: Pubkey,
    pub payer: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    pub token_mint: AccountInfo<'info>,
    pub wsol_mint: AccountInfo<'info>,
    pub vault_authority: AccountInfo<'info>,
    pub token_vault: AccountInfo<'info>,
    pub sol_vault: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub sol_token_program: AccountInfo<'info>,
    pub bumps: MarketBumps,
}

impl NewMarket<'_> {
    /// Every creation rule (`InitParams::validate`), then the suite's mint rules.
    pub fn check(&self, params: &InitParams) -> Result<()> {
        params.validate()?;
        check_token_mint(&self.token_mint)
    }

    /// Both vaults, idempotently; call it once the token is known to be acceptable.
    pub fn create_vaults(&self) -> Result<()> {
        let market_state_seed = self.market_state.to_bytes();
        for (vault, mint, token_program, bump) in [
            (
                &self.token_vault,
                &self.token_mint,
                &self.token_program,
                self.bumps.token_vault,
            ),
            (
                &self.sol_vault,
                &self.wsol_mint,
                &self.sol_token_program,
                self.bumps.sol_vault,
            ),
        ] {
            let mint_seed = mint.key.to_bytes();
            create_vault(
                VaultAccounts {
                    payer: &self.payer,
                    vault,
                    mint,
                    authority: &self.vault_authority,
                    token_program,
                    system_program: &self.system_program,
                },
                &[b"vault", &market_state_seed, &mint_seed, &[bump]],
            )?;
        }
        Ok(())
    }

    /// Writes the new market state, created and waiting for its seed, with the router's
    /// market PDA as the only signer `pipeline_swap` accepts, and emits `MarketCreated`.
    pub fn record(&self, state: &mut MarketState, params: &InitParams, clock: &Clock) {
        state.layout_version = LAYOUT_VERSION;
        state.status = STATUS_CREATED;
        state.authority_bump = self.bumps.authority;
        state.token_vault_bump = self.bumps.token_vault;
        state.sol_vault_bump = self.bumps.sol_vault;
        state.market_signer = pipeline_market_signer(&self.market_state);
        state.token_mint = self.token_mint.key();
        state.wsol_mint = self.wsol_mint.key();
        state.token_vault = self.token_vault.key();
        state.sol_vault = self.sol_vault.key();
        state.seeder = params.seeder;
        state.set_creation_slot(clock.slot);
        state.set_creation_time(clock.unix_timestamp);
        state.set_fee_bps(params.fee_bps);
        state.set_wall_split_bps(params.wall_split_bps);
        state.set_reward_share_bps(params.reward_share_bps);
        state.fee_recipient = params.fee_recipient;
        state.rewards_recipient = params.rewards_recipient;
        state.set_cap_floor_bps(params.cap_floor_bps);
        state.set_cap_decay_bps(params.cap_decay_bps);

        emit!(MarketCreated {
            market_state: self.market_state,
            token_mint: state.token_mint,
            params: params.clone(),
            creation_slot: clock.slot,
            creation_time: clock.unix_timestamp,
        });
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

/// Whether `mint` is wrapped SOL, SPL Token's or Token-2022's: either would pair SOL with
/// SOL.
pub(crate) fn is_wrapped_sol(mint: &Pubkey) -> bool {
    *mint == native_mint::ID || *mint == anchor_spl::token_2022::spl_token_2022::native_mint::ID
}

/// The suite's mint rules (the shared `mint-rules` crate, `POOL4-17`): a Token-2022 token
/// may carry only the allowlisted extensions, and every other one is refused, including any
/// this program does not recognise. The buy wall AMM's stricter rule, that the mint and
/// freeze authorities are removed, is checked at the seed.
fn check_token_mint(mint: &AccountInfo) -> Result<()> {
    let data = mint.try_borrow_data()?;
    mint_rules::check_mint(&mint.owner.to_bytes(), &data).map_err(|refusal| match refusal {
        mint_rules::MintRefusal::ExtensionNotAllowed(extension) => {
            msg!("Mint {} carries refused extension {}", mint.key, extension);
            error!(StrategyError::MintExtensionNotAllowed)
        }
        // Anchor has already checked it is a mint of the token program passed.
        mint_rules::MintRefusal::NotATokenProgram | mint_rules::MintRefusal::NotAMint => {
            error!(StrategyError::WrongAccount)
        }
    })
}
