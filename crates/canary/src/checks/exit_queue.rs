//! `exit_queue`: five wallets buy the reference size one after another, then sell in the same
//! order, all in one copy (`CANARY-16`). Only the total is judged: in a thin pool the first
//! buyer out gains what the last one loses, which is ordinary price movement.
//!
//! - Fail: any of the five cannot sell, or together they get back within the fail band.
//! - Warn: together they get back less than the pass band.
//! - Pass: all five sell and together get back within the pass band.

use serde::Serialize;
use serde_json::{json, Value};

use crate::bands::{band, pass_band_words, Band};
use crate::checks::exit_sizes;
use crate::checks::exits::{
    across_pairs, could_not_sell_back, references, return_ppm, round_trip_failure, Committed,
    Money, PairVerdict, Reference,
};
use crate::checks::readable::Trading;
use crate::checks::timed::stand_in_note;
use crate::config::QUEUE_BUYERS;
use crate::market::Session;
use crate::record::{Outcome, Verdict};
use crate::swap::SwapPath;
use crate::trade::RoundTrip;

/// One pair's queue: each buyer's buy and sale, in order.
#[derive(Clone, Debug, Serialize)]
pub struct QueuePair {
    pub token: usize,
    pub reference: Option<Reference>,
    pub buyers: Vec<RoundTrip>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Measured {
    pub pairs: Vec<QueuePair>,
}

/// The buyers buy in turn, then sell everything they bought in the same order.
pub fn measure(
    session: &mut Session,
    path: &dyn SwapPath,
    sizes: &exit_sizes::Measured,
) -> Measured {
    let money = sizes.money;
    let pairs = references(sizes)
        .into_iter()
        .map(|(token, reference)| {
            let Some(reference) = reference else {
                return QueuePair {
                    token,
                    reference: None,
                    buyers: vec![],
                };
            };
            let mut svm = session.fresh();
            let mut buyers: Vec<RoundTrip> = (0..QUEUE_BUYERS)
                .map(|i| {
                    let trader = session.seed.wallet(
                        &session.market.address,
                        &format!("exit_queue {token} buyer {i}"),
                    );
                    session.fund(&mut svm, &trader, money, token, reference.amount);
                    let buy = session.leg(&mut svm, path, &trader, money, token, reference.amount);
                    RoundTrip {
                        amount: reference.amount,
                        wallet: trader,
                        buy,
                        sell: None,
                    }
                })
                .collect();
            for buyer in &mut buyers {
                buyer.sell =
                    session.sell_all(&mut svm, path, &buyer.buy, &buyer.wallet, token, money);
            }
            QueuePair {
                token,
                reference: Some(reference),
                buyers,
            }
        })
        .collect();
    Measured { pairs }
}

impl Measured {
    /// Every swap committed: the first buyer's buy is the ordinary trade's; every later swap
    /// trades in a state other buyers moved.
    pub fn committed(&self) -> Vec<Committed> {
        let mut out = vec![];
        for pair in &self.pairs {
            for (i, buyer) in pair.buyers.iter().enumerate() {
                out.push(Committed {
                    leg: buyer.buy.clone(),
                    ordinary: i == 0,
                    context: format!("exit_queue's buy by buyer {}", i + 1),
                });
                if let Some(sale) = &buyer.sell {
                    out.push(Committed {
                        leg: sale.clone(),
                        ordinary: false,
                        context: format!("exit_queue's sale by buyer {}", i + 1),
                    });
                }
            }
        }
        out
    }

    pub fn could_not_sell_back(&self) -> bool {
        self.pairs
            .iter()
            .flat_map(|p| p.buyers.iter())
            .any(could_not_sell_back)
    }
}

/// What the buyers that bought put in and got back together.
fn totals(pair: &QueuePair) -> (u64, u64) {
    pair.buyers
        .iter()
        .filter(|b| b.bought())
        .fold((0u64, 0u64), |(put_in, got_back), b| {
            (
                put_in.saturating_add(b.put_in().unwrap_or(0)),
                got_back.saturating_add(b.sold().map_or(0, |s| s.trader_received)),
            )
        })
}

fn judge_pair(pair: &QueuePair, money: &Money) -> PairVerdict {
    let verdict = |outcome, reason| PairVerdict {
        token: pair.token,
        outcome,
        reason,
    };
    let Some(reference) = &pair.reference else {
        return verdict(
            Outcome::NotRun,
            "Not run: no size could be bought and sold back.".to_string(),
        );
    };
    let stand_in = stand_in_note(reference, money);
    let amount = money.amount(reference.amount);
    let unbought: Vec<String> = pair
        .buyers
        .iter()
        .enumerate()
        .filter(|(_, b)| !b.bought())
        .map(|(i, b)| {
            format!(
                "buyer {} ({})",
                i + 1,
                round_trip_failure(b).unwrap_or_default()
            )
        })
        .collect();
    let unbought_note = if unbought.is_empty() {
        String::new()
    } else {
        format!(" Could not buy: {}.", unbought.join(", "))
    };
    if unbought.len() == pair.buyers.len() {
        return verdict(
            Outcome::NotRun,
            format!("Not run: no buyer could buy {amount}.{unbought_note}"),
        );
    }
    let n = pair.buyers.len();
    if let Some((i, stuck)) = pair
        .buyers
        .iter()
        .enumerate()
        .find(|(_, b)| could_not_sell_back(b))
    {
        return verdict(
            Outcome::Fail,
            format!(
                "Of {n} wallets that each bought {amount} and sold in the same order, buyer {} could not sell ({}).{unbought_note}{stand_in}",
                i + 1,
                round_trip_failure(stuck).unwrap_or_default()
            ),
        );
    }
    let (put_in, got_back) = totals(pair);
    let ppm = return_ppm(put_in, got_back).unwrap_or(0);
    let together = format!(
        "{} wallets that each bought {amount} and sold in the same order got back {} together",
        n - unbought.len(),
        money.returned(put_in, got_back)
    );
    match band(ppm) {
        Band::Fail => verdict(
            Outcome::Fail,
            format!("{together}.{unbought_note}{stand_in}"),
        ),
        Band::Between => verdict(
            Outcome::Warn,
            format!(
                "{together}, less than {} back.{unbought_note}{stand_in}",
                pass_band_words()
            ),
        ),
        Band::Pass => verdict(
            Outcome::Pass,
            format!("All {together}.{unbought_note}{stand_in}"),
        ),
    }
}

fn numbers(m: &Measured, money: &Money) -> Value {
    json!({
        "could_not_sell_back": m.could_not_sell_back(),
        "pairs": m.pairs.iter().map(|pair| {
            let (put_in, got_back) = totals(pair);
            json!({
                "token": pair.token,
                "amount": pair.reference.as_ref().map(|r| r.amount),
                "stand_in": pair.reference.as_ref().is_some_and(|r| r.stand_in),
                "put_in": put_in,
                "got_back": got_back,
                "return_ppm": return_ppm(put_in, got_back),
                "buyers": pair.buyers.iter().map(|b| money.row(b)).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
    })
}

fn inputs(m: &Measured) -> Value {
    json!({
        "buyers": QUEUE_BUYERS,
        "amounts": m.pairs.iter().map(|p| p.reference.as_ref().map(|r| r.amount)).collect::<Vec<_>>(),
        "order": "all buy in turn, then all sell in the order they bought",
    })
}

pub fn judge(m: &Measured, sizes: &exit_sizes::Measured, trading: &Trading) -> Verdict {
    if let Trading::NotRun(why) = trading {
        return Verdict::not_run(format!("Not run: {why}."));
    }
    let money = Money(sizes);
    let pairs: Vec<PairVerdict> = m.pairs.iter().map(|p| judge_pair(p, &money)).collect();
    let (outcome, reason) = across_pairs(&pairs);
    Verdict::new(outcome, reason, inputs(m), numbers(m, &money))
}
