//! `exit_wallets`: round-trips the reference size from five fresh wallets, the market
//! creator, the strategy's upgrade authority and each mint authority, each from the same
//! starting state (`CANARY-16`). A key that is a program's address, not a wallet, is skipped
//! and named.
//!
//! - Fail: fresh wallets get different results from the same state, or an insider gets more
//!   back than a fresh wallet.
//! - Warn: an insider gets less back than a fresh wallet.
//! - Pass: all get the same.

use std::cmp::Ordering;

use pipeline_client::{self as client, pda, Pubkey};
use serde::Serialize;
use serde_json::{json, Value};

use crate::checks::exit_sizes;
use crate::checks::exits::{
    across_pairs, could_not_sell_back, references, round_trip_failure, Committed, Money,
    PairVerdict, Reference,
};
use crate::checks::readable::Trading;
use crate::checks::timed::stand_in_note;
use crate::config::FRESH_WALLETS;
use crate::market::Session;
use crate::record::{Outcome, Verdict};
use crate::swap::SwapPath;
use crate::trade::RoundTrip;

/// Who a wallet is to the market.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Insider {
    /// Its roles, in words: "the market creator", "the mint authority of mint 1".
    pub roles: Vec<String>,
    #[serde(serialize_with = "address")]
    pub key: Pubkey,
    /// Why it was skipped, when it is a program's address and not a wallet.
    pub skipped: Option<String>,
}

impl Insider {
    pub fn role_words(&self) -> String {
        join_and(&self.roles)
    }

    /// Who it is, in words: "the market creator", or "the wallet that is the market creator
    /// and the mint authority of mint 1", with its address.
    pub fn who(&self) -> String {
        if self.roles.len() == 1 {
            format!("{} ({})", self.role_words(), self.key)
        } else {
            format!("the wallet that is {} ({})", self.role_words(), self.key)
        }
    }
}

fn join_and(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn address<S: serde::Serializer>(key: &Pubkey, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&key.to_string())
}

/// One wallet's round trip.
#[derive(Clone, Debug, Serialize)]
pub struct WalletRow {
    /// "a fresh wallet", or the insider's roles.
    pub who: String,
    pub fresh: bool,
    pub row: RoundTrip,
}

/// One pair's wallets.
#[derive(Clone, Debug, Serialize)]
pub struct WalletPair {
    pub token: usize,
    pub reference: Option<Reference>,
    pub rows: Vec<WalletRow>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Measured {
    pub insiders: Vec<Insider>,
    pub pairs: Vec<WalletPair>,
}

/// A mint's mint authority, when it has one.
fn mint_authority(data: &[u8]) -> Option<Pubkey> {
    const SOME: [u8; 4] = [1, 0, 0, 0];
    (data.get(..4) == Some(&SOME[..]))
        .then(|| data.get(4..36))
        .flatten()
        .map(|b| Pubkey::new_from_array(b.try_into().expect("32 bytes")))
}

/// A program's upgrade authority, from its ProgramData, when it has one.
fn upgrade_authority(data: &[u8]) -> Option<Pubkey> {
    const HAS_AUTHORITY: usize = 12;
    (data.get(HAS_AUTHORITY) == Some(&1))
        .then(|| data.get(HAS_AUTHORITY + 1..HAS_AUTHORITY + 33))
        .flatten()
        .map(|b| Pubkey::new_from_array(b.try_into().expect("32 bytes")))
}

/// The market's insiders, each key once with all its roles, and whether each is a wallet:
/// a key off the Ed25519 curve, or whose account is a program or held by one, is a program's
/// address and cannot sign as a wallet does.
pub fn insiders(session: &mut Session) -> Vec<Insider> {
    let mut found: Vec<(String, Pubkey)> = vec![(
        "the market creator".to_string(),
        session.market.record.created_by,
    )];
    let base = session.base();
    let strategy = session.market.strategy();
    if let Some(authority) = base
        .get_account(&pda::program_data(&strategy))
        .and_then(|a| upgrade_authority(&a.data))
    {
        found.push(("the strategy's upgrade authority".to_string(), authority));
    }
    for i in 0..session.market.len() {
        if let Some(authority) = base
            .get_account(&session.market.mint(i))
            .and_then(|a| mint_authority(&a.data))
        {
            found.push((format!("the mint authority of mint {i}"), authority));
        }
    }
    let mut insiders: Vec<Insider> = vec![];
    for (role, key) in found {
        match insiders.iter_mut().find(|i| i.key == key) {
            Some(insider) => insider.roles.push(role),
            None => insiders.push(Insider {
                roles: vec![role],
                key,
                skipped: None,
            }),
        }
    }
    let keys: Vec<Pubkey> = insiders.iter().map(|i| i.key).collect();
    let mut probe = session.fresh();
    session.load(&mut probe, &keys);
    for insider in &mut insiders {
        let account = probe.get_account(&insider.key);
        insider.skipped = if !insider.key.is_on_curve() {
            Some("its address is off the Ed25519 curve, a program-derived address".to_string())
        } else if let Some(account) = account.filter(|a| a.executable) {
            Some(format!("it is a program, owned by {}", account.owner))
        } else if let Some(account) = probe
            .get_account(&insider.key)
            .filter(|a| a.owner != client::SYSTEM_PROGRAM_ID)
        {
            Some(format!(
                "it is an account held by the program {}",
                account.owner
            ))
        } else {
            None
        };
    }
    insiders
}

/// Round-trips the reference amount from every fresh wallet and every insider that is a
/// wallet, each from a fresh copy.
pub fn measure(
    session: &mut Session,
    path: &dyn SwapPath,
    sizes: &exit_sizes::Measured,
) -> Measured {
    let money = sizes.money;
    let insiders = insiders(session);
    let pairs = references(sizes)
        .into_iter()
        .map(|(token, reference)| {
            let Some(reference) = reference else {
                return WalletPair {
                    token,
                    reference: None,
                    rows: vec![],
                };
            };
            let mut rows = vec![];
            for i in 0..FRESH_WALLETS {
                let trader = session.seed.wallet(
                    &session.market.address,
                    &format!("exit_wallets {token} fresh {i}"),
                );
                let mut svm = session.fresh();
                rows.push(WalletRow {
                    who: "a fresh wallet".to_string(),
                    fresh: true,
                    row: session.round_trip_in(
                        &mut svm,
                        path,
                        &trader,
                        money,
                        token,
                        reference.amount,
                    ),
                });
            }
            for insider in insiders.iter().filter(|i| i.skipped.is_none()) {
                let mut svm = session.fresh();
                rows.push(WalletRow {
                    who: insider.who(),
                    fresh: false,
                    row: session.round_trip_in(
                        &mut svm,
                        path,
                        &insider.key,
                        money,
                        token,
                        reference.amount,
                    ),
                });
            }
            WalletPair {
                token,
                reference: Some(reference),
                rows,
            }
        })
        .collect();
    Measured { insiders, pairs }
}

impl Measured {
    /// Every swap committed: the fresh wallets' are the ordinary trade.
    pub fn committed(&self) -> Vec<Committed> {
        self.pairs
            .iter()
            .flat_map(|p| p.rows.iter())
            .flat_map(|w| {
                std::iter::once(Committed {
                    leg: w.row.buy.clone(),
                    ordinary: w.fresh,
                    context: format!("exit_wallets's buy by {}", w.who),
                })
                .chain(w.row.sell.as_ref().map(|leg| Committed {
                    leg: leg.clone(),
                    ordinary: w.fresh,
                    context: format!("exit_wallets's sale by {}", w.who),
                }))
            })
            .collect()
    }

    pub fn could_not_sell_back(&self) -> bool {
        self.pairs
            .iter()
            .flat_map(|p| p.rows.iter())
            .any(|w| could_not_sell_back(&w.row))
    }
}

/// What a wallet got: whether it sold, what it put in and what came back.
fn result(row: &RoundTrip) -> (bool, Option<u64>, Option<u64>) {
    (
        row.sold().is_some(),
        row.put_in(),
        row.sold().map(|r| r.trader_received),
    )
}

/// How `row` compares with `fresh` by what came back for what was put in.
fn compared(row: &RoundTrip, fresh: &RoundTrip) -> Ordering {
    match (row.sold(), fresh.sold()) {
        (None, None) => Ordering::Equal,
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (Some(a), Some(b)) => {
            let (put_a, put_b) = (row.put_in().unwrap_or(0), fresh.put_in().unwrap_or(0));
            (a.trader_received as u128 * put_b as u128)
                .cmp(&(b.trader_received as u128 * put_a as u128))
        }
    }
}

fn got(money: &Money, row: &RoundTrip) -> String {
    match row.sold() {
        Some(sale) => money.returned(row.put_in().unwrap_or(0), sale.trader_received),
        None => format!("nothing ({})", round_trip_failure(row).unwrap_or_default()),
    }
}

fn judge_pair(pair: &WalletPair, skipped: &str, money: &Money) -> PairVerdict {
    let verdict = |outcome, reason: String| PairVerdict {
        token: pair.token,
        outcome,
        reason: format!("{reason}{skipped}"),
    };
    let Some(reference) = &pair.reference else {
        return verdict(
            Outcome::NotRun,
            "Not run: no size could be bought and sold back.".to_string(),
        );
    };
    let stand_in = stand_in_note(reference, money);
    let fresh: Vec<&WalletRow> = pair.rows.iter().filter(|w| w.fresh).collect();
    let Some(first) = fresh.first() else {
        return verdict(
            Outcome::NotRun,
            "Not run: no fresh wallet traded.".to_string(),
        );
    };
    if let Err(failure) = &first.row.buy.swap {
        return verdict(
            Outcome::NotRun,
            format!(
                "Not run: a fresh wallet's buy of {} failed ({failure}).",
                money.amount(reference.amount)
            ),
        );
    }
    if let Some(other) = fresh.iter().find(|w| result(&w.row) != result(&first.row)) {
        return verdict(
            Outcome::Fail,
            format!(
                "Fresh wallets got different results from the same state: one got back {}, another {}.{stand_in}",
                got(money, &first.row),
                got(money, &other.row)
            ),
        );
    }
    let insiders: Vec<&WalletRow> = pair.rows.iter().filter(|w| !w.fresh).collect();
    if let Some(more) = insiders
        .iter()
        .find(|w| compared(&w.row, &first.row) == Ordering::Greater)
    {
        return verdict(
            Outcome::Fail,
            format!(
                "{} got back {} where a fresh wallet got back {}.{stand_in}",
                capitalised(&more.who),
                got(money, &more.row),
                got(money, &first.row)
            ),
        );
    }
    if let Some(less) = insiders
        .iter()
        .find(|w| compared(&w.row, &first.row) == Ordering::Less)
    {
        return verdict(
            Outcome::Warn,
            format!(
                "{} got back {} where a fresh wallet got back {}.{stand_in}",
                capitalised(&less.who),
                got(money, &less.row),
                got(money, &first.row)
            ),
        );
    }
    let mut who = vec![format!("{} fresh wallets", fresh.len())];
    who.extend(insiders.iter().map(|w| w.who.clone()));
    verdict(
        Outcome::Pass,
        format!(
            "{} all got back {} from the same state.{stand_in}",
            capitalised(&join_and(&who)),
            got(money, &first.row)
        ),
    )
}

fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |c| {
        c.to_uppercase().collect::<String>() + chars.as_str()
    })
}

fn numbers(m: &Measured, money: &Money) -> Value {
    json!({
        "could_not_sell_back": m.could_not_sell_back(),
        "insiders": m.insiders,
        "pairs": m.pairs.iter().map(|pair| json!({
            "token": pair.token,
            "amount": pair.reference.as_ref().map(|r| r.amount),
            "stand_in": pair.reference.as_ref().is_some_and(|r| r.stand_in),
            "wallets": pair.rows.iter().map(|w| {
                let mut row = money.row(&w.row);
                row["who"] = json!(w.who);
                row["fresh"] = json!(w.fresh);
                row
            }).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn inputs(m: &Measured) -> Value {
    json!({
        "fresh_wallets": FRESH_WALLETS,
        "insiders": m.insiders,
        "amounts": m.pairs.iter().map(|p| p.reference.as_ref().map(|r| r.amount)).collect::<Vec<_>>(),
        "starting_state": "the copy's own, for every wallet",
    })
}

pub fn judge(m: &Measured, sizes: &exit_sizes::Measured, trading: &Trading) -> Verdict {
    if let Trading::NotRun(why) = trading {
        return Verdict::not_run(format!("Not run: {why}."));
    }
    let money = Money(sizes);
    let skipped: String = m
        .insiders
        .iter()
        .filter_map(|i| {
            i.skipped.as_ref().map(|why| {
                format!(
                    " {} ({}) is a program's address, not a wallet, and was skipped: {why}.",
                    capitalised(&i.role_words()),
                    i.key
                )
            })
        })
        .collect();
    let pairs: Vec<PairVerdict> = m
        .pairs
        .iter()
        .map(|pair| judge_pair(pair, &skipped, &money))
        .collect();
    let (outcome, reason) = across_pairs(&pairs);
    Verdict::new(outcome, reason, inputs(m), numbers(m, &money))
}
