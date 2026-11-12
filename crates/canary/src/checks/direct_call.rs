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
use solana_transaction::Transaction;

use crate::checks::readable::Trading;
use crate::failure::{Failure, Stage};
use crate::market::Session;
use crate::record::{Outcome, Verdict};
use crate::swap::{direct_swap, SwapRequest};

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
    pub attempts: Vec<Attempt>,
}

const ANOTHER_KEY: &str = "another key signing as the market signer";
const NOT_SIGNING: &str = "the market signer not signing";

/// Calls `pipeline_swap` directly, buying `amount` of `token` with `money`, each call from
/// the same fresh copy.
pub fn measure(session: &mut Session, money: usize, token: usize, amount: u64) -> Measured {
    let mut svm = session.fresh();
    let trader = session.funded_trader(&mut svm, "direct call", money, amount);
    let mut measured = Measured {
        input: money,
        output: token,
        amount,
        unprepared: None,
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
    let impostor = session.seed.wallet(&session.market.address, "direct call impostor");
    let market_address = session.market.address;
    for (how, signer) in [
        (ANOTHER_KEY, AccountMeta::new_readonly(impostor, true)),
        (NOT_SIGNING, AccountMeta::new_readonly(market_address, false)),
    ] {
        let mut attempt = svm.clone();
        let mut tx = Transaction::new_with_payer(
            &direct_swap(&session.market, &request, signer.clone()),
            Some(&trader),
        );
        tx.message.recent_blockhash = attempt.latest_blockhash();
        let failure = attempt
            .send_transaction(tx)
            .err()
            .map(|failed| Failure::from_transaction(Stage::Swap, &session.market.strategy(), &failed));
        measured.attempts.push(Attempt {
            how,
            market_signer: signer.pubkey.to_string(),
            market_signer_signs: signer.is_signer,
            accepted: failure.is_none(),
            failure,
        });
    }
    measured
}

/// Judges `direct_call`; `m` is `None` when the market refuses every trade, and
/// `amount_words` says the amount sent as the record's reader reads it.
pub fn judge(m: Option<&Measured>, trading: &Trading, market: &Pubkey, amount_words: String) -> Verdict {
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
    let numbers = json!({ "attempts": m.attempts });
    let accepted: Vec<&str> = m.attempts.iter().filter(|a| a.accepted).map(|a| a.how).collect();
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
                a.failure.as_ref().map_or_else(String::new, |f| f.to_string())
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
