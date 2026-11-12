//! `token_authorities`: for each of the market's mints, Canary acts as each authority that
//! exists and is a wallet, then trades again (`CANARY-17`): minting 100 times the vault's
//! holding and selling it, freezing the buyer's account, setting the transfer fee to 100%,
//! moving the buyer's tokens as permanent delegate, or pausing the mint. An authority that
//! is a program's address is "not run", naming the program.

mod common;

use canary::{run_market, Outcome, Record, RunOptions};
use common::{Cluster, Extensions, Market, CP, TOKEN, TOKEN_2022};
use pipeline_check::SvmSource;
use serde_json::Value;

fn record(cluster: &Cluster, market: &Market) -> Record {
    run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market.market,
        &RunOptions::default(),
    )
    .into_results()
    .expect("a full source never lacks an account")
    .record("token_authorities")
    .clone()
}

/// The record's action by `power`.
fn action<'a>(record: &'a Record, power: &str) -> &'a Value {
    record.numbers["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["power"] == power)
        .unwrap_or_else(|| panic!("no {power} action: {}", record.numbers))
}

/// A wrapped SOL market whose token is a Token-2022 mint with `extensions`, its mint
/// authority renounced so only the authority under test acts.
fn market_with(extensions: Extensions) -> (Cluster, Market) {
    let mut cluster = Cluster::new();
    let token = cluster.create_mint_2022(6, &extensions);
    let market = cluster.sol_market_of(token);
    cluster.renounce_mint_authority(&token, &TOKEN_2022);
    (cluster, market)
}

#[test]
fn a_mint_authority_that_mints_and_sells_takes_nearly_all_of_the_other_vault() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);

    let record = record(&cluster, &market);

    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    let minted = action(&record, "mint_authority");
    assert_eq!(minted["effect"], true, "{minted}");
    // 100 times a vault of 1,000,000 tokens sold into 1,000 SOL takes 100/101 of it, less
    // the pool's 0.3% fee on what goes in: 99.0%, as the prototype found on devnet.
    let share = minted["sales"][0]["share_of_vault_ppm"].as_u64().unwrap();
    assert!((990_000..991_000).contains(&share), "{share}");
    assert!(
        record
            .reason
            .contains("took 99.0% of the vault of mint 0 (wrapped SOL)"),
        "{}",
        record.reason
    );
}

#[test]
fn a_freeze_authority_that_freezes_the_buyer_stops_the_sale() {
    let (cluster, market) = market_with(Extensions {
        freeze_authority: true,
        ..Extensions::default()
    });

    let record = record(&cluster, &market);

    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    let frozen = action(&record, "freeze_authority");
    assert_eq!(frozen["effect"], true, "{frozen}");
    assert!(
        frozen["round_trip"]["buy"]["swap"]["Ok"]["trader_received"].as_u64() > Some(0),
        "{frozen}"
    );
    let failure = &frozen["round_trip"]["sell"]["swap"]["Err"];
    assert_eq!(failure["class"], "token_program_refused", "{frozen}");
    assert!(record.reason.contains("AccountFrozen"), "{}", record.reason);
}

#[test]
fn a_permanent_delegate_that_moves_the_buyers_tokens_leaves_nothing_to_sell() {
    let (cluster, market) = market_with(Extensions {
        permanent_delegate: true,
        ..Extensions::default()
    });

    let record = record(&cluster, &market);

    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    let moved = action(&record, "permanent_delegate");
    assert_eq!(moved["effect"], true, "{moved}");
    let bought = moved["round_trip"]["buy"]["swap"]["Ok"]["trader_received"]
        .as_u64()
        .unwrap();
    assert!(bought > 0);
    assert_eq!(moved["moved"].as_u64(), Some(bought), "{moved}");
    assert!(
        moved["round_trip"]["sell"]["swap"]["Err"].is_object(),
        "{moved}"
    );
}

#[test]
fn a_pause_authority_that_pauses_the_mint_stops_the_sale() {
    let (cluster, market) = market_with(Extensions {
        pausable: true,
        ..Extensions::default()
    });

    let record = record(&cluster, &market);

    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    let paused = action(&record, "pause_authority");
    assert_eq!(paused["effect"], true, "{paused}");
    let failure = &paused["round_trip"]["sell"]["swap"]["Err"];
    assert_eq!(failure["class"], "token_program_refused", "{paused}");
}

#[test]
fn a_transfer_fee_of_100_percent_two_epochs_on_makes_a_buy_deliver_nothing() {
    let (cluster, market) = market_with(Extensions {
        transfer_fee: Some((0, 0)),
        ..Extensions::default()
    });

    let record = record(&cluster, &market);

    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    let fee = action(&record, "transfer_fee_authority");
    assert_eq!(fee["effect"], true, "{fee}");
    let buy = &fee["round_trip"]["buy"]["swap"]["Ok"];
    assert!(buy["trader_spent"].as_u64().unwrap() > 0, "{fee}");
    assert_eq!(buy["trader_received"].as_u64(), Some(0), "{fee}");
    assert!(
        record.reason.contains("delivered nothing"),
        "{}",
        record.reason
    );
}

#[test]
fn an_authority_that_is_a_programs_address_is_not_run_and_names_the_program() {
    let mut cluster = Cluster::new();
    let sol = cluster.wrapped_sol();
    // The constant-product pool's own address, which the strategy owns; it depends on the
    // mint, so the mint's authority moves to it after the market is created.
    let token = cluster.create_mint(6);
    let pool = Cluster::cp_pool(&sol, &token, 30);
    let market = cluster.cp_market(sol, token, 30, (1_000 * common::SOL, 1_000_000_000_000));
    let ix = spl_token_2022_interface::instruction::set_authority(
        &TOKEN,
        &token,
        Some(&pool),
        spl_token_2022_interface::instruction::AuthorityType::MintTokens,
        &cluster.admin_key(),
        &[],
    )
    .unwrap();
    cluster.send(&[ix], &[]);

    let record = record(&cluster, &market);

    assert_eq!(record.outcome, Outcome::NotRun, "{}", record.reason);
    assert!(record.reason.contains(&CP.to_string()), "{}", record.reason);
    let minted = action(&record, "mint_authority");
    assert_eq!(minted["outcome"], "not run", "{minted}");
}

#[test]
fn a_market_whose_mints_have_no_authority_passes() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    cluster.renounce_mint_authority(&market.mint_b, &TOKEN);

    let record = record(&cluster, &market);

    assert_eq!(record.outcome, Outcome::Pass, "{}", record.reason);
    assert_eq!(record.numbers["actions"].as_array().unwrap().len(), 0);
}

#[test]
fn an_action_on_a_market_whose_round_trip_fails_anyway_is_not_run() {
    // The evil strategy's "short output" pays a single unit, so a round trip returns almost
    // nothing whether or not anyone freezes anything.
    const SHORT_OUTPUT: u8 = 2;
    let mut cluster = Cluster::new();
    let token = cluster.create_mint_with_freeze_authority(9);
    let market = cluster.evil_market_of(token, 1_000 * common::SOL);
    cluster.renounce_mint_authority(&token, &TOKEN);

    let record = run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market.market,
        &RunOptions {
            extra: vec![SHORT_OUTPUT],
            ..RunOptions::default()
        },
    )
    .into_results()
    .unwrap()
    .record("token_authorities")
    .clone();

    let frozen = action(&record, "freeze_authority");
    assert_eq!(frozen["outcome"], "not run", "{frozen}");
    assert!(
        frozen["reason"].as_str().unwrap().contains("without the authority acting"),
        "{frozen}"
    );
    assert_eq!(record.outcome, Outcome::NotRun, "{}", record.reason);
}
