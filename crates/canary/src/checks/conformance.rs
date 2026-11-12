//! `conformance`: runs `pipeline-check` unchanged on the copy and keeps its whole report as
//! the conformance report (`CANARY-03`).
//!
//! - Fail: `pipeline-check` reports fail. Warn: it reports warn. Pass: it reports pass.
//! - "Not run" when it skipped every check, or when the run's swap path does not execute the
//!   router's bytes, since `pipeline-check` itself runs the router (`CANARY-26`).

use pipeline_check::{check_market_with_source, CheckOptions, Status};
use serde_json::{json, Value};

use crate::market::Copy;
use crate::record::{Outcome, Verdict};

pub fn run(copy: &Copy, runs_router: bool) -> Verdict {
    if !runs_router {
        return Verdict::not_run(
            "Not run: pipeline-check executes the router's bytes, and this run's swap path does not.",
        );
    }
    let options = CheckOptions::default();
    let report = check_market_with_source(
        &copy.pristine,
        copy.market.address,
        &options,
        copy.report_source(),
    );
    let numbers: Value = serde_json::from_str(&report.to_json()).unwrap_or(Value::Null);
    let summary = &report.summary;
    let counts = format!(
        "{} pass, {} warn, {} fail and {} skip",
        summary.pass, summary.warn, summary.fail, summary.skip
    );
    let first = |status: Status| {
        report
            .checks
            .iter()
            .find(|c| c.status == status)
            .map_or_else(String::new, |c| {
                format!(
                    " First {}: {} ({}).",
                    status.label().to_lowercase(),
                    c.id,
                    c.message
                )
            })
    };
    let (outcome, reason) = match summary.result {
        Status::Fail => (
            Outcome::Fail,
            format!(
                "pipeline-check reports fail: {counts}.{}",
                first(Status::Fail)
            ),
        ),
        Status::Warn => (
            Outcome::Warn,
            format!(
                "pipeline-check reports warn: {counts}.{}",
                first(Status::Warn)
            ),
        ),
        Status::Pass => (
            Outcome::Pass,
            format!("pipeline-check reports pass: {counts}."),
        ),
        Status::Skip => (
            Outcome::NotRun,
            format!("Not run: pipeline-check skipped every check ({counts})."),
        ),
    };
    Verdict::new(
        outcome,
        reason,
        json!({ "pipeline_check": pipeline_check::SCHEMA, "options": "pipeline-check's defaults" }),
        numbers,
    )
}
