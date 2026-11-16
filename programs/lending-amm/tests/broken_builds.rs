//! Each invariant of the fuzzer shown able to fail (docs/spec/lending-pool.md, "Invariants for
//! test layer 3"): the deliberately broken builds of `tests/broken-builds.json`, one careless
//! edit each (a rounding flipped the wrong way, a missing check), run through the invariant
//! fuzzer of `tests/common/fuzz.rs` exactly as the real build is, must each be caught, by the
//! invariant the table names.
//!
//! Build them first, from the repo root:
//!
//! ```sh
//! python3 programs/lending-amm/scripts/broken-builds.py
//! ```
//!
//! which writes `programs/target/lending-broken-builds/<name>.so` (`LENDING_BROKEN_BUILDS`
//! moves it). Every build runs from the same fixed seed, `BROKEN_BUILDS_SEED` (default 85), for
//! at most `BROKEN_BUILDS_CASES` sequences (default 400), so a run is the same every time.

mod common;

use std::path::PathBuf;

use common::fuzz::{case, run_case};
use proptest::test_runner::{Config, RngSeed, TestError, TestRunner};

struct Build {
    name: String,
    invariant: String,
}

fn builds() -> Vec<Build> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/broken-builds.json");
    let table: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    table["builds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| Build {
            name: b["name"].as_str().unwrap().to_string(),
            invariant: b["invariant"].as_str().unwrap().to_string(),
        })
        .collect()
}

fn program(name: &str) -> Vec<u8> {
    let dir = std::env::var("LENDING_BROKEN_BUILDS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/lending-broken-builds")
        });
    let path = dir.join(format!("{name}.so"));
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Build the broken builds first: python3 programs/lending-amm/scripts/broken-builds.py",
            path.display()
        )
    })
}

fn var(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Runs the fuzzer on one broken build; returns how many sequences it took and what it
/// reported, or `None` when it found nothing.
fn fuzz(program: &[u8]) -> (u32, Option<String>) {
    let mut runner = TestRunner::new(Config {
        cases: var("BROKEN_BUILDS_CASES", 400) as u32,
        rng_seed: RngSeed::Fixed(var("BROKEN_BUILDS_SEED", 85)),
        failure_persistence: None,
        // The first failure names the invariant; shrinking it would only cost time.
        max_shrink_iters: 0,
        ..Config::default()
    });
    let sequences = std::cell::Cell::new(0);
    let result = runner.run(&case(32), |case| {
        sequences.set(sequences.get() + 1);
        run_case(Some(program), &case).map(|_| ())
    });
    let sequences = sequences.get();
    match result {
        Ok(()) => (sequences, None),
        Err(TestError::Fail(reason, _)) => (sequences, Some(reason.to_string())),
        Err(TestError::Abort(reason)) => (sequences, Some(format!("aborted: {reason}"))),
    }
}

#[test]
fn the_fuzzer_catches_every_broken_build_by_the_invariant_it_breaks() {
    let builds = builds();
    let programs: Vec<Vec<u8>> = builds.iter().map(|b| program(&b.name)).collect();
    let results: Vec<(u32, Option<String>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = programs
            .iter()
            .map(|program| scope.spawn(move || fuzz(program)))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut missed = vec![];
    for (build, (sequences, report)) in builds.iter().zip(results) {
        match report {
            Some(report) if report.contains(&build.invariant) => {
                println!(
                    "{}: caught by {} after {sequences} sequences",
                    build.name, build.invariant
                );
            }
            Some(report) => missed.push(format!(
                "{}: expected {}, but the fuzzer reported: {}",
                build.name,
                build.invariant,
                report.lines().next().unwrap_or_default()
            )),
            None => missed.push(format!(
                "{}: not caught in {sequences} sequences",
                build.name
            )),
        }
    }
    assert!(missed.is_empty(), "{}", missed.join("\n"));
}

#[test]
fn every_invariant_has_a_broken_build() {
    use common::fuzz::invariant::*;
    let caught: Vec<String> = builds().into_iter().map(|b| b.invariant).collect();
    for invariant in [
        CONSERVED,
        EXIT,
        QUOTE,
        RECORDED,
        VALUE,
        IN_KIND,
        SWAP,
        REBALANCE,
        WITHDRAW_MODE,
        SHARES,
        STATES,
    ] {
        assert!(
            caught.iter().any(|c| c == invariant),
            "no broken build shows {invariant} able to fail"
        );
    }
}
