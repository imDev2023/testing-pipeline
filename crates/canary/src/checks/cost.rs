//! `cost`: reports the round-trip return at every size of `exit_sizes`, and splits the loss
//! at the smallest size and at the reference size into Pipeline's fee on both legs,
//! Token-2022 transfer fees, and the rest, which is the strategy's own fee and spread.
//!
//! - Fail: the ordinary trade's return is in the fail band.
//! - Warn: the ordinary trade's return is between the bands, or any other size returns less
//!   than the pass band; or a step crashed or ran out of compute.
//! - Pass: every size's return is in the pass band.
//!
//! Pipeline's fee is what the router charged in the copy (its swap's return data), never a
//! constant. Since Pipeline 0.3 the sale's fee is taken from what it brought back when the
//! money side is the market's fee mint (wrapped SOL, on every market that trades it and
//! declares no other); otherwise it is charged in the token and valued at the sale's own
//! price.

use serde::Serialize;
use serde_json::{json, Value};

use crate::bands::{band, pass_band_words, Band};
use crate::checks::exit_sizes::Measured;
use crate::checks::readable::Trading;
use crate::market::MintFacts;
use crate::record::{Outcome, Verdict};
use crate::trade::RoundTrip;
use crate::words;

/// Where a round trip's loss went, in money-side units. Signed, because a round trip can
/// return more than it put in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Split {
    pub amount: u64,
    pub put_in: i128,
    pub got_back: i128,
    pub return_ppm: u64,
    pub pipeline_fee: i128,
    /// Pipeline's fee on the buy, as the router charged it, in the mint it was taken in.
    pub pipeline_fee_buy: u64,
    /// That mint, by index: the money side, unless the market declares the token its fee
    /// mint, when the fee comes out of the tokens bought.
    pub pipeline_fee_buy_mint: usize,
    /// Pipeline's fee on the sale, as the router charged it, in the mint it was taken in.
    pub pipeline_fee_sale: u64,
    /// That mint, by index: the money side when it is the market's fee mint, the token
    /// otherwise.
    pub pipeline_fee_sale_mint: usize,
    pub transfer_fees: i128,
    pub rest: i128,
}

/// Splits a round trip that sold back; `None` otherwise.
pub fn split(row: &RoundTrip, money: &MintFacts, token: &MintFacts) -> Option<Split> {
    let buy = row.buy.swap.as_ref().ok()?;
    let sale_leg = row.sell.as_ref()?;
    let sale = sale_leg.swap.as_ref().ok()?;
    let return_ppm = row.return_ppm()?;
    // Tokens valued at the sale's own price: what arrived per token it was charged for,
    // before any Pipeline fee taken from what arrived.
    let in_money = |tokens: u64| -> i128 {
        if sale.net_sent == 0 {
            return 0;
        }
        (tokens as u128 * sale.received as u128 / sale.net_sent as u128) as i128
    };
    // Token-2022 transfer fees the trader bore: on the money sent in and the tokens sent out
    // on the buy, and on the tokens sent in and the money sent out on the sale.
    let output_fee = |leg: &crate::trade::Leg| {
        leg.quote.as_ref().map_or(0, |q| {
            q.strategy_amount_out
                .saturating_sub(q.arrives_out(leg.output))
        })
    };
    let transfer_fees = money.transfer_fee_on(row.buy.clock.epoch, row.buy.amount_in) as i128
        + in_money(output_fee(&row.buy))
        + in_money(token.transfer_fee_on(sale_leg.clock.epoch, sale_leg.amount_in))
        + output_fee(sale_leg) as i128;
    // Each leg's fee in money-side units: as charged when it was taken in the money side,
    // and valued at the sale's price when it was taken in the token.
    let buy_fee = if buy.fee_mint == row.buy.input {
        buy.pipeline_fee as i128
    } else {
        in_money(buy.pipeline_fee)
    };
    let sale_fee = if sale.fee_mint == sale_leg.output {
        sale.pipeline_fee as i128
    } else {
        in_money(sale.pipeline_fee)
    };
    let pipeline_fee = buy_fee + sale_fee;
    let put_in = buy.trader_spent as i128;
    let got_back = sale.trader_received as i128;
    Some(Split {
        amount: row.amount,
        put_in,
        got_back,
        return_ppm,
        pipeline_fee,
        pipeline_fee_buy: buy.pipeline_fee,
        pipeline_fee_buy_mint: buy.fee_mint,
        pipeline_fee_sale: sale.pipeline_fee,
        pipeline_fee_sale_mint: sale.fee_mint,
        transfer_fees,
        rest: put_in - got_back - pipeline_fee - transfer_fees,
    })
}

fn numbers(m: &Measured) -> Value {
    let money = &m.mints[m.money];
    json!({
        "money": m.money,
        "basis": m.ladder.basis,
        "pairs": m.pairs.iter().map(|pair| {
            let token = &m.mints[pair.token];
            let reference = pair.reference_row(m.ladder.reference);
            json!({
                "token": pair.token,
                "returns": pair.rows.iter().map(|row| json!({
                    "amount": row.amount,
                    "amount_words": m.amount(row.amount),
                    "return_ppm": row.return_ppm(),
                    "band": row.return_ppm().map(band),
                })).collect::<Vec<_>>(),
                "smallest": pair.rows.first().and_then(|row| split(row, money, token)),
                "reference": reference.and_then(|(row, _)| split(row, money, token)),
                "reference_is_stand_in": reference.map(|(_, stand_in)| stand_in),
            })
        }).collect::<Vec<_>>(),
    })
}

fn inputs(m: &Measured) -> Value {
    json!({
        "sizes": m.ladder.sizes,
        "reference": m.ladder.reference,
        "basis": m.ladder.basis,
        "money": m.money,
    })
}

pub fn judge(m: &Measured, trading: &Trading) -> Verdict {
    if let Trading::NotRun(why) = trading {
        return Verdict::not_run(format!("Not run: {why}."));
    }
    let numbers = numbers(m);
    let inputs = inputs(m);
    let rows = || m.pairs.iter().flat_map(|p| p.rows.iter());
    if rows().all(|r| r.return_ppm().is_none()) {
        return Verdict::new(
            Outcome::NotRun,
            "Not run: no size could be bought and sold back.",
            inputs,
            numbers,
        );
    }
    // The ordinary trade's worst return, and every other size's worst.
    let ordinary: Vec<&RoundTrip> = m
        .pairs
        .iter()
        .flat_map(|p| p.ordinary_rows(m.ladder.reference))
        .filter(|r| r.return_ppm().is_some())
        .collect();
    let worst_ordinary = ordinary.iter().min_by_key(|r| r.return_ppm());
    let describe = |row: &RoundTrip| {
        let put_in = row.put_in().unwrap_or(0);
        let back = row.sold().map_or(0, |s| s.trader_received);
        format!(
            "{} of what was put in ({} in, {} back)",
            words::percent(row.return_ppm().unwrap_or(0)),
            m.amount(put_in),
            m.amount(back)
        )
    };
    let stand_in_note = m
        .pairs
        .iter()
        .find_map(|p| p.reference_row(m.ladder.reference).filter(|(_, s)| *s))
        .map_or_else(String::new, |(row, _)| {
            format!(
                " The reference size could not be bought and sold back, so {} stands in for it.",
                m.amount(row.amount)
            )
        });
    if let Some(row) = worst_ordinary.filter(|r| band(r.return_ppm().unwrap_or(0)) == Band::Fail) {
        return Verdict::new(
            Outcome::Fail,
            format!(
                "The ordinary trade of {} returns {}.{stand_in_note}",
                m.amount(row.amount),
                describe(row)
            ),
            inputs,
            numbers,
        );
    }
    if let Some(row) = worst_ordinary.filter(|r| band(r.return_ppm().unwrap_or(0)) == Band::Between)
    {
        return Verdict::new(
            Outcome::Warn,
            format!(
                "The ordinary trade of {} returns {}.{stand_in_note}",
                m.amount(row.amount),
                describe(row)
            ),
            inputs,
            numbers,
        );
    }
    let worst_other = rows()
        .filter(|r| r.return_ppm().is_some_and(|ppm| band(ppm) != Band::Pass))
        .min_by_key(|r| r.return_ppm());
    if let Some(row) = worst_other {
        return Verdict::new(
            Outcome::Warn,
            format!(
                "The ordinary trade returns {}, but {} returns {}.{stand_in_note}",
                pass_band_words(),
                m.amount(row.amount),
                describe(row)
            ),
            inputs,
            numbers,
        );
    }
    let fault = rows()
        .flat_map(|r| r.legs())
        .flat_map(|leg| leg.failures())
        .find(|f| f.class.is_fault());
    if let Some(fault) = fault {
        return Verdict::new(
            Outcome::Warn,
            format!(
                "Every size returns {}, but {} hit {} ({}).{stand_in_note}",
                pass_band_words(),
                fault.stage.describe(),
                fault.class.words(),
                fault.error_words()
            ),
            inputs,
            numbers,
        );
    }
    let best = worst_ordinary.map_or_else(String::new, |row| {
        format!(
            " The ordinary trade of {} returns {}.",
            m.amount(row.amount),
            describe(row)
        )
    });
    Verdict::new(
        Outcome::Pass,
        format!(
            "Every size that round-tripped returns {}.{best}{stand_in_note}",
            pass_band_words()
        ),
        inputs,
        numbers,
    )
}
