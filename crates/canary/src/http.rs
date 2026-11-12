//! The HTTP endpoint the container serves (`docs/spec/pipescope-architecture.md`, "Canary
//! runner"): `POST /run` takes one market's [`Snapshot`] and answers with one Canary result
//! per check, or with the addresses the snapshot lacks. The container has no network, so the
//! snapshot is everything the run reads.
//!
//! ```text
//! POST /run   {"market", "round", "cluster", "accounts"}
//!   200 {"status": "results", "harness", "records": [...], "notes": [...]}
//!   200 {"status": "missing", "round", "addresses": [...]}
//!   400 {"error"}
//! GET /health  200 {"harness"}
//! ```

use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::config::{HARNESS, SNAPSHOT_MAX_BYTES, SNAPSHOT_ROUNDS};
use crate::run::{run_market, MarketRun, RunOptions};
use crate::source::{Snapshot, SnapshotSource};

pub fn router() -> Router {
    Router::new()
        .route("/run", post(run))
        .route(
            "/health",
            get(|| async { Json(json!({ "harness": HARNESS })) }),
        )
        .layer(DefaultBodyLimit::max(SNAPSHOT_MAX_BYTES))
}

fn refuse(error: String) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": error })))
}

/// Runs a snapshot to its answer. Blocking: the run is CPU-bound work in a local VM.
pub fn answer(snapshot: &Snapshot) -> Result<Value, String> {
    let market = snapshot.market.parse().map_err(|_| {
        format!(
            "the snapshot's market {:?} is not an address",
            snapshot.market
        )
    })?;
    let mut source = SnapshotSource::new(snapshot)?;
    let options = RunOptions {
        last_round: snapshot.round >= SNAPSHOT_ROUNDS,
        ..RunOptions::default()
    };
    Ok(match run_market(&mut source, market, &options) {
        MarketRun::Results(results) => json!({
            "status": "results",
            "harness": HARNESS,
            "records": results.records,
            "notes": results.notes,
        }),
        MarketRun::Missing(addresses) => json!({
            "status": "missing",
            "round": snapshot.round,
            "addresses": addresses.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
        }),
    })
}

async fn run(body: Bytes) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let snapshot: Snapshot = serde_json::from_slice(&body)
        .map_err(|e| refuse(format!("the body is not a snapshot: {e}")))?;
    let answered = tokio::task::spawn_blocking(move || answer(&snapshot))
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("the run stopped: {e}") })),
            )
        })?;
    answered.map(Json).map_err(refuse)
}
