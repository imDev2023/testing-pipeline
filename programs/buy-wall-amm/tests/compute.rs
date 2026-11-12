//! Compute ceilings, asserted per instruction (docs/spec/README.md, "Test layers" 5;
//! docs/spec/pool4-for-solana.md, "Compute ceilings"). This module mirrors the spec's table
//! for the instructions built so far; a ceiling may be lowered to what is measured plus
//! headroom, and raising one needs a reason written into the spec.
//!
//! What is measured is the strategy's own invocation, its token program calls included,
//! from the runtime's "consumed" log lines.

mod common;

use common::*;
use pipeline_client::{self as client, AccountMeta};
use solana_keypair::Keypair;
use solana_signer::Signer;

const INIT_MARKET: u64 = 120_000;
const SEED: u64 = 80_000;
const MARKET_INFO: u64 = 10_000;
const RESOLVE_ACCOUNTS: u64 = 10_000;

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
