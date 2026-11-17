//! The quotes the gate compares: on every market, exact-in quotes both ways at a tenth, a
//! hundredth and a thousandth of the input vault, as the deployed build gives them when a
//! snapshot is taken and as the candidate gives them on the same state (`POOL4-41`); both
//! are taken by the same replay (`check.rs`).

use crate::session::{first_line, MarketView, Session};
use crate::snapshot::QuoteOutcome;

/// The gate's quotes are of what the input vault holds divided by each of these.
pub const QUOTE_DIVISORS: [u64; 3] = [10, 100, 1_000];
/// The gate's buy is of what the SOL vault holds divided by this; its sell is of what the buy
/// bought, less Pipeline's fee.
pub const BUY_DIVISOR: u64 = 100;

/// The amounts quoted from mint `input`: shares of what its vault holds, or 1 when it holds
/// nothing.
pub fn amounts(session: &Session, view: &MarketView, input: usize) -> Vec<u64> {
    let held = session.balance(&view.vaults[input]).unwrap_or_default();
    let mut amounts: Vec<u64> = QUOTE_DIVISORS
        .iter()
        .map(|divisor| held / divisor)
        .filter(|a| *a > 0)
        .collect();
    amounts.dedup();
    if amounts.is_empty() {
        amounts.push(1);
    }
    amounts
}

/// What the program in `session` quotes for `amount` from mint `input` to mint `output`,
/// resolving the accounts first, as a terminal does.
pub fn quote(
    session: &Session,
    view: &MarketView,
    input: usize,
    output: usize,
    amount: u64,
) -> QuoteOutcome {
    match session.resolve(view, input, output, amount) {
        Ok(resolved) => session.quote(view, input, output, amount, &resolved),
        Err(error) => QuoteOutcome::Refused(format!("resolve: {}", first_line(&error))),
    }
}
