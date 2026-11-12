//! `exit_transferred`: one wallet buys the reference size and sends the tokens to a second
//! wallet, which sells them (`CANARY-27`, `CANARY-37`).
//!
//! - Fail: the transfer went through and the second wallet cannot sell.
//! - Warn: the transfer is refused, for any token, ours or anyone's: the reason says the
//!   token could not be sent to another wallet and what the buyer got back by selling it; or
//!   the second wallet's return is below the pass band while the buyer's own is not.
//! - Pass: the second wallet's return is in the pass band.
//!
//! A refused transfer is never "a buyer could not sell back": the buyer could still sell.

use pipeline_client::Pubkey;
use serde::Serialize;
use serde_json::{json, Value};

use crate::bands::pass_band_words;
use crate::checks::exit_sizes;
use crate::checks::exits::{
    across_pairs, below_tolerance, could_not_sell_back, in_pass_band, references, return_ppm,
    round_trip_failure, Committed, Money, PairVerdict, Reference,
};
use crate::checks::readable::Trading;
use crate::checks::timed::stand_in_note;
use crate::failure::Failure;
use crate::market::{token_amount, Session};
use crate::record::{Outcome, Verdict};
use crate::swap::SwapPath;
use crate::trade::{Leg, RoundTrip};

/// One pair's transfer.
#[derive(Clone, Debug, Serialize)]
pub struct TransferPair {
    pub token: usize,
    pub reference: Option<Reference>,
    /// The buyer's buy, and the buyer's own sale when the transfer was refused.
    pub buyer: Option<RoundTrip>,
    #[serde(serialize_with = "address")]
    pub receiver: Pubkey,
    /// The mint's transfer hook program, when it has one.
    #[serde(skip)]
    pub hook: Option<Pubkey>,
    /// What was sent, and what arrived or why the transfer was refused; `None` when the buy
    /// delivered nothing to send.
    pub sent: u64,
    pub transfer: Option<Result<u64, Failure>>,
    /// The second wallet's sale of what arrived.
    pub receiver_sale: Option<Leg>,
}

fn address<S: serde::Serializer>(key: &Pubkey, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&key.to_string())
}

#[derive(Clone, Debug, Serialize)]
pub struct Measured {
    pub pairs: Vec<TransferPair>,
}

/// One wallet buys, sends everything it bought to a second wallet, and the second sells it;
/// when the transfer is refused, the buyer sells it instead.
pub fn measure(
    session: &mut Session,
    path: &dyn SwapPath,
    sizes: &exit_sizes::Measured,
) -> Measured {
    let money = sizes.money;
    let pairs = references(sizes)
        .into_iter()
        .map(|(token, reference)| {
            let market = session.market.address;
            let buyer = session
                .seed
                .wallet(&market, &format!("exit_transferred {token} buyer"));
            let receiver = session
                .seed
                .wallet(&market, &format!("exit_transferred {token} receiver"));
            let empty = TransferPair {
                token,
                reference: reference.clone(),
                buyer: None,
                receiver,
                hook: session.market.mints[token].transfer_hook,
                sent: 0,
                transfer: None,
                receiver_sale: None,
            };
            let Some(reference) = reference else {
                return empty;
            };
            let mut svm = session.fresh();
            session.fund(&mut svm, &buyer, money, token, reference.amount);
            let buy = session.leg(&mut svm, path, &buyer, money, token, reference.amount);
            let held = token_amount(&svm, &session.market.ata(&buyer, token)).unwrap_or(0);
            let mut pair = TransferPair {
                buyer: Some(RoundTrip {
                    amount: reference.amount,
                    wallet: buyer,
                    buy: buy.clone(),
                    sell: None,
                }),
                sent: held,
                ..empty
            };
            if buy.swap.is_err() || held == 0 {
                return pair;
            }
            let transfer = session.transfer(&mut svm, token, &buyer, &receiver, held);
            match &transfer {
                Ok(_) => {
                    // The second wallet needs SOL for fees and an account of the money mint to
                    // be paid into; its token account holds what arrived.
                    session.open_wallet(&mut svm, &receiver, money);
                    pair.receiver_sale =
                        session.sell_all(&mut svm, path, &buy, &receiver, token, money);
                }
                Err(_) => {
                    let sale = session.sell_all(&mut svm, path, &buy, &buyer, token, money);
                    if let Some(row) = pair.buyer.as_mut() {
                        row.sell = sale;
                    }
                }
            }
            pair.transfer = Some(transfer);
            pair
        })
        .collect();
    Measured { pairs }
}

impl Measured {
    /// Every swap committed: the buy is the ordinary trade's, the sales are not.
    pub fn committed(&self) -> Vec<Committed> {
        let mut out = vec![];
        for pair in &self.pairs {
            if let Some(buyer) = &pair.buyer {
                out.push(Committed {
                    leg: buyer.buy.clone(),
                    ordinary: true,
                    context: "exit_transferred's buy".to_string(),
                });
                if let Some(sale) = &buyer.sell {
                    out.push(Committed {
                        leg: sale.clone(),
                        ordinary: false,
                        context: "exit_transferred's sale by the buyer".to_string(),
                    });
                }
            }
            if let Some(sale) = &pair.receiver_sale {
                out.push(Committed {
                    leg: sale.clone(),
                    ordinary: false,
                    context: "exit_transferred's sale by the second wallet".to_string(),
                });
            }
        }
        out
    }

    /// "A buyer could not sell back": the second wallet's sale failed, or, after a refused
    /// transfer, the buyer's own sale failed. The refusal itself never counts (`CANARY-27`).
    pub fn could_not_sell_back(&self) -> bool {
        self.pairs.iter().any(|pair| {
            pair.receiver_sale
                .as_ref()
                .is_some_and(|leg| leg.swap.is_err())
                || pair.buyer.as_ref().is_some_and(could_not_sell_back)
        })
    }
}

fn judge_pair(pair: &TransferPair, money: &Money) -> PairVerdict {
    let verdict = |outcome, reason| PairVerdict {
        token: pair.token,
        outcome,
        reason,
    };
    let (Some(reference), Some(buyer)) = (&pair.reference, &pair.buyer) else {
        return verdict(
            Outcome::NotRun,
            "Not run: no size could be bought and sold back.".to_string(),
        );
    };
    let stand_in = stand_in_note(reference, money);
    let amount = money.amount(reference.amount);
    if let Err(failure) = &buyer.buy.swap {
        return verdict(
            Outcome::NotRun,
            format!("Not run: the buy of {amount} failed ({failure})."),
        );
    }
    let put_in = buyer.put_in().unwrap_or(0);
    let Some(transfer) = &pair.transfer else {
        return verdict(
            Outcome::NotRun,
            format!("Not run: the buy of {amount} delivered nothing to send."),
        );
    };
    let arrived = match transfer {
        Err(refusal) => {
            let sale = match buyer.sold() {
                Some(sale) => format!(
                    "the buyer got back {} by selling it",
                    money.returned(put_in, sale.trader_received)
                ),
                None => format!(
                    "the buyer could not sell it either ({})",
                    round_trip_failure(buyer).unwrap_or_default()
                ),
            };
            let refused = match pair.hook {
                Some(hook) if refusal.program.as_deref() == Some(hook.to_string().as_str()) => {
                    format!(
                        "its transfer hook {hook} refused ({})",
                        refusal.error_words()
                    )
                }
                _ => refusal.to_string(),
            };
            return verdict(
                Outcome::Warn,
                format!(
                    "The token could not be sent to another wallet: {refused}; {sale}.{stand_in}"
                ),
            );
        }
        Ok(arrived) => *arrived,
    };
    let Some(sale) = &pair.receiver_sale else {
        return verdict(
            Outcome::Fail,
            format!(
                "The transfer of the tokens bought for {amount} went through, but {arrived} units arrived, nothing the second wallet could sell.{stand_in}"
            ),
        );
    };
    let received = match &sale.swap {
        Err(failure) => {
            return verdict(
                Outcome::Fail,
                format!(
                    "A second wallet sent the tokens bought for {amount} could not sell them ({failure}).{stand_in}"
                ),
            )
        }
        Ok(receipt) => receipt.trader_received,
    };
    let ppm = return_ppm(put_in, received).unwrap_or(0);
    let got = money.returned(put_in, received);
    if in_pass_band(ppm) {
        return verdict(
            Outcome::Pass,
            format!(
                "A second wallet sent the tokens bought for {amount} sold them and got back {got} of what the buyer put in.{stand_in}"
            ),
        );
    }
    let own = reference.own_return_ppm.unwrap_or(0);
    let own_words = crate::words::percent(own);
    // Below the pass band: a finding when the buyer's own sale is not, or when the transfer
    // cost more than the tolerance on top of a return already below it (`CANARY-37`).
    if in_pass_band(own) || below_tolerance(own, ppm) {
        return verdict(
            Outcome::Warn,
            format!(
                "A second wallet sent the tokens bought for {amount} got back {got}, below {} back, where the buyer selling them got back {own_words}.{stand_in}",
                pass_band_words()
            ),
        );
    }
    verdict(
        Outcome::Pass,
        format!(
            "A second wallet sent the tokens bought for {amount} got back {got}, as the buyer selling them did ({own_words}); that return is the market's own, which cost reports.{stand_in}"
        ),
    )
}

fn numbers(m: &Measured, money: &Money) -> Value {
    json!({
        "could_not_sell_back": m.could_not_sell_back(),
        "pairs": m.pairs.iter().map(|pair| {
            let put_in = pair.buyer.as_ref().and_then(RoundTrip::put_in);
            let received = pair.receiver_sale.as_ref().and_then(|l| l.swap.as_ref().ok()).map(|r| r.trader_received);
            json!({
                "token": pair.token,
                "amount": pair.reference.as_ref().map(|r| r.amount),
                "stand_in": pair.reference.as_ref().is_some_and(|r| r.stand_in),
                "buyer": pair.buyer.as_ref().map(|row| money.row(row)),
                "receiver": pair.receiver.to_string(),
                "sent": pair.sent,
                "transferred": pair.transfer.as_ref().map(Result::is_ok),
                "arrived": pair.transfer.as_ref().and_then(|t| t.as_ref().ok()),
                "transfer_failure": pair.transfer.as_ref().and_then(|t| t.as_ref().err()),
                "receiver_sold": pair.receiver_sale.as_ref().map(|l| l.swap.is_ok()),
                "receiver_got_back": received,
                "receiver_return_ppm": put_in.zip(received).and_then(|(p, r)| return_ppm(p, r)),
                "receiver_sale_failure": pair.receiver_sale.as_ref().and_then(|l| l.swap.as_ref().err()),
                "buyer_own_return_ppm": pair.reference.as_ref().and_then(|r| r.own_return_ppm),
            })
        }).collect::<Vec<_>>(),
    })
}

fn inputs(m: &Measured) -> Value {
    json!({
        "amounts": m.pairs.iter().map(|p| p.reference.as_ref().map(|r| r.amount)).collect::<Vec<_>>(),
        "sent": "everything the buyer bought, to a new wallet, which sells it",
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
