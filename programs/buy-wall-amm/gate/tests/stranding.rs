//! Proof that the gate catches stranding (docs/spec/pool4-for-solana.md, "A release gate"):
//! on every fixture the repo keeps, a build that moves a field, one that renames the market
//! state type so its derived discriminator changes, and one that changes the account's size
//! are each refused, a build whose payout rule can no longer sweep fee slot 2 and one whose
//! slot 2 wallet is refused as unset are each refused on every market the deployed build swept
//! it on and on the market the gate makes of its own, and a build that appends a field into
//! the reserve and one that sets the designer's wallet pass.
//!
//! Build the test builds first: `cargo run -p buy-wall-gate -- test-builds`.

use buy_wall_amm::state::STATUS_OPEN;
use buy_wall_gate::keeper::Job;
use buy_wall_gate::snapshot::{Outcome, Snapshot, StepKind};
use buy_wall_gate::stranding::TestBuild;
use buy_wall_gate::{check, programs, release::Release};

#[test]
fn builds_that_would_strand_a_market_are_refused_on_every_fixture_and_an_append_passes() {
    let fixtures = programs::fixtures();
    assert!(!fixtures.is_empty(), "the repo keeps no fixture");
    let router = programs::pinned_router();
    for build in TestBuild::ALL {
        let elf = programs::test_build(build);
        for (path, snapshot) in &fixtures {
            let report = check::run(snapshot, &elf, Some(&router), &Release::default());
            if build.must_pass() {
                assert!(
                    report.passed(),
                    "{} on {}:\n{report}",
                    build.name(),
                    path.display()
                );
            } else {
                assert!(
                    !report.passed(),
                    "{} passed on {}:\n{report}",
                    build.name(),
                    path.display()
                );
                let failures = report.failures();
                if build.breaks_the_layout() {
                    // Every open market of the fixture fails, and the report says where. A
                    // market waiting for its seed may still work: its seed writes every field
                    // it moves.
                    for market in &report.markets {
                        if status(snapshot, &market.market_state) != STATUS_OPEN {
                            continue;
                        }
                        assert!(
                            failures
                                .iter()
                                .any(|f| f.market_state == market.market_state),
                            "{} left open market {} working on {}:\n{report}",
                            build.name(),
                            market.market_state,
                            path.display()
                        );
                    }
                } else {
                    // Slot 2 fails on every market the deployed build swept it on and on the
                    // gate's own market (POOL4-53), and nothing else does.
                    let slot_2 = StepKind::Job {
                        job: Job::SweepFees(2),
                    };
                    let swept: Vec<&str> = snapshot
                        .baseline
                        .steps
                        .iter()
                        .filter(|s| s.kind == slot_2 && s.outcome == Outcome::Passed)
                        .map(|s| s.market_state.as_str())
                        .collect();
                    assert!(
                        !swept.is_empty(),
                        "{} sweeps slot 2 nowhere",
                        path.display()
                    );
                    let own = &report.own_market.as_ref().unwrap().market_state;
                    let mut failed: Vec<&str> = failures
                        .iter()
                        .map(|f| {
                            assert_eq!(f.step, "sweep_fees { slot: 2 }", "{report}");
                            f.market_state.as_str()
                        })
                        .collect();
                    assert_eq!(failed.pop(), Some(own.as_str()), "{report}");
                    assert_eq!(failed, swept, "{report}");
                }
                println!("{} on {}:\n{report}", build.name(), path.display());
            }
        }
    }
}

/// A saved market state's `status` byte.
fn status(snapshot: &Snapshot, market_state: &str) -> u8 {
    let saved = snapshot
        .accounts
        .iter()
        .find(|a| a.address == market_state)
        .expect("the fixture holds the market state");
    saved.decode().unwrap().1.data[9]
}
