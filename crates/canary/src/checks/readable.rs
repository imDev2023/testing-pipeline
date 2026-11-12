//! `readable`: calls `pipeline_market_info`, resolves accounts and quotes the smallest size
//! in every direction.
//!
//! - Fail: the strategy's current version cannot read the market's state (a stranded
//!   market).
//! - Warn: a direction crashes or runs out of compute.
//! - Pass: the version reads the market; a market that reads but refuses every trade passes
//!   here, and its trading checks are "not run" with the strategy's own error.

use serde::Serialize;
use serde_json::json;

use crate::failure::{Failure, FailureClass};
use crate::market::Session;
use crate::record::{Outcome, Verdict};
use crate::trade::Quote;

/// One direction's probe.
#[derive(Clone, Debug, Serialize)]
pub struct Probe {
    pub input: usize,
    pub output: usize,
    pub amount: u64,
    pub result: Result<Quote, Failure>,
}

/// What `readable` measured.
#[derive(Clone, Debug, Serialize)]
pub struct Measured {
    pub market_info: Result<(), Failure>,
    pub probes: Vec<Probe>,
}

/// Probes every direction: the money side with the smallest size, and every other mint
/// with what that smallest buy of it would deliver (one unit when the buy quotes nothing).
pub fn measure(session: &mut Session, money: usize, smallest: u64) -> Measured {
    let mut svm = session.fresh();
    let market_info = session.market_info(&svm).map(|_| ());
    let n = session.market.len();
    let mut bought = vec![1u64; n];
    let mut probes = vec![];
    for output in (0..n).filter(|o| *o != money) {
        let result = session.probe(&mut svm, money, output, smallest);
        if let Ok(quote) = &result {
            bought[output] = quote.amount_out.max(1);
        }
        probes.push(Probe {
            input: money,
            output,
            amount: smallest,
            result,
        });
    }
    for input in (0..n).filter(|i| *i != money) {
        for output in (0..n).filter(|o| *o != input) {
            let amount = bought[input];
            let result = session.probe(&mut svm, input, output, amount);
            probes.push(Probe {
                input,
                output,
                amount,
                result,
            });
        }
    }
    Measured {
        market_info,
        probes,
    }
}

/// Whether the trading checks can run on a market, as `readable` found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Trading {
    Open,
    /// The trading checks are "not run", for this reason.
    NotRun(String),
}

fn failures(m: &Measured) -> impl Iterator<Item = &Failure> {
    m.market_info
        .as_ref()
        .err()
        .into_iter()
        .chain(m.probes.iter().filter_map(|p| p.result.as_ref().err()))
}

/// Judges `readable`, and says whether the trading checks can run.
pub fn judge(m: &Measured) -> (Verdict, Trading) {
    let numbers = json!({
        "market_info": m.market_info.as_ref().err(),
        "directions": m.probes,
    });
    let inputs = json!({
        "directions": m.probes.iter().map(|p| json!({ "input": p.input, "output": p.output, "amount": p.amount })).collect::<Vec<_>>(),
    });
    if let Some(stranded) = failures(m).find(|f| f.class == FailureClass::CannotReadState) {
        let reason = format!(
            "The strategy's current version cannot read this market's state ({}, while {}), so the market is stranded.",
            stranded.error_words(),
            stranded.stage.describe()
        );
        return (
            Verdict::new(Outcome::Fail, reason.clone(), inputs, numbers),
            Trading::NotRun(format!(
                "the strategy's current version cannot read the market's state ({})",
                stranded.error_words()
            )),
        );
    }
    let quoted = m.probes.iter().filter(|p| p.result.is_ok()).count();
    // A market refuses every trade when every direction is refused cleanly. When a quote
    // crashes or runs out of compute, the trades still run: a swap that works without a
    // quote is itself a finding.
    let refusals: Vec<&Failure> = m
        .probes
        .iter()
        .filter_map(|p| p.result.as_ref().err())
        .collect();
    let trading = if m.probes.is_empty() {
        Trading::NotRun("the market has no direction to trade".into())
    } else if quoted == 0 && refusals.iter().all(|f| !f.class.is_fault()) {
        Trading::NotRun(format!(
            "the market refuses every trade ({})",
            refusals[0].error_words()
        ))
    } else {
        Trading::Open
    };
    if let Some(fault) = failures(m).find(|f| f.class.is_fault()) {
        let reason = format!(
            "The strategy reads the market, but {} hit {} ({}).",
            fault.stage.describe(),
            fault.class.words(),
            fault.error_words()
        );
        return (
            Verdict::new(Outcome::Warn, reason, inputs, numbers),
            trading,
        );
    }
    let reason = match &trading {
        Trading::Open => format!(
            "The strategy's current version reads the market and quotes {quoted} of its {} directions.",
            m.probes.len()
        ),
        Trading::NotRun(why) => format!("The strategy's current version reads the market, but {why}."),
    };
    (
        Verdict::new(Outcome::Pass, reason, inputs, numbers),
        trading,
    )
}
