//! A rate change waits (docs/spec/tax-amm.md, "Rates"; `TAX-05`; hardening finding H010,
//! #67): `set_taxes` stores the new rates as pending, and quotes and swaps apply them only
//! from `RATE_CHANGE_DELAY_SLOTS` slots later, longer than any transaction's lifetime, so no
//! change can reach a swap already signed. Decreases wait too.

mod common;

use common::authority::*;
use common::model::Model;
use common::*;
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::config::RATE_CHANGE_DELAY_SLOTS;
use tax_amm::events::TaxesChanged;
use tax_amm::InitParams;

const AMOUNT: u64 = 1_000_000_000;

/// A market on two SPL Token mints with rates 300 and 500 inside 0 to 1,000, whose tax
/// authority is `authority`, and a trader funded for it.
fn market_with_authority(env: &mut Env, authority: &Keypair) -> (Market, Keypair) {
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let params = InitParams {
        tax_authority: ak(&authority.pubkey()),
        buy_tax_min_bps: 0,
        buy_tax_max_bps: 1_000,
        ..valid_params(&Pubkey::new_unique())
    };
    let market = env.seeded_market(mints, &params, [100_000_000_000, 200_000_000_000]);
    let trader = env.funded_wallet(&market, 10_000_000_000_000);
    (market, trader)
}

fn set_taxes(
    env: &mut Env,
    market: &Market,
    authority: &Keypair,
    buy: u16,
    sell: u16,
) -> Vec<TaxesChanged> {
    let meta = env
        .send_signed(
            set_taxes_instruction(&market.market_state, &authority.pubkey(), buy, sell),
            authority,
        )
        .unwrap();
    strategy_events(&meta.logs)
}

/// The rates quotes and swaps apply now, read from what a swap each way pays: each
/// direction is quoted and swapped, and the model priced at `rates` must agree.
fn assert_trades_at(
    env: &mut Env,
    market: &Market,
    trader: &Keypair,
    rates: (u16, u16),
    what: &str,
) {
    for (i, o) in [(1, 0), (0, 1)] {
        let mut state = env.tax_market(&market.market_state);
        state.buy_tax_bps = rates.0;
        state.sell_tax_bps = rates.1;
        let mut model = Model::of(&state);
        let expected = model.swap(i, o, AMOUNT).unwrap();
        let quote = env.quote(market, &exact_in(i, o, AMOUNT)).unwrap();
        assert_eq!(quote.amount_out, expected.out, "{what}: quote {i}->{o}");
        let swapped = env.swap(market, trader, (i, o), AMOUNT).unwrap();
        assert_eq!(swapped.received, expected.out, "{what}: swap {i}->{o}");
    }
}

/// Hardening finding H010 (#67): the tax authority could put `[set_taxes(max), a victim's
/// swap, set_taxes(back)]` in one transaction and turn the victim's slippage allowance into
/// tax. The change now waits, so the swap pays the posted rates and the change back cancels
/// the pending one.
#[test]
fn sos_h010_a_rate_change_never_reaches_a_swap_in_the_same_transaction() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let (market, victim) = market_with_authority(&mut env, &authority);
    let before = env.tax_market(&market.market_state);
    let posted = (before.buy_tax_bps, before.sell_tax_bps);
    for (i, o) in [(1, 0), (0, 1)] {
        let state = env.tax_market(&market.market_state);
        let quote = env.quote(&market, &exact_in(i, o, AMOUNT)).unwrap();
        let mut model = Model::of(&state);
        let expected = model.swap(i, o, AMOUNT).unwrap();
        let options = SwapOptions {
            // The victim allows 10% of slippage, all of which the flip used to take.
            min_amount_out: quote.amount_out * 9 / 10,
            ..SwapOptions::default()
        };
        let sandwich = [
            set_taxes_instruction(&market.market_state, &authority.pubkey(), 1_000, 1_000),
            env.swap_instruction(&market, &victim.pubkey(), (i, o), AMOUNT, &options)
                .unwrap(),
            set_taxes_instruction(
                &market.market_state,
                &authority.pubkey(),
                posted.0,
                posted.1,
            ),
        ];
        env.send_meta(&sandwich, &[&authority, &victim]).unwrap();
        let after = env.tax_market(&market.market_state);
        assert_eq!(
            after.tax_collected - state.tax_collected,
            expected.tax as u128,
            "{i}->{o}: taxed at the posted rates"
        );
        assert_eq!((after.buy_tax_bps, after.sell_tax_bps), posted);
        assert_eq!(
            after.pending_from_slot, 0,
            "the change back cancelled the pending one"
        );
    }
}

#[test]
fn a_change_applies_from_its_slot_and_decreases_wait_too() {
    for (new, what) in [((800u16, 900u16), "higher"), ((0, 0), "lower")] {
        let mut env = Env::new();
        let authority = Keypair::new();
        let (market, trader) = market_with_authority(&mut env, &authority);
        let start = env.slot();
        let events = set_taxes(&mut env, &market, &authority, new.0, new.1);
        let from_slot = start + RATE_CHANGE_DELAY_SLOTS;
        assert_eq!(
            events,
            [TaxesChanged {
                market_state: ak(&market.market_state),
                tax_authority: ak(&authority.pubkey()),
                buy_tax_bps: new.0,
                sell_tax_bps: new.1,
                from_slot,
            }],
            "{what}"
        );
        let pending = env.tax_market(&market.market_state);
        assert_eq!(
            (pending.buy_tax_bps, pending.sell_tax_bps),
            (300, 500),
            "{what}: in force"
        );
        assert_eq!(
            (
                pending.pending_buy_tax_bps,
                pending.pending_sell_tax_bps,
                pending.pending_from_slot
            ),
            (new.0, new.1, from_slot),
            "{what}: pending"
        );

        env.warp_slots(RATE_CHANGE_DELAY_SLOTS - 1);
        assert_trades_at(
            &mut env,
            &market,
            &trader,
            (300, 500),
            &format!("{what}, a slot early"),
        );
        env.warp_slots(1);
        assert_trades_at(
            &mut env,
            &market,
            &trader,
            new,
            &format!("{what}, from its slot"),
        );
        // The swap made the change the market's rates.
        let applied = env.tax_market(&market.market_state);
        assert_eq!((applied.buy_tax_bps, applied.sell_tax_bps), new, "{what}");
        assert_eq!(
            (
                applied.pending_buy_tax_bps,
                applied.pending_sell_tax_bps,
                applied.pending_from_slot
            ),
            (0, 0, 0),
            "{what}: nothing pending"
        );
    }
}

#[test]
fn a_second_change_before_the_first_applies_replaces_it_and_waits_again() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let (market, trader) = market_with_authority(&mut env, &authority);
    set_taxes(&mut env, &market, &authority, 800, 900);
    env.warp_slots(RATE_CHANGE_DELAY_SLOTS / 2);
    set_taxes(&mut env, &market, &authority, 100, 200);
    env.warp_slots(RATE_CHANGE_DELAY_SLOTS / 2);
    assert_trades_at(
        &mut env,
        &market,
        &trader,
        (300, 500),
        "when the first would have applied",
    );
    env.warp_slots(RATE_CHANGE_DELAY_SLOTS / 2);
    assert_trades_at(
        &mut env,
        &market,
        &trader,
        (100, 200),
        "when the second applies",
    );
}

#[test]
fn a_change_after_a_due_one_keeps_the_due_rates_until_its_own_slot() {
    // A change that is due but that no swap has applied yet is the market's rates: a later
    // change replaces it only from its own slot, never at once.
    let mut env = Env::new();
    let authority = Keypair::new();
    let (market, trader) = market_with_authority(&mut env, &authority);
    set_taxes(&mut env, &market, &authority, 800, 900);
    env.warp_slots(RATE_CHANGE_DELAY_SLOTS * 2);
    set_taxes(&mut env, &market, &authority, 100, 200);
    let state = env.tax_market(&market.market_state);
    assert_eq!((state.buy_tax_bps, state.sell_tax_bps), (800, 900));
    assert_trades_at(
        &mut env,
        &market,
        &trader,
        (800, 900),
        "before the second change's slot",
    );
    env.warp_slots(RATE_CHANGE_DELAY_SLOTS);
    assert_trades_at(
        &mut env,
        &market,
        &trader,
        (100, 200),
        "from the second change's slot",
    );
}

#[test]
fn renouncing_applies_a_due_change_and_cancels_one_still_pending() {
    // Renounced, a market's taxes never change again, not even by a change it announced.
    for (wait, expected) in [(RATE_CHANGE_DELAY_SLOTS, (800, 900)), (1, (300, 500))] {
        let mut env = Env::new();
        let authority = Keypair::new();
        let (market, trader) = market_with_authority(&mut env, &authority);
        set_taxes(&mut env, &market, &authority, 800, 900);
        env.warp_slots(wait);
        env.send_signed(
            renounce_instruction(&market.market_state, &authority.pubkey()),
            &authority,
        )
        .unwrap();
        let state = env.tax_market(&market.market_state);
        assert_eq!(
            (state.buy_tax_bps, state.sell_tax_bps),
            expected,
            "after {wait} slots"
        );
        assert_eq!(state.pending_from_slot, 0, "after {wait} slots");
        env.warp_slots(RATE_CHANGE_DELAY_SLOTS);
        assert_trades_at(
            &mut env,
            &market,
            &trader,
            expected,
            &format!("renounced after {wait} slots"),
        );
    }
}
