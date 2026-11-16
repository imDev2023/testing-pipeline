//! The stateful invariant fuzzer's harness (docs/spec/README.md, "Test layers" 3): Proptest
//! generates a market of some shape and a sequence of steps, the harness sends each step as
//! real transactions through the router copied from devnet in LiteSVM, and after every step
//! it checks every invariant of the product. A failing sequence is shrunk to a minimal one,
//! printed so it can be pasted into a regression test, and replayed by [`replay`].
//!
//! The harness knows nothing about any product. A product is a [`Product`]: how to build a
//! world from a shape, the steps that can happen to it, how to apply one, what to observe
//! before and after each step (its [`Product::Snapshot`]), and its invariants, each a named
//! check of one step: the world, the snapshots before and after, and what the step did
//! (its [`Product::Outcome`]). The tax AMM's product is [`tax::TaxAmm`].
//!
//! # Adding a product's steps and invariants
//!
//! A product that builds on another, as the containment hook builds on the tax AMM (its
//! contained tokens trade only in a tax market), wraps the other's parts rather than
//! repeating them:
//!
//! 1. Its shape holds the inner product's shape plus its own choices, and its world holds
//!    the inner world (for the hook, a [`tax::TaxWorld`] whose market trades a contained
//!    token) plus its own accounts.
//! 2. Its step enum has a variant wrapping the inner product's step, applied by the inner
//!    product's [`Product::apply`], and a variant per step of its own (for the hook:
//!    `bind`, `unlock`, transfers that must be refused).
//! 3. Its snapshot and outcome hold the inner product's. A step of its own gives the inner
//!    outcome [`tax::Outcome::outside`], which tells the inner invariants that no
//!    instruction of the inner product ran, so they check it changed nothing they guard.
//! 4. Its invariants are the inner product's, each [`lift`]ed through the four field
//!    projections, followed by its own.
//! 5. Its fuzz test calls [`fuzz`] with its product, and its regression tests call
//!    [`replay`] with the minimal sequences [`fuzz`] printed.
//!
//! Shapes and steps refer to wallets and markets by index, never by key, and a product
//! derives every key its world creates from its shape (the tax AMM's from `Shape::keys`), so
//! a printed sequence replays exactly; the base VM's admin, who only pays and creates, is the
//! one key that differs between runs.
//!
//! # Running it
//!
//! `PROPTEST_CASES` sets how many sequences run and `FUZZ_STEPS` the most steps in one
//! (each product sets its defaults). `FUZZ_INVARIANTS`, a comma-separated list of invariant
//! names, checks only those: how each invariant is shown to catch a fault on its own. A
//! product whose sequences are slow runs them with [`fuzz_in_parallel`], on as many threads
//! as `FUZZ_THREADS` says, or every core.

#![allow(dead_code)]

pub mod tax;

use std::fmt::Debug;

use proptest::prelude::*;
use proptest::strategy::BoxedStrategy;
use proptest::test_runner::{Config, TestCaseError, TestError, TestRunner};

/// One product under the fuzzer.
pub trait Product: 'static {
    /// How a market is set up, chosen by Proptest.
    type Shape: Clone + Debug;
    /// Everything the steps act on.
    type World;
    /// One thing anyone can do, chosen by Proptest.
    type Step: Clone + Debug;
    /// What the invariants compare before and after a step.
    type Snapshot;
    /// What a step did.
    type Outcome: Debug;

    /// Proptest's strategy for shapes.
    fn shapes() -> BoxedStrategy<Self::Shape>;
    /// Proptest's strategy for steps.
    fn steps() -> BoxedStrategy<Self::Step>;
    /// A fresh world of `shape`. Setup failing is a failure of the product.
    fn world(shape: &Self::Shape) -> Result<Self::World, String>;
    /// What a world holds now.
    fn snapshot(world: &Self::World) -> Self::Snapshot;
    /// Applies one step. A step the program refuses is an outcome, not an error.
    fn apply(world: &mut Self::World, step: &Self::Step) -> Self::Outcome;
    /// The outcome of a world just built, checked against the snapshot it starts from.
    fn start(world: &Self::World) -> Self::Outcome;
    /// Steps that end every sequence, such as every holder exiting.
    fn closing_steps(world: &Self::World) -> Vec<Self::Step>;
    /// Every invariant, checked after every step.
    fn invariants() -> Vec<Invariant<Self>>;
}

/// What an invariant is given: one step's world, snapshots and outcome.
pub struct Checked<'a, P: Product + ?Sized> {
    pub world: &'a P::World,
    pub before: &'a P::Snapshot,
    pub after: &'a P::Snapshot,
    pub outcome: &'a P::Outcome,
}

/// An invariant's check of one step. `Err` says what broke.
pub type Check<P> = Box<dyn Fn(&Checked<'_, P>) -> Result<(), String>>;

/// A named check of one step.
pub struct Invariant<P: Product + ?Sized> {
    pub name: &'static str,
    pub check: Check<P>,
}

impl<P: Product + ?Sized> Invariant<P> {
    pub fn new(
        name: &'static str,
        check: impl Fn(&Checked<'_, P>) -> Result<(), String> + 'static,
    ) -> Self {
        Invariant {
            name,
            check: Box::new(check),
        }
    }
}

/// An inner product's invariant, checked on an outer product that holds the inner one's
/// world, snapshots and outcome (see "Adding a product's steps and invariants").
pub fn lift<O: Product, I: Product>(
    inner: Invariant<I>,
    world: fn(&O::World) -> &I::World,
    snapshot: fn(&O::Snapshot) -> &I::Snapshot,
    outcome: fn(&O::Outcome) -> &I::Outcome,
) -> Invariant<O> {
    let check = inner.check;
    Invariant::new(inner.name, move |c: &Checked<'_, O>| {
        check(&Checked {
            world: world(c.world),
            before: snapshot(c.before),
            after: snapshot(c.after),
            outcome: outcome(c.outcome),
        })
    })
}

/// The invariants `FUZZ_INVARIANTS` names, or all of them. Naming one that does not exist
/// fails, so a typo can't make a run check nothing.
pub fn enabled<P: Product>() -> Vec<Invariant<P>> {
    let all = P::invariants();
    let Ok(names) = std::env::var("FUZZ_INVARIANTS") else {
        return all;
    };
    let names: Vec<&str> = names.split(',').map(str::trim).collect();
    for name in &names {
        assert!(
            all.iter().any(|invariant| invariant.name == *name),
            "FUZZ_INVARIANTS names {name}, which is not an invariant: {:?}",
            all.iter()
                .map(|invariant| invariant.name)
                .collect::<Vec<_>>()
        );
    }
    all.into_iter()
        .filter(|invariant| names.contains(&invariant.name))
        .collect()
}

fn check_all<P: Product>(
    invariants: &[Invariant<P>],
    checked: &Checked<'_, P>,
    at: &str,
) -> Result<(), String> {
    for invariant in invariants {
        (invariant.check)(checked).map_err(|broken| {
            format!(
                "invariant `{}` broke {at}: {broken}\noutcome: {:?}",
                invariant.name, checked.outcome
            )
        })?;
    }
    Ok(())
}

/// Builds a world of `shape`, then applies `steps` and the product's closing steps, checking
/// `invariants` on the world as built and after every step.
pub fn run_sequence<P: Product>(
    invariants: &[Invariant<P>],
    shape: &P::Shape,
    steps: &[P::Step],
) -> Result<P::World, String> {
    let mut world = P::world(shape)?;
    let start = P::snapshot(&world);
    let outcome = P::start(&world);
    check_all(
        invariants,
        &Checked {
            world: &world,
            before: &start,
            after: &start,
            outcome: &outcome,
        },
        "at the start",
    )?;
    // Each step's snapshot after is the next one's before.
    let apply = |world: &mut P::World,
                 before: P::Snapshot,
                 index: usize,
                 step: &P::Step,
                 what: &str|
     -> Result<P::Snapshot, String> {
        let outcome = P::apply(world, step);
        let after = P::snapshot(world);
        check_all(
            invariants,
            &Checked {
                world,
                before: &before,
                after: &after,
                outcome: &outcome,
            },
            &format!("after {what} {index}, {step:?}"),
        )?;
        Ok(after)
    };
    let mut before = start;
    for (index, step) in steps.iter().enumerate() {
        before = apply(&mut world, before, index, step, "step")?;
    }
    for (index, step) in P::closing_steps(&world).iter().enumerate() {
        before = apply(&mut world, before, index, step, "closing step")?;
    }
    Ok(world)
}

/// How many sequences and steps a run has: `PROPTEST_CASES` and `FUZZ_STEPS`, or the
/// product's defaults.
pub fn sizes(default_cases: u32, default_steps: usize) -> (u32, usize) {
    let read = |name: &str| std::env::var(name).ok().and_then(|v| v.parse().ok());
    (
        read("PROPTEST_CASES").unwrap_or(default_cases),
        read("FUZZ_STEPS")
            .map(|steps: u32| steps as usize)
            .unwrap_or(default_steps),
    )
}

/// Runs `cases` sequences of 1 to `max_steps` steps of product `P`, each on a shape of its
/// own, and fails with the minimal failing shape and sequence, printed as Rust so it can be
/// replayed by [`replay`] in a regression test. `each` sees every world after its sequence
/// passed, so a test can read what was measured across the run.
pub fn fuzz<P: Product>(cases: u32, max_steps: usize, each: impl FnMut(&P::World)) {
    // Proptest runs cases through a `Fn`.
    let each = std::cell::RefCell::new(each);
    let invariants = enabled::<P>();
    let max_shrink_iters = std::env::var("PROPTEST_MAX_SHRINK_ITERS")
        .ok()
        .and_then(|iters| iters.parse().ok())
        .unwrap_or(1_024);
    let mut runner = TestRunner::new(Config {
        cases,
        max_shrink_iters,
        failure_persistence: None,
        ..Config::default()
    });
    let strategy = (
        P::shapes(),
        prop::collection::vec(P::steps(), 1..=max_steps),
    );
    let result = runner.run(&strategy, |(shape, steps)| {
        let world = run_sequence::<P>(&invariants, &shape, &steps).map_err(TestCaseError::fail)?;
        (each.borrow_mut())(&world);
        Ok(())
    });
    match result {
        Ok(()) => {}
        Err(TestError::Fail(reason, (shape, steps))) => {
            let product = std::any::type_name::<P>()
                .rsplit("::")
                .next()
                .unwrap_or("P");
            panic!(
                "{reason}\n\nminimal failing case, for a regression test:\n\nreplay::<{product}>(\n&{shape:#?},\n&{steps:#?},\n);"
            )
        }
        Err(TestError::Abort(reason)) => panic!("the fuzzer aborted: {reason}"),
    }
}

/// How many threads [`fuzz_in_parallel`] runs on: `FUZZ_THREADS`, or every core.
pub fn threads() -> usize {
    std::env::var("FUZZ_THREADS")
        .ok()
        .and_then(|threads| threads.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
        .max(1)
}

/// [`fuzz`] split across `threads` threads, each running its share of the `cases` on worlds
/// of its own (a product keeps its base VM per thread), for a product whose sequences are
/// too slow to run one after another. A failure is shrunk and printed by the thread that
/// found it, as [`fuzz`] prints it, and fails the run once every thread has finished.
pub fn fuzz_in_parallel<P: Product>(
    cases: u32,
    max_steps: usize,
    threads: usize,
    each: impl Fn(&P::World) + Sync,
) {
    let threads = threads.clamp(1, cases.max(1) as usize) as u32;
    std::thread::scope(|scope| {
        let each = &each;
        let runs: Vec<_> = (0..threads)
            .map(|k| {
                // The first `cases % threads` threads take one case more.
                let share = cases / threads + u32::from(k < cases % threads);
                std::thread::Builder::new()
                    .name(format!("fuzz-{k}"))
                    .spawn_scoped(scope, move || fuzz::<P>(share, max_steps, each))
                    .expect("a fuzzing thread")
            })
            .collect();
        let failed = runs
            .into_iter()
            .map(|run| run.join())
            .filter(Result::is_err)
            .count();
        assert!(
            failed == 0,
            "{failed} of {threads} fuzzing threads found a failing case, printed above"
        );
    });
}

/// Replays one sequence on one shape with every invariant: a regression test made from a
/// minimal failing case [`fuzz`] printed.
pub fn replay<P: Product>(shape: &P::Shape, steps: &[P::Step]) -> P::World {
    run_sequence::<P>(&P::invariants(), shape, steps).unwrap_or_else(|broken| panic!("{broken}"))
}
