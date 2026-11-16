//! `direct_call`: calls the strategy's `pipeline_swap` without the router, once with another
//! key signing as the market signer and once with the real market signer not signing, after
//! sending the input to the vault as the router would.
//!
//! - Fail: never.
//! - Warn: a call is accepted, so trades can skip the Pipeline fee and leave no swap event.
//! - Pass: both calls are refused.
//! - "Not run" when the market refuses every trade, or a trade's accounts cannot be resolved.

use pipeline_client::{AccountMeta, Pubkey};
use serde::Serialize;
use serde_json::json;

use crate::checks::readable::Trading;
use crate::failure::Failure;
use crate::market::Session;
use crate::record::{Outcome, Verdict};
use crate::swap::{call_directly, SwapRequest};

/// One call without the router.
#[derive(Clone, Debug, Serialize)]
pub struct Attempt {
    /// How the market signer was given.
    pub how: &'static str,
    /// The first account of the call, the market signer's place.
    pub market_signer: String,
    pub market_signer_signs: bool,
    pub accepted: bool,
    /// Why the call was refused.
    pub failure: Option<Failure>,
}

/// What `direct_call` measured.
#[derive(Clone, Debug, Serialize)]
pub struct Measured {
    pub input: usize,
    pub output: usize,
    pub amount: u64,
    /// The trade could not be prepared, so nothing was called.
    pub unprepared: Option<Failure>,
    /// The same call with the market signer signing, as the router passes it: unless it is
    /// accepted, a refusal of the two calls below says nothing about the market signer.
    pub control: Option<Attempt>,
    pub attempts: Vec<Attempt>,
}

const ANOTHER_KEY: &str = "another key signing as the market signer";
const NOT_SIGNING: &str = "the market signer not signing";
const AS_THE_ROUTER: &str = "the market signer signing, as the router passes it";

/// Calls `pipeline_swap` directly, buying `amount` of `token` with `money`, each call from
/// the same fresh copy.
pub fn measure(session: &mut Session, money: usize, token: usize, amount: u64) -> Measured {
    let mut svm = session.fresh();
    let trader = session.seed.wallet(&session.market.address, "direct call");
    session.fund(&mut svm, &trader, money, token, amount);
    let mut measured = Measured {
        input: money,
        output: token,
        amount,
        unprepared: None,
        control: None,
        attempts: vec![],
    };
    let prepared = match session.prepare(&mut svm, &trader, money, token, amount) {
        Ok(prepared) => prepared,
        Err(failure) => {
            measured.unprepared = Some(failure);
            return measured;
        }
    };
    let extra = session.extra.clone();
    let request = SwapRequest {
        trader,
        input: money,
        output: token,
        amount_in: amount,
        strategy_accounts: &prepared.resolved,
        extra: &extra,
        hooks: &prepared.hooks,
    };
    let impostor = session
        .seed
        .wallet(&session.market.address, "direct call impostor");
    let market_address = session.market.address;
    for (how, signer) in [
        (
            AS_THE_ROUTER,
            AccountMeta::new_readonly(market_address, true),
        ),
        (ANOTHER_KEY, AccountMeta::new_readonly(impostor, true)),
        (
            NOT_SIGNING,
            AccountMeta::new_readonly(market_address, false),
        ),
    ] {
        let mut attempt = svm.clone();
        let failure = call_directly(&mut attempt, &session.market, &request, signer.clone()).err();
        let attempt = Attempt {
            how,
            market_signer: signer.pubkey.to_string(),
            market_signer_signs: signer.is_signer,
            accepted: failure.is_none(),
            failure,
        };
        if how == AS_THE_ROUTER {
            measured.control = Some(attempt);
        } else {
            measured.attempts.push(attempt);
        }
    }
    measured
}

/// Judges `direct_call`; `m` is `None` when the market refuses every trade, and
/// `amount_words` says the amount sent as the record's reader reads it.
pub fn judge(
    m: Option<&Measured>,
    trading: &Trading,
    market: &Pubkey,
    amount_words: String,
) -> Verdict {
    let m = match (trading, m) {
        (Trading::NotRun(why), _) => return Verdict::not_run(format!("Not run: {why}.")),
        (Trading::Open, None) => {
            return Verdict::not_run("Not run: the market has no direction to trade.")
        }
        (Trading::Open, Some(m)) => m,
    };
    if let Some(failure) = &m.unprepared {
        return Verdict::not_run(format!(
            "Not run: the trade's accounts could not be resolved ({failure})."
        ));
    }
    let inputs = json!({
        "input": m.input,
        "output": m.output,
        "amount": m.amount,
        "amount_words": amount_words,
        "real_market_signer": market.to_string(),
        "calls": [ANOTHER_KEY, NOT_SIGNING],
    });
    let numbers = json!({ "control": m.control, "attempts": m.attempts });
    if let Some(control) = m.control.as_ref().filter(|c| !c.accepted) {
        return Verdict::new(
            Outcome::NotRun,
            format!(
                "Not run: the strategy refused even the call with {} ({}), so refusals of the calls without the router would say nothing about its market signer.",
                control.how,
                control.failure.as_ref().map_or_else(String::new, |f| f.to_string())
            ),
            inputs,
            numbers,
        );
    }
    let accepted: Vec<&str> = m
        .attempts
        .iter()
        .filter(|a| a.accepted)
        .map(|a| a.how)
        .collect();
    if !accepted.is_empty() {
        return Verdict::new(
            Outcome::Warn,
            format!(
                "The strategy accepted a pipeline_swap call without the router ({}), so trades can skip the Pipeline fee and leave no swap event.",
                accepted.join(", and ")
            ),
            inputs,
            numbers,
        );
    }
    let refusals: Vec<String> = m
        .attempts
        .iter()
        .map(|a| {
            format!(
                "with {} ({})",
                a.how,
                a.failure
                    .as_ref()
                    .map_or_else(String::new, |f| f.to_string())
            )
        })
        .collect();
    Verdict::new(
        Outcome::Pass,
        format!(
            "The strategy refused both pipeline_swap calls without the router: {}.",
            refusals.join(", and ")
        ),
        inputs,
        numbers,
    )
}
