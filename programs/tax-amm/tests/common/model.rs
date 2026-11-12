//! The spec's formulas, written out again here independently of the program, so tests
//! check the market against docs/spec/tax-amm.md and not against the program's own code:
//! "Pricing and the tax", "Credited input", "Where the tax goes" and "Counters for the
//! containment hook".

#![allow(dead_code)]

use tax_amm::TaxMarket;

/// Basis points in a whole.
const BPS: u128 = 10_000;
/// The suite share is a policy value, so it is read from its one place, the program's
/// config module, and not repeated here.
const SUITE_SHARE: u128 = tax_amm::config::SUITE_SHARE_BPS as u128;

/// What the spec says a market holds, as plain numbers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Model {
    pub tax_side: usize,
    pub buy_tax_bps: u16,
    pub sell_tax_bps: u16,
    pub shares: [u16; 4],
    pub burn_share_bps: u16,
    pub virtual_side: usize,
    pub virtual_reserve: u64,
    pub reserves: [u64; 2],
    /// Recipients 0 to 3, the burn, the suite share.
    pub owed: [u64; 6],
    pub tax_collected: u128,
    pub volume: [u128; 2],
    pub swap_count: u64,
}

/// What a trade does, by the spec.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Trade {
    pub out: u64,
    pub tax: u64,
}

/// Why the spec refuses a trade.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `out` would be 0.
    ZeroOutput,
    /// The curve would pay out more of `o` than its real reserve.
    BeyondRealReserve,
}

fn ceil_div(n: u128, d: u128) -> u128 {
    n.div_ceil(d)
}

impl Model {
    /// The model of a market state as it stands.
    pub fn of(state: &TaxMarket) -> Model {
        Model {
            tax_side: state.tax_side as usize,
            buy_tax_bps: state.buy_tax_bps,
            sell_tax_bps: state.sell_tax_bps,
            shares: state.shares,
            burn_share_bps: state.burn_share_bps,
            virtual_side: state.virtual_side as usize,
            virtual_reserve: state.virtual_reserve,
            reserves: state.reserves,
            owed: state.owed,
            tax_collected: state.tax_collected,
            volume: state.volume,
            swap_count: state.swap_count,
        }
    }

    /// Checks the market state holds exactly what the model does, to the unit.
    pub fn assert_matches(&self, state: &TaxMarket) {
        assert_eq!(
            &Model::of(state),
            self,
            "market state against the spec's formulas"
        );
    }

    /// The effective reserve `E` of side `i`.
    fn effective(&self, i: usize) -> u128 {
        let virtual_part = if i == self.virtual_side {
            self.virtual_reserve
        } else {
            0
        };
        self.reserves[i] as u128 + virtual_part as u128
    }

    /// What the market has recorded in vault `i`: its real reserve, plus all tax owed if
    /// it is the tax-side vault.
    pub fn recorded(&self, i: usize) -> u128 {
        let owed = if i == self.tax_side {
            self.owed.iter().map(|&o| o as u128).sum()
        } else {
            0
        };
        self.reserves[i] as u128 + owed
    }

    /// A trade of credited input `a` from side `i` to `o`, priced but not applied.
    pub fn price(&self, i: usize, o: usize, a: u64) -> Result<Trade, Refusal> {
        let a = a as u128;
        let (e_i, e_o) = (self.effective(i), self.effective(o));
        let curve = |input: u128| -> u128 {
            e_o.checked_mul(input)
                .expect("model amounts fit u128")
                .checked_div(e_i + input)
                .unwrap_or(0)
        };
        let (paid_from_reserve, out, tax) = if self.tax_side == i {
            // Buy tax: taken from the input, before the curve.
            let tax = ceil_div(a * self.buy_tax_bps as u128, BPS);
            let out = curve(a - tax);
            (out, out, tax)
        } else {
            // Sell tax: taken from the curve's output, which stays in the tax-side vault.
            let g = curve(a);
            let tax = ceil_div(g * self.sell_tax_bps as u128, BPS);
            (g, g - tax, tax)
        };
        if paid_from_reserve > self.reserves[o] as u128 {
            return Err(Refusal::BeyondRealReserve);
        }
        if out == 0 {
            return Err(Refusal::ZeroOutput);
        }
        Ok(Trade {
            out: out as u64,
            tax: tax as u64,
        })
    }

    /// The tax split by "Where the tax goes", by slot: recipients 0 to 3, the burn, the
    /// suite share.
    pub fn split(&self, tax: u64) -> [u64; 6] {
        let tax = tax as u128;
        let suite = tax * SUITE_SHARE / BPS;
        let rest = tax - suite;
        let mut slots = [0u128; 6];
        for (slot, &share) in slots.iter_mut().zip(&self.shares) {
            *slot = rest * share as u128 / BPS;
        }
        slots[4] = rest * self.burn_share_bps as u128 / BPS;
        slots[5] = suite;
        let paid: u128 = slots[..5].iter().sum();
        slots[0] += rest - paid;
        slots.map(|s| s as u64)
    }

    /// Applies a swap of credited input `a` from `i` to `o`, as a router swap does.
    pub fn swap(&mut self, i: usize, o: usize, a: u64) -> Result<Trade, Refusal> {
        let trade = self.price(i, o, a)?;
        if self.tax_side == i {
            self.reserves[i] += a - trade.tax;
            self.reserves[o] -= trade.out;
        } else {
            self.reserves[i] += a;
            self.reserves[o] -= trade.out + trade.tax;
        }
        let parts = self.split(trade.tax);
        for (owed, part) in self.owed.iter_mut().zip(parts) {
            *owed += part;
        }
        self.tax_collected += trade.tax as u128;
        self.volume[i] += a as u128;
        self.volume[o] += trade.out as u128;
        self.swap_count += 1;
        Ok(trade)
    }
}
