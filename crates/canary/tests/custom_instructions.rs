//! `custom_instructions`: noted, from the instruction list and the callers the snapshot
//! carries (`PIPESCOPE-92`): `terminal-api` works the list out once per strategy version and
//! the `CanaryRun` Durable Object posts it; the binary never works it out itself.

mod common;

use axum::body::Body;
use axum::http::Request;
use canary::source::record_snapshot;
use common::Cluster;
use http_body_util::BodyExt;
use pipeline_check::SvmSource;
use serde_json::{json, Value};
use tower::ServiceExt;

async fn answer(snapshot: Value) -> Value {
    let response = canary::http::router()
        .oneshot(
            Request::post("/run")
                .header("content-type", "application/json")
                .body(Body::from(snapshot.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

/// The `custom_instructions` record for the snapshot of a deep market, with `instructions`
/// posted in it (or not, when `Value::Null`).
async fn record_with(instructions: Value) -> Value {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    let mut snapshot = serde_json::to_value(
        record_snapshot(&mut SvmSource::new(cluster.svm.clone()), market.market).unwrap(),
    )
    .unwrap();
    if !instructions.is_null() {
        snapshot["instructions"] = instructions;
    }
    let answer = answer(snapshot).await;
    answer["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["check"] == "custom_instructions")
        .cloned()
        .unwrap_or_else(|| panic!("no custom_instructions record: {answer}"))
}

#[tokio::test]
async fn the_instructions_beyond_pipelines_six_are_noted_with_their_callers() {
    let record = record_with(json!({
        "anchor": true,
        "instructions": [
            { "name": "PipelineSwap", "calls": 900, "signers": [] },
            { "name": "Deposit", "calls": 12, "signers": ["9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt"] },
            { "name": "UpdateConfig", "calls": 0, "signers": [] },
        ],
    }))
    .await;

    assert_eq!(record["outcome"], "noted", "{record}");
    let reason = record["reason"].as_str().unwrap();
    assert!(
        reason.contains("Deposit (called 12 times by 1 signer)"),
        "{reason}"
    );
    assert!(reason.contains("UpdateConfig (never called)"), "{reason}");
    assert!(!reason.contains("PipelineSwap"), "{reason}");
    assert_eq!(
        record["numbers"]["instructions"].as_array().unwrap().len(),
        2,
        "{record}"
    );
}

#[tokio::test]
async fn a_program_not_built_with_anchor_is_noted_as_none_found() {
    let record = record_with(json!({ "anchor": false, "instructions": [] })).await;

    assert_eq!(record["outcome"], "noted", "{record}");
    assert!(
        record["reason"].as_str().unwrap().contains("none found"),
        "{record}"
    );
}

#[tokio::test]
async fn a_snapshot_without_the_list_is_not_run() {
    let record = record_with(Value::Null).await;

    assert_eq!(record["outcome"], "not run", "{record}");
    assert!(
        record["reason"].as_str().unwrap().contains("terminal-api"),
        "{record}"
    );
}
