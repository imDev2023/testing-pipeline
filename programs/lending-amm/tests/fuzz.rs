//! The stateful invariant fuzzer (docs/spec/README.md, "Test layers" 3) on the real build:
//! sequences that mix every instruction with a moving Kamino, every invariant of
//! docs/spec/lending-pool.md, "Invariants for test layer 3", and the bar's shared three checked
//! after every step. What it generates and checks is `tests/common/fuzz.rs`;
//! `tests/broken_builds.rs` shows each invariant able to fail.
//!
//! `PROPTEST_CASES` sets how many sequences run (default 24, CI's bounded run on every push),
//! `FUZZ_STEPS` their longest (default 32), and `FUZZ_SEED` the seed, which every run prints so
//! a run can be repeated exactly. A long run, from `programs/`:
//!
//! ```sh
//! PROPTEST_CASES=10000 cargo test -p lending-amm --test fuzz -- --nocapture
//! ```

mod common;

use common::fuzz::{case, run_case};
use proptest::test_runner::{Config, RngSeed, TestRunner};

fn var(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.parse().ok())
}

#[test]
fn the_invariants_hold_after_every_step_while_kamino_moves() {
    let cases = var("PROPTEST_CASES").unwrap_or(24) as u32;
    let steps = var("FUZZ_STEPS").unwrap_or(32) as usize;
    let seed = var("FUZZ_SEED").unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    });
    println!("fuzzing {cases} sequences of up to {steps} steps with FUZZ_SEED={seed}");
    let started = std::time::Instant::now();
    let mut runner = TestRunner::new(Config {
        cases,
        rng_seed: RngSeed::Fixed(seed),
        failure_persistence: None,
        ..Config::default()
    });
    let result = runner.run(&case(steps), |case| {
        println!("{}", run_case(None, &case)?);
        Ok(())
    });
    println!(
        "{cases} sequences with FUZZ_SEED={seed} in {:.0} s",
        started.elapsed().as_secs_f64()
    );
    if let Err(failure) = result {
        panic!("FUZZ_SEED={seed}: {failure}");
    }
}

#[test]
fn wide_mul_compares_products_beyond_128_bits() {
    use common::fuzz::wide_mul;
    assert_eq!(wide_mul(u128::MAX, 2), (1, u128::MAX - 1));
    assert!(wide_mul(u128::MAX, 3) > wide_mul(u128::MAX, 2));
    assert_eq!(wide_mul(1 << 64, 1 << 64), (1, 0));
}
