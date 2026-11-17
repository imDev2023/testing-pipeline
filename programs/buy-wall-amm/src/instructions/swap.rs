//! `pipeline_swap`: settles a trade the router sends (docs/spec/pool4-for-solana.md,
//! "Pricing", "After pricing", "The fee" and "Counters"), then brings the wall's guard up to
//! date ("After pricing" steps 1, 3 and 4, `guard.rs`) and the inventory cap ("After
//! pricing" steps 5 and 6, `cap.rs`).
//!
//! Only this market's router market may call it, so every trade pays Pipeline's fee, emits a
//! swap event and counts in the market's counters (bypass is refused: ADR 0001). The router
//! has just moved the trader's input into the input vault; this credits what arrived beyond
//! every ledger kept there, prices it with the same function as `pipeline_quote`, pays the
//! trader from the output vault, and books the trade. The input and the fee stay in the
//! vaults: nothing is refunded and nothing is paid out to a recipient during a swap.
//!
//! Remaining accounts: the output vault and the vault authority, as
//! `pipeline_resolve_accounts` lists them, then any transfer-hook accounts of the token,
//! which a buy's output transfer forwards.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenInterface;
use pipeline_strategy_interface as psi;

use crate::cap::Moved;
use crate::errors::StrategyError;
use crate::events::{CapLowered, Trimmed};
use crate::pricing::{self, Side};
use crate::state::{is_market_state, vault_authority, MarketState, AUTHORITY_SEED};
use crate::token::{token_balance, transfer_checked, Transfer};

/// The router's ten fixed trade accounts.
#[derive(Accounts)]
pub struct SwapAccounts<'info> {
    /// The router's market PDA; compared with the stored market signer.
    pub market_signer: Signer<'info>,
    #[account(mut, constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// CHECK: the trader's wallet, for identity only. It never signs here.
    pub trader: UncheckedAccount<'info>,
    /// CHECK: the router's; this strategy never refunds, so it is not used.
    #[account(mut)]
    pub trader_input: UncheckedAccount<'info>,
    /// CHECK: receives the output; the token program checks it. Never the output vault.
    #[account(mut)]
    pub trader_output: UncheckedAccount<'info>,
    /// CHECK: compared with the market's vault for the input mint.
    #[account(mut)]
    pub input_vault: UncheckedAccount<'info>,
    /// CHECK: compared with the market's mint at the input index.
    pub input_mint: UncheckedAccount<'info>,
    /// CHECK: compared with the market's mint at the output index.
    pub output_mint: UncheckedAccount<'info>,
    /// CHECK: the router's; the input transfer is the router's own.
    pub input_token_program: UncheckedAccount<'info>,
    /// SPL Token or Token-2022, and the owner of the output vault: the swap lends it the
    /// vault authority's signature, so it must be the vault's own program.
    pub output_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_swap<'info>(
    ctx: Context<'info, SwapAccounts<'info>>,
    request: crate::interface::SwapRequest,
) -> Result<()> {
    let market_state = ctx.accounts.market_state.key();
    let state = ctx.accounts.market_state.load()?;
    require_keys_eq!(
        ctx.accounts.market_signer.key(),
        state.market_signer,
        StrategyError::NotPipeline
    );
    let trade = &request.trade;
    let (input_vault, output_vault) = state.vaults(trade.input_index, trade.output_index)?;
    let mints = [state.token_mint, state.wsol_mint];
    let mint = |index: u8| {
        mints
            .get(index as usize)
            .copied()
            .ok_or(StrategyError::WrongAccount)
    };
    require_keys_eq!(
        ctx.accounts.input_vault.key(),
        input_vault,
        StrategyError::WrongAccount
    );
    require_keys_eq!(
        ctx.accounts.input_mint.key(),
        mint(trade.input_index)?,
        StrategyError::WrongAccount
    );
    require_keys_eq!(
        ctx.accounts.output_mint.key(),
        mint(trade.output_index)?,
        StrategyError::WrongAccount
    );
    let [output_vault_info, authority, hook_accounts @ ..] = ctx.remaining_accounts else {
        return err!(StrategyError::WrongAccount);
    };
    require_keys_eq!(
        output_vault_info.key(),
        output_vault,
        StrategyError::WrongAccount
    );
    require_keys_eq!(
        *output_vault_info.owner,
        ctx.accounts.output_token_program.key(),
        StrategyError::WrongAccount
    );
    // Paying the vault itself would move nothing while the market booked a payout.
    require_keys_neq!(
        ctx.accounts.trader_output.key(),
        output_vault,
        StrategyError::WrongAccount
    );
    // Signing with the wrong account would fail in the token program anyway; checking it
    // here names the mistake, as the tax AMM does (`POOL4-24`, `TAX-35`).
    let authority_bump = state.authority_bump;
    let authority_key =
        vault_authority(&market_state, authority_bump).ok_or(StrategyError::WrongAccount)?;
    require_keys_eq!(authority.key(), authority_key, StrategyError::WrongAccount);

    // Credit what arrived beyond every ledger kept in the input vault, capped at what the
    // router sent in this call, so a donation to either vault is never credited.
    let recorded = state
        .recorded(trade.input_index)
        .ok_or(StrategyError::Overflow)?;
    let vault_balance = token_balance(&ctx.accounts.input_vault.to_account_info())?;
    let credited = psi::credited_input(vault_balance, recorded, request.amount_sent);
    // The same function as `pipeline_quote`, books and counters included, so quotes and
    // swaps agree.
    let settled = pricing::settle(
        &state,
        &crate::interface::TradeRequest {
            amount: credited,
            ..trade.clone()
        },
    )?;
    // The token is the only mint a transfer hook can be on; wrapped SOL has none.
    let hook_accounts = match settled.priced.side {
        Side::Buy => hook_accounts,
        Side::Sell => &[],
    };
    let decimals = mint_decimals(&ctx.accounts.output_mint.to_account_info())?;
    drop(state);

    let bump = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_state.as_ref(), &bump];
    transfer_checked(
        Transfer {
            token_program: &ctx.accounts.output_token_program.to_account_info(),
            from: output_vault_info,
            mint: &ctx.accounts.output_mint.to_account_info(),
            to: &ctx.accounts.trader_output.to_account_info(),
            authority,
            hook_accounts,
        },
        settled.priced.amount_out,
        decimals,
        &[authority_seeds],
    )?;

    // "After pricing", in its order. None of it changes the trade just priced.
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let mut state = ctx.accounts.market_state.load_mut()?;
    // Step 1 and, at the slot's first update, step 4: the reference and the floor, which read
    // the last close, the price the slot opened at, before step 3 replaces it (`POOL4-50`).
    let guard = state
        .guard()
        .follow(clock.slot, now)
        .ok_or(StrategyError::Overflow)?;
    // Steps 2 and 3: the books, the price and the last close.
    state.set_books(&settled.books);
    state.set_sqrt_price(settled.priced.sqrt_price);
    state.set_guard(&guard.close_at(settled.priced.sqrt_price));

    // Steps 5 and 6: the decay credit, then the ratchet or the trim, at the price just set,
    // with the trimmed totals. They change neither the trade nor the price.
    let (inventory, moved) = state
        .inventory()
        .after_swap(state.cap_rules(), now)
        .ok_or(StrategyError::Overflow)?;
    state.set_inventory(&inventory);
    match moved {
        Moved::Nothing => {}
        Moved::Lowered { by, held } => emit!(CapLowered {
            market_state,
            cap: inventory.cap,
            lowered_by: by,
            held,
            decay_credit: inventory.decay_credit,
        }),
        Moved::Trimmed(trim) => emit!(Trimmed {
            market_state,
            tokens: trim.tokens,
            sol: trim.sol,
            liquidity: trim.liquidity,
            cap: inventory.cap,
        }),
    }

    // Step 7: the counters.
    state
        .set_counters(&settled.counters)
        .ok_or(StrategyError::Overflow)?;
    Ok(())
}

/// The decimals of the output mint, byte 44 of both token programs' mint layouts. The
/// account's key is the market's stored mint, so its data is that mint's.
fn mint_decimals(mint: &AccountInfo) -> Result<u8> {
    let data = mint.try_borrow_data()?;
    data.get(44)
        .copied()
        .ok_or_else(|| error!(StrategyError::WrongAccount))
}
