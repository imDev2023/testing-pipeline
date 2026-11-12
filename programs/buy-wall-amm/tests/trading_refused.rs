//! Quotes and swaps stay refused in this ticket (plain trading is the next one), before
//! the seed and after it; account resolution already names the output vault, and bypass
//! is refused (docs/spec/pool4-for-solana.md, "Pricing", "Bypass").

mod common;

use buy_wall_amm::errors::StrategyError::*;
use common::*;
use pipeline_client::{self as client, AccountMeta, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;

const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;

/// Every request a trader could make: both directions, both modes, zero and non-zero.
fn every_request() -> Vec<TradeRequest> {
    let mut requests = vec![];
    for mode in [TradeMode::ExactIn, TradeMode::ExactOut] {
        for (input, output) in [(0, 1), (1, 0)] {
            for amount in [0, 1, 1_000_000, u64::MAX] {
                requests.push(trade(mode, input, output, amount));
            }
        }
    }
    requests
}

fn assert_every_quote_refused(env: &Env, market: &Market, open: bool) {
    for request in every_request() {
        let result = env.quote(market, &request);
        match (request.mode, open) {
            (TradeMode::ExactOut, _) => assert_refused(result, ExactOutNotSupported),
            (TradeMode::ExactIn, false) => assert_refused(result, MarketNotOpen),
            (TradeMode::ExactIn, true) => assert_fails(result),
        }
    }
}

/// Every swap is refused through the router: exact-in by the strategy's own pricing
/// (`exact_in_error`), exact-out by the router itself, since the market reports
/// `supports_exact_out = false`.
fn assert_every_swap_refused(
    env: &mut Env,
    market: &Market,
    exact_in_error: buy_wall_amm::errors::StrategyError,
) {
    let trader = env.trader(market, TOKENS, LAMPORTS);
    for (input, output) in [(0, 1), (1, 0)] {
        for amount in [1, 1_000_000] {
            let result = env.swap(market, &trader, (input, output), TradeMode::ExactIn, amount);
            assert_refused(result, exact_in_error);
            let result = env.swap(
                market,
                &trader,
                (input, output),
                TradeMode::ExactOut,
                amount,
            );
            assert_fails(result);
        }
    }
}

#[test]
fn quotes_and_swaps_are_refused_before_the_seed() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let market = env
        .create_market(token, TOKEN, &launch_params(env.admin.pubkey()))
        .unwrap();
    assert_every_quote_refused(&env, &market, false);
    assert_every_swap_refused(&mut env, &market, MarketNotOpen);
}

#[test]
fn quotes_and_swaps_are_still_refused_after_the_seed() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(
            token,
            TOKEN,
            &launch_params(env.admin.pubkey()),
            TOKENS,
            LAMPORTS,
        )
        .unwrap();
    assert_every_quote_refused(&env, &market, true);
    for request in every_request() {
        if request.mode == TradeMode::ExactIn && request.amount > 0 {
            assert_refused(env.quote(&market, &request), TradingNotAvailable);
        }
    }
    let before = (
        env.balance(&market.token_vault),
        env.balance(&market.sol_vault),
    );
    let state = env.market_state(&market);
    assert_every_swap_refused(&mut env, &market, TradingNotAvailable);
    assert_eq!(
        (
            env.balance(&market.token_vault),
            env.balance(&market.sol_vault)
        ),
        before
    );
    assert_eq!(env.market_state(&market), state);

    // The market still reports the token at index 0 and wrapped SOL at index 1.
    let info = env.market_info(&market.market_state).unwrap();
    assert_eq!(info.mints, vec![token.to_bytes(), WSOL.to_bytes()]);
    assert!(!info.supports_exact_out);
}

#[test]
fn account_resolution_names_the_output_vault() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let market = env
        .create_market(token, TOKEN, &launch_params(env.admin.pubkey()))
        .unwrap();
    for (input, output, vault) in [(0, 1, market.sol_vault), (1, 0, market.token_vault)] {
        let resolved = env
            .resolve(&market, &trade(TradeMode::ExactIn, input, output, 1))
            .unwrap();
        assert!(resolved.complete);
        assert_eq!(resolved.accounts.len(), 1);
        assert_eq!(resolved.accounts[0].address, vault.to_bytes());
        assert!(resolved.accounts[0].writable);
    }
    // Indices other than the two mints are refused.
    for (input, output) in [(0, 0), (1, 1), (0, 2), (2, 1)] {
        let request = trade(TradeMode::ExactIn, input, output, 1);
        assert_refused(env.resolve(&market, &request), WrongAccount);
    }
}

#[test]
fn a_swap_not_signed_by_the_routers_market_is_refused() {
    // Bypass (ADR 0001): `pipeline_swap` called directly, with someone else signing as the
    // market signer.
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(
            token,
            TOKEN,
            &launch_params(env.admin.pubkey()),
            TOKENS,
            LAMPORTS,
        )
        .unwrap();
    let trader = env.trader(&market, TOKENS, LAMPORTS);
    let impostor = Keypair::new();
    let request = SwapRequest {
        trade: trade(TradeMode::ExactIn, 1, 0, SOL),
        amount_sent: SOL,
        min_amount_out: 0,
    };
    let mut accounts = env.read_accounts(&market, &request.trade);
    accounts[0] = AccountMeta::new_readonly(impostor.pubkey(), true);
    accounts[1] = AccountMeta::new(market.market_state, false);
    accounts[2] = AccountMeta::new_readonly(trader.pubkey(), false);
    let owner = trader.pubkey();
    accounts[3] = AccountMeta::new(client::pda::associated_token(&owner, &WSOL, &TOKEN), false);
    accounts[4] = AccountMeta::new(client::pda::associated_token(&owner, &token, &TOKEN), false);
    accounts[5] = AccountMeta::new(market.sol_vault, false);
    accounts.push(AccountMeta::new(market.token_vault, false));
    let ix = strategy_call(client::interface::discriminator::SWAP, &request, accounts);
    assert_refused(env.send(&[ix], &[&impostor]), NotPipeline);
}
