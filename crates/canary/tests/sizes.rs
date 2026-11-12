//! The money side and the sizes, including mints no well-behaved token would have.

use canary::config::{SMALL_VAULT_UNITS, SOL_REFERENCE_SIZE, SOL_SIZES};
use canary::sizes::{ladder, money_side, Basis, Side};
use canary::words;

#[test]
fn wrapped_sol_is_the_money_side_and_otherwise_the_mint_least_held_by_its_market() {
    let side = |is_wrapped_sol, supply, vault| Side {
        is_wrapped_sol,
        supply,
        vault,
    };
    assert_eq!(money_side(&[side(false, 100, 99), side(true, 100, 99)]), 1);
    // 1% of the first mint's supply sits in the vault, 90% of the second's.
    assert_eq!(money_side(&[side(false, 100, 1), side(false, 100, 90)]), 0);
    assert_eq!(money_side(&[side(false, 100, 90), side(false, 100, 1)]), 1);
    // A mint with no supply counts as wholly in its vault.
    assert_eq!(money_side(&[side(false, 0, 0), side(false, 100, 99)]), 1);
}

#[test]
fn the_ladders_follow_the_spec() {
    let sol = ladder(true, 0, 9);
    assert_eq!(
        (sol.basis, sol.sizes.as_slice(), sol.reference),
        (Basis::Sol, &SOL_SIZES[..], SOL_REFERENCE_SIZE)
    );
    let share = ladder(false, 1_000_000_000, 6);
    assert_eq!(share.basis, Basis::ShareOfVault);
    assert_eq!(
        share.sizes,
        vec![1_000, 100_000, 1_000_000, 10_000_000, 50_000_000]
    );
    assert_eq!(share.reference, 1_000_000);
    let small = ladder(false, SMALL_VAULT_UNITS - 1, 6);
    assert_eq!(small.basis, Basis::WholeTokens);
    assert_eq!(
        small.sizes,
        vec![10_000, 100_000, 1_000_000, 10_000_000, 100_000_000]
    );
    assert_eq!(small.reference, 1_000_000);
}

#[test]
fn a_mint_with_absurd_decimals_neither_panics_nor_trades_nothing() {
    for decimals in [0u8, 1, 19, 38, 39, 77, 128, 255] {
        let small = ladder(false, 0, decimals);
        assert!(small.sizes.iter().all(|s| *s >= 1), "{decimals}: {small:?}");
        assert!(small.reference >= 1);
        let text = words::decimal(123_456, decimals);
        assert!(!text.is_empty(), "{decimals}");
    }
    assert_eq!(words::decimal(123_456, 3), "123.456");
    assert_eq!(
        words::decimal(5, 200),
        "0.".to_string() + &"0".repeat(199) + "5"
    );
}
