//! Quotes, swaps and adding liquidity value the lent side from Kamino's reserve
//! (docs/spec/lending-pool.md, "Valuing the lent side"): `L = B + V`, with `V` the market's
//! recorded cTokens at the reserve's stored rate, after checking the reserve.
//!
//! The tests give a market cTokens directly ([`Env::give_ctokens`]), so they can set any amount
//! and compare it with a market holding the same value in its buffer; `tests/rebalance.rs`
//! lends through klend's real deposit. Every transaction goes
//! through the real router, against the Kamino reserve dumped from the cluster this build lends
//! on and, where Kamino itself runs, klend's deployed bytes.

mod common;

use common::kamino::redeem_reserve_collateral;
use common::*;
use lending_amm::config::LENT_MINTS;
use lending_amm::kamino::offsets;
use lending_amm::{InitParams, StrategyError};
use pipeline_client::{self as client, AccountMeta, Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Other-side reserve every market starts with: a million tokens of 6 decimals.
const OTHER: u64 = 1_000_000_000_000;

/// A market lending `LENT_MINTS[lent]`, the other mint first and the lent mint second.
fn spec(env: &mut Env, lent: usize, lp_fee_bps: u16) -> MarketSpec {
    let other = env.create_mint(&TOKEN);
    MarketSpec {
        mints: [(other, TOKEN), (ck(&LENT_MINTS[lent].mint), TOKEN)],
        params: InitParams {
            lent_index: 1,
            lp_fee_bps,
        },
    }
}

/// One base unit of lent mint `lent`, times `whole`.
fn units(lent: usize, whole: u64) -> u64 {
    whole * [SOL, 1_000_000][lent]
}

/// The program's view of the reserve a market lends to.
fn reserve(env: &Env, market: &Market) -> lending_amm::kamino::Reserve {
    let entry = &LENT_MINTS[env.lent_entry_of(market)];
    let data = env.data(&ck(&entry.reserve));
    lending_amm::kamino::read_reserve(
        &entry.reserve,
        &lending_amm::config::KLEND_PROGRAM,
        &data,
        entry,
    )
    .unwrap()
}

/// cTokens of the market's reserve worth about `liquidity`, and their value `V`.
fn ctokens_for(env: &Env, market: &Market, liquidity: u64) -> (u64, u64) {
    let reserve = reserve(env, market);
    let supply = reserve.total_supply_sf().unwrap().div_ceil(1 << 60);
    let ctokens = (liquidity as u128 * reserve.mint_total_supply as u128 / supply) as u64;
    (ctokens, reserve.lent_value(ctokens).unwrap())
}

/// Adds `amount` to a market's buffer as if an instruction had put it there: in its lent-mint
/// vault (and, for WSOL, the lamports behind it) and recorded in its market state.
fn give_buffer(env: &mut Env, market: &Market, amount: u64) {
    let vault = market.vaults[market.lent_index];
    let mut account = env.svm.get_account(&vault).unwrap();
    let held = u64::from_le_bytes(account.data[64..72].try_into().unwrap());
    account.data[64..72].copy_from_slice(&(held + amount).to_le_bytes());
    if market.mints[market.lent_index] == wsol() {
        account.lamports += amount;
    }
    env.svm.set_account(vault, account).unwrap();
    let state = env.market_state(&market.market_state);
    let offset = lending_amm::state::layout::RESERVES + 8 * market.lent_index;
    let recorded = state.reserves[market.lent_index] + amount;
    env.patch(&market.market_state, offset, &recorded.to_le_bytes());
}

/// Two markets opened by the same first deposit, `[OTHER, buffer]`, so with the same share
/// count: one then holds cTokens worth about `lent_value`, `V`, and its twin holds `V` more in
/// its buffer instead. Returns both, with `V`.
fn twins(
    env: &mut Env,
    lent: usize,
    fee: u16,
    buffer: u64,
    lent_value: u64,
) -> (Market, Market, u64) {
    let with_ctokens = spec(env, lent, fee);
    let (market, _) = env
        .create_funded_market(&with_ctokens, [OTHER, buffer])
        .unwrap();
    let (ctokens, value) = ctokens_for(env, &market, lent_value);
    env.give_ctokens(&market, ctokens);
    let all_buffer = spec(env, lent, fee);
    let (twin, _) = env
        .create_funded_market(&all_buffer, [OTHER, buffer])
        .unwrap();
    give_buffer(env, &twin, value);
    assert_eq!(env.share_count(&market), env.share_count(&twin));
    (market, twin, value)
}

#[test]
fn quotes_swaps_and_adding_price_the_lent_side_at_its_buffer_plus_its_ctokens_value() {
    for lent in 0..LENT_MINTS.len() {
        for fee in [0, 30, 200] {
            let mut env = Env::new();
            let (market, twin, value) =
                twins(&mut env, lent, fee, units(lent, 10), units(lent, 40));
            assert!(
                value > units(lent, 39),
                "the cTokens are worth about 40 units"
            );
            assert_eq!(
                env.market_state(&market.market_state).reserves[1] + value,
                env.market_state(&twin.market_state).reserves[1]
            );

            // Quotes both ways, from dust to a large sell into the buffer.
            for (input, output, amount) in [
                (0, 1, 1_000),
                (0, 1, OTHER / 50),
                (1, 0, 1_000),
                (1, 0, units(lent, 30)),
            ] {
                // Both refuse alike too, such as dust that would buy nothing.
                let trade = exact_in(input, output, amount);
                assert_eq!(
                    env.quote(&market, &trade).ok(),
                    env.quote(&twin, &trade).ok(),
                    "lent {lent}, fee {fee}: {input}->{output} {amount}"
                );
            }

            // Swaps deliver the same, and move both markets the same way.
            let trader = env.funded_wallet(&market, [OTHER, units(lent, 100)]);
            let twin_trader = env.funded_wallet(&twin, [OTHER, units(lent, 100)]);
            for (sides, amount) in [((0, 1), OTHER / 100), ((1, 0), units(lent, 5))] {
                let paid = env.swap(&market, &trader, sides, amount).unwrap();
                let twin_paid = env.swap(&twin, &twin_trader, sides, amount).unwrap();
                assert_eq!(paid.received, twin_paid.received, "lent {lent}, fee {fee}");
            }
            let (a, b) = (
                env.market_state(&market.market_state),
                env.market_state(&twin.market_state),
            );
            assert_eq!(a.reserves[0], b.reserves[0]);
            assert_eq!(a.reserves[1] + value, b.reserves[1]);

            // Adding mints the same shares for the same amounts.
            let lp = env.funded_wallet(&market, [OTHER, units(lent, 100)]);
            let twin_lp = env.funded_wallet(&twin, [OTHER, units(lent, 100)]);
            let max = [OTHER / 10, units(lent, 50)];
            env.add_liquidity(&market, &lp, max, 0).unwrap();
            env.add_liquidity(&twin, &twin_lp, max, 0).unwrap();
            let shares = env.balance(&lp_shares_account(&lp.pubkey(), &market.market_state));
            let twin_shares =
                env.balance(&lp_shares_account(&twin_lp.pubkey(), &twin.market_state));
            assert!(shares > 0);
            assert_eq!(shares, twin_shares, "lent {lent}, fee {fee}");
            for i in 0..2 {
                assert_eq!(
                    env.balance(&env.wallet_token_account(&market, &lp.pubkey(), i)),
                    env.balance(&env.wallet_token_account(&twin, &twin_lp.pubkey(), i)),
                    "lent {lent}, fee {fee}: mint {i} taken"
                );
            }
        }
    }
}

#[test]
fn ctokens_and_tokens_sent_to_a_market_outside_its_instructions_are_never_credited() {
    let mut env = Env::new();
    let (market, twin, _) = twins(&mut env, 0, 30, 10 * SOL, 40 * SOL);
    let quotes = |env: &Env, market: &Market| {
        [exact_in(0, 1, OTHER / 100), exact_in(1, 0, 5 * SOL)]
            .map(|t| env.quote(market, &t).unwrap())
    };
    let before = quotes(&env, &market);
    let recorded = env.market_state(&market.market_state);

    // cTokens straight into the market's cToken account, and both tokens into its vaults.
    let ctoken_account = market.addresses.ctoken_account;
    let held = env.balance(&ctoken_account);
    env.patch(&ctoken_account, 64, &(held + 1_000 * SOL).to_le_bytes());
    env.donate(&market, 0, &market.vaults[0], OTHER);
    env.donate(&market, 1, &market.vaults[1], 20 * SOL);

    assert_eq!(quotes(&env, &market), before, "donations are never priced");
    assert_eq!(
        env.market_state(&market.market_state),
        recorded,
        "nor recorded"
    );
    assert_eq!(quotes(&env, &twin), before);

    // A swap pays out its quote and credits only what the router sent.
    let trader = env.funded_wallet(&market, [OTHER, 100 * SOL]);
    let twin_trader = env.funded_wallet(&twin, [OTHER, 100 * SOL]);
    for (sides, amount) in [((0, 1), OTHER / 100), ((1, 0), 5 * SOL)] {
        let quote = env
            .quote(&market, &exact_in(sides.0, sides.1, amount))
            .unwrap();
        let paid = env.swap(&market, &trader, sides, amount).unwrap();
        assert_eq!(paid.received, quote.amount_out);
        assert_eq!(
            paid.received,
            env.swap(&twin, &twin_trader, sides, amount)
                .unwrap()
                .received
        );
    }
    // Adding mints what the twin without donations mints.
    let lp = env.funded_wallet(&market, [OTHER, 100 * SOL]);
    let twin_lp = env.funded_wallet(&twin, [OTHER, 100 * SOL]);
    env.add_liquidity(&market, &lp, [OTHER / 10, 50 * SOL], 0)
        .unwrap();
    env.add_liquidity(&twin, &twin_lp, [OTHER / 10, 50 * SOL], 0)
        .unwrap();
    assert_eq!(
        env.balance(&lp_shares_account(&lp.pubkey(), &market.market_state)),
        env.balance(&lp_shares_account(&twin_lp.pubkey(), &twin.market_state))
    );
    // The market's recorded cTokens never moved.
    assert_eq!(
        env.market_state(&market.market_state).ctokens,
        recorded.ctokens
    );
    assert_eq!(env.balance(&ctoken_account), held + 1_000 * SOL);
}

/// The strategy accounts a quote or swap passes, with the reserve (the third) replaced by
/// `reserve`, or left out when it is `None`.
fn with_reserve(
    env: &Env,
    market: &Market,
    trade: &TradeRequest,
    reserve: Option<Pubkey>,
) -> Vec<AccountMeta> {
    let mut accounts = env.resolve_accounts(market, trade).unwrap();
    assert_eq!(accounts[2].pubkey, env.reserve_of(market));
    match reserve {
        Some(address) => accounts[2] = AccountMeta::new_readonly(address, false),
        None => {
            accounts.remove(2);
        }
    }
    accounts
}

fn quote_with(
    env: &Env,
    market: &Market,
    trade: &TradeRequest,
    strategy: Vec<AccountMeta>,
) -> Result<Vec<u8>, String> {
    let mut accounts = env.read_accounts(market, trade);
    accounts.extend(strategy);
    env.simulate(strategy_call(
        client::interface::discriminator::QUOTE,
        trade,
        accounts,
    ))
}

fn swap_with(
    env: &mut Env,
    market: &Market,
    trader: &Keypair,
    (input, output): (usize, usize),
    amount: u64,
    reserve: Option<Pubkey>,
) -> Result<Vec<u8>, String> {
    let mut swap = env
        .swap_instruction(
            market,
            &trader.pubkey(),
            (input, output),
            amount,
            TradeMode::ExactIn,
        )
        .unwrap();
    let reserve_key = env.reserve_of(market);
    let at = swap
        .accounts
        .iter()
        .position(|a| a.pubkey == reserve_key)
        .unwrap();
    match reserve {
        Some(address) => swap.accounts[at] = AccountMeta::new_readonly(address, false),
        None => {
            swap.accounts.remove(at);
        }
    }
    env.send(&[swap], &[trader])
}

fn add_with(
    env: &mut Env,
    market: &Market,
    lp: &Keypair,
    reserve: Option<Pubkey>,
) -> Result<Vec<u8>, String> {
    let mut add = env.add_liquidity_instruction(market, &lp.pubkey(), [OTHER / 10, 5 * SOL], 0);
    let reserve_key = env.reserve_of(market);
    let at = add
        .accounts
        .iter()
        .position(|a| a.pubkey == reserve_key)
        .unwrap();
    match reserve {
        Some(address) => add.accounts[at] = AccountMeta::new_readonly(address, false),
        None => {
            add.accounts.remove(at);
        }
    }
    env.send(&[add], &[lp])
}

/// A funded WSOL-lent market holding cTokens, with a trader and an LP ready.
fn market_with_ctokens(env: &mut Env) -> (Market, Keypair, Keypair) {
    let spec = spec(env, 0, 30);
    let (market, _) = env.create_funded_market(&spec, [OTHER, 10 * SOL]).unwrap();
    let (ctokens, _) = ctokens_for(env, &market, 40 * SOL);
    env.give_ctokens(&market, ctokens);
    let trader = env.funded_wallet(&market, [OTHER, 100 * SOL]);
    let lp = env.funded_wallet(&market, [OTHER, 100 * SOL]);
    (market, trader, lp)
}

/// Fails unless a quote both ways, a swap both ways and adding liquidity are all refused with
/// `error`.
fn assert_all_refused(
    env: &mut Env,
    market: &Market,
    trader: &Keypair,
    lp: &Keypair,
    reserve: Option<Pubkey>,
    error: StrategyError,
    case: &str,
) {
    for (input, output, amount) in [(0, 1, OTHER / 100), (1, 0, SOL)] {
        let trade = exact_in(input, output, amount);
        let strategy = if reserve == Some(env.reserve_of(market)) {
            env.resolve_accounts(market, &trade).unwrap()
        } else {
            with_reserve(env, market, &trade, reserve)
        };
        println!("{case}: quote {input}->{output}");
        assert_refused(quote_with(env, market, &trade, strategy), error);
        println!("{case}: swap {input}->{output}");
        assert_refused(
            swap_with(env, market, trader, (input, output), amount, reserve),
            error,
        );
    }
    println!("{case}: add_liquidity");
    let added = add_with(env, market, lp, reserve);
    if reserve.is_none() {
        // The reserve is add_liquidity's last named account, so Anchor refuses first.
        assert_anchor_error(added, 3005);
    } else {
        assert_refused(added, error);
    }
}

#[test]
fn a_reserve_failing_any_part_of_the_check_refuses_quotes_swaps_and_adding() {
    let address = ck(&LENT_MINTS[0].reserve);

    // The address: the reserve's own bytes at another address, and the other lent mint's
    // reserve.
    let mut env = Env::new();
    let (market, trader, lp) = market_with_ctokens(&mut env);
    let elsewhere = Pubkey::new_unique();
    let copy = env.svm.get_account(&address).unwrap();
    env.svm.set_account(elsewhere, copy).unwrap();
    for wrong in [elsewhere, ck(&LENT_MINTS[1].reserve)] {
        assert_all_refused(
            &mut env,
            &market,
            &trader,
            &lp,
            Some(wrong),
            StrategyError::ReserveWrongAddress,
            "address",
        );
    }

    // The owner, the size, the discriminator, the lending market, the liquidity mint and the
    // collateral mint, each broken in turn on the real reserve.
    type Break = Box<dyn Fn(&mut Env)>;
    let cases: Vec<(&str, Break, StrategyError)> = vec![
        (
            "owner",
            Box::new(move |env: &mut Env| {
                let mut account = env.svm.get_account(&address).unwrap();
                account.owner = Pubkey::new_unique();
                env.svm.set_account(address, account).unwrap();
            }),
            StrategyError::ReserveNotKamino,
        ),
        (
            "size",
            Box::new(move |env: &mut Env| {
                let mut account = env.svm.get_account(&address).unwrap();
                account.data.push(0);
                env.svm.set_account(address, account).unwrap();
            }),
            StrategyError::ReserveWrongSize,
        ),
        (
            "discriminator",
            Box::new(move |env: &mut Env| env.patch(&address, 0, &[0])),
            StrategyError::ReserveWrongDiscriminator,
        ),
        (
            "lending market",
            Box::new(move |env: &mut Env| env.patch(&address, offsets::LENDING_MARKET, &[0; 32])),
            StrategyError::ReserveWrongLendingMarket,
        ),
        (
            "liquidity mint",
            Box::new(move |env: &mut Env| env.patch(&address, offsets::LIQUIDITY_MINT, &[0; 32])),
            StrategyError::ReserveWrongLiquidityMint,
        ),
        (
            "collateral mint",
            Box::new(move |env: &mut Env| env.patch(&address, offsets::COLLATERAL_MINT, &[0; 32])),
            StrategyError::ReserveWrongCollateralMint,
        ),
    ];
    for (case, break_it, error) in cases {
        let mut env = Env::new();
        let (market, trader, lp) = market_with_ctokens(&mut env);
        break_it(&mut env);
        assert_all_refused(&mut env, &market, &trader, &lp, Some(address), error, case);
    }
}

#[test]
fn a_market_with_no_ctokens_still_refuses_a_reserve_that_fails_the_check() {
    // Every market on chain holds no cTokens until rebalance lends; the check runs anyway.
    let mut env = Env::new();
    let spec = spec(&mut env, 0, 30);
    let (market, _) = env.create_funded_market(&spec, [OTHER, 10 * SOL]).unwrap();
    let trader = env.funded_wallet(&market, [OTHER, 100 * SOL]);
    let lp = env.funded_wallet(&market, [OTHER, 100 * SOL]);
    env.patch(&ck(&LENT_MINTS[0].reserve), 0, &[0]);
    assert_all_refused(
        &mut env,
        &market,
        &trader,
        &lp,
        Some(ck(&LENT_MINTS[0].reserve)),
        StrategyError::ReserveWrongDiscriminator,
        "no cTokens",
    );
}

#[test]
fn a_swap_or_deposit_built_without_the_reserve_is_refused() {
    let mut env = Env::new();
    let (market, trader, lp) = market_with_ctokens(&mut env);
    assert_all_refused(
        &mut env,
        &market,
        &trader,
        &lp,
        None,
        StrategyError::ReserveWrongAddress,
        "no reserve",
    );

    // With a hooked other side, the hook's accounts follow the strategy's own, so the account
    // in the reserve's place is the hook's.
    let mut env = Env::new();
    let (hooked, _) = env.create_hooked_mint();
    let spec = MarketSpec {
        mints: [(hooked, TOKEN_2022), (wsol(), TOKEN)],
        params: InitParams {
            lent_index: 1,
            lp_fee_bps: 30,
        },
    };
    let (market, _) = env.create_funded_market(&spec, [OTHER, 10 * SOL]).unwrap();
    let trader = env.funded_wallet(&market, [OTHER, 100 * SOL]);
    assert_refused(
        swap_with(&mut env, &market, &trader, (1, 0), SOL, None),
        StrategyError::ReserveWrongAddress,
    );
}

#[test]
fn account_resolution_lists_the_reserve_read_only_and_swaps_never_write_lock_it() {
    let mut env = Env::new();
    let (market, trader, _) = market_with_ctokens(&mut env);
    for (input, output) in [(0, 1), (1, 0)] {
        let trade = exact_in(input, output, SOL);
        let accounts = env.resolve_accounts(&market, &trade).unwrap();
        assert_eq!(
            accounts
                .iter()
                .map(|a| (a.pubkey, a.is_writable))
                .collect::<Vec<_>>(),
            vec![
                (market.vaults[output], true),
                (market.addresses.authority, false),
                (env.reserve_of(&market), false),
            ]
        );
        let swap = env
            .swap_instruction(
                &market,
                &trader.pubkey(),
                (input, output),
                SOL,
                TradeMode::ExactIn,
            )
            .unwrap();
        let reserve = swap
            .accounts
            .iter()
            .find(|a| a.pubkey == env.reserve_of(&market))
            .expect("the swap passes the reserve");
        assert!(
            !reserve.is_writable,
            "the swap write-locks Kamino's reserve"
        );
        let before = env.data(&env.reserve_of(&market));
        env.send(&[swap], &[&trader]).unwrap();
        assert_eq!(
            env.data(&env.reserve_of(&market)),
            before,
            "the swap changed the reserve"
        );
    }
}

#[test]
fn the_stored_rate_is_used_as_it_is() {
    let mut env = Env::new();
    env.load_klend();
    let (market, trader, _) = market_with_ctokens(&mut env);
    let address = env.reserve_of(&market);
    // Give the reserve debt, so interest accrues, if it has less than one unit borrowed.
    let data = env.data(&address);
    let borrowed = u128::from_le_bytes(
        data[offsets::BORROWED_AMOUNT_SF..][..16]
            .try_into()
            .unwrap(),
    );
    if borrowed >> 60 == 0 {
        let available = u64::from_le_bytes(
            data[offsets::TOTAL_AVAILABLE_AMOUNT..][..8]
                .try_into()
                .unwrap(),
        );
        env.patch(
            &address,
            offsets::BORROWED_AMOUNT_SF,
            &(((available / 2) as u128) << 60).to_le_bytes(),
        );
    }

    // A day after the reserve was last refreshed, quotes and swaps refuse it as too stale to
    // value the market's cTokens, since a round trip across a refresh could then pay
    // (finding H-S2, docs/security/lending-amm/).
    use lending_amm::config::TRADE_MAX_RESERVE_AGE_SLOTS as AGE;
    let start = env.clock();
    env.advance_clock(216_000, 86_400);
    assert_refused(
        env.quote(&market, &exact_in(0, 1, OTHER / 100)),
        StrategyError::ReserveStale,
    );
    assert_refused(
        env.swap(&market, &trader, (0, 1), OTHER / 100),
        StrategyError::ReserveStale,
    );
    // Up to an hour after it, nothing has refreshed it: quotes and swaps both price at the stored
    // rate, so each swap delivers its quote.
    env.set_clock(
        start.slot + AGE,
        start.unix_timestamp + (AGE * 2 / 5) as i64,
    );
    for (sides, amount) in [((0, 1), OTHER / 100), ((1, 0), SOL)] {
        let quote = env
            .quote(&market, &exact_in(sides.0, sides.1, amount))
            .unwrap();
        let paid = env.swap(&market, &trader, sides, amount).unwrap();
        assert_eq!(paid.received, quote.amount_out);
    }

    // Once klend accrues the hour's interest (any redeem refreshes the reserve), the market's
    // cTokens are worth more, so the same sell of the other side buys more of the lent side.
    let sell = exact_in(0, 1, OTHER / 100);
    let stored = env.quote(&market, &sell).unwrap();
    let ctokens = env.market_state(&market.market_state).ctokens;
    let value_before = reserve(&env, &market).lent_value(ctokens).unwrap();
    let holder = Keypair::new();
    env.svm.airdrop(&holder.pubkey(), SOL).unwrap();
    let collateral = env.spl_account(&holder.pubkey(), &ck(&LENT_MINTS[0].collateral_mint), 1);
    let liquidity = env.spl_account(&holder.pubkey(), &wsol(), 0);
    let redeem =
        redeem_reserve_collateral(&env.kamino, 0, &holder.pubkey(), &collateral, &liquidity, 1);
    env.send(&[redeem], &[&holder]).unwrap();
    let value_after = reserve(&env, &market).lent_value(ctokens).unwrap();
    println!("the market's cTokens: worth {value_before} at the stored rate, {value_after} once klend accrued an hour");
    assert!(value_after > value_before);
    let accrued = env.quote(&market, &sell).unwrap();
    println!(
        "a sell of {} quoted {} before, {} after",
        sell.amount, stored.amount_out, accrued.amount_out
    );
    assert!(accrued.amount_out > stored.amount_out);
    let paid = env.swap(&market, &trader, (0, 1), OTHER / 100).unwrap();
    assert_eq!(paid.received, accrued.amount_out);
}

#[test]
fn a_market_with_no_ctokens_trades_from_its_buffer_when_the_reserve_supply_cannot_be_computed() {
    // V = 0 needs nothing from the reserve but its check, so a reserve whose fees exceed what
    // it holds (which klend could not redeem from either) stops only markets holding cTokens.
    let mut env = Env::new();
    let spec = spec(&mut env, 0, 30);
    let (market, _) = env.create_funded_market(&spec, [OTHER, 10 * SOL]).unwrap();
    let (lent_market, lent_trader, lent_lp) = market_with_ctokens(&mut env);
    let trader = env.funded_wallet(&market, [OTHER, 100 * SOL]);
    let lp = env.funded_wallet(&market, [OTHER, 100 * SOL]);
    let address = ck(&LENT_MINTS[0].reserve);
    env.patch(
        &address,
        offsets::ACCUMULATED_PROTOCOL_FEES_SF,
        &u128::MAX.to_le_bytes(),
    );

    let quote = env.quote(&market, &exact_in(1, 0, SOL)).unwrap();
    assert_eq!(
        env.swap(&market, &trader, (1, 0), SOL).unwrap().received,
        quote.amount_out
    );
    env.add_liquidity(&market, &lp, [OTHER / 10, 5 * SOL], 0)
        .unwrap();

    assert_all_refused(
        &mut env,
        &lent_market,
        &lent_trader,
        &lent_lp,
        Some(address),
        StrategyError::ReserveSupplyInvalid,
        "supply invalid, holding cTokens",
    );
}
