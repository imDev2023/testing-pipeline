//! Compute ceilings (docs/spec/containment-hook.md, "Compute ceilings"; docs/spec/README.md,
//! "Test layers" 5), each measured on a typical launch against `support/ceilings.rs`, the
//! spec's table and its one place in the tests, and the call depth of a buy. The invariant
//! fuzzer (`tests/fuzz.rs`) measures the same ceilings on every step it runs.
//!
//! A cost is what the hook's own invocation consumes. Each test prints what it measured.

mod support;

use support::*;

#[test]
fn bind_stays_under_its_ceiling() {
    // Less what its bump searches spend beyond each address's first bump, which the ceiling
    // leaves out (docs/spec/containment-hook.md, "Compute ceilings").
    let mut most = 0;
    for contained_index in [0, 1] {
        let mut env = hook_env();
        let mint = contained_mint(&mut env);
        let market = home_market(&mut env, mint, contained_index);
        let meta = bind(&mut env, mint, &market).unwrap();
        let costs = hook_compute(&meta.logs);
        assert_eq!(costs.len(), 1, "{:?}", meta.logs);
        let search = ceilings::bind_bump_search(&mint, &market);
        println!(
            "bind, contained mint at index {contained_index}: {} CU, {search} of them searching for bumps",
            costs[0]
        );
        most = most.max(costs[0] - search);
    }
    assert!(most <= ceilings::BIND, "bind took {most} CU");
}

#[test]
fn each_further_bump_costs_bind_the_same() {
    // What bind costs once its bump searches beyond the first bumps are taken out is the same
    // on every mint, within what comparing keys costs, so the rule its ceiling leaves out is
    // the one its cost follows. The fuzzer measured 55,416 units in all on one mint.
    let mut net = vec![];
    for _ in 0..12 {
        let mut env = hook_env();
        let mint = contained_mint(&mut env);
        let market = home_market(&mut env, mint, 0);
        let meta = bind(&mut env, mint, &market).unwrap();
        let cost = hook_compute(&meta.logs)[0];
        let search = ceilings::bind_bump_search(&mint, &market);
        net.push(cost - search);
        println!("bind: {cost} CU, {search} of them beyond the first bumps");
    }
    let (low, high) = (net.iter().min().unwrap(), net.iter().max().unwrap());
    assert!(
        high - low <= 200,
        "bind less its bump searches ranged from {low} to {high} CU"
    );
}

#[test]
fn execute_stays_under_its_ceiling_on_every_hooked_transfer() {
    // docs/spec/containment-hook.md, "Measured": the hook on each hooked transfer of
    // a trade, into the vault and into the fee account on a sell, out of the vault on a buy.
    let mut env = hook_env();
    let launched = launch(&mut env);
    let trader = trader(&mut env, &launched, 10 * SOL);
    let meta = swap(
        &mut env,
        &launched,
        &trader,
        (QUOTE, CONTAINED),
        SOL,
        &Swap::default(),
    )
    .unwrap();
    let on_buy = hook_compute(&meta.logs);
    assert_eq!(on_buy.len(), 1, "{:?}", meta.logs);
    println!("Execute on a buy, out of the vault: {} CU", on_buy[0]);

    let bought = env.balance(&contained_account(
        &launched,
        &solana_signer::Signer::pubkey(&trader),
    ));
    let meta = swap(
        &mut env,
        &launched,
        &trader,
        (CONTAINED, QUOTE),
        bought / 2,
        &Swap::default(),
    )
    .unwrap();
    let on_sell = hook_compute(&meta.logs);
    assert_eq!(on_sell.len(), 2, "{:?}", meta.logs);
    println!("Execute on a sell, into the vault: {} CU", on_sell[0]);
    println!("Execute on a sell, into the fee account: {} CU", on_sell[1]);

    for cost in on_buy.iter().chain(&on_sell) {
        assert!(*cost <= ceilings::EXECUTE, "Execute took {cost} CU");
    }
}

#[test]
fn unlock_stays_under_its_ceiling() {
    // By the deadline and by the goal. It uses the bumps the config stores, so its cost does
    // not move from mint to mint as `bind`'s does.
    let mut most = 0;
    for by_goal in [false, true] {
        let mut env = hook_env();
        let launched = launch_with(
            &mut env,
            LaunchOptions {
                unlock_goal: if by_goal { 1 } else { GOAL },
                ..LaunchOptions::default()
            },
        );
        if by_goal {
            let trader = trader(&mut env, &launched, 10 * SOL);
            buy(&mut env, &launched, &trader, SOL);
        } else {
            let deadline = config(&env, &launched.mint).unlock_deadline;
            warp_to(&mut env, deadline);
        }
        let meta = unlock(&mut env, &launched).unwrap();
        let costs = hook_compute(&meta.logs);
        assert_eq!(costs.len(), 1, "{:?}", meta.logs);
        println!(
            "unlock by the {}: {} CU",
            if by_goal { "goal" } else { "deadline" },
            costs[0]
        );
        most = most.max(costs[0]);
    }
    assert!(most <= ceilings::UNLOCK, "unlock took {most} CU");
}

#[test]
fn a_buy_calls_the_hook_at_the_deepest_level_devnet_allows() {
    // docs/spec/README.md, "Test layers" 5: router (1), tax AMM (2), Token-2022 (3), hook (4).
    // Devnet does not have SIMD-0268's deeper call limit, and neither does this VM, which
    // runs mainnet's features: without it the limit stays at four levels of calls. LiteSVM
    // writes a feature account for every active feature, so its absence shows it inactive.
    let mut env = hook_env();
    let deeper_limit: pipeline_client::Pubkey = "6TkHkRmP7JZy1fdM6fg5uXn76wChQBWGokHBJzrLB3mj"
        .parse()
        .unwrap();
    assert!(env.svm.get_account(&deeper_limit).is_none());
    let launched = launch(&mut env);
    let trader = trader(&mut env, &launched, 10 * SOL);
    let meta = swap(
        &mut env,
        &launched,
        &trader,
        (QUOTE, CONTAINED),
        SOL,
        &Swap::default(),
    )
    .unwrap();
    assert_eq!(hook_depths(&meta.logs), vec![4]);
    let deepest = meta
        .logs
        .iter()
        .filter_map(|line| line.split(" invoke [").nth(1))
        .map(|rest| rest.trim_end_matches(']').parse::<u32>().unwrap())
        .max()
        .unwrap();
    assert_eq!(deepest, 4, "the hook is the deepest call");
    println!(
        "a buy of a contained token: {} CU in all",
        meta.compute_units_consumed
    );
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
