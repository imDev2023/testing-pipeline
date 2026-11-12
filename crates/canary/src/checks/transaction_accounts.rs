//! `transaction_accounts`: lists the accounts the strategy asks for, in every account
//! resolution of the run, that describe the transaction rather than the market.
//!
//! - Fail: never.
//! - Warn: the strategy asks for one, so it could tell a simulated trade from a real one and
//!   Canary's results may not hold.
//! - Pass: it asks for none.
//! - "Not run" when no trade's accounts could be resolved.

use std::collections::BTreeSet;

use pipeline_client::{pubkey, Pubkey};
use serde_json::json;

use crate::record::{Outcome, Verdict};

/// The sysvars that describe the transaction or the chain's recent history, by name.
pub const TRANSACTION_SYSVARS: [(&str, Pubkey); 3] = [
    (
        "Instructions",
        pubkey!("Sysvar1nstructions1111111111111111111111111"),
    ),
    (
        "SlotHashes",
        pubkey!("SysvarS1otHashes111111111111111111111111111"),
    ),
    (
        "RecentBlockhashes",
        pubkey!("SysvarRecentB1ockHashes11111111111111111111"),
    ),
];

/// Every account the strategy listed in the run's account resolutions.
#[derive(Clone, Debug, Default)]
pub struct Resolutions {
    /// Resolutions that completed.
    pub count: usize,
    pub accounts: BTreeSet<Pubkey>,
}

pub fn judge(resolutions: &Resolutions) -> Verdict {
    if resolutions.count == 0 {
        return Verdict::not_run("Not run: no trade's accounts could be resolved.");
    }
    let asked: Vec<&str> = TRANSACTION_SYSVARS
        .iter()
        .filter(|(_, key)| resolutions.accounts.contains(key))
        .map(|(name, _)| *name)
        .collect();
    let inputs = json!({
        "looked_for": TRANSACTION_SYSVARS.iter().map(|(name, key)| json!({ "name": name, "address": key.to_string() })).collect::<Vec<_>>(),
    });
    let numbers = json!({
        "resolutions": resolutions.count,
        "accounts_listed": resolutions.accounts.len(),
        "transaction_accounts": asked,
    });
    if asked.is_empty() {
        return Verdict::new(
            Outcome::Pass,
            format!(
                "The strategy asked for no account that describes the transaction, in {} account resolutions.",
                resolutions.count
            ),
            inputs,
            numbers,
        );
    }
    Verdict::new(
        Outcome::Warn,
        format!(
            "The strategy asks for the {} sysvar{}, so it could tell a simulated trade from a real one and these results may not hold for real trades.",
            asked.join(" and "),
            if asked.len() == 1 { "" } else { "s" }
        ),
        inputs,
        numbers,
    )
}
