//! Removing liquidity (docs/spec/lending-pool.md, "Shares" and "Removing"): an LP burns shares
//! for their part of the other side, the buffer and the market's cTokens, each rounded down,
//! either in cash, the cTokens' part redeemed by klend's real `redeem_reserve_collateral`, or in
//! kind, the cTokens themselves, with no Kamino account in the instruction. Sent as an LP sends
//! them, against the router copied from devnet, klend's deployed bytes and the Kamino accounts
//! dumped from the cluster this build lends on.

mod common;

use common::rebalance::{lent_spec, units, OTHER};
use common::remove::Payout;
use common::*;
use lending_amm::config::MINIMUM_LIQUIDITY;
use lending_amm::events::LiquidityRemoved;
use lending_amm::kamino::{lending_market_offsets, offsets};
use lending_amm::StrategyError;
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// A market lending `LENT_MINTS[lent]` with a 0.30% LP fee, opened by its first LP with
/// `[OTHER, 50 units]` and rebalanced, so four fifths of its lent side are real cTokens from
/// klend's deposit; then a second LP adds half as much again. Returns both LPs.
fn lent_market(env: &mut Env, lent: usize) -> (Market, Keypair, Keypair) {
    env.load_klend();
    let spec = lent_spec(env, lent, 30);
    let (market, first) = env
        .create_funded_market(&spec, [OTHER, units(lent, 50)])
        .unwrap();
    env.rebalance(&market, None).unwrap();
    let second = env.funded_wallet(&market, [OTHER, units(lent, 50)]);
    env.add_liquidity(&market, &second, [OTHER / 2, units(lent, 25)], 0)
        .unwrap();
    (market, first, second)
}

/// What a removal of `shares` pays, by the spec's formulas computed here on their own:
/// `[R x lp / N, B x lp / N, c x lp / N]`, each rounded down.
fn parts(env: &Env, market: &Market, shares: u64) -> [u64; 3] {
    let state = env.market_state(&market.market_state);
    let n = env.share_count(market) as u128;
    let part = |whole: u64| (whole as u128 * shares as u128 / n) as u64;
    [
        part(state.reserves[market.other_index()]),
        part(state.reserves[market.lent_index]),
        part(state.ctokens),
    ]
}

/// Whether klend ran in a transaction.
fn klend_ran(logs: &[String]) -> bool {
    let invoke = format!("Program {} invoke", common::kamino::klend());
    logs.iter().any(|line| line.starts_with(&invoke))
}

/// The buffer's share of the lent side, `B / L`, as a fraction.
fn buffer_share(env: &Env, market: &Market) -> f64 {
    env.buffer(market) as f64 / env.lent_total(market) as f64
}

#[test]
fn a_removal_in_cash_pays_each_part_with_the_ctokens_redeemed_by_klend() {
    for lent in 0..2 {
        let mut env = Env::new();
        let (market, _, lp) = lent_market(&mut env, lent);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let shares = env.lp_shares_of(&market, &lp.pubkey()) / 3;
        let [other_part, buffer_part, ctokens_part] = parts(&env, &market, shares);
        assert!(other_part > 0 && buffer_part > 0 && ctokens_part > 0);
        let worth = env
            .program_reserve(&market)
            .lent_value(ctokens_part)
            .unwrap();
        let before = env.market_state(&market.market_state);
        let (n, share_before) = (env.share_count(&market), buffer_share(&env, &market));
        let ctokens_held = env.balance(&market.addresses.ctoken_account);
        let into = [other, lent_side].map(|i| env.wallet_token_account(&market, &lp.pubkey(), i));
        let held = into.map(|account| env.balance(&account));

        let meta = env
            .remove_liquidity(&market, &lp, shares, [0, 0], Payout::Cash)
            .unwrap();

        // klend's real redeem ran in the transaction, and paid at least what the market valued
        // the cTokens' part at, at the stored rate.
        assert!(klend_ran(&meta.logs), "klend's redeem ran");
        let removed = events::<LiquidityRemoved>(&meta.logs);
        assert_eq!(removed.len(), 1);
        let event = &removed[0];
        assert!(!event.in_kind);
        assert_eq!((event.shares, event.ctokens), (shares, ctokens_part));
        assert!(event.redeemed >= worth, "{} < {worth}", event.redeemed);
        // The LP receives the other side's part, and in the lent mint the buffer's part plus
        // what klend paid: only the two mints, no cTokens.
        let received = [0, 1].map(|i| env.balance(&into[i]) - held[i]);
        assert_eq!(received, [other_part, buffer_part + event.redeemed]);
        assert_eq!(event.amounts[other], other_part);
        assert_eq!(event.amounts[lent_side], buffer_part + event.redeemed);
        assert_eq!(
            env.balance_or_zero(&env.lp_ctoken_account(&market, &lp.pubkey())),
            0
        );

        // The shares are burned, and each recorded side loses exactly its part.
        assert_eq!(env.share_count(&market), n - shares);
        assert_eq!(event.share_count, n - shares);
        let after = env.market_state(&market.market_state);
        assert_eq!(after.reserves[other], before.reserves[other] - other_part);
        assert_eq!(
            after.reserves[lent_side],
            before.reserves[lent_side] - buffer_part
        );
        assert_eq!(after.ctokens, before.ctokens - ctokens_part);
        assert_eq!(
            env.balance(&market.addresses.ctoken_account),
            ctokens_held - ctokens_part
        );
        assert_eq!(after.redeemed, before.redeemed + event.redeemed as u128);
        assert_eq!(after.deposited, before.deposited);
        // The buffer's share of the lent side is unchanged, but for rounding.
        let share_after = buffer_share(&env, &market);
        assert!(
            (share_after - share_before).abs() < 1e-6,
            "{share_before} -> {share_after}"
        );
    }
}

#[test]
fn a_removal_in_kind_pays_ctokens_into_the_lps_associated_token_account_with_no_kamino_account() {
    for lent in 0..2 {
        let mut env = Env::new();
        let (market, _, lp) = lent_market(&mut env, lent);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let shares = env.lp_shares_of(&market, &lp.pubkey()) / 2;
        let [other_part, buffer_part, ctokens_part] = parts(&env, &market, shares);
        let before = env.market_state(&market.market_state);
        let share_before = buffer_share(&env, &market);
        let lp_ctoken = env.lp_ctoken_account(&market, &lp.pubkey());
        assert!(
            env.svm.get_account(&lp_ctoken).is_none(),
            "missing at first"
        );
        let lamports = env.svm.get_balance(&lp.pubkey()).unwrap();
        let into = [other, lent_side].map(|i| env.wallet_token_account(&market, &lp.pubkey(), i));
        let held = into.map(|account| env.balance(&account));

        let remove =
            env.remove_liquidity_instruction(&market, &lp.pubkey(), shares, [0, 0], Payout::InKind);
        // Built with no Kamino account at all: nothing klend owns, and not klend itself.
        for account in &remove.accounts {
            assert_ne!(account.pubkey, common::kamino::klend());
            let owner = env.svm.get_account(&account.pubkey).map(|a| a.owner);
            assert_ne!(owner, Some(common::kamino::klend()), "{}", account.pubkey);
        }
        // Nor does it write-lock the collateral mint every Kamino user of the reserve shares.
        let collateral = remove.accounts[common::remove::position("collateral_mint")].clone();
        assert!(!collateral.is_writable);
        assert!(remove
            .accounts
            .iter()
            .all(|a| a.pubkey != collateral.pubkey || !a.is_writable));
        let meta = env.send_meta(&[remove], &[&lp]).unwrap();
        assert!(!klend_ran(&meta.logs), "no Kamino instruction");

        // The cTokens arrive in the LP's associated token account, created at the LP's expense.
        assert_eq!(env.balance(&lp_ctoken), ctokens_part);
        let rent = env.svm.minimum_balance_for_rent_exemption(165);
        assert_eq!(lamports - env.svm.get_balance(&lp.pubkey()).unwrap(), rent);
        let received = [0, 1].map(|i| env.balance(&into[i]) - held[i]);
        assert_eq!(received, [other_part, buffer_part]);
        let event = &events::<LiquidityRemoved>(&meta.logs)[0];
        assert!(event.in_kind);
        assert_eq!((event.ctokens, event.redeemed), (ctokens_part, 0));

        let after = env.market_state(&market.market_state);
        assert_eq!(after.reserves[other], before.reserves[other] - other_part);
        assert_eq!(
            after.reserves[lent_side],
            before.reserves[lent_side] - buffer_part
        );
        assert_eq!(after.ctokens, before.ctokens - ctokens_part);
        // The cTokens took their part of the net amount lent with them, off what was deposited,
        // so the market's yield V + redeemed - deposited falls in proportion with V.
        let net = before.deposited - before.redeemed;
        let take = net * ctokens_part as u128 / before.ctokens as u128;
        assert_eq!(
            (after.deposited, after.redeemed),
            (before.deposited - take, before.redeemed)
        );
        let share_after = buffer_share(&env, &market);
        assert!(
            (share_after - share_before).abs() < 1e-6,
            "{share_before} -> {share_after}"
        );

        // A second removal in kind pays into the account that now exists, and costs nothing.
        let lamports = env.svm.get_balance(&lp.pubkey()).unwrap();
        let [_, _, more] = parts(&env, &market, shares / 2);
        env.remove_liquidity(&market, &lp, shares / 2, [0, 0], Payout::InKind)
            .unwrap();
        assert_eq!(env.balance(&lp_ctoken), ctokens_part + more);
        assert_eq!(env.svm.get_balance(&lp.pubkey()).unwrap(), lamports);
    }
}

#[test]
fn ctokens_paid_in_kind_redeem_at_klend_for_at_least_what_the_market_valued_them_at() {
    for lent in 0..2 {
        let mut env = Env::new();
        let (market, _, lp) = lent_market(&mut env, lent);
        let shares = env.lp_shares_of(&market, &lp.pubkey()) / 2;
        let [_, _, ctokens_part] = parts(&env, &market, shares);
        let worth = env
            .program_reserve(&market)
            .lent_value(ctokens_part)
            .unwrap();
        env.remove_liquidity(&market, &lp, shares, [0, 0], Payout::InKind)
            .unwrap();
        env.advance_clock(150, 60);

        // The LP redeems the cTokens at klend themselves.
        let lp_ctoken = env.lp_ctoken_account(&market, &lp.pubkey());
        let lent_account = env.wallet_token_account(&market, &lp.pubkey(), market.lent_index);
        let before = env.balance(&lent_account);
        let redeem = common::kamino::redeem_reserve_collateral(
            &env.kamino,
            lent,
            &lp.pubkey(),
            &lp_ctoken,
            &lent_account,
            ctokens_part,
        );
        env.send(&[redeem], &[&lp]).unwrap();
        let paid = env.balance(&lent_account) - before;
        assert!(
            paid >= worth,
            "klend paid {paid} for cTokens the market valued at {worth}"
        );
        assert_eq!(env.balance(&lp_ctoken), 0);
    }
}

#[test]
fn min_other_and_min_lent_are_enforced() {
    let mut env = Env::new();
    let (market, _, lp) = lent_market(&mut env, 0);
    let shares = env.lp_shares_of(&market, &lp.pubkey()) / 4;
    let [other_part, buffer_part, ctokens_part] = parts(&env, &market, shares);
    let worth = env
        .program_reserve(&market)
        .lent_value(ctokens_part)
        .unwrap();
    let (o, l) = (market.other_index(), market.lent_index);
    let min = |other: u64, lent: u64| {
        let mut min = [0u64; 2];
        min[o] = other;
        min[l] = lent;
        min
    };
    for payout in [Payout::Cash, Payout::InKind] {
        assert_refused(
            env.remove_liquidity(&market, &lp, shares, min(other_part + 1, 0), payout),
            StrategyError::BelowMinOther,
        );
        assert_refused(
            env.remove_liquidity(&market, &lp, shares, min(0, u64::MAX), payout),
            StrategyError::BelowMinLent,
        );
    }
    // In kind the lent mint paid is the buffer's part; it passes at exactly that.
    assert_refused(
        env.remove_liquidity(
            &market,
            &lp,
            shares,
            min(0, buffer_part + 1),
            Payout::InKind,
        ),
        StrategyError::BelowMinLent,
    );
    env.remove_liquidity(
        &market,
        &lp,
        shares,
        min(other_part, buffer_part),
        Payout::InKind,
    )
    .unwrap();
    // In cash it is the buffer's part plus klend's payout, at least the stored rate's value.
    let [other_part, buffer_part, ctokens_part] = parts(&env, &market, shares);
    let worth_now = env
        .program_reserve(&market)
        .lent_value(ctokens_part)
        .unwrap();
    assert!(worth_now > 0 && worth > 0);
    env.remove_liquidity(
        &market,
        &lp,
        shares,
        min(other_part, buffer_part + worth_now),
        Payout::Cash,
    )
    .unwrap();
}

#[test]
fn a_cash_removal_kamino_cannot_pay_fails_before_calling_kamino_and_in_kind_still_works() {
    let lent = 0;
    let reserve_of = |env: &Env, market: &Market| env.reserve_of(market);
    // Each way Kamino can be unable to pay the cTokens' part right now, made by editing the
    // cloned accounts.
    type Patch = fn(&mut Env, &Market, &Pubkey);
    let states: [(&str, Patch); 4] = [
        ("too little free liquidity", |env, _, reserve| {
            // Borrowers take all but 1,000 units of the available liquidity, which leaves the
            // total supply, and so the rate, as it was.
            let data = env.data(reserve);
            let at = |offset: usize, len: usize| {
                let mut bytes = [0u8; 16];
                bytes[..len].copy_from_slice(&data[offset..offset + len]);
                u128::from_le_bytes(bytes)
            };
            let available = at(offsets::TOTAL_AVAILABLE_AMOUNT, 8);
            let borrowed = at(offsets::BORROWED_AMOUNT_SF, 16) + ((available - 1_000) << 60);
            env.patch(
                reserve,
                offsets::TOTAL_AVAILABLE_AMOUNT,
                &1_000u64.to_le_bytes(),
            );
            env.patch(
                reserve,
                offsets::BORROWED_AMOUNT_SF,
                &borrowed.to_le_bytes(),
            );
        }),
        ("reserve emergency mode", |env, _, reserve| {
            env.patch(reserve, offsets::EMERGENCY_MODE, &[1])
        }),
        ("lending market emergency mode", |env, _, _| {
            let lending_market = env.kamino.address("lending-market");
            env.patch(
                &lending_market,
                lending_market_offsets::EMERGENCY_MODE,
                &[1],
            )
        }),
        ("deprecated reserve", |env, _, reserve| {
            env.patch(reserve, offsets::VERSION, &u64::MAX.to_le_bytes())
        }),
    ];
    for (name, patch) in states {
        let mut env = Env::new();
        let (market, _, lp) = lent_market(&mut env, lent);
        let shares = env.lp_shares_of(&market, &lp.pubkey()) / 2;
        let reserve = reserve_of(&env, &market);
        patch(&mut env, &market, &reserve);
        let before = env.market_state(&market.market_state);
        let remove =
            env.remove_liquidity_instruction(&market, &lp.pubkey(), shares, [0, 0], Payout::Cash);
        let refused = env.send_meta(&[remove], &[&lp]);
        let logs = refused.clone().err().unwrap_or_default();
        assert_refused(refused, StrategyError::KaminoCannotPay);
        assert!(
            !logs.contains(&format!("Program {} invoke", common::kamino::klend())),
            "{name}"
        );
        assert_eq!(env.market_state(&market.market_state), before, "{name}");
        // In kind still works.
        let [_, _, ctokens_part] = parts(&env, &market, shares);
        env.remove_liquidity(&market, &lp, shares, [0, 0], Payout::InKind)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            env.balance(&env.lp_ctoken_account(&market, &lp.pubkey())),
            ctokens_part
        );
    }
}

#[test]
fn a_removal_in_kind_works_while_the_reserve_fails_the_layout_check() {
    let mut env = Env::new();
    let (market, _, lp) = lent_market(&mut env, 0);
    let reserve = env.reserve_of(&market);
    env.patch(&reserve, 0, &[0u8; 8]);
    let shares = env.lp_shares_of(&market, &lp.pubkey()) / 2;
    assert_refused(
        env.remove_liquidity(&market, &lp, shares, [0, 0], Payout::Cash),
        StrategyError::ReserveWrongDiscriminator,
    );
    env.remove_liquidity(&market, &lp, shares, [0, 0], Payout::InKind)
        .unwrap();
}

#[test]
fn a_cash_removal_needs_the_kamino_accounts_and_refuses_substitutes() {
    let mut env = Env::new();
    let (market, _, lp) = lent_market(&mut env, 0);
    let shares = env.lp_shares_of(&market, &lp.pubkey()) / 2;
    let build = |env: &Env| {
        env.remove_liquidity_instruction(&market, &lp.pubkey(), shares, [0, 0], Payout::Cash)
    };
    // Cash built without the Kamino accounts, as an in-kind removal is.
    let mut missing = build(&env);
    let reserve_at = common::remove::position("reserve");
    missing.accounts[reserve_at] = pipeline_client::AccountMeta::new_readonly(strategy_id(), false);
    assert_refused(
        env.send(&[missing], &[&lp]),
        StrategyError::KaminoAccountsMissing,
    );
    // Another USDC or SOL reserve's accounts, or a stranger in any Kamino slot.
    let other_reserve = env.kamino.address("reserve-usdc");
    for (name, substitute, error) in [
        (
            "klend_program",
            Pubkey::new_unique(),
            StrategyError::KaminoAccountWrong,
        ),
        ("reserve", other_reserve, StrategyError::ReserveWrongAddress),
        (
            "lending_market",
            Pubkey::new_unique(),
            StrategyError::LendingMarketWrongAccount,
        ),
        (
            "lending_market_authority",
            Pubkey::new_unique(),
            StrategyError::KaminoAccountWrong,
        ),
        (
            "reserve_liquidity_supply",
            Pubkey::new_unique(),
            StrategyError::KaminoAccountWrong,
        ),
        (
            "instructions_sysvar",
            Pubkey::new_unique(),
            StrategyError::KaminoAccountWrong,
        ),
        (
            "reserve_collateral_mint",
            env.kamino.address("collateral-mint-usdc"),
            StrategyError::KaminoAccountWrong,
        ),
    ] {
        let mut remove = build(&env);
        let at = common::remove::position(name);
        remove.accounts[at].pubkey = substitute;
        let result = env.send(&[remove], &[&lp]);
        assert_refused(result, error);
    }
}

#[test]
fn removing_nothing_or_more_than_the_market_has_is_refused() {
    let mut env = Env::new();
    let (market, _, lp) = lent_market(&mut env, 0);
    for payout in [Payout::Cash, Payout::InKind] {
        assert_refused(
            env.remove_liquidity(&market, &lp, 0, [0, 0], payout),
            StrategyError::ZeroRemoval,
        );
        let supply = env.mint_supply(&market.addresses.lp_mint);
        assert_refused(
            env.remove_liquidity(&market, &lp, supply + 1, [0, 0], payout),
            StrategyError::NotEnoughShares,
        );
    }
}

#[test]
fn the_locked_minimum_is_never_withdrawn_and_the_market_still_prices() {
    for lent in 0..2 {
        let mut env = Env::new();
        let (market, first, second) = lent_market(&mut env, lent);
        // Every LP leaves, one in cash and one in kind.
        let all = env.lp_shares_of(&market, &second.pubkey());
        env.remove_liquidity(&market, &second, all, [0, 0], Payout::Cash)
            .unwrap();
        let all = env.lp_shares_of(&market, &first.pubkey());
        let [other_part, buffer_part, ctokens_part] = parts(&env, &market, all);
        let before = env.market_state(&market.market_state);
        env.remove_liquidity(&market, &first, all, [0, 0], Payout::InKind)
            .unwrap();
        assert_eq!(env.mint_supply(&market.addresses.lp_mint), 0);
        assert_eq!(env.share_count(&market), MINIMUM_LIQUIDITY);

        // The locked minimum's part of every side stays behind.
        let state = env.market_state(&market.market_state);
        let (o, l) = (market.other_index(), market.lent_index);
        assert_eq!(state.reserves[o], before.reserves[o] - other_part);
        assert_eq!(state.reserves[l], before.reserves[l] - buffer_part);
        assert_eq!(state.ctokens, before.ctokens - ctokens_part);
        assert!(state.reserves[o] > 0 && state.reserves[l] > 0 && state.ctokens > 0);

        // The market still prices both ways, here selling as much as each side's total, and a
        // new LP adds at its ratio.
        let totals = [state.reserves[o], env.lent_total(&market)];
        for (input, output, amount) in [(o, l, totals[0]), (l, o, totals[1])] {
            let quote = env
                .quote(&market, &exact_in(input, output, amount))
                .unwrap();
            assert!(quote.amount_out > 0);
        }
        let newcomer = env.funded_wallet(&market, [OTHER, units(lent, 50)]);
        let max = [state.reserves[0] * 10, state.reserves[1] * 10];
        env.add_liquidity(&market, &newcomer, max, 0).unwrap();
        let shares = env.lp_shares_of(&market, &newcomer.pubkey());
        // At the ratio, the newcomer's shares are worth what they put in, not a first deposit's.
        assert!(shares > 0 && shares <= 10 * MINIMUM_LIQUIDITY);
    }
}

#[test]
fn an_spl_burn_of_lp_shares_lowers_n_and_raises_every_other_shares_worth() {
    let mut env = Env::new();
    let (market, first, second) = lent_market(&mut env, 0);
    let n = env.share_count(&market);
    let burned = env.lp_shares_of(&market, &first.pubkey()) / 2;
    let held = env.lp_shares_of(&market, &second.pubkey());
    let before = parts(&env, &market, held);
    env.burn_shares(&market, &first, burned).unwrap();
    assert_eq!(env.share_count(&market), n - burned);
    let after = parts(&env, &market, held);
    for i in 0..3 {
        assert!(
            after[i] > before[i],
            "part {i}: {} -> {}",
            before[i],
            after[i]
        );
    }
    // The second LP removes, and receives the larger parts.
    env.remove_liquidity(&market, &second, held, [0, 0], Payout::InKind)
        .unwrap();
    assert_eq!(
        env.balance(&env.lp_ctoken_account(&market, &second.pubkey())),
        after[2]
    );
}

#[test]
fn donating_around_a_deposit_and_a_removal_gains_the_donor_nothing() {
    for payout in [Payout::Cash, Payout::InKind] {
        let mut env = Env::new();
        let (market, _, _) = lent_market(&mut env, 0);
        let (o, l) = (market.other_index(), market.lent_index);
        // A donor sends tokens to both vaults and cTokens to the cToken account, then adds and
        // removes at once.
        let donor = env.funded_wallet(&market, [OTHER, units(0, 50)]);
        let donated = [OTHER / 10, units(0, 5)];
        for (i, amount) in donated.into_iter().enumerate() {
            let vault = market.vaults[i];
            env.donate(&market, i, &vault, amount);
        }
        let ctoken_account = market.addresses.ctoken_account;
        let ctokens = env.balance(&ctoken_account);
        env.patch(&ctoken_account, 64, &(ctokens + units(0, 5)).to_le_bytes());
        let held =
            [o, l].map(|i| env.balance(&env.wallet_token_account(&market, &donor.pubkey(), i)));
        env.add_liquidity(&market, &donor, [OTHER / 4, units(0, 10)], 0)
            .unwrap();
        let put_in = [0, 1].map(|i| {
            held[i] - env.balance(&env.wallet_token_account(&market, &donor.pubkey(), [o, l][i]))
        });
        let shares = env.lp_shares_of(&market, &donor.pubkey());
        let worth_rate = env.program_reserve(&market);
        let meta = env
            .remove_liquidity(&market, &donor, shares, [0, 0], payout)
            .unwrap();
        let event = &events::<LiquidityRemoved>(&meta.logs)[0];
        let back_other = event.amounts[o];
        // The lent side back: the lent mint paid, plus in kind the cTokens at their value.
        let back_lent = event.amounts[l] as u128
            + if payout == Payout::InKind {
                worth_rate.lent_value(event.ctokens).unwrap() as u128
            } else {
                0
            };
        assert!(back_other <= put_in[0], "{back_other} > {}", put_in[0]);
        // In cash klend pays at the rate it refreshes to, a hair above the stored rate.
        let tolerance = if payout == Payout::Cash {
            put_in[1] as u128 / 1_000_000 + 1
        } else {
            0
        };
        assert!(
            back_lent <= put_in[1] as u128 + tolerance,
            "{back_lent} > {}",
            put_in[1]
        );
        // The donations stay where they were sent, never counted.
        let state = env.market_state(&market.market_state);
        for (i, amount) in donated.into_iter().enumerate() {
            assert_eq!(env.balance(&market.vaults[i]), state.reserves[i] + amount);
        }
        assert_eq!(env.balance(&ctoken_account), state.ctokens + units(0, 5));
    }
}

#[test]
fn with_a_hooked_other_mint_a_removal_forwards_the_hooks_accounts() {
    for payout in [Payout::Cash, Payout::InKind] {
        let mut env = Env::new();
        env.load_klend();
        let (mint, _) = env.create_hooked_mint();
        let spec = MarketSpec {
            mints: [(mint, TOKEN_2022), (wsol(), TOKEN)],
            params: lending_amm::InitParams {
                lent_index: 1,
                lp_fee_bps: 30,
            },
        };
        let (market, lp) = env.create_funded_market(&spec, [OTHER, 50 * SOL]).unwrap();
        env.rebalance(&market, None).unwrap();
        assert!(!market.hook_accounts[0].is_empty());
        let shares = env.lp_shares_of(&market, &lp.pubkey()) / 2;
        let [other_part, _, _] = parts(&env, &market, shares);

        // Without the hook's accounts the hooked payout fails.
        let mut bare =
            env.remove_liquidity_instruction(&market, &lp.pubkey(), shares, [0, 0], payout);
        bare.accounts.truncate(common::remove::ACCOUNTS.len());
        assert!(env.send(&[bare], &[&lp]).is_err());

        let into = env.wallet_token_account(&market, &lp.pubkey(), 0);
        let held = env.balance(&into);
        let meta = env
            .remove_liquidity(&market, &lp, shares, [0, 0], payout)
            .unwrap();
        assert_eq!(env.balance(&into) - held, other_part);
        let hook = format!("Program {} invoke", test_hook_id());
        assert!(
            meta.logs.iter().any(|line| line.starts_with(&hook)),
            "the hook ran"
        );
    }
}

#[test]
fn a_cash_removal_whose_ctokens_klend_would_pay_nothing_for_and_nothing_else_is_refused() {
    let mut env = Env::new();
    env.load_klend();
    // A market whose other side and buffer are small against its share count, so a single
    // share is worth no unit of either, only some cTokens: one token against 50 SOL, lent, then
    // a sale beyond the buffer that redeems and leaves the buffer near empty.
    let spec = lent_spec(&mut env, 0, 30);
    let (market, lp) = env
        .create_funded_market(&spec, [1_000_000, units(0, 50)])
        .unwrap();
    env.rebalance(&market, None).unwrap();
    let buffer = env.buffer(&market);
    let amount = env.sell_paying(&market, buffer + buffer / 2);
    let trader = env.funded_wallet(&market, [2 * amount, 0]);
    env.swap(
        &market,
        &trader,
        (market.other_index(), market.lent_index),
        amount,
    )
    .unwrap();
    let [other_part, buffer_part, ctokens_part] = parts(&env, &market, 1);
    assert_eq!((other_part, buffer_part), (0, 0));
    assert!(ctokens_part > 0);
    // Kamino's rate falls so far that those cTokens are worth nothing: the reserve's supply is
    // one unit, as after a write-off of nearly everything.
    let reserve = env.reserve_of(&market);
    env.patch(
        &reserve,
        offsets::TOTAL_AVAILABLE_AMOUNT,
        &1u64.to_le_bytes(),
    );
    for offset in [
        offsets::BORROWED_AMOUNT_SF,
        offsets::ACCUMULATED_PROTOCOL_FEES_SF,
        offsets::ACCUMULATED_REFERRER_FEES_SF,
        offsets::PENDING_REFERRER_FEES_SF,
    ] {
        env.patch(&reserve, offset, &0u128.to_le_bytes());
    }
    assert_eq!(
        env.program_reserve(&market)
            .lent_value(ctokens_part)
            .unwrap(),
        0
    );
    let shares = env.lp_shares_of(&market, &lp.pubkey());
    assert_refused(
        env.remove_liquidity(&market, &lp, 1, [0, 0], Payout::Cash),
        StrategyError::ZeroRemoval,
    );
    assert_eq!(env.lp_shares_of(&market, &lp.pubkey()), shares);
    // In kind the same share pays its cTokens.
    env.remove_liquidity(&market, &lp, 1, [0, 0], Payout::InKind)
        .unwrap();
    assert_eq!(
        env.balance(&env.lp_ctoken_account(&market, &lp.pubkey())),
        ctokens_part
    );
}
