//! The seed (docs/spec/tax-amm.md, "The seed"): the seeder funds a tax market once, before
//! any swap, and the market records what arrived and opens.

mod common;

use common::*;
use pipeline_client::{pda, Pubkey};
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
    let terms = terms_of(&env.tax_market(&market.market_state));
    let mut unsigned = seed_instruction(&market, &stranger.pubkey(), [1, 1], terms, vec![]);
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
        // A contained mint is bound between its market's creation and its seed, so only a
        // cleared hook can be seeded in the creation transaction.
        ("an SPL Token mint and a mint whose hook is cleared", [0, 2]),
    ] {
        let mut env = Env::new();
        let mints = kinds.map(|kind| match kind {
            0 => (env.create_mint(&TOKEN), TOKEN),
            1 => (env.create_mint(&TOKEN_2022), TOKEN_2022),
            _ => (env.create_mint_with_cleared_hook(), TOKEN_2022),
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
        let params = valid_params(&creator);
        env.fund(&creator, &market, [1_000_000, 2_000_000]);
        let mut instructions = vec![create_market_instruction(
            &creator,
            &state.pubkey(),
            true,
            init_data(&params),
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
        // The creator hashes the terms it is creating the market with.
        let terms = terms_hash(mint_keys, &params, ([0, 0], 0));
        instructions.push(seed_instruction(
            &market,
            &creator,
            [600_000, 1_500_000],
            terms,
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
    let terms = terms_of(&env.tax_market(&market.market_state));
    let mut seed = seed_instruction(
        &market,
        &seeder.pubkey(),
        [600_000, 1_500_000],
        terms,
        vec![],
    );
    seed.accounts[2].pubkey = theirs(0);
    seed.accounts[3].pubkey = theirs(1);
    assert_refused(env.send(&[seed], &[&seeder]), StrategyError::WrongAccount);
    assert_eq!(
        env.tax_market(&market.market_state).status,
        MarketStatus::Created
    );
    assert_eq!(env.balance(&theirs(0)), 1_000_000);
}

/// A change to a market's creation parameters.
type Alter = fn(&mut tax_amm::InitParams);

/// Hardening finding H019 (#67): `seed` bound no terms, so anyone could create a decoy market
/// naming a victim as its seeder, with terms of its own (here a huge virtual reserve on the
/// other side, which would let one tiny swap take the victim's whole deposit), and a victim
/// signing `seed` on a market it was handed funded it. The seed now carries the hash of the
/// terms its seeder agreed to, and every difference is refused before anything moves.
#[test]
fn sos_h019_a_seed_whose_terms_are_not_the_markets_is_refused() {
    let victim = Keypair::new();
    let intended = valid_params(&victim.pubkey());
    let altered: [(&str, Alter); 6] = [
        ("a virtual reserve on the other side", |p| {
            p.virtual_side = 1;
            p.virtual_reserve = u64::MAX / 2;
        }),
        ("another tax authority", |p| {
            p.tax_authority = ak(&Pubkey::new_unique())
        }),
        ("another tax recipient", |p| {
            p.recipients[0] = ak(&Pubkey::new_unique())
        }),
        ("a wider buy tax range", |p| p.buy_tax_max_bps = 1_000),
        ("the other tax side", |p| p.tax_side = 0),
        ("a higher sell tax", |p| p.sell_tax_bps = 600),
    ];
    for (what, alter) in altered {
        let mut env = Env::new();
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN), TOKEN),
        ];
        let mut decoy = intended;
        alter(&mut decoy);
        let market = env.create_tax_market(mints, &decoy).unwrap();
        env.fund(&victim.pubkey(), &market, [1_000_000, 2_000_000]);
        let expected = terms_hash(market.mints, &intended, ([0, 0], 0));
        let seed = seed_instruction(&market, &victim.pubkey(), [1_000_000, 0], expected, vec![]);
        assert_refused(env.send(&[seed], &[&victim]), StrategyError::TermsChanged);
        let state = env.tax_market(&market.market_state);
        assert_eq!(state.status, MarketStatus::Created, "{what}");
        assert_eq!(env.balance(&market.vaults[0]), 0, "{what}: nothing moved");
    }
    // The market's own terms, hashed by the seeder that created it, open it.
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let market = env.create_tax_market(mints, &intended).unwrap();
    env.fund(&victim.pubkey(), &market, [1_000_000, 2_000_000]);
    let expected = terms_hash(market.mints, &intended, ([0, 0], 0));
    let seed = seed_instruction(
        &market,
        &victim.pubkey(),
        [1_000_000, 2_000_000],
        expected,
        vec![],
    );
    env.send(&[seed], &[&victim]).unwrap();
    assert_eq!(
        env.tax_market(&market.market_state).status,
        MarketStatus::Open
    );
}

/// A rate change pending before the seed is part of the terms: a seed hashed without it is
/// refused, and one that names it opens the market.
#[test]
fn a_rate_change_pending_before_the_seed_is_part_of_its_terms() {
    use common::authority::set_taxes_instruction;
    let authority = Keypair::new();
    let (mut env, market, seeder) = unseeded(|p| p.tax_authority = ak(&authority.pubkey()));
    let before = env.tax_market(&market.market_state);
    env.send(
        &[set_taxes_instruction(
            &market.market_state,
            &authority.pubkey(),
            800,
            900,
        )],
        &[&authority],
    )
    .unwrap();
    let after = env.tax_market(&market.market_state);
    assert_ne!(after.pending_from_slot, 0);
    for (terms, refused) in [(terms_of(&before), true), (terms_of(&after), false)] {
        let seed = seed_instruction(
            &market,
            &seeder.pubkey(),
            [600_000, 1_500_000],
            terms,
            vec![],
        );
        let result = env.send(&[seed], &[&seeder]);
        if refused {
            assert_refused(result, StrategyError::TermsChanged);
        } else {
            result.unwrap();
        }
    }
}

/// The hash of fixed terms, which `scripts/terms.test.ts` pins too, so the TypeScript client
/// that demo scripts and Aviary seed with computes exactly what the program checks.
#[test]
fn the_terms_hash_of_fixed_terms_is_the_clients() {
    let key = |s: &str| s.parse::<Pubkey>().unwrap();
    let default = Pubkey::default();
    let params = tax_amm::InitParams {
        tax_side: 1,
        buy_tax_bps: 300,
        sell_tax_bps: 500,
        buy_tax_min_bps: 100,
        buy_tax_max_bps: 800,
        sell_tax_min_bps: 0,
        sell_tax_max_bps: 1_000,
        tax_authority: ak(&key("9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt")),
        seeder: ak(&key("ACrn3UD4DLgyCKbNMiqx6Vcs2d49RSbHdbLJ82uw61s8")),
        recipients: [
            ak(&key("8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2")),
            ak(&default),
            ak(&default),
            ak(&default),
        ],
        shares: [9_000, 0, 0, 0],
        burn_share_bps: 1_000,
        virtual_side: 0,
        virtual_reserve: 50_000_000_000,
    };
    let mints = [
        key("So11111111111111111111111111111111111111112"),
        key("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    ];
    let none = Pubkey::new_from_array(terms_hash(mints, &params, ([0, 0], 0))).to_string();
    let pending =
        Pubkey::new_from_array(terms_hash(mints, &params, ([800, 900], 12_345))).to_string();
    println!("no pending change: {none}\npending: {pending}");
    assert_eq!(none, "FBQRE7k7qyqiavt2rD3WFVRj2wrjESjBLU36g3TZSKbs");
    assert_eq!(pending, "FXQuHEirGu2qVb8yD38kFxBLyoEenoVvSjctJWwD1DG2");
}
