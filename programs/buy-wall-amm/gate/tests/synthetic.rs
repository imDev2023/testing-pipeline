//! A market made by a LiteSVM run through the real router passes the gate with the build
//! that made it (decision `POOL4-20`: until devnet has a market, layout version 1 is
//! represented by such a market, marked synthetic).

use buy_wall_gate::{check, programs, release::Release, synthetic};

#[test]
fn a_market_traded_in_litesvm_passes_the_gate_with_the_build_that_made_it() {
    let build = programs::current_build();
    let router = programs::pinned_router();
    let snapshot = synthetic::build(&build, &router).unwrap();
    assert!(snapshot.synthetic);
    let report = check::run(&snapshot, &build, Some(&router), &Release::default());
    assert!(report.passed(), "{report}");
}

/// The names of the steps the gate ran on each market, without their amounts.
fn steps(report: &check::Report) -> Vec<Vec<String>> {
    report
        .markets
        .iter()
        .map(|market| {
            market
                .steps
                .iter()
                .map(|step| step.name.split(" (").next().unwrap().to_string())
                .collect()
        })
        .collect()
}

#[test]
fn the_gate_resolves_quotes_runs_every_due_keeper_job_buys_and_sells_on_every_market() {
    let build = programs::current_build();
    let router = programs::pinned_router();
    let snapshot = synthetic::build(&build, &router).unwrap();
    let report = check::run(&snapshot, &build, Some(&router), &Release::default());
    let quotes = || vec!["quote".to_string(); 6];
    let resolve = || vec!["pipeline_resolve_accounts".to_string(); 2];
    let trades = || vec!["buy".to_string(), "sell".to_string()];
    // Market A has every keeper job due but slot 1, whose wallet is unset; market B none.
    let jobs = [
        "place_wall",
        "settle",
        "pay_rewards",
        "sweep_fees { slot: 0 }",
        "sweep_fees { slot: 2 }",
    ];
    let a: Vec<String> = [
        resolve(),
        quotes(),
        jobs.map(String::from).to_vec(),
        trades(),
    ]
    .concat();
    let b: Vec<String> = [resolve(), quotes(), trades()].concat();
    assert_eq!(steps(&report), vec![a, b], "{report}");
    assert!(report.passed(), "{report}");
}
