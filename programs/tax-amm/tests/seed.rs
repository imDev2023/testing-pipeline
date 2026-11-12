//! The seed (docs/spec/tax-amm.md, "The seed"): the seeder funds a tax market once, before
//! any swap, and the market records what arrived and opens.

mod common;

use common::*;
use pipeline_client::pda;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::events::Seeded;
use tax_amm::state::MarketStatus;
use tax_amm::StrategyError;

/// A created market, not yet seeded, whose seeder holds 1,000,000 of mint 0 and 2,000,000
/// of mint 1.
fn unseeded(params: impl FnOnce(&mut tax_amm::InitParams)) -> (Env, Market, Keypair) {
    let mut env = Env::new();
    let seeder = Keypair::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
    ];
    let mut p = valid_params(&seeder.pubkey());
    params(&mut p);
    let market = env.create_tax_market(mints, &p).unwrap();
    env.fund(&seeder.pubkey(), &market, [1_000_000, 2_000_000]);
    (env, market, seeder)
}

#[test]
fn the_seeder_seeds_and_the_market_records_what_arrived_and_opens() {
    let (mut env, market, seeder) = unseeded(|_| {});
    let meta = env.seed(&market, &seeder, [600_000, 1_500_000]).unwrap();

    let state = env.tax_market(&market.market_state);
    assert_eq!(state.status, MarketStatus::Open);
    assert_eq!(state.reserves, [600_000, 1_500_000]);
    assert_eq!(env.balance(&market.vaults[0]), 600_000);
    assert_eq!(env.balance(&market.vaults[1]), 1_500_000);
    let source = |i: usize| {
        pda::associated_token(
            &seeder.pubkey(),
            &market.mints[i],
            &market.token_programs[i],
        )
    };
    assert_eq!(env.balance(&source(0)), 400_000);
    assert_eq!(env.balance(&source(1)), 500_000);
    // Nothing is owed and nothing counted: only swaps book tax and move the counters.
    assert_eq!(state.owed, [0; tax_amm::state::OWED_SLOTS]);
    assert_eq!(
        (state.tax_collected, state.volume, state.swap_count),
        (0, [0, 0], 0)
    );

    let events: Vec<Seeded> = strategy_events(&meta.logs);
    assert_eq!(
        events,
        vec![Seeded {
            market_state: ak(&market.market_state),
            seeder: ak(&seeder.pubkey()),
            amounts: [600_000, 1_500_000],
        }]
    );
}

#[test]
fn tokens_already_in_a_vault_before_the_seed_are_not_counted() {
    let (mut env, market, seeder) = unseeded(|_| {});
    // Someone sends tokens straight to both vaults first.
    for i in 0..2 {
        write_token_account_at(&mut env, &market, i, 77_777);
    }
    env.seed(&market, &seeder, [600_000, 1_500_000]).unwrap();
    assert_eq!(
        env.tax_market(&market.market_state).reserves,
        [600_000, 1_500_000]
    );
    assert_eq!(env.balance(&market.vaults[0]), 677_777);
}

/// Sets vault `i`'s balance to `amount`, as a transfer straight to it would.
fn write_token_account_at(env: &mut Env, market: &Market, i: usize, amount: u64) {
    let mut account = env.svm.get_account(&market.vaults[i]).unwrap();
    account.data[64..72].copy_from_slice(&amount.to_le_bytes());
    env.svm.set_account(market.vaults[i], account).unwrap();
}

#[test]
fn the_seed_is_refused_from_anyone_but_the_seeder() {
    let (mut env, market, _) = unseeded(|_| {});
    let stranger = Keypair::new();
    env.fund(&stranger.pubkey(), &market, [1_000_000, 2_000_000]);
    assert_refused(
        env.seed(&market, &stranger, [600_000, 1_500_000]),
        StrategyError::NotSeeder,
    );
    // Nor can anyone sign for the seeder: without the seeder's signature it is no seed.
    let mut unsigned = seed_instruction(&market, &stranger.pubkey(), [1, 1], vec![]);
    let seeder = ck(&env.tax_market(&market.market_state).seeder);
    unsigned.accounts[0] = pipeline_client::AccountMeta::new_readonly(seeder, false);
    let failure = env.send(&[unsigned], &[]).unwrap_err();
    assert!(failure.contains("Custom(3010)"), "{failure}");
    assert_eq!(
        env.tax_market(&market.market_state).status,
        MarketStatus::Created
    );
}

#[test]
fn the_seed_is_refused_a_second_time() {
    let (mut env, market, seeder) = unseeded(|_| {});
    env.seed(&market, &seeder, [600_000, 1_500_000]).unwrap();
    assert_refused(
        env.seed(&market, &seeder, [1, 1]),
        StrategyError::AlreadySeeded,
    );
    assert_eq!(
        env.tax_market(&market.market_state).reserves,
        [600_000, 1_500_000]
    );
}

#[test]
fn a_zero_seed_is_refused_on_a_side_without_a_virtual_reserve() {
    // No virtual reserve: neither side may be empty.
    for amounts in [[0, 1_500_000], [600_000, 0], [0, 0]] {
        let (mut env, market, seeder) = unseeded(|_| {});
        assert_refused(env.seed(&market, &seeder, amounts), StrategyError::ZeroSeed);
    }
    // A virtual reserve on side 1: side 0 still needs a seed.
    let (mut env, market, seeder) = unseeded(|p| {
        p.virtual_side = 1;
        p.virtual_reserve = 5_000_000;
    });
    assert_refused(
        env.seed(&market, &seeder, [0, 1_500_000]),
        StrategyError::ZeroSeed,
    );
    // A virtual side named but no virtual reserve: it needs a seed too.
    let (mut env, market, seeder) = unseeded(|p| p.virtual_side = 1);
    assert_refused(
        env.seed(&market, &seeder, [600_000, 0]),
        StrategyError::ZeroSeed,
    );
}

#[test]
fn a_single_sided_seed_works_on_a_market_with_a_virtual_reserve() {
    for virtual_side in [0u8, 1] {
        let (mut env, market, seeder) = unseeded(|p| {
            p.virtual_side = virtual_side;
            p.virtual_reserve = 5_000_000;
        });
        let mut amounts = [600_000, 1_500_000];
        amounts[virtual_side as usize] = 0;
        let meta = env.seed(&market, &seeder, amounts).unwrap();
        let state = env.tax_market(&market.market_state);
        assert_eq!(state.status, MarketStatus::Open);
        assert_eq!(state.reserves, amounts);
        assert_eq!(state.virtual_reserve, 5_000_000);
        assert_eq!(strategy_events::<Seeded>(&meta.logs)[0].amounts, amounts);
    }
}

/// The legacy wire size of a transaction: its signatures, then its message.
fn wire_size(transaction: &solana_transaction::Transaction) -> usize {
    1 + 64 * transaction.signatures.len() + transaction.message.serialize().len()
}

#[test]
fn the_creation_transaction_seeds_the_market_it_creates() {
    // docs/spec/tax-amm.md, "Creating a market": create_market, init_fee_account for each
    // mint and the seed, in one transaction, the market open as it lands. The creator seeds
    // it, as Aviary's launch form has the creator's wallet do. Prints its size, against a
    // transaction's 1,232 bytes, for each kind of mint pair.
    const MAX_TRANSACTION_BYTES: usize = 1_232;
    for (what, kinds) in [
        ("two SPL Token mints", [0, 0]),
        ("two Token-2022 mints", [1, 1]),
        ("an SPL Token and a Token-2022 mint", [0, 1]),
        ("an SPL Token mint and a hooked mint", [0, 2]),
    ] {
        let mut env = Env::new();
        let mints = kinds.map(|kind| match kind {
            0 => (env.create_mint(&TOKEN), TOKEN),
            1 => (env.create_mint(&TOKEN_2022), TOKEN_2022),
            _ => (env.create_hooked_mint(), TOKEN_2022),
        });
        let state = Keypair::new();
        let mint_keys = mints.map(|(mint, _)| mint);
        let token_programs = mints.map(|(_, program)| program);
        let (authority, vaults) = tax_market_addresses(&state.pubkey(), mint_keys);
        let market = Market {
            market: pda::market(&strategy_id(), &state.pubkey()),
            market_state: state.pubkey(),
            authority,
            mints: mint_keys,
            token_programs,
            vaults,
            created: Default::default(),
        };
        let creator = env.admin.pubkey();
        env.fund(&creator, &market, [1_000_000, 2_000_000]);
        let mut instructions = vec![create_market_instruction(
            &creator,
            &state.pubkey(),
            true,
            init_data(&valid_params(&creator)),
            init_accounts(&state.pubkey(), mint_keys, token_programs),
        )];
        for i in 0..2 {
            instructions.push(pipeline_client::init_fee_account(
                &creator,
                &market.market,
                &mint_keys[i],
                &token_programs[i],
            ));
        }
        let hooks: Vec<_> = (0..2)
            .flat_map(|i| {
                let source = pda::associated_token(&creator, &mint_keys[i], &token_programs[i]);
                env.hook_accounts(&mint_keys[i], source, vaults[i], creator)
            })
            .collect();
        instructions.push(seed_instruction(
            &market,
            &creator,
            [600_000, 1_500_000],
            hooks,
        ));
        let transaction = solana_transaction::Transaction::new_signed_with_payer(
            &instructions,
            Some(&creator),
            &[&env.admin, &state],
            env.svm.latest_blockhash(),
        );
        let size = wire_size(&transaction);
        println!("the creation transaction on {what}: {size} of {MAX_TRANSACTION_BYTES} bytes");
        // Mints of one token program fit without an address lookup table; a mixed pair or a
        // hooked mint does not (docs/spec/tax-amm.md, "Not measured yet").
        if kinds[0] == kinds[1] {
            assert!(size <= MAX_TRANSACTION_BYTES, "{what}: {size}");
        }
        env.send(&instructions, &[&state]).unwrap();
        let state = env.tax_market(&market.market_state);
        assert_eq!(state.status, MarketStatus::Open);
        assert_eq!(state.reserves, [600_000, 1_500_000]);
    }
}

#[test]
fn the_seed_is_refused_from_a_token_account_the_seeder_only_holds_a_delegation_on() {
    // docs/spec/tax-amm.md, "The seed": from token accounts the seeder owns. A wallet that
    // once approved the seeder as its delegate must not find its tokens locked in a market.
    let (mut env, market, seeder) = unseeded(|_| {});
    let other = Keypair::new();
    env.fund(&other.pubkey(), &market, [1_000_000, 2_000_000]);
    let theirs = |i: usize| {
        pda::associated_token(&other.pubkey(), &market.mints[i], &market.token_programs[i])
    };
    for i in 0..2 {
        // SPL Token's and Token-2022's `Approve`: tag 4, then the amount.
        let mut data = vec![4u8];
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        let approve = pipeline_client::Instruction::new_with_bytes(
            market.token_programs[i],
            &data,
            vec![
                pipeline_client::AccountMeta::new(theirs(i), false),
                pipeline_client::AccountMeta::new_readonly(seeder.pubkey(), false),
                pipeline_client::AccountMeta::new_readonly(other.pubkey(), true),
            ],
        );
        env.send(&[approve], &[&other]).unwrap();
    }
    let mut seed = seed_instruction(&market, &seeder.pubkey(), [600_000, 1_500_000], vec![]);
    seed.accounts[2].pubkey = theirs(0);
    seed.accounts[3].pubkey = theirs(1);
    assert_refused(env.send(&[seed], &[&seeder]), StrategyError::WrongAccount);
    assert_eq!(
        env.tax_market(&market.market_state).status,
        MarketStatus::Created
    );
    assert_eq!(env.balance(&theirs(0)), 1_000_000);
}
