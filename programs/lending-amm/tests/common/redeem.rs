//! The in-swap redeem in the tests (docs/spec/lending-pool.md, "Redeeming the shortfall"):
//! markets that have lent through klend's real deposit, and the sells that pay out more of the
//! lent side than their buffer holds.

use lending_amm::kamino::Reserve;

use super::rebalance::{lent_spec, units, OTHER};
use super::{Env, Market};

impl Env {
    /// A market lending `LENT_MINTS[lent]` at `lp_fee_bps`, opened with `[OTHER, 50 units]`
    /// and rebalanced, so four fifths of its lent side are real cTokens from klend's deposit and
    /// its buffer is at its target.
    pub fn lending_market(&mut self, lent: usize, lp_fee_bps: u16) -> Market {
        self.load_klend();
        let spec = lent_spec(self, lent, lp_fee_bps);
        let (market, _) = self
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        self.rebalance(&market, None).unwrap();
        market
    }

    /// The input of the other mint whose sell pays out at least `out` of the lent side, by the
    /// spec's formula `out = L x a_net / (R + a_net)` on the market as it is.
    pub fn sell_paying(&self, market: &Market, out: u64) -> u64 {
        let state = self.market_state(&market.market_state);
        let reserve = state.reserves[market.other_index()] as u128;
        let total = self.lent_total(market) as u128;
        let out = out as u128;
        let net = (out * reserve).div_ceil(total - out);
        let fee = state.lp_fee_bps as u128;
        // One more unit of net input than the formula needs, so the floor never falls short.
        ((net + 1) * 10_000).div_ceil(10_000 - fee) as u64
    }

    /// The largest sell of the other mint whose quote pays out at most `out` of the lent side,
    /// found by quoting.
    pub fn largest_sell_within(&self, market: &Market, out: u64) -> u64 {
        let (other, lent) = (market.other_index(), market.lent_index);
        let pays = |amount: u64| {
            match self.quote(market, &super::exact_in(other, lent, amount)) {
                Ok(quote) => quote.amount_out,
                // Dust pays out nothing; anything else refused pays out too much.
                Err(refusal) if refusal.contains("ZeroOutput") => 0,
                Err(_) => u64::MAX,
            }
        };
        // `high` pays out more than `out`, `low` at most `out`.
        let (mut low, mut high) = (0u64, self.sell_paying(market, out + 1));
        while high - low > 1 {
            let middle = low + (high - low) / 2;
            if pays(middle) <= out {
                low = middle;
            } else {
                high = middle;
            }
        }
        low
    }

    /// The market's recorded buffer `B`.
    pub fn buffer(&self, market: &Market) -> u64 {
        self.market_state(&market.market_state).reserves[market.lent_index]
    }
}

/// The cTokens a swap burns for a shortfall `s`, by the spec's formula
/// `ceil(s x S_ctoken / S_total)`, at the reserve's stored rate, computed with plain 256-bit
/// arithmetic independent of the program's.
pub fn ctokens_for_shortfall(reserve: &Reserve, shortfall: u64) -> u64 {
    let supply = reserve.total_supply_sf().unwrap();
    // s x S_ctoken x 2^60 / S_total_sf, rounded up; s x S_ctoken < 2^128, times 2^60 needs
    // wider arithmetic, so divide in two steps of exact long division.
    let numerator = U256::from(shortfall as u128 * reserve.mint_total_supply as u128).shl(60);
    numerator.div_ceil(supply)
}

/// The smallest 256-bit unsigned integer the formula above needs.
#[derive(Clone, Copy)]
struct U256 {
    high: u128,
    low: u128,
}

impl U256 {
    fn from(value: u128) -> Self {
        U256 {
            high: 0,
            low: value,
        }
    }

    fn shl(self, bits: u32) -> Self {
        U256 {
            high: (self.high << bits) | (self.low >> (128 - bits)),
            low: self.low << bits,
        }
    }

    /// `self / divisor` rounded up, which must fit in a u64.
    fn div_ceil(self, divisor: u128) -> u64 {
        let mut remainder: u128 = 0;
        let mut quotient: u128 = 0;
        for bit in (0..256).rev() {
            let next = if bit >= 128 {
                (self.high >> (bit - 128)) & 1
            } else {
                (self.low >> bit) & 1
            };
            let carry = remainder >> 127;
            remainder = (remainder << 1) | next;
            quotient <<= 1;
            if carry == 1 || remainder >= divisor {
                remainder = remainder.wrapping_sub(divisor);
                quotient |= 1;
            }
        }
        let rounded = quotient + (remainder != 0) as u128;
        u64::try_from(rounded).expect("fits a u64")
    }
}
