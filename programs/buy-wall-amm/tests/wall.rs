//! The buy wall through the real router (docs/spec/pool4-for-solana.md, "A sell", "A buy",
//! "After pricing" steps 1 and 4, "`place_wall`", "Worked example", "Done means"): idle SOL
//! becomes a SOL-only stretch of liquidity below the price when anyone calls `place_wall`;
//! trades move through the curve and the wall together at or below its top and through the
//! curve alone above it, in at most two steps, with quotes equal to swaps; a guard of a
//! lagged reference and a slowly rising floor keeps the wall from being placed at a pumped
//! price, so pumping, placing the wall and dumping never pays.

mod common;

use buy_wall_amm::cap::SECONDS_PER_DAY as DAY;
use buy_wall_amm::config::{
    FLOOR_CRAWL_BPS, KEEPER_TIP_CAP, MIN_SQRT_PRICE, REF_STEP_BPS, REF_STEP_WINDOW, WALL_THRESHOLD,
};
use buy_wall_amm::events::WallPlaced;
use buy_wall_amm::math::U256;
use buy_wall_amm::params::BPS;
use buy_wall_amm::state::MarketState;
use common::*;
use pipeline_client::{pda, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;

const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;
const BUY: (usize, usize) = (1, 0);
const SELL: (usize, usize) = (0, 1);

/// The spec's two-step pricing, written out here from "A sell" and "A buy" in their own order
/// (`need` first, then the comparison), with the program's 256-bit type for arithmetic only,
/// so the tests check the program against the spec rather than against itself.
mod spec {
    use super::*;
    use buy_wall_amm::config::MAX_SQRT_PRICE;

    pub struct Priced {
        pub fee: u64,
        pub out: u64,
        pub sqrt_price: u128,
    }

    fn ceil_bps(amount: u64, bps: u16) -> u64 {
        (amount as u128 * bps as u128).div_ceil(10_000) as u64
    }

    pub fn sell(state: &MarketState, a: u64) -> Option<Priced> {
        let (l, w, top) = (state.liquidity(), state.wall_liquidity(), state.wall_top());
        let (mut remaining, mut gross, mut s) = (a as u128, 0u128, state.sqrt_price());
        for _ in 0..2 {
            let (liq, target) = if w > 0 && s > top {
                (l, top)
            } else {
                (l + w, MIN_SQRT_PRICE)
            };
            let lq = U256::times_q(liq);
            let need = lq.mul_u128(s - target)?.div_ceil(U256::mul(s, target)?)?;
            let (next, used) = if U256::from(remaining) >= need {
                (target, need.to_u128()?)
            } else {
                let denominator = lq.checked_add(U256::mul(remaining, s)?)?;
                (lq.mul_u128(s)?.div_ceil(denominator)?.to_u128()?, remaining)
            };
            gross += U256::mul(liq, s - next)?.checked_shr64()?;
            remaining -= used;
            s = next;
            if remaining == 0 {
                break;
            }
        }
        if remaining > 0 {
            return None;
        }
        let gross = u64::try_from(gross).ok()?;
        let fee = ceil_bps(gross, state.fee_bps());
        Some(Priced {
            fee,
            out: gross - fee,
            sqrt_price: s,
        })
    }

    pub fn buy(state: &MarketState, a: u64) -> Option<Priced> {
        let (l, w, top) = (state.liquidity(), state.wall_liquidity(), state.wall_top());
        let fee = ceil_bps(a, state.fee_bps());
        let (mut remaining, mut out, mut s) = ((a - fee) as u128, 0u128, state.sqrt_price());
        for _ in 0..2 {
            let (liq, target) = if w > 0 && s < top {
                (l + w, top)
            } else {
                (l, MAX_SQRT_PRICE)
            };
            let need = U256::mul(liq, target - s)?.checked_ceil_shr64()?;
            let (next, used) = if remaining >= need {
                (target, need)
            } else {
                (
                    s + U256::times_q(remaining)
                        .div_floor(U256::from(liq))?
                        .to_u128()?,
                    remaining,
                )
            };
            out += U256::times_q(liq)
                .mul_u128(next - s)?
                .div_floor(U256::mul(next, s)?)?
                .to_u128()?;
            remaining -= used;
            s = next;
            if remaining == 0 {
                break;
            }
        }
        if remaining > 0 {
            return None;
        }
        Some(Priced {
            fee,
            out: u64::try_from(out).ok()?,
            sqrt_price: s,
        })
    }
}

/// Moves the clock `seconds` on, with slots to match.
fn later(env: &mut Env, seconds: i64) {
    let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    env.set_clock(
        clock.slot + seconds as u64 * 5 / 2 + 1,
        clock.unix_timestamp + seconds,
    );
}

fn clock(env: &Env) -> anchor_lang::prelude::Clock {
    env.svm.get_sysvar::<anchor_lang::prelude::Clock>()
}

/// Quotes, then swaps `amount` through the router; checks the swap paid exactly the quote
/// and both equal the spec's pricing on the market as it was. Returns what it paid.
fn trade(
    env: &mut Env,
    market: &Market,
    trader: &Keypair,
    direction: (usize, usize),
    amount: u64,
) -> (u64, Vec<String>) {
    let before = env.state(market);
    let quote = env
        .quote(market, &exact_in(direction.0, direction.1, amount))
        .unwrap();
    let spec = if direction == BUY {
        spec::buy(&before, amount)
    } else {
        spec::sell(&before, amount)
    }
    .expect("the spec prices it");
    let (result, logs) = env
        .swap_logged(market, trader, direction, TradeMode::ExactIn, amount, 0)
        .unwrap();
    assert_eq!(result.received, quote.amount_out, "the swap pays the quote");
    assert_eq!(quote.amount_out, spec.out, "the quote is the spec's");
    let after = env.state(market);
    assert_eq!(
        after.sqrt_price(),
        spec.sqrt_price,
        "the price is the spec's"
    );
    assert_eq!(
        after.fees_collected() - before.fees_collected(),
        spec.fee as u128
    );
    assert_books(env, market);
    (result.received, logs)
}

/// Every vault holds exactly its ledgers; the pool ledgers cover what the curve and the wall
/// hold at the current price, compared exactly (`wall::covers`); and the wall's floor is not
/// above the price.
fn assert_books(env: &Env, market: &Market) {
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
    let s = state.sqrt_price();
    assert!(
        buy_wall_amm::wall::covers(
            state.liquidity(),
            s,
            state.wall(),
            state.pool_tokens(),
            state.pool_sol()
        ),
        "the pool ledgers cover the curve and the wall"
    );
    assert!(state.floor() <= s, "the floor is never above the price");
}

/// The worked example's market (docs/spec/pool4-for-solana.md, "Worked example"): 1,000,000
/// tokens of 6 decimals against 10 SOL, fee 100, wall split 5,000, reward share 1,500, cap
/// floor 2,000 and cap decay 2,000, which are the launch values.
fn worked_example(env: &mut Env) -> Market {
    let params = launch_params(env.admin.pubkey());
    assert_eq!(
        (
            params.fee_bps,
            params.wall_split_bps,
            params.reward_share_bps,
            params.cap_floor_bps,
            params.cap_decay_bps
        ),
        (100, 5_000, 1_500, 2_000, 2_000)
    );
    let token = env.seedable_token(&TOKEN);
    env.create_and_seed(token, TOKEN, &params, TOKENS, LAMPORTS)
        .unwrap()
        .0
}

/// The worked example up to `place_wall`: an hour after the seed a buy of 1 SOL, and 60
/// seconds later a sell of what it bought, which trims the curve.
fn traded_worked_example(env: &mut Env) -> (Market, Keypair) {
    let market = worked_example(env);
    let trader = env.trader(&market, 300_000_000_000, 100 * SOL);
    later(env, 3_600);
    let (bought, _) = trade(env, &market, &trader, BUY, SOL);
    assert_eq!(bought, 90_081_892_629);
    later(env, 60);
    let (sold, _) = trade(env, &market, &trader, SELL, bought);
    assert_eq!(sold, 980_099_999);
    let state = env.state(&market);
    assert_eq!(state.idle_sol(), 91_293_332);
    (market, trader)
}

#[test]
fn the_worked_examples_wall_numbers_are_reproduced_through_the_router() {
    let mut env = Env::new();
    let (market, trader) = traded_worked_example(&mut env);
    let before = env.state(&market);
    // The sell back left the floor at its own price.
    assert_eq!(before.floor(), 1_844_674_407_372_029_099);

    // `place_wall`.
    let keeper = env.keeper();
    let (tip, logs) = env.place_wall(&market, &keeper).unwrap();
    assert_eq!(tip, 912_933);
    let placed = env.state(&market);
    assert_eq!(placed.wall_top(), 1_844_674_407_372_029_099);
    assert_eq!(placed.wall_liquidity(), 903_804_009);
    assert_eq!(placed.wall_sol_placed(), 90_380_400);
    assert_eq!(placed.pool_sol(), 10_007_047_068);
    assert_eq!(placed.retired_tokens(), 8_333_333_340);
    assert_eq!(placed.retired_tokens() - before.retired_tokens(), 11);
    assert_eq!(placed.pool_tokens(), 991_666_666_660);
    assert_eq!(placed.idle_sol(), 0);
    assert_eq!(placed.tips_paid(), 912_933);
    assert_eq!(placed.wall_tokens_bought(), 0);
    // `place_wall` never moves the price, the curve, the cap, the guard or the counters.
    assert_eq!(placed.sqrt_price(), before.sqrt_price());
    assert_eq!(placed.liquidity(), before.liquidity());
    assert_eq!(placed.cap(), before.cap());
    assert_eq!(placed.guard(), before.guard());
    assert_eq!(placed.counters(), before.counters());
    let tips = pda::associated_token(&keeper.pubkey(), &WSOL, &TOKEN);
    assert_eq!(
        events::<WallPlaced>(&logs),
        vec![WallPlaced {
            market_state: market.market_state,
            caller: keeper.pubkey().to_bytes().into(),
            tip_account: tips.to_bytes().into(),
            converted: 0,
            closed_sol: 0,
            closed_tokens: 0,
            dust_sol: 2,
            dust_tokens: 11,
            tip: 912_933,
            wall_top: 1_844_674_407_372_029_099,
            wall_liquidity: 903_804_009,
            wall_sol_placed: 90_380_400,
        }]
    );
    assert_books(&env, &market);

    // 60 seconds later, a sell of 20,000,000,000 units, through the curve and the wall
    // together (`settle` in between, ticket #51, touches neither).
    later(&mut env, 60);
    let (out, _) = trade(&mut env, &market, &trader, SELL, 20_000_000_000);
    assert_eq!(out, 194_120_326);
    let sold = env.state(&market);
    assert_eq!(sold.fees_collected() - placed.fees_collected(), 1_960_812);
    assert_eq!(out + 1_960_812, 196_081_138);
    assert_eq!(sold.sqrt_price(), 1_808_529_293_213_661_729);
    // The wall has spent 1,770,941 lamports on 180,633,508 units.
    let wall = sold.wall();
    assert_eq!(
        sold.wall_sol_placed() - wall.sol_at(sold.sqrt_price()).unwrap(),
        1_770_941
    );
    assert_eq!(wall.tokens_at(sold.sqrt_price()).unwrap(), 180_633_508);
}

#[test]
fn pricing_above_across_and_inside_the_wall_matches_the_spec_both_ways() {
    let mut env = Env::new();
    let (market, trader) = traded_worked_example(&mut env);
    let keeper = env.keeper();
    env.place_wall(&market, &keeper).unwrap();
    let top = env.state(&market).wall_top();
    let price = |env: &Env| env.state(&market).sqrt_price();
    assert_eq!(price(&env), top);

    // Inside: at the top a sell goes through the curve and the wall, and stays below it.
    trade(&mut env, &market, &trader, SELL, 20_000_000_000);
    assert!(price(&env) < top);
    // A buy that stays below the top, through both.
    trade(&mut env, &market, &trader, BUY, 1_000_000);
    assert!(price(&env) < top);
    // Across, upward: through both to the top, then the curve alone.
    trade(&mut env, &market, &trader, BUY, SOL / 2);
    assert!(price(&env) > top);
    // Above: a buy through the curve alone.
    trade(&mut env, &market, &trader, BUY, 1_000_000);
    // Above: a sell that stays above the top, through the curve alone.
    trade(&mut env, &market, &trader, SELL, 1_000_000_000);
    assert!(price(&env) > top);
    // Across, downward: the curve alone to the top, then both.
    trade(&mut env, &market, &trader, SELL, 60_000_000_000);
    assert!(price(&env) < top);
}

#[test]
fn the_reference_ignores_trades_in_its_own_slot() {
    let mut env = Env::new();
    let market = worked_example(&mut env);
    let trader = env.trader(&market, 100_000_000_000, 100 * SOL);
    let opened = env.state(&market);
    let opening = opened.sqrt_price();

    // A buy in a later slot: the reference follows the last close, still the opening price.
    later(&mut env, 60);
    trade(&mut env, &market, &trader, BUY, SOL);
    let first = env.state(&market);
    assert_eq!(first.reference(), opening);
    assert_eq!(first.last_slot(), clock(&env).slot);
    assert_eq!(first.last_close(), first.sqrt_price());

    // More trades in the same slot, however long the clock's seconds run: the reference
    // never moves, though the last close does.
    for (direction, amount) in [(BUY, SOL), (SELL, 10_000_000_000), (BUY, 3 * SOL)] {
        let mut c = clock(&env);
        c.unix_timestamp += 30;
        env.svm.set_sysvar(&c);
        trade(&mut env, &market, &trader, direction, amount);
        let state = env.state(&market);
        assert_eq!(
            state.reference(),
            opening,
            "a trade in the reference's own slot"
        );
        assert_eq!(
            (state.last_slot(), state.ref_time()),
            (first.last_slot(), first.ref_time())
        );
        assert_eq!(state.last_close(), state.sqrt_price());
    }
    let pumped = env.state(&market).last_close();

    // The next slot, 5 seconds on (within one `REF_STEP_WINDOW`): the reference moves toward
    // the last close, 5 seconds' worth of `REF_STEP_BPS / 2`.
    const { assert!(REF_STEP_WINDOW > 5) };
    let mut c = clock(&env);
    c.slot += 1;
    c.unix_timestamp = first.ref_time() + 5;
    env.svm.warp_to_slot(c.slot);
    env.svm.set_sysvar(&c);
    trade(&mut env, &market, &trader, SELL, 1_000_000);
    let next = env.state(&market);
    let window = REF_STEP_WINDOW as u128;
    let step = opening * REF_STEP_BPS as u128 * 5 / (2 * BPS as u128 * window);
    assert!(pumped > opening + step);
    assert_eq!(next.reference(), opening + step);
    assert_eq!(
        (next.last_slot(), next.ref_time()),
        (c.slot, c.unix_timestamp)
    );
}

#[test]
fn the_floor_crawls_toward_the_reference_and_drops_at_once() {
    let mut env = Env::new();
    let market = worked_example(&mut env);
    let trader = env.trader(&market, 1_000_000_000_000, 100 * SOL);
    let opening = env.state(&market).sqrt_price();

    // A big buy, then many minutes of small trades let the reference climb toward the
    // pumped price; the floor follows it at most `FLOOR_CRAWL_BPS / 2` a day.
    later(&mut env, 10);
    trade(&mut env, &market, &trader, BUY, 20 * SOL);
    for _ in 0..20 {
        later(&mut env, 12);
        trade(&mut env, &market, &trader, BUY, 1_000_000);
    }
    let pumped = env.state(&market);
    assert!(
        pumped.reference() > opening * 102 / 100,
        "the reference climbed"
    );
    // The floor started at the opening price and has crawled, but only by seconds' worth.
    assert!(pumped.floor() > opening);
    let seconds = (pumped.floor_time() - env.state(&market).floor_time()) as u128 + 12 * 20 + 10;
    assert!(
        (pumped.floor() - opening) * 2 * BPS as u128 * DAY
            <= opening * FLOOR_CRAWL_BPS as u128 * seconds,
        "the floor crawled no faster than FLOOR_CRAWL_BPS a day"
    );

    // Half a day later, one trade: the floor crawls exactly half a day's worth.
    let before = env.state(&market);
    later(&mut env, (DAY / 2) as i64);
    trade(&mut env, &market, &trader, BUY, 1_000_000);
    let crawled = env.state(&market);
    assert!(before.floor() < crawled.reference());
    let crawl = before.floor() * FLOOR_CRAWL_BPS as u128 * (DAY / 2) / (2 * BPS as u128 * DAY);
    assert_eq!(
        crawled.floor(),
        (before.floor() + crawl).min(crawled.reference())
    );

    // A sell to below the floor takes it down to the new price at once.
    later(&mut env, 60);
    trade(&mut env, &market, &trader, SELL, 900_000_000_000);
    let dumped = env.state(&market);
    assert!(dumped.sqrt_price() < crawled.floor());
    assert_eq!(dumped.floor(), dumped.sqrt_price());
}

#[test]
fn place_wall_is_refused_below_the_threshold_and_with_the_wrong_accounts() {
    let mut env = Env::new();
    let keeper = env.keeper();
    let token = env.seedable_token(&TOKEN);
    let params = launch_params(env.admin.pubkey());
    // Not seeded yet.
    let created = env.create_market(token, TOKEN, &params).unwrap();
    assert_refused(
        env.place_wall(&created, &keeper),
        buy_wall_amm::errors::StrategyError::MarketNotOpen,
    );

    // Seeded, with nothing idle and no wall.
    let market = worked_example(&mut env);
    assert_refused(
        env.place_wall(&market, &keeper),
        buy_wall_amm::errors::StrategyError::WallBelowThreshold,
    );
    // A buy's fee puts 4,000,000 lamports in idle SOL: still below 10,000,000.
    let trader = env.trader(&market, 100_000_000_000, 100 * SOL);
    later(&mut env, 60);
    trade(&mut env, &market, &trader, BUY, SOL);
    assert!(env.state(&market).idle_sol() < WALL_THRESHOLD);
    assert_refused(
        env.place_wall(&market, &keeper),
        buy_wall_amm::errors::StrategyError::WallBelowThreshold,
    );
    // Two more reach it.
    trade(&mut env, &market, &trader, BUY, SOL);
    trade(&mut env, &market, &trader, BUY, SOL);
    assert!(env.state(&market).idle_sol() >= WALL_THRESHOLD);

    let tips = pda::associated_token(&keeper.pubkey(), &WSOL, &TOKEN);
    let wrong = |env: &mut Env, ix: pipeline_client::Instruction| {
        assert_refused(
            env.send(&[ix], &[&keeper]),
            buy_wall_amm::errors::StrategyError::WrongAccount,
        );
    };
    // The tip may not go to the SOL vault itself.
    wrong(
        &mut env,
        place_wall_ix(&market, &keeper.pubkey(), &market.sol_vault),
    );
    // Another market's vault, or the token vault, as the SOL vault.
    for vault in [market.token_vault, created.sol_vault] {
        let mut ix = place_wall_ix(&market, &keeper.pubkey(), &tips);
        ix.accounts[2].pubkey = vault;
        assert_fails(env.send(&[ix], &[&keeper]));
    }
    // Another account as the vault authority.
    let mut ix = place_wall_ix(&market, &keeper.pubkey(), &tips);
    ix.accounts[5].pubkey = created.vault_authority;
    wrong(&mut env, ix);
    // A tip account that is not wrapped SOL.
    write_token_account(
        &mut env.svm,
        &market.token_mint,
        &TOKEN,
        &keeper.pubkey(),
        0,
    )
    .unwrap();
    let token_account = pda::associated_token(&keeper.pubkey(), &market.token_mint, &TOKEN);
    assert_fails(env.send(
        &[place_wall_ix(&market, &keeper.pubkey(), &token_account)],
        &[&keeper],
    ));
    // Nothing above moved anything; the right accounts work, from anyone.
    let before = env.state(&market);
    assert_eq!(env.balance(&tips), 0);
    let (tip, _) = env.place_wall(&market, &keeper).unwrap();
    assert_eq!(tip, env.state(&market).tips_paid() as u64);
    assert!(tip > 0 && before.wall_liquidity() == 0);
    // And at once again: nothing idle, nothing spent.
    assert_refused(
        env.place_wall(&market, &keeper),
        buy_wall_amm::errors::StrategyError::WallBelowThreshold,
    );
}

#[test]
fn place_wall_closes_a_wall_that_has_spent_enough_and_places_it_again() {
    let mut env = Env::new();
    let (market, trader) = traded_worked_example(&mut env);
    let keeper = env.keeper();
    env.place_wall(&market, &keeper).unwrap();
    // Sell well into the wall, until it has spent more than WALL_THRESHOLD.
    later(&mut env, 60);
    trade(&mut env, &market, &trader, SELL, 150_000_000_000);
    let sold = env.state(&market);
    let wall = sold.wall();
    let spent = sold.wall_sol_placed() - wall.sol_at(sold.sqrt_price()).unwrap();
    let bought = wall.tokens_at(sold.sqrt_price()).unwrap();
    assert!(spent >= WALL_THRESHOLD && bought > 0);
    // The sell's fee and its trim left some SOL idle too.
    let work = spent.max(sold.idle_sol());

    let (tip, logs) = env.place_wall(&market, &keeper).unwrap();
    let placed = env.state(&market);
    let [event] = events::<WallPlaced>(&logs).try_into().unwrap();
    assert_eq!(event.converted, spent);
    assert_eq!(event.closed_tokens, bought);
    assert_eq!(event.closed_sol, wall.sol_at(sold.sqrt_price()).unwrap());
    // The tip is the fee earned on the work: the larger of the SOL the wall spent and the
    // SOL that was idle.
    assert_eq!(tip, (work / 100).min(KEEPER_TIP_CAP));
    assert_eq!(event.tip, tip);
    assert_eq!(placed.tips_paid(), sold.tips_paid() + tip as u128);
    // The tokens it bought, and the dust, are retired; the totals count what it bought.
    assert_eq!(placed.wall_tokens_bought(), bought as u128);
    assert_eq!(
        placed.retired_tokens(),
        sold.retired_tokens() + bought + event.dust_tokens
    );
    // The new wall: at the floor, which the sell took down to its price, with everything
    // idle; the pool keeps the curve's holdings rounded up.
    assert_eq!(placed.wall_top(), sold.floor().min(sold.sqrt_price()));
    let curve_tokens = U256::times_q(placed.liquidity())
        .div_ceil(U256::from(placed.sqrt_price()))
        .unwrap()
        .to_u64()
        .unwrap();
    assert_eq!(placed.pool_tokens(), curve_tokens);
    // Value only moved between ledgers, but for the tip.
    let sol = |s: &MarketState| s.pool_sol() as u128 + s.idle_sol() as u128;
    assert_eq!(sol(&placed), sol(&sold) - tip as u128);
    assert_eq!(
        placed.pool_tokens() as u128 + placed.retired_tokens() as u128,
        sold.pool_tokens() as u128 + sold.retired_tokens() as u128
    );
    assert_books(&env, &market);
}

/// Adds `lamports` to the market's idle SOL and its SOL vault together, as a market whose
/// fees and trims had left that much idle would hold.
fn add_idle_sol(env: &mut Env, market: &Market, lamports: u64) {
    let mut account = env.svm.get_account(&market.market_state).unwrap();
    let state: &mut MarketState = bytemuck::from_bytes_mut(&mut account.data[8..]);
    state.set_idle_sol(state.idle_sol() + lamports);
    env.svm.set_account(market.market_state, account).unwrap();
    let mut vault = env.svm.get_account(&market.sol_vault).unwrap();
    let amount = u64::from_le_bytes(vault.data[64..72].try_into().unwrap());
    vault.data[64..72].copy_from_slice(&(amount + lamports).to_le_bytes());
    vault.lamports += lamports;
    env.svm.set_account(market.sol_vault, vault).unwrap();
}

#[test]
fn pumping_the_price_placing_the_wall_and_dumping_never_pays() {
    // The spec's case: the worked example's market with 5 SOL idle; buy with 30 SOL, place
    // the wall in the same slot (collecting its tip) and sell everything back.
    let mut env = Env::new();
    let market = worked_example(&mut env);
    add_idle_sol(&mut env, &market, 5 * SOL);
    assert_books(&env, &market);
    // 30 SOL for the strategy, and Pipeline's 0.25% on top.
    let pumper = env.trader(&market, 0, 31 * SOL);
    later(&mut env, 3_600);
    let before = env.state(&market).sqrt_price();
    let (bought, _) = trade(&mut env, &market, &pumper, BUY, 30 * SOL);
    let (tip, _) = env.place_wall(&market, &pumper).unwrap();
    assert_eq!(tip, KEEPER_TIP_CAP);
    let placed = env.state(&market);
    assert!(
        placed.wall_top() <= before,
        "the wall's top is no higher than before the buy"
    );
    // Every unit bought goes back to the strategy; Pipeline's 0.25% on top comes from more
    // tokens, since the spec's model leaves the router's fee out.
    let held = env.balance(&pda::associated_token(
        &pumper.pubkey(),
        &market.token_mint,
        &TOKEN,
    ));
    write_token_account(
        &mut env.svm,
        &market.token_mint,
        &TOKEN,
        &pumper.pubkey(),
        held + bought / 300 + 1,
    )
    .unwrap();
    let (sold, _) = trade(&mut env, &market, &pumper, SELL, bought);
    let loss = 30 * SOL - sold - tip;
    println!("pumped with 30 SOL, placed the wall and dumped: lost {loss} lamports");
    // 0.595 SOL, to the lamport but one.
    assert_eq!(loss, 595_000_001);
    assert!(env.state(&market).wall_top() <= before);
}

#[test]
fn after_a_pump_place_wall_places_the_wall_at_the_lagging_floor() {
    // A buy lifts the price; the floor, which rises only slowly toward a lagging reference,
    // stays below it, so the wall's top is the floor, not the price (when the floor has
    // dropped to the price, as after the worked example's sell, the top is the price:
    // `the_worked_examples_wall_numbers_are_reproduced_through_the_router`).
    let mut env = Env::new();
    let market = worked_example(&mut env);
    add_idle_sol(&mut env, &market, SOL);
    let trader = env.trader(&market, 0, 100 * SOL);
    later(&mut env, 60);
    trade(&mut env, &market, &trader, BUY, 5 * SOL);
    let state = env.state(&market);
    assert!(state.floor() < state.sqrt_price());
    let keeper = env.keeper();
    env.place_wall(&market, &keeper).unwrap();
    let placed = env.state(&market);
    assert_eq!(placed.wall_top(), state.floor());
    // The wall is all SOL, below the price.
    let wall_sol = placed.wall_sol_placed();
    assert!(wall_sol > 0);
    assert_eq!(placed.wall().sol_at(placed.sqrt_price()), Some(wall_sol));
    assert_eq!(placed.wall().tokens_at(placed.sqrt_price()), Some(0));
}
