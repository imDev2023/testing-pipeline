//! Seeding by another program (docs/spec/pool4-for-solana.md, "Addresses", "Creation
//! parameters", "Creating a market", "The seed"): a launchpad graduating a token calls
//! `pipeline_seed_liquidity`, which creates the market at the PDA `["seeded", seeder,
//! token_mint, wsol_mint]`, takes at most `amounts[i]` from each escrow, and seeds and opens
//! the market as the `seed` action does; the same transaction records it with the router's
//! `register_existing_market` and both fee accounts, and it then trades like any market.
//!
//! The launchpad is the stand-in in `programs/test-programs/stand-in-launchpad`, calling
//! through the real router's bytes from devnet.

mod common;

use buy_wall_amm::errors::StrategyError::{self, *};
use buy_wall_amm::state::STATUS_OPEN;
use buy_wall_amm::InitParams;
use common::launchpad::Launch;
use common::*;
use pipeline_client::interface::SeedRequest;
use pipeline_client::{Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// The worked example's seed: 1,000,000 tokens of 6 decimals and 10 SOL.
const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;

/// A seedable SPL Token token and a launch of it whose escrows hold more than the seed.
fn launch(env: &mut Env) -> Launch {
    let token = env.seedable_token(&TOKEN);
    env.launch(token, TOKEN, 3 * TOKENS, 3 * LAMPORTS)
}

#[test]
fn a_launchpad_graduates_a_token_into_an_open_market_the_router_records_and_trades() {
    let mut env = Env::new();
    env.set_clock(5_000, 1_800_000_000);
    let launch = launch(&mut env);
    let params = launch_params(Pubkey::new_unique());

    let graduated = env.graduate(&launch, &params, TOKENS, LAMPORTS).unwrap();
    let market = &graduated.market;

    // The market state lives at the seeded PDA, with the launchpad's seeder as its seeder
    // (the seeder in the data is ignored), and opened as the worked example's seed row.
    assert_eq!(market.market_state, launch.market_state());
    let state = env.state(market);
    assert_eq!(state.seeder, launch.seeder);
    assert_eq!(state.status, STATUS_OPEN);
    assert_eq!(state.sqrt_price(), 1_844_674_407_370_955_161);
    assert_eq!(state.liquidity(), 99_999_999_999);
    assert_eq!(state.cap(), TOKENS);
    assert_eq!((state.pool_tokens(), state.pool_sol()), (TOKENS, LAMPORTS));
    assert_eq!(state.market_signer, market.market);

    // Exactly the seed left the escrows, SeedResult.taken says so, there are no LP shares,
    // and the vaults hold it.
    let g = &graduated.graduation;
    assert_eq!(g.left_escrows, vec![TOKENS, LAMPORTS]);
    assert_eq!(g.taken, g.left_escrows);
    assert_eq!(g.lp_amount, 0);
    assert_eq!(env.balance(&launch.token_escrow), 2 * TOKENS);
    assert_eq!(env.balance(&launch.sol_escrow), 2 * LAMPORTS);
    assert_eq!(env.balance(&market.token_vault), TOKENS);
    assert_eq!(env.balance(&market.sol_vault), LAMPORTS);

    // The router recorded it with its mints and vaults, and it trades both ways at once.
    let info = env.market_info(&market.market_state).unwrap();
    assert_eq!(info.mints, market.mints().map(|k| k.to_bytes()).to_vec());
    assert_eq!(info.vaults, market.vaults().map(|k| k.to_bytes()).to_vec());
    let trader = env.trader(market, 1_000_000_000, 2 * SOL);
    for (input, output, amount) in [(1, 0, SOL), (0, 1, 1_000_000_000)] {
        let quote = env.quote(market, &exact_in(input, output, amount)).unwrap();
        let swap = env
            .swap(market, &trader, (input, output), TradeMode::ExactIn, amount)
            .unwrap();
        assert_eq!(swap.received, quote.amount_out);
        assert!(swap.received > 0);
    }
}

#[test]
fn a_seeder_seeds_a_token_once_and_another_seeder_gets_another_address() {
    let mut env = Env::new();
    let launch = launch(&mut env);
    let params = launch_params(Pubkey::new_unique());
    let first = env.graduate(&launch, &params, TOKENS, LAMPORTS).unwrap();
    let before = env.market_state(&first.market);

    // The same seeder and token derive the same market state, which exists now: a second
    // seeding is refused and leaves the market and the escrows as they were.
    let again = env.graduate(&launch, &params, TOKENS, LAMPORTS);
    let failure = again.as_ref().err().expect("a second seeding is refused");
    assert!(failure.contains("already in use"), "{failure}");
    assert_eq!(env.market_state(&first.market), before);
    assert_eq!(env.balance(&launch.token_escrow), 2 * TOKENS);

    // Another launchpad's seeder for the same token gets its own address, so nobody can
    // take another launchpad's market first.
    let other = env.launch(launch.token_mint, TOKEN, TOKENS, LAMPORTS);
    assert_ne!(other.seeder, launch.seeder);
    assert_ne!(other.market_state(), launch.market_state());
    let second = env.graduate(&other, &params, TOKENS, LAMPORTS).unwrap();
    assert_eq!(env.state(&second.market).seeder, other.seeder);
    assert_eq!(env.market_state(&first.market), before);

    // The same seeder graduating another token gets another market too.
    let token = env.seedable_token(&TOKEN);
    let same_seeder = Launch {
        creator: launch.creator.insecure_clone(),
        seeder: launch.seeder,
        token_mint: token,
        token_program: TOKEN,
        token_escrow: pipeline_client::pda::associated_token(&launch.seeder, &token, &TOKEN),
        sol_escrow: launch.sol_escrow,
    };
    write_token_account(&mut env.svm, &token, &TOKEN, &launch.seeder, TOKENS).unwrap();
    let third = env
        .graduate(&same_seeder, &params, TOKENS, LAMPORTS)
        .unwrap();
    assert_ne!(third.market.market_state, first.market.market_state);
}

#[test]
fn a_seeder_cannot_be_named_without_its_signature() {
    let mut env = Env::new();
    let launch = launch(&mut env);
    // pipeline_seed_liquidity called directly, naming the launch's seeder, which only the
    // launchpad can sign for.
    let request = SeedRequest {
        amounts: vec![TOKENS, LAMPORTS],
        data: borsh::to_vec(&launch_params(Pubkey::new_unique())).unwrap(),
    };
    let call = env.seed_liquidity_ix(&launch, false, &request);
    let failure = env
        .send(&[call], &[])
        .expect_err("an unsigned seeder is refused");
    assert!(failure.contains("AccountNotSigner"), "{failure}");
    assert!(env.svm.get_account(&launch.market_state()).is_none());
    assert_eq!(env.balance(&launch.token_escrow), 3 * TOKENS);
}

#[test]
fn the_seed_action_is_refused_on_a_market_seeded_by_another_program() {
    let mut env = Env::new();
    let launch = launch(&mut env);
    let graduated = env
        .graduate(
            &launch,
            &launch_params(Pubkey::new_unique()),
            TOKENS,
            LAMPORTS,
        )
        .unwrap();
    let market = &graduated.market;
    let before = env.market_state(market);

    // Even signed by its seeder, from its escrows, the market is already seeded.
    let seed = seed_ix(market, &launch.seeder, 1_000, SOL, vec![]);
    assert_refused(env.call_as_seeder(&launch, seed), AlreadySeeded);
    // Anyone else is refused the same way, as on any seeded market (`seed` checks the
    // status before the signer).
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    env.fund(&stranger.pubkey(), &market.token_mint, &TOKEN, 1_000, SOL);
    let seed = seed_ix(market, &stranger.pubkey(), 1_000, SOL, vec![]);
    assert_refused(env.send(&[seed], &[&stranger]), AlreadySeeded);
    assert_eq!(env.market_state(market), before);
}

/// How a test makes the token a market is tried on: its mint and its token program.
type TokenOf = Box<dyn Fn(&mut Env) -> (Pubkey, Pubkey)>;

/// Tries one market both ways, from fresh VMs: created through the router and seeded by
/// the `seed` action in one transaction (the admin as seeder), and graduated by the
/// launchpad. Fails unless both are refused with `refusal`, or both land when it is `None`.
/// A refused graduation leaves no market state and takes nothing from the escrows.
fn assert_both_ways(
    what: &str,
    token_of: &dyn Fn(&mut Env) -> (Pubkey, Pubkey),
    params: &InitParams,
    (tokens, lamports): (u64, u64),
    refusal: Option<StrategyError>,
) {
    let mut env = Env::new();
    let (token, program) = token_of(&mut env);
    let created = env.create_and_seed(
        token,
        program,
        &InitParams {
            seeder: env.admin.pubkey(),
            ..params.clone()
        },
        tokens,
        lamports,
    );

    let mut env = Env::new();
    let (token, program) = token_of(&mut env);
    let escrowed = if env.svm.get_account(&token).is_some() {
        (tokens, lamports)
    } else {
        (0, 0)
    };
    let launch = env.launch(token, program, escrowed.0, escrowed.1);
    let graduated = env.graduate(&launch, params, tokens, lamports);

    match refusal {
        Some(error) => {
            println!("{what}: both refused with {error:?}");
            assert_refused(created.map(|_| ()), error);
            assert_refused(graduated.map(|_| ()), error);
            assert!(env.svm.get_account(&launch.market_state()).is_none());
            assert_eq!(env.balance(&launch.sol_escrow), escrowed.1);
        }
        None => {
            created.unwrap_or_else(|e| panic!("{what}: created: {e}"));
            graduated.unwrap_or_else(|e| panic!("{what}: graduated: {e}"));
        }
    }
}

fn seedable(program: Pubkey) -> TokenOf {
    Box::new(move |env: &mut Env| (env.seedable_token(&program), program))
}

#[test]
fn every_creation_rule_refuses_a_graduation_as_it_refuses_a_creation() {
    let unset = Pubkey::default();
    let wallet = Pubkey::new_unique();
    type Change = Box<dyn Fn(&mut InitParams)>;
    let cases: Vec<(&str, Change, Option<StrategyError>)> = vec![
        ("fee 24", Box::new(|p| p.fee_bps = 24), Some(FeeOutOfRange)),
        ("fee 25", Box::new(|p| p.fee_bps = 25), None),
        ("fee 300", Box::new(|p| p.fee_bps = 300), None),
        (
            "fee 301",
            Box::new(|p| p.fee_bps = 301),
            Some(FeeOutOfRange),
        ),
        (
            "wall split 10,001",
            Box::new(|p| p.wall_split_bps = 10_001),
            Some(WallSplitOutOfRange),
        ),
        (
            "no fee recipient, wall split 10,000",
            Box::new(move |p| {
                p.wall_split_bps = 10_000;
                p.fee_recipient = unset;
            }),
            None,
        ),
        (
            "no fee recipient, wall split 9,999",
            Box::new(move |p| {
                p.wall_split_bps = 9_999;
                p.fee_recipient = unset;
            }),
            Some(FeeRecipientRequired),
        ),
        (
            "reward share 3,001",
            Box::new(|p| p.reward_share_bps = 3_001),
            Some(RewardShareOutOfRange),
        ),
        (
            "reward share 0, a rewards recipient",
            Box::new(move |p| {
                p.reward_share_bps = 0;
                p.rewards_recipient = wallet;
            }),
            Some(RewardsRecipientMismatch),
        ),
        (
            "reward share 1, no rewards recipient",
            Box::new(move |p| {
                p.reward_share_bps = 1;
                p.rewards_recipient = unset;
            }),
            Some(RewardsRecipientMismatch),
        ),
        (
            "cap floor 9",
            Box::new(|p| p.cap_floor_bps = 9),
            Some(CapFloorOutOfRange),
        ),
        (
            "cap floor 10,000",
            Box::new(|p| p.cap_floor_bps = 10_000),
            None,
        ),
        (
            "cap floor 10,001",
            Box::new(|p| p.cap_floor_bps = 10_001),
            Some(CapFloorOutOfRange),
        ),
        (
            "cap decay 10,001",
            Box::new(|p| p.cap_decay_bps = 10_001),
            Some(CapDecayOutOfRange),
        ),
    ];
    for (what, change, refusal) in cases {
        let mut params = launch_params(Pubkey::new_unique());
        change(&mut params);
        assert_both_ways(
            what,
            &*seedable(TOKEN),
            &params,
            (TOKENS, LAMPORTS),
            refusal,
        );
    }
}

#[test]
fn every_mint_rule_refuses_a_graduation_as_it_refuses_a_creation() {
    use spl_token_2022_interface::extension::ExtensionType;
    let params = launch_params(Pubkey::new_unique());
    let seed = (TOKENS, LAMPORTS);
    let cases: Vec<(&str, TokenOf, Option<StrategyError>)> = vec![
        ("SPL Token", seedable(TOKEN), None),
        ("Token-2022", seedable(TOKEN_2022), None),
        (
            "a transfer fee",
            Box::new(|env: &mut Env| {
                let token = env.create_mint_with(
                    &TOKEN_2022,
                    6,
                    &[RealExtension::TransferFee { bps: 100 }],
                    false,
                );
                env.revoke_authorities(&token, &TOKEN_2022);
                (token, TOKEN_2022)
            }),
            Some(MintExtensionNotAllowed),
        ),
        (
            "a permanent delegate",
            Box::new(|env: &mut Env| {
                let delegate = ExtensionType::PermanentDelegate as u16;
                (env.plant_token_2022_mint(delegate, 32), TOKEN_2022)
            }),
            Some(MintExtensionNotAllowed),
        ),
    ];
    for (what, token_of, refusal) in cases {
        assert_both_ways(what, &*token_of, &params, seed, refusal);
    }

    // An extension the program does not recognise: no token account of it can even be
    // funded, so creation alone is tried through the router, and the graduation from an
    // empty escrow.
    let mut env = Env::new();
    let token = env.plant_token_2022_mint(u16::MAX, 8);
    assert_refused(
        env.create_market(token, TOKEN_2022, &params),
        MintExtensionNotAllowed,
    );
    let launch = env.launch(token, TOKEN_2022, 0, LAMPORTS);
    assert_refused(
        env.graduate(&launch, &params, TOKENS, LAMPORTS).map(|_| ()),
        MintExtensionNotAllowed,
    );
    assert!(env.svm.get_account(&launch.market_state()).is_none());

    // Wrapped SOL as the token: SPL Token's aliases the escrows and the vaults, which is
    // refused before the strategy runs; Token-2022's would pair SOL with SOL.
    let mut env = Env::new();
    let launch = env.launch(WSOL, TOKEN, LAMPORTS, LAMPORTS);
    assert_fails(
        env.graduate(&launch, &params, LAMPORTS, LAMPORTS)
            .map(|_| ()),
    );
    let native_2022 = pipeline_client::pubkey!("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
    let mut data = vec![0u8; 82];
    data[44] = 9;
    data[45] = 1;
    let lamports = env.svm.minimum_balance_for_rent_exemption(82);
    env.svm
        .set_account(native_2022, solana_account(lamports, data, TOKEN_2022))
        .unwrap();
    let launch = env.launch(native_2022, TOKEN_2022, LAMPORTS, LAMPORTS);
    assert_refused(
        env.graduate(&launch, &params, LAMPORTS, LAMPORTS)
            .map(|_| ()),
        SameMint,
    );
    // Another mint in wrapped SOL's place.
    let token = env.seedable_token(&TOKEN);
    let launch = env.launch(token, TOKEN, TOKENS, LAMPORTS);
    let other = env.seedable_token(&TOKEN);
    write_token_account(&mut env.svm, &other, &TOKEN, &launch.seeder, LAMPORTS).unwrap();
    // Every address derived from it, so only the rule that index 1 is wrapped SOL refuses.
    let program = strategy_id();
    let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &program).0;
    let market_state = pda(&[
        b"seeded",
        launch.seeder.as_ref(),
        token.as_ref(),
        other.as_ref(),
    ]);
    let mut accounts = env.seed_liquidity_accounts(&launch);
    accounts[0].pubkey = market_state;
    accounts[5].pubkey = other;
    accounts[6].pubkey = pipeline_client::pda::associated_token(&launch.seeder, &other, &TOKEN);
    accounts[8].pubkey = pda(&[b"authority", market_state.as_ref()]);
    accounts[9].pubkey = pda(&[b"vault", market_state.as_ref(), token.as_ref()]);
    accounts[10].pubkey = pda(&[b"vault", market_state.as_ref(), other.as_ref()]);
    let data = borsh::to_vec(&params).unwrap();
    let graduate = env.graduate_ix(&launch, vec![TOKENS, LAMPORTS], data, accounts);
    assert_refused(env.send(&[graduate], &[&launch.creator]), WrongAccount);
    // The wrong token program for the token.
    let mut accounts = env.seed_liquidity_accounts(&launch);
    accounts[4].pubkey = TOKEN_2022;
    let data = borsh::to_vec(&params).unwrap();
    let graduate = env.graduate_ix(&launch, vec![TOKENS, LAMPORTS], data, accounts);
    assert_fails(env.send(&[graduate], &[&launch.creator]));
    assert!(env.svm.get_account(&launch.market_state()).is_none());
}

#[test]
fn every_seed_rule_refuses_a_graduation_as_it_refuses_a_seed() {
    use buy_wall_amm::config::MIN_SEED_LAMPORTS;
    let params = launch_params(Pubkey::new_unique());
    let live_mint_authority: TokenOf =
        Box::new(|env: &mut Env| (env.create_mint(&TOKEN, 6), TOKEN));
    let live_freeze_authority: TokenOf = Box::new(|env: &mut Env| {
        use spl_token_2022_interface::instruction::{set_authority, AuthorityType};
        let token = env.create_mint_with(&TOKEN, 6, &[], true);
        let admin = env.admin.pubkey();
        let ix =
            set_authority(&TOKEN, &token, None, AuthorityType::MintTokens, &admin, &[]).unwrap();
        env.send(&[ix], &[]).unwrap();
        (token, TOKEN)
    });
    assert_both_ways(
        "a live mint authority",
        &*live_mint_authority,
        &params,
        (TOKENS, LAMPORTS),
        Some(MintAuthorityLive),
    );
    assert_both_ways(
        "a live freeze authority",
        &*live_freeze_authority,
        &params,
        (TOKENS, LAMPORTS),
        Some(FreezeAuthorityLive),
    );

    let spl = seedable(TOKEN);
    for (what, params, seed, refusal) in [
        ("no tokens", params.clone(), (0, LAMPORTS), Some(EmptySeed)),
        (
            "one lamport under MIN_SEED_LAMPORTS",
            params.clone(),
            (TOKENS, MIN_SEED_LAMPORTS - 1),
            Some(SeedTooSmall),
        ),
        (
            "MIN_SEED_LAMPORTS",
            params.clone(),
            (TOKENS, MIN_SEED_LAMPORTS),
            None,
        ),
        // The highest opening price, 2^88, and one lamport above it (the seed test's case).
        (
            "the highest opening price",
            InitParams {
                cap_floor_bps: 10_000,
                ..params.clone()
            },
            (1 << 10, 1 << 58),
            None,
        ),
        (
            "above the highest opening price",
            InitParams {
                cap_floor_bps: 10_000,
                ..params.clone()
            },
            (1 << 10, (1 << 58) + 1),
            Some(OpeningPriceOutOfBounds),
        ),
        // The curve at the cap floor: 100 basis points of 101,000,000 units at one lamport
        // a unit hold MIN_LIQUIDITY or more, 99 do not.
        (
            "a cap floor holding MIN_LIQUIDITY",
            InitParams {
                cap_floor_bps: 100,
                ..params.clone()
            },
            (101_000_000, 101_000_000),
            None,
        ),
        (
            "a cap floor too thin",
            InitParams {
                cap_floor_bps: 99,
                ..params.clone()
            },
            (101_000_000, 101_000_000),
            Some(CapFloorTooThin),
        ),
    ] {
        assert_both_ways(what, &*spl, &params, seed, refusal);
    }
}

#[test]
fn the_seeder_in_the_data_is_ignored_for_the_calling_programs_pda() {
    let mut env = Env::new();
    let launch = launch(&mut env);
    // A created market refuses the default key as its seeder; a seeded one never reads it.
    let params = launch_params(Pubkey::default());
    let graduated = env.graduate(&launch, &params, TOKENS, LAMPORTS).unwrap();
    assert_eq!(env.state(&graduated.market).seeder, launch.seeder);
}

#[test]
fn a_seed_request_needs_one_amount_per_mint_and_exactly_the_parameters() {
    // Called directly by a wallet seeder: the launchpad itself refuses a request whose
    // amounts don't match its accounts before the strategy sees it.
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let launch = env.wallet_launch(token, TOKEN, TOKENS, LAMPORTS);
    let data = borsh::to_vec(&launch_params(Pubkey::new_unique())).unwrap();
    let send = |env: &mut Env, amounts: Vec<u64>, data: Vec<u8>| {
        let call = env.seed_liquidity_ix(&launch, true, &SeedRequest { amounts, data });
        env.send(&[call], &[&launch.creator])
    };
    for amounts in [vec![], vec![TOKENS], vec![TOKENS, LAMPORTS, 1]] {
        assert_refused(send(&mut env, amounts, data.clone()), BadSeedAmounts);
    }
    let mut longer = data.clone();
    longer.push(0);
    for bad in [longer, data[..data.len() - 1].to_vec(), vec![]] {
        assert_refused(send(&mut env, vec![TOKENS, LAMPORTS], bad), BadInitData);
    }
    // Well formed, the same call seeds the wallet's own market.
    send(&mut env, vec![TOKENS, LAMPORTS], data).unwrap();
    assert_eq!(env.state(&launch.market()).seeder, launch.seeder);
}

#[test]
fn a_seed_comes_only_from_escrows_the_seeder_owns() {
    let mut env = Env::new();
    let launch = launch(&mut env);
    let params = borsh::to_vec(&launch_params(Pubkey::new_unique())).unwrap();
    // Someone else's accounts, the whole balance delegated to the seeder.
    let owner = Pubkey::new_unique();
    env.fund(&owner, &launch.token_mint, &TOKEN, TOKENS, LAMPORTS);
    for (index, mint) in [(3, launch.token_mint), (6, WSOL)] {
        let theirs = pipeline_client::pda::associated_token(&owner, &mint, &TOKEN);
        let mut account = env.svm.get_account(&theirs).unwrap();
        account.data[72..76].copy_from_slice(&1u32.to_le_bytes());
        account.data[76..108].copy_from_slice(launch.seeder.as_ref());
        account.data[121..129].copy_from_slice(&u64::MAX.to_le_bytes());
        env.svm.set_account(theirs, account).unwrap();
        let mut accounts = env.seed_liquidity_accounts(&launch);
        accounts[index].pubkey = theirs;
        let graduate = env.graduate_ix(&launch, vec![TOKENS, LAMPORTS], params.clone(), accounts);
        let failure = env
            .send(&[graduate], &[&launch.creator])
            .expect_err("a delegated escrow is refused");
        assert!(failure.contains("ConstraintTokenOwner"), "{failure}");
    }
    assert!(env.svm.get_account(&launch.market_state()).is_none());
}

#[test]
fn a_seed_larger_than_an_escrow_takes_nothing() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let launch = env.launch(token, TOKEN, TOKENS - 1, LAMPORTS);
    let params = launch_params(Pubkey::new_unique());
    assert_fails(env.graduate(&launch, &params, TOKENS, LAMPORTS).map(|_| ()));
    assert!(env.svm.get_account(&launch.market_state()).is_none());
    assert_eq!(env.balance(&launch.token_escrow), TOKENS - 1);
    assert_eq!(env.balance(&launch.sol_escrow), LAMPORTS);
}

#[test]
fn a_seeded_market_reads_back_through_the_same_market_state_as_a_created_one() {
    use buy_wall_amm::config::MARKET_STATE_SIZE;
    use buy_wall_amm::state::MARKET_STATE_DISCRIMINATOR;
    let mut env = Env::new();
    env.set_clock(7_000, 1_800_000_000);
    let launch = launch(&mut env);
    let params = InitParams {
        seeder: launch.seeder,
        ..launch_params(Pubkey::new_unique())
    };
    let seeded = env
        .graduate(&launch, &params, TOKENS, LAMPORTS)
        .unwrap()
        .market;

    // The same market created through the router with the launchpad's seeder as its
    // seeder, seeded by the `seed` action signed by that seeder, at the same moment.
    let market_state = Keypair::new();
    let (created, create) = env.create_market_ix(
        &market_state,
        launch.token_mint,
        TOKEN,
        borsh::to_vec(&params).unwrap(),
    );
    let mut instructions = vec![create];
    instructions.extend(env.fee_account_ixs(&created));
    env.send(&instructions, &[&market_state]).unwrap();
    let seed = seed_ix(&created, &launch.seeder, TOKENS, LAMPORTS, vec![]);
    env.call_as_seeder(&launch, seed).unwrap();

    // Both are the program's fixed-size market state, with the same discriminator and
    // layout, and every field equal but those derived from each market state's address.
    let accounts = [&seeded, &created].map(|m| env.svm.get_account(&m.market_state).unwrap());
    for account in &accounts {
        assert_eq!(account.owner, strategy_id());
        assert_eq!(account.data.len(), MARKET_STATE_SIZE);
        assert_eq!(&account.data[..8], MARKET_STATE_DISCRIMINATOR);
    }
    let [mut a, mut b] = [&seeded, &created].map(|m| env.state(m));
    for (state, market) in [(&mut a, &seeded), (&mut b, &created)] {
        assert_eq!(state.market_signer, market.market);
        assert_eq!(
            (state.token_vault, state.sol_vault),
            (market.token_vault, market.sol_vault)
        );
        state.market_signer = Pubkey::default();
        state.token_vault = Pubkey::default();
        state.sol_vault = Pubkey::default();
        state.authority_bump = 0;
        state.token_vault_bump = 0;
        state.sol_vault_bump = 0;
    }
    assert_eq!(bytemuck::bytes_of(&a), bytemuck::bytes_of(&b));

    // `pipeline_market_info` reports both the same way, and both price a trade alike.
    for market in [&seeded, &created] {
        let info = env.market_info(&market.market_state).unwrap();
        assert_eq!(info.mints, market.mints().map(|k| k.to_bytes()).to_vec());
        assert_eq!(info.vaults, market.vaults().map(|k| k.to_bytes()).to_vec());
        assert!(!info.supports_exact_out);
    }
    let buy = exact_in(1, 0, SOL);
    assert_eq!(
        env.quote(&seeded, &buy).unwrap(),
        env.quote(&created, &buy).unwrap()
    );
}

#[test]
fn a_graduation_emits_the_creation_and_seed_events() {
    use buy_wall_amm::events::{MarketCreated, MarketSeeded};
    let mut env = Env::new();
    env.set_clock(9_000, 1_800_000_000);
    let launch = launch(&mut env);
    let params = launch_params(Pubkey::new_unique());
    let graduated = env.graduate(&launch, &params, TOKENS, LAMPORTS).unwrap();
    let market_state = graduated.market.market_state;

    let created: Vec<MarketCreated> = events(&graduated.logs);
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].market_state, market_state);
    assert_eq!(created[0].token_mint, launch.token_mint);
    assert_eq!(
        created[0].params,
        InitParams {
            seeder: launch.seeder,
            ..params
        }
    );
    assert_eq!(
        (created[0].creation_slot, created[0].creation_time),
        (9_000, 1_800_000_000)
    );
    let seeded: Vec<MarketSeeded> = events(&graduated.logs);
    assert_eq!(seeded.len(), 1);
    assert_eq!(seeded[0].market_state, market_state);
    assert_eq!(
        (seeded[0].token_amount, seeded[0].sol_amount),
        (TOKENS, LAMPORTS)
    );
    assert_eq!(seeded[0].sqrt_price, 1_844_674_407_370_955_161);
    assert_eq!(seeded[0].cap, TOKENS);
    assert_eq!(seeded[0].seed_time, 1_800_000_000);
}

#[test]
fn a_token_with_a_transfer_hook_graduates_with_its_hook_accounts() {
    let mut env = Env::new();
    let token = env.seedable_hooked_token();
    let launch = env.launch(token, TOKEN_2022, TOKENS, LAMPORTS);
    let graduated = env
        .graduate(
            &launch,
            &launch_params(Pubkey::new_unique()),
            TOKENS,
            LAMPORTS,
        )
        .unwrap();
    assert_eq!(graduated.graduation.taken, vec![TOKENS, LAMPORTS]);
    let market = &graduated.market;
    assert_eq!(env.balance(&market.token_vault), TOKENS);
    let trader = env.trader(market, 1_000_000_000, 2 * SOL);
    let quote = env.quote(market, &exact_in(1, 0, SOL)).unwrap();
    let swap = env
        .swap(market, &trader, (1, 0), TradeMode::ExactIn, SOL)
        .unwrap();
    assert_eq!(swap.received, quote.amount_out);
}

#[test]
fn the_graduation_transaction_fits_the_size_limit() {
    let mut env = Env::new();
    let data = borsh::to_vec(&launch_params(Pubkey::new_unique())).unwrap();
    let plain = env.seedable_token(&TOKEN);
    let token_2022 = env.seedable_token(&TOKEN_2022);
    let hooked = env.seedable_hooked_token();
    for (what, token, program) in [
        ("SPL Token", plain, TOKEN),
        ("Token-2022", token_2022, TOKEN_2022),
        ("Token-2022 with a transfer hook", hooked, TOKEN_2022),
    ] {
        let launch = env.launch(token, program, TOKENS, LAMPORTS);
        let creator = launch.creator.pubkey();
        let mut instructions = vec![env.graduate_ix(
            &launch,
            vec![TOKENS, LAMPORTS],
            data.clone(),
            env.seed_liquidity_accounts(&launch),
        )];
        instructions.extend(env.register_ixs(&creator, &launch.market()));
        // Paid for and signed by the creator alone, as a launchpad's user would send it.
        let size = transaction_size(&instructions, &creator, 0);
        println!(
            "graduate + register_existing_market + init_fee_account x2 ({what}): {size} bytes"
        );
        assert!(
            size <= 1_232,
            "{what}: {size} bytes is over the 1,232-byte limit"
        );
    }
}
