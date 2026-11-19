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
    // The floor moves only at the slot's first update, and then never above the price the
    // slot opened at, the last close before the trade (`POOL4-50`).
    if clock(env).slot > before.last_slot() {
        assert!(
            after.floor() <= before.last_close(),
            "the floor is above the price its slot opened at"
        );
    } else {
        assert_eq!(
            (after.floor(), after.floor_time()),
            (before.floor(), before.floor_time()),
            "the floor moved on a trade in its own slot"
        );
    }
    assert_eq!(after.last_close(), after.sqrt_price());
    assert_books(env, market);
    (result.received, logs)
}

/// Every vault holds exactly its ledgers; the pool ledgers cover what the curve and the wall
/// hold at the current price, compared exactly (`wall::covers`); and the wall's floor is not
/// above the reference. (It may be above the price: a sell lowers the price at once, and the
/// floor only at the next slot's first update.)
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
    assert!(
        state.floor() <= state.reference(),
        "the floor is never above the reference"
    );
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
    // The sell back, the first update of its slot, crawled the floor 60 seconds' worth toward
    // the reference, below the buy's price, the price that slot opened at; its own lower price
    // never reaches the floor in its slot (`POOL4-50`).
    assert_eq!(before.floor(), 1_844_700_027_848_835_313);
    assert_eq!(before.last_close(), 1_844_674_407_372_029_099);

    // `place_wall` is refused in the sell's slot; from the next slot it runs, bringing the
    // floor down to the sell's price, the price that slot opened at. The sell closed just
    // above the opening price, the lowest close since the seed, so the wall goes there
    // (`POOL4-50`), and the low is reset to the price at placement.
    let keeper = env.keeper();
    assert_refused(
        env.place_wall(&market, &keeper),
        buy_wall_amm::errors::StrategyError::SwapThisSlot,
    );
    env.next_slot();
    let (tip, logs) = env.place_wall(&market, &keeper).unwrap();
    assert_eq!(tip, 912_933);
    let placed = env.state(&market);
    assert_eq!(placed.wall_top(), 1_844_674_407_370_955_161);
    assert_eq!(placed.wall_liquidity(), 903_804_010);
    assert_eq!(placed.wall_sol_placed(), 90_380_400);
    assert_eq!(placed.pool_sol(), 10_007_047_068);
    assert_eq!(placed.retired_tokens(), 8_333_333_340);
    assert_eq!(placed.retired_tokens() - before.retired_tokens(), 11);
    assert_eq!(placed.pool_tokens(), 991_666_666_660);
    assert_eq!(placed.idle_sol(), 0);
    assert_eq!(placed.tips_paid(), 912_933);
    assert_eq!(placed.wall_tokens_bought(), 0);
    // `place_wall` never moves the price, the curve, the cap or the counters, and of the guard
    // only the floor, at the same time, so its clock stays, and the low.
    assert_eq!(placed.sqrt_price(), before.sqrt_price());
    assert_eq!(placed.liquidity(), before.liquidity());
    assert_eq!(placed.cap(), before.cap());
    assert_eq!(
        placed.guard(),
        buy_wall_amm::guard::Guard {
            floor: 1_844_674_407_372_029_099,
            low_since_placement: 1_844_674_407_372_029_099,
            ..before.guard()
        }
    );
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
            wall_top: 1_844_674_407_370_955_161,
            wall_liquidity: 903_804_010,
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
    assert_eq!(sold.sqrt_price(), 1_808_529_293_214_755_428);
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
    env.next_slot();
    env.place_wall(&market, &keeper).unwrap();
    let top = env.state(&market).wall_top();
    let price = |env: &Env| env.state(&market).sqrt_price();
    // The top is the opening price, the lowest close since the seed, a hair below the price
    // (`POOL4-50`).
    assert!(price(&env) > top && price(&env) - top < 2_000_000);

    // Across, downward from a hair above the top: a sell through the curve alone to the top,
    // then through the curve and the wall, and stays below it.
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
fn the_floor_crawls_toward_the_reference_and_drops_from_the_next_slot() {
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
        (before.floor() + crawl)
            .min(crawled.reference())
            .min(before.last_close())
    );

    // A sell to below the floor never takes it down in the sell's own slot (`POOL4-50`); the
    // next slot's first update, here a `place_wall`, takes it down to the sell's price at once.
    later(&mut env, 60);
    trade(&mut env, &market, &trader, SELL, 900_000_000_000);
    let dumped = env.state(&market);
    // The sell opened its slot: the floor crawled a minute's worth, never above the price that
    // slot opened at, and the sell's own price never reached it.
    assert!(dumped.sqrt_price() < crawled.floor());
    assert!(dumped.floor() >= crawled.floor() && dumped.floor() <= crawled.last_close());
    add_idle_sol(&mut env, &market, WALL_THRESHOLD);
    env.next_slot();
    let keeper = env.keeper();
    env.place_wall(&market, &keeper).unwrap();
    let placed = env.state(&market);
    assert_eq!(placed.floor(), dumped.sqrt_price());
    assert_eq!(placed.wall_top(), dumped.sqrt_price());
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

    // Seeded, with nothing idle and no wall: in the seed's own slot, and from the next.
    let market = worked_example(&mut env);
    assert_refused(
        env.place_wall(&market, &keeper),
        buy_wall_amm::errors::StrategyError::SwapThisSlot,
    );
    env.next_slot();
    assert_refused(
        env.place_wall(&market, &keeper),
        buy_wall_amm::errors::StrategyError::WallBelowThreshold,
    );
    // A buy's fee puts 4,000,000 lamports in idle SOL: still below 10,000,000. In the buy's
    // slot the slot is checked first (`POOL4-50`).
    let trader = env.trader(&market, 100_000_000_000, 100 * SOL);
    later(&mut env, 60);
    trade(&mut env, &market, &trader, BUY, SOL);
    assert!(env.state(&market).idle_sol() < WALL_THRESHOLD);
    assert_refused(
        env.place_wall(&market, &keeper),
        buy_wall_amm::errors::StrategyError::SwapThisSlot,
    );
    env.next_slot();
    assert_refused(
        env.place_wall(&market, &keeper),
        buy_wall_amm::errors::StrategyError::WallBelowThreshold,
    );
    // Two more reach it; the wall waits for the next slot.
    trade(&mut env, &market, &trader, BUY, SOL);
    trade(&mut env, &market, &trader, BUY, SOL);
    assert!(env.state(&market).idle_sol() >= WALL_THRESHOLD);
    env.next_slot();

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
    env.next_slot();
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

    // From the next slot, as the keeper runner sends it after the sell's swap event.
    env.next_slot();
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
    // The new wall: at the floor, which `place_wall`'s slot update took down to the sell's
    // price, the price its slot opened at, with everything idle; the pool keeps the curve's
    // holdings rounded up.
    assert!(sold.floor() > sold.sqrt_price());
    assert_eq!(placed.floor(), sold.sqrt_price());
    assert_eq!(placed.wall_top(), sold.sqrt_price());
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
    // the wall (refused in the buy's slot, so in the next, collecting its tip) and sell
    // everything back.
    let mut env = Env::new();
    let market = worked_example(&mut env);
    add_idle_sol(&mut env, &market, 5 * SOL);
    assert_books(&env, &market);
    // 30 SOL for the strategy, and Pipeline's 0.25% on top.
    let pumper = env.trader(&market, 0, 31 * SOL);
    later(&mut env, 3_600);
    let before = env.state(&market).sqrt_price();
    let (bought, _) = trade(&mut env, &market, &pumper, BUY, 30 * SOL);
    assert_refused(
        env.place_wall(&market, &pumper),
        buy_wall_amm::errors::StrategyError::SwapThisSlot,
    );
    env.next_slot();
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
    // `the_worked_examples_wall_numbers_are_reproduced_through_the_router`). The wall waits
    // for the slot after the buy's, and an hour later the floor has crawled only up to the
    // reference, which still lags at the opening price.
    let mut env = Env::new();
    let market = worked_example(&mut env);
    add_idle_sol(&mut env, &market, SOL);
    let trader = env.trader(&market, 0, 100 * SOL);
    later(&mut env, 60);
    trade(&mut env, &market, &trader, BUY, 5 * SOL);
    let state = env.state(&market);
    assert!(state.floor() < state.sqrt_price());
    let keeper = env.keeper();
    later(&mut env, 3_600);
    env.place_wall(&market, &keeper).unwrap();
    let placed = env.state(&market);
    assert_eq!(placed.wall_top(), state.floor());
    // The wall is all SOL, below the price.
    let wall_sol = placed.wall_sol_placed();
    assert!(wall_sol > 0);
    assert_eq!(placed.wall().sol_at(placed.sqrt_price()), Some(wall_sol));
    assert_eq!(placed.wall().tokens_at(placed.sqrt_price()), Some(0));
}

/// SOS finding H003 (`POOL4-50`): a sell to a dip bought straight back in its own slot never
/// moves the floor, so the wall is never dragged down for good by a price that lasted only
/// inside one slot; `place_wall` in that slot is refused. Since the placement cap (amended
/// 2026-11-19), the next slot's `place_wall` puts the wall at the dip's low once, the griefing
/// residual the owner accepted, and resets the low to the price at placement, so once idle
/// SOL has refilled, the next placement goes back up to the floor. A genuine fall, a sell
/// nobody buys back, lowers the floor from the next slot on.
#[test]
fn sos_h003_a_dip_bought_back_in_its_own_slot_never_moves_the_floor() {
    let mut env = Env::new();
    let market = worked_example(&mut env);
    let keeper = env.keeper();
    // A wall of 1 SOL at the opening price, which is the floor.
    add_idle_sol(&mut env, &market, SOL);
    later(&mut env, 60);
    env.place_wall(&market, &keeper).unwrap();
    let walled = env.state(&market);
    let opening = walled.sqrt_price();
    assert_eq!(walled.wall_top(), opening);
    assert_eq!(walled.floor(), opening);

    // One slot: a sell to well under three quarters of the opening square-root price (about
    // half the price), then a buy back with everything it paid.
    later(&mut env, 60);
    let attacker = env.trader(&market, 600_000_000_000, 100 * SOL);
    let (paid, _) = trade(&mut env, &market, &attacker, SELL, 500_000_000_000);
    let dip = env.state(&market).sqrt_price();
    assert!(dip < opening * 3 / 4, "the sell reached a deep dip");
    trade(&mut env, &market, &attacker, BUY, paid);
    let back = env.state(&market);
    assert!(back.sqrt_price() > dip + (opening - dip) * 9 / 10);
    assert_eq!(
        back.floor(),
        walled.floor(),
        "a dip inside one slot moved the floor"
    );

    // `place_wall` in that slot is refused, whatever is idle.
    add_idle_sol(&mut env, &market, WALL_THRESHOLD);
    assert_refused(
        env.place_wall(&market, &keeper),
        buy_wall_amm::errors::StrategyError::SwapThisSlot,
    );

    // From the next slot it brings the floor up to date with the price the slot opened at,
    // the buy back's close, which leaves it up; the lowest close since the last placement,
    // the dip's, caps the placement, so this one wall goes at the dip (the placement cap,
    // `POOL4-50`).
    assert_eq!(back.low_since_placement(), dip);
    env.next_slot();
    env.place_wall(&market, &keeper).unwrap();
    let placed = env.state(&market);
    assert_eq!(placed.floor(), walled.floor().min(back.sqrt_price()));
    assert!(placed.floor() > dip + (opening - dip) * 9 / 10);
    assert_eq!(placed.wall_top(), dip);
    // It brought the floor up to date and reset the low to the price at placement (code
    // review finding 1: before, it left the low alone and a later swap reset it); the
    // reference and its slot wait for a swap.
    assert_eq!(
        (placed.reference(), placed.ref_time(), placed.last_slot()),
        (back.reference(), back.ref_time(), back.last_slot())
    );
    assert_eq!(placed.low_since_placement(), placed.sqrt_price());
    assert_books(&env, &market);

    // A buy in a later slot leaves the low at the price at placement, at or above the
    // floor; once idle SOL has refilled to the threshold, the next placement goes back up
    // to the floor.
    later(&mut env, 60);
    trade(&mut env, &market, &attacker, BUY, 1_000_000);
    let refilled = env.state(&market);
    assert_eq!(refilled.low_since_placement(), placed.sqrt_price());
    assert!(refilled.low_since_placement() >= placed.floor());
    add_idle_sol(&mut env, &market, WALL_THRESHOLD);
    env.next_slot();
    env.place_wall(&market, &keeper).unwrap();
    let placed = env.state(&market);
    assert_eq!(placed.wall_top(), placed.floor());
    assert!(placed.wall_top() > dip + (opening - dip) * 9 / 10);
    assert_books(&env, &market);

    // A genuine fall: a sell nobody buys back. In its own slot the floor never reaches its
    // price (the sell opened the slot, so the floor may crawl, but never above the price the
    // slot opened at).
    later(&mut env, 60);
    trade(&mut env, &market, &attacker, SELL, 300_000_000_000);
    let fallen = env.state(&market);
    assert!(fallen.sqrt_price() < placed.floor());
    assert!(fallen.floor() >= placed.floor() && fallen.floor() <= placed.last_close());
    // From the next slot, the first update takes it down to the fall's close, and the wall
    // goes there.
    env.next_slot();
    trade(&mut env, &market, &attacker, BUY, 1_000_000);
    assert_eq!(env.state(&market).floor(), fallen.sqrt_price());
    env.next_slot();
    env.place_wall(&market, &keeper).unwrap();
    assert_eq!(env.state(&market).wall_top(), fallen.sqrt_price());
    assert_books(&env, &market);
}

/// The worked example's market at a 0.25% fee with the whole market share to the wall and no
/// rewards, after a fall of about a fifth of the price and a day without a swap: the floor at
/// the fall's close `s0`, the reference still at the opening price above it, a wall of 30 SOL
/// (three times the curve's SOL) at `s0`, and `WALL_THRESHOLD` idle. Returns the market and
/// the price `s0`. This is SOS finding H004's window, where the first swap realised a whole
/// day's crawl of the floor at once.
fn after_a_fall_and_a_quiet_day(env: &mut Env) -> (Market, u128) {
    let mut params = launch_params(env.admin.pubkey());
    params.fee_bps = 25;
    params.wall_split_bps = 10_000;
    params.reward_share_bps = 0;
    params.rewards_recipient = pipeline_client::Pubkey::default();
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(token, TOKEN, &params, TOKENS, LAMPORTS)
        .unwrap();
    let opening = env.state(&market).sqrt_price();
    let keeper = env.keeper();
    later(env, 60);
    let seller = env.trader(&market, 200_000_000_000, SOL);
    trade(env, &market, &seller, SELL, 120_000_000_000);
    let s0 = env.state(&market).sqrt_price();
    assert!(s0 < opening * 92 / 100);
    // From the next slot the floor is the fall's close; the wall goes there, then three times
    // the curve's SOL joins it.
    env.next_slot();
    let _ = env.place_wall(&market, &keeper);
    add_idle_sol(env, &market, 30 * SOL);
    env.next_slot();
    env.place_wall(&market, &keeper).unwrap();
    add_idle_sol(env, &market, WALL_THRESHOLD);
    let state = env.state(&market);
    assert_eq!((state.floor(), state.wall_top()), (s0, s0));
    assert_eq!(state.reference(), opening);
    later(env, DAY as i64);
    (market, s0)
}

/// SOS finding H004 (`POOL4-50`): after a fall and a quiet day, a buy up to where the floor
/// would crawl, `place_wall` and a sell back never pays. The buy cannot lift the floor above
/// the price its slot opened at, `place_wall` is refused in the buy's slot, and from the next
/// slot the wall's top is no higher than the price before the buy, so the sell back never
/// returns more than the buy cost.
#[test]
fn sos_h004_a_quiet_days_crawl_cannot_be_captured_by_a_buy_place_wall_and_sell() {
    let mut env = Env::new();
    let (market, s0) = after_a_fall_and_a_quiet_day(&mut env);
    let before = env.state(&market);
    // Where a day's crawl would take the floor, below the reference after its step.
    let crawled = s0 + buy_wall_amm::guard::floor_crawl(s0, DAY).unwrap();
    assert!(crawled < before.reference() * 98 / 100);
    // The least buy that lifts the price to it.
    let reaches = |a: u64| spec::buy(&before, a).unwrap().sqrt_price >= crawled;
    let (mut lo, mut hi) = (1u64, 10 * SOL);
    assert!(reaches(hi));
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if reaches(mid) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    let amount = hi;
    // The amount, and Pipeline's 0.25% on top.
    let pumper = env.trader(&market, 0, amount + amount / 300 + 1);
    let (bought, _) = trade(&mut env, &market, &pumper, BUY, amount);
    let after_buy = env.state(&market);
    assert!(after_buy.sqrt_price() >= crawled);
    assert!(
        after_buy.floor() <= s0,
        "the buy lifted the floor above the price its slot opened at"
    );

    // `place_wall` in the buy's slot is refused.
    assert_refused(
        env.place_wall(&market, &pumper),
        buy_wall_amm::errors::StrategyError::SwapThisSlot,
    );
    // From the next slot, the wall's top is no higher than the price the buy's slot opened
    // at, nor the price before the buy.
    env.next_slot();
    let (tip, _) = env.place_wall(&market, &pumper).unwrap();
    let placed = env.state(&market);
    assert!(placed.wall_top() <= placed.floor() && placed.floor() <= s0);
    assert!(placed.wall_top() <= placed.sqrt_price());

    // The sell back, with Pipeline's 0.25% on top from more tokens.
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
    println!("bought {bought} units for {amount} lamports, sold them back for {sold}, tip {tip}");
    assert!(
        sold <= amount,
        "the round trip returned {sold} lamports for {amount}"
    );
}

/// SOS finding H050 (`POOL4-50`): no keeper job run between the legs of a round trip changes
/// what it returns. `settle` and `sweep_fees` touch only owed ledgers, and `place_wall`, the
/// only job that moves pricing state, is refused in the round trip's slot; so in H004's window
/// a round trip with the jobs between its legs sells for exactly what the same round trip
/// with none does, which never exceeds what the buy cost.
#[test]
fn sos_h050_keeper_jobs_between_a_round_trips_legs_change_nothing() {
    let round_trip = |jobs: bool| -> (u64, u64) {
        let mut env = Env::new();
        let (market, _) = after_a_fall_and_a_quiet_day(&mut env);
        common::payouts::set_supply(&mut env, &market.token_mint, TOKENS);
        let amount = SOL;
        let trader = env.trader(&market, 0, amount + amount / 300 + 1);
        let (bought, _) = trade(&mut env, &market, &trader, BUY, amount);
        if jobs {
            let before = env.state(&market);
            assert!(before.retired_tokens() > 0 && before.fees_suite() > 0);
            env.send(&[common::payouts::settle_ix(&market)], &[])
                .unwrap();
            let payer = env.admin.pubkey();
            let suite = pipeline_client::Pubkey::new_from_array(
                buy_wall_amm::config::SUITE_TREASURY.to_bytes(),
            );
            env.send(
                &[common::payouts::sweep_fees_ix(&market, &payer, &suite, 2)],
                &[],
            )
            .unwrap();
            let keeper = env.keeper();
            assert_refused(
                env.place_wall(&market, &keeper),
                buy_wall_amm::errors::StrategyError::SwapThisSlot,
            );
            let after = env.state(&market);
            assert_eq!((after.retired_tokens(), after.fees_suite()), (0, 0));
        }
        let held = env.balance(&pda::associated_token(
            &trader.pubkey(),
            &market.token_mint,
            &TOKEN,
        ));
        write_token_account(
            &mut env.svm,
            &market.token_mint,
            &TOKEN,
            &trader.pubkey(),
            held + bought / 300 + 1,
        )
        .unwrap();
        let (sold, _) = trade(&mut env, &market, &trader, SELL, bought);
        (amount, sold)
    };
    let (amount, plain) = round_trip(false);
    let (_, with_jobs) = round_trip(true);
    assert_eq!(
        with_jobs, plain,
        "a keeper job between the legs changed the sell"
    );
    assert!(
        plain <= amount,
        "the round trip returned {plain} for {amount}"
    );
}

/// The least `a` in `lo..=hi` for which `reaches(a)` holds, `reaches` being monotone and
/// holding at `hi`.
fn least(mut lo: u64, mut hi: u64, reaches: impl Fn(u64) -> bool) -> u64 {
    assert!(reaches(hi));
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if reaches(mid) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    hi
}

/// Round 2's back-run of a fall across one slot boundary (VERIFY-H003 residual 1, `POOL4-50`
/// as the owner amended it on 2026-11-19): on the round 2 model's market (10 SOL curve, fee
/// 25, a tight cap, a 1 SOL wall at the floor 0.98 of the opening square-root price and 0.02
/// SOL idle), a third party dumps to half the price in slot N, which trims the curve and
/// leaves its SOL idle; the back-runner buys the price back up to the floor in slot N, so at
/// slot N+1 the floor stays up; it then calls `place_wall` and sells everything it bought.
/// Under the slot-based floor alone the wall went up at the old floor with all the idle SOL,
/// the dump's trimmed SOL included, and the back-runner sold into it for more than it paid.
/// Every placement is now capped at the lowest close since the last placement, the dump's
/// low, so the wall goes there and the round trip never pays.
#[test]
fn sos_r2v_backrun_of_a_fall_across_one_slot_never_pays() {
    let mut env = Env::new();
    let mut params = launch_params(env.admin.pubkey());
    params.fee_bps = 25;
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(token, TOKEN, &params, TOKENS, LAMPORTS)
        .unwrap();
    let opening = env.state(&market).sqrt_price();
    let keeper = env.keeper();
    let seller = env.trader(&market, 500_000_000_000, SOL);

    // The floor and a 1 SOL wall at 0.98 of the opening square-root price: a sell to there,
    // then from the next slot `place_wall`, then 0.02 SOL idle.
    later(&mut env, 60);
    let state = env.state(&market);
    let to_floor = least(1, TOKENS, |x| {
        spec::sell(&state, x).unwrap().sqrt_price <= opening * 98 / 100
    });
    trade(&mut env, &market, &seller, SELL, to_floor);
    env.next_slot();
    let idle = env.state(&market).idle_sol();
    add_idle_sol(&mut env, &market, SOL - idle);
    env.place_wall(&market, &keeper).unwrap();
    add_idle_sol(&mut env, &market, 20_000_000);
    let walled = env.state(&market);
    let floor = walled.floor();
    assert_eq!(walled.wall_top(), floor);
    assert!(floor <= opening * 98 / 100 && floor > opening * 97 / 100);

    // Slot N: the third party dumps to half the price, through the curve and the wall; the
    // cap trims the curve and its SOL goes idle.
    later(&mut env, 60);
    let state = env.state(&market);
    let dump = least(1, TOKENS, |x| {
        spec::sell(&state, x).unwrap().sqrt_price <= floor * 7_071 / 10_000
    });
    let dumper = env.trader(&market, dump + dump / 300 + 1, SOL);
    trade(&mut env, &market, &dumper, SELL, dump);
    let dumped = env.state(&market);
    let low = dumped.sqrt_price();
    assert!(
        dumped.idle_sol() > walled.idle_sol() + SOL / 10,
        "the dump trimmed"
    );

    // Slot N, after it: the back-runner buys the price back up to the floor.
    let cost = least(1, 10 * SOL, |a| {
        spec::buy(&dumped, a).unwrap().sqrt_price >= floor
    });
    let back_runner = env.trader(&market, 0, cost + cost / 300 + 1);
    let (bought, _) = trade(&mut env, &market, &back_runner, BUY, cost);
    let back = env.state(&market);
    assert!(back.sqrt_price() >= floor);
    assert_eq!(
        back.floor(),
        floor,
        "a swap moved the floor in its own slot"
    );
    assert_eq!(
        back.low_since_placement(),
        low,
        "the lowest close since the last placement is the dump's"
    );

    // Slot N+1: `place_wall` by the back-runner. The floor stays up (the slot opened at the
    // buy back's close), but the wall goes no higher than the dump's low.
    env.next_slot();
    let (tip, _) = env.place_wall(&market, &back_runner).unwrap();
    let placed = env.state(&market);
    assert_eq!(placed.floor(), floor);
    assert!(
        placed.wall_top() <= low,
        "the wall went up at {} above the dump's low {low}",
        placed.wall_top()
    );
    assert_eq!(placed.wall_top(), low);
    assert_books(&env, &market);

    // The back-runner sells everything it bought, with Pipeline's 0.25% on top from more
    // tokens.
    let held = env.balance(&pda::associated_token(
        &back_runner.pubkey(),
        &market.token_mint,
        &TOKEN,
    ));
    write_token_account(
        &mut env.svm,
        &market.token_mint,
        &TOKEN,
        &back_runner.pubkey(),
        held + bought / 300 + 1,
    )
    .unwrap();
    let (sold, _) = trade(&mut env, &market, &back_runner, SELL, bought);
    println!("back-run: bought {bought} units for {cost} lamports, tip {tip}, sold for {sold}");
    assert!(
        sold + tip <= cost,
        "the back-run returned {sold} lamports and a {tip} tip for {cost}"
    );
}

/// Code review (high) finding 1 (`POOL4-50`): the placement cap must survive a tiny swap in
/// the slot after the dump. On round 2's back-run market, a third party dumps to about half
/// the price in slot N (the curve trims, its SOL goes idle) and the back-runner buys back to
/// the floor as slot N's last swap; in slot N+1 the back-runner sends one tiny buy first,
/// which, when the cap was the last traded slot's lowest close, reset it to about the floor;
/// in slot N+2 `place_wall` placed the wall at the old floor with the trimmed SOL and the
/// back-runner sold into it for more than it paid. The cap is now the lowest close since
/// the last placement, which only a placement resets, so the wall goes no higher than the
/// dump's low and the round trip never pays.
#[test]
fn sos_cr1_a_tiny_swap_in_the_next_slot_does_not_clear_the_placement_cap() {
    let mut env = Env::new();
    let mut params = launch_params(env.admin.pubkey());
    params.fee_bps = 25;
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(token, TOKEN, &params, TOKENS, LAMPORTS)
        .unwrap();
    let opening = env.state(&market).sqrt_price();
    let keeper = env.keeper();
    let seller = env.trader(&market, 500_000_000_000, SOL);

    // The floor and a 1 SOL wall at 0.98 of the opening square-root price, then 0.02 SOL
    // idle, as in `sos_r2v_backrun_of_a_fall_across_one_slot_never_pays`.
    later(&mut env, 60);
    let state = env.state(&market);
    let to_floor = least(1, TOKENS, |x| {
        spec::sell(&state, x).unwrap().sqrt_price <= opening * 98 / 100
    });
    trade(&mut env, &market, &seller, SELL, to_floor);
    env.next_slot();
    let idle = env.state(&market).idle_sol();
    add_idle_sol(&mut env, &market, SOL - idle);
    env.place_wall(&market, &keeper).unwrap();
    add_idle_sol(&mut env, &market, 20_000_000);
    let walled = env.state(&market);
    let floor = walled.floor();
    assert_eq!(walled.wall_top(), floor);

    // Slot N: the dump, then the back-runner's buy back to the floor as the slot's last swap.
    later(&mut env, 60);
    let state = env.state(&market);
    let dump = least(1, TOKENS, |x| {
        spec::sell(&state, x).unwrap().sqrt_price <= floor * 7_071 / 10_000
    });
    let dumper = env.trader(&market, dump + dump / 300 + 1, SOL);
    trade(&mut env, &market, &dumper, SELL, dump);
    let dumped = env.state(&market);
    let low = dumped.sqrt_price();
    assert!(
        dumped.idle_sol() > walled.idle_sol() + SOL / 10,
        "the dump trimmed"
    );
    let cost = least(1, 10 * SOL, |a| {
        spec::buy(&dumped, a).unwrap().sqrt_price >= floor
    });
    let tiny = 1_000_000;
    let back_runner = env.trader(&market, 0, cost + tiny + (cost + tiny) / 300 + 2);
    let (bought, _) = trade(&mut env, &market, &back_runner, BUY, cost);
    assert!(env.state(&market).sqrt_price() >= floor);

    // Slot N+1: the back-runner's tiny buy, the slot's first swap. The floor stays up.
    env.next_slot();
    let (tiny_bought, _) = trade(&mut env, &market, &back_runner, BUY, tiny);
    let nudged = env.state(&market);
    assert_eq!(nudged.floor(), floor);
    assert!(nudged.sqrt_price() >= floor);

    // Slot N+2: `place_wall` by the back-runner. The wall goes no higher than the dump's low.
    env.next_slot();
    let (tip, _) = env.place_wall(&market, &back_runner).unwrap();
    let placed = env.state(&market);
    assert_eq!(placed.floor(), floor);
    assert!(
        placed.wall_top() <= low,
        "the wall went up at {} above the dump's low {low}",
        placed.wall_top()
    );
    assert_books(&env, &market);

    // The back-runner sells everything it bought, with Pipeline's 0.25% on top from more
    // tokens.
    let bought = bought + tiny_bought;
    let held = env.balance(&pda::associated_token(
        &back_runner.pubkey(),
        &market.token_mint,
        &TOKEN,
    ));
    write_token_account(
        &mut env.svm,
        &market.token_mint,
        &TOKEN,
        &back_runner.pubkey(),
        held + bought / 300 + 1,
    )
    .unwrap();
    let (sold, _) = trade(&mut env, &market, &back_runner, SELL, bought);
    let paid = cost + tiny;
    println!(
        "back-run with a tiny swap: bought {bought} units for {paid} lamports, tip {tip}, sold for {sold}"
    );
    assert!(
        sold + tip <= paid,
        "the back-run returned {sold} lamports and a {tip} tip for {paid}"
    );
}
