//! How a failure is named: each class, with the program that raised it and, for Anchor
//! programs, the error's name, number, message and source line or account.

mod common;

use canary::{run_market, MarketResults, RunOptions};
use common::{Cluster, CP, EVIL, SOL};
use pipeline_check::SvmSource;
use pipeline_client::{self as client, Pubkey};
use serde_json::Value;

fn run(cluster: &Cluster, market: Pubkey, extra: Vec<u8>) -> MarketResults {
    run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market,
        &RunOptions {
            extra,
            ..RunOptions::default()
        },
    )
    .into_results()
    .expect("a full source never lacks an account")
}

/// Every failure recorded anywhere in a market's records.
fn failures(results: &MarketResults) -> Vec<Value> {
    fn walk(value: &Value, out: &mut Vec<Value>) {
        match value {
            Value::Object(map) => {
                if map.contains_key("class") && map.contains_key("stage") {
                    out.push(value.clone());
                }
                map.values().for_each(|v| walk(v, out));
            }
            Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = vec![];
    for record in &results.records {
        walk(&record.numbers, &mut out);
    }
    out
}

fn find(results: &MarketResults, class: &str) -> Value {
    failures(results)
        .into_iter()
        .find(|f| f["class"] == class)
        .unwrap_or_else(|| panic!("no {class} failure in {:#?}", failures(results)))
}

#[test]
fn cannot_read_state_names_anchors_error_and_the_account() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    cluster.edit(&market.state, |data| data[0] ^= 0xff);

    let failure = find(&run(&cluster, market.market, vec![]), "cannot_read_state");

    assert_eq!(failure["program"], CP.to_string());
    assert_eq!(failure["anchor"]["name"], "AccountDiscriminatorMismatch");
    assert_eq!(failure["anchor"]["number"], 3002);
    assert!(
        failure["anchor"]["message"].as_str().unwrap().len() > 10,
        "{failure}"
    );
    assert_eq!(
        failure["anchor"]["origin"], "caused by account: pool",
        "{failure}"
    );
}

#[test]
fn strategy_refused_names_the_error_and_its_source_line() {
    let mut cluster = Cluster::new();
    let sol = cluster.wrapped_sol();
    let token = cluster.create_mint(6);
    let market = cluster.cp_market(sol, token, 30, (0, 0));

    let failure = find(&run(&cluster, market.market, vec![]), "strategy_refused");

    assert_eq!(failure["program"], CP.to_string());
    assert_eq!(failure["anchor"]["name"], "InsufficientLiquidity");
    assert_eq!(failure["anchor"]["number"], 6004);
    assert_eq!(
        failure["anchor"]["message"],
        "Pool cannot provide that much output"
    );
    let origin = failure["anchor"]["origin"].as_str().unwrap();
    assert!(
        origin.starts_with("thrown in ") && origin.contains("lib.rs:"),
        "{origin}"
    );
}

#[test]
fn router_refused_names_the_router() {
    let mut cluster = Cluster::new();
    // Pays out 1:1 and refunds more input than was sent, which the router refuses.
    const REFUND_MORE: u8 = 3;
    let market = cluster.evil_market(1_000 * SOL);

    let failure = find(
        &run(&cluster, market.market, vec![REFUND_MORE]),
        "router_refused",
    );

    assert_eq!(failure["program"], client::PROGRAM_ID.to_string());
    assert_eq!(failure["stage"], "swap");
    assert!(failure["anchor"]["name"].is_string(), "{failure}");
}

#[test]
fn token_program_refused_names_the_token_program() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * SOL);
    // Pulls one more unit of input from the trader with the market signer, which the token
    // program refuses: the market signer is not the trader's delegate.
    const PULL_AS_DELEGATE: u8 = 10;

    let failure = find(
        &run(&cluster, market.market, vec![PULL_AS_DELEGATE]),
        "token_program_refused",
    );

    assert_eq!(failure["program"], client::TOKEN_PROGRAM_ID.to_string());
    assert_eq!(failure["stage"], "swap");
}

#[test]
fn crash_names_the_panic_and_its_source_line() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * SOL);
    cluster.add_third_mint(&market, 1_000 * SOL);

    let failure = find(&run(&cluster, market.market, vec![]), "crash");

    assert_eq!(failure["program"], EVIL.to_string());
    assert!(
        failure["panic"]
            .as_str()
            .unwrap()
            .contains("test-strategy-evil/src/lib.rs at "),
        "{failure}"
    );
}

#[test]
fn out_of_compute_is_named_at_the_quote_limit() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * SOL);
    const QUOTE_HOG: u8 = 8;

    let failure = find(
        &run(&cluster, market.market, vec![QUOTE_HOG]),
        "out_of_compute",
    );

    assert_eq!(failure["program"], EVIL.to_string());
    assert_eq!(failure["stage"], "quote");
    let used = failure["compute_units"].as_u64().unwrap();
    assert!(
        used >= u64::from(canary::config::QUOTE_COMPUTE_LIMIT) - 1_000,
        "{failure}"
    );
}
