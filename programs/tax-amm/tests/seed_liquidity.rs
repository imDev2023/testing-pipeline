//! Seeding from another program (docs/spec/tax-amm.md, "Addresses", "Creation parameters",
//! "Creating a market", "The seed"): a launchpad graduating a token calls
//! `pipeline_seed_liquidity`, which creates the market at the PDA `["seeded", seeder, mint_0,
//! mint_1]`, takes at most `amounts[i]` from each escrow and opens the market, and the same
//! transaction records it with the router's `register_existing_market` and both fee accounts.
//!
//! The launchpad is the stand-in in `programs/test-programs/stand-in-launchpad`, calling
//! through the real router's bytes from devnet.

mod common;

use common::launchpad::Launch;
use common::*;
use pipeline_client::interface::SeedRequest;
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::state::MarketStatus;

#[test]
fn a_launchpad_graduates_a_token_into_an_open_tax_market_the_router_records() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let launch = env.launch(mints, [800_000_000_000, 300_000_000_000]);
    let params = valid_params(&Pubkey::new_unique());
    let amounts = [500_000_000_000, 200_000_000_000];

    let graduated = env.graduate(&launch, &params, amounts).unwrap();
    let market = &graduated.market;

    // The market state lives at the seeded PDA, with the launchpad's seeder as its seeder
    // (the seeder in `data` is ignored) and every other parameter as sent.
    assert_eq!(market.market_state, launch.market_state());
    let state = env.tax_market(&market.market_state);
    assert_eq!(
        state.params(),
        tax_amm::InitParams {
            seeder: ak(&launch.seeder),
            ..params
        }
    );
    assert_eq!(state.status, MarketStatus::Open);
    assert_eq!(state.reserves, amounts);
    assert_eq!(ck(&state.market_signer), market.market);

    // At most amounts[i] left each escrow, SeedResult.taken is exactly what left, and the
    // vaults hold it.
    let g = &graduated.graduation;
    assert_eq!(g.left_escrows, amounts.to_vec());
    assert_eq!(g.taken, g.left_escrows);
    assert_eq!(g.lp_amount, 0);
    assert_eq!(env.balance(&launch.escrows[0]), 300_000_000_000);
    assert_eq!(env.balance(&launch.escrows[1]), 100_000_000_000);
    assert_eq!(env.balance(&market.vaults[0]), amounts[0]);
    assert_eq!(env.balance(&market.vaults[1]), amounts[1]);

    // The router recorded it, with both fee accounts, and it trades at once.
    let recorded = env.router_market(&market.market);
    assert_eq!(recorded.mints(), &market.mints);
    assert_eq!(&recorded.vaults[..2], &market.vaults);
    let trader = env.funded_wallet(market, 10_000_000_000);
    for direction in [(0, 1), (1, 0)] {
        let quote = env.quote(market, &exact_in(direction.0, direction.1, 1_000_000_000));
        let result = env.swap(market, &trader, direction, 1_000_000_000).unwrap();
        assert_eq!(result.received, quote.unwrap().amount_out);
    }
}

/// Two SPL Token mints and a launch on them whose escrows hold plenty of each.
fn launch_on_spl_token(env: &mut Env) -> Launch {
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    env.launch(mints, [10_000_000_000_000, 10_000_000_000_000])
}

const AMOUNTS: [u64; 2] = [500_000_000_000, 200_000_000_000];

#[test]
fn a_seeder_seeds_a_pair_of_mints_once() {
    let mut env = Env::new();
    let launch = launch_on_spl_token(&mut env);
    let params = valid_params(&Pubkey::new_unique());
    let first = env.graduate(&launch, &params, AMOUNTS).unwrap();

    // The same seeder and mints derive the same market state, which exists now.
    let again = env.graduate(&launch, &params, AMOUNTS);
    let failure = again.as_ref().err().expect("a second seeding is refused");
    assert!(failure.contains("already in use"), "{failure}");
    let state = env.tax_market(&first.market.market_state);
    assert_eq!(state.reserves, AMOUNTS);

    // Another launch, with its own seeder, makes its own market on the same mints.
    let other = env.launch(
        [(launch.mints[0], TOKEN), (launch.mints[1], TOKEN)],
        AMOUNTS,
    );
    let second = env.graduate(&other, &params, AMOUNTS).unwrap();
    assert_ne!(second.market.market_state, first.market.market_state);
}

#[test]
fn a_call_the_seeder_did_not_sign_is_refused() {
    let mut env = Env::new();
    let launch = launch_on_spl_token(&mut env);
    // pipeline_seed_liquidity called directly, naming the launch's seeder, which only the
    // launchpad can sign for.
    let request = SeedRequest {
        amounts: AMOUNTS.to_vec(),
        data: init_data(&valid_params(&Pubkey::new_unique())),
    };
    let call = env.seed_liquidity_instruction(&launch, false, &request);
    let failure = env
        .send(&[call], &[])
        .expect_err("an unsigned seeder is refused");
    assert!(failure.contains("AccountNotSigner"), "{failure}");
    assert!(env.svm.get_account(&launch.market_state()).is_none());
    assert_eq!(env.balance(&launch.escrows[0]), 10_000_000_000_000);
}

#[test]
fn the_seed_action_is_refused_on_a_seeded_market() {
    let mut env = Env::new();
    let launch = launch_on_spl_token(&mut env);
    let graduated = env
        .graduate(&launch, &valid_params(&Pubkey::new_unique()), AMOUNTS)
        .unwrap();
    let market = &graduated.market;

    // Even signed by the seeder itself, from its escrows, the market is already seeded.
    let seed = seed_instruction(market, &launch.seeder, [1_000, 1_000], vec![]);
    assert_refused(
        env.call_as_seeder(&launch, seed),
        tax_amm::StrategyError::AlreadySeeded,
    );
    // Anyone else is not its seeder.
    let stranger = Keypair::new();
    env.fund(&stranger.pubkey(), market, [1_000, 1_000]);
    assert_refused(
        env.seed(market, &stranger, [1_000, 1_000]),
        tax_amm::StrategyError::NotSeeder,
    );
    assert_eq!(env.tax_market(&market.market_state).reserves, AMOUNTS);
}

use anchor_lang::prelude::Pubkey as AnchorKey;
use tax_amm::config::MAX_TAX_BPS;
use tax_amm::{InitParams, StrategyError as E};

/// Fails unless a market on the mints `mints_of` makes, with valid parameters changed by
/// `change`, is refused with `error` both when created through the router and when seeded
/// by a launchpad: the two run the same validation.
fn assert_refused_both_ways(
    mints_of: impl Fn(&mut Env) -> [(Pubkey, Pubkey); 2],
    change: impl Fn(&mut InitParams),
    error: E,
) {
    let mut params = valid_params(&Pubkey::new_unique());
    change(&mut params);

    let mut env = Env::new();
    let mints = mints_of(&mut env);
    assert_refused(env.create_tax_market(mints, &params), error);

    let mut env = Env::new();
    let mints = mints_of(&mut env);
    let launch = env.launch(mints, [0, 0]);
    assert_refused(env.graduate(&launch, &params, AMOUNTS).map(|_| ()), error);
    assert!(env.svm.get_account(&launch.market_state()).is_none());
}

/// A change to valid creation parameters.
type ParamsChange = Box<dyn Fn(&mut InitParams)>;
/// Makes a market's two mints, each with its token program.
type MintsOf = Box<dyn Fn(&mut Env) -> [(Pubkey, Pubkey); 2]>;

fn spl_token_mints(env: &mut Env) -> [(Pubkey, Pubkey); 2] {
    [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ]
}

#[test]
fn every_creation_rule_refuses_a_seeded_market_as_it_refuses_a_created_one() {
    let none = AnchorKey::default();
    let cases: Vec<(ParamsChange, E)> = vec![
        (Box::new(|p| p.tax_side = 2), E::BadTaxSide),
        (Box::new(|p| p.virtual_side = 2), E::BadVirtualSide),
        (
            Box::new(|p| p.sell_tax_max_bps = MAX_TAX_BPS + 1),
            E::TaxAboveCap,
        ),
        (Box::new(|p| p.buy_tax_min_bps = 900), E::RangeInverted),
        (Box::new(|p| p.buy_tax_bps = 99), E::RateOutsideRange),
        (
            Box::new(move |p| {
                p.recipients = [none; 4];
                p.shares = [0; 4];
                p.burn_share_bps = 10_000;
            }),
            E::NoRecipient,
        ),
        (
            Box::new(move |p| {
                p.recipients[1] = none;
                p.recipients[2] = AnchorKey::new_unique();
            }),
            E::RecipientsOutOfOrder,
        ),
        (
            Box::new(|p| {
                p.shares[1] = 0;
                p.burn_share_bps = 4_000;
            }),
            E::ZeroShare,
        ),
        (
            Box::new(|p| {
                p.shares[2] = 1;
                p.burn_share_bps = 999;
            }),
            E::ShareWithoutRecipient,
        ),
        (Box::new(|p| p.burn_share_bps = 999), E::SharesNotWhole),
    ];
    for (change, error) in cases {
        assert_refused_both_ways(spl_token_mints, change, error);
    }
}

#[test]
fn a_seeded_market_refuses_to_burn_native_sol_as_a_created_one_does() {
    assert_refused_both_ways(
        |env| {
            let native = env.write_native_mint(&tax_amm::params::NATIVE_MINTS[0], &TOKEN);
            [(env.create_mint(&TOKEN), TOKEN), (native, TOKEN)]
        },
        |p| p.tax_side = 1,
        E::BurnOnNativeSol,
    );
}

#[test]
fn every_mint_rule_refuses_a_seeded_market_as_it_refuses_a_created_one() {
    use spl_token_2022_interface::extension::ExtensionType;
    let keep = |_: &mut InitParams| {};
    // A mint extension outside the allowlist.
    assert_refused_both_ways(
        |env| {
            let delegate = ExtensionType::PermanentDelegate as u16;
            let mint = env.write_mint_with_extensions(&[(delegate, 32)]);
            [(mint, TOKEN_2022), (env.create_mint(&TOKEN), TOKEN)]
        },
        keep,
        E::MintExtensionNotAllowed,
    );
    // A token program that is not the mint's.
    assert_refused_both_ways(
        |env| {
            [
                (env.create_mint(&TOKEN), TOKEN_2022),
                (env.create_mint(&TOKEN), TOKEN),
            ]
        },
        keep,
        E::WrongTokenProgram,
    );
    // The same mint twice.
    assert_refused_both_ways(
        |env| {
            let mint = env.create_mint(&TOKEN);
            [(mint, TOKEN), (mint, TOKEN)]
        },
        keep,
        E::EqualMints,
    );
}

#[test]
fn the_seeder_in_the_data_is_ignored_for_the_calling_programs_pda() {
    let mut env = Env::new();
    let launch = launch_on_spl_token(&mut env);
    // A created market refuses the default key as its seeder; a seeded one never reads it.
    let mut params = valid_params(&Pubkey::new_unique());
    params.seeder = AnchorKey::default();
    let graduated = env.graduate(&launch, &params, AMOUNTS).unwrap();
    let state = env.tax_market(&graduated.market.market_state);
    assert_eq!(ck(&state.seeder), launch.seeder);
}

#[test]
fn a_seed_request_needs_one_amount_per_mint_and_valid_data() {
    // Called directly by a wallet seeder: the launchpad itself refuses a request whose
    // amounts don't match its accounts before the strategy sees it.
    let mut env = Env::new();
    let mints = spl_token_mints(&mut env);
    let launch = env.wallet_launch(mints, [10_000_000_000_000, 10_000_000_000_000]);
    let data = init_data(&valid_params(&Pubkey::new_unique()));
    for amounts in [vec![], vec![1_000], vec![1_000, 1_000, 1_000]] {
        let request = SeedRequest {
            amounts,
            data: data.clone(),
        };
        let call = env.seed_liquidity_instruction(&launch, true, &request);
        assert_refused(env.send(&[call], &[&launch.creator]), E::BadSeedAmounts);
    }
    let mut longer = data.clone();
    longer.push(0);
    for data in [longer, data[..data.len() - 1].to_vec(), vec![]] {
        let request = SeedRequest {
            amounts: AMOUNTS.to_vec(),
            data,
        };
        let call = env.seed_liquidity_instruction(&launch, true, &request);
        assert_refused(env.send(&[call], &[&launch.creator]), E::BadInitData);
    }
    // The same request, well formed, seeds the wallet's market.
    let request = SeedRequest {
        amounts: AMOUNTS.to_vec(),
        data,
    };
    let call = env.seed_liquidity_instruction(&launch, true, &request);
    env.send(&[call], &[&launch.creator]).unwrap();
    assert_eq!(env.tax_market(&launch.market_state()).reserves, AMOUNTS);
}

#[test]
fn a_token_launches_single_sided_on_a_virtual_reserve() {
    let mut env = Env::new();
    let launch = launch_on_spl_token(&mut env);
    let mut params = valid_params(&Pubkey::new_unique());
    params.virtual_side = 1;
    params.virtual_reserve = 50_000_000_000;
    let graduated = env
        .graduate(&launch, &params, [1_000_000_000_000, 0])
        .unwrap();
    assert_eq!(graduated.graduation.taken, vec![1_000_000_000_000, 0]);
    assert_eq!(
        graduated.graduation.left_escrows,
        vec![1_000_000_000_000, 0]
    );
    let market = &graduated.market;
    assert_eq!(
        env.tax_market(&market.market_state).reserves,
        [1_000_000_000_000, 0]
    );
    // Open at once: a buy of the token prices against the virtual reserve.
    let trader = env.funded_wallet(market, 10_000_000_000);
    let quote = env.quote(market, &exact_in(1, 0, 1_000_000_000)).unwrap();
    let result = env.swap(market, &trader, (1, 0), 1_000_000_000).unwrap();
    assert_eq!(result.received, quote.amount_out);
    assert!(result.received > 0);
}

#[test]
fn a_side_without_a_virtual_reserve_needs_a_seed_above_zero() {
    let mut env = Env::new();
    let launch = launch_on_spl_token(&mut env);
    let params = valid_params(&Pubkey::new_unique());
    for amounts in [[0, AMOUNTS[1]], [AMOUNTS[0], 0]] {
        assert_refused(
            env.graduate(&launch, &params, amounts).map(|_| ()),
            E::ZeroSeed,
        );
    }
    assert!(env.svm.get_account(&launch.market_state()).is_none());
}

#[test]
fn a_seed_larger_than_the_escrow_takes_nothing() {
    let mut env = Env::new();
    let mints = spl_token_mints(&mut env);
    let launch = env.launch(mints, [AMOUNTS[0] - 1, AMOUNTS[1]]);
    let params = valid_params(&Pubkey::new_unique());
    let failure = env
        .graduate(&launch, &params, AMOUNTS)
        .err()
        .expect("the token program refuses the transfer");
    assert!(failure.contains("insufficient funds"), "{failure}");
    assert_eq!(env.balance(&launch.escrows[0]), AMOUNTS[0] - 1);
    assert_eq!(env.balance(&launch.escrows[1]), AMOUNTS[1]);
    assert!(env.svm.get_account(&launch.market_state()).is_none());
}

#[test]
fn token_2022_and_hooked_mints_graduate_and_trade() {
    let cases: Vec<(&str, MintsOf)> = vec![
        (
            "two Token-2022 mints",
            Box::new(|env| {
                [
                    (env.create_mint(&TOKEN_2022), TOKEN_2022),
                    (env.create_mint(&TOKEN_2022), TOKEN_2022),
                ]
            }),
        ),
        (
            "SPL Token and a mint with Pipeline's test-hook",
            Box::new(|env| {
                let hooked = env.create_mint_with_test_hook();
                [(env.create_mint(&TOKEN), TOKEN), (hooked, TOKEN_2022)]
            }),
        ),
    ];
    for (what, mints_of) in cases {
        let mut env = Env::new();
        let mints = mints_of(&mut env);
        let launch = env.launch(mints, [10_000_000_000_000, 10_000_000_000_000]);
        let graduated = env
            .graduate(&launch, &valid_params(&Pubkey::new_unique()), AMOUNTS)
            .unwrap_or_else(|e| panic!("{what}: {e}"));
        let market = &graduated.market;
        assert_eq!(graduated.graduation.taken, AMOUNTS.to_vec(), "{what}");
        assert_eq!(
            env.tax_market(&market.market_state).reserves,
            AMOUNTS,
            "{what}"
        );
        let trader = env.funded_wallet(market, 10_000_000_000);
        for direction in [(0, 1), (1, 0)] {
            let quote = env
                .quote(market, &exact_in(direction.0, direction.1, 1_000_000_000))
                .unwrap();
            let result = env.swap(market, &trader, direction, 1_000_000_000).unwrap();
            assert_eq!(result.received, quote.amount_out, "{what}");
        }
    }
}

#[test]
fn lamports_sent_to_the_market_state_or_a_vault_beforehand_do_not_block_the_graduation() {
    let mut env = Env::new();
    let launch = launch_on_spl_token(&mut env);
    let market_state = launch.market_state();
    let (_, vaults) = tax_market_addresses(&market_state, launch.mints);
    for address in [market_state, vaults[0]] {
        env.svm.airdrop(&address, 1_000_000).unwrap();
    }
    let graduated = env
        .graduate(&launch, &valid_params(&Pubkey::new_unique()), AMOUNTS)
        .unwrap();
    let state = env.tax_market(&graduated.market.market_state);
    assert_eq!(state.status, MarketStatus::Open);
    assert_eq!(state.reserves, AMOUNTS);
}

#[test]
fn the_graduation_transaction_fits_for_mints_of_one_token_program() {
    // docs/spec/tax-amm.md, "Creating a market": the launchpad's call, then
    // register_existing_market and init_fee_account for each mint, in one transaction paid
    // for by the creator. Prints its legacy size, against a transaction's 1,232 bytes, for
    // each kind of mint pair.
    const MAX_TRANSACTION_BYTES: usize = 1_232;
    let cases: Vec<(&str, bool, MintsOf)> = vec![
        ("two SPL Token mints", true, Box::new(spl_token_mints)),
        (
            "two Token-2022 mints",
            true,
            Box::new(|env| {
                [
                    (env.create_mint(&TOKEN_2022), TOKEN_2022),
                    (env.create_mint(&TOKEN_2022), TOKEN_2022),
                ]
            }),
        ),
        (
            "an SPL Token and a Token-2022 mint",
            false,
            Box::new(|env| {
                [
                    (env.create_mint(&TOKEN), TOKEN),
                    (env.create_mint(&TOKEN_2022), TOKEN_2022),
                ]
            }),
        ),
        (
            "an SPL Token mint and a hooked mint",
            false,
            Box::new(|env| {
                let hooked = env.create_mint_with_test_hook();
                [(env.create_mint(&TOKEN), TOKEN), (hooked, TOKEN_2022)]
            }),
        ),
    ];
    for (what, must_fit, mints_of) in cases {
        let mut env = Env::new();
        let mints = mints_of(&mut env);
        let launch = env.launch(mints, AMOUNTS);
        let params = valid_params(&Pubkey::new_unique());
        let mut instructions = vec![env.graduate_instruction(
            &launch,
            AMOUNTS,
            init_data(&params),
            env.seed_liquidity_accounts(&launch),
        )];
        instructions.extend(env.register_instructions(
            &launch.creator.pubkey(),
            &launch.market_state(),
            launch.mints,
            launch.token_programs,
        ));
        let transaction = solana_transaction::Transaction::new_signed_with_payer(
            &instructions,
            Some(&launch.creator.pubkey()),
            &[&launch.creator],
            env.svm.latest_blockhash(),
        );
        let size = 1 + 64 * transaction.signatures.len() + transaction.message.serialize().len();
        println!("the graduation transaction on {what}: {size} of {MAX_TRANSACTION_BYTES} bytes");
        if must_fit {
            assert!(size <= MAX_TRANSACTION_BYTES, "{what}: {size}");
        }
        env.svm.send_transaction(transaction).unwrap();
        assert_eq!(env.tax_market(&launch.market_state()).reserves, AMOUNTS, "{what}");
    }
}
