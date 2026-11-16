//! Compute ceilings, asserted per instruction (docs/spec/README.md, "Test layers" 5;
//! docs/spec/pool4-for-solana.md, "Compute ceilings"). This module mirrors the spec's table
//! for the instructions built so far; a ceiling may be lowered to what is measured plus
//! headroom, and raising one needs a reason written into the spec.
//!
//! What is measured is the strategy's own invocation, its token program calls included,
//! from the runtime's "consumed" log lines.

mod common;

use common::*;
use pipeline_client::Pubkey;
use pipeline_client::{self as client, AccountMeta, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;

const INIT_MARKET: u64 = 120_000;
const SEED: u64 = 80_000;
const MARKET_INFO: u64 = 10_000;
const RESOLVE_ACCOUNTS: u64 = 10_000;
const QUOTE: u64 = 40_000;
const SWAP_ONE_STEP: u64 = 45_000;
const SEED_LIQUIDITY: u64 = 180_000;

const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;

#[test]
fn creation_and_the_seed_stay_under_their_ceilings() {
    for (label, program, hook) in [
        ("SPL Token", TOKEN, false),
        ("Token-2022", TOKEN_2022, false),
        ("Token-2022 with a transfer hook", TOKEN_2022, true),
    ] {
        let mut env = Env::new();
        let token = if hook {
            env.create_mint_with(
                &program,
                6,
                &[RealExtension::TransferHook {
                    program: TEST_HOOK_PROGRAM,
                }],
                false,
            )
        } else {
            env.create_mint(&program, 6)
        };
        env.revoke_authorities(&token, &program);
        let admin = env.admin.pubkey();
        let market_state = Keypair::new();
        let (market, create) = env.create_market_ix(
            &market_state,
            token,
            program,
            borsh::to_vec(&launch_params(admin)).unwrap(),
        );
        let (_, logs) = env.send_logged(&[create], &[&market_state]).unwrap();
        // The router calls `pipeline_init_market`, then `pipeline_market_info`.
        let init = strategy_units(&logs, 0);
        let info_in_create = strategy_units(&logs, 1);
        println!(
            "{label}: pipeline_init_market {init} CU, pipeline_market_info {info_in_create} CU"
        );
        assert!(init <= INIT_MARKET, "pipeline_init_market used {init}");
        assert!(info_in_create <= MARKET_INFO);

        if hook {
            // Seeding a hooked token runs its hook, whose compute is its own; the seed
            // through a hook is measured where the hook program is loaded.
            continue;
        }
        env.fund(&admin, &token, &program, TOKENS, LAMPORTS);
        let (_, logs) = env
            .send_logged(&[seed_ix(&market, &admin, TOKENS, LAMPORTS, vec![])], &[])
            .unwrap();
        let seed = strategy_units(&logs, 0);
        println!("{label}: seed {seed} CU");
        assert!(seed <= SEED, "seed used {seed}");

        let ix = strategy_call(
            client::interface::discriminator::MARKET_INFO,
            &(),
            vec![AccountMeta::new_readonly(market.market_state, false)],
        );
        let (_, logs) = env.simulate_logged(ix).unwrap();
        let info = strategy_units(&logs, 0);
        let (_, logs) = env
            .simulate_logged(strategy_call(
                client::interface::discriminator::RESOLVE_ACCOUNTS,
                &ResolveRequest {
                    trade: exact_in(1, 0, SOL),
                    round: 0,
                },
                env.read_accounts(&market, &exact_in(1, 0, SOL)),
            ))
            .unwrap();
        let resolve = strategy_units(&logs, 0);
        println!("{label}: pipeline_market_info {info} CU, pipeline_resolve_accounts {resolve} CU");
        assert!(info <= MARKET_INFO, "pipeline_market_info used {info}");
        assert!(
            resolve <= RESOLVE_ACCOUNTS,
            "pipeline_resolve_accounts used {resolve}"
        );
    }
}

/// The units the strategy's first invocation in `logs` used, less what any transfer-hook
/// program it called used: a hook's own compute is outside the ceilings
/// (docs/spec/pool4-for-solana.md, "Compute ceilings").
fn strategy_units_without_hooks(logs: &[String]) -> u64 {
    let hook = format!("Program {TEST_HOOK_PROGRAM} consumed ");
    let hooks: u64 = logs
        .iter()
        .filter_map(|line| line.strip_prefix(&hook))
        .filter_map(|rest| rest.split_whitespace().next()?.parse::<u64>().ok())
        .sum();
    strategy_units(logs, 0) - hooks
}

#[test]
fn quotes_and_one_step_swaps_stay_under_their_ceilings() {
    // Markets across the opening range and the token programs, each traded both ways at
    // sizes from dust to a large share of the pool, where the maths' divisions run longest.
    let markets: [(&str, Pubkey, bool, u64, u64); 5] = [
        (
            "SPL Token, the worked example",
            TOKEN,
            false,
            TOKENS,
            LAMPORTS,
        ),
        ("Token-2022", TOKEN_2022, false, TOKENS, LAMPORTS),
        (
            "Token-2022 with a transfer hook",
            TOKEN_2022,
            true,
            TOKENS,
            LAMPORTS,
        ),
        // A high price: 10^9 lamports a unit, near the top of the opening range.
        ("a high price", TOKEN, false, 10_000_000, 10_000_000 * SOL),
        // A low price: 10^-7 lamports a unit, a seed of u64::MAX / 2 units.
        ("a low price", TOKEN, false, u64::MAX / 2, 100 * SOL),
    ];
    let mut worst = (0, 0);
    for (label, program, hook, tokens, lamports) in markets {
        let mut env = Env::new();
        let admin = env.admin.pubkey();
        let market = if hook {
            let token = env.seedable_hooked_token();
            env.create_and_seed_hooked(token, &launch_params(admin), tokens, lamports)
                .unwrap()
        } else {
            let token = env.seedable_token(&program);
            env.create_and_seed(token, program, &launch_params(admin), tokens, lamports)
                .unwrap()
                .0
        };
        let trader = env.trader(&market, tokens, lamports);
        for (input, output, amount) in [
            (1, 0, 1_000),
            (1, 0, lamports / 1_000),
            (1, 0, lamports / 3),
            (0, 1, tokens / 1_000_000),
            (0, 1, tokens / 1_000),
            (0, 1, tokens / 3),
        ] {
            let Ok((_, logs)) = env.quote_logged(&market, &exact_in(input, output, amount)) else {
                continue;
            };
            let quote = strategy_units(&logs, 0);
            let (_, logs) = env
                .swap_logged(
                    &market,
                    &trader,
                    (input, output),
                    TradeMode::ExactIn,
                    amount,
                    0,
                )
                .unwrap();
            let swap = strategy_units_without_hooks(&logs);
            println!("{label}, {input}->{output} {amount}: pipeline_quote {quote} CU, pipeline_swap {swap} CU");
            assert!(quote <= QUOTE, "{label}: pipeline_quote used {quote}");
            assert!(swap <= SWAP_ONE_STEP, "{label}: pipeline_swap used {swap}");
            worst = (worst.0.max(quote), worst.1.max(swap));
        }
        let (_, logs) = env
            .simulate_logged(strategy_call(
                client::interface::discriminator::RESOLVE_ACCOUNTS,
                &ResolveRequest {
                    trade: exact_in(1, 0, SOL),
                    round: 0,
                },
                env.read_accounts(&market, &exact_in(1, 0, SOL)),
            ))
            .unwrap();
        let resolve = strategy_units(&logs, 0);
        assert!(
            resolve <= RESOLVE_ACCOUNTS,
            "{label}: pipeline_resolve_accounts used {resolve}"
        );
    }
    println!(
        "worst: pipeline_quote {} CU, pipeline_swap {} CU",
        worst.0, worst.1
    );
}

#[test]
fn pipeline_seed_liquidity_stays_under_its_ceiling() {
    // A launchpad's graduation creates the market, its two vaults and seeds it in one call,
    // measured inside the stand-in launchpad's CPI, the token's hook left out.
    let mut worst = 0;
    for (label, program, hook) in [
        ("SPL Token", TOKEN, false),
        ("Token-2022", TOKEN_2022, false),
        ("Token-2022 with a transfer hook", TOKEN_2022, true),
    ] {
        let mut env = Env::new();
        let token = if hook {
            env.seedable_hooked_token()
        } else {
            env.seedable_token(&program)
        };
        let launch = env.launch(token, program, TOKENS, LAMPORTS);
        let graduated = env
            .graduate(
                &launch,
                &launch_params(Pubkey::new_unique()),
                TOKENS,
                LAMPORTS,
            )
            .unwrap();
        let units = strategy_units_without_hooks(&graduated.logs);
        println!("{label}: pipeline_seed_liquidity {units} CU");
        assert!(
            units <= SEED_LIQUIDITY,
            "{label}: pipeline_seed_liquidity used {units}"
        );
        worst = worst.max(units);
    }
    println!("worst: pipeline_seed_liquidity {worst} CU");
}
