//! `seed { token_amount, sol_amount }`: the custom action that opens a market
//! (docs/spec/pool4-for-solana.md, "The seed"). Signed by the market's seeder, from token
//! accounts the seeder owns, allowed once.
//!
//! It records what actually arrived in each vault, `x` token units and `y` lamports, so
//! anything sent to a vault earlier stays a donation, and opens the market from them
//! (`opening::open`).

use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::StrategyError;
use crate::events::MarketSeeded;
use crate::opening;
use crate::state::{is_market_state, MarketState, STATUS_CREATED, STATUS_OPEN};
use crate::token::{transfer_measured, Transfer};

/// The order is part of `metadata.json`'s `seed` action; keep them in step. Remaining
/// accounts are the token's transfer-hook accounts.
#[derive(Accounts)]
pub struct Seed<'info> {
    /// The market's stored seeder; checked in the handler.
    pub seeder: Signer<'info>,
    #[account(mut, constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// The seeder's own token account (owned by the seeder, not merely delegated to them).
    #[account(mut, token::mint = token_mint, token::authority = seeder, token::token_program = token_program)]
    pub seeder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The seeder's own wrapped SOL account.
    #[account(mut, token::mint = wsol_mint, token::authority = seeder, token::token_program = sol_token_program)]
    pub seeder_sol: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: compared with the market state's token vault.
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: compared with the market state's SOL vault.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = sol_token_program)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub sol_token_program: Program<'info, Token>,
}

pub fn handle_seed<'info>(
    ctx: Context<'info, Seed<'info>>,
    token_amount: u64,
    sol_amount: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;
    {
        let state = accounts.market_state.load()?;
        require!(state.status == STATUS_CREATED, StrategyError::AlreadySeeded);
        require_keys_eq!(
            accounts.seeder.key(),
            state.seeder,
            StrategyError::NotSeeder
        );
        require_keys_eq!(
            accounts.token_vault.key(),
            state.token_vault,
            StrategyError::WrongAccount
        );
        require_keys_eq!(
            accounts.sol_vault.key(),
            state.sol_vault,
            StrategyError::WrongAccount
        );
        require_keys_eq!(
            accounts.token_mint.key(),
            state.token_mint,
            StrategyError::WrongAccount
        );
        require_keys_eq!(
            accounts.wsol_mint.key(),
            state.wsol_mint,
            StrategyError::WrongAccount
        );
    }

    let (x, y) = bring_seed(
        SeedSource {
            seeder: &accounts.seeder.to_account_info(),
            token_from: &accounts.seeder_token.to_account_info(),
            sol_from: &accounts.seeder_sol.to_account_info(),
            token_vault: &accounts.token_vault.to_account_info(),
            sol_vault: &accounts.sol_vault.to_account_info(),
            token_mint: &accounts.token_mint,
            wsol_mint: &accounts.wsol_mint,
            token_program: &accounts.token_program.to_account_info(),
            sol_token_program: &accounts.sol_token_program.to_account_info(),
            hook_accounts: ctx.remaining_accounts,
        },
        token_amount,
        sol_amount,
    )?;

    let mut state = accounts.market_state.load_mut()?;
    open_market(
        &mut state,
        accounts.market_state.key(),
        x,
        y,
        &Clock::get()?,
    )
}

/// Where a seed comes from and goes to: the seeder's own token accounts (the escrows, when
/// another program seeds), signed for by the seeder, into the market's vaults.
pub struct SeedSource<'a, 'info> {
    pub seeder: &'a AccountInfo<'info>,
    pub token_from: &'a AccountInfo<'info>,
    pub sol_from: &'a AccountInfo<'info>,
    pub token_vault: &'a AccountInfo<'info>,
    pub sol_vault: &'a AccountInfo<'info>,
    pub token_mint: &'a InterfaceAccount<'info, Mint>,
    pub wsol_mint: &'a InterfaceAccount<'info, Mint>,
    pub token_program: &'a AccountInfo<'info>,
    pub sol_token_program: &'a AccountInfo<'info>,
    /// The token's transfer-hook accounts.
    pub hook_accounts: &'a [AccountInfo<'info>],
}

/// Refuses the seed unless the token's mint and freeze authorities are removed and its
/// transfer hook, if it has one, is cleared, then transfers `token_amount` and
/// `sol_amount` into the vaults and returns what actually arrived in each, `x` token units
/// and `y` lamports, so anything sent to a vault earlier stays a donation. Every path that
/// seeds a market brings its seed through this.
pub fn bring_seed(source: SeedSource, token_amount: u64, sol_amount: u64) -> Result<(u64, u64)> {
    check_authorities_removed(source.token_mint)?;
    let x = transfer_measured(
        Transfer {
            token_program: source.token_program,
            from: source.token_from,
            mint: &source.token_mint.to_account_info(),
            to: source.token_vault,
            authority: source.seeder,
            hook_accounts: source.hook_accounts,
        },
        token_amount,
        source.token_mint.decimals,
    )?;
    let y = transfer_measured(
        Transfer {
            token_program: source.sol_token_program,
            from: source.sol_from,
            mint: &source.wsol_mint.to_account_info(),
            to: source.sol_vault,
            authority: source.seeder,
            hook_accounts: &[],
        },
        sol_amount,
        source.wsol_mint.decimals,
    )?;
    Ok((x, y))
}

/// The token's mint and freeze authorities must both be removed before a seed: a live mint
/// authority could mint and sell into the curve and the wall, and a live freeze authority
/// could freeze the vault (the spec's "Mint rules"). So must a Token-2022 token's transfer
/// hook, both its program and its authority (`POOL4-48`): whoever could still set the hook
/// could make it refuse every sell but their own.
fn check_authorities_removed(token_mint: &InterfaceAccount<'_, Mint>) -> Result<()> {
    require!(
        token_mint.mint_authority.is_none(),
        StrategyError::MintAuthorityLive
    );
    require!(
        token_mint.freeze_authority.is_none(),
        StrategyError::FreezeAuthorityLive
    );
    let info = token_mint.to_account_info();
    let data = info.try_borrow_data()?;
    require!(
        transfer_hook_cleared(&data),
        StrategyError::TransferHookLive
    );
    Ok(())
}

/// Whether a mint's `data` carries no live transfer hook: no TransferHook extension at all
/// (an SPL Token mint, or a Token-2022 mint without one), or one whose value, the hook
/// authority then the hook program (32 bytes each, zero for none), is all zeros, the state
/// a contained token reaches after its unlock. Once both are unset Token-2022 can never set
/// them again. The extension is read through the shared `mint-rules` crate, which already
/// walked this mint's entries at creation.
fn transfer_hook_cleared(data: &[u8]) -> bool {
    match mint_rules::find_extension(data, mint_rules::extension::TRANSFER_HOOK) {
        None => true,
        Some(hook) => hook.len() == TRANSFER_HOOK_LEN && hook.iter().all(|&b| b == 0),
    }
}

/// The length of Token-2022's TransferHook extension value: an optional authority and an
/// optional program, 32 bytes each.
const TRANSFER_HOOK_LEN: usize = 64;

/// Opens a created market from what its seed brought, `x` token units and `y` lamports
/// (`opening::open`, refusing a seed the spec refuses), and emits `MarketSeeded`. Both
/// `seed` and `pipeline_seed_liquidity` open a market through this.
pub fn open_market(
    state: &mut MarketState,
    market_state: Pubkey,
    x: u64,
    y: u64,
    clock: &Clock,
) -> Result<()> {
    let opened = opening::open(x, y, state.cap_floor_bps(), state.cap_decay_bps())
        .map_err(StrategyError::from)?;
    let now = clock.unix_timestamp;
    state.status = STATUS_OPEN;
    state.set_seed_time(now);
    state.set_seeded_tokens(x);
    state.set_cap_floor(opened.cap_floor);
    state.set_cap_decay_per_day(opened.cap_decay_per_day);
    state.set_sqrt_price(opened.sqrt_price);
    state.set_liquidity(opened.liquidity);
    state.set_pool_tokens(x);
    state.set_pool_sol(y);
    state.set_cap(opened.cap);
    state.set_decay_time(now);
    // The wall guard starts at the opening price, and every clock field at now.
    state.set_reference(opened.sqrt_price);
    state.set_ref_time(now);
    state.set_floor(opened.sqrt_price);
    state.set_floor_time(now);
    state.set_last_slot(clock.slot);
    state.set_last_close(opened.sqrt_price);

    emit!(MarketSeeded {
        market_state,
        token_amount: x,
        sol_amount: y,
        sqrt_price: opened.sqrt_price,
        liquidity: opened.liquidity,
        cap: opened.cap,
        cap_floor: opened.cap_floor,
        cap_decay_per_day: opened.cap_decay_per_day,
        seed_time: now,
    });
    Ok(())
}
