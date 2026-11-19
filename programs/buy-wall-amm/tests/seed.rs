//! The seed (docs/spec/pool4-for-solana.md, "The seed"): signed only by the stored seeder,
//! once, from token accounts the seeder owns, recording what actually arrived and opening
//! the market; and one transaction carrying `create_market`, both `init_fee_account` calls
//! and `seed` ("Creating a market").

mod common;

use buy_wall_amm::config::{MIN_SEED_LAMPORTS, SUITE_TREASURY};
use buy_wall_amm::errors::StrategyError::*;
use buy_wall_amm::events::{MarketCreated, MarketSeeded};
use buy_wall_amm::state::STATUS_OPEN;
use common::*;
use pipeline_client::{pda, AccountMeta, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// The worked example's seed: 1,000,000 tokens of 6 decimals and 10 SOL.
const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;

/// The worked example's parameters (docs/spec/pool4-for-solana.md, "Worked example").
fn worked_example_params(seeder: Pubkey) -> buy_wall_amm::InitParams {
    buy_wall_amm::InitParams {
        fee_bps: 100,
        wall_split_bps: 5_000,
        fee_recipient: Pubkey::new_unique(),
        reward_share_bps: 1_500,
        rewards_recipient: Pubkey::new_unique(),
        cap_floor_bps: 2_000,
        cap_decay_bps: 2_000,
        seeder,
    }
}

#[test]
fn one_transaction_creates_and_seeds_the_worked_example() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    env.set_clock(5_000, 1_800_000_000);
    let seeder = env.admin.pubkey();
    let params = worked_example_params(seeder);
    let (market, logs) = env
        .create_and_seed(token, TOKEN, &params, TOKENS, LAMPORTS)
        .unwrap();

    // The seed row of the worked example, exactly.
    let state = env.state(&market);
    assert_eq!(state.sqrt_price(), 1_844_674_407_370_955_161);
    assert_eq!(state.liquidity(), 99_999_999_999);
    assert_eq!(state.cap(), 1_000_000_000_000);
    // Everything else the seed sets.
    assert_eq!(state.status, STATUS_OPEN);
    assert_eq!((state.pool_tokens(), state.pool_sol()), (TOKENS, LAMPORTS));
    assert_eq!(state.seeded_tokens(), TOKENS);
    assert_eq!(state.cap_floor(), 200_000_000_000);
    assert_eq!(state.cap_decay_per_day(), 200_000_000_000);
    let s = state.sqrt_price();
    assert_eq!(
        (
            state.reference(),
            state.floor(),
            state.last_close(),
            state.low_since_placement()
        ),
        (s, s, s, s)
    );
    assert_eq!(state.seed_time(), 1_800_000_000);
    assert_eq!(state.decay_time(), 1_800_000_000);
    assert_eq!(state.ref_time(), 1_800_000_000);
    assert_eq!(state.floor_time(), 1_800_000_000);
    assert_eq!(state.last_slot(), 5_000);
    // Nothing a later ticket fills in has moved.
    assert_eq!(state.decay_credit(), 0);
    assert_eq!(
        (
            state.wall_liquidity(),
            state.wall_top(),
            state.wall_sol_placed()
        ),
        (0, 0, 0)
    );
    assert_eq!(
        (
            state.retired_tokens(),
            state.rewards_owed(),
            state.idle_sol()
        ),
        (0, 0, 0)
    );
    assert_eq!(
        (
            state.fees_recipient(),
            state.fees_designer(),
            state.fees_suite()
        ),
        (0, 0, 0)
    );
    assert_eq!((state.volume(0), state.volume(1)), (Some(0), Some(0)));
    assert_eq!((state.fees_collected(), state.swap_count()), (0, 0));
    assert!(state.reserve.iter().all(|&b| b == 0));

    // The vaults hold exactly the seed.
    assert_eq!(env.balance(&market.token_vault), TOKENS);
    assert_eq!(env.balance(&market.sol_vault), LAMPORTS);
    let seeder_token = pda::associated_token(&seeder, &token, &TOKEN);
    assert_eq!(env.balance(&seeder_token), 0);

    // Both instructions emitted their events.
    let created: Vec<MarketCreated> = events(&logs);
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].market_state, market.market_state);
    assert_eq!(created[0].params, params);
    assert_eq!(created[0].token_mint, token);
    let seeded: Vec<MarketSeeded> = events(&logs);
    assert_eq!(seeded.len(), 1);
    assert_eq!(seeded[0].market_state, market.market_state);
    assert_eq!(
        (seeded[0].token_amount, seeded[0].sol_amount),
        (TOKENS, LAMPORTS)
    );
    assert_eq!(seeded[0].sqrt_price, s);
    assert_eq!(seeded[0].liquidity, 99_999_999_999);
    assert_eq!(seeded[0].cap, TOKENS);
    assert_eq!(seeded[0].seed_time, 1_800_000_000);
    // The suite treasury is a constant of the program, not a creation parameter.
    assert_ne!(SUITE_TREASURY, Pubkey::default());
}

#[test]
fn the_one_transaction_fits_the_size_limit() {
    let env = Env::new();
    let market_state = Keypair::new();
    let token = Pubkey::new_unique();
    let admin = env.admin.pubkey();
    let data = borsh::to_vec(&worked_example_params(admin)).unwrap();
    for program in [TOKEN, TOKEN_2022] {
        let (market, create) = env.create_market_ix(&market_state, token, program, data.clone());
        let mut instructions = vec![create];
        instructions.extend(env.fee_account_ixs(&market));
        instructions.push(seed_ix(&market, &admin, TOKENS, LAMPORTS, vec![]));
        let size = transaction_size(&instructions, &admin, 1);
        println!("create_market + init_fee_account x2 + seed ({program}): {size} bytes");
        assert!(size <= 1_232, "{size} bytes is over the 1,232-byte limit");
    }
}

#[test]
fn a_seed_records_what_arrived_not_what_was_in_the_vaults() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let seeder = env.admin.pubkey();
    let market = env
        .create_market(token, TOKEN, &worked_example_params(seeder))
        .unwrap();
    // Donations to both vaults before the seed.
    let donor = Pubkey::new_unique();
    env.fund(&donor, &token, &TOKEN, 0, 0);
    let donor_token = pda::associated_token(&donor, &token, &TOKEN);
    let mut account = env.svm.get_account(&market.token_vault).unwrap();
    account.data[64..72].copy_from_slice(&777u64.to_le_bytes());
    env.svm.set_account(market.token_vault, account).unwrap();
    let mut account = env.svm.get_account(&market.sol_vault).unwrap();
    account.data[64..72].copy_from_slice(&555u64.to_le_bytes());
    account.lamports += 555;
    env.svm.set_account(market.sol_vault, account).unwrap();
    assert!(env.svm.get_account(&donor_token).is_some());

    env.fund(&seeder, &token, &TOKEN, TOKENS, LAMPORTS);
    env.send(&[seed_ix(&market, &seeder, TOKENS, LAMPORTS, vec![])], &[])
        .unwrap();
    let state = env.state(&market);
    assert_eq!((state.pool_tokens(), state.pool_sol()), (TOKENS, LAMPORTS));
    assert_eq!(state.sqrt_price(), 1_844_674_407_370_955_161);
    assert_eq!(env.balance(&market.token_vault), TOKENS + 777);
    assert_eq!(env.balance(&market.sol_vault), LAMPORTS + 555);
}

/// A created market and a funded seeder, ready to try a seed.
fn created(env: &mut Env, token: Pubkey, seeder: &Keypair) -> Market {
    let market = env
        .create_market(token, TOKEN, &worked_example_params(seeder.pubkey()))
        .unwrap();
    env.svm.airdrop(&seeder.pubkey(), SOL).unwrap();
    env.fund(&seeder.pubkey(), &token, &TOKEN, TOKENS, LAMPORTS);
    market
}

/// The seed refuses a stored cap floor above 10,000 basis points itself, rather than opening
/// a market whose cap starts below its floor, where every buy would revert. Creation never
/// stores such a value, so the market state is edited here by hand, as a faulty layout
/// upgrade might leave it.
#[test]
fn sos_h023_the_seed_refuses_a_stored_cap_floor_above_10000_basis_points() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let seeder = Keypair::new();
    let market = created(&mut env, token, &seeder);
    let mut account = env.svm.get_account(&market.market_state).unwrap();
    let state: &mut buy_wall_amm::state::MarketState =
        bytemuck::from_bytes_mut(&mut account.data[8..]);
    state.set_cap_floor_bps(10_001);
    env.svm.set_account(market.market_state, account).unwrap();
    let ix = seed_ix(&market, &seeder.pubkey(), TOKENS, LAMPORTS, vec![]);
    assert_refused(env.send(&[ix], &[&seeder]), CapFloorOutOfRange);
    assert_eq!(env.state(&market).pool_tokens(), 0);
}

#[test]
fn only_the_stored_seeder_may_seed_and_only_once() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let seeder = Keypair::new();
    let market = created(&mut env, token, &seeder);

    // Anyone else, even holding the tokens, is refused.
    let other = Keypair::new();
    env.svm.airdrop(&other.pubkey(), SOL).unwrap();
    env.fund(&other.pubkey(), &token, &TOKEN, TOKENS, LAMPORTS);
    let ix = seed_ix(&market, &other.pubkey(), TOKENS, LAMPORTS, vec![]);
    assert_refused(env.send(&[ix], &[&other]), NotSeeder);
    // The seeder's key without its signature is refused too.
    let mut ix = seed_ix(&market, &seeder.pubkey(), TOKENS, LAMPORTS, vec![]);
    ix.accounts[0].is_signer = false;
    assert_fails(env.send(&[ix], &[]));

    let ix = seed_ix(&market, &seeder.pubkey(), TOKENS / 2, LAMPORTS / 2, vec![]);
    env.send(&[ix], &[&seeder]).unwrap();
    let ix = seed_ix(&market, &seeder.pubkey(), TOKENS / 2, LAMPORTS / 2, vec![]);
    assert_refused(env.send(&[ix], &[&seeder]), AlreadySeeded);
    assert_eq!(env.state(&market).pool_tokens(), TOKENS / 2);
}

#[test]
fn a_seed_comes_only_from_token_accounts_the_seeder_owns() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let seeder = Keypair::new();
    let market = created(&mut env, token, &seeder);
    // Someone else's accounts, which the seeder could spend only as a delegate.
    let owner = Keypair::new();
    env.fund(&owner.pubkey(), &token, &TOKEN, TOKENS, LAMPORTS);
    for (index, mint, program) in [(2, token, TOKEN), (3, WSOL, TOKEN)] {
        let theirs = pda::associated_token(&owner.pubkey(), &mint, &program);
        let mut account = env.svm.get_account(&theirs).unwrap();
        // Delegate the whole balance to the seeder (COption<Pubkey> delegate, amount).
        account.data[72..76].copy_from_slice(&1u32.to_le_bytes());
        account.data[76..108].copy_from_slice(seeder.pubkey().as_ref());
        account.data[121..129].copy_from_slice(&u64::MAX.to_le_bytes());
        env.svm.set_account(theirs, account).unwrap();
        let mut ix = seed_ix(&market, &seeder.pubkey(), TOKENS, LAMPORTS, vec![]);
        ix.accounts[index] = AccountMeta::new(theirs, false);
        assert_fails(env.send(&[ix], &[&seeder]));
    }
    assert_eq!(env.state(&market).status, 1);
}

#[test]
fn substituted_vaults_mints_and_market_states_are_refused() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let seeder = Keypair::new();
    let market = created(&mut env, token, &seeder);
    let other_token = env.seedable_token(&TOKEN);
    let other = created(&mut env, other_token, &seeder);
    env.fund(&seeder.pubkey(), &token, &TOKEN, TOKENS, LAMPORTS);

    let attempt = |env: &mut Env, index: usize, key: Pubkey| {
        let mut ix = seed_ix(&market, &seeder.pubkey(), TOKENS, LAMPORTS, vec![]);
        ix.accounts[index].pubkey = key;
        env.send(&[ix], &[&seeder])
    };
    // Another market's vaults, the two vaults swapped, and the seeder's own accounts.
    assert_refused(attempt(&mut env, 4, other.token_vault), WrongAccount);
    assert_refused(attempt(&mut env, 5, other.sol_vault), WrongAccount);
    assert_refused(attempt(&mut env, 4, market.sol_vault), WrongAccount);
    let seeder_sol = pda::associated_token(&seeder.pubkey(), &WSOL, &TOKEN);
    assert_refused(attempt(&mut env, 5, seeder_sol), WrongAccount);
    // Another mint, or wrapped SOL in the token's place.
    assert_fails(attempt(&mut env, 6, other_token));
    assert_fails(attempt(&mut env, 6, WSOL));
    // Not a market state: a token account, and the router's market account.
    assert_fails(attempt(&mut env, 1, market.token_vault));
    assert_fails(attempt(&mut env, 1, market.market));

    // Unchanged, it works.
    env.send(
        &[seed_ix(&market, &seeder.pubkey(), TOKENS, LAMPORTS, vec![])],
        &[&seeder],
    )
    .unwrap();
}

#[test]
fn a_seed_is_refused_while_the_mint_or_freeze_authority_is_live() {
    let mut env = Env::new();
    let seeder = Keypair::new();
    // A live mint authority (and no freeze authority).
    let minting = env.create_mint(&TOKEN, 6);
    let market = created(&mut env, minting, &seeder);
    let ix = seed_ix(&market, &seeder.pubkey(), TOKENS, LAMPORTS, vec![]);
    assert_refused(env.send(&[ix], &[&seeder]), MintAuthorityLive);
    // A freeze authority, with the mint authority removed.
    let freezing = env.create_mint_with(&TOKEN, 6, &[], true);
    {
        use spl_token_2022_interface::instruction::{set_authority, AuthorityType};
        let admin = env.admin.pubkey();
        let ix = set_authority(
            &TOKEN,
            &freezing,
            None,
            AuthorityType::MintTokens,
            &admin,
            &[],
        )
        .unwrap();
        env.send(&[ix], &[]).unwrap();
    }
    let market = created(&mut env, freezing, &seeder);
    let ix = seed_ix(&market, &seeder.pubkey(), TOKENS, LAMPORTS, vec![]);
    assert_refused(env.send(&[ix], &[&seeder]), FreezeAuthorityLive);
    // With both removed, it works.
    env.revoke_authorities(&freezing, &TOKEN);
    let ix = seed_ix(&market, &seeder.pubkey(), TOKENS, LAMPORTS, vec![]);
    env.send(&[ix], &[&seeder]).unwrap();
}

/// A created market of `token`, a Token-2022 token, whose seeder is the admin, funded
/// with the worked example's seed; and the seed itself, with the token's transfer-hook
/// accounts as they are now.
fn created_hooked(env: &mut Env, token: Pubkey) -> (Market, pipeline_client::Instruction) {
    let admin = env.admin.pubkey();
    let market = env
        .create_market(token, TOKEN_2022, &worked_example_params(admin))
        .unwrap();
    env.fund(&admin, &token, &TOKEN_2022, TOKENS, LAMPORTS);
    let hooks = env.hook_accounts(
        &token,
        pda::associated_token(&admin, &token, &TOKEN_2022),
        market.token_vault,
        admin,
    );
    let ix = seed_ix(&market, &admin, TOKENS, LAMPORTS, hooks);
    (market, ix)
}

/// Finding H001 (`POOL4-48`): whoever can still set a token's transfer hook could, once
/// holders have bought, make it refuse every sell but its own and sell into the curve and
/// the wall, so the seed refuses a token whose hook program or hook authority is still set,
/// as it refuses a live mint or freeze authority, and nothing moves.
#[test]
fn sos_h001_a_seed_is_refused_while_the_tokens_transfer_hook_is_live() {
    for (what, clear_program, clear_authority) in [
        ("program and authority set", false, false),
        ("authority removed, program still set", false, true),
        ("program removed, authority still set", true, false),
    ] {
        let mut env = Env::new();
        let token = env.hooked_token();
        env.clear_transfer_hook(&token, clear_program, clear_authority);
        let (market, ix) = created_hooked(&mut env, token);
        let refused = env.send(&[ix], &[]);
        println!("{what}: {refused:?}");
        assert_refused(refused, TransferHookLive);
        assert_eq!(env.state(&market).status, 1, "{what}: still waiting");
        assert_eq!(env.balance(&market.token_vault), 0, "{what}");
        assert_eq!(env.balance(&market.sol_vault), 0, "{what}");

        // Clearing what is left of the hook lets the same seed through, when the hook
        // authority is still there to clear the program; without it the program stays set
        // for good and the token can never be seeded.
        if clear_authority {
            continue;
        }
        env.clear_transfer_hook(&token, !clear_program, true);
        let ix = seed_ix(&market, &env.admin.pubkey(), TOKENS, LAMPORTS, vec![]);
        env.send(&[ix], &[]).unwrap();
        assert_eq!(env.state(&market).status, STATUS_OPEN, "{what}");
        assert_eq!(env.balance(&market.token_vault), TOKENS, "{what}");
    }
}

/// Finding H001 (`POOL4-48`): a token whose transfer hook was cleared, both its program and
/// its authority unset, as a contained token's is after its unlock, seeds and trades as any
/// Token-2022 token does, with no hook accounts and no hook called.
#[test]
fn sos_h001_a_token_whose_transfer_hook_was_cleared_seeds_and_trades() {
    let mut env = Env::new();
    let token = env.seedable_hooked_token();
    assert_eq!(env.hook_program(&token), None);
    let admin = env.admin.pubkey();
    let (market, logs) = env
        .create_and_seed(
            token,
            TOKEN_2022,
            &worked_example_params(admin),
            TOKENS,
            LAMPORTS,
        )
        .unwrap();
    let state = env.state(&market);
    assert_eq!(state.status, STATUS_OPEN);
    assert_eq!(state.sqrt_price(), 1_844_674_407_370_955_161);
    let trader = env.trader(&market, 1_000_000_000, 2 * SOL);
    env.set_clock(5_000, 1_800_003_600);
    let bought = env
        .swap(
            &market,
            &trader,
            (1, 0),
            pipeline_client::TradeMode::ExactIn,
            SOL,
        )
        .unwrap();
    let sold = env
        .swap(
            &market,
            &trader,
            (0, 1),
            pipeline_client::TradeMode::ExactIn,
            bought.received,
        )
        .unwrap();
    assert!(bought.received > 0 && sold.received > 0);
    let hook = format!("Program {TEST_HOOK_PROGRAM} invoke");
    assert!(!logs.iter().any(|line| line.starts_with(&hook)));
}

#[test]
fn each_seed_bound_is_refused_on_the_wrong_side() {
    let mut env = Env::new();
    let admin = env.admin.pubkey();
    let mut params = worked_example_params(admin);

    // MIN_SEED_LAMPORTS: one lamport short, then exactly.
    let token = env.seedable_token(&TOKEN);
    assert_refused(
        env.create_and_seed(token, TOKEN, &params, TOKENS, MIN_SEED_LAMPORTS - 1),
        SeedTooSmall,
    );
    env.create_and_seed(token, TOKEN, &params, TOKENS, MIN_SEED_LAMPORTS)
        .unwrap();
    // No tokens at all.
    assert_refused(
        env.create_and_seed(token, TOKEN, &params, 0, LAMPORTS),
        EmptySeed,
    );

    // The highest opening price, 2^88: 1,024 units against 2^58 lamports opens exactly
    // there, one lamport more is above it. (No seed can reach the lowest opening price,
    // 2^40; see `opening::tests::no_seed_can_open_below_the_lowest_opening_price`.)
    params.cap_floor_bps = 10_000;
    let (x, y) = (1u64 << 10, 1u64 << 58);
    let (market, _) = env.create_and_seed(token, TOKEN, &params, x, y).unwrap();
    assert_eq!(env.state(&market).sqrt_price(), 1u128 << 88);
    assert_refused(
        env.create_and_seed(token, TOKEN, &params, x, y + 1),
        OpeningPriceOutOfBounds,
    );

    // The curve at the cap floor: at a price of one lamport per unit, 101,000,000 units
    // with a floor of 100 basis points hold 1,010,000 >= MIN_LIQUIDITY; 99 basis points
    // hold 999,900.
    let (x, y) = (101_000_000u64, 101_000_000u64);
    params.cap_floor_bps = 100;
    env.create_and_seed(token, TOKEN, &params, x, y).unwrap();
    params.cap_floor_bps = 99;
    assert_refused(
        env.create_and_seed(token, TOKEN, &params, x, y),
        CapFloorTooThin,
    );
}
