//! The HTTP endpoint the container serves: one snapshot in; results or missing addresses out.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use canary::config::SNAPSHOT_ROUNDS;
use canary::source::record_snapshot;
use common::Cluster;
use http_body_util::BodyExt;
use pipeline_check::SvmSource;
use pipeline_client::pda;
use serde_json::Value;
use tower::ServiceExt;

async fn post(body: String) -> (StatusCode, Value) {
    let response = canary::http::router()
        .oneshot(
            Request::post("/run")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn a_complete_snapshot_gets_one_record_per_check() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    let snapshot =
        record_snapshot(&mut SvmSource::new(cluster.svm.clone()), market.market).unwrap();

    let (status, answer) = post(serde_json::to_string(&snapshot).unwrap()).await;

    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["status"], "results");
    let records = answer["records"].as_array().unwrap();
    let checks: Vec<&str> = records
        .iter()
        .map(|r| r["check"].as_str().unwrap())
        .collect();
    assert_eq!(checks, canary::checks::CHECKS);
    assert!(records
        .iter()
        .all(|r| r["harness"] == canary::config::HARNESS));
    assert!(records
        .iter()
        .all(|r| r["market"] == market.market.to_string()));
}

#[tokio::test]
async fn a_snapshot_lacking_an_account_gets_exactly_the_missing_addresses_until_the_last_round() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    let mut snapshot =
        record_snapshot(&mut SvmSource::new(cluster.svm.clone()), market.market).unwrap();
    let vault = pda::associated_token(&market.state, &market.mint_b, &common::TOKEN);
    snapshot.accounts.remove(&vault.to_string());

    snapshot.round = SNAPSHOT_ROUNDS - 1;
    let (status, answer) = post(serde_json::to_string(&snapshot).unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["status"], "missing");
    assert_eq!(answer["addresses"], serde_json::json!([vault.to_string()]));

    snapshot.round = SNAPSHOT_ROUNDS;
    let (_, answer) = post(serde_json::to_string(&snapshot).unwrap()).await;
    assert_eq!(answer["status"], "results");
    assert!(answer["records"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["outcome"] == "not run"
            && r["reason"].as_str().unwrap().contains(&vault.to_string())));
}

#[tokio::test]
async fn a_malformed_snapshot_is_refused_with_a_reason() {
    let (status, answer) = post("{\"market\": 1}".into()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        answer["error"].as_str().unwrap().contains("snapshot"),
        "{answer}"
    );

    let (status, answer) = post(
        serde_json::json!({
            "market": "not an address",
            "round": 1,
            "cluster": { "slot": 1, "epoch": 1, "unix_timestamp": 1 },
            "accounts": {},
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        answer["error"].as_str().unwrap().contains("not an address"),
        "{answer}"
    );
}
