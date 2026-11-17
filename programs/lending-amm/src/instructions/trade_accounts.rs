//! The router's ten fixed trade accounts, which quotes, account resolution and swaps all
//! receive first, and the strategy's own accounts after them, with the pricing both quotes and
//! swaps go through.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::config::{self, KLEND_PROGRAM};
use crate::errors::StrategyError;
use crate::interface::TradeRequest;
use crate::kamino::{self, KaminoAccounts, Reserve};
use crate::pricing::{self, Quote};
use crate::state::LendingAmmMarket;

/// How many Kamino accounts a redeeming swap passes after the reserve ([`RedeemAccounts`]).
pub const REDEEM_ACCOUNTS: usize = 8;

/// The strategy accounts a quote or swap receives after the router's ten, in the order
/// `pipeline_resolve_accounts` lists them: the output vault, the vault authority and the
/// Kamino reserve the lent side lends to, then, for a trade whose quote redeems from Kamino,
/// the redeem accounts ([`RedeemAccounts`]), then anything else, such as the output mint's
/// transfer-hook accounts.
pub struct StrategyAccounts<'a, 'info> {
    pub output_vault: &'a AccountInfo<'info>,
    pub authority: &'a AccountInfo<'info>,
    /// The reserve's account.
    pub reserve_account: &'a AccountInfo<'info>,
    /// The reserve, checked and read.
    pub reserve: Reserve,
    /// The redeem accounts, when the trade was built with them.
    pub redeem: Option<RedeemAccounts<'a, 'info>>,
    pub rest: &'a [AccountInfo<'info>],
}

/// The Kamino accounts a swap that redeems its shortfall passes after the reserve, in the order
/// `pipeline_resolve_accounts` lists them (docs/spec/lending-pool.md, "Accounts"). They are
/// checked only when the trade's quote needs a redeem, before any is passed to klend
/// ([`StrategyAccounts::kamino_can_pay`]).
pub struct RedeemAccounts<'a, 'info> {
    pub klend_program: &'a AccountInfo<'info>,
    pub lending_market: &'a AccountInfo<'info>,
    pub lending_market_authority: &'a AccountInfo<'info>,
    pub liquidity_supply: &'a AccountInfo<'info>,
    pub collateral_mint: &'a AccountInfo<'info>,
    /// The market's own cToken account, whose cTokens the redeem burns.
    pub ctoken_account: &'a AccountInfo<'info>,
    /// SPL Token, the program of the lent mint and of every cToken mint.
    pub token_program: &'a AccountInfo<'info>,
    pub instructions_sysvar: &'a AccountInfo<'info>,
}

/// Splits `remaining` into [`StrategyAccounts`] for a trade paying out mint `output`, checking
/// the reserve before reading it. A trade built without the reserve fails the check with
/// `ReserveWrongAddress`, whatever account sits in its place.
///
/// The redeem accounts are recognised by klend's program id where they start, and only for a
/// lent-side output: a lent mint has no transfer hook, so nothing else follows the reserve
/// there, while after an other-side output's reserve come that mint's hook accounts.
pub fn strategy_accounts<'a, 'info>(
    market: &LendingAmmMarket,
    remaining: &'a [AccountInfo<'info>],
    output: usize,
) -> Result<StrategyAccounts<'a, 'info>> {
    let [output_vault, authority, rest @ ..] = remaining else {
        return err!(StrategyError::WrongAccount);
    };
    let (reserve_account, rest) = rest
        .split_first()
        .ok_or(StrategyError::ReserveWrongAddress)?;
    let reserve = kamino::reserve_of(&market.lent_mint(), reserve_account)?;
    let starts_redeem = rest.first().is_some_and(|a| *a.key == KLEND_PROGRAM);
    let (redeem, rest) = match rest {
        [klend_program, lending_market, lending_market_authority, liquidity_supply, collateral_mint, ctoken_account, token_program, instructions_sysvar, rest @ ..]
            if output == market.lent_side() && starts_redeem =>
        {
            let redeem = RedeemAccounts {
                klend_program,
                lending_market,
                lending_market_authority,
                liquidity_supply,
                collateral_mint,
                ctoken_account,
                token_program,
                instructions_sysvar,
            };
            (Some(redeem), rest)
        }
        _ if output == market.lent_side() && starts_redeem => {
            return err!(StrategyError::KaminoAccountWrong)
        }
        _ => (None, rest),
    };
    Ok(StrategyAccounts {
        output_vault,
        authority,
        reserve_account,
        reserve,
        redeem,
        rest,
    })
}

impl<'a, 'info> StrategyAccounts<'a, 'info> {
    /// klend's accounts for redeeming the lent mint `liquidity_mint`, the trade's output mint,
    /// from the redeem accounts; refused when the trade was built without them.
    pub fn kamino(
        &self,
        liquidity_mint: &'a AccountInfo<'info>,
    ) -> Result<(KaminoAccounts<'a, 'info>, &'a AccountInfo<'info>)> {
        let redeem = self
            .redeem
            .as_ref()
            .ok_or(StrategyError::RedeemAccountsMissing)?;
        let kamino = KaminoAccounts {
            klend_program: redeem.klend_program,
            reserve: self.reserve_account,
            lending_market: redeem.lending_market,
            lending_market_authority: redeem.lending_market_authority,
            liquidity_mint,
            liquidity_supply: redeem.liquidity_supply,
            collateral_mint: redeem.collateral_mint,
            token_program: redeem.token_program,
            instructions_sysvar: redeem.instructions_sysvar,
        };
        Ok((kamino, redeem.ctoken_account))
    }

    /// What Kamino can pay `market` right now for a swap's redeem, from the redeem accounts,
    /// each checked against the lent mint's entry in `LENT_MINTS` ([`KaminoAccounts::check`]),
    /// the cToken account against the market's own; refused when the trade was built without
    /// them.
    pub fn kamino_can_pay(
        &self,
        market: &LendingAmmMarket,
        liquidity_mint: &'a AccountInfo<'info>,
    ) -> Result<u64> {
        let (kamino, ctoken_account) = self.kamino(liquidity_mint)?;
        require_keys_eq!(
            *ctoken_account.key,
            market.ctoken_account,
            StrategyError::KaminoAccountWrong
        );
        let lent =
            config::lent_mint(&market.lent_mint()).ok_or(StrategyError::LentMintNotListed)?;
        let (reserve, lending_market) = kamino.check(lent)?;
        Ok(reserve.can_pay_planned(
            &lending_market,
            market.ctokens,
            Clock::get()?.unix_timestamp,
        ))
    }

    /// Prices `trade` with the one pricing function, [`pricing::quote`], reading Kamino's other
    /// accounts only when its output is the lent side and beyond the buffer; `output_mint` is the
    /// router's output mint account. `pipeline_quote` and `pipeline_swap` both price through it.
    ///
    /// Built without the redeem accounts, as account resolution builds a trade the reserve alone
    /// shows Kamino cannot pay, it counts what Kamino can pay from the reserve alone, so such a
    /// trade is refused with `BeyondBuffer`, the reason; one that would redeem fails with
    /// `RedeemAccountsMissing`, and the integrator resolves again.
    pub fn quote(
        &self,
        market: &LendingAmmMarket,
        output_mint: &'a AccountInfo<'info>,
        trade: &TradeRequest,
    ) -> Result<Quote> {
        // A market holding cTokens prices them at the stored rate, which may lag the interest by
        // at most `TRADE_MAX_RESERVE_AGE_SLOTS`, so no round trip across a refresh pays. A
        // deprecated reserve's rate never moves again, so it is never stale.
        require!(
            market.ctokens == 0
                || self.reserve.deprecated()
                || self
                    .reserve
                    .refreshed_within(Clock::get()?.slot, config::TRADE_MAX_RESERVE_AGE_SLOTS),
            StrategyError::ReserveStale
        );
        let quote = pricing::quote(market, &self.reserve, trade, || match self.redeem {
            Some(_) => self.kamino_can_pay(market, output_mint),
            None => Ok(self
                .reserve
                .can_pay_by_itself(market.ctokens, Clock::get()?.unix_timestamp)),
        })?;
        require!(
            quote.shortfall == 0 || self.redeem.is_some(),
            StrategyError::RedeemAccountsMissing
        );
        Ok(quote)
    }
}

/// For quotes and account resolution, which run in simulation: the market state and the
/// strategy accounts are read (the reserve, and for a lent-side output beyond the buffer the
/// redeem accounts), and so is the output mint for such a quote, which must then be the real
/// lent mint; the other accounts may be placeholders.
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
    /// CHECK: read only by a quote of a lent-side output beyond the buffer, which checks it is
    /// the lent mint before passing it on as klend's liquidity mint.
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
