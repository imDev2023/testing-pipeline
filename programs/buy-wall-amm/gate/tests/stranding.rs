//! Proof that the gate catches stranding (docs/spec/pool4-for-solana.md, "A release gate"):
//! on every fixture the repo keeps, a build that moves a field, one that renames the market
//! state type so its derived discriminator changes, and one that changes the account's size
//! are each refused, and a build that appends a field into the reserve passes.
//!
//! Build the test builds first: `cargo run -p buy-wall-gate -- test-builds`.

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
                // Every market of the fixture fails, and the report says where.
                for market in &report.markets {
                    assert!(
                        market.steps.iter().any(|step| !step.passed),
                        "{} left market {} working on {}:\n{report}",
                        build.name(),
                        market.market_state,
                        path.display()
                    );
                }
                println!("{} on {}:\n{report}", build.name(), path.display());
            }
        }
    }
}
