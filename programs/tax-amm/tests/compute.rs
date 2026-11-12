//! Compute ceilings (docs/spec/tax-amm.md, "Compute ceilings"; docs/spec/README.md, "Test
//! layers" 5). This module mirrors the spec's table, and its one place in the tests: a
//! ceiling changes only by a PR to the spec file and this table together.
//!
//! A cost is what the tax AMM's own invocation consumes, its token program calls included,
//! measured on mints without a transfer hook. Each test prints what it measured.

mod common;

use common::*;
use pipeline_client::Pubkey;

/// The spec's table, in compute units.
mod ceilings {
    pub const PIPELINE_QUOTE: u64 = 25_000;
    pub const PIPELINE_SWAP: u64 = 60_000;
    pub const PIPELINE_MARKET_INFO: u64 = 15_000;
    pub const PIPELINE_RESOLVE_ACCOUNTS: u64 = 15_000;
    pub const PIPELINE_INIT_MARKET: u64 = 120_000;
    pub const PIPELINE_SEED_LIQUIDITY: u64 = 150_000;
    pub const SEED: u64 = 80_000;
    pub const DISTRIBUTE: u64 = 90_000;
    pub const SET_TAXES: u64 = 20_000;
    pub const SET_RECIPIENTS: u64 = 20_000;
    pub const RENOUNCE_TAX_AUTHORITY: u64 = 20_000;
}

/// Markets on plain mints of each token program, SPL Token's and Token-2022's.
fn markets() -> Vec<(&'static str, Env, Market)> {
    [("SPL Token", TOKEN), ("Token-2022", TOKEN_2022)]
        .into_iter()
        .map(|(name, token_program)| {
            let mut env = Env::new();
            let mints = [
                (env.create_mint(&token_program), token_program),
                (env.create_mint(&token_program), token_program),
            ];
            let market = env
                .create_tax_market(mints, &valid_params(&Pubkey::new_unique()))
                .unwrap();
            (name, env, market)
        })
        .collect()
}

#[test]
fn pipeline_init_market_stays_under_its_ceiling() {
    for (name, _, market) in markets() {
        // create_market calls the strategy twice: pipeline_init_market, then
        // pipeline_market_info.
        let costs = strategy_compute(&market.created.logs);
        assert_eq!(costs.len(), 2, "{:?}", market.created.logs);
        println!("pipeline_init_market on {name} mints: {} CU", costs[0]);
        assert!(
            costs[0] <= ceilings::PIPELINE_INIT_MARKET,
            "{name}: {}",
            costs[0]
        );
    }
}

#[test]
fn pipeline_market_info_stays_under_its_ceiling() {
    for (name, env, market) in markets() {
        let in_creation = strategy_compute(&market.created.logs)[1];
        let meta = env.market_info_meta(&market.market_state).unwrap();
        let direct = strategy_compute(&meta.logs)[0];
        println!("pipeline_market_info on {name} mints: {in_creation} CU in create_market, {direct} CU called directly");
        assert!(
            in_creation <= ceilings::PIPELINE_MARKET_INFO,
            "{name}: {in_creation}"
        );
        assert!(direct <= ceilings::PIPELINE_MARKET_INFO, "{name}: {direct}");
    }
}

#[test]
fn pipeline_resolve_accounts_stays_under_its_ceiling() {
    for (name, env, market) in markets() {
        for (input, output) in [(0, 1), (1, 0)] {
            let meta = env
                .resolve_meta(&market, &exact_in(input, output, 1_000_000))
                .unwrap();
            let cost = strategy_compute(&meta.logs)[0];
            println!("pipeline_resolve_accounts {input}->{output} on {name} mints: {cost} CU");
            assert!(
                cost <= ceilings::PIPELINE_RESOLVE_ACCOUNTS,
                "{name}: {cost}"
            );
        }
    }
}

#[test]
fn the_table_mirrors_the_spec() {
    let spec = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/spec/tax-amm.md"),
    )
    .unwrap();
    let table: String = spec
        .split("### Compute ceilings")
        .nth(1)
        .and_then(|rest| rest.split("\n### ").next())
        .expect("the spec's compute ceilings section")
        .to_string();
    // A row naming several instructions gives one ceiling for "each".
    let row = |instructions: &str, ceiling: u64| {
        let each = if instructions.contains(", ") {
            " each"
        } else {
            ""
        };
        let cells = format!("| {instructions} | {}{each} |", format_cu(ceiling));
        assert!(
            table.contains(&cells),
            "the spec's table has no row {cells}"
        );
    };
    use ceilings::*;
    row("`pipeline_quote`", PIPELINE_QUOTE);
    row("`pipeline_swap`", PIPELINE_SWAP);
    const { assert!(PIPELINE_MARKET_INFO == PIPELINE_RESOLVE_ACCOUNTS) };
    row(
        "`pipeline_market_info`, `pipeline_resolve_accounts`",
        PIPELINE_MARKET_INFO,
    );
    row("`pipeline_init_market`", PIPELINE_INIT_MARKET);
    row("`pipeline_seed_liquidity`", PIPELINE_SEED_LIQUIDITY);
    row("`seed`", SEED);
    row("`distribute`", DISTRIBUTE);
    const { assert!(SET_TAXES == SET_RECIPIENTS && SET_RECIPIENTS == RENOUNCE_TAX_AUTHORITY) };
    row(
        "`set_taxes`, `set_recipients`, `renounce_tax_authority`",
        SET_TAXES,
    );
}

/// `120000` as the spec writes it, `120,000`.
fn format_cu(units: u64) -> String {
    let digits = units.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}
