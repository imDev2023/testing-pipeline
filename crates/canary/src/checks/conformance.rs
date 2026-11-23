//! `conformance`: runs `pipeline-check` unchanged on the copy and keeps its whole report as
//! the conformance report (`CANARY-03`).
//!
//! - Fail: `pipeline-check` reports fail. Warn: it reports warn. Pass: it reports pass.
//! - "Not run" when it skipped every check, or when the run's swap path does not execute the
//!   router's bytes, since `pipeline-check` itself runs the router (`CANARY-26`).
//! - Known, not counted: on a market with a mint contained by our containment hook,
//!   `pipeline-check`'s checks that swap into a trader's account ([`TRADER_ACCOUNT_CHECKS`])
//!   when every failure they report is the hook's `DestinationOwnerCanChange`.
//!   `pipeline-check` writes its traders' token accounts without the immutable owner
//!   extension that every real associated token account carries, so the hook refuses to
//!   deliver the token to them (`HOOK-47`), while Canary's own traders hold accounts with it
//!   (`crate::token_account`). Known until Pipeline's checker writes the extension.

use pipeline_check::{check_market_with_source, CheckOptions, CheckResult, Report, Status};
use serde_json::{json, Value};

use crate::config::{CONTAINMENT_HOOK_DESTINATION_OWNER_CAN_CHANGE, CONTAINMENT_HOOK_PROGRAM};
use crate::market::{Copy, Market};
use crate::record::{Outcome, Verdict};

/// `pipeline-check`'s checks whose swaps deliver a token into its own trader's account, and
/// so meet the containment hook's allow rule: a buy (`quote_matches_swap`, `round_trip`'s
/// sale back) or an exact-out refund (`exact_out_refund`).
pub const TRADER_ACCOUNT_CHECKS: [&str; 3] =
    ["quote_matches_swap", "exact_out_refund", "round_trip"];

/// Why the known checks are not counted, in the record's reason.
const KNOWN_UNTIL: &str =
    "known until Pipeline's checker writes the immutable owner extension, HOOK-47";

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
    judge(&report, &copy.market)
}

/// The verdict on `pipeline-check`'s report for `market`.
pub fn judge(report: &Report, market: &Market) -> Verdict {
    let mut numbers: Value = serde_json::from_str(&report.to_json()).unwrap_or(Value::Null);
    let known = known_failures(report, market);
    let counted: Vec<&CheckResult> = report
        .checks
        .iter()
        .filter(|c| !known.contains(&c.id.as_str()))
        .collect();
    let count = |status: Status| counted.iter().filter(|c| c.status == status).count();
    let counts = format!(
        "{} pass, {} warn, {} fail and {} skip",
        count(Status::Pass),
        count(Status::Warn),
        count(Status::Fail),
        count(Status::Skip)
    );
    let result = counted
        .iter()
        .map(|c| c.status)
        .max()
        .unwrap_or(Status::Skip);
    let first = |status: Status| {
        counted
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
    // Before the known checks are left out, the report's own words; after, said so.
    let apart = if known.is_empty() {
        ""
    } else {
        "apart from the known, "
    };
    let (outcome, reason) = match result {
        Status::Fail => (
            Outcome::Fail,
            format!(
                "{apart}pipeline-check reports fail: {counts}.{}",
                first(Status::Fail)
            ),
        ),
        Status::Warn => (
            Outcome::Warn,
            format!(
                "{apart}pipeline-check reports warn: {counts}.{}",
                first(Status::Warn)
            ),
        ),
        Status::Pass => (
            Outcome::Pass,
            format!("{apart}pipeline-check reports pass: {counts}."),
        ),
        Status::Skip => (
            Outcome::NotRun,
            format!("Not run: {apart}pipeline-check skipped every check ({counts})."),
        ),
    };
    let reason = if known.is_empty() {
        reason
    } else {
        numbers["canary_known"] = json!(known);
        capitalise(&format!(
            "{reason} Known, not counted: {}, whose swaps fail only with the containment hook's DestinationOwnerCanChange ({CONTAINMENT_HOOK_DESTINATION_OWNER_CAN_CHANGE}) because pipeline-check's own traders lack the immutable owner extension; {KNOWN_UNTIL}.",
            words_list(&known),
        ))
    };
    Verdict::new(
        outcome,
        reason,
        json!({ "pipeline_check": pipeline_check::SCHEMA, "options": "pipeline-check's defaults" }),
        numbers,
    )
}

/// The checks of [`TRADER_ACCOUNT_CHECKS`] that warn or fail only with the containment
/// hook's `DestinationOwnerCanChange`, on a market with a mint our hook contains; none on
/// any other market.
pub fn known_failures(report: &Report, market: &Market) -> Vec<&'static str> {
    let contained = market
        .mints
        .iter()
        .any(|m| m.transfer_hook.and_then(|h| h.program) == Some(CONTAINMENT_HOOK_PROGRAM));
    if !contained {
        return vec![];
    }
    TRADER_ACCOUNT_CHECKS
        .into_iter()
        .filter(|id| {
            report.check(id).is_some_and(|check| {
                matches!(check.status, Status::Warn | Status::Fail) && only_the_hooks_refusal(check)
            })
        })
        .collect()
}

/// Whether every failure `check` reports is a swap refused with the hook's
/// `DestinationOwnerCanChange`: `quote_matches_swap`'s mismatches and `exact_out_refund`'s
/// problems, listed in its details, and `round_trip`'s warnings, which are its message.
fn only_the_hooks_refusal(check: &CheckResult) -> bool {
    let error = format!("Custom({CONTAINMENT_HOOK_DESTINATION_OWNER_CAN_CHANGE}))");
    let listed = |key: &str| -> Vec<String> {
        check.details[key]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    let failures = match check.id.as_str() {
        "quote_matches_swap" => listed("mismatches"),
        "exact_out_refund" => listed("problems"),
        "round_trip" => check
            .message
            .trim_end_matches('.')
            .split("; ")
            .map(str::to_string)
            .collect(),
        _ => vec![],
    };
    !failures.is_empty() && failures.iter().all(|failure| failure.contains(&error))
}

/// `a`, `a and b`, `a, b and c`.
fn words_list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().collect::<String>() + chars.as_str()
    })
}
