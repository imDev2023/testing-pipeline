//! The money side and the sizes, including mints no well-behaved token would have.

use canary::config::{
    DUST_FLOOR_HUNDREDTHS, HUNDREDTHS, SMALL_VAULT_UNITS, SOL_REFERENCE_SIZE, SOL_SIZES,
};
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
    let share = ladder(false, 1_000_000_000_000, 6);
    assert_eq!(share.basis, Basis::ShareOfVault);
    assert_eq!(
        share.sizes,
        vec![
            1_000_000,
            100_000_000,
            1_000_000_000,
            10_000_000_000,
            50_000_000_000
        ]
    );
    assert_eq!(share.reference, 1_000_000_000);
    let small = ladder(false, SMALL_VAULT_UNITS - 1, 6);
    assert_eq!(small.basis, Basis::WholeTokens);
    assert_eq!(
        small.sizes,
        vec![10_000, 100_000, 1_000_000, 10_000_000, 100_000_000]
    );
    assert_eq!(small.reference, 1_000_000);
}

#[test]
fn a_share_of_the_vault_under_the_dust_floor_takes_the_whole_token_size_in_its_place() {
    // The goal demo token's market (`EjGJbL...`, 2026-11-27): its quote vault held just over
    // the small-vault threshold, so 1 part per million was 2 base units, whose sale back
    // rounded to nothing.
    let goal = ladder(false, 2_150_000, 6);
    assert_eq!(goal.basis, Basis::ShareOfVault);
    // 2, 215 and 2,150 units are under 0.01 token; 21,500 and 107,500 are not.
    assert_eq!(
        goal.sizes,
        vec![10_000, 21_500, 100_000, 107_500, 1_000_000]
    );
    assert_eq!(goal.reference, 1_000_000);
    // 1 part per million of a vault of 1,000 tokens is 0.001 token, under the floor.
    let mid = ladder(false, 1_000_000_000, 6);
    assert_eq!(
        mid.sizes,
        vec![10_000, 100_000, 1_000_000, 10_000_000, 50_000_000]
    );
    assert_eq!(mid.reference, 1_000_000);
    // A mint without decimals has a floor of 1 unit, which every share already meets.
    let whole = ladder(false, SMALL_VAULT_UNITS, 0);
    assert_eq!(whole.sizes, vec![2, 200, 2_000, 20_000, 100_000]);
    assert_eq!(whole.reference, 2_000);
}

#[test]
fn every_ladder_is_sorted_holds_its_reference_and_sits_on_or_over_the_floor() {
    let vaults = [
        SMALL_VAULT_UNITS - 1,
        SMALL_VAULT_UNITS,
        2_150_000,
        9_999_999,
        123_456_789,
        10_000_000_000,
        u64::MAX / 3,
        u64::MAX,
    ];
    for decimals in [0u8, 2, 6, 9, 12, 19, 20, 255] {
        let floor = 10u128
            .checked_pow(decimals as u32)
            .map_or(u128::MAX, |one| {
                one * DUST_FLOOR_HUNDREDTHS as u128 / HUNDREDTHS as u128
            })
            .clamp(1, u64::MAX as u128) as u64;
        for vault in vaults {
            let l = ladder(false, vault, decimals);
            let case = format!("{vault} units, {decimals} decimals: {l:?}");
            assert!(l.sizes.windows(2).all(|w| w[0] < w[1]), "{case}");
            assert!(l.sizes.contains(&l.reference), "{case}");
            assert!(l.sizes.iter().all(|s| *s >= floor), "{case}");
        }
    }
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
