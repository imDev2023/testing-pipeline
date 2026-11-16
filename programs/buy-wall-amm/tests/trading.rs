//! Plain trading through the real router (docs/spec/pool4-for-solana.md, "Pricing", "After
//! pricing" steps 2, 3 and 7, "The fee", "Ledgers" and "Counters"): a seeded market trades
//! both ways on its constant-product curve, exact-in, its fee taken in SOL and split into
//! ledgers, nothing paid out to anyone but the trader, donations never credited, and every
//! quote equal to its swap.

mod common;

use buy_wall_amm::config::{MAX_FEE_BPS, MIN_FEE_BPS};
use buy_wall_amm::errors::StrategyError::*;
use buy_wall_amm::state::MarketState;
use common::*;
use pipeline_client::{pda, Pubkey, TradeMode};
use solana_signer::Signer;

const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;
const BUY: (usize, usize) = (1, 0);
const SELL: (usize, usize) = (0, 1);

/// The fee split as the spec writes it, computed here on its own rather than with the
/// program's `FeeSplit`: (designer, suite, wall, recipient).
fn expected_split(fee: u64, wall_split_bps: u16) -> (u64, u64, u64, u64) {
    let designer = fee / 10;
    let suite = fee / 10;
    let rest = fee - designer - suite;
    let wall = (rest as u128 * wall_split_bps as u128 / 10_000) as u64;
    (designer, suite, wall, rest - wall)
}

fn fee_ledgers(state: &MarketState) -> (u64, u64, u64, u64) {
    (
        state.fees_designer(),
        state.fees_suite(),
        state.idle_sol(),
        state.fees_recipient(),
    )
}

/// Every vault holds exactly the sum of its ledgers, as it does with no donation.
fn assert_vaults_match_ledgers(env: &Env, market: &Market) {
    let state = env.state(market);
    assert_eq!(
        env.balance(&market.token_vault) as u128,
        state.pool_tokens() as u128 + state.retired_tokens() as u128 + state.rewards_owed() as u128
    );
    assert_eq!(
        env.balance(&market.sol_vault) as u128,
        state.pool_sol() as u128
            + state.idle_sol() as u128
            + state.fees_recipient() as u128
            + state.fees_designer() as u128
            + state.fees_suite() as u128
    );
}

fn seeded(env: &mut Env, fee_bps: u16, wall_split_bps: u16) -> Market {
    let token = env.seedable_token(&TOKEN);
    let mut params = launch_params(env.admin.pubkey());
    params.fee_bps = fee_bps;
    params.wall_split_bps = wall_split_bps;
    env.create_and_seed(token, TOKEN, &params, TOKENS, LAMPORTS)
        .unwrap()
        .0
}

#[test]
fn the_worked_example_trades_at_the_spec_numbers_through_the_router() {
    // Seeded with 1,000,000 tokens of 6 decimals and 10 SOL, fee 100, wall split 5,000
    // (docs/spec/pool4-for-solana.md, "Worked example").
    let mut env = Env::new();
    let market = seeded(&mut env, 100, 5_000);
    // Pipeline's 0.25% comes on top of each input, so the trader holds a little more.
    let trader = env.trader(&market, 1_000_000_000, 2 * SOL);
    let token_account = pda::associated_token(&trader.pubkey(), &market.token_mint, &TOKEN);
    let opened = env.state(&market);

    // One hour later, a buy of 1 SOL.
    let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    env.set_clock(clock.slot + 9_000, clock.unix_timestamp + 3_600);
    let quote = env.quote(&market, &exact_in(1, 0, SOL)).unwrap();
    let bought = env
        .swap(&market, &trader, BUY, TradeMode::ExactIn, SOL)
        .unwrap();
    assert_eq!(quote.amount_out, 90_081_892_629);
    assert_eq!(bought.received, 90_081_892_629);
    assert_eq!(bought.net_sent, SOL);
    assert_eq!(env.balance(&token_account), 1_000_000_000 + 90_081_892_629);
    let state = env.state(&market);
    assert_eq!(state.sqrt_price(), 2_027_297_173_702_505_949);
    assert_eq!(state.last_close(), 2_027_297_173_702_505_949);
    assert_eq!(
        fee_ledgers(&state),
        (1_000_000, 1_000_000, 4_000_000, 4_000_000)
    );
    assert_eq!(state.pool_sol(), LAMPORTS + SOL - 10_000_000);
    assert_eq!(state.pool_tokens(), TOKENS - 90_081_892_629);
    assert_eq!(state.liquidity(), opened.liquidity());
    assert_eq!(
        (state.volume(0), state.volume(1)),
        (Some(90_081_892_629), Some(SOL as u128))
    );
    assert_eq!(
        (state.fees_collected(), state.swap_count()),
        (10_000_000, 1)
    );
    assert_vaults_match_ledgers(&env, &market);

    // 60 seconds later, a sell of those units.
    let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    env.set_clock(clock.slot + 150, clock.unix_timestamp + 60);
    let quote = env.quote(&market, &exact_in(0, 1, 90_081_892_629)).unwrap();
    let sold = env
        .swap(&market, &trader, SELL, TradeMode::ExactIn, 90_081_892_629)
        .unwrap();
    assert_eq!(quote.amount_out, 980_099_999);
    assert_eq!(sold.received, 980_099_999);
    let state = env.state(&market);
    assert_eq!(state.sqrt_price(), 1_844_674_407_372_029_099);
    // Gross 989,999,999 left the pool: 980,099,999 to the trader and the fee of 9,900,000,
    // 3,960,000 of it to the wall. The sell left the curve above the cap the buy lowered,
    // so the trim then moved 8,333,333,329 units to the retired tokens and 83,333,332
    // lamports to idle SOL (tests/cap.rs checks the cap's numbers).
    let (trimmed_tokens, trimmed_sol) = (8_333_333_329, 83_333_332);
    assert_eq!(
        state.pool_sol(),
        LAMPORTS + SOL - 10_000_000 - 989_999_999 - trimmed_sol
    );
    assert_eq!(state.pool_tokens(), TOKENS - trimmed_tokens);
    assert_eq!(state.retired_tokens(), trimmed_tokens);
    assert_eq!(
        fee_ledgers(&state),
        (
            1_000_000 + 990_000,
            1_000_000 + 990_000,
            4_000_000 + 3_960_000 + trimmed_sol,
            4_000_000 + 3_960_000
        )
    );
    assert_eq!(
        (state.volume(0), state.volume(1)),
        (Some(2 * 90_081_892_629), Some(SOL as u128 + 980_099_999))
    );
    assert_eq!(
        (state.fees_collected(), state.swap_count()),
        (19_900_000, 2)
    );
    // The wall guard is a later ticket's: trading leaves it as the seed set it.
    assert_eq!(state.cap(), 991_666_666_667);
    assert_eq!(
        (state.floor(), state.reference(), state.wall_liquidity()),
        (opened.floor(), opened.reference(), 0)
    );
    assert_vaults_match_ledgers(&env, &market);
}

#[test]
fn the_fee_is_taken_in_sol_both_ways_and_split_at_every_rate_and_wall_split() {
    for fee_bps in [MIN_FEE_BPS, 100, MAX_FEE_BPS] {
        for wall_split_bps in [0, 5_000, 10_000] {
            let mut env = Env::new();
            let market = seeded(&mut env, fee_bps, wall_split_bps);
            let trader = env.trader(&market, 50_000_000_000, 3 * SOL);
            let what = format!("fee {fee_bps}, wall split {wall_split_bps}");

            // A buy: the fee comes off the SOL coming in.
            let before = env.state(&market);
            let bought = env
                .swap(&market, &trader, BUY, TradeMode::ExactIn, 2 * SOL + 7)
                .unwrap();
            let after = env.state(&market);
            let fee = ((2 * SOL + 7) as u128 * fee_bps as u128).div_ceil(10_000) as u64;
            assert_eq!(
                after.fees_collected() - before.fees_collected(),
                fee as u128,
                "{what}"
            );
            let (d, s, w, r) = expected_split(fee, wall_split_bps);
            assert_eq!(fee_ledgers(&after), (d, s, w, r), "{what}: buy");
            assert_eq!(
                after.pool_sol() - before.pool_sol(),
                2 * SOL + 7 - fee,
                "{what}"
            );
            assert_eq!(
                before.pool_tokens() - after.pool_tokens(),
                bought.received,
                "{what}"
            );

            // A sell: the fee comes off the SOL going out, never off the token.
            let before = after;
            let sold = env
                .swap(&market, &trader, SELL, TradeMode::ExactIn, 40_000_000_000)
                .unwrap();
            let after = env.state(&market);
            let gross = before.pool_sol() - after.pool_sol();
            let fee = (gross as u128 * fee_bps as u128).div_ceil(10_000) as u64;
            assert_eq!(sold.received, gross - fee, "{what}");
            assert_eq!(
                after.fees_collected() - before.fees_collected(),
                fee as u128,
                "{what}"
            );
            let (d2, s2, w2, r2) = expected_split(fee, wall_split_bps);
            assert_eq!(
                fee_ledgers(&after),
                (d + d2, s + s2, w + w2, r + r2),
                "{what}: sell"
            );
            assert_eq!(
                after.pool_tokens() - before.pool_tokens(),
                40_000_000_000,
                "{what}"
            );
            assert_eq!(after.swap_count(), 2, "{what}");
            assert_vaults_match_ledgers(&env, &market);
        }
    }
}

#[test]
fn every_quote_equals_its_swap_both_ways_at_every_size() {
    let mut env = Env::new();
    let market = seeded(&mut env, 100, 5_000);
    let trader = env.trader(&market, 10_000_000_000_000, 500 * SOL);
    for amount in [2, 101, 1_000_000, 123_456_789, SOL, 7 * SOL, 100 * SOL] {
        for (direction, request) in [
            (BUY, exact_in(1, 0, amount)),
            (SELL, exact_in(0, 1, amount * 50)),
        ] {
            let quote = env.quote(&market, &request);
            let swap = env.swap(
                &market,
                &trader,
                direction,
                TradeMode::ExactIn,
                request.amount,
            );
            match (quote, swap) {
                (Ok(quote), Ok(swap)) => {
                    assert_eq!(swap.received, quote.amount_out, "{request:?}");
                    assert_eq!(quote.amount_in, request.amount);
                }
                (Err(_), Err(_)) => {}
                (quote, swap) => panic!("{request:?}: quote {quote:?}, swap {swap:?}"),
            }
        }
    }
    assert_vaults_match_ledgers(&env, &market);
}

#[test]
fn a_swap_pays_nobody_but_the_trader() {
    let mut env = Env::new();
    let market = seeded(&mut env, MAX_FEE_BPS, 5_000);
    let trader = env.trader(&market, 10_000_000_000, 2 * SOL);
    let sol_vault = env.balance(&market.sol_vault);
    env.swap(&market, &trader, BUY, TradeMode::ExactIn, SOL)
        .unwrap();
    // All of the buy's SOL stays in the vault, its fee included.
    assert_eq!(env.balance(&market.sol_vault), sol_vault + SOL);
    let sol_vault = env.balance(&market.sol_vault);
    let sold = env
        .swap(&market, &trader, SELL, TradeMode::ExactIn, 10_000_000_000)
        .unwrap();
    // Only the trader's output leaves; the fee stays.
    assert_eq!(env.balance(&market.sol_vault), sol_vault - sold.received);
    // The swap's own accounts name no recipient: the router's ten, the output vault and
    // the vault authority, nothing else.
    let ix = env.swap_ix(&market, &trader.pubkey(), BUY, TradeMode::ExactIn, SOL, 0);
    let params = launch_params(env.admin.pubkey());
    for account in &ix.accounts {
        assert_ne!(account.pubkey, params.fee_recipient);
        assert_ne!(account.pubkey, buy_wall_amm::config::SUITE_TREASURY);
    }
}

#[test]
fn donations_to_either_vault_are_never_credited_or_paid_out() {
    // Two identical markets, one of them sent tokens and SOL straight into its vaults:
    // the same trades give the same output, price and books in both.
    let mut env = Env::new();
    let plain = seeded(&mut env, 100, 5_000);
    let donated = seeded(&mut env, 100, 5_000);
    let donor = env.trader(&donated, 77_000_000, 5 * SOL);
    for (mint, program, vault, amount, decimals) in [
        (
            donated.token_mint,
            TOKEN,
            donated.token_vault,
            77_000_000,
            6,
        ),
        (WSOL, TOKEN, donated.sol_vault, 5 * SOL, 9),
    ] {
        let from = pda::associated_token(&donor.pubkey(), &mint, &program);
        let ix = spl_token_2022_interface::instruction::transfer_checked(
            &program,
            &from,
            &mint,
            &vault,
            &donor.pubkey(),
            &[],
            amount,
            decimals,
        )
        .unwrap();
        env.send(&[ix], &[&donor]).unwrap();
    }
    let traders = [
        env.trader(&plain, 20_000_000_000, 2 * SOL),
        env.trader(&donated, 20_000_000_000, 2 * SOL),
    ];
    for (direction, amount) in [(BUY, SOL), (SELL, 20_000_000_000), (BUY, SOL / 3)] {
        let request = exact_in(direction.0, direction.1, amount);
        assert_eq!(env.quote(&plain, &request), env.quote(&donated, &request));
        let a = env
            .swap(&plain, &traders[0], direction, TradeMode::ExactIn, amount)
            .unwrap();
        let b = env
            .swap(&donated, &traders[1], direction, TradeMode::ExactIn, amount)
            .unwrap();
        assert_eq!(a.received, b.received);
        let (sa, sb) = (env.state(&plain), env.state(&donated));
        assert_eq!(sa.sqrt_price(), sb.sqrt_price());
        assert_eq!(sa.books(), sb.books());
        assert_eq!(sa.counters(), sb.counters());
    }
    // The donations sit in the vaults beyond every ledger, untouched.
    let state = env.state(&donated);
    assert_eq!(
        env.balance(&donated.token_vault) - state.recorded(0).unwrap(),
        77_000_000
    );
    assert_eq!(
        env.balance(&donated.sol_vault) - state.recorded(1).unwrap(),
        5 * SOL
    );
    assert_vaults_match_ledgers(&env, &plain);
}

#[test]
fn quotes_change_nothing_and_counters_move_only_with_router_swaps() {
    let mut env = Env::new();
    let market = seeded(&mut env, 100, 5_000);
    let before = env.market_state(&market);
    for request in [exact_in(1, 0, SOL), exact_in(0, 1, 1_000_000_000)] {
        env.quote(&market, &request).unwrap();
        env.resolve(&market, &request).unwrap();
    }
    assert_eq!(env.market_state(&market), before);
    // A refused swap changes nothing either.
    let trader = env.trader(&market, 0, SOL);
    assert_refused(
        env.swap(&market, &trader, BUY, TradeMode::ExactIn, 1),
        NothingAfterFee,
    );
    assert_eq!(env.market_state(&market), before);
}

#[test]
fn refusals_reach_the_trader_through_the_router() {
    let mut env = Env::new();
    let market = seeded(&mut env, 100, 5_000);
    let trader = env.trader(&market, 1_000_000, SOL);
    // One lamport pays a one-lamport fee and leaves nothing to buy with.
    assert_refused(
        env.swap(&market, &trader, BUY, TradeMode::ExactIn, 1),
        NothingAfterFee,
    );
    assert_refused(env.quote(&market, &exact_in(1, 0, 1)), NothingAfterFee);
    // At about 0.01 lamport a unit, one unit frees nothing.
    assert_refused(
        env.swap(&market, &trader, SELL, TradeMode::ExactIn, 1),
        ZeroOutput,
    );
    assert_refused(env.quote(&market, &exact_in(0, 1, 1)), ZeroOutput);
    assert_refused(env.quote(&market, &exact_in(0, 1, 0)), ZeroInput);
    assert_refused(env.quote(&market, &exact_in(1, 0, 0)), ZeroInput);
    // Exact-out is refused by the strategy's quote and, since the market reports no
    // exact-out support, by the router's swap.
    for (input, output) in [(0, 1), (1, 0)] {
        assert_refused(
            env.quote(&market, &trade(TradeMode::ExactOut, input, output, 1_000)),
            ExactOutNotSupported,
        );
        assert_fails(env.swap(
            &market,
            &trader,
            (input, output),
            TradeMode::ExactOut,
            1_000,
        ));
    }
    assert!(
        !env.market_info(&market.market_state)
            .unwrap()
            .supports_exact_out
    );
    // A minimum one unit above the quote fails the whole swap.
    let quote = env.quote(&market, &exact_in(1, 0, SOL / 10)).unwrap();
    assert_fails(env.swap_logged(
        &market,
        &trader,
        BUY,
        TradeMode::ExactIn,
        SOL / 10,
        quote.amount_out + 1,
    ));
    env.swap_logged(
        &market,
        &trader,
        BUY,
        TradeMode::ExactIn,
        SOL / 10,
        quote.amount_out,
    )
    .unwrap();
}

#[test]
fn quotes_and_swaps_are_refused_before_the_seed() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let market = env
        .create_market(token, TOKEN, &launch_params(env.admin.pubkey()))
        .unwrap();
    let trader = env.trader(&market, TOKENS, LAMPORTS);
    for (input, output) in [(0, 1), (1, 0)] {
        assert_refused(
            env.quote(&market, &exact_in(input, output, 1_000_000)),
            MarketNotOpen,
        );
        assert_refused(
            env.swap(
                &market,
                &trader,
                (input, output),
                TradeMode::ExactIn,
                1_000_000,
            ),
            MarketNotOpen,
        );
    }
}

#[test]
fn a_token_with_a_transfer_hook_is_bought_and_sold_through_the_router() {
    let mut env = Env::new();
    let token = env.seedable_hooked_token();
    let market = env
        .create_and_seed_hooked(token, &launch_params(env.admin.pubkey()), TOKENS, LAMPORTS)
        .unwrap();
    let trader = env.trader(&market, 1_000_000_000, 2 * SOL);
    let quote = env.quote(&market, &exact_in(1, 0, SOL)).unwrap();
    let bought = env
        .swap(&market, &trader, BUY, TradeMode::ExactIn, SOL)
        .unwrap();
    assert_eq!(bought.received, quote.amount_out);
    assert_eq!(bought.received, 90_081_892_629);
    let quote = env
        .quote(&market, &exact_in(0, 1, bought.received))
        .unwrap();
    let sold = env
        .swap(&market, &trader, SELL, TradeMode::ExactIn, bought.received)
        .unwrap();
    assert_eq!(sold.received, quote.amount_out);
    assert_eq!(sold.received, 980_099_999);
    assert_vaults_match_ledgers(&env, &market);

    // Without the hook's accounts, the buy's transfer out of the vault fails.
    let mut ix = env.swap_ix(&market, &trader.pubkey(), BUY, TradeMode::ExactIn, SOL, 0);
    ix.accounts.truncate(
        ix.accounts.len()
            - env
                .hook_accounts(
                    &token,
                    market.token_vault,
                    Pubkey::default(),
                    market.vault_authority,
                )
                .len(),
    );
    assert_fails(env.send(&[ix], &[&trader]));
}
