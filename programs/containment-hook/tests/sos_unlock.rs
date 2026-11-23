//! `unlock`'s behaviour added by the hook's internal adversarial review (#74), each pinned by a
//! test named after the finding (docs/security/containment-hook/round-1.md).

mod support;

use containment_hook::HookError;
use support::*;

/// H009, H015, H057: a home market state of a version newer than the one the hook knows reads
/// as unreadable, even with a counter past the goal: before the deadline `unlock` is refused,
/// and from the deadline it unlocks by the deadline, as for any market state that can no
/// longer be read as the tax AMM's.
#[test]
fn sos_h009_a_market_state_of_a_newer_version_leaves_only_the_deadline() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let state = launched.market.market_state;
    let goal = config(&env, &launched.mint).unlock_goal;
    let at = tax_amm::state::layout::TAX_COLLECTED;
    edit_account(&mut env, &state, |account| {
        account.data[8] = tax_amm::state::STATE_VERSION + 1;
        account.data[at..at + 16].copy_from_slice(&u128::from(goal).to_le_bytes());
    });
    assert_hook_refused(unlock(&mut env, &launched), HookError::NotATaxMarketState);

    let deadline = config(&env, &launched.mint).unlock_deadline;
    warp_to(&mut env, deadline);
    let unlocked = unlock(&mut env, &launched).unwrap();
    assert!(
        unlocked
            .logs
            .iter()
            .any(|line| line.contains("Unlocked by the deadline")),
        "{:#?}",
        unlocked.logs
    );
    assert_eq!(config(&env, &launched.mint).unlocked_at, Some(deadline));
}
