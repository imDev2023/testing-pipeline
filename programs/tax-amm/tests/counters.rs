//! The counters for the containment hook (docs/spec/tax-amm.md, "Counters for the
//! containment hook"): `volume`, `tax_collected` and `swap_count` add up the router's swap
//! events and the swaps' taxes, and nothing but a router swap changes them.

mod common;

use common::model::Model;
use common::*;
use pipeline_client::Pubkey;

#[test]
fn the_counters_equal_the_swap_events_and_the_sum_of_their_taxes() {
    for tax_side in [0u8, 1] {
        let mut env = Env::new();
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN_2022), TOKEN_2022),
        ];
        let mut p = valid_params(&Pubkey::new_unique());
        p.tax_side = tax_side;
        let market = env.seeded_market(mints, &p, [100_000_000_000, 200_000_000_000]);
        let trader = env.funded_wallet(&market, 1_000_000_000_000);
        let mut model = Model::of(&env.tax_market(&market.market_state));

        let mut volume = [0u128; 2];
        let mut taxes = 0u128;
        let trades = [
            (0, 1, 1_000_000_000u64),
            (1, 0, 3_000_000_000),
            (1, 0, 11),
            (0, 1, 9_999_999_999),
        ];
        for (i, o, amount) in trades {
            let meta = env
                .swap_with(&market, &trader, (i, o), amount, &SwapOptions::default())
                .unwrap();
            let events = Env::swap_events(&meta);
            assert_eq!(events.len(), 1);
            let event = &events[0];
            assert_eq!(event.input_mint, market.mints[i]);
            assert_eq!(event.output_mint, market.mints[o]);
            volume[i] += event.net_sent as u128;
            volume[o] += event.received as u128;
            taxes += model.swap(i, o, amount).unwrap().tax as u128;
        }
        let state = env.tax_market(&market.market_state);
        assert_eq!(state.volume, volume);
        assert_eq!(state.tax_collected, taxes);
        assert_eq!(state.swap_count, trades.len() as u64);
        model.assert_matches(&state);
    }
}

#[test]
fn nothing_but_a_router_swap_changes_the_counters() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let market = env.seeded_market(
        mints,
        &valid_params(&Pubkey::new_unique()),
        [100_000_000_000, 200_000_000_000],
    );
    let trader = env.funded_wallet(&market, 1_000_000_000_000);
    env.swap(&market, &trader, (0, 1), 1_000_000_000).unwrap();
    let counters = |env: &Env| {
        let state = env.tax_market(&market.market_state);
        (state.volume, state.tax_collected, state.swap_count)
    };
    let after_swap = counters(&env);
    assert_eq!(after_swap.2, 1);

    // Quotes, account resolution, tokens sent to the vaults, a refused swap and a second
    // seed attempt leave them where they are.
    env.quote(&market, &exact_in(1, 0, 5_000_000)).unwrap();
    env.resolve_accounts(&market, &exact_in(0, 1, 5_000_000))
        .unwrap();
    for v in 0..2 {
        env.transfer(&market, &trader, v, market.vaults[v], 1_000_000)
            .unwrap();
    }
    env.swap(&market, &trader, (0, 1), 1).unwrap_err();
    let seeder = solana_keypair::Keypair::new();
    env.seed(&market, &seeder, [1, 1]).unwrap_err();
    assert_eq!(counters(&env), after_swap);
}
