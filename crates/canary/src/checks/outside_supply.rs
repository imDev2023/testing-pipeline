//! `outside_supply`: whether supply held outside the market's pool could be sold into the
//! real quote buyers paid in (`CANARY-47`; `HOOK-50`).
//!
//! In a fresh copy a fresh wallet makes the ordinary buy (the reference size), so the market
//! holds real quote a buyer paid in. The supply outside the pool is then the token's supply
//! less the market's vault balance of it, the buyer's tokens included. The check quotes a
//! sale of all of it, with Canary's own quoting; the part the market cannot buy back is what
//! is left once the largest sale that quotes is taken out. A market whose quote side is all
//! real buys back every token that came out of it, and so does a market with a virtual
//! reserve seeded with the whole supply, since selling back every bought token returns its
//! pool to where it started; only supply that never came out of the pool, on a market that
//! never pays out more than its real quote, is left over. The check then quotes a sale of
//! that part first, or of the largest part of it that quotes, and compares what the sale
//! takes out of the pool with the market's quote vault.
//! A quote that pays out more than the quote vault really holds counts as refused (R2T-12):
//! its swap could not pay it, so the search finds the largest sale the real quote can pay,
//! and a strategy that quotes on a virtual reserve without capping the payout is judged as
//! one that caps it.
//!
//! - Fail: never; the supply's holder has to sell.
//! - Warn: the market cannot buy back all the supply outside its pool, and the part it
//!   cannot, sold first, takes [`OUTSIDE_SUPPLY_WARN_PPM`] or more of the quote vault.
//! - Pass: no supply is outside the pool, the market can buy all of it back, or the part it
//!   cannot takes less than that.
//! - "Not run" when the market refuses every trade, the ordinary buy fails, or no sale of
//!   the token quotes.
//!
//! Every market is checked by the same rule, ours or anyone's.

use litesvm::LiteSVM;
use pipeline_client::Pubkey;
use serde::Serialize;
use serde_json::json;

use crate::checks::readable::Trading;
use crate::config::{OUTSIDE_SUPPLY_SEARCH_STEPS, OUTSIDE_SUPPLY_WARN_PPM};
use crate::failure::{Failure, FailureClass, Stage};
use crate::market::{token_amount, Session};
use crate::record::{Outcome, Verdict};
use crate::sizes::share_of_vault_ppm;
use crate::swap::SwapPath;
use crate::words;

/// A sale of the token into the market, as quoted.
#[derive(Clone, Debug, Serialize)]
pub struct Sale {
    /// What the sale was asked to sell.
    pub asked: u64,
    /// The largest part of it that quotes: all of it, or what the search found.
    pub sold: u64,
    /// What the strategy pays out of the pool for it.
    pub taken: u64,
    /// Why the market refused the whole of it, when it did.
    pub refused: Option<Failure>,
}

/// One token mint of the market.
#[derive(Clone, Debug, Serialize)]
pub struct OutsideMint {
    pub mint: usize,
    pub address: String,
    pub decimals: u8,
    /// The quote vault after the ordinary buy.
    pub money_vault: u64,
    pub supply: u64,
    pub vault: u64,
    /// Supply less the vault balance.
    pub outside: u64,
    /// The sale of all the outside supply.
    pub all: Option<Sale>,
    /// The part of the outside supply the market cannot buy back.
    pub unbacked: u64,
    /// The sale of the unbacked part first.
    pub first: Option<Sale>,
    /// Why no sale of the token quotes.
    pub failure: Option<Failure>,
}

/// What `outside_supply` measured.
#[derive(Clone, Debug, Serialize)]
pub struct Measured {
    pub money: usize,
    pub reference: u64,
    /// Why the ordinary buy failed.
    pub buy_failure: Option<Failure>,
    pub mints: Vec<OutsideMint>,
}

/// Makes the ordinary buy of each token mint in a fresh copy, then measures its outside
/// supply.
pub fn measure(
    session: &mut Session,
    path: &dyn SwapPath,
    money: usize,
    reference: u64,
) -> Measured {
    let mut measured = Measured {
        money,
        reference,
        buy_failure: None,
        mints: vec![],
    };
    for token in (0..session.market.len()).filter(|t| *t != money) {
        let mut svm = session.fresh();
        let buyer = session
            .seed
            .wallet(&session.market.address, "outside supply buyer");
        session.fund(&mut svm, &buyer, money, token, reference);
        let buy = session.leg(&mut svm, path, &buyer, money, token, reference);
        if let Err(failure) = buy.swap {
            measured.buy_failure = Some(failure);
            return measured;
        }
        let money_vault = token_amount(&svm, &session.market.vault(money)).unwrap_or(0);
        let mint = session.market.mints[token].clone();
        let supply = mint_supply(&svm, &mint.address).unwrap_or(mint.supply);
        let vault = token_amount(&svm, &session.market.vault(token)).unwrap_or(0);
        let outside = supply.saturating_sub(vault);
        let mut row = OutsideMint {
            mint: token,
            address: mint.address.to_string(),
            decimals: mint.decimals,
            money_vault,
            supply,
            vault,
            outside,
            all: None,
            unbacked: 0,
            first: None,
            failure: None,
        };
        if outside > 0 {
            match largest_sale(session, &mut svm, token, money, outside) {
                Ok(all) => {
                    row.unbacked = outside - all.sold;
                    row.all = Some(all);
                    if row.unbacked > 0 {
                        match largest_sale(session, &mut svm, token, money, row.unbacked) {
                            Ok(first) => row.first = Some(first),
                            Err(failure) => row.failure = Some(failure),
                        }
                    }
                }
                Err(failure) => row.failure = Some(failure),
            }
        }
        measured.mints.push(row);
    }
    measured
}

/// A mint's supply as it stands in `svm`.
fn mint_supply(svm: &LiteSVM, mint: &Pubkey) -> Option<u64> {
    svm.get_account(mint).and_then(|a| {
        a.data
            .get(36..44)
            .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
    })
}

/// What the strategy pays out of the pool for a sale of `amount` of `token` for `money`, as
/// quoted; a quote paying out more than the money vault really holds is refused, since its
/// swap could not pay it.
fn quoted_payout(
    session: &mut Session,
    svm: &mut LiteSVM,
    token: usize,
    money: usize,
    amount: u64,
) -> Result<u64, Failure> {
    let quote = session.probe(svm, token, money, amount)?;
    let real = token_amount(svm, &session.market.vault(money)).unwrap_or(0);
    if quote.strategy_amount_out > real {
        return Err(Failure::plain(
            Stage::Quote,
            FailureClass::StrategyRefused,
            &session.market.strategy(),
            format!(
                "the quote pays out {} of mint {money}, more than the {real} its vault really holds",
                quote.strategy_amount_out
            ),
        ));
    }
    Ok(quote.strategy_amount_out)
}

/// The sale of `amount` of `token` for `money`, or, when the market refuses it, of the
/// largest part of it that quotes, found by halving the range at most
/// [`OUTSIDE_SUPPLY_SEARCH_STEPS`] times; the error when no part of it quotes. A quote that
/// pays out more than the money vault really holds counts as refused ([`quoted_payout`]).
fn largest_sale(
    session: &mut Session,
    svm: &mut LiteSVM,
    token: usize,
    money: usize,
    amount: u64,
) -> Result<Sale, Failure> {
    let refused = match quoted_payout(session, svm, token, money, amount) {
        Ok(taken) => {
            return Ok(Sale {
                asked: amount,
                sold: amount,
                taken,
                refused: None,
            })
        }
        Err(failure) => failure,
    };
    // `low` quotes (or is nothing), `high` is refused.
    let (mut low, mut high) = (0u64, amount);
    let mut best = None;
    for _ in 0..OUTSIDE_SUPPLY_SEARCH_STEPS {
        if high - low <= 1 {
            break;
        }
        let middle = low + (high - low) / 2;
        match quoted_payout(session, svm, token, money, middle) {
            Ok(taken) => {
                low = middle;
                best = Some(taken);
            }
            Err(_) => high = middle,
        }
    }
    match best {
        Some(taken) => Ok(Sale {
            asked: amount,
            sold: low,
            taken,
            refused: Some(refused),
        }),
        None => Err(refused),
    }
}

/// Judges `outside_supply`; `m` is `None` when the market refuses every trade, and `money`
/// says an amount of the money side as the record's reader reads it.
pub fn judge(m: Option<&Measured>, trading: &Trading, money: &dyn Fn(u64) -> String) -> Verdict {
    let m = match (trading, m) {
        (Trading::NotRun(why), _) => return Verdict::not_run(format!("Not run: {why}.")),
        (Trading::Open, None) => {
            return Verdict::not_run("Not run: the market has no token to sell.")
        }
        (Trading::Open, Some(m)) => m,
    };
    if let Some(failure) = &m.buy_failure {
        return Verdict::not_run(format!(
            "Not run: the ordinary buy of {} failed ({failure}).",
            money(m.reference)
        ));
    }
    let inputs = json!({
        "money": m.money,
        "reference": m.reference,
        "reference_words": money(m.reference),
        "warn_ppm": OUTSIDE_SUPPLY_WARN_PPM,
        "search_steps": OUTSIDE_SUPPLY_SEARCH_STEPS,
    });
    let share = |row: &OutsideMint, taken: u64| {
        share_of_vault_ppm(taken, row.money_vault).unwrap_or(u64::MAX)
    };
    let numbers = |worst: Option<u64>| {
        json!({
            "mints": m.mints,
            "worst_share_ppm": worst,
        })
    };
    let tokens = |row: &OutsideMint, amount: u64| {
        format!(
            "{} of mint {}",
            words::decimal(amount, row.decimals),
            row.mint
        )
    };
    // The worst unbacked sale, by the share of the quote vault it takes.
    let worst = m
        .mints
        .iter()
        .filter_map(|row| {
            row.first
                .as_ref()
                .map(|first| (row, first, share(row, first.taken)))
        })
        .max_by_key(|(_, _, ppm)| *ppm);
    if let Some((row, first, ppm)) = worst.filter(|(_, _, ppm)| *ppm >= OUTSIDE_SUPPLY_WARN_PPM) {
        let sold_first = if first.sold < first.asked {
            format!(
                "the market refuses that part whole, and the largest part of it that it buys, {}, takes",
                tokens(row, first.sold)
            )
        } else {
            "that part would take".to_string()
        };
        return Verdict::new(
            Outcome::Warn,
            format!(
                "Supply held outside the pool could be sold into the real quote buyers paid in: of the {} outside the pool, the market cannot buy back {}; sold first, {sold_first} {} of the {} in its quote vault after an ordinary buy of {}.",
                tokens(row, row.outside),
                tokens(row, row.unbacked),
                money(first.taken),
                money(row.money_vault),
                money(m.reference),
            ),
            inputs,
            numbers(Some(ppm)),
        );
    }
    if let Some(row) = m.mints.iter().find(|row| row.failure.is_some()) {
        return Verdict::new(
            Outcome::NotRun,
            format!(
                "Not run: no sale of mint {} quotes ({}).",
                row.mint,
                row.failure
                    .as_ref()
                    .map_or_else(String::new, |f| f.to_string())
            ),
            inputs,
            numbers(None),
        );
    }
    let said: Vec<String> = m
        .mints
        .iter()
        .map(|row| match &row.first {
            _ if row.outside == 0 => format!("all of mint {} is in the pool", row.mint),
            None => format!(
                "the market can buy back all {} outside the pool",
                tokens(row, row.outside)
            ),
            Some(first) => format!(
                "the {} outside the pool that the market cannot buy back would take {} of the {} in its quote vault, {}",
                tokens(row, row.unbacked),
                money(first.taken),
                money(row.money_vault),
                words::percent(share(row, first.taken))
            ),
        })
        .collect();
    let worst_ppm = worst.map(|(_, _, ppm)| ppm);
    Verdict::new(
        Outcome::Pass,
        format!(
            "No supply outside the pool can take {} or more of the real quote: {}.",
            words::percent(OUTSIDE_SUPPLY_WARN_PPM),
            said.join("; ")
        ),
        inputs,
        numbers(worst_ppm),
    )
}
