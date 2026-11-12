//! The money side and the sizes Canary trades (`CANARY-05` to `CANARY-07`;
//! `docs/spec/pipescope-canary.md`, "The money side and sizes").

use serde::Serialize;

use crate::config::{
    HUNDREDTHS, PPM, SMALL_VAULT_REFERENCE_HUNDREDTHS, SMALL_VAULT_SIZES_HUNDREDTHS,
    SMALL_VAULT_UNITS, SOL_REFERENCE_SIZE, SOL_SIZES, VAULT_REFERENCE_PPM, VAULT_SIZES_PPM,
};

/// What the money side needs to know about one mint of a market.
#[derive(Clone, Copy, Debug)]
pub struct Side {
    pub is_wrapped_sol: bool,
    pub supply: u64,
    pub vault: u64,
}

/// The money side: the wrapped SOL mint when the market has one; otherwise the mint whose
/// vault holds the smallest share of that mint's supply (the first such mint on a tie).
pub fn money_side(sides: &[Side]) -> usize {
    if let Some(sol) = sides.iter().position(|s| s.is_wrapped_sol) {
        return sol;
    }
    // Compare vault / supply as cross products; a mint with no supply counts as wholly in
    // its vault, so it is never chosen over one with supply outside the market.
    let share = |s: &Side| match s.supply {
        0 => (1u128, 1u128),
        supply => (s.vault as u128, supply as u128),
    };
    (0..sides.len())
        .min_by(|a, b| {
            let (na, da) = share(&sides[*a]);
            let (nb, db) = share(&sides[*b]);
            (na * db).cmp(&(nb * da)).then(a.cmp(b))
        })
        .unwrap_or(0)
}

/// How a ladder's sizes were set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    /// Fixed amounts of SOL.
    Sol,
    /// Parts per million of the money vault.
    ShareOfVault,
    /// Whole tokens, because the money vault is nearly empty.
    WholeTokens,
}

/// The sizes to trade, smallest first, and the reference size among them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Ladder {
    pub basis: Basis,
    pub sizes: Vec<u64>,
    pub reference: u64,
}

/// The ladder for a money side holding `vault` units of a mint with `decimals`.
pub fn ladder(is_wrapped_sol: bool, vault: u64, decimals: u8) -> Ladder {
    if is_wrapped_sol {
        return Ladder {
            basis: Basis::Sol,
            sizes: SOL_SIZES.to_vec(),
            reference: SOL_REFERENCE_SIZE,
        };
    }
    let dedup = |mut sizes: Vec<u64>| {
        sizes.dedup();
        sizes
    };
    if vault < SMALL_VAULT_UNITS {
        let one = 10u128.pow(decimals as u32);
        let in_hundredths =
            |h: u64| ((one * h as u128) / HUNDREDTHS as u128).clamp(1, u64::MAX as u128) as u64;
        return Ladder {
            basis: Basis::WholeTokens,
            sizes: dedup(
                SMALL_VAULT_SIZES_HUNDREDTHS
                    .iter()
                    .map(|h| in_hundredths(*h))
                    .collect(),
            ),
            reference: in_hundredths(SMALL_VAULT_REFERENCE_HUNDREDTHS),
        };
    }
    let of_vault = |ppm: u64| ((vault as u128 * ppm as u128) / PPM as u128).max(1) as u64;
    Ladder {
        basis: Basis::ShareOfVault,
        sizes: dedup(VAULT_SIZES_PPM.iter().map(|p| of_vault(*p)).collect()),
        reference: of_vault(VAULT_REFERENCE_PPM),
    }
}

/// `amount` as parts per million of `vault`, rounded down; `None` for an empty vault.
pub fn share_of_vault_ppm(amount: u64, vault: u64) -> Option<u64> {
    (vault > 0)
        .then(|| ((amount as u128 * PPM as u128) / vault as u128).min(u64::MAX as u128) as u64)
}
