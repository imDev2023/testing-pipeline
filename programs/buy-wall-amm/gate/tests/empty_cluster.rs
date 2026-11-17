//! A cluster with no market must not pass a broken build (audit findings H097 and H098;
//! decision `POOL4-53`): besides replaying every market the cluster has, every gate run makes
//! a market of its own in the same world with the candidate, through the router, seeds it,
//! trades it, runs each keeper job that becomes due, and refuses the candidate if any step
//! fails, so a build that refuses every instruction is refused before the first market
//! exists.
//!
//! Needs the stranding test builds (`cargo run -p buy-wall-gate -- test-builds`).

use buy_wall_gate::keeper::Job;
use buy_wall_gate::snapshot::{Snapshot, StepKind};
use buy_wall_gate::stranding::TestBuild;
use buy_wall_gate::synthetic::Lab;
use buy_wall_gate::{check, download, programs, release::Release};
use litesvm::LiteSVM;
use pipeline_check::SvmSource;
use pipeline_client::{self as client, Pubkey};

fn run(snapshot: &Snapshot, build: &[u8]) -> check::Report {
    check::run(
        snapshot,
        build,
        Some(&programs::pinned_router()),
        &Release::default(),
    )
}

/// A cluster before its first deploy's first market: the router and `build` at `program`,
/// and nothing else, not even the router's config or the program's registration.
fn bare_cluster(build: &[u8], program: Pubkey) -> Snapshot {
    let mut svm = LiteSVM::new();
    svm.add_program(client::PROGRAM_ID, &programs::pinned_router())
        .unwrap();
    svm.add_program(program, build).unwrap();
    let mut source = SvmSource::new(svm);
    let snapshot = download::snapshot(&mut source, &program, &[], None, true, "no market").unwrap();
    assert!(snapshot.markets.is_empty());
    snapshot
}

/// A cluster with the router configured and the program deployed and registered, as devnet
/// is once the program is, but no market yet.
fn registered_cluster(build: &[u8]) -> Snapshot {
    let lab = Lab::new(build, &programs::pinned_router()).unwrap();
    let snapshot = lab.snapshot(&[], "no market").unwrap();
    assert!(snapshot.markets.is_empty());
    snapshot
}

/// The names of the steps run on the gate's own market, without their amounts.
fn own_steps(report: &check::Report) -> Vec<String> {
    report
        .own_market
        .as_ref()
        .expect("the gate made a market of its own")
        .steps
        .iter()
        .map(|step| step.name.split(" (").next().unwrap().to_string())
        .collect()
}

#[test]
fn sos_h097_an_empty_cluster_passes_the_current_build_by_trading_a_market_of_its_own() {
    let build = programs::current_build();
    for snapshot in [
        bare_cluster(&build, programs::program_id()),
        registered_cluster(&build),
    ] {
        let report = run(&snapshot, &build);
        assert!(report.passed(), "{report}");
        assert!(report.markets.is_empty());
        // Made and traded past its first wall and settlement, then checked as a market the
        // cluster had would be, every keeper job due but slot 1's, whose wallet is unset.
        let mut expected = vec!["make a market of its own".to_string()];
        expected.extend(vec!["pipeline_resolve_accounts".to_string(); 2]);
        expected.extend(vec!["quote".to_string(); 6]);
        expected.push("pipeline_market_info".into());
        expected.extend(
            [
                "place_wall",
                "settle",
                "pay_rewards",
                "sweep_fees { slot: 0 }",
                "sweep_fees { slot: 2 }",
            ]
            .map(String::from),
        );
        expected.extend(["buy".to_string(), "sell".to_string()]);
        assert_eq!(own_steps(&report), expected, "{report}");
        assert!(report.to_string().contains("market of its own"), "{report}");
    }
}

#[test]
fn sos_h097_an_empty_cluster_refuses_a_build_that_strands_a_keeper_job() {
    // The deployed build is the current one, the candidate one that can no longer sweep fee
    // slot 2: with no market on the cluster, only the gate's own market can catch it.
    let snapshot = registered_cluster(&programs::current_build());
    let report = run(&snapshot, &programs::test_build(TestBuild::NarrowedSweep));
    assert!(!report.passed(), "{report}");
    let own = report.own_market.as_ref().unwrap();
    let failures = report.failures();
    assert_eq!(failures.len(), 1, "{report}");
    assert_eq!(failures[0].market_state, own.market_state);
    assert_eq!(failures[0].step, "sweep_fees { slot: 2 }", "{report}");
    let failed = own.steps.iter().find(|s| !s.passed).unwrap();
    assert_eq!(
        failed.kind,
        StepKind::Job {
            job: Job::SweepFees(2)
        }
    );
    // A failure on the gate's own market never counts as one the deployed build shares.
    assert!(failed.deployed_fails_too.is_none());
}

#[test]
fn sos_h098_an_empty_cluster_refuses_a_build_declared_for_another_address() {
    // The test-designer-recipient build declares `DesignerTestBui1d1...` and so refuses every
    // instruction at the real address; the same mismatch, mirrored: the current build, which
    // declares the real address, deployed at the designer build's.
    let designer = Pubkey::from_str_const("DesignerTestBui1d111111111111111111111111111");
    let build = programs::current_build();
    let snapshot = bare_cluster(&build, designer);
    let report = run(&snapshot, &build);
    assert!(!report.passed(), "{report}");
    let failures = report.failures();
    assert_eq!(failures.len(), 1, "{report}");
    assert_eq!(failures[0].step, "make a market of its own", "{report}");
    let own = report.own_market.as_ref().unwrap();
    // Anchor's DeclaredProgramIdMismatch, 4100, raised by the build on its first call.
    assert!(own.steps[0].detail.contains("Custom(4100)"), "{report}");
    assert!(
        own.steps[0].detail.contains("DeclaredProgramIdMismatch"),
        "{report}"
    );
}
