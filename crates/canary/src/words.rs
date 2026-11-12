//! Numbers as the code-written reasons say them.

use crate::config::{LAMPORTS_PER_SOL, PPM, PPM_PER_POINT};
use crate::sizes::Basis;

/// `units` of a mint with `decimals`, as a decimal with trailing zeros cut.
pub fn decimal(units: u64, decimals: u8) -> String {
    let scale = 10u128.pow(decimals as u32);
    let whole = units as u128 / scale;
    let fraction = units as u128 % scale;
    if fraction == 0 {
        return whole.to_string();
    }
    let digits = format!("{fraction:0width$}", width = decimals as usize);
    format!("{whole}.{}", digits.trim_end_matches('0'))
}

/// An amount on the money side: SOL for wrapped SOL, otherwise whole tokens.
pub fn money(amount: u64, basis: Basis, decimals: u8) -> String {
    match basis {
        Basis::Sol => format!("{} SOL", decimal(amount, decimals_of_lamports())),
        Basis::ShareOfVault | Basis::WholeTokens => format!("{} tokens", decimal(amount, decimals)),
    }
}

fn decimals_of_lamports() -> u8 {
    LAMPORTS_PER_SOL.ilog10() as u8
}

/// Parts per million as a percentage with one decimal place, rounded down.
pub fn percent(ppm: u64) -> String {
    let tenths = ppm / (PPM_PER_POINT / 10);
    format!("{}.{}%", tenths / 10, tenths % 10)
}

/// Parts per million of a whole, as a percentage, for shares of a vault.
pub fn share(ppm: u64) -> String {
    if ppm >= PPM {
        return "all of it or more".to_string();
    }
    percent(ppm)
}
