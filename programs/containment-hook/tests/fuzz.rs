//! The stateful invariant fuzzer of contained tokens (docs/spec/containment-hook.md,
//! "Invariants"; docs/spec/README.md, "Test layers" 3 and 5): long random sequences of
//! everything anyone can do to a contained token and its home market, as real transactions
//! through the router copied from devnet in LiteSVM, with the bar's three invariants, the
//! hook's five and the tax AMM's own checked after every step. What it covers is
//! `support/fuzz.rs`; the harness it runs on is the tax AMM's (`tax-amm/tests/common/fuzz/`).
//!
//! A plain `cargo test` runs 1,000 sequences of up to 50 steps, spread over every core.
//! `PROPTEST_CASES` and `FUZZ_STEPS` change that, `FUZZ_THREADS` the threads, and
//! `FUZZ_INVARIANTS` checks only the invariants it names.

mod support;

use std::collections::BTreeMap;
use std::sync::Mutex;

use support::common::fuzz::tax::*;
use support::common::fuzz::{fuzz_in_parallel, replay, sizes, threads, Product};
use support::fuzz::*;
// Both products name these; the hook's are meant here.
use support::fuzz::{self as hook};
use support::mint_hook;

#[test]
fn the_invariants_hold_after_every_step_of_every_sequence() {
    let (cases, steps) = sizes(hook::DEFAULT_CASES, hook::DEFAULT_STEPS);
    let threads = threads();
    let started = std::time::Instant::now();
    // What the run measured and did, from every thread.
    #[derive(Default)]
    struct Run {
        sequences: u32,
        unlocked: u32,
        max_costs: BTreeMap<&'static str, u64>,
        tally: BTreeMap<String, u32>,
    }
    let run = Mutex::new(Run::default());
    fuzz_in_parallel::<ContainmentHook>(cases, steps, threads, |world| {
        let mut run = run.lock().unwrap();
        run.sequences += 1;
        if mint_hook(&world.tax.env, &world.mint).is_some_and(|hook| hook.program.is_none()) {
            run.unlocked += 1;
        }
        for (label, count) in world.tally.iter().chain(&world.tax.tally) {
            *run.tally.entry(label.clone()).or_default() += count;
        }
        for (&name, &cost) in &world.max_costs {
            let max = run.max_costs.entry(name).or_default();
            *max = (*max).max(cost);
        }
    });
    let run = run.into_inner().unwrap();
    println!(
        "{} sequences of up to {steps} steps passed in {:.0?} on {threads} threads; {} ended unlocked",
        run.sequences,
        started.elapsed(),
        run.unlocked
    );
    for (label, count) in &run.tally {
        println!("{count:>8}  {label}");
    }
    for (name, ceiling) in [
        ("execute", support::ceilings::EXECUTE),
        ("bind", support::ceilings::BIND),
        ("unlock", support::ceilings::UNLOCK),
    ] {
        match run.max_costs.get(name) {
            Some(cost) => println!("{name}: at most {cost} CU of its {ceiling}"),
            None => println!("{name}: never ran"),
        }
    }
}

#[test]
fn the_eight_invariants_are_the_specs() {
    let names: Vec<&str> = ContainmentHook::invariants()
        .iter()
        .map(|i| i.name)
        .collect();
    // The bar's three come first, as the tax AMM checks them.
    assert_eq!(&names[..3], &support::common::fuzz::tax::INVARIANTS[..3]);
    // Then the hook's five, after the rest of the tax AMM's, in the spec's order.
    let at = names
        .iter()
        .position(|&n| n == hook::INVARIANTS[0])
        .unwrap();
    assert_eq!(&names[at..at + 5], &hook::INVARIANTS[..]);
    let spec = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/spec/containment-hook.md"),
    )
    .unwrap();
    let section = spec
        .split("### Invariants")
        .nth(1)
        .and_then(|rest| rest.split("\n### ").next())
        .unwrap();
    let numbered = section
        .lines()
        .filter(|line| line.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .count();
    assert_eq!(numbered, 5, "the spec lists five of its own");
}

/// The fuzzer's first failure (2026-11-16), minimised: a holder's `transfer_checked` to their
/// own account settled while the token was contained, where the fuzzer expected the hook to
/// refuse it. Token-2022 completes a transfer from an account to itself before it calls any
/// hook, so nothing moves and the hook never runs; the spec now says so ("What this allows",
/// and invariant 2), and the fuzzer expects it.
#[test]
fn regression_a_transfer_to_the_same_account_moves_nothing_and_skips_the_hook() {
    replay::<ContainmentHook>(
        &HookShape {
            tax: Shape {
                mints: [Outside, SplToken],
                tax_side: 1,
                ranges: [[0, 0], [0, 0]],
                rates: [0, 0],
                recipients: 1,
                weights: [1, 1, 1, 1, 1],
                burn: false,
                tax_authority: false,
                virtual_side: 0,
                virtual_reserve: 0,
                seed: [1000, 1000],
                creation: CreateAndSeed,
                keys: 0,
            },
            contained: 0,
            unlock_goal: 1,
            deadline_after: 1,
        },
        &[Transfer {
            from: 2,
            own: false,
            to: Holder(2),
            size: Dust(1),
            tail: Complete,
        }],
    );
}

/// The fuzzer's second failure (2026-11-16), minimised: on a market created without its seed,
/// the deadline came and went, the token was unlocked, and the seeder sent away part of what
/// it was to seed, so the seed failed for want of funds where the tax AMM's model expected it
/// to settle. The model now expects a seed bigger than the seeder holds to be refused with
/// `InsufficientFunds`, which only a product built on the tax AMM, whose transfers let the
/// seeder spend its seed first, can reach.
#[test]
fn regression_the_seeder_keeps_its_seed_until_the_seed() {
    replay::<ContainmentHook>(
        &HookShape {
            tax: Shape {
                mints: [Outside, SplToken],
                tax_side: 1,
                ranges: [[0, 0], [0, 0]],
                rates: [0, 0],
                recipients: 1,
                weights: [1, 1, 1, 1, 1],
                burn: false,
                tax_authority: false,
                virtual_side: 0,
                virtual_reserve: 0,
                seed: [1000, 1000],
                creation: CreateOnly,
                keys: 0,
            },
            contained: 0,
            unlock_goal: 1,
            deadline_after: 1,
        },
        &[
            ToDeadline { offset: 0 },
            Unlock {
                caller: 0,
                state: RecordedState,
            },
            Transfer {
                from: 54,
                own: false,
                to: Holder(143),
                size: Dust(1),
                tail: Complete,
            },
            Tax(Seed {
                who: Seeder,
                empty_side: None,
            }),
        ],
    );
}

/// The fuzzer's third failure (2026-11-16), minimised: the seeder sent one unit of its seed
/// straight into the home vault while the token was contained, as the hook allows, then
/// seeded with its quote side left empty, and the token program refused the first side for
/// want of funds where the tax AMM's model expected `ZeroSeed` for the second. The model now
/// takes the sides in the program's order, each side's transfer before its check that
/// something arrived.
#[test]
fn regression_a_seed_is_judged_side_by_side() {
    replay::<ContainmentHook>(
        &HookShape {
            tax: Shape {
                mints: [Outside, SplToken],
                tax_side: 1,
                ranges: [[0, 0], [0, 0]],
                rates: [0, 0],
                recipients: 1,
                weights: [1, 1, 1, 1, 1],
                burn: false,
                tax_authority: false,
                virtual_side: 0,
                virtual_reserve: 0,
                seed: [1000, 1000],
                creation: CreateOnly,
                keys: 0,
            },
            contained: 0,
            unlock_goal: 1,
            deadline_after: 1,
        },
        &[
            Transfer {
                from: 76,
                own: false,
                to: HomeVault,
                size: Dust(1),
                tail: Complete,
            },
            Tax(Seed {
                who: Seeder,
                empty_side: Some(1),
            }),
        ],
    );
}
