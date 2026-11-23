//! `a × b` exactly, for tests that compare products of effective reserves, which can pass
//! 2^128: the tax AMM's Proptest properties (`tests/maths.rs`) and its invariant fuzzer.
//! One copy, tested in `tests/maths.rs` (hardening finding T09, #67).

#![allow(dead_code)]

/// `a × b` exactly, as eight 32-bit digits, most significant first, so two products
/// compare correctly. Schoolbook multiplication on small digits: deliberately not the
/// program's own 256-bit product, so a mistake there can't hide behind the same mistake
/// here.
pub fn wide_mul(a: u128, b: u128) -> [u64; 8] {
    let digits = |x: u128| -> [u64; 4] { std::array::from_fn(|i| ((x >> (32 * i)) as u32) as u64) };
    let (a, b) = (digits(a), digits(b));
    let mut product = [0u64; 8];
    for i in 0..4 {
        let mut carry = 0u64;
        for j in 0..4 {
            let column = product[i + j] + a[i] * b[j] + carry;
            product[i + j] = column & 0xffff_ffff;
            carry = column >> 32;
        }
        product[i + 4] += carry;
    }
    product.reverse();
    product
}
