//! The stateful invariant fuzzer across every instruction (docs/spec/tax-amm.md,
//! "Invariants"; docs/spec/README.md, "Test layers" 3 and 5): long random sequences of
//! everything anyone can do to tax markets of every shape, as real transactions through the
//! router copied from devnet in LiteSVM, with the ten invariants checked after every step.
//! What it covers is `common/fuzz/tax.rs`; the harness, and how to add a product's steps and
//! invariants to it, is `common/fuzz/mod.rs`.
//!
//! A plain `cargo test` runs 1,000 sequences of up to 50 steps. `PROPTEST_CASES` and
//! `FUZZ_STEPS` change that, and `FUZZ_INVARIANTS` checks only the invariants it names.

mod common;

use std::collections::BTreeMap;

use common::ceilings;
use common::fuzz::tax::*;
use common::fuzz::{fuzz, replay, sizes, Product};
use common::*;
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn the_invariants_hold_after_every_step_of_every_sequence() {
    let (cases, steps) = sizes(DEFAULT_CASES, DEFAULT_STEPS);
    let started = std::time::Instant::now();
    // The most compute each instruction took across the whole run.
    let mut max_costs: BTreeMap<&'static str, u64> = BTreeMap::new();
    // What the steps did, and the shapes they did it on, across the run.
    let mut tally: BTreeMap<String, u32> = BTreeMap::new();
    let mut shapes: BTreeMap<String, u32> = BTreeMap::new();
    let mut ran = 0u32;
    fuzz::<TaxAmm>(cases, steps, |world| {
        ran += 1;
        for (label, count) in &world.tally {
            *tally.entry(label.clone()).or_default() += count;
        }
        for feature in features(&world.shape) {
            *shapes.entry(feature).or_default() += 1;
        }
        for (&name, &cost) in &world.max_costs {
            let max = max_costs.entry(name).or_default();
            *max = (*max).max(cost);
        }
    });
    println!(
        "{ran} sequences of up to {steps} steps passed in {:.0?}",
        started.elapsed()
    );
    for (feature, count) in &shapes {
        println!("{count:>8}  markets: {feature}");
    }
    for (label, count) in &tally {
        println!("{count:>8}  {label}");
    }
    for (name, ceiling) in ceilings::ALL {
        match max_costs.get(name) {
            Some(cost) => println!("{name}: at most {cost} CU of its {ceiling}"),
            None => println!("{name}: not measured, never called without a transfer hook"),
        }
    }
}

#[test]
fn the_ten_invariants_are_the_specs() {
    let names: Vec<&str> = TaxAmm::invariants().iter().map(|i| i.name).collect();
    assert_eq!(
        &names[..10],
        &INVARIANTS[..],
        "the ten come first, in order"
    );
    // The bar's three, then the spec's seven, by its "Invariants" list.
    let spec = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/spec/tax-amm.md"),
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
    assert_eq!(numbered, 7, "the spec lists seven of its own");
}

/// What a market's shape covers, for the run's tally.
fn features(shape: &Shape) -> Vec<String> {
    let mut features = vec![
        format!("{:?} at index 0", shape.mints[0]),
        format!("{:?} at index 1", shape.mints[1]),
        format!("taxed on side {}", shape.tax_side),
        format!("{} tax recipients", shape.recipients),
        format!("created by {:?}", shape.creation),
    ];
    if shape.burn {
        features.push("a burn share".into());
    }
    if shape.tax_authority {
        features.push("a tax authority".into());
    }
    if shape.virtual_reserve > 0 {
        features.push(format!("a virtual reserve on side {}", shape.virtual_side));
        if shape.seed[shape.virtual_side as usize] == 0 {
            features.push("seeded single-sided".into());
        }
    }
    features
}

/// The fuzzer's first failure (2026-11-12), minimised: a tax recipient paid in mint 0 had no
/// token account for mint 1, so selling all it was paid failed in the router
/// (`BadTokenAccount`). A terminal creates the trader's output account in the swap's
/// transaction, which the harness now does too, so the recipient exits.
#[test]
fn regression_a_recipient_paid_in_one_mint_sells_it_for_the_other() {
    replay::<TaxAmm>(
        &Shape {
            mints: [SplToken, SplToken],
            tax_side: 0,
            ranges: [[0, 0], [0, 2]],
            rates: [0, 1],
            recipients: 2,
            weights: [1, 1, 1, 1, 1],
            burn: false,
            tax_authority: false,
            virtual_side: 0,
            virtual_reserve: 0,
            seed: [10_000, 1_000],
            creation: CreateAndSeed,
            keys: 0,
        },
        &[
            Swap {
                wallet: 0,
                input: 0,
                size: Part {
                    mantissa: 1,
                    exp: 7,
                },
            },
            Swap {
                wallet: 0,
                input: 0,
                size: Part {
                    mantissa: 5,
                    exp: 6,
                },
            },
            Swap {
                wallet: 0,
                input: 1,
                size: Dust(1),
            },
            Distribute {
                slot: 0,
                caller: 0,
                wrong_wallet: false,
            },
        ],
    );
}

/// The fuzzer's second failure (2026-11-12), minimised: building a market left for a later
/// `seed` airdropped the seeder twice in one blockhash, the same transaction again
/// (`AlreadyProcessed`). The harness now moves to a new blockhash before each airdrop.
#[test]
fn regression_a_market_created_without_its_seed() {
    replay::<TaxAmm>(
        &Shape {
            mints: [SplToken, SplToken],
            tax_side: 0,
            ranges: [[0, 0], [0, 0]],
            rates: [0, 0],
            recipients: 1,
            weights: [1, 1, 1, 1, 1],
            burn: false,
            tax_authority: false,
            virtual_side: 0,
            virtual_reserve: 0,
            seed: [1_000, 1_000],
            creation: CreateOnly,
            keys: 0,
        },
        &[Swap {
            wallet: 0,
            input: 0,
            size: Dust(1),
        }],
    );
}

/// The fuzzer's third finding (2026-11-12): `distribute` once took 84,443 units of its
/// 90,000 on a market without a hooked mint, because finding the slot wallet's associated
/// token account tries bumps from 255 down at 1,500 units a try, once in the program and
/// twice more in the associated token program when it creates the account. The ceilings
/// leave that search out beyond the first bump (docs/spec/tax-amm.md, "Compute ceilings");
/// this pins what it costs, so the rule a keeper sizes its compute by stays true.
#[test]
fn each_further_bump_of_the_slot_wallets_address_costs_a_payout_the_same() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let tax_mint = mints[1].0;
    // Two wallets whose token accounts for the tax-side mint need 1 bump and 6 bumps.
    let wallet_with_bump = |bump: u8| loop {
        let wallet = Pubkey::new_unique();
        let (_, found) = Pubkey::find_program_address(
            &[wallet.as_ref(), TOKEN.as_ref(), tax_mint.as_ref()],
            &pipeline_client::ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        if found == bump {
            break wallet;
        }
    };
    let (first, sixth) = (wallet_with_bump(255), wallet_with_bump(250));
    let mut params = valid_params(&Pubkey::new_unique());
    params.recipients[0] = ak(&first);
    params.recipients[1] = ak(&sixth);
    let market = env.seeded_market(mints, &params, [100_000_000_000, 200_000_000_000]);
    let trader = env.funded_wallet(&market, 1_000_000_000_000);
    let caller = Keypair::new();
    env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
    let payout = |env: &mut Env, slot: u8| {
        env.swap(&market, &trader, (1, 0), 10_000_000_000).unwrap();
        let meta = env.distribute(&market, &caller, slot).unwrap();
        strategy_compute(&meta.logs)[0]
    };
    let creating = [payout(&mut env, 0), payout(&mut env, 1)];
    let existing = [payout(&mut env, 0), payout(&mut env, 1)];
    println!("payouts creating the account: {creating:?} CU; into it: {existing:?} CU");
    // Comparing keys stops at their first differing byte, so a few units also depend on
    // the addresses.
    let near = |measured: u64, expected: u64| measured.abs_diff(expected) <= 100;
    assert!(near(creating[1] - creating[0], 5 * 3 * ceilings::BUMP_TRY));
    assert!(near(existing[1] - existing[0], 5 * ceilings::BUMP_TRY));
    // Within the ceiling once the search beyond the first bump is left out.
    assert!(creating[1] - 5 * 3 * ceilings::BUMP_TRY <= ceilings::DISTRIBUTE);
    assert!(existing[1] - 5 * ceilings::BUMP_TRY <= ceilings::DISTRIBUTE);
}

/// Hardening finding T01 (#67, docs/security/tax-amm/round-1.md): the fuzzer took the first
/// `Error Code:` name in a failure's logs as the spec's refusal, whichever program raised it,
/// so a refusal by the router or a hook under one of the spec's names would have passed as the
/// tax AMM's. A refusal is now the spec's only when the tax AMM raised it with that error's
/// number.
#[test]
fn sos_t01_a_refusal_raised_by_another_program_is_never_taken_for_the_strategys() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let params = valid_params(&Pubkey::new_unique());
    let market = env.seeded_market(mints, &params, [1_000_000_000, 1_000_000_000]);
    let trader = env.funded_wallet(&market, 1_000_000_000);

    // The router refuses a swap that would pay less than its minimum.
    let quote = env.quote(&market, &exact_in(0, 1, 1_000_000)).unwrap();
    let options = SwapOptions {
        min_amount_out: quote.amount_out + 1,
        ..SwapOptions::default()
    };
    let failure = env
        .swap_with(&market, &trader, (0, 1), 1_000_000, &options)
        .unwrap_err();
    let named = failure
        .split("Error Code: ")
        .nth(1)
        .and_then(|rest| rest.split('.').next())
        .expect("the router names its error")
        .to_string();
    let router = pipeline_client::PROGRAM_ID.to_string();
    assert_eq!(
        refusal(&failure),
        format!("{named} from {router}"),
        "a refusal by the router names the router"
    );

    // The tax AMM's own refusal, raised inside the router's swap, keeps its bare name.
    let dust = env
        .swap_with(&market, &trader, (0, 1), 1, &SwapOptions::default())
        .unwrap_err();
    assert_eq!(refusal(&dust), "ZeroOutput");
}

/// Hardening finding T02 (#67): the fuzzer checked no compute on a market with a hooked mint,
/// although most instructions there never call the hook (the tax authority's actions,
/// quotes, a swap paying out the unhooked mint, `distribute` on the unhooked side), about a
/// third of all shapes. Now only an invocation that called a program of the mint's own
/// (its hook) goes unmeasured, since a hook's cost is the hook's own to bound.
#[test]
fn sos_t02_instructions_that_never_call_the_hook_are_measured_on_hooked_markets() {
    let shape = Shape {
        mints: [Hooked, SplToken],
        tax_side: 1,
        ranges: [[0, 1_000], [0, 1_000]],
        rates: [300, 300],
        recipients: 1,
        weights: [1, 1, 1, 1, 1],
        burn: false,
        tax_authority: true,
        virtual_side: 0,
        virtual_reserve: 0,
        seed: [1_000_000_000, 1_000_000_000],
        creation: CreateAndSeed,
        keys: 0,
    };
    let mut world = TaxAmm::world(&shape).unwrap();
    let measured = |world: &mut TaxWorld, step: Step| -> Vec<&'static str> {
        let outcome = TaxAmm::apply(world, &step);
        assert!(outcome.result.is_ok(), "{step:?}: {outcome:?}");
        outcome.costs.iter().map(|&(name, _)| name).collect()
    };
    let set_taxes = SetTaxes {
        who: TaxAuthority,
        buy: Exactly(100),
        sell: Exactly(200),
    };
    assert_eq!(measured(&mut world, set_taxes), ["set_taxes"]);
    // Into the hooked mint, out of the unhooked one: the router moves the hooked input,
    // the tax AMM's own transfer is of the unhooked mint.
    let buy = Swap {
        wallet: 0,
        input: 0,
        size: Part {
            mantissa: 1,
            exp: 4,
        },
    };
    assert_eq!(
        measured(&mut world, buy),
        ["pipeline_resolve_accounts", "pipeline_quote", "pipeline_swap"]
    );
    // Out of the hooked mint: the tax AMM's transfer calls the hook, so the swap goes
    // unmeasured, and its quote does not.
    let sell = Swap {
        wallet: 0,
        input: 1,
        size: Part {
            mantissa: 1,
            exp: 4,
        },
    };
    assert_eq!(
        measured(&mut world, sell),
        ["pipeline_resolve_accounts", "pipeline_quote"]
    );
    let payout = Distribute {
        slot: 0,
        caller: 0,
        wrong_wallet: false,
    };
    assert_eq!(measured(&mut world, payout), ["distribute"]);
    // The creation reads the hooked mint but calls nothing of it; the seed moves it in.
    assert!(!world.max_costs.contains_key("seed"));
    for name in [
        "pipeline_init_market",
        "pipeline_market_info",
        "set_taxes",
        "pipeline_resolve_accounts",
        "pipeline_quote",
        "pipeline_swap",
        "distribute",
    ] {
        assert!(world.max_costs.contains_key(name), "{name} is recorded");
    }
}
