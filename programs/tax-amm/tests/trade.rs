//! Trading a seeded tax market through the router (docs/spec/tax-amm.md, "Pricing and the
//! tax", "Credited input", "Where the tax goes" and "Counters for the containment hook"):
//! every quote and swap against the spec's formulas, written out again in
//! `common/model.rs`, to the unit.

mod common;

use common::model::Model;
use common::*;
use pipeline_client::Pubkey;
use tax_amm::{InitParams, StrategyError};

/// The rates the criteria name: none, typical and the cap.
const RATES: [(u16, u16); 3] = [(0, 0), (300, 500), (1_000, 1_000)];

fn params(tax_side: u8, (buy, sell): (u16, u16)) -> InitParams {
    let mut p = valid_params(&Pubkey::new_unique());
    p.tax_side = tax_side;
    p.buy_tax_bps = buy;
    p.sell_tax_bps = sell;
    p.buy_tax_min_bps = 0;
    p.buy_tax_max_bps = 1_000;
    p.sell_tax_min_bps = 0;
    p.sell_tax_max_bps = 1_000;
    p
}

#[test]
fn quotes_price_by_the_spec_both_ways() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let market = env.seeded_market(
        mints,
        &params(1, (300, 500)),
        [100_000_000_000, 200_000_000_000],
    );
    let model = Model::of(&env.tax_market(&market.market_state));
    for (i, o) in [(0, 1), (1, 0)] {
        let quote = env.quote(&market, &exact_in(i, o, 1_000_000_000)).unwrap();
        let trade = model.price(i, o, 1_000_000_000).unwrap();
        assert_eq!(
            (quote.amount_in, quote.amount_out),
            (1_000_000_000, trade.out)
        );
    }
}

/// Trades `(input, output, amount)` in turn, each with its quote as the minimum, and checks
/// after each that the trader got the quote, the quote is the spec's price, and the market
/// state and both vaults hold exactly what the spec's formulas say.
fn trade_and_check(env: &mut Env, market: &Market, trades: &[(usize, usize, u64)]) -> Model {
    let mut model = Model::of(&env.tax_market(&market.market_state));
    let trader = env.funded_wallet(market, 10_000_000_000_000);
    for &(i, o, amount) in trades {
        let quote = env.quote(market, &exact_in(i, o, amount)).unwrap();
        let options = SwapOptions {
            min_amount_out: quote.amount_out,
            ..SwapOptions::default()
        };
        let meta = env
            .swap_with(market, &trader, (i, o), amount, &options)
            .unwrap();
        let result: pipeline_client::SwapResult =
            borsh::from_slice(&meta.return_data.data).unwrap();
        let trade = model.swap(i, o, amount).unwrap();
        assert_eq!(quote.amount_in, amount);
        assert_eq!(
            quote.amount_out, trade.out,
            "{i}->{o} {amount}: the quote is the spec's"
        );
        assert_eq!(
            result.received, quote.amount_out,
            "{i}->{o} {amount}: the swap is its quote"
        );
        assert_eq!(result.net_sent, amount);
        model.assert_matches(&env.tax_market(&market.market_state));
        for v in 0..2 {
            assert_eq!(
                env.balance(&market.vaults[v]) as u128,
                model.recorded(v),
                "vault {v}"
            );
        }
    }
    model
}

#[test]
fn the_tax_maths_both_ways_at_every_rate_on_both_token_programs_and_tax_sides() {
    for token_program in [TOKEN, TOKEN_2022] {
        for tax_side in [0u8, 1] {
            for rates in RATES {
                let mut env = Env::new();
                let mints = [
                    (env.create_mint(&token_program), token_program),
                    (env.create_mint(&token_program), token_program),
                ];
                let market = env.seeded_market(
                    mints,
                    &params(tax_side, rates),
                    [100_000_000_000, 200_000_000_000],
                );
                let model = trade_and_check(
                    &mut env,
                    &market,
                    &[
                        (0, 1, 1_000_000_000),
                        (1, 0, 3_333_333_333),
                        (0, 1, 7),
                        (1, 0, 50_000_000_000),
                        (0, 1, 12_345_678_901),
                    ],
                );
                // Some tax was taken whenever there is a rate, in the tax-side mint.
                assert_eq!(model.tax_collected > 0, rates != (0, 0));
            }
        }
    }
}

#[test]
fn the_tax_maths_both_ways_with_a_contained_mint_on_either_side() {
    // The containment hook, the one transfer hook a market's mint may run, runs on every
    // transfer of the contained mint in its home market: the seed's, the router's input
    // transfer and fee, and the tax AMM's output transfer. Its home market takes its tax in
    // the other mint.
    for contained_side in [0usize, 1] {
        let mut env = Env::new();
        let market = env.contained_market(contained_side, [100_000_000_000, 200_000_000_000]);
        let model = trade_and_check(
            &mut env,
            &market,
            &[(0, 1, 1_000_000_000), (1, 0, 3_333_333_333), (0, 1, 999)],
        );
        assert!(model.tax_collected > 0);
    }
}

#[test]
fn the_virtual_reserve_is_priced_as_if_held() {
    // Launched single-sided: only token 0 is deposited, and side 1 prices as if it held
    // 50 units more than it really does.
    for tax_side in [0u8, 1] {
        let mut env = Env::new();
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN), TOKEN),
        ];
        let mut p = params(tax_side, (300, 500));
        p.virtual_side = 1;
        p.virtual_reserve = 50_000_000_000;
        let market = env.seeded_market(mints, &p, [1_000_000_000_000, 0]);
        // Buying token 0 with token 1 fills the real reserve of side 1; selling some back
        // is paid from it, never from the virtual reserve, which never changes.
        let model = trade_and_check(
            &mut env,
            &market,
            &[(1, 0, 2_000_000_000), (0, 1, 10_000_000_000), (1, 0, 5)],
        );
        assert_eq!(model.virtual_reserve, 50_000_000_000);
        assert_eq!(
            env.tax_market(&market.market_state).virtual_reserve,
            50_000_000_000
        );
    }
}

#[test]
fn a_trade_that_would_pay_out_more_than_the_real_reserve_is_refused_as_a_quote_and_a_swap() {
    for tax_side in [0u8, 1] {
        let mut env = Env::new();
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN), TOKEN),
        ];
        let mut p = params(tax_side, (300, 500));
        p.virtual_side = 1;
        p.virtual_reserve = 50_000_000_000;
        let market = env.seeded_market(mints, &p, [1_000_000_000_000, 0]);
        let model = trade_and_check(&mut env, &market, &[(1, 0, 2_000_000_000)]);
        let real = model.reserves[1];
        assert!(real > 0);
        // Selling enough token 0 that the curve would pay out more than side 1 really holds.
        let mut amount = 1_000_000;
        while model.price(0, 1, amount) != Err(common::model::Refusal::BeyondRealReserve) {
            amount *= 2;
        }
        assert_refused(
            env.quote(&market, &exact_in(0, 1, amount)),
            StrategyError::InsufficientLiquidity,
        );
        let trader = env.funded_wallet(&market, u64::MAX / 4);
        let before = env.tax_market(&market.market_state);
        assert_refused(
            env.swap(&market, &trader, (0, 1), amount),
            StrategyError::InsufficientLiquidity,
        );
        Model::of(&before).assert_matches(&env.tax_market(&market.market_state));
        assert_eq!(env.balance(&market.vaults[1]) as u128, model.recorded(1));
    }
}
