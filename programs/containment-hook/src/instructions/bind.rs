//! `bind`: binds a Token-2022 mint to its one home market, once and for good
//! (docs/spec/containment-hook.md, "Binding").
//!
//! Signed by the mint's mint authority, so only the launcher can bind and nobody can
//! front-run them. It creates the config and the validation account, so a second `bind` of
//! the same mint fails, and no instruction changes the config afterwards. Before writing
//! anything it checks the mint, the unlock terms, the home market, which must not have
//! collected any tax yet, and its quote mint; the vault and the fee account are read from the router's `Market`
//! and derived, never taken from the caller.

use anchor_lang::prelude::*;

use crate::config::TAX_AMM_PROGRAM_ID;
use crate::errors::HookError;
use crate::mint::{read_mint, MintFacts};
use crate::router::{self, RouterMarket, ROUTER_PROGRAM_ID};
use crate::state::{
    Config, CONFIG_SEED, CONFIG_VERSION, EXTRA_ACCOUNT_METAS_SEED, UNLOCK_SEED, VALIDATION_DATA,
    VALIDATION_LEN,
};
use crate::tax_market;
use crate::terms::{check_terms, TermsRefusal};

#[derive(Accounts)]
pub struct Bind<'info> {
    /// The mint's mint authority: only the launcher can bind a mint.
    pub mint_authority: Signer<'info>,
    /// Pays the rent of the config and the validation account.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The mint to contain.
    /// CHECK: every check on it is the handler's.
    pub mint: UncheckedAccount<'info>,
    /// Created here, so a second `bind` of the same mint fails.
    #[account(init, payer = payer, space = Config::SPACE, seeds = [CONFIG_SEED, mint.key().as_ref()], bump)]
    pub config: Account<'info, Config>,
    /// The validation account, created here and written by the handler.
    /// CHECK: it is created at its PDA and written whole.
    #[account(init, payer = payer, space = VALIDATION_LEN, seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_metas: UncheckedAccount<'info>,
    /// The unlock PDA, which must be the mint's transfer hook authority; it holds no data.
    /// CHECK: only its address is used, derived from its seeds.
    #[account(seeds = [UNLOCK_SEED, mint.key().as_ref()], bump)]
    pub unlock: UncheckedAccount<'info>,
    /// The home market: the router's `Market` account.
    /// CHECK: every check on it is the handler's.
    pub market: UncheckedAccount<'info>,
    /// The tax AMM market state the `Market` records.
    /// CHECK: every check on it is the handler's.
    pub market_state: UncheckedAccount<'info>,
    /// The home market's other mint, which its tax and the unlock goal are counted in.
    /// CHECK: the handler checks it is the market's other mint, then its hook and authorities.
    pub quote_mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn process_bind(ctx: Context<Bind>, unlock_goal: u64, unlock_deadline: i64) -> Result<()> {
    let accounts = &ctx.accounts;
    let mint = accounts.mint.key();
    check_mint(
        &accounts.mint,
        &accounts.mint_authority,
        &accounts.unlock.key(),
    )?;

    let clock = Clock::get()?;
    check_terms(clock.unix_timestamp, unlock_goal, unlock_deadline).map_err(
        |refusal| match refusal {
            TermsRefusal::ZeroGoal => error!(HookError::ZeroGoal),
            TermsRefusal::DeadlineNotInFuture => error!(HookError::DeadlineNotInFuture),
            TermsRefusal::DeadlineTooFar => error!(HookError::DeadlineTooFar),
        },
    )?;

    let home = check_home_market(&accounts.market, &accounts.market_state, &mint)?;
    check_quote_mint(&accounts.quote_mint, &home.quote_mint)?;

    ctx.accounts
        .extra_account_metas
        .try_borrow_mut_data()?
        .copy_from_slice(&VALIDATION_DATA);
    ctx.accounts.config.set_inner(Config {
        version: CONFIG_VERSION,
        mint,
        market: ctx.accounts.market.key(),
        market_state: ctx.accounts.market_state.key(),
        vault: home.vault,
        fee_account: home.fee_account,
        quote_mint: home.quote_mint,
        unlock_goal,
        unlock_deadline,
        bound_at: clock.unix_timestamp,
        config_bump: ctx.bumps.config,
        extra_account_metas_bump: ctx.bumps.extra_account_metas,
        unlock_bump: ctx.bumps.unlock,
        unlocked_at: None,
    });
    Ok(())
}

/// Checks on the mint (docs/spec/containment-hook.md, "Checks on the mint"): owned by
/// Token-2022, only the shared allowlist's extensions, no freeze authority, `signer` as its
/// mint authority, and this program as its transfer hook with `unlock` as hook authority.
/// A mint authority that is a Token-2022 multisig is refused: its account's address can sign
/// only through the keypair it was created at, which would bind without its other signers.
fn check_mint(mint: &UncheckedAccount, signer: &Signer, unlock: &Pubkey) -> Result<()> {
    require_keys_eq!(
        *mint.owner,
        anchor_spl::token_2022::ID,
        HookError::MintNotToken2022
    );
    let data = mint.try_borrow_data()?;
    mint_rules::check_mint(&mint.owner.to_bytes(), &data).map_err(|refusal| match refusal {
        mint_rules::MintRefusal::ExtensionNotAllowed(extension) => {
            msg!("Mint {} carries refused extension {}", mint.key, extension);
            error!(HookError::MintExtensionNotAllowed)
        }
        mint_rules::MintRefusal::NotATokenProgram | mint_rules::MintRefusal::NotAMint => {
            error!(HookError::NotAMint)
        }
    })?;
    let MintFacts {
        mint_authority,
        freeze_authority,
        transfer_hook,
    } = read_mint(&data).ok_or(HookError::NotAMint)?;
    // Freezing the home market's vault would trap every holder with nowhere else to sell.
    require!(freeze_authority.is_none(), HookError::FreezeAuthoritySet);
    require!(
        mint_authority == Some(signer.key().to_bytes()),
        HookError::NotMintAuthority
    );
    require_keys_neq!(
        *signer.owner,
        anchor_spl::token_2022::ID,
        HookError::MintAuthorityIsMultisig
    );
    let hook = transfer_hook.ok_or(HookError::WrongHookProgram)?;
    require!(
        hook.program == Some(crate::ID.to_bytes()),
        HookError::WrongHookProgram
    );
    require!(
        hook.authority == Some(unlock.to_bytes()),
        HookError::WrongHookAuthority
    );
    Ok(())
}

/// Checks on the quote mint (docs/spec/containment-hook.md, "Checks on the home market";
/// `HOOK-52`): the home market's other mint, with no live transfer hook (any program's, this
/// one's included), and, unless it is on the tax AMM's quote list, no mint or freeze authority,
/// by the tax AMM's own rule, so its issuer can neither refuse nor freeze the payouts every
/// holder's exit depends on.
fn check_quote_mint(quote: &UncheckedAccount, market_quote: &Pubkey) -> Result<()> {
    require_keys_eq!(
        quote.key(),
        *market_quote,
        HookError::QuoteMintNotTheMarkets
    );
    let data = quote.try_borrow_data()?;
    mint_rules::check_mint(&quote.owner.to_bytes(), &data)
        .map_err(|_| error!(HookError::NotAMint))?;
    let facts = read_mint(&data).ok_or(HookError::NotAMint)?;
    if let Some(hook) = facts.transfer_hook {
        require!(
            hook.program.is_none() && hook.authority.is_none(),
            HookError::QuoteMintHooked
        );
    }
    tax_amm::mint_levers::check_authorities(market_quote, &data)
        .map_err(|_| error!(HookError::QuoteMintHasAuthority))?;
    Ok(())
}

/// What `bind` records of a home market, besides the accounts it was given.
struct HomeMarket {
    vault: Pubkey,
    fee_account: Pubkey,
    quote_mint: Pubkey,
}

/// Checks on the home market (docs/spec/containment-hook.md, "Checks on the home market"):
/// a router `Market` at its PDA, on the tax AMM, trading `mint` against one quote mint, with
/// the market state it records, owned by the tax AMM and taking its tax in the quote mint.
/// Returns the vault the `Market` records for `mint` and the fee account derived for it.
fn check_home_market(
    market: &UncheckedAccount,
    market_state: &UncheckedAccount,
    mint: &Pubkey,
) -> Result<HomeMarket> {
    require_keys_eq!(
        *market.owner,
        ROUTER_PROGRAM_ID,
        HookError::NotARouterMarket
    );
    let recorded: RouterMarket =
        router::read_market(&market.try_borrow_data()?).ok_or(HookError::NotARouterMarket)?;
    require!(
        router::market_address(&recorded) == Some(market.key()),
        HookError::MarketNotAtItsAddress
    );
    require_keys_eq!(
        recorded.strategy,
        TAX_AMM_PROGRAM_ID,
        HookError::NotATaxMarket
    );
    let (contained, quote) = match recorded.mints() {
        [first, second] if first == mint => (0u8, *second),
        [first, second] if second == mint => (1u8, *first),
        _ => return err!(HookError::MarketDoesNotHoldMint),
    };
    require_keys_neq!(quote, *mint, HookError::MarketDoesNotHoldMint);

    require_keys_eq!(
        market_state.key(),
        recorded.market_state,
        HookError::WrongMarketState
    );
    require_keys_eq!(
        *market_state.owner,
        TAX_AMM_PROGRAM_ID,
        HookError::NotATaxMarketState
    );
    let state = market_state.try_borrow_data()?;
    let tax_side = tax_market::tax_side(&state).ok_or(HookError::NotATaxMarketState)?;
    // The goal is counted in the quote mint, never in the contained token, whose price the
    // launcher's supply sets.
    require!(tax_side == 1 - contained, HookError::TaxSideNotQuote);
    // The goal counts the tax collected under containment, from zero at the binding, so a
    // market that has already collected tax (traded under another hook, say) is refused.
    require!(
        tax_market::tax_collected(&state) == Some(0),
        HookError::MarketAlreadyCollectedTax
    );
    drop(state);

    let vault = *recorded
        .vaults
        .get(contained as usize)
        .ok_or(HookError::MarketDoesNotHoldMint)?;
    let fee_account =
        router::fee_account(&market.key(), &recorded, mint).ok_or(HookError::NotARouterMarket)?;
    Ok(HomeMarket {
        vault,
        fee_account,
        quote_mint: quote,
    })
}
