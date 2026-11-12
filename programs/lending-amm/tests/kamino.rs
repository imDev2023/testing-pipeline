//! The Kamino module against Kamino's own accounts and program: the reserve dumped from the
//! cluster this build lends on, and klend's deployed bytes (docs/spec/lending-pool.md,
//! "Valuing the lent side" and "Redeeming the shortfall"; docs/spec/README.md, "Test layers",
//! layer 6).
//!
//! Run on both cluster builds: the `devnet` build reads our devnet lending market's reserves,
//! the `mainnet` build Kamino's main market's.

mod common;

use common::kamino::{self, lent_name, redeem_reserve_collateral, Fixtures};
use common::*;
use lending_amm::config::{LentMint, LENT_MINTS};
use lending_amm::errors::StrategyError;
use lending_amm::kamino::{offsets, LendingMarket, Reserve};
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// The fixed-point scale of Kamino's `_sf` fields: 60 fractional bits.
const SF: u128 = 1 << 60;

fn reserve_label(i: usize) -> String {
    format!("reserve-{}", lent_name(i))
}

/// The reserve for `LENT_MINTS[i]` as the program reads it, from the VM.
fn read(env: &Env, i: usize) -> Reserve {
    let entry = &LENT_MINTS[i];
    let address = ck(&entry.reserve);
    let account = env.svm.get_account(&address).expect("reserve");
    lending_amm::kamino::read_reserve(&entry.reserve, &ak(&account.owner), &account.data, entry)
        .expect("the reserve passes the check")
}

fn read_lending_market(env: &Env, entry: &LentMint) -> LendingMarket {
    let address = ck(&entry.lending_market);
    let account = env.svm.get_account(&address).expect("lending market");
    lending_amm::kamino::read_lending_market(
        &entry.lending_market,
        &ak(&account.owner),
        &account.data,
        entry,
    )
    .expect("the lending market passes the check")
}

fn u64_at(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

fn u128_at(data: &[u8], offset: usize) -> u128 {
    u128::from_le_bytes(data[offset..offset + 16].try_into().unwrap())
}

#[test]
fn the_dumped_reserves_are_the_ones_this_build_lends_to() {
    let fixtures = Fixtures::of_build();
    assert_eq!(fixtures.cluster, kamino::cluster());
    for (i, entry) in LENT_MINTS.iter().enumerate() {
        let name = lent_name(i);
        let reserve = fixtures.get(&reserve_label(i));
        assert_eq!(reserve.address, ck(&entry.reserve), "{name} reserve");
        assert_eq!(
            reserve.account.owner,
            kamino::klend(),
            "{name} reserve owner"
        );
        assert_eq!(
            fixtures.address("lending-market"),
            ck(&entry.lending_market)
        );
        assert_eq!(
            fixtures.address(&format!("liquidity-mint-{name}")),
            ck(&entry.mint)
        );
        assert_eq!(
            fixtures.address(&format!("collateral-mint-{name}")),
            ck(&entry.collateral_mint)
        );
    }
}

#[test]
fn every_reserve_this_build_lends_to_passes_the_check() {
    let env = Env::new();
    for i in 0..LENT_MINTS.len() {
        let reserve = read(&env, i);
        assert_eq!(reserve.version, 1);
        assert!(!reserve.emergency_mode && !reserve.block_ctoken_usage);
        let market = read_lending_market(&env, &LENT_MINTS[i]);
        assert!(!market.emergency_mode);
    }
}

#[test]
fn the_total_supply_and_the_ctoken_supply_are_read_at_the_specs_offsets() {
    // S_total = total_available_amount + borrowed_amount_sf - accumulated_protocol_fees_sf
    //   - accumulated_referrer_fees_sf - pending_referrer_fees_sf, in 60-bit fixed point, and
    // S_ctoken = collateral.mint_total_supply, at the offsets of the Kamino facts, section 4,
    // written out here independently of the module.
    let env = Env::new();
    for i in 0..LENT_MINTS.len() {
        let data = env.data(&ck(&LENT_MINTS[i].reserve));
        let expected = ((u64_at(&data, 224) as u128) << 60) + u128_at(&data, 232)
            - u128_at(&data, 344)
            - u128_at(&data, 360)
            - u128_at(&data, 376);
        let reserve = read(&env, i);
        assert_eq!(
            reserve.total_supply_sf().ok(),
            Some(expected),
            "{}",
            lent_name(i)
        );
        assert_eq!(reserve.mint_total_supply, u64_at(&data, 2592));
        assert!(reserve.mint_total_supply > 0);
        println!(
            "{} reserve: S_total {} (+{} / 2^60), S_ctoken {}, rate {:.12}",
            lent_name(i),
            expected >> 60,
            expected & (SF - 1),
            reserve.mint_total_supply,
            expected as f64 / SF as f64 / reserve.mint_total_supply as f64
        );
    }
}

/// On Kamino's main market USDC reserve the SPL mint's supply is 13.8M base units below the
/// reserve's own `collateral.mint_total_supply`; the valuation uses the reserve's.
#[cfg(feature = "mainnet")]
#[test]
fn s_ctoken_is_the_reserves_own_supply_not_the_spl_mints() {
    let env = Env::new();
    let usdc = 1;
    let reserve = read(&env, usdc);
    let spl_supply = env.mint_supply(&ck(&LENT_MINTS[usdc].collateral_mint));
    println!(
        "USDC reserve: collateral.mint_total_supply {}, SPL mint supply {}, difference {}",
        reserve.mint_total_supply,
        spl_supply,
        reserve.mint_total_supply - spl_supply
    );
    assert!(reserve.mint_total_supply > spl_supply);
    let supply = reserve.total_supply_sf().unwrap();
    // A position large enough that the two supplies give different values.
    let ctokens = 10_000_000_000_000;
    let v = reserve.lent_value(ctokens).unwrap();
    assert_eq!(
        Some(v),
        lending_amm::kamino::collateral_value(ctokens, supply, reserve.mint_total_supply)
    );
    assert_ne!(
        Some(v),
        lending_amm::kamino::collateral_value(ctokens, supply, spl_supply),
        "the SPL mint's supply would value the position differently"
    );
}

/// A wallet holding `ctokens` of lent mint `i`'s cTokens and an empty account of the lent
/// mint, both SPL Token accounts.
fn ctoken_holder(env: &mut Env, i: usize, ctokens: u64) -> (Keypair, Pubkey, Pubkey) {
    let wallet = Keypair::new();
    env.svm.airdrop(&wallet.pubkey(), SOL).unwrap();
    let entry = &LENT_MINTS[i];
    let collateral = env.spl_account(&wallet.pubkey(), &ck(&entry.collateral_mint), ctokens);
    let liquidity = env.spl_account(&wallet.pubkey(), &ck(&entry.mint), 0);
    (wallet, collateral, liquidity)
}

/// What klend's real `redeem_reserve_collateral` pays `wallet` for `ctokens`, or its error.
fn redeem(
    env: &mut Env,
    i: usize,
    wallet: &Keypair,
    collateral: &Pubkey,
    liquidity: &Pubkey,
    ctokens: u64,
) -> Result<u64, String> {
    let before = env.balance(liquidity);
    let instruction = redeem_reserve_collateral(
        &env.kamino,
        i,
        &wallet.pubkey(),
        collateral,
        liquidity,
        ctokens,
    );
    env.send(&[instruction], &[wallet])?;
    Ok(env.balance(liquidity) - before)
}

#[test]
fn the_lent_value_is_never_above_what_klend_pays_and_within_one_unit_when_fresh() {
    let mut env = Env::new();
    env.load_klend();
    for i in 0..LENT_MINTS.len() {
        let name = lent_name(i);
        // Positions from one cToken to most of what the reserve can pay.
        let available = read(&env, i).freely_available();
        let sizes = [1, 7, 1_000, 123_456_789, available / 3];
        let (wallet, collateral, liquidity) =
            ctoken_holder(&mut env, i, sizes.iter().sum::<u64>() * 2);

        // The reserve as dumped, last refreshed some slots before the clock: klend refreshes
        // it inside the redeem, so it pays at least the stored rate.
        env.advance_clock(150, 60);
        for ctokens in sizes {
            let v = read(&env, i).lent_value(ctokens).unwrap();
            let paid = redeem(&mut env, i, &wallet, &collateral, &liquidity, ctokens).unwrap();
            println!("{name}: {ctokens} cTokens valued at {v}, klend paid {paid}");
            assert!(v <= paid, "{name}: valued {v} above klend's payout {paid}");
            // The redeem refreshed the reserve in this slot, so the next value is at the rate
            // klend pays now: within one unit of the payout, and never above it.
            let fresh = read(&env, i).lent_value(ctokens).unwrap();
            let paid_again =
                redeem(&mut env, i, &wallet, &collateral, &liquidity, ctokens).unwrap();
            println!("{name}: refreshed this slot, valued at {fresh}, klend paid {paid_again}");
            assert!(fresh <= paid_again && paid_again - fresh <= 1);
            env.advance_clock(1, 1);
        }
    }
}

/// Gives a reserve with less than one unit borrowed some debt, so interest accrues; the
/// `devnet` dump's reserves hold only dust left by a repaid test borrow.
fn ensure_borrowed(env: &mut Env, i: usize) {
    let address = ck(&LENT_MINTS[i].reserve);
    let data = env.data(&address);
    if u128_at(&data, offsets::BORROWED_AMOUNT_SF) >> 60 == 0 {
        // Half as much borrowed as is available, so utilisation is a third.
        let borrowed = (u64_at(&data, offsets::TOTAL_AVAILABLE_AMOUNT) as u128 / 2) << 60;
        env.patch(
            &address,
            offsets::BORROWED_AMOUNT_SF,
            &borrowed.to_le_bytes(),
        );
    }
}

#[test]
fn interest_klend_accrues_raises_the_lent_value() {
    let mut env = Env::new();
    env.load_klend();
    for i in 0..LENT_MINTS.len() {
        ensure_borrowed(&mut env, i);
        let ctokens = 1_000_000_000_000;
        let before = read(&env, i).lent_value(ctokens).unwrap();
        // A day later, any redeem makes klend refresh the reserve and accrue its interest.
        env.advance_clock(216_000, 86_400);
        let (wallet, collateral, liquidity) = ctoken_holder(&mut env, i, 1);
        redeem(&mut env, i, &wallet, &collateral, &liquidity, 1).unwrap();
        let after = read(&env, i).lent_value(ctokens).unwrap();
        println!(
            "{}: {ctokens} cTokens worth {before}, a day of interest later {after}",
            lent_name(i)
        );
        assert!(after > before);
    }
}

/// What Kamino can pay right now, for a market holding `ctokens`, from the VM's accounts.
fn can_pay_now(env: &Env, i: usize, ctokens: u64) -> u64 {
    let reserve = read(env, i);
    let market = read_lending_market(env, &LENT_MINTS[i]);
    reserve.can_pay_now(&market, ctokens, env.clock().unix_timestamp)
}

/// About as many cTokens as `liquidity` is worth at the reserve's stored rate, and never worth
/// more: `floor(liquidity x S_ctoken / ceil(S_total))`, since `ceil(S_total) >= S_total`.
fn ctokens_worth(reserve: &Reserve, liquidity: u64) -> u64 {
    let supply = reserve.total_supply_sf().unwrap().div_ceil(SF);
    (liquidity as u128 * reserve.mint_total_supply as u128 / supply) as u64
}

#[test]
fn what_kamino_can_pay_now_is_the_smallest_of_its_three_terms() {
    let i = 0;
    let address = ck(&LENT_MINTS[i].reserve);
    let mut env = Env::new();
    env.load_klend();
    let fresh = Env::new();
    let reserve = read(&fresh, i);
    let available = reserve.total_available_amount;
    let big = ctokens_worth(&reserve, available);

    // 1. The market's own cTokens bind: a position worth less than everything else.
    let small = 1_000_000;
    assert_eq!(
        can_pay_now(&env, i, small),
        reserve.lent_value(small).unwrap()
    );

    // 2. Freely available liquidity binds: a position worth more than the reserve holds, with
    // no withdrawal cap in the way.
    env.patch(&address, offsets::WITHDRAWAL_CAP + 24, &0u64.to_le_bytes());
    assert_eq!(can_pay_now(&env, i, big * 2), available);
    // Queued withdrawal tickets come off what is freely available, at the stored rate.
    let queued = ctokens_worth(&reserve, available / 4);
    env.patch(
        &address,
        offsets::QUEUED_COLLATERAL_AMOUNT,
        &queued.to_le_bytes(),
    );
    let queued_value = read(&env, i).lent_value(queued).unwrap();
    assert_eq!(read(&env, i).freely_available(), available - queued_value);
    assert_eq!(can_pay_now(&env, i, big * 2), available - queued_value);
    env.patch(
        &address,
        offsets::QUEUED_COLLATERAL_AMOUNT,
        &0u64.to_le_bytes(),
    );

    // 3. The withdrawal cap binds: capacity 10 units of the lent mint in a day, 4 used.
    let now = env.clock().unix_timestamp as u64;
    let cap = |capacity: i64, used: i64, start: u64, length: u64| {
        let mut bytes = capacity.to_le_bytes().to_vec();
        bytes.extend_from_slice(&used.to_le_bytes());
        bytes.extend_from_slice(&start.to_le_bytes());
        bytes.extend_from_slice(&length.to_le_bytes());
        bytes
    };
    let unit = available / 1_000;
    env.patch(
        &address,
        offsets::WITHDRAWAL_CAP,
        &cap(10 * unit as i64, 4 * unit as i64, now - 60, 86_400),
    );
    assert_eq!(can_pay_now(&env, i, big), 6 * unit);
    // Deposits count against the cap, so a negative running total leaves more than capacity.
    env.patch(
        &address,
        offsets::WITHDRAWAL_CAP,
        &cap(10 * unit as i64, -(2 * unit as i64), now - 60, 86_400),
    );
    assert_eq!(can_pay_now(&env, i, big), 12 * unit);
    // Once the interval is over, the whole capacity is back.
    env.patch(
        &address,
        offsets::WITHDRAWAL_CAP,
        &cap(10 * unit as i64, 10 * unit as i64, now - 86_400, 86_400),
    );
    assert_eq!(can_pay_now(&env, i, big), 10 * unit);
    // Used up: nothing.
    env.patch(
        &address,
        offsets::WITHDRAWAL_CAP,
        &cap(10 * unit as i64, 11 * unit as i64, now - 60, 86_400),
    );
    assert_eq!(can_pay_now(&env, i, big), 0);

    // klend agrees with the cap term: with 6 units left, a redeem worth 6 units goes through
    // and one worth more than what then remains fails.
    env.patch(
        &address,
        offsets::WITHDRAWAL_CAP,
        &cap(10 * unit as i64, 4 * unit as i64, now - 60, 86_400),
    );
    let (wallet, collateral, liquidity) = ctoken_holder(&mut env, i, big);
    let within = ctokens_worth(&read(&env, i), can_pay_now(&env, i, big) / 2);
    redeem(&mut env, i, &wallet, &collateral, &liquidity, within).unwrap();
    let left = can_pay_now(&env, i, big);
    let beyond = ctokens_worth(&read(&env, i), left) + ctokens_worth(&read(&env, i), unit / 100);
    let refused = redeem(&mut env, i, &wallet, &collateral, &liquidity, beyond);
    assert!(
        refused
            .as_ref()
            .is_err_and(|e| e.contains("WithdrawalCapReached")),
        "klend paid beyond the cap: {refused:?}"
    );
}

#[test]
fn kamino_can_pay_nothing_in_either_emergency_mode_or_once_the_reserve_is_deprecated() {
    let i = 0;
    let entry = &LENT_MINTS[i];
    let reserve = ck(&entry.reserve);
    let lending_market = ck(&entry.lending_market);
    let ctokens = 1_000_000_000;
    for (case, address, offset, bytes) in [
        (
            "reserve emergency mode",
            reserve,
            offsets::EMERGENCY_MODE,
            vec![1u8],
        ),
        (
            "lending market emergency mode",
            lending_market,
            lending_amm::kamino::lending_market_offsets::EMERGENCY_MODE,
            vec![1u8],
        ),
        (
            "deprecated reserve",
            reserve,
            offsets::VERSION,
            u64::MAX.to_le_bytes().to_vec(),
        ),
    ] {
        let mut env = Env::new();
        env.load_klend();
        assert!(can_pay_now(&env, i, ctokens) > 0, "{case}: pays before");
        env.patch(&address, offset, &bytes);
        assert_eq!(can_pay_now(&env, i, ctokens), 0, "{case}");
        // klend refuses the redeem too.
        let (wallet, collateral, liquidity) = ctoken_holder(&mut env, i, ctokens);
        let refused = redeem(&mut env, i, &wallet, &collateral, &liquidity, ctokens);
        println!("{case}: klend's redeem {refused:?}");
        assert!(refused.is_err(), "{case}: klend paid");
    }
}

#[test]
fn block_ctoken_usage_does_not_stop_redeems() {
    let mut env = Env::new();
    let address = ck(&LENT_MINTS[0].reserve);
    let before = can_pay_now(&env, 0, 1_000_000);
    env.patch(&address, offsets::BLOCK_CTOKEN_USAGE, &[1]);
    assert!(read(&env, 0).block_ctoken_usage);
    assert_eq!(can_pay_now(&env, 0, 1_000_000), before);
}

/// Every part of the reserve check, as the program reports a failure.
fn refusal(env: &Env, i: usize, address: &Pubkey) -> Result<(), u32> {
    let account = env.svm.get_account(address).expect("account");
    lending_amm::kamino::read_reserve(
        &ak(address),
        &ak(&account.owner),
        &account.data,
        &LENT_MINTS[i],
    )
    .map(|_| ())
    .map_err(|error| error as u32)
}

#[test]
fn the_reserve_check_refuses_each_part_in_turn() {
    let i = 0;
    let entry = &LENT_MINTS[i];
    let address = ck(&entry.reserve);
    let fresh = Env::new();
    assert!(refusal(&fresh, i, &address).is_ok());

    // The address: the right bytes at another address.
    let mut env = Env::new();
    let elsewhere = Pubkey::new_unique();
    let account = env.svm.get_account(&address).unwrap();
    env.svm.set_account(elsewhere, account).unwrap();
    assert_eq!(
        refusal(&env, i, &elsewhere),
        Err(StrategyError::ReserveWrongAddress as u32)
    );
    // The reserve of the other lent mint.
    assert_eq!(
        refusal(&env, i, &ck(&LENT_MINTS[1].reserve)),
        Err(StrategyError::ReserveWrongAddress as u32)
    );

    // The owner.
    let mut env = Env::new();
    let mut account = env.svm.get_account(&address).unwrap();
    account.owner = TOKEN;
    env.svm.set_account(address, account).unwrap();
    assert_eq!(
        refusal(&env, i, &address),
        Err(StrategyError::ReserveNotKamino as u32)
    );

    // The size, one byte more and one less.
    for delta in [1i64, -1] {
        let mut env = Env::new();
        let mut account = env.svm.get_account(&address).unwrap();
        account
            .data
            .resize((account.data.len() as i64 + delta) as usize, 0);
        env.svm.set_account(address, account).unwrap();
        assert_eq!(
            refusal(&env, i, &address),
            Err(StrategyError::ReserveWrongSize as u32)
        );
    }

    // The discriminator, the lending market, the liquidity mint and the collateral mint.
    for (offset, error) in [
        (0, StrategyError::ReserveWrongDiscriminator),
        (
            offsets::LENDING_MARKET,
            StrategyError::ReserveWrongLendingMarket,
        ),
        (
            offsets::LIQUIDITY_MINT,
            StrategyError::ReserveWrongLiquidityMint,
        ),
        (
            offsets::COLLATERAL_MINT,
            StrategyError::ReserveWrongCollateralMint,
        ),
    ] {
        let mut env = Env::new();
        let byte = env.data(&address)[offset];
        env.patch(&address, offset, &[byte ^ 1]);
        assert_eq!(
            refusal(&env, i, &address),
            Err(error as u32),
            "offset {offset}"
        );
    }
}
