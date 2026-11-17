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
/// The spec's ceiling for a swap that crosses into the wall and trims.
const SWAP_TRIM: u64 = 60_000;
const SEED_LIQUIDITY: u64 = 180_000;
const PLACE_WALL: u64 = 50_000;
const SETTLE: u64 = 30_000;
const PAY_REWARDS: u64 = 60_000;
const SWEEP_FEES: u64 = 60_000;
const HANDOVER: u64 = 10_000;

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
fn swaps_that_lower_the_cap_or_trim_stay_under_their_ceilings() {
    use buy_wall_amm::events::{CapLowered, Trimmed};
    // The same markets: an hour after the seed a buy of a third of the pool's SOL lowers the
    // cap, and a minute later a sell of more than it bought is trimmed.
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
        ("a high price", TOKEN, false, 10_000_000, 10_000_000 * SOL),
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
        let trader = env.trader(&market, tokens / 2, lamports);
        let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
        env.set_clock(clock.slot + 9_000, clock.unix_timestamp + 3_600);
        let (bought, logs) = env
            .swap_logged(
                &market,
                &trader,
                (1, 0),
                TradeMode::ExactIn,
                lamports / 3,
                0,
            )
            .unwrap();
        assert_eq!(
            events::<CapLowered>(&logs).len(),
            1,
            "{label}: the buy lowers the cap"
        );
        let lowering = strategy_units_without_hooks(&logs);

        let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
        env.set_clock(clock.slot + 150, clock.unix_timestamp + 60);
        let sell = bought.received + tokens / 100;
        let (_, logs) = env
            .swap_logged(&market, &trader, (0, 1), TradeMode::ExactIn, sell, 0)
            .unwrap();
        assert_eq!(events::<Trimmed>(&logs).len(), 1, "{label}: the sell trims");
        let trimming = strategy_units_without_hooks(&logs);
        println!("{label}: a buy lowering the cap {lowering} CU, a sell trimming {trimming} CU");
        assert!(
            lowering <= SWAP_ONE_STEP,
            "{label}: a buy lowering the cap used {lowering}"
        );
        assert!(
            trimming <= SWAP_TRIM,
            "{label}: a sell trimming used {trimming}"
        );
        worst = (worst.0.max(lowering), worst.1.max(trimming));
    }
    println!(
        "worst: a buy lowering the cap {} CU, a sell trimming {} CU",
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

#[test]
fn place_wall_and_swaps_that_cross_into_the_wall_and_trim_stay_under_their_ceilings() {
    use buy_wall_amm::events::{Trimmed, WallPlaced};
    // The same markets: an hour after the seed a buy and a sell back that trims leave SOL
    // idle; `place_wall` places it at the price; a buy lifts the price above the wall's top
    // and a sell of more than it bought crosses back into the wall and trims; then
    // `place_wall` again closes a wall that has bought tokens.
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
        ("a high price", TOKEN, false, 10_000_000, 10_000_000 * SOL),
        ("a low price", TOKEN, false, u64::MAX / 2, 100 * SOL),
    ];
    let mut worst = (0, 0, 0);
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
        let trader = env.trader(&market, tokens / 2, lamports);
        let keeper = env.keeper();
        let later = |env: &mut Env, seconds: i64| {
            let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
            env.set_clock(clock.slot + 150, clock.unix_timestamp + seconds);
        };
        let swap = |env: &mut Env, direction: (usize, usize), amount: u64| {
            env.swap_logged(&market, &trader, direction, TradeMode::ExactIn, amount, 0)
                .unwrap()
        };
        later(&mut env, 3_600);
        let (bought, _) = swap(&mut env, (1, 0), lamports / 3);
        later(&mut env, 60);
        swap(&mut env, (0, 1), bought.received + tokens / 100);

        env.next_slot();
        let (_, logs) = env.place_wall(&market, &keeper).unwrap();
        assert_eq!(events::<WallPlaced>(&logs).len(), 1);
        let placing = strategy_units(&logs, 0);
        let top = env.state(&market).wall_top();

        later(&mut env, 60);
        let (bought, _) = swap(&mut env, (1, 0), lamports / 3);
        assert!(env.state(&market).sqrt_price() > top);
        later(&mut env, 60);
        let sell = bought.received + tokens / 100;
        let (_, logs) = env.quote_logged(&market, &exact_in(0, 1, sell)).unwrap();
        let quote = strategy_units(&logs, 0);
        let (_, logs) = swap(&mut env, (0, 1), sell);
        assert!(
            env.state(&market).sqrt_price() < top,
            "{label}: the sell crosses into the wall"
        );
        assert_eq!(events::<Trimmed>(&logs).len(), 1, "{label}: the sell trims");
        let crossing = strategy_units_without_hooks(&logs);

        env.next_slot();
        let (_, logs) = env.place_wall(&market, &keeper).unwrap();
        let [placed] = events::<WallPlaced>(&logs).try_into().unwrap();
        assert!(
            placed.closed_tokens > 0,
            "{label}: the old wall had bought tokens"
        );
        let replacing = strategy_units(&logs, 0);
        println!(
            "{label}: place_wall {placing} CU, again {replacing} CU; \
             a sell crossing into the wall and trimming {crossing} CU, quoted in {quote} CU"
        );
        assert!(
            placing.max(replacing) <= PLACE_WALL,
            "{label}: place_wall used {placing}, {replacing}"
        );
        assert!(
            crossing <= SWAP_TRIM,
            "{label}: a sell crossing and trimming used {crossing}"
        );
        assert!(quote <= QUOTE, "{label}: pipeline_quote used {quote}");
        worst = (
            worst.0.max(placing.max(replacing)),
            worst.1.max(crossing),
            worst.2.max(quote),
        );
    }
    println!(
        "worst: place_wall {} CU, a sell crossing into the wall and trimming {} CU, pipeline_quote {} CU",
        worst.0, worst.1, worst.2
    );
}

#[test]
fn payouts_and_handovers_stay_under_their_ceilings() {
    use common::payouts::*;
    // On each token program, the worked example's trades leave tokens retired and every fee
    // ledger owed; `settle`, then `pay_rewards` and each `sweep_fees` slot into recipient
    // accounts the payouts create, then the same again into accounts that exist, then both
    // handovers.
    let mut worst = [0u64; 4];
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
        // Recipients whose accounts have bump 255, so the address search a payout makes is
        // the same on every run (`recipient_with_first_bump`).
        let fee_recipient = recipient_with_first_bump(&WSOL, &TOKEN);
        let rewards_recipient = recipient_with_first_bump(&token, &program);
        let mut params = launch_params(env.admin.pubkey());
        params.fee_recipient = fee_recipient.pubkey();
        params.rewards_recipient = rewards_recipient.pubkey();
        let market = if hook {
            env.create_and_seed_hooked(token, &params, TOKENS, LAMPORTS)
                .unwrap()
        } else {
            env.create_and_seed(token, program, &params, TOKENS, LAMPORTS)
                .unwrap()
                .0
        };
        set_supply(&mut env, &market.token_mint, u64::MAX / 2);
        let trader = env.trader(&market, TOKENS / 2, LAMPORTS);
        let keeper = env.keeper();
        let cycle = |env: &mut Env| {
            let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
            env.set_clock(clock.slot + 150, clock.unix_timestamp + 3_600);
            let (bought, _) = env
                .swap_logged(&market, &trader, (1, 0), TradeMode::ExactIn, SOL, 0)
                .unwrap();
            env.swap_logged(
                &market,
                &trader,
                (0, 1),
                TradeMode::ExactIn,
                bought.received,
                0,
            )
            .unwrap();
            env.next_slot();
            let _ = env.place_wall(&market, &keeper);
            let (_, logs) = env.send_logged(&[settle_ix(&market)], &[]).unwrap();
            let settling = strategy_units(&logs, 0);

            let recipient = rewards_recipient.pubkey();
            let to = client::pda::associated_token(&recipient, &market.token_mint, &program);
            let hooks = env.hook_accounts(
                &market.token_mint,
                market.token_vault,
                to,
                market.vault_authority,
            );
            let ix = pay_rewards_ix(&market, &env.admin.pubkey(), &recipient, hooks);
            let (_, logs) = env.send_logged(&[ix], &[]).unwrap();
            let paying = strategy_units_without_hooks(&logs);

            let mut sweeping = 0;
            for (slot, wallet) in [
                (0, fee_recipient.pubkey()),
                (2, buy_wall_amm::config::SUITE_TREASURY.to_bytes().into()),
            ] {
                let ix = sweep_fees_ix(&market, &env.admin.pubkey(), &wallet, slot);
                let (_, logs) = env.send_logged(&[ix], &[]).unwrap();
                sweeping = sweeping.max(strategy_units(&logs, 0));
            }
            (settling, paying, sweeping)
        };
        let (settle_new, pay_new, sweep_new) = cycle(&mut env);
        let (settle_again, pay_existing, sweep_existing) = cycle(&mut env);

        let mut handing = 0;
        for (rewards, signer) in [(false, &fee_recipient), (true, &rewards_recipient)] {
            let ix = handover_ix(&market, rewards, &signer.pubkey(), &Pubkey::new_unique());
            let (_, logs) = env.send_logged(&[ix], &[signer]).unwrap();
            handing = handing.max(strategy_units(&logs, 0));
        }
        println!(
            "{label}: settle {settle_new}, {settle_again} CU; pay_rewards creating the account \
             {pay_new} CU, into it {pay_existing} CU; sweep_fees creating the account \
             {sweep_new} CU, into it {sweep_existing} CU; a handover {handing} CU"
        );
        let settling = settle_new.max(settle_again);
        let paying = pay_new.max(pay_existing);
        let sweeping = sweep_new.max(sweep_existing);
        assert!(settling <= SETTLE, "{label}: settle used {settling}");
        assert!(paying <= PAY_REWARDS, "{label}: pay_rewards used {paying}");
        assert!(
            sweeping <= SWEEP_FEES,
            "{label}: sweep_fees used {sweeping}"
        );
        assert!(handing <= HANDOVER, "{label}: a handover used {handing}");
        worst = [
            worst[0].max(settling),
            worst[1].max(paying),
            worst[2].max(sweeping),
            worst[3].max(handing),
        ];
    }
    println!(
        "worst: settle {} CU, pay_rewards {} CU, sweep_fees {} CU, a handover {} CU",
        worst[0], worst[1], worst[2], worst[3]
    );
}
