//! `rebalance`, the permissionless keeper job that moves a market's buffer back to its target
//! by depositing into Kamino or redeeming from it whenever the buffer's share of the lent side
//! has left its band (docs/spec/lending-pool.md, "The rule" and "When it runs").
//!
//! Every transaction goes through the real programs: the router copied from devnet, the
//! lending AMM, and klend's deployed bytes with the Kamino accounts dumped from the cluster
//! this build lends on.

mod common;

use common::rebalance::{lent_spec, units, OTHER};
use common::*;
use lending_amm::config::{BUFFER_TARGET_BPS, LENT_MINTS};
use lending_amm::events::{RebalanceDirection, Rebalanced};
use lending_amm::kamino::ctokens_for_value;
use lending_amm::StrategyError;
use pipeline_client::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

#[test]
fn above_the_band_it_deposits_the_surplus_through_klends_real_deposit() {
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        let spec = lent_spec(&mut env, lent, 30);
        let buffer = units(lent, 50);
        let (market, _) = env.create_funded_market(&spec, [OTHER, buffer]).unwrap();
        let ctoken_account = market.addresses.ctoken_account;
        let vault = market.vaults[market.lent_index];
        let supply_before = env.program_reserve(&market).mint_total_supply;

        // Everything is in the buffer, so its share is 100%: it deposits B - L x 20%.
        let wanted = buffer - buffer * BUFFER_TARGET_BPS as u64 / 10_000;
        let meta = env.rebalance(&market, None).unwrap();

        let state = env.market_state(&market.market_state);
        let minted = env.balance(&ctoken_account);
        let taken = buffer - env.balance(&vault);
        println!("lent {lent}: asked klend to take {wanted}, it took {taken} for {minted} cTokens");
        assert!(minted > 0);
        // klend's own deposit minted the cTokens: its cToken supply grew by exactly them.
        assert_eq!(
            env.program_reserve(&market).mint_total_supply - supply_before,
            minted
        );
        // klend takes back only what the cTokens it mints are worth, rounded up, so at most
        // what was asked and never less than one cToken's worth below it.
        assert!(taken <= wanted && wanted - taken <= 2, "{wanted} {taken}");
        // The market recorded exactly what moved.
        assert_eq!(state.ctokens, minted);
        assert_eq!(state.reserves[market.lent_index], buffer - taken);
        assert_eq!(state.deposited, taken as u128);
        assert_eq!(state.redeemed, 0);
        // The buffer is back at its target, 20% of the lent side, within klend's rounding.
        let total = env.lent_total(&market);
        let target = total as u128 * BUFFER_TARGET_BPS as u128 / 10_000;
        assert!(state.reserves[market.lent_index] as u128 - target <= 2);

        let events = events::<Rebalanced>(&meta.logs);
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.market_state, ak(&market.market_state));
        assert_eq!(event.direction, RebalanceDirection::Deposit);
        assert_eq!(event.liquidity, taken);
        assert_eq!(event.ctokens, minted);
        assert_eq!(event.buffer, state.reserves[market.lent_index]);
        assert_eq!(event.ctokens_held, state.ctokens);
    }
}

/// A market lending `LENT_MINTS[lent]` whose buffer holds exactly `buffer` and which has
/// recorded `ctokens` cTokens, from a first deposit of `[OTHER, buffer]`.
fn market_with(env: &mut Env, lent: usize, buffer: u64, ctokens: u64) -> Market {
    let spec = lent_spec(env, lent, 30);
    let (market, _) = env.create_funded_market(&spec, [OTHER, buffer]).unwrap();
    if ctokens > 0 {
        env.give_ctokens(&market, ctokens);
    }
    market
}

/// Every byte of the market's state, vaults and cToken account, and of the reserve, to show a
/// refused call changed nothing.
fn snapshot(env: &Env, market: &Market) -> Vec<Vec<u8>> {
    let mut accounts = vec![
        market.market_state,
        market.vaults[0],
        market.vaults[1],
        market.addresses.ctoken_account,
        env.reserve_of(market),
    ];
    accounts.dedup();
    accounts.iter().map(|a| env.data(a)).collect()
}

/// The smallest cToken amount from `from` up whose value is a multiple of `k`, with that value.
fn ctokens_valued_at_multiple_of(env: &Env, market: &Market, from: u64, k: u64) -> (u64, u64) {
    let reserve = env.program_reserve(market);
    (from..)
        .map(|c| (c, reserve.lent_value(c).unwrap()))
        .find(|(_, v)| v % k == 0)
        .unwrap()
}

#[test]
fn inside_the_band_it_fails_with_within_band_and_changes_nothing() {
    for (lent, entry) in LENT_MINTS.iter().enumerate() {
        let mut env = Env::new();
        // After lending, the buffer is at its target, inside the band.
        let mut probe = market_with(&mut env, lent, units(lent, 50), 0);
        env.rebalance(&probe, None).unwrap();
        let before = snapshot(&env, &probe);
        assert_refused(env.rebalance(&probe, None), StrategyError::WithinBand);
        assert_eq!(snapshot(&env, &probe), before);

        // Exactly at either edge is inside: B = V / 9 is 10% of L, and B = 3V / 7 is 30%.
        // With V about 8 times the floor, one unit beyond 30% deposits V / 7, above the floor,
        // and one unit below 10% plans a redeem of V / 9, below it.
        let floor = entry.min_rebalance;
        for (k, numerator, edge) in [(9, 1, "10%"), (7, 3, "30%")] {
            probe = market_with(&mut env, lent, 1, 0);
            let from = {
                let r = env.program_reserve(&probe);
                ctokens_for_value(8 * floor, r.total_supply_sf().unwrap(), r.mint_total_supply)
                    .unwrap()
            };
            let (ctokens, value) = ctokens_valued_at_multiple_of(&env, &probe, from, k);
            let buffer = value / k * numerator;
            let market = market_with(&mut env, lent, buffer, ctokens);
            let before = snapshot(&env, &market);
            assert_refused(env.rebalance(&market, None), StrategyError::WithinBand);
            assert_eq!(snapshot(&env, &market), before, "lent {lent} at {edge}");
            // One unit outside the edge, it is no longer inside the band: at 30% plus one it
            // deposits, and at 10% less one the redeem it plans is below the floor.
            let outside = if numerator == 3 {
                buffer + 1
            } else {
                buffer - 1
            };
            let market = market_with(&mut env, lent, outside, ctokens);
            let result = env.rebalance(&market, None);
            if numerator == 3 {
                result.unwrap();
            } else {
                assert_refused(result, StrategyError::BelowMinRebalance);
            }
        }
    }
}

#[test]
fn a_move_smaller_than_min_rebalance_is_skipped_at_the_wsol_and_the_usdc_floor() {
    for (lent, entry) in LENT_MINTS.iter().enumerate() {
        let floor = entry.min_rebalance;
        // With nothing lent the deposit is B - floor(B / 5): exactly the floor for this
        // buffer, and one unit below it for a buffer two units smaller.
        let at_floor = floor / 4 * 5;
        let mut env = Env::new();
        let below = market_with(&mut env, lent, at_floor - 2, 0);
        let before = snapshot(&env, &below);
        assert_refused(
            env.rebalance(&below, None),
            StrategyError::BelowMinRebalance,
        );
        assert_eq!(snapshot(&env, &below), before);

        let market = market_with(&mut env, lent, at_floor, 0);
        env.rebalance(&market, None).unwrap();
        let state = env.market_state(&market.market_state);
        println!(
            "{}: at the floor of {floor} it lent {} of a buffer of {at_floor}",
            common::kamino::lent_name(lent),
            state.deposited
        );
        assert!(state.deposited as u64 <= floor && floor - state.deposited as u64 <= 2);
    }
}

/// The running lending yield so far, `V + redeemed - deposited`.
fn yield_so_far(env: &Env, market: &Market) -> i128 {
    let state = env.market_state(&market.market_state);
    let value = env
        .program_reserve(market)
        .lent_value(state.ctokens)
        .unwrap();
    value as i128 + state.redeemed as i128 - state.deposited as i128
}

/// What one cToken of the market's reserve is worth, rounded up.
fn one_ctoken(env: &Env, market: &Market) -> u64 {
    let r = env.program_reserve(market);
    r.total_supply_sf()
        .unwrap()
        .div_ceil((r.mint_total_supply as u128) << 60) as u64
}

#[test]
fn below_the_band_it_redeems_the_shortfall_through_klends_real_redeem() {
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        let market = env.market_below_the_band(lent);
        let vault = market.vaults[market.lent_index];
        let ctoken_account = market.addresses.ctoken_account;
        let before = env.market_state(&market.market_state);
        let buffer = before.reserves[market.lent_index];
        let total = env.lent_total(&market);
        let wanted = total * BUFFER_TARGET_BPS as u64 / 10_000 - buffer;
        let (vault_before, ctokens_before) = (env.balance(&vault), env.balance(&ctoken_account));

        let meta = env.rebalance(&market, None).unwrap();

        let state = env.market_state(&market.market_state);
        let received = env.balance(&vault) - vault_before;
        let burned = ctokens_before - env.balance(&ctoken_account);
        println!(
            "lent {lent}: buffer {buffer} of {total}, asked for {wanted}, klend paid {received} \
             for {burned} cTokens"
        );
        // It burned as many cTokens as are worth at most the shortfall, so the buffer never
        // passes its target, and lands less than one cToken's worth short of it.
        assert!(received <= wanted && wanted - received <= one_ctoken(&env, &market));
        assert_eq!(state.reserves[market.lent_index], buffer + received);
        assert_eq!(state.ctokens, before.ctokens - burned);
        assert_eq!(state.redeemed, received as u128);
        assert_eq!(state.deposited, before.deposited);
        // What it lent and what it took back leave the lending yield so far where Kamino's
        // rounding puts it: within a unit or two of nothing, since no time has passed.
        let earned = yield_so_far(&env, &market);
        assert!((-2..=2).contains(&earned), "yield {earned}");
        let event = &events::<Rebalanced>(&meta.logs)[0];
        assert_eq!(event.direction, RebalanceDirection::Redeem);
        assert_eq!((event.liquidity, event.ctokens), (received, burned));
        assert_eq!(
            (event.deposited, event.redeemed),
            (state.deposited, state.redeemed)
        );
    }
}

#[test]
fn a_redeem_is_capped_at_what_kamino_can_pay_right_now() {
    for (lent, entry) in LENT_MINTS.iter().enumerate() {
        let mut env = Env::new();
        let market = env.market_below_the_band(lent);
        let state = env.market_state(&market.market_state);
        let shortfall = env.lent_total(&market) * BUFFER_TARGET_BPS as u64 / 10_000
            - state.reserves[market.lent_index];
        // Kamino's withdrawal cap has less left in this interval than the shortfall, though
        // more than the floor: written into the cloned reserve, and klend's redeem enforces it.
        let cap = (shortfall + entry.min_rebalance) / 2;
        let address = env.reserve_of(&market);
        let now = env.clock().unix_timestamp as u64;
        let mut fields = Vec::new();
        fields.extend_from_slice(&(cap as i64 + 1_000).to_le_bytes());
        fields.extend_from_slice(&1_000i64.to_le_bytes());
        fields.extend_from_slice(&now.to_le_bytes());
        fields.extend_from_slice(&86_400u64.to_le_bytes());
        env.patch(
            &address,
            lending_amm::kamino::offsets::WITHDRAWAL_CAP,
            &fields,
        );

        env.rebalance(&market, None).unwrap();
        let received = env.market_state(&market.market_state).redeemed as u64;
        println!("lent {lent}: shortfall {shortfall}, Kamino could pay {cap}, it paid {received}");
        // It plans against the cap less KAMINO_RATE_HEADROOM_BPS of it, for the rate klend
        // refreshes to, and lands within one cToken's worth of that.
        let planned = lending_amm::kamino::with_rate_headroom(cap);
        assert!(received <= planned && planned - received <= one_ctoken(&env, &market));
    }
}

#[test]
fn anyone_may_call_it_it_creates_no_account_and_the_caller_pays_only_the_fee() {
    let mut env = Env::new();
    env.load_klend();
    let market = market_with(&mut env, 0, units(0, 50), 0);
    // A stranger with nothing to do with the market pays for its own transaction.
    let caller = solana_keypair::Keypair::new();
    env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
    let instruction = env.rebalance_instruction(&market, &caller.pubkey());
    // Every account it may write exists already, so it can create none, and the caller is
    // read-only in it, so the program can take nothing from them.
    for meta in instruction.accounts.iter().filter(|meta| meta.is_writable) {
        assert!(
            env.svm.get_account(&meta.pubkey).is_some(),
            "{}",
            meta.pubkey
        );
    }
    assert!(!instruction.accounts[0].is_writable && instruction.accounts[0].is_signer);
    let before = env.svm.get_balance(&caller.pubkey()).unwrap();
    env.svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&caller.pubkey()),
        &[&caller],
        env.svm.latest_blockhash(),
    );
    let meta = env.svm.send_transaction(tx).unwrap();
    let after = env.svm.get_balance(&caller.pubkey()).unwrap();
    println!(
        "the caller paid {} lamports, the fee {}",
        before - after,
        meta.fee
    );
    assert_eq!(before - after, meta.fee);
    assert_eq!(meta.fee, 5_000);
    assert!(env.market_state(&market.market_state).ctokens > 0);
}

/// Quotes of a small trade each way, the other side's reserve, the lent side's total and the
/// share count.
fn price_and_shares(env: &Env, market: &Market, lent: usize) -> ([u64; 2], u64, u64, u64) {
    let (other, lent_side) = (market.other_index(), market.lent_index);
    let sell = env
        .quote(market, &exact_in(other, lent_side, 1_000_000_000))
        .unwrap()
        .amount_out;
    let buy = env
        .quote(market, &exact_in(lent_side, other, units(lent, 1)))
        .unwrap()
        .amount_out;
    let state = env.market_state(&market.market_state);
    (
        [sell, buy],
        state.reserves[other],
        env.lent_total(market),
        env.share_count(market),
    )
}

#[test]
fn a_rebalance_leaves_the_price_where_it_was_and_lowers_no_lp_shares_value() {
    for lent in 0..LENT_MINTS.len() {
        for direction in ["deposit", "redeem"] {
            let mut env = Env::new();
            let market = if direction == "deposit" {
                market_with(&mut env, lent, units(lent, 50), 0)
            } else {
                env.market_below_the_band(lent)
            };
            let (quotes, other, total, shares) = price_and_shares(&env, &market, lent);
            env.rebalance(&market, None).unwrap();
            let (quotes_after, other_after, total_after, shares_after) =
                price_and_shares(&env, &market, lent);
            println!(
                "lent {lent} {direction}: quotes {quotes:?} -> {quotes_after:?}, \
                 L {total} -> {total_after}"
            );
            // The other side and the share count do not move at all; the lent side's total
            // moves only by Kamino's rounding, at most one unit down, so no LP share loses more
            // than that unit's share, and each quote moves by at most what one unit of the lent
            // side is worth: one unit of the lent mint, or R / L units of the other.
            assert_eq!((other_after, shares_after), (other, shares));
            assert!(total_after + 1 >= total && total_after <= total + 1);
            let one_lent_unit = [1, other.div_ceil(total) + 1];
            for ((before, after), bound) in quotes.iter().zip(quotes_after).zip(one_lent_unit) {
                assert!(before.abs_diff(after) <= bound, "{before} {after} {bound}");
            }
        }
    }
}

#[test]
fn after_lending_add_liquidity_comes_in_at_the_ratio_without_calling_kamino_and_dilutes_nobody() {
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        let market = market_with(&mut env, lent, units(lent, 50), 0);
        env.rebalance(&market, None).unwrap();
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let before = env.market_state(&market.market_state);
        let (r, l, n) = (
            before.reserves[other],
            env.lent_total(&market),
            env.share_count(&market),
        );

        // A new LP offers a tenth of each side, and twice as much of the lent mint as needed.
        let mut max = [0u64; 2];
        max[other] = r / 10;
        max[lent_side] = l / 5;
        let lp = env.funded_wallet(&market, max);
        let meta = env.add_liquidity(&market, &lp, max, 0).unwrap();

        // Kamino is never called: the lent side joins the buffer, the cTokens stay as they were.
        let klend = common::kamino::klend().to_string();
        assert!(!meta.logs.iter().any(|line| line.contains(&klend)));
        let after = env.market_state(&market.market_state);
        assert_eq!(after.ctokens, before.ctokens);
        assert_eq!(
            (after.deposited, after.redeemed),
            (before.deposited, before.redeemed)
        );
        let took_other = after.reserves[other] - r;
        let took_lent = after.reserves[lent_side] - before.reserves[lent_side];
        // At the ratio R : L, the lent side valued at its buffer plus its cTokens: the shares
        // minted are min(other x N / R, lent x N / L), and it took what they are worth, rounded
        // up, of each side; the lent mint was the side offered in excess.
        let minted = env.share_count(&market) - n;
        let expected =
            |offered: u64, side: u64| (offered as u128 * n as u128 / side as u128) as u64;
        assert_eq!(
            minted,
            expected(max[other], r).min(expected(max[lent_side], l))
        );
        let worth = |side: u64| (minted as u128 * side as u128).div_ceil(n as u128) as u64;
        assert_eq!((took_other, took_lent), (worth(r), worth(l)));
        assert!(took_lent < max[lent_side]);
        // Earlier LPs are not diluted: each share holds at least as much of each side.
        let (r2, l2, n2) = (
            after.reserves[other],
            env.lent_total(&market),
            env.share_count(&market),
        );
        assert!(r2 as u128 * n as u128 >= r as u128 * n2 as u128);
        assert!(l2 as u128 * n as u128 >= l as u128 * n2 as u128);
    }
}

/// Gives a reserve with less than one unit borrowed some debt, so interest accrues; the
/// `devnet` dump's reserves hold only dust left by a repaid test borrow.
fn ensure_borrowed(env: &mut Env, lent: usize) {
    use lending_amm::kamino::offsets;
    let address = ck(&LENT_MINTS[lent].reserve);
    let data = env.data(&address);
    let borrowed = u128::from_le_bytes(
        data[offsets::BORROWED_AMOUNT_SF..offsets::BORROWED_AMOUNT_SF + 16]
            .try_into()
            .unwrap(),
    );
    if borrowed >> 60 == 0 {
        let available = u64::from_le_bytes(
            data[offsets::TOTAL_AVAILABLE_AMOUNT..offsets::TOTAL_AVAILABLE_AMOUNT + 8]
                .try_into()
                .unwrap(),
        );
        // Half as much borrowed as is available, so utilisation is a third.
        let borrowed = (available as u128 / 2) << 60;
        env.patch(
            &address,
            offsets::BORROWED_AMOUNT_SF,
            &borrowed.to_le_bytes(),
        );
    }
}

/// Makes klend refresh the reserve of `LENT_MINTS[lent]` now, accruing its interest, the way
/// any Kamino user's redeem does: a stranger redeems one cToken.
fn refresh_reserve(env: &mut Env, lent: usize) {
    let entry = &LENT_MINTS[lent];
    let stranger = solana_keypair::Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let collateral = env.spl_account(&stranger.pubkey(), &ck(&entry.collateral_mint), 1);
    let liquidity = env.spl_account(&stranger.pubkey(), &ck(&entry.mint), 0);
    let redeem = common::kamino::redeem_reserve_collateral(
        &env.kamino,
        lent,
        &stranger.pubkey(),
        &collateral,
        &liquidity,
        1,
    );
    env.send(&[redeem], &[&stranger]).unwrap();
}

#[test]
fn as_klend_accrues_interest_the_lent_value_the_yield_and_an_lp_shares_value_rise() {
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        env.load_klend();
        ensure_borrowed(&mut env, lent);
        let market = market_with(&mut env, lent, units(lent, 50), 0);
        env.rebalance(&market, None).unwrap();
        let ctokens = env.market_state(&market.market_state).ctokens;
        let value = env.program_reserve(&market).lent_value(ctokens).unwrap();
        let earned = yield_so_far(&env, &market);
        let (_, _, total, shares) = price_and_shares(&env, &market, lent);

        // A day later klend refreshes the reserve and accrues a day of interest.
        env.advance_clock(216_000, 86_400);
        refresh_reserve(&mut env, lent);

        let value_after = env.program_reserve(&market).lent_value(ctokens).unwrap();
        let earned_after = yield_so_far(&env, &market);
        let (_, _, total_after, shares_after) = price_and_shares(&env, &market, lent);
        println!(
            "lent {lent}: V {value} -> {value_after}, yield {earned} -> {earned_after}, \
             L per share {total}/{shares} -> {total_after}/{shares_after}"
        );
        assert!(value_after > value);
        assert!(earned_after > earned && earned_after > 0);
        assert_eq!(shares_after, shares);
        assert!(total_after > total);
    }
}

#[test]
fn a_substituted_kamino_account_or_another_markets_account_is_refused() {
    use common::rebalance::position;
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        env.load_klend();
        let market = market_with(&mut env, lent, units(lent, 50), 0);
        let neighbour = market_with(&mut env, lent, units(lent, 50), 0);
        let other_entry = common::kamino::lent_name(1 - lent);
        let k = env.kamino.clone();
        // A copy of the lending market at another address, owned by klend like the real one.
        let fake_market = Pubkey::new_unique();
        let real_market = env.svm.get_account(&k.address("lending-market")).unwrap();
        env.svm.set_account(fake_market, real_market).unwrap();
        let clock_sysvar: Pubkey = "SysvarC1ock11111111111111111111111111111111"
            .parse()
            .unwrap();

        let cases: Vec<(&str, Pubkey, Result<StrategyError, u32>)> = vec![
            (
                "reserve",
                k.address(&format!("reserve-{other_entry}")),
                Ok(StrategyError::ReserveWrongAddress),
            ),
            (
                "klend_program",
                pipeline_client::PROGRAM_ID,
                Ok(StrategyError::KaminoAccountWrong),
            ),
            (
                "lending_market",
                fake_market,
                Ok(StrategyError::LendingMarketWrongAccount),
            ),
            (
                "lending_market_authority",
                Pubkey::new_unique(),
                Ok(StrategyError::KaminoAccountWrong),
            ),
            (
                "reserve_liquidity_supply",
                k.address(&format!("liquidity-supply-{other_entry}")),
                Ok(StrategyError::KaminoAccountWrong),
            ),
            (
                "collateral_mint",
                k.address(&format!("collateral-mint-{other_entry}")),
                Ok(StrategyError::KaminoAccountWrong),
            ),
            (
                "lent_mint",
                k.address(&format!("liquidity-mint-{other_entry}")),
                Ok(StrategyError::KaminoAccountWrong),
            ),
            (
                "token_program",
                TOKEN_2022,
                Ok(StrategyError::KaminoAccountWrong),
            ),
            (
                "instructions_sysvar",
                clock_sysvar,
                Ok(StrategyError::KaminoAccountWrong),
            ),
            (
                "ctoken_account",
                neighbour.addresses.ctoken_account,
                Ok(StrategyError::WrongAccount),
            ),
            (
                "buffer_vault",
                neighbour.vaults[neighbour.lent_index],
                Ok(StrategyError::WrongAccount),
            ),
            (
                "buffer_vault",
                market.vaults[market.other_index()],
                Ok(StrategyError::WrongAccount),
            ),
            // Anchor's ConstraintSeeds.
            ("authority", neighbour.addresses.authority, Err(2006)),
        ];
        for (name, substitute, refusal) in cases {
            let caller = solana_keypair::Keypair::new();
            env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
            let mut instruction = env.rebalance_instruction(&market, &caller.pubkey());
            instruction.accounts[position(name)].pubkey = substitute;
            let before = (snapshot(&env, &market), snapshot(&env, &neighbour));
            let result = env.send_meta(&[instruction], &[&caller]);
            match refusal {
                Ok(error) => assert_refused(result, error),
                Err(number) => assert_anchor_error(result, number),
            }
            assert_eq!(
                (snapshot(&env, &market), snapshot(&env, &neighbour)),
                before,
                "{name}"
            );
        }
        // With every account its own, the same market rebalances.
        env.rebalance(&market, None).unwrap();
    }
}

#[test]
fn a_capped_redeem_still_lands_when_the_reserves_stored_rate_is_stale() {
    // Kamino refreshes the reserve inside the redeem and pays at the higher rate, so a redeem
    // sized at the stored rate right up to the cap would overshoot it; the headroom it leaves,
    // KAMINO_RATE_HEADROOM_BPS, must cover the interest since the last refresh. With real
    // borrowing that is a day of the mainnet reserves' own curves, and an hour of our devnet
    // reserves' curve, which is steep on purpose (LENDING-39) and accrues about 0.1% a day;
    // longer, klend refuses the redeem, and a keeper puts klend's `refresh_reserve` first in the
    // same transaction (the next test).
    for (lent, entry) in LENT_MINTS.iter().enumerate() {
        let mut env = Env::new();
        env.load_klend();
        ensure_borrowed(&mut env, lent);
        let market = env.market_below_the_band(lent);
        let stale: i64 = if cfg!(feature = "mainnet") {
            86_400
        } else {
            3_600
        };
        env.advance_clock(stale as u64 * 5 / 2, stale);
        let state = env.market_state(&market.market_state);
        let shortfall = env.lent_total(&market) * BUFFER_TARGET_BPS as u64 / 10_000
            - state.reserves[market.lent_index];
        let cap = (shortfall + entry.min_rebalance) / 2;
        let address = env.reserve_of(&market);
        let now = env.clock().unix_timestamp as u64;
        let mut fields = Vec::new();
        fields.extend_from_slice(&(cap as i64 + 1_000).to_le_bytes());
        fields.extend_from_slice(&1_000i64.to_le_bytes());
        fields.extend_from_slice(&now.to_le_bytes());
        fields.extend_from_slice(&86_400u64.to_le_bytes());
        env.patch(
            &address,
            lending_amm::kamino::offsets::WITHDRAWAL_CAP,
            &fields,
        );

        env.rebalance(&market, None).unwrap();
        let received = env.market_state(&market.market_state).redeemed as u64;
        println!("lent {lent}: {stale} s stale, Kamino could pay {cap}, it paid {received}");
        assert!(received <= cap);
        // Within the headroom it leaves for the rate klend refreshes to.
        let headroom = cap as u128 * lending_amm::config::KAMINO_RATE_HEADROOM_BPS as u128 / 10_000;
        assert!((cap - received) as u128 <= headroom + one_ctoken(&env, &market) as u128 + 1);
    }
}

#[test]
fn a_capped_redeem_on_a_reserve_stale_beyond_the_headroom_lands_when_klends_refresh_comes_first() {
    // A month without a refresh accrues more interest than KAMINO_RATE_HEADROOM_BPS covers on
    // every reserve, so a redeem planned at the stored rate right up to Kamino's withdrawal cap
    // overshoots it and klend refuses it. A keeper then puts klend's own `refresh_reserve` before
    // `rebalance` in the same transaction: the redeem is planned at a rate refreshed in that
    // slot, and lands within the headroom, as "redeems what it can" asks however stale the
    // reserve was.
    for (lent, entry) in LENT_MINTS.iter().enumerate() {
        let mut env = Env::new();
        env.load_klend();
        ensure_borrowed(&mut env, lent);
        let market = env.market_below_the_band(lent);
        let stale: i64 = 30 * 86_400;
        env.advance_clock(stale as u64 * 5 / 2, stale);
        let state = env.market_state(&market.market_state);
        let shortfall = env.lent_total(&market) * BUFFER_TARGET_BPS as u64 / 10_000
            - state.reserves[market.lent_index];
        let cap = (shortfall + entry.min_rebalance) / 2;
        let address = env.reserve_of(&market);
        let now = env.clock().unix_timestamp as u64;
        let mut fields = Vec::new();
        fields.extend_from_slice(&(cap as i64 + 1_000).to_le_bytes());
        fields.extend_from_slice(&1_000i64.to_le_bytes());
        fields.extend_from_slice(&now.to_le_bytes());
        fields.extend_from_slice(&86_400u64.to_le_bytes());
        env.patch(
            &address,
            lending_amm::kamino::offsets::WITHDRAWAL_CAP,
            &fields,
        );

        // Alone, klend refuses the redeem: the stored rate is a month behind.
        let before = env.market_state(&market.market_state);
        let refused = env.rebalance(&market, None);
        let logs = refused.clone().err().unwrap_or_default();
        assert!(
            refused.is_err(),
            "lent {lent}: a month-stale redeem at the cap should overshoot"
        );
        assert!(logs.contains("WithdrawalCapReached"), "lent {lent}: {logs}");
        assert_eq!(env.market_state(&market.market_state), before);

        // With klend's refresh first, in the same transaction, it lands within the headroom.
        let refresh = env.refresh_reserve_instruction(&market);
        let caller = solana_keypair::Keypair::new();
        env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
        let rebalance = env.rebalance_instruction(&market, &caller.pubkey());
        env.send_meta(&[refresh, rebalance], &[&caller]).unwrap();
        let received = env.market_state(&market.market_state).redeemed as u64;
        println!("lent {lent}: {stale} s stale, Kamino could pay {cap}, refreshed first it paid {received}");
        assert!(received <= cap);
        let headroom = cap as u128 * lending_amm::config::KAMINO_RATE_HEADROOM_BPS as u128 / 10_000;
        assert!((cap - received) as u128 <= headroom + one_ctoken(&env, &market) as u128 + 1);
    }
}
