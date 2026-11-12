//! Compute ceilings (docs/spec/containment-hook.md, "Compute ceilings"; docs/spec/README.md,
//! "Test layers" 5). This module mirrors the spec's table, and is its one place in the
//! tests: a ceiling changes only by a PR to the spec file and this table together.
//!
//! A cost is what the hook's own invocation consumes. Each test prints what it measured.

mod support;

use support::*;

/// The spec's table, in compute units.
mod ceilings {
    pub const EXECUTE: u64 = 10_000;
    pub const BIND: u64 = 60_000;
    pub const UNLOCK: u64 = 30_000;
}

/// The compute units each invocation of the hook consumed, in order, from a transaction's
/// logs.
fn hook_compute(logs: &[String]) -> Vec<u64> {
    let prefix = format!("Program {} consumed ", hook_id());
    logs.iter()
        .filter_map(|line| line.strip_prefix(&prefix))
        .map(|rest| rest.split(' ').next().unwrap().parse().unwrap())
        .collect()
}

#[test]
fn bind_stays_under_its_ceiling() {
    let mut most = 0;
    for contained_index in [0, 1] {
        let mut env = hook_env();
        let mint = contained_mint(&mut env);
        let market = home_market(&mut env, mint, contained_index);
        let meta = bind(&mut env, mint, &market).unwrap();
        let costs = hook_compute(&meta.logs);
        assert_eq!(costs.len(), 1, "{:?}", meta.logs);
        println!(
            "bind, contained mint at index {contained_index}: {} CU",
            costs[0]
        );
        most = most.max(costs[0]);
    }
    assert!(most <= ceilings::BIND, "bind took {most} CU");
}

#[test]
fn the_table_mirrors_the_spec() {
    let spec = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/spec/containment-hook.md"),
    )
    .unwrap();
    let table: String = spec
        .split("### Compute ceilings")
        .nth(1)
        .and_then(|rest| rest.split("\n### ").next())
        .expect("the spec's compute ceilings section")
        .to_string();
    let row = |instruction: &str, ceiling: &str| {
        let cells = format!("| {instruction} | {ceiling} |");
        assert!(
            table.contains(&cells),
            "the spec's table has no row {cells}"
        );
    };
    row("`Execute`", &format_cu(ceilings::EXECUTE));
    row("`bind`", &format_cu(ceilings::BIND));
    row("`unlock`", &format_cu(ceilings::UNLOCK));
}

/// `60000` as the spec writes it, `60,000`.
fn format_cu(units: u64) -> String {
    let digits = units.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}
