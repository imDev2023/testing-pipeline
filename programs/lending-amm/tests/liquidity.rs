//! Adding liquidity (docs/spec/lending-pool.md, "Shares" and "Adding"): the first deposit
//! sets the price and locks `MINIMUM_LIQUIDITY` for good; later deposits come in at the
//! ratio; donations are never credited.

mod common;

use common::*;
use lending_amm::config::MINIMUM_LIQUIDITY;
use lending_amm::events::LiquidityAdded;
use lending_amm::StrategyError;
use solana_signer::Signer;

/// `isqrt(other x lent) - MINIMUM_LIQUIDITY`, computed here on its own, in floating point
/// checked by squaring.
fn first_shares(other: u64, lent: u64) -> u64 {
    let product = other as u128 * lent as u128;
    let mut root = (product as f64).sqrt() as u128;
    while root * root > product {
        root -= 1;
    }
    while (root + 1) * (root + 1) <= product {
        root += 1;
    }
    root as u64 - MINIMUM_LIQUIDITY
}

/// Shares and takes of a later deposit, from the spec's formulas.
fn later(max: [u64; 2], reserves: [u64; 2], n: u64) -> (u64, [u64; 2]) {
    let shares = (0..2)
        .map(|i| (max[i] as u128 * n as u128 / reserves[i] as u128) as u64)
        .min()
        .unwrap();
    let take = |i: usize| (shares as u128 * reserves[i] as u128).div_ceil(n as u128) as u64;
    (shares, [take(0), take(1)])
}

#[test]
fn the_first_deposit_in_the_creation_transaction_opens_the_market() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let amounts = [2_000_000_000, 5 * SOL];
    let (market, lp) = env.create_funded_market(&spec, amounts).unwrap();

    let state = env.market_state(&market.market_state);
    assert_eq!(state.reserves, amounts);
    let shares = first_shares(amounts[0], amounts[1]);
    let lp_shares = lp_shares_account(&lp.pubkey(), &market.market_state);
    assert_eq!(env.balance(&lp_shares), shares);
    // The locked minimum is never minted, but counts in the share count.
    assert_eq!(env.mint_supply(&market.addresses.lp_mint), shares);
    assert_eq!(env.share_count(&market), shares + MINIMUM_LIQUIDITY);
    // The vaults hold exactly what was taken; the LP holds the rest (nothing).
    assert_eq!(env.balance(&market.vaults[0]), amounts[0]);
    assert_eq!(env.balance(&market.vaults[1]), amounts[1]);
    for i in 0..2 {
        assert_eq!(
            env.balance(&env.wallet_token_account(&market, &lp.pubkey(), i)),
            0
        );
    }

    let added: Vec<LiquidityAdded> = events(&market.created.logs);
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].amounts, amounts);
    assert_eq!(added[0].shares, shares);
    assert_eq!(added[0].share_count, shares + MINIMUM_LIQUIDITY);
    assert!(added[0].first);
    assert_eq!(added[0].lp, ak(&lp.pubkey()));
}

#[test]
fn the_first_deposit_takes_both_amounts_and_fails_without_shares_above_the_minimum() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    // isqrt(1,001 x 1,001) = 1,001 mints one share; 1,000 x 1,000 mints none.
    let (market, lp) = env.create_funded_market(&spec, [1_001, 1_001]).unwrap();
    assert_eq!(
        env.balance(&lp_shares_account(&lp.pubkey(), &market.market_state)),
        1
    );

    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    assert_refused(
        env.create_funded_market(&spec, [1_000, 1_000]),
        StrategyError::FirstDepositTooSmall,
    );
    for amounts in [[0, SOL], [SOL, 0]] {
        assert_refused(
            env.create_funded_market(&spec, amounts),
            StrategyError::ZeroDeposit,
        );
    }
}

#[test]
fn a_first_deposit_may_also_come_after_the_creation() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(0);
    let market = env.create_market(&spec).unwrap();
    let lp = env.funded_wallet(&market, [10 * SOL, 10 * SOL]);
    env.add_liquidity(&market, &lp, [3 * SOL, 7 * SOL], 0)
        .unwrap();
    assert_eq!(
        env.market_state(&market.market_state).reserves,
        [3 * SOL, 7 * SOL]
    );
}

#[test]
fn later_deposits_come_in_at_the_ratio_and_take_only_what_their_shares_are_worth() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let (market, _) = env
        .create_funded_market(&spec, [3_000_000_007, 7 * SOL + 3])
        .unwrap();
    // Offers that over-supply one side, the other, and neither.
    for max in [
        [1_000_000_000, 9 * SOL],
        [5_000_000_000, 2 * SOL + 1],
        [123_457, 288_067],
    ] {
        let before = env.market_state(&market.market_state).reserves;
        let n = env.share_count(&market);
        let (shares, take) = later(max, before, n);
        let lp = env.funded_wallet(&market, max);
        let meta = env.add_liquidity(&market, &lp, max, shares).unwrap();
        let after = env.market_state(&market.market_state).reserves;
        assert_eq!(after, [before[0] + take[0], before[1] + take[1]], "{max:?}");
        assert_eq!(env.share_count(&market), n + shares);
        assert_eq!(
            env.balance(&lp_shares_account(&lp.pubkey(), &market.market_state)),
            shares
        );
        for i in 0..2 {
            let left = env.balance(&env.wallet_token_account(&market, &lp.pubkey(), i));
            assert_eq!(left, max[i] - take[i]);
        }
        let added: Vec<LiquidityAdded> = events(&meta.logs);
        assert_eq!(added[0].amounts, take);
        assert!(!added[0].first);
    }
}

#[test]
fn a_later_deposit_refuses_below_min_lp_and_passes_at_it() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let (market, _) = env.create_funded_market(&spec, [SOL, 2 * SOL]).unwrap();
    let max = [SOL / 2, SOL];
    let (shares, _) = later(
        max,
        env.market_state(&market.market_state).reserves,
        env.share_count(&market),
    );
    let lp = env.funded_wallet(&market, max);
    assert_refused(
        env.add_liquidity(&market, &lp, max, shares + 1),
        StrategyError::BelowMinLp,
    );
    env.add_liquidity(&market, &lp, max, shares).unwrap();
}

#[test]
fn a_deposit_too_small_for_one_share_is_refused() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    // N = isqrt(10^11 x 10^9) = 10^10 shares against 10^11 of the other side.
    let (market, _) = env.create_funded_market(&spec, [100 * SOL, SOL]).unwrap();
    let lp = env.funded_wallet(&market, [SOL, SOL]);
    // One unit of the other side is worth a tenth of a share.
    assert_refused(
        env.add_liquidity(&market, &lp, [1, SOL], 0),
        StrategyError::ZeroShares,
    );
}

#[test]
fn donating_before_the_first_deposit_gains_the_donor_nothing() {
    // A donor sends tokens to both vaults before the first deposit, then deposits: their
    // shares are what the same deposit gets without the donation, the market records only
    // the deposit, and the donation is never priced.
    let amounts = [2 * SOL, 3 * SOL];
    let clean = {
        let mut env = Env::new();
        let spec = env.wsol_market_spec(30);
        let (market, lp) = env.create_funded_market(&spec, amounts).unwrap();
        env.balance(&lp_shares_account(&lp.pubkey(), &market.market_state))
    };
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let market = env.create_market(&spec).unwrap();
    let donor = env.funded_wallet(&market, amounts);
    env.donate(&market, 0, &market.vaults[0], 7 * SOL);
    env.donate(&market, 1, &market.vaults[1], 11 * SOL);
    env.add_liquidity(&market, &donor, amounts, 0).unwrap();
    let shares = env.balance(&lp_shares_account(&donor.pubkey(), &market.market_state));
    assert_eq!(shares, clean);
    assert_eq!(env.market_state(&market.market_state).reserves, amounts);
    assert_eq!(env.balance(&market.vaults[0]), amounts[0] + 7 * SOL);
}

#[test]
fn donating_around_a_later_deposit_gains_the_donor_nothing() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let (market, _) = env.create_funded_market(&spec, [SOL, 2 * SOL]).unwrap();
    let max = [SOL, 2 * SOL];
    let expected = later(
        max,
        env.market_state(&market.market_state).reserves,
        env.share_count(&market),
    );
    let lp = env.funded_wallet(&market, max);
    env.donate(&market, 0, &market.vaults[0], 5 * SOL);
    env.donate(&market, 1, &market.vaults[1], 5 * SOL);
    env.add_liquidity(&market, &lp, max, 0).unwrap();
    assert_eq!(
        env.balance(&lp_shares_account(&lp.pubkey(), &market.market_state)),
        expected.0
    );
    env.donate(&market, 1, &market.vaults[1], 3 * SOL);
    let state = env.market_state(&market.market_state);
    assert_eq!(
        state.reserves,
        [SOL + expected.1[0], 2 * SOL + expected.1[1]]
    );
}

#[test]
fn an_lp_adds_again_into_their_existing_shares_account_and_lamports_sent_first_do_not_block_it() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let (market, first) = env.create_funded_market(&spec, [SOL, SOL]).unwrap();
    let shares = lp_shares_account(&first.pubkey(), &market.market_state);
    let held = env.balance(&shares);
    for i in 0..2 {
        write_token_account(&mut env.svm, &market.mints[i], &TOKEN, &first.pubkey(), SOL).unwrap();
    }
    env.add_liquidity(&market, &first, [SOL / 2, SOL / 2], 1)
        .unwrap();
    assert!(env.balance(&shares) > held);
    // Someone sends lamports to a new LP's shares account address before their first add.
    let lp = env.funded_wallet(&market, [SOL, SOL]);
    let address = lp_shares_account(&lp.pubkey(), &market.market_state);
    let least = env.svm.minimum_balance_for_rent_exemption(0);
    env.svm.airdrop(&address, least).unwrap();
    env.add_liquidity(&market, &lp, [SOL / 2, SOL / 2], 1)
        .unwrap();
    // The shares account is a token account of the LP mint that the LP owns.
    let account = env.svm.get_account(&address).unwrap();
    assert_eq!(account.owner, TOKEN);
    assert_eq!(&account.data[..32], market.addresses.lp_mint.as_ref());
    assert_eq!(&account.data[32..64], lp.pubkey().as_ref());
}

#[test]
fn another_lps_shares_account_is_refused() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let (market, first) = env.create_funded_market(&spec, [SOL, SOL]).unwrap();
    let lp = env.funded_wallet(&market, [SOL, SOL]);
    let mut add = env.add_liquidity_instruction(&market, &lp.pubkey(), [SOL / 2, SOL / 2], 0);
    add.accounts[9].pubkey = lp_shares_account(&first.pubkey(), &market.market_state);
    assert_anchor_error(env.send(&[add], &[&lp]), 2006);
}

#[test]
fn add_liquidity_refuses_substituted_vaults_mints_and_lp_mint() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let (market, _) = env.create_funded_market(&spec, [SOL, SOL]).unwrap();
    let (other_market, _) = {
        let other_spec = env.wsol_market_spec(31);
        env.create_funded_market(&other_spec, [SOL, SOL]).unwrap()
    };
    let lp = env.funded_wallet(&market, [SOL, SOL]);
    // vault 0, vault 1, mint 0, the LP mint, the authority: another market's.
    for (index, wrong) in [
        (4, other_market.vaults[0]),
        (5, other_market.vaults[1]),
        (6, other_market.mints[0]),
        (8, other_market.addresses.lp_mint),
        (10, other_market.addresses.authority),
    ] {
        let mut add = env.add_liquidity_instruction(&market, &lp.pubkey(), [SOL / 2, SOL / 2], 0);
        add.accounts[index].pubkey = wrong;
        assert!(env.send(&[add], &[&lp]).is_err(), "account {index}");
    }
    assert_eq!(env.market_state(&market.market_state).reserves, [SOL, SOL]);
}

#[test]
fn a_market_whose_buffer_is_empty_stays_open_so_a_deposit_never_resets_its_price() {
    // Once lending starts, the buffer can reach 0 while the market still holds the other side,
    // cTokens and LP shares. Such a market is open: a deposit comes in at its ratio, never as
    // a first deposit that would mint shares at a price of the depositor's choosing. Written
    // straight into the market state here, since this build lends nothing.
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let (market, _) = env.create_funded_market(&spec, [SOL, SOL]).unwrap();
    let mut account = env.svm.get_account(&market.market_state).unwrap();
    let buffer = lending_amm::state::layout::RESERVES + 8 * market.lent_index;
    account.data[buffer..buffer + 8].copy_from_slice(&0u64.to_le_bytes());
    env.svm.set_account(market.market_state, account).unwrap();

    let attacker = env.funded_wallet(&market, [SOL, SOL]);
    // A first deposit would mint isqrt(10^9 x 1,001) - 1,000 shares for one unit of the lent
    // side; at the ratio, with the lent side's total at 0, it is refused.
    let result = env.add_liquidity(&market, &attacker, [SOL, 1_001], 0);
    assert_refused(result, StrategyError::EmptySide);
    assert_eq!(
        env.balance_or_zero(&lp_shares_account(&attacker.pubkey(), &market.market_state)),
        0
    );
}
