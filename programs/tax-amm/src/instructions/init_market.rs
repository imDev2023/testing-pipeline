//! `pipeline_init_market`: creates a tax market. The router calls it from `create_market`,
//! which anyone can call (docs/spec/tax-amm.md, "Markets").
//!
//! It refuses every market that breaks a rule, checks and stores the router's market signer,
//! creates the two vaults and records the creation slot and time. The creator's own
//! signature never reaches it, so it can't take tokens from them; liquidity comes from the
//! seed, which the seeder signs directly.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_2022::{self, GetAccountDataSize, InitializeAccount3};
use anchor_spl::token_interface::TokenInterface;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::events::MarketCreated;
use crate::params::{check_wallets, own_addresses, InitParams};
use crate::state::{
    MarketStatus, TaxMarket, AUTHORITY_SEED, RESERVED_LEN, STATE_VERSION, VAULT_SEED,
};

/// The router's four fixed accounts, then the tax AMM's own, in the order `metadata.json`'s
/// `init.accounts` lists them.
#[derive(Accounts)]
pub struct InitMarket<'info> {
    /// The router's market PDA for this market state.
    pub market_signer: Signer<'info>,
    /// A fresh keypair the creator generated, which signs (metadata `new_keypair`). The
    /// router passes its signature on only while the account is empty and unfunded.
    #[account(init, payer = payer, space = TaxMarket::SPACE)]
    pub market_state: Account<'info, TaxMarket>,
    /// A router PDA holding the SOL the creator allowed for setup. Rent comes from it; the
    /// router returns what is left to the creator.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: checked against the mint rules by the handler, before any vault exists.
    pub mint_0: UncheckedAccount<'info>,
    /// CHECK: checked against the mint rules by the handler, before any vault exists.
    pub mint_1: UncheckedAccount<'info>,
    /// CHECK: the vault authority PDA, which owns both vaults; it holds no data.
    #[account(seeds = [AUTHORITY_SEED, market_state.key().as_ref()], bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the vault PDA for mint 0, created by the handler.
    #[account(mut, seeds = [VAULT_SEED, market_state.key().as_ref(), mint_0.key().as_ref()], bump)]
    pub vault_0: UncheckedAccount<'info>,
    /// CHECK: the vault PDA for mint 1, created by the handler.
    #[account(mut, seeds = [VAULT_SEED, market_state.key().as_ref(), mint_1.key().as_ref()], bump)]
    pub vault_1: UncheckedAccount<'info>,
    pub token_program_0: Interface<'info, TokenInterface>,
    pub token_program_1: Interface<'info, TokenInterface>,
}

pub fn init_market(ctx: Context<InitMarket>, data: Vec<u8>) -> Result<()> {
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
    let market = NewMarket {
        market_state,
        market_signer,
        payer: &accounts.payer,
        system_program: &accounts.system_program,
        mints: [&accounts.mint_0, &accounts.mint_1],
        token_programs: [&accounts.token_program_0, &accounts.token_program_1],
        authority: &accounts.authority,
        authority_bump: ctx.bumps.authority,
        vaults: [&accounts.vault_0, &accounts.vault_1],
        vault_bumps: [ctx.bumps.vault_0, ctx.bumps.vault_1],
    }
    .create(&params)?;
    ctx.accounts.market_state.set_inner(market);
    Ok(())
}

/// What creating a tax market needs, whichever way it is created: through the router's
/// `create_market` (`pipeline_init_market`) or by a launchpad (`pipeline_seed_liquidity`).
/// Both create every market through [`NewMarket::create`], so one piece of code applies
/// every creation rule and mint rule to both.
pub(crate) struct NewMarket<'a, 'info> {
    pub market_state: Pubkey,
    /// The router's market PDA for `market_state`, the only caller allowed to swap.
    pub market_signer: Pubkey,
    pub payer: &'a Signer<'info>,
    pub system_program: &'a Program<'info, System>,
    pub mints: [&'a UncheckedAccount<'info>; 2],
    pub token_programs: [&'a Interface<'info, TokenInterface>; 2],
    pub authority: &'a UncheckedAccount<'info>,
    pub authority_bump: u8,
    pub vaults: [&'a UncheckedAccount<'info>; 2],
    pub vault_bumps: [u8; 2],
}

impl NewMarket<'_, '_> {
    /// Refuses a market that breaks a creation rule or a mint rule, then creates both vaults
    /// and emits `MarketCreated`. Returns the new market state, created and not yet open,
    /// for the caller to store.
    pub(crate) fn create(self, params: &InitParams) -> Result<TaxMarket> {
        let mints = self.mints.map(|mint| mint.key());
        require_keys_neq!(mints[0], mints[1], StrategyError::EqualMints);
        for i in 0..2 {
            check_mint(self.mints[i], self.token_programs[i])?;
        }
        params.validate(&mints)?;
        let vaults = self.vaults.map(|vault| vault.key());
        check_wallets(
            &params.recipients,
            &own_addresses(
                &self.market_state,
                &self.authority.key(),
                &mints,
                &vaults,
                &self.market_signer,
            ),
        )?;

        for i in 0..2 {
            let bump = [self.vault_bumps[i]];
            let seeds: &[&[u8]] = &[
                VAULT_SEED,
                self.market_state.as_ref(),
                self.mints[i].key.as_ref(),
                &bump,
            ];
            create_vault(
                self.payer,
                self.system_program,
                self.vaults[i],
                self.mints[i],
                self.authority,
                self.token_programs[i],
                seeds,
            )?;
        }

        let clock = Clock::get()?;
        emit!(MarketCreated {
            market_state: self.market_state,
            mints,
            vaults,
            params: *params,
            created_slot: clock.slot,
            created_at: clock.unix_timestamp,
        });
        Ok(TaxMarket {
            version: STATE_VERSION,
            status: MarketStatus::Created,
            tax_side: params.tax_side,
            virtual_side: params.virtual_side,
            authority_bump: self.authority_bump,
            tax_authority_renounced: false,
            mints,
            vaults,
            market_signer: self.market_signer,
            buy_tax_bps: params.buy_tax_bps,
            sell_tax_bps: params.sell_tax_bps,
            buy_tax_min_bps: params.buy_tax_min_bps,
            buy_tax_max_bps: params.buy_tax_max_bps,
            sell_tax_min_bps: params.sell_tax_min_bps,
            sell_tax_max_bps: params.sell_tax_max_bps,
            tax_authority: params.tax_authority,
            seeder: params.seeder,
            recipients: params.recipients,
            shares: params.shares,
            burn_share_bps: params.burn_share_bps,
            virtual_reserve: params.virtual_reserve,
            reserves: [0; 2],
            owed: Default::default(),
            tax_collected: 0,
            volume: [0; 2],
            swap_count: 0,
            created_slot: clock.slot,
            created_at: clock.unix_timestamp,
            reserved: [0; RESERVED_LEN],
        })
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

/// Refuses a mint its token program doesn't own, one the shared mint rules refuse, or one
/// whose transfer hook the tax AMM's own rules refuse ([`crate::mint_levers`]).
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
    })?;
    crate::mint_levers::check_transfer_hook(mint.key, &data).map_err(|refusal| {
        msg!("Mint {} has a transfer hook a market refuses", mint.key);
        error!(refusal)
    })
}

/// Creates a vault: a token account of `mint` at its PDA, owned by the vault authority,
/// sized by the token program for the mint's extensions. Lamports someone sent to the
/// address beforehand don't block it.
fn create_vault<'info>(
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    vault: &UncheckedAccount<'info>,
    mint: &UncheckedAccount<'info>,
    authority: &UncheckedAccount<'info>,
    token_program: &Interface<'info, TokenInterface>,
    seeds: &[&[u8]],
) -> Result<()> {
    let space = token_2022::get_account_data_size(
        CpiContext::new(
            token_program.key(),
            GetAccountDataSize {
                mint: mint.to_account_info(),
            },
        ),
        &[],
    )?;
    create_pda_account(
        payer,
        system_program,
        vault,
        space,
        &token_program.key(),
        seeds,
    )?;
    token_2022::initialize_account3(CpiContext::new(
        token_program.key(),
        InitializeAccount3 {
            account: vault.to_account_info(),
            mint: mint.to_account_info(),
            authority: authority.to_account_info(),
        },
    ))
}

/// Creates an account at a PDA of this program, owned by `owner`, as Anchor's `init` does:
/// `create_account` when it holds nothing, otherwise topping it up to rent exemption and
/// allocating and assigning it, so a pre-funded address can't block creation.
fn create_pda_account<'info>(
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    account: &UncheckedAccount<'info>,
    space: u64,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(space as usize);
    let signer_seeds = &[seeds];
    let program = system_program.key();
    let lamports = account.lamports();
    if lamports == 0 {
        return system_program::create_account(
            CpiContext::new_with_signer(
                program,
                system_program::CreateAccount {
                    from: payer.to_account_info(),
                    to: account.to_account_info(),
                },
                signer_seeds,
            ),
            rent,
            space,
            owner,
        );
    }
    let top_up = rent.saturating_sub(lamports);
    if top_up > 0 {
        system_program::transfer(
            CpiContext::new(
                program,
                system_program::Transfer {
                    from: payer.to_account_info(),
                    to: account.to_account_info(),
                },
            ),
            top_up,
        )?;
    }
    system_program::allocate(
        CpiContext::new_with_signer(
            program,
            system_program::Allocate {
                account_to_allocate: account.to_account_info(),
            },
            signer_seeds,
        ),
        space,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            program,
            system_program::Assign {
                account_to_assign: account.to_account_info(),
            },
            signer_seeds,
        ),
        owner,
    )
}
