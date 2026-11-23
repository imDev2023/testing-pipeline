//! Compute ceilings (docs/spec/tax-amm.md, "Compute ceilings"; docs/spec/README.md, "Test
//! layers" 5), as `common/ceilings.rs` defines them once, mirroring the spec's table: a
//! ceiling changes only by a PR to the spec file and that table together, which
//! [`the_table_mirrors_the_spec`] checks. The invariant fuzzer (`tests/fuzz.rs`) holds every
//! instruction it calls to the same ceilings, on every market shape it builds.
//!
//! A cost is what the tax AMM's own invocation consumes, its token program calls included,
//! measured on mints without a transfer hook. Each test prints what it measured.

mod common;

use common::ceilings;
use common::*;
use pipeline_client::Pubkey;
use solana_signer::Signer;

/// Markets on plain mints of each token program, SPL Token's and Token-2022's.
fn markets() -> Vec<(&'static str, Env, Market)> {
    [("SPL Token", TOKEN), ("Token-2022", TOKEN_2022)]
        .into_iter()
        .map(|(name, token_program)| {
            let mut env = Env::new();
            let mints = [
                (env.create_mint(&token_program), token_program),
                (env.create_mint(&token_program), token_program),
            ];
            let market = env
                .create_tax_market(mints, &valid_params(&Pubkey::new_unique()))
                .unwrap();
            (name, env, market)
        })
        .collect()
}

#[test]
fn pipeline_init_market_stays_under_its_ceiling() {
    for (name, _, market) in markets() {
        // create_market calls the strategy twice: pipeline_init_market, then
        // pipeline_market_info.
        let costs = strategy_compute(&market.created.logs);
        assert_eq!(costs.len(), 2, "{:?}", market.created.logs);
        println!("pipeline_init_market on {name} mints: {} CU", costs[0]);
        assert!(
            costs[0] <= ceilings::PIPELINE_INIT_MARKET,
            "{name}: {}",
            costs[0]
        );
    }
}

#[test]
fn creating_a_contained_mints_market_stays_under_its_ceiling() {
    // Checking a contained mint's hook authority derives its unlock PDA; the search beyond
    // the first bump is the address's, not the program's, and the ceiling leaves it out.
    for k in 0..8u8 {
        let mut env = Env::new();
        let contained =
            env.create_contained_mint_at(&solana_keypair::Keypair::new_from_array([k + 1; 32]));
        let quote = env.create_mint(&TOKEN);
        let params = quote_taxed_params(&Pubkey::new_unique(), 1);
        let market = env
            .create_tax_market([(contained, TOKEN_2022), (quote, TOKEN)], &params)
            .unwrap();
        let cost = strategy_compute(&market.created.logs)[0];
        let search = ceilings::unlock_bump_search(&env, &contained);
        println!("pipeline_init_market with a contained mint: {cost} CU, {search} of them beyond the first bump");
        assert!(
            cost - search <= ceilings::PIPELINE_INIT_MARKET,
            "{cost} - {search}"
        );
    }
}

#[test]
fn pipeline_market_info_stays_under_its_ceiling() {
    for (name, env, market) in markets() {
        let in_creation = strategy_compute(&market.created.logs)[1];
        let meta = env.market_info_meta(&market.market_state).unwrap();
        let direct = strategy_compute(&meta.logs)[0];
        println!("pipeline_market_info on {name} mints: {in_creation} CU in create_market, {direct} CU called directly");
        assert!(
            in_creation <= ceilings::PIPELINE_MARKET_INFO,
            "{name}: {in_creation}"
        );
        assert!(direct <= ceilings::PIPELINE_MARKET_INFO, "{name}: {direct}");
    }
}

#[test]
fn pipeline_resolve_accounts_stays_under_its_ceiling() {
    for (name, env, market) in markets() {
        for (input, output) in [(0, 1), (1, 0)] {
            let meta = env
                .resolve_meta(&market, &exact_in(input, output, 1_000_000))
                .unwrap();
            let cost = strategy_compute(&meta.logs)[0];
            println!("pipeline_resolve_accounts {input}->{output} on {name} mints: {cost} CU");
            assert!(
                cost <= ceilings::PIPELINE_RESOLVE_ACCOUNTS,
                "{name}: {cost}"
            );
        }
    }
}

/// Seeded markets on plain mints of each token program, with the seed's metadata, taxed
/// on side 1 at typical rates.
fn seeded_markets() -> Vec<(
    &'static str,
    Env,
    Market,
    litesvm::types::TransactionMetadata,
)> {
    [("SPL Token", TOKEN), ("Token-2022", TOKEN_2022)]
        .into_iter()
        .map(|(name, token_program)| {
            let mut env = Env::new();
            let mints = [
                (env.create_mint(&token_program), token_program),
                (env.create_mint(&token_program), token_program),
            ];
            let seeder = solana_keypair::Keypair::new();
            let market = env
                .create_tax_market(mints, &valid_params(&seeder.pubkey()))
                .unwrap();
            let amounts = [100_000_000_000, 200_000_000_000];
            env.fund(&seeder.pubkey(), &market, amounts);
            let seeded = env.seed(&market, &seeder, amounts).unwrap();
            (name, env, market, seeded)
        })
        .collect()
}

#[test]
fn seed_stays_under_its_ceiling() {
    for (name, _, _, seeded) in seeded_markets() {
        let costs = strategy_compute(&seeded.logs);
        assert_eq!(costs.len(), 1);
        println!("seed on {name} mints: {} CU", costs[0]);
        assert!(costs[0] <= ceilings::SEED, "{name}: {}", costs[0]);
    }
}

/// The tax authority's three actions on a market that has traded, each measured as the tax
/// authority sends it: `set_taxes`; `set_recipients` from one recipient to four (the most
/// shares checked), then back to one (the most emptied slots checked for owed tax); and
/// `renounce_tax_authority`.
#[test]
fn the_tax_authority_actions_stay_under_their_ceilings() {
    use common::authority::*;
    use solana_keypair::Keypair;
    for (mints_name, token_program) in [("SPL Token", TOKEN), ("Token-2022", TOKEN_2022)] {
        let mut env = Env::new();
        let authority = Keypair::new();
        let mints = [
            (env.create_mint(&token_program), token_program),
            (env.create_mint(&token_program), token_program),
        ];
        // One tax recipient, so only slot 0, the burn and the suite share are owed tax.
        let mut params = tax_amm::InitParams {
            tax_authority: ak(&authority.pubkey()),
            ..valid_params(&Pubkey::new_unique())
        };
        params.recipients[1] = anchor_lang::prelude::Pubkey::default();
        params.shares = [9_000, 0, 0, 0];
        let market = env.seeded_market(mints, &params, [100_000_000_000, 200_000_000_000]);
        let trader = env.funded_wallet(&market, 10_000_000_000_000);
        env.swap(&market, &trader, (1, 0), 1_000_000_000).unwrap();
        let state = &market.market_state;
        let first = ck(&params.recipients[0]);
        let four = Split {
            recipients: [
                first,
                Pubkey::new_unique(),
                Pubkey::new_unique(),
                Pubkey::new_unique(),
            ],
            shares: [2_500, 2_500, 2_000, 2_000],
            burn_share_bps: 1_000,
        };
        let one = Split {
            recipients: [
                first,
                Pubkey::default(),
                Pubkey::default(),
                Pubkey::default(),
            ],
            shares: [10_000, 0, 0, 0],
            burn_share_bps: 0,
        };
        let actions = [
            (
                "set_taxes",
                set_taxes_instruction(state, &authority.pubkey(), 800, 0),
                ceilings::SET_TAXES,
            ),
            (
                "set_recipients to four",
                set_recipients_instruction(state, &authority.pubkey(), &four),
                ceilings::SET_RECIPIENTS,
            ),
            (
                "set_recipients back to one",
                set_recipients_instruction(state, &authority.pubkey(), &one),
                ceilings::SET_RECIPIENTS,
            ),
            (
                "renounce_tax_authority",
                renounce_instruction(state, &authority.pubkey()),
                ceilings::RENOUNCE_TAX_AUTHORITY,
            ),
        ];
        for (name, instruction, ceiling) in actions {
            let meta = env.send_signed(instruction, &authority).unwrap();
            let costs = strategy_compute(&meta.logs);
            assert_eq!(costs.len(), 1);
            println!("{name} on a market of {mints_name} mints: {} CU", costs[0]);
            assert!(costs[0] <= ceiling, "{name}: {}", costs[0]);
        }
    }
}

#[test]
fn pipeline_seed_liquidity_stays_under_its_ceiling() {
    for (name, token_program) in [("SPL Token", TOKEN), ("Token-2022", TOKEN_2022)] {
        let mut env = Env::new();
        let mints = [
            (env.create_mint(&token_program), token_program),
            (env.create_mint(&token_program), token_program),
        ];
        let amounts = [100_000_000_000, 200_000_000_000];
        let launch = env.launch(mints, amounts);
        let graduated = env
            .graduate(&launch, &valid_params(&Pubkey::new_unique()), amounts)
            .unwrap();
        // The launchpad calls pipeline_seed_liquidity, then register_existing_market calls
        // pipeline_market_info.
        let costs = strategy_compute(&graduated.market.created.logs);
        assert_eq!(costs.len(), 2, "{:?}", graduated.market.created.logs);
        println!("pipeline_seed_liquidity on {name} mints: {} CU", costs[0]);
        assert!(
            costs[0] <= ceilings::PIPELINE_SEED_LIQUIDITY,
            "{name}: {}",
            costs[0]
        );
    }
}

#[test]
fn pipeline_quote_stays_under_its_ceiling() {
    for (name, env, market, _) in seeded_markets() {
        for (input, output) in [(0, 1), (1, 0)] {
            let trade = exact_in(input, output, 1_000_000_000);
            let mut accounts = env.read_accounts(&market, &trade);
            accounts.extend(
                env.resolve_accounts(&market, &trade)
                    .unwrap()
                    .into_iter()
                    .map(|a| pipeline_client::AccountMeta::new_readonly(a.pubkey, false)),
            );
            let call = strategy_call(
                pipeline_client::interface::discriminator::QUOTE,
                &trade,
                accounts,
            );
            let cost = strategy_compute(&env.simulate_meta(call).unwrap().logs)[0];
            println!("pipeline_quote {input}->{output} on {name} mints: {cost} CU");
            assert!(cost <= ceilings::PIPELINE_QUOTE, "{name}: {cost}");
        }
    }
}

#[test]
fn pipeline_swap_stays_under_its_ceiling() {
    for (name, mut env, market, _) in seeded_markets() {
        let trader = env.funded_wallet(&market, 1_000_000_000_000);
        for (input, output) in [(0, 1), (1, 0)] {
            let meta = env
                .swap_with(
                    &market,
                    &trader,
                    (input, output),
                    1_000_000_000,
                    &SwapOptions::default(),
                )
                .unwrap();
            let costs = strategy_compute(&meta.logs);
            assert_eq!(costs.len(), 1);
            println!(
                "pipeline_swap {input}->{output} on {name} mints: {} CU, the whole router swap {} CU",
                costs[0], meta.compute_units_consumed
            );
            assert!(costs[0] <= ceilings::PIPELINE_SWAP, "{name}: {}", costs[0]);
        }
    }
}

#[test]
fn a_swap_calls_a_transfer_hook_inside_it_as_the_input_and_as_the_output() {
    // docs/spec/README.md, "Test layers" 5: router (1) -> tax AMM (2) -> Token-2022 (3) ->
    // transfer hook (4) is the deepest call a swap makes, when the hooked mint is the
    // output; as the input, the router's own transfers call the hook at depth 3. The hook is
    // the containment hook, the only one a market's mint may run, in its home market.
    for hooked_side in [0usize, 1] {
        let mut env = Env::new();
        let market = env.contained_market(hooked_side, [100_000_000_000, 200_000_000_000]);
        let trader = env.funded_wallet(&market, 1_000_000_000_000);
        let hook = containment_hook_id();
        for (input, output) in [(0, 1), (1, 0)] {
            let quote = env
                .quote(&market, &exact_in(input, output, 1_000_000_000))
                .unwrap();
            let meta = env
                .swap_with(
                    &market,
                    &trader,
                    (input, output),
                    1_000_000_000,
                    &SwapOptions::default(),
                )
                .unwrap();
            let depths: Vec<u32> = meta
                .logs
                .iter()
                .filter_map(|line| line.strip_prefix(&format!("Program {hook} invoke [")))
                .map(|rest| rest.trim_end_matches(']').parse().unwrap())
                .collect();
            let as_output = output == hooked_side;
            println!(
                "hooked mint as the {}: hook called at depths {depths:?}, {} CU in all",
                if as_output { "output" } else { "input" },
                meta.compute_units_consumed
            );
            if as_output {
                assert_eq!(
                    depths,
                    vec![4],
                    "once, inside the tax AMM's output transfer"
                );
            } else {
                // The trader's input to the vault, then Pipeline's fee.
                assert_eq!(depths, vec![3, 3], "in the router's two transfers");
            }
            let result: pipeline_client::SwapResult =
                borsh::from_slice(&meta.return_data.data).unwrap();
            assert_eq!(result.received, quote.amount_out);
        }
    }
}

#[test]
fn distribute_stays_under_its_ceiling_when_it_creates_the_token_account_and_when_it_burns() {
    use tax_amm::state::{BURN_SLOT, SUITE_SLOT};
    for (name, mut env, market, _) in seeded_markets() {
        let trader = env.funded_wallet(&market, 1_000_000_000_000);
        env.swap(&market, &trader, (1, 0), 10_000_000_000).unwrap();
        env.swap(&market, &trader, (0, 1), 5_000_000_000).unwrap();
        // `fund` writes balances without minting them; the burn needs a supply behind them.
        let supply = 10_000_000_000_000;
        env.set_supply(&market.mints[1], supply);
        let caller = solana_keypair::Keypair::new();
        env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
        let cases = [
            (0, "paying a tax recipient, creating its token account"),
            (BURN_SLOT, "burning"),
            (
                SUITE_SLOT,
                "paying the suite share, creating its token account",
            ),
        ];
        for (slot, what) in cases {
            let cost = distribute_cost(&mut env, &market, &caller, slot);
            println!("distribute {what} on {name} mints: {cost} CU");
            assert!(cost <= ceilings::DISTRIBUTE, "{name}, {what}: {cost}");
        }
        // Into a token account that already exists, after more tax is booked.
        env.swap(&market, &trader, (1, 0), 10_000_000_000).unwrap();
        let cost = distribute_cost(&mut env, &market, &caller, 0);
        println!(
            "distribute paying a tax recipient's existing token account on {name} mints: {cost} CU"
        );
        assert!(cost <= ceilings::DISTRIBUTE, "{name}: {cost}");
    }
}

/// `distribute` for `slot`, and its compute less what finding the slot wallet's associated
/// token account costs beyond its first bump, which the ceiling leaves out
/// ([`ceilings::distribute_bump_search`]).
fn distribute_cost(
    env: &mut Env,
    market: &Market,
    caller: &solana_keypair::Keypair,
    slot: u8,
) -> u64 {
    let search = ceilings::distribute_bump_search(env, market, slot);
    let meta = env.distribute(market, caller, slot).unwrap();
    let costs = strategy_compute(&meta.logs);
    assert_eq!(costs.len(), 1);
    costs[0] - search
}

#[test]
fn the_table_mirrors_the_spec() {
    let spec = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/spec/tax-amm.md"),
    )
    .unwrap();
    let table: String = spec
        .split("### Compute ceilings")
        .nth(1)
        .and_then(|rest| rest.split("\n### ").next())
        .expect("the spec's compute ceilings section")
        .to_string();
    // A row naming several instructions gives one ceiling for "each".
    let row = |instructions: &str, ceiling: u64| {
        let each = if instructions.contains(", ") {
            " each"
        } else {
            ""
        };
        let cells = format!("| {instructions} | {}{each} |", format_cu(ceiling));
        assert!(
            table.contains(&cells),
            "the spec's table has no row {cells}"
        );
    };
    use ceilings::*;
    row("`pipeline_quote`", PIPELINE_QUOTE);
    row("`pipeline_swap`", PIPELINE_SWAP);
    const { assert!(PIPELINE_MARKET_INFO == PIPELINE_RESOLVE_ACCOUNTS) };
    row(
        "`pipeline_market_info`, `pipeline_resolve_accounts`",
        PIPELINE_MARKET_INFO,
    );
    row("`pipeline_init_market`", PIPELINE_INIT_MARKET);
    row("`pipeline_seed_liquidity`", PIPELINE_SEED_LIQUIDITY);
    row("`seed`", SEED);
    row("`distribute`", DISTRIBUTE);
    const { assert!(SET_TAXES == SET_RECIPIENTS && SET_RECIPIENTS == RENOUNCE_TAX_AUTHORITY) };
    row(
        "`set_taxes`, `set_recipients`, `renounce_tax_authority`",
        SET_TAXES,
    );
}

#[test]
fn every_instruction_of_the_program_has_a_ceiling() {
    let idl: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("idl/tax_amm.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let mut instructions: Vec<&str> = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|instruction| instruction["name"].as_str().unwrap())
        .collect();
    let mut table: Vec<&str> = ceilings::ALL.iter().map(|(name, _)| *name).collect();
    instructions.sort_unstable();
    table.sort_unstable();
    assert_eq!(table, instructions, "the ceiling table against the IDL");
}

/// `120000` as the spec writes it, `120,000`.
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
