//! A small unsigned 256-bit integer with only the operations the program's maths needs, every
//! one checked: an overflow or a division by zero returns `None` (which the program turns
//! into an error), never a panic or a wrapped value.
//!
//! The seed's maths (`opening.rs`) needs `y × 2^128`, and the pricing (`pricing.rs`) needs
//! products of a liquidity, `Q = 2^64` and a square-root price, which can pass 192 bits.

const LOW_64: u128 = u64::MAX as u128;

/// Q64.64's one, `2^64`.
pub const Q: u128 = 1 << 64;

/// An unsigned 256-bit integer, `hi × 2^128 + lo`. Field order makes the derived ordering
/// numeric.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct U256 {
    pub hi: u128,
    pub lo: u128,
}

impl From<u128> for U256 {
    fn from(lo: u128) -> Self {
        U256 { hi: 0, lo }
    }
}

impl From<u64> for U256 {
    fn from(lo: u64) -> Self {
        U256 {
            hi: 0,
            lo: lo as u128,
        }
    }
}

impl U256 {
    pub const ZERO: U256 = U256 { hi: 0, lo: 0 };
    pub const ONE: U256 = U256 { hi: 0, lo: 1 };

    /// `a × b`, which always fits in 256 bits.
    pub fn mul(a: u128, b: u128) -> Option<U256> {
        let (a1, a0) = (a >> 64, a & LOW_64);
        let (b1, b0) = (b >> 64, b & LOW_64);
        let p00 = a0.checked_mul(b0)?;
        let p01 = a0.checked_mul(b1)?;
        let p10 = a1.checked_mul(b0)?;
        let p11 = a1.checked_mul(b1)?;
        let mid = (p00 >> 64)
            .checked_add(p01 & LOW_64)?
            .checked_add(p10 & LOW_64)?;
        let lo = ((mid & LOW_64) << 64) | (p00 & LOW_64);
        let hi = p11
            .checked_add(p01 >> 64)?
            .checked_add(p10 >> 64)?
            .checked_add(mid >> 64)?;
        Some(U256 { hi, lo })
    }

    /// `s²`.
    pub fn square(s: u128) -> U256 {
        // A product of two u128s always fits in 256 bits.
        U256::mul(s, s).unwrap_or(U256 {
            hi: u128::MAX,
            lo: u128::MAX,
        })
    }

    /// `x × Q`, `x × 2^64`, which always fits in 256 bits.
    pub fn times_q(x: u128) -> U256 {
        U256 {
            hi: x >> 64,
            lo: x << 64,
        }
    }

    /// `self × x`, or `None` past 256 bits.
    pub fn mul_u64(self, x: u64) -> Option<U256> {
        let x = x as u128;
        let r0 = (self.lo & LOW_64).checked_mul(x)?;
        let r1 = (self.lo >> 64).checked_mul(x)?.checked_add(r0 >> 64)?;
        let lo = ((r1 & LOW_64) << 64) | (r0 & LOW_64);
        let hi = self.hi.checked_mul(x)?.checked_add(r1 >> 64)?;
        Some(U256 { hi, lo })
    }

    /// `self × x`, or `None` past 256 bits.
    pub fn mul_u128(self, x: u128) -> Option<U256> {
        let low = U256::mul(self.lo, x)?;
        let hi = self.hi.checked_mul(x)?.checked_add(low.hi)?;
        Some(U256 { hi, lo: low.lo })
    }

    pub fn checked_add(self, other: U256) -> Option<U256> {
        let (lo, carry) = self.lo.overflowing_add(other.lo);
        let hi = self.hi.checked_add(other.hi)?.checked_add(carry as u128)?;
        Some(U256 { hi, lo })
    }

    pub fn checked_sub(self, other: U256) -> Option<U256> {
        let (lo, borrow) = self.lo.overflowing_sub(other.lo);
        let hi = self.hi.checked_sub(other.hi)?.checked_sub(borrow as u128)?;
        Some(U256 { hi, lo })
    }

    /// `self >> n` for `n` from 1 to 127; `None` otherwise.
    pub fn checked_shr(self, n: u32) -> Option<U256> {
        let back = 128u32.checked_sub(n).filter(|back| *back < 128)?;
        Some(U256 {
            hi: self.hi.checked_shr(n)?,
            lo: self.lo.checked_shr(n)? | self.hi.checked_shl(back)?,
        })
    }

    /// `self << n` for `n` from 0 to 255, or `None` if a set bit would be shifted out.
    pub fn checked_shl(self, n: u32) -> Option<U256> {
        if n == 0 {
            return Some(self);
        }
        if n > self.leading_zeros() {
            return None;
        }
        Some(if n >= 128 {
            U256 {
                hi: self.lo.checked_shl(n.checked_sub(128)?)?,
                lo: 0,
            }
        } else {
            U256 {
                hi: self.hi.checked_shl(n)? | self.lo.checked_shr(128u32.checked_sub(n)?)?,
                lo: self.lo.checked_shl(n)?,
            }
        })
    }

    /// `floor(self / 2^64)`, or `None` if it does not fit in 128 bits.
    pub fn checked_shr64(self) -> Option<u128> {
        if self.hi >> 64 != 0 {
            return None;
        }
        Some((self.hi << 64) | (self.lo >> 64))
    }

    /// `ceil(self / 2^64)`, or `None` if it does not fit in 128 bits.
    pub fn checked_ceil_shr64(self) -> Option<u128> {
        let floor = self.checked_shr64()?;
        if self.lo & LOW_64 == 0 {
            Some(floor)
        } else {
            floor.checked_add(1)
        }
    }

    pub fn is_zero(self) -> bool {
        self == U256::ZERO
    }

    /// The number of leading zero bits, 256 for 0.
    pub fn leading_zeros(self) -> u32 {
        if self.hi != 0 {
            self.hi.leading_zeros()
        } else {
            128 + self.lo.leading_zeros()
        }
    }

    /// The value, if it fits in 128 bits.
    pub fn to_u128(self) -> Option<u128> {
        (self.hi == 0).then_some(self.lo)
    }

    /// The value, if it fits in 64 bits.
    pub fn to_u64(self) -> Option<u64> {
        u64::try_from(self.to_u128()?).ok()
    }

    /// `(floor(self / d), self mod d)`, by binary long division over only the bits the
    /// quotient can have; `None` when `d` is 0.
    pub fn div_rem(self, d: U256) -> Option<(U256, U256)> {
        if d.is_zero() {
            return None;
        }
        if self < d {
            return Some((U256::ZERO, self));
        }
        // `self >= d > 0`, so the shift is between 0 and 255 and loses no bit of `d`.
        let shift = d.leading_zeros().checked_sub(self.leading_zeros())?;
        let mut divisor = d.checked_shl(shift)?;
        let mut rem = self;
        let mut quotient = U256::ZERO;
        let mut bit = shift;
        loop {
            if rem >= divisor {
                rem = rem.checked_sub(divisor)?;
                quotient = quotient.with_bit(bit)?;
            }
            if bit == 0 {
                break;
            }
            bit = bit.checked_sub(1)?;
            divisor = divisor.checked_shr(1)?;
        }
        Some((quotient, rem))
    }

    /// `floor(self / d)`; `None` when `d` is 0.
    pub fn div_floor(self, d: U256) -> Option<U256> {
        Some(self.div_rem(d)?.0)
    }

    /// `ceil(self / d)`; `None` when `d` is 0.
    pub fn div_ceil(self, d: U256) -> Option<U256> {
        let (quotient, rem) = self.div_rem(d)?;
        if rem.is_zero() {
            Some(quotient)
        } else {
            quotient.checked_add(U256::ONE)
        }
    }

    /// The highest power of four at or below `self` (0 for 0).
    pub fn highest_power_of_four(self) -> Option<U256> {
        let bits = 256u32.checked_sub(self.leading_zeros())?;
        if bits == 0 {
            return Some(U256::ZERO);
        }
        let exponent = bits.checked_sub(1)? & !1;
        U256::ONE.checked_shl(exponent)
    }

    /// `self` with bit `n` (0 to 255) set.
    fn with_bit(self, n: u32) -> Option<U256> {
        Some(if n >= 128 {
            U256 {
                hi: self.hi | 1u128.checked_shl(n.checked_sub(128)?)?,
                lo: self.lo,
            }
        } else {
            U256 {
                hi: self.hi,
                lo: self.lo | 1u128.checked_shl(n)?,
            }
        })
    }
}

// Kani proofs of the 256-bit operations, in the tiers Pipeline uses (see `opening.rs`):
// bounded by default, every input behind `--cfg kani_full`. Z3 proves `mul` and `mul_u64`
// for every input (`proofs/opening_z3.py`), and Proptest checks every operation on 10,000
// random inputs below.
#[cfg(kani)]
mod proofs {
    use super::*;

    /// 256-bit multiplication is exact: it agrees with u128 multiplication wherever that
    /// does not overflow, for operands below 2^10 in each 64-bit half (so every partial
    /// product and carry path runs). Proving a 128-bit multiplier equivalent for every pair
    /// takes SAT solvers hours, so Z3 proves `mul` and `mul_u64` for every input
    /// (`proofs/opening_z3.py`), and the full domain runs here only in the full tier.
    #[kani::proof]
    fn mul_agrees_with_u128_bounded() {
        let (a, b): (u128, u128) = (kani::any(), kani::any());
        let half = |v: u128| (v >> 64) < 1 << 10 && (v & LOW_64) < 1 << 10;
        kani::assume(half(a) && half(b));
        let product = U256::mul(a, b).unwrap();
        if let Some(expected) = a.checked_mul(b) {
            assert_eq!(product, U256::from(expected));
        } else {
            assert!(product.hi > 0);
        }
    }

    /// The same for every pair.
    #[cfg(kani_full)]
    #[kani::proof]
    fn mul_agrees_with_u128() {
        let (a, b): (u128, u128) = (kani::any(), kani::any());
        let product = U256::mul(a, b).unwrap();
        if let Some(expected) = a.checked_mul(b) {
            assert_eq!(product, U256::from(expected));
        } else {
            assert!(product.hi > 0);
        }
    }

    /// Division is exact: `q × d + r == n` and `r < d`, for `n` below 2^12 (so the loop
    /// runs at most 12 times; Kani checks the unwinding bound) and any non-zero `d`.
    #[kani::proof]
    #[kani::unwind(14)]
    fn div_rem_is_exact_bounded() {
        let n: u128 = kani::any();
        let d: u128 = kani::any();
        kani::assume(n < 1 << 12 && d > 0);
        let (q, r) = U256::from(n).div_rem(U256::from(d)).unwrap();
        assert_eq!(q, U256::from(n / d));
        assert_eq!(r, U256::from(n % d));
    }

    /// Division by zero is `None`, never a panic, for any dividend.
    #[kani::proof]
    fn div_by_zero_is_none() {
        let n = U256 {
            hi: kani::any(),
            lo: kani::any(),
        };
        assert!(n.div_rem(U256::ZERO).is_none());
    }

    /// Division is exact for every pair of 256-bit numbers.
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(258)]
    fn div_rem_is_exact() {
        let n = U256 {
            hi: kani::any(),
            lo: kani::any(),
        };
        let d = U256 {
            hi: kani::any(),
            lo: kani::any(),
        };
        kani::assume(!d.is_zero());
        let (q, r) = n.div_rem(d).unwrap();
        assert!(r < d);
        // q × d <= n, and q >= 2^128 needs d < 2^128, so one factor always fits in 128 bits.
        let product = if q.hi == 0 {
            d.mul_u128(q.lo)
        } else {
            q.mul_u128(d.lo)
        };
        assert_eq!(product.and_then(|p| p.checked_add(r)), Some(n));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn u256() -> impl Strategy<Value = U256> {
        // Every width from a few bits to the full 256, so every shift distance runs.
        (0u32..=256, any::<u128>(), any::<u128>()).prop_map(|(bits, hi, lo)| {
            let value = U256 { hi, lo };
            match 256u32.checked_sub(bits) {
                Some(0) => value,
                Some(drop) if drop < 128 => value.checked_shr(drop).unwrap(),
                Some(drop) if drop < 256 => U256 {
                    hi: 0,
                    lo: hi >> (drop - 128),
                },
                _ => U256::ZERO,
            }
        })
    }

    /// `a × b + c` for a 256-bit `a`, a u128 `b` and a 256-bit `c`, if it fits.
    fn mul_add(a: U256, b: U256, c: U256) -> Option<U256> {
        if b.hi == 0 {
            a.mul_u128(b.lo)?.checked_add(c)
        } else if a.hi == 0 {
            b.mul_u128(a.lo)?.checked_add(c)
        } else {
            None
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// `div_rem` is exact: `q × d + r == n` and `r < d`.
        #[test]
        fn div_rem_is_exact(n in u256(), d in u256()) {
            prop_assume!(!d.is_zero());
            let (q, r) = n.div_rem(d).unwrap();
            prop_assert!(r < d);
            // q × d never exceeds n, so it fits whenever one factor fits in 128 bits,
            // which is always so: q >= 2^128 needs d < 2^128.
            prop_assert_eq!(mul_add(q, d, r), Some(n));
        }

        /// `div_ceil` is the least `c` with `c × d >= n`.
        #[test]
        fn div_ceil_is_the_ceiling(n in u256(), d in u256()) {
            prop_assume!(!d.is_zero());
            let c = n.div_ceil(d).unwrap();
            let f = n.div_floor(d).unwrap();
            let exact = n.div_rem(d).unwrap().1.is_zero();
            prop_assert_eq!(c, if exact { f } else { f.checked_add(U256::ONE).unwrap() });
        }

        /// `mul_u128` agrees with `mul` where both apply, and is `None` exactly past 256 bits.
        #[test]
        fn mul_u128_is_exact(a in any::<u128>(), b in any::<u128>(), hi in any::<u128>()) {
            prop_assert_eq!(U256::from(a).mul_u128(b), U256::mul(a, b));
            let wide = U256 { hi, lo: a };
            // (hi × 2^128 + a) × b fits exactly when hi × b + carry < 2^128.
            let low = U256::mul(a, b).unwrap();
            let fits = hi.checked_mul(b).and_then(|h| h.checked_add(low.hi)).is_some();
            prop_assert_eq!(wide.mul_u128(b).is_some(), fits);
        }

        /// `shl` is multiplication by a power of two, refusing to lose a bit.
        #[test]
        fn shl_is_exact(n in u256(), shift in 0u32..256) {
            match n.checked_shl(shift) {
                Some(shifted) => {
                    let back = (0..shift).try_fold(shifted, |v, _| v.checked_shr(1));
                    prop_assert_eq!(back, Some(n));
                }
                None => prop_assert!(shift > n.leading_zeros()),
            }
        }

        /// `times_q` and the shifts by 64 undo each other.
        #[test]
        fn times_q_round_trips(x in any::<u128>()) {
            prop_assert_eq!(U256::times_q(x).checked_shr64(), Some(x));
            prop_assert_eq!(U256::times_q(x).checked_ceil_shr64(), Some(x));
            prop_assert_eq!(U256::times_q(x), U256::mul(x, Q).unwrap());
        }
    }

    #[test]
    fn division_at_the_edges() {
        let max = U256 {
            hi: u128::MAX,
            lo: u128::MAX,
        };
        assert_eq!(max.div_rem(U256::ONE), Some((max, U256::ZERO)));
        assert_eq!(max.div_rem(max), Some((U256::ONE, U256::ZERO)));
        assert_eq!(U256::ONE.div_rem(max), Some((U256::ZERO, U256::ONE)));
        assert_eq!(
            U256::ZERO.div_rem(U256::ONE),
            Some((U256::ZERO, U256::ZERO))
        );
        assert_eq!(max.div_rem(U256::ZERO), None);
        assert_eq!(
            U256::from(7u128).div_ceil(U256::from(2u128)),
            Some(U256::from(4u128))
        );
        assert_eq!(
            max.div_ceil(U256::from(2u128)),
            Some(U256 {
                hi: 1 << 127,
                lo: 0
            })
        );
        assert_eq!(
            U256::ONE.checked_shl(255),
            Some(U256 {
                hi: 1 << 127,
                lo: 0
            })
        );
        assert_eq!(U256::from(2u128).checked_shl(255), None);
    }
}
