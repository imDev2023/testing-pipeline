//! Locking LP shares, and the accounts a removal or a lock must never accept
//! (docs/spec/lending-pool.md, "Locking", "Removing" and "Addresses"): `lock_lp` moves an LP's
//! shares into the market's lock account for good, where they still count in `N` and keep
//! earning, and nothing ever moves them out.

mod common;

use common::rebalance::{lent_spec, units, OTHER};
use common::remove::{Payout, LOCK_ACCOUNTS};
use common::*;
use lending_amm::events::SharesLocked;
use lending_amm::StrategyError;
use pipeline_client::{AccountMeta, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// A WSOL-lent market that has lent through klend's real deposit, its first LP and a second
/// LP who added half as much again.
fn lent_market(env: &mut Env) -> (Market, Keypair, Keypair) {
    env.load_klend();
    let spec = lent_spec(env, 0, 30);
    let (market, first) = env
        .create_funded_market(&spec, [OTHER, units(0, 50)])
        .unwrap();
    env.rebalance(&market, None).unwrap();
    let second = env.funded_wallet(&market, [OTHER, units(0, 50)]);
    env.add_liquidity(&market, &second, [OTHER / 2, units(0, 25)], 0)
        .unwrap();
    (market, first, second)
}

/// `[R, L]`: the market's other-side reserve and its lent side's total `B + V`.
fn totals(env: &Env, market: &Market) -> [u128; 2] {
    let state = env.market_state(&market.market_state);
    [
        state.reserves[market.other_index()] as u128,
        env.lent_total(market) as u128,
    ]
}

#[test]
fn lock_lp_moves_shares_into_the_lock_account_and_its_event_reports_them() {
    let mut env = Env::new();
    let (market, lp, _) = lent_market(&mut env);
    let lock = env.lock_account(&market);
    assert!(env.svm.get_account(&lock).is_none(), "missing at first");
    let n = env.share_count(&market);
    let held = env.lp_shares_of(&market, &lp.pubkey());
    let lamports = env.svm.get_balance(&lp.pubkey()).unwrap();

    let meta = env.lock_lp(&market, &lp, held / 4).unwrap();
    assert_eq!(env.balance(&lock), held / 4);
    assert_eq!(env.lp_shares_of(&market, &lp.pubkey()), held - held / 4);
    // The lock account is created at the LP's expense, owned by the vault authority.
    let rent = env.svm.minimum_balance_for_rent_exemption(165);
    assert_eq!(lamports - env.svm.get_balance(&lp.pubkey()).unwrap(), rent);
    let account = env.svm.get_account(&lock).unwrap();
    assert_eq!(
        Pubkey::try_from(&account.data[32..64]).unwrap(),
        market.addresses.authority
    );
    let locked = events::<SharesLocked>(&meta.logs);
    assert_eq!(locked.len(), 1);
    assert_eq!(
        (
            locked[0].lp,
            locked[0].amount,
            locked[0].locked,
            locked[0].share_count
        ),
        (ak(&lp.pubkey()), held / 4, held / 4, n)
    );
    // Locked shares still count in N.
    assert_eq!(env.share_count(&market), n);

    // A second lock adds to the account, and the event reports the total locked.
    let meta = env.lock_lp(&market, &lp, held / 4).unwrap();
    assert_eq!(events::<SharesLocked>(&meta.logs)[0].locked, 2 * (held / 4));
    assert_eq!(env.balance(&lock), 2 * (held / 4));

    assert_refused(env.lock_lp(&market, &lp, 0), StrategyError::ZeroLock);
}

#[test]
fn locked_shares_keep_earning_the_lp_fee() {
    let mut env = Env::new();
    let (market, lp, _) = lent_market(&mut env);
    let held = env.lp_shares_of(&market, &lp.pubkey());
    env.lock_lp(&market, &lp, held).unwrap();
    let locked = env.balance(&env.lock_account(&market)) as u128;
    let n = env.share_count(&market) as u128;
    let before = totals(&env, &market);
    // Trades both ways pay the LP fee into the market.
    let (o, l) = (market.other_index(), market.lent_index);
    let trader = env.funded_wallet(&market, [OTHER, units(0, 50)]);
    env.swap(&market, &trader, (o, l), OTHER / 100).unwrap();
    env.swap(&market, &trader, (l, o), units(0, 1) / 2).unwrap();
    let after = totals(&env, &market);
    assert_eq!(env.share_count(&market) as u128, n);
    // N is unchanged, so the value of every share, the locked ones included,
    // R x L / N^2, has grown with the fee by as much as R x L.
    assert!(after[0] * after[1] > before[0] * before[1]);
    assert!(locked > 0 && locked < n);
}

#[test]
fn nothing_moves_shares_out_of_the_lock_account() {
    let mut env = Env::new();
    let (market, lp, _) = lent_market(&mut env);
    let held = env.lp_shares_of(&market, &lp.pubkey());
    env.lock_lp(&market, &lp, held / 2).unwrap();
    let lock = env.lock_account(&market);

    // A removal or a lock naming the lock account as the shares to take is refused: the LP
    // does not own it.
    let mut remove =
        env.remove_liquidity_instruction(&market, &lp.pubkey(), 1_000, [0, 0], Payout::InKind);
    remove.accounts[common::remove::position("lp_shares")].pubkey = lock;
    assert_refused(env.send(&[remove], &[&lp]), StrategyError::WrongAccount);
    let mut relock = env.lock_lp_instruction(&market, &lp.pubkey(), 1_000);
    relock.accounts[3].pubkey = lock;
    assert_refused(env.send(&[relock], &[&lp]), StrategyError::WrongAccount);
    // A swap paying out of it is refused, as any account other than the market's vault is.
    let trader = env.funded_wallet(&market, [OTHER, units(0, 50)]);
    let (o, l) = (market.other_index(), market.lent_index);
    let mut accounts = env
        .resolve_accounts(&market, &exact_in(o, l, OTHER / 100))
        .unwrap();
    accounts[0] = AccountMeta::new(lock, false);
    let swap = env.swap_instruction_with(
        &market,
        &trader.pubkey(),
        (o, l),
        OTHER / 100,
        pipeline_client::TradeMode::ExactIn,
        accounts,
    );
    assert_refused(env.send(&[swap], &[&trader]), StrategyError::WrongAccount);
    // An SPL Token transfer out needs the vault authority's signature, which only the program
    // can give.
    assert_eq!(env.balance(&lock), held / 2);
}

#[test]
fn an_lp_removes_from_any_lp_token_account_they_own() {
    let mut env = Env::new();
    let (market, lp, _) = lent_market(&mut env);
    // The LP moves some shares to their associated token account for the LP mint.
    let ata = env.spl_account(&lp.pubkey(), &market.addresses.lp_mint, 0);
    let mut data = vec![3u8]; // SPL Token `Transfer`
    data.extend_from_slice(&1_000_000u64.to_le_bytes());
    let transfer = pipeline_client::Instruction::new_with_bytes(
        TOKEN,
        &data,
        vec![
            AccountMeta::new(lp_shares_account(&lp.pubkey(), &market.market_state), false),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(lp.pubkey(), true),
        ],
    );
    env.send(&[transfer], &[&lp]).unwrap();
    let mut remove =
        env.remove_liquidity_instruction(&market, &lp.pubkey(), 1_000_000, [0, 0], Payout::InKind);
    remove.accounts[common::remove::position("lp_shares")].pubkey = ata;
    env.send(&[remove], &[&lp]).unwrap();
    assert_eq!(env.balance(&ata), 0);
}

#[test]
fn hostile_accounts_in_a_removal_are_refused() {
    let mut env = Env::new();
    let (market, lp, second) = lent_market(&mut env);
    // Another market, with its own vaults, cToken account and LP mint.
    let other_spec = lent_spec(&mut env, 0, 100);
    let (elsewhere, _) = env
        .create_funded_market(&other_spec, [OTHER, units(0, 50)])
        .unwrap();
    let shares = env.lp_shares_of(&market, &lp.pubkey()) / 4;
    let stranger = Pubkey::new_unique();
    let cases: Vec<(&str, Pubkey, StrategyError)> = vec![
        // Someone else's LP token account, for which the signer is not the owner.
        (
            "lp_shares",
            lp_shares_account(&second.pubkey(), &market.market_state),
            StrategyError::WrongAccount,
        ),
        (
            "lp_mint",
            elsewhere.addresses.lp_mint,
            StrategyError::WrongAccount,
        ),
        ("vault_0", elsewhere.vaults[0], StrategyError::WrongAccount),
        ("vault_1", elsewhere.vaults[1], StrategyError::WrongAccount),
        (
            "ctoken_account",
            elsewhere.addresses.ctoken_account,
            StrategyError::WrongAccount,
        ),
        (
            "authority",
            elsewhere.addresses.authority,
            StrategyError::WrongAccount,
        ),
        (
            "collateral_mint",
            env.kamino.address("collateral-mint-usdc"),
            StrategyError::WrongAccount,
        ),
    ];
    for payout in [Payout::Cash, Payout::InKind] {
        for (name, substitute, error) in &cases {
            let mut remove =
                env.remove_liquidity_instruction(&market, &lp.pubkey(), shares, [0, 0], payout);
            remove.accounts[common::remove::position(name)].pubkey = *substitute;
            let result = env.send(&[remove], &[&lp]);
            if *name == "authority" {
                // Anchor's seeds check names its own error.
                assert!(result.is_err(), "{name}: {result:?}");
            } else {
                assert_refused(result, *error);
            }
        }
    }
    // A cToken account other than the LP's own is refused in kind; in cash, which never touches
    // it, it is ignored.
    let mut remove =
        env.remove_liquidity_instruction(&market, &lp.pubkey(), shares, [0, 0], Payout::InKind);
    remove.accounts[common::remove::position("lp_ctoken")].pubkey = stranger;
    assert_refused(env.send(&[remove], &[&lp]), StrategyError::WrongAccount);
    let mut remove =
        env.remove_liquidity_instruction(&market, &lp.pubkey(), shares, [0, 0], Payout::Cash);
    remove.accounts[common::remove::position("lp_ctoken")].pubkey = stranger;
    env.send(&[remove], &[&lp]).unwrap();
    assert!(env.svm.get_account(&stranger).is_none());
    // A removal aimed at another market's vaults through that market's state is that market's
    // removal, which the LP holds no shares of.
    let mut remove =
        env.remove_liquidity_instruction(&market, &lp.pubkey(), shares, [0, 0], Payout::InKind);
    remove.accounts[common::remove::position("market_state")].pubkey = elsewhere.market_state;
    assert!(env.send(&[remove], &[&lp]).is_err());
}

#[test]
fn hostile_accounts_in_a_lock_are_refused() {
    let mut env = Env::new();
    let (market, lp, second) = lent_market(&mut env);
    let other_spec = lent_spec(&mut env, 0, 100);
    let (elsewhere, _) = env
        .create_funded_market(&other_spec, [OTHER, units(0, 50)])
        .unwrap();
    let position = |name: &str| LOCK_ACCOUNTS.iter().position(|n| *n == name).unwrap();
    let cases = [
        (
            "lp_shares",
            lp_shares_account(&second.pubkey(), &market.market_state),
        ),
        ("lp_mint", elsewhere.addresses.lp_mint),
        // Another market's lock account, or the LP's own token account.
        ("lock_account", env.lock_account(&elsewhere)),
        (
            "lock_account",
            env.spl_account(&lp.pubkey(), &market.addresses.lp_mint, 0),
        ),
    ];
    for (name, substitute) in cases {
        let mut lock = env.lock_lp_instruction(&market, &lp.pubkey(), 1_000);
        lock.accounts[position(name)].pubkey = substitute;
        assert_refused(env.send(&[lock], &[&lp]), StrategyError::WrongAccount);
    }
}
