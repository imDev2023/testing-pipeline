//! `conformance`: runs `pipeline-check` unchanged on the copy and keeps its whole report as
//! the conformance report (`CANARY-03`).
//!
//! - Fail: `pipeline-check` reports fail. Warn: it reports warn. Pass: it reports pass.
//! - "Not run" when it skipped every check, or when the run's swap path does not execute the
//!   router's bytes, since `pipeline-check` itself runs the router (`CANARY-26`).
//! - Known, not counted: on a contained mint's home market, `pipeline-check`'s checks that
//!   swap into a trader's account ([`TRADER_ACCOUNT_CHECKS`]) when every failure they report
//!   is error 6023, the hook's `DestinationOwnerCanChange`.
//!   `pipeline-check` writes its traders' token accounts without the immutable owner
//!   extension that every real associated token account carries, so the hook refuses to
//!   deliver the token to them (`HOOK-47`), while Canary's own traders hold accounts with it
//!   (`crate::token_account`). Known until Pipeline's checker writes the extension.
//! - The rule needs Canary's own evidence ([`probe_hook`], R2T-10), since `pipeline-check`'s
//!   failure text carries the error number but not the program that raised it, and 6023 is
//!   other programs' number too (the buy wall AMM's `ExactOutNotSupported`, the tax AMM's
//!   `AlreadySeeded`, the router's `SetupPayerMisused`): the hook's config of each contained
//!   mint names this market as its home, and a buy of the mint into an account written as
//!   `pipeline-check` writes it fails with 6023 raised by the containment hook program.
//! - The known reason also says which of `pipeline-check`'s other checks measured only the
//!   swaps that went through, and so covered only the sell direction ([`SELL_ONLY_CHECKS`],
//!   R2T-11).

use pipeline_check::{check_market_with_source, CheckOptions, CheckResult, Report, Status};
use pipeline_client::Pubkey;
use serde::Serialize;
use serde_json::{json, Value};

use crate::config::{CONTAINMENT_HOOK_DESTINATION_OWNER_CAN_CHANGE, CONTAINMENT_HOOK_PROGRAM};
use crate::failure::Failure;
use crate::market::{Copy, Market, Session};
use crate::record::{Outcome, Verdict};
use crate::swap::SwapPath;

/// `pipeline-check`'s checks whose swaps deliver a token into its own trader's account, and
/// so meet the containment hook's allow rule: a buy (`quote_matches_swap`, `round_trip`'s
/// sale back) or an exact-out refund (`exact_out_refund`).
pub const TRADER_ACCOUNT_CHECKS: [&str; 3] =
    ["quote_matches_swap", "exact_out_refund", "round_trip"];

/// `pipeline-check`'s checks that measure only swaps that matched their quote or went
/// through (`min_out_enforced`, `compute`) or ignore a failed 1-unit swap (`dust_and_zero`):
/// with every buy into its own traders refused they measure sells alone and still pass.
pub const SELL_ONLY_CHECKS: [&str; 3] = ["min_out_enforced", "compute", "dust_and_zero"];

/// The hook's config: its size with the discriminator, and where it names its home Market
/// (`programs/containment-hook/src/state.rs`, pinned by the hook's `config_v1_bytes_are_pinned`).
const CONFIG_LEN: usize = 237;
const CONFIG_MARKET_AT: usize = 41;

/// Canary's own evidence on one contained mint of the market (R2T-10).
#[derive(Clone, Debug, Serialize)]
pub struct HookEvidence {
    /// The mint's index in the market.
    pub mint: usize,
    /// Whether the hook's config of the mint, `["config", mint]` under the hook, names this
    /// market as the mint's home.
    pub home_market: bool,
    /// How Canary's buy of the mint into an account written as `pipeline-check` writes it
    /// (without the immutable owner extension) failed; `None` when it went through or could
    /// not be tried.
    pub probe: Option<Failure>,
}

impl HookEvidence {
    /// Whether the probe's failure is error 6023 raised by the containment hook program.
    pub fn refused_by_the_hook(&self) -> bool {
        self.probe.as_ref().is_some_and(|failure| {
            failure.program.as_deref() == Some(CONTAINMENT_HOOK_PROGRAM.to_string().as_str())
                && failure.anchor.as_ref().map(|a| a.number).or(failure.code)
                    == Some(CONTAINMENT_HOOK_DESTINATION_OWNER_CAN_CHANGE)
        })
    }

    fn report(&self) -> Value {
        json!({
            "mint": self.mint,
            "home_market": self.home_market,
            "refused_by": self.probe.as_ref().and_then(|f| f.program.clone()),
            "error": self.probe.as_ref().map(|f| f.error_words()),
            "excuses": self.home_market && self.refused_by_the_hook(),
        })
    }
}

/// For each mint of the market our containment hook contains, whether its config names this
/// market and how a buy of it into an account without the immutable owner extension, as
/// `pipeline-check` writes its traders' accounts, fails, each in a fresh copy; `amount` is
/// the buy, in the other mint.
pub fn probe_hook(session: &mut Session, path: &dyn SwapPath, amount: u64) -> Vec<HookEvidence> {
    let market = session.market.clone();
    let mut evidence = vec![];
    for token in 0..market.len() {
        let mint = &market.mints[token];
        if mint.transfer_hook_program() != Some(CONTAINMENT_HOOK_PROGRAM) {
            continue;
        }
        let Some(money) = (0..market.len()).find(|i| *i != token) else {
            continue;
        };
        let mut svm = session.fresh();
        let config = Pubkey::find_program_address(
            &[b"config", mint.address.as_ref()],
            &CONTAINMENT_HOOK_PROGRAM,
        )
        .0;
        session.load(&mut svm, &[config]);
        let home_market = svm.get_account(&config).is_some_and(|account| {
            account.owner == CONTAINMENT_HOOK_PROGRAM
                && account.data.len() == CONFIG_LEN
                && account.data[CONFIG_MARKET_AT..CONFIG_MARKET_AT + 32]
                    == market.address.to_bytes()
        });
        let trader = session
            .seed
            .wallet(&market.address, &format!("conformance hook probe {token}"));
        session.fund(&mut svm, &trader, money, token, amount);
        // The token account as pipeline-check writes its traders': the mint's required
        // extensions only, no immutable owner.
        if let Err(error) = pipeline_check::write_token_account(
            &mut svm,
            &mint.address,
            &mint.token_program,
            &trader,
            0,
        ) {
            session
                .notes
                .push(format!("could not write the hook probe's account: {error}"));
        }
        let leg = session.leg(&mut svm, path, &trader, money, token, amount);
        evidence.push(HookEvidence {
            mint: token,
            home_market,
            probe: leg.swap.err(),
        });
    }
    evidence
}

/// Why the known checks are not counted, in the record's reason.
const KNOWN_UNTIL: &str =
    "known until Pipeline's checker writes the immutable owner extension, HOOK-47";

pub fn run(copy: &Copy, runs_router: bool, evidence: &[HookEvidence]) -> Verdict {
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
    judge(&report, &copy.market, evidence)
}

/// The verdict on `pipeline-check`'s report for `market`, with Canary's own [`probe_hook`]
/// evidence on its contained mints.
pub fn judge(report: &Report, market: &Market, evidence: &[HookEvidence]) -> Verdict {
    let mut numbers: Value = serde_json::from_str(&report.to_json()).unwrap_or(Value::Null);
    if !evidence.is_empty() {
        numbers["canary_hook_probe"] = json!(evidence
            .iter()
            .map(HookEvidence::report)
            .collect::<Vec<_>>());
    }
    let known = known_failures(report, market, evidence);
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
        let partial: Vec<&str> = SELL_ONLY_CHECKS
            .into_iter()
            .filter(|id| report.check(id).is_some_and(|c| c.status != Status::Skip))
            .collect();
        let partial_words = if partial.is_empty() {
            String::new()
        } else {
            numbers["canary_known_partial"] = json!(partial);
            format!(
                " Of those, pipeline-check's {} covered only the sell direction on this market, since every buy into its own traders' accounts was refused.",
                words_list(&partial)
            )
        };
        capitalise(&format!(
            "{reason}{partial_words} Known, not counted: {}, whose swaps fail only with the containment hook's DestinationOwnerCanChange ({CONTAINMENT_HOOK_DESTINATION_OWNER_CAN_CHANGE}), raised by the hook itself on this, the token's home market, because pipeline-check's own traders lack the immutable owner extension; {KNOWN_UNTIL}.",
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

/// The checks of [`TRADER_ACCOUNT_CHECKS`] that warn or fail only with error 6023, on a
/// market with a mint our hook contains, when Canary's own evidence shows, for every such
/// mint, that this is its home market and that the hook itself raises 6023 on a buy into an
/// account like `pipeline-check`'s; none on any other market or without that evidence.
pub fn known_failures(
    report: &Report,
    market: &Market,
    evidence: &[HookEvidence],
) -> Vec<&'static str> {
    let contained: Vec<usize> = (0..market.mints.len())
        .filter(|i| {
            market.mints[*i].transfer_hook.and_then(|h| h.program) == Some(CONTAINMENT_HOOK_PROGRAM)
        })
        .collect();
    let shown = |i: &usize| {
        evidence
            .iter()
            .any(|e| e.mint == *i && e.home_market && e.refused_by_the_hook())
    };
    if contained.is_empty() || !contained.iter().all(shown) {
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
