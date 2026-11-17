//! What a market owes leaves it, through the real router (docs/spec/pool4-for-solana.md,
//! "`settle`", "`pay_rewards`", "`sweep_fees { slot }`", "Recipients", "Worked example"):
//! `settle` burns the retired tokens but the reward share, `pay_rewards` pays the reward share
//! to the rewards recipient, `sweep_fees` pays each fee ledger to its wallet, and each
//! recipient can hand its own role to another wallet. All four keeper-side actions are
//! permissionless, and no recipient's account, however broken, ever blocks trading or another
//! payout.

mod common;

use buy_wall_amm::events::Settled;
use common::payouts::*;
use common::*;
use pipeline_client::{Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;

const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;
const BUY: (usize, usize) = (1, 0);
const SELL: (usize, usize) = (0, 1);

/// Moves the clock `seconds` on, with slots to match.
fn later(env: &mut Env, seconds: i64) {
    let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    env.set_clock(
        clock.slot + seconds as u64 * 5 / 2 + 1,
        clock.unix_timestamp + seconds,
    );
}

/// A mint's supply (SPL Token's and Token-2022's mint layout: the supply at 36).
fn supply(env: &Env, mint: &Pubkey) -> u64 {
    let data = env.svm.get_account(mint).expect("the mint").data;
    u64::from_le_bytes(data[36..44].try_into().unwrap())
}

/// Swaps `amount` through the router; returns what it paid.
fn swap(
    env: &mut Env,
    market: &Market,
    trader: &Keypair,
    direction: (usize, usize),
    amount: u64,
) -> u64 {
    env.swap_logged(market, trader, direction, TradeMode::ExactIn, amount, 0)
        .unwrap()
        .0
        .received
}

/// Every vault holds exactly its ledgers.
fn assert_books(env: &Env, market: &Market) {
    let state = env.state(market);
    assert_eq!(
        env.balance(&market.token_vault) as u128,
        state.pool_tokens() as u128 + state.retired_tokens() as u128 + state.rewards_owed() as u128,
        "the token vault holds its ledgers"
    );
    assert_eq!(
        env.balance(&market.sol_vault) as u128,
        state.pool_sol() as u128
            + state.idle_sol() as u128
            + state.fees_recipient() as u128
            + state.fees_designer() as u128
            + state.fees_suite() as u128,
        "the SOL vault holds its ledgers"
    );
}

/// The worked example's market (docs/spec/pool4-for-solana.md, "Worked example"), with the
/// launch values, traded and walled up to its `settle`: an hour after the seed a buy of 1
/// SOL, 60 seconds later a sell of what it bought, which trims, then `place_wall`.
fn worked_example_walled(env: &mut Env, params: &buy_wall_amm::InitParams) -> (Market, Keypair) {
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(token, TOKEN, params, TOKENS, LAMPORTS)
        .unwrap();
    let trader = env.trader(&market, 300_000_000_000, 100 * SOL);
    later(env, 3_600);
    let bought = swap(env, &market, &trader, BUY, SOL);
    assert_eq!(bought, 90_081_892_629);
    later(env, 60);
    assert_eq!(swap(env, &market, &trader, SELL, bought), 980_099_999);
    let keeper = env.keeper();
    let (tip, _) = env.place_wall(&market, &keeper).unwrap();
    assert_eq!(tip, 912_933);
    assert_eq!(env.state(&market).retired_tokens(), 8_333_333_340);
    (market, trader)
}

#[test]
fn the_worked_examples_settle_is_reproduced_through_the_router() {
    let mut env = Env::new();
    let params = launch_params(env.admin.pubkey());
    let (market, trader) = worked_example_walled(&mut env, &params);
    let before = env.state(&market);
    set_supply(&mut env, &market.token_mint, TOKENS + 300_000_000_000);
    let supply_before = supply(&env, &market.token_mint);

    // Anyone may settle: nobody signs it but whoever pays the transaction fee.
    assert!(settle_ix(&market).accounts.iter().all(|a| !a.is_signer));
    let (_, logs) = env.send_logged(&[settle_ix(&market)], &[]).unwrap();

    let after = env.state(&market);
    assert_eq!(
        supply_before - supply(&env, &market.token_mint),
        7_083_333_339
    );
    assert_eq!(after.rewards_owed(), 1_250_000_001);
    assert_eq!(after.retired_tokens(), 0);
    assert_eq!(after.tokens_burned(), 7_083_333_339);
    assert_eq!(
        events::<Settled>(&logs),
        vec![Settled {
            market_state: market.market_state,
            retired: 8_333_333_340,
            burned: 7_083_333_339,
            to_rewards: 1_250_000_001,
            rewards_owed: 1_250_000_001,
            tokens_burned: 7_083_333_339,
        }]
    );
    // `settle` never moves the price, the curve, the wall, the cap, the guard or the counters.
    assert_eq!(after.sqrt_price(), before.sqrt_price());
    assert_eq!(after.liquidity(), before.liquidity());
    assert_eq!(after.wall(), before.wall());
    assert_eq!(after.cap(), before.cap());
    assert_eq!(after.guard(), before.guard());
    assert_eq!(after.counters(), before.counters());
    assert_eq!(after.books(), before.books());
    assert_books(&env, &market);

    // Settled with nothing retired: refused.
    assert_refused(
        env.send(&[settle_ix(&market)], &[]),
        buy_wall_amm::errors::StrategyError::NothingToSettle,
    );

    // And the worked example's last row is unchanged by it: 60 seconds later, a sell of
    // 20,000,000,000 units through the curve and the wall together.
    later(&mut env, 60);
    assert_eq!(
        swap(&mut env, &market, &trader, SELL, 20_000_000_000),
        194_120_326
    );
    assert_eq!(env.state(&market).sqrt_price(), 1_808_529_293_213_661_729);
    assert_books(&env, &market);
}

/// Creation parameters with the launch values and these recipients.
fn params_with(
    env: &Env,
    fee_recipient: Pubkey,
    rewards_recipient: Pubkey,
) -> buy_wall_amm::InitParams {
    let mut params = launch_params(env.admin.pubkey());
    params.fee_recipient = fee_recipient;
    params.rewards_recipient = rewards_recipient;
    params
}

/// A wallet with SOL for fees and rent, and nothing else.
fn wallet(env: &mut Env) -> Keypair {
    let wallet = Keypair::new();
    env.svm.airdrop(&wallet.pubkey(), SOL).unwrap();
    wallet
}

/// The worked example's market after its `settle`, with both recipients' keys: every
/// ledger a payout pays is above 0.
struct Owing {
    env: Env,
    market: Market,
    trader: Keypair,
    fee_recipient: Keypair,
    rewards_recipient: Keypair,
}

fn owing() -> Owing {
    let mut env = Env::new();
    let (fee_recipient, rewards_recipient) = (wallet(&mut env), wallet(&mut env));
    let params = params_with(&env, fee_recipient.pubkey(), rewards_recipient.pubkey());
    let (market, trader) = worked_example_walled(&mut env, &params);
    set_supply(&mut env, &market.token_mint, TOKENS + 300_000_000_000);
    env.send(&[settle_ix(&market)], &[]).unwrap();
    let state = env.state(&market);
    assert_eq!(state.rewards_owed(), 1_250_000_001);
    assert!(state.fees_recipient() > 0 && state.fees_designer() > 0 && state.fees_suite() > 0);
    Owing {
        env,
        market,
        trader,
        fee_recipient,
        rewards_recipient,
    }
}

/// `pay_rewards` paid for by `payer`, to `recipient`, with the token's hook accounts.
fn pay_rewards(
    env: &mut Env,
    market: &Market,
    payer: &Keypair,
    recipient: &Pubkey,
) -> Result<Vec<String>, String> {
    let to = pipeline_client::pda::associated_token(
        recipient,
        &market.token_mint,
        &market.token_program,
    );
    let hooks = env.hook_accounts(
        &market.token_mint,
        market.token_vault,
        to,
        market.vault_authority,
    );
    env.send_logged(
        &[pay_rewards_ix(market, &payer.pubkey(), recipient, hooks)],
        &[payer],
    )
    .map(|(_, logs)| logs)
}

/// `sweep_fees { slot }` paid for by `payer`, to `recipient`.
fn sweep(
    env: &mut Env,
    market: &Market,
    payer: &Keypair,
    recipient: &Pubkey,
    slot: u8,
) -> Result<Vec<String>, String> {
    env.send_logged(
        &[sweep_fees_ix(market, &payer.pubkey(), recipient, slot)],
        &[payer],
    )
    .map(|(_, logs)| logs)
}

/// A wallet's associated token account balance, 0 when it has none.
fn held(env: &Env, owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> u64 {
    let account = pipeline_client::pda::associated_token(owner, mint, program);
    env.svm
        .get_account(&account)
        .map(|_| env.balance(&account))
        .unwrap_or(0)
}

#[test]
fn pay_rewards_pays_everything_owed_to_the_rewards_recipient() {
    use buy_wall_amm::errors::StrategyError;
    use buy_wall_amm::events::RewardsPaid;
    let Owing {
        mut env,
        market,
        rewards_recipient,
        ..
    } = owing();
    let recipient = rewards_recipient.pubkey();
    let to = pipeline_client::pda::associated_token(&recipient, &market.token_mint, &TOKEN);
    assert!(
        env.svm.get_account(&to).is_none(),
        "the recipient has no token account yet"
    );
    let before = env.state(&market);

    // The wrong recipient, or another account of the right one, is refused.
    let payer = wallet(&mut env);
    let stranger = Pubkey::new_unique();
    assert_refused(
        pay_rewards(&mut env, &market, &payer, &stranger),
        StrategyError::WrongAccount,
    );
    let mut ix = pay_rewards_ix(&market, &payer.pubkey(), &recipient, vec![]);
    ix.accounts[5].pubkey = market.token_vault;
    assert_refused(env.send(&[ix], &[&payer]), StrategyError::WrongAccount);

    // Anyone may pay it; the caller pays for the recipient's missing token account.
    let lamports = env.svm.get_balance(&payer.pubkey()).unwrap();
    let logs = pay_rewards(&mut env, &market, &payer, &recipient).unwrap();
    assert_eq!(env.balance(&to), 1_250_000_001);
    assert!(
        env.svm.get_balance(&payer.pubkey()).unwrap() < lamports,
        "the payer paid the rent"
    );
    let after = env.state(&market);
    assert_eq!(
        (after.rewards_owed(), after.rewards_paid()),
        (0, 1_250_000_001)
    );
    assert_eq!(
        events::<RewardsPaid>(&logs),
        vec![RewardsPaid {
            market_state: market.market_state,
            recipient: recipient.to_bytes().into(),
            token_account: to.to_bytes().into(),
            amount: 1_250_000_001,
            rewards_paid: 1_250_000_001,
        }]
    );
    assert_eq!(after.sqrt_price(), before.sqrt_price());
    assert_eq!(after.counters(), before.counters());
    assert_eq!(after.books(), before.books());
    assert_books(&env, &market);

    // Nothing owed: refused.
    assert_refused(
        pay_rewards(&mut env, &market, &payer, &recipient),
        StrategyError::NothingOwed,
    );
}

#[test]
fn sweep_fees_pays_each_slot_to_its_wallet() {
    use buy_wall_amm::config::{DESIGNER_RECIPIENT, SUITE_TREASURY};
    use buy_wall_amm::errors::StrategyError;
    use buy_wall_amm::events::FeesSwept;
    let Owing {
        mut env,
        market,
        fee_recipient,
        ..
    } = owing();
    let before = env.state(&market);
    let payer = wallet(&mut env);
    let recipient = fee_recipient.pubkey();
    let suite = SUITE_TREASURY.to_bytes().into();

    // Each slot only to its own wallet, and no slot past 2.
    assert_refused(
        sweep(&mut env, &market, &payer, &suite, 0),
        StrategyError::WrongAccount,
    );
    assert_refused(
        sweep(&mut env, &market, &payer, &recipient, 2),
        StrategyError::WrongAccount,
    );
    assert_refused(
        sweep(&mut env, &market, &payer, &recipient, 3),
        StrategyError::BadFeeSlot,
    );

    // Slot 0 to the fee recipient and slot 2 to the suite treasury, each into an account the
    // payout creates.
    let logs = sweep(&mut env, &market, &payer, &recipient, 0).unwrap();
    assert_eq!(
        held(&env, &recipient, &WSOL, &TOKEN),
        before.fees_recipient()
    );
    let [swept] = events::<FeesSwept>(&logs).try_into().unwrap();
    assert_eq!(
        swept,
        FeesSwept {
            market_state: market.market_state,
            slot: 0,
            recipient: recipient.to_bytes().into(),
            token_account: pipeline_client::pda::associated_token(&recipient, &WSOL, &TOKEN)
                .to_bytes()
                .into(),
            amount: before.fees_recipient(),
        }
    );
    sweep(&mut env, &market, &payer, &suite, 2).unwrap();
    assert_eq!(held(&env, &suite, &WSOL, &TOKEN), before.fees_suite());

    // Slot 1: refused while DESIGNER_RECIPIENT is unset, the SOL waiting in the vault; paid
    // in a build where it is set (CI's `test-designer-recipient` build).
    let designer = DESIGNER_RECIPIENT.to_bytes().into();
    let designer_slot = sweep(&mut env, &market, &payer, &designer, 1);
    if DESIGNER_RECIPIENT == anchor_lang::prelude::Pubkey::default() {
        assert_refused(designer_slot, StrategyError::RecipientUnset);
        assert_eq!(env.state(&market).fees_designer(), before.fees_designer());
    } else {
        designer_slot.unwrap();
        assert_eq!(held(&env, &designer, &WSOL, &TOKEN), before.fees_designer());
        assert_eq!(env.state(&market).fees_designer(), 0);
    }

    let after = env.state(&market);
    assert_eq!((after.fees_recipient(), after.fees_suite()), (0, 0));
    assert_eq!(after.sqrt_price(), before.sqrt_price());
    assert_eq!(after.counters(), before.counters());
    assert_eq!(
        (after.pool_sol(), after.idle_sol(), after.pool_tokens()),
        (before.pool_sol(), before.idle_sol(), before.pool_tokens())
    );
    assert_books(&env, &market);

    // Nothing owed: refused.
    assert_refused(
        sweep(&mut env, &market, &payer, &recipient, 0),
        StrategyError::NothingOwed,
    );
    assert_refused(
        sweep(&mut env, &market, &payer, &suite, 2),
        StrategyError::NothingOwed,
    );
}

#[test]
fn each_recipient_hands_over_its_own_role_and_what_it_is_owed() {
    use buy_wall_amm::errors::StrategyError;
    use buy_wall_amm::events::{RecipientChanged, RecipientRole};
    let Owing {
        mut env,
        market,
        fee_recipient,
        rewards_recipient,
        ..
    } = owing();
    let before = env.state(&market);
    let (new_fee, new_rewards) = (wallet(&mut env), wallet(&mut env));
    let stranger = wallet(&mut env);
    let admin = env.admin.insecure_clone();
    let seeder = admin.insecure_clone();

    // Every attempt by anyone but the role's current recipient is refused: a stranger, the
    // creator and seeder, the other role's recipient, and the new wallet itself.
    for (rewards, signer) in [
        (false, &stranger),
        (false, &admin),
        (false, &seeder),
        (false, &rewards_recipient),
        (false, &new_fee),
        (true, &stranger),
        (true, &admin),
        (true, &fee_recipient),
        (true, &new_rewards),
    ] {
        let new = if rewards {
            new_rewards.pubkey()
        } else {
            new_fee.pubkey()
        };
        let ix = handover_ix(&market, rewards, &signer.pubkey(), &new);
        assert_refused(env.send(&[ix], &[signer]), StrategyError::NotRecipient);
    }
    // Never to the default key.
    for (rewards, signer) in [(false, &fee_recipient), (true, &rewards_recipient)] {
        let ix = handover_ix(&market, rewards, &signer.pubkey(), &Pubkey::default());
        assert_refused(
            env.send(&[ix], &[signer]),
            StrategyError::NewRecipientRequired,
        );
    }
    // Unsigned: refused before the program runs.
    let mut ix = handover_ix(&market, false, &fee_recipient.pubkey(), &stranger.pubkey());
    ix.accounts[0].is_signer = false;
    assert_fails(env.send(&[ix], &[]));
    assert_eq!(env.state(&market).fee_recipient, before.fee_recipient);
    assert_eq!(
        env.state(&market).rewards_recipient,
        before.rewards_recipient
    );

    // The current recipients hand over.
    let ix = handover_ix(&market, false, &fee_recipient.pubkey(), &new_fee.pubkey());
    let (_, logs) = env.send_logged(&[ix], &[&fee_recipient]).unwrap();
    assert_eq!(
        events::<RecipientChanged>(&logs),
        vec![RecipientChanged {
            market_state: market.market_state,
            role: RecipientRole::Fee,
            old: fee_recipient.pubkey().to_bytes().into(),
            new: new_fee.pubkey().to_bytes().into(),
        }]
    );
    let ix = handover_ix(
        &market,
        true,
        &rewards_recipient.pubkey(),
        &new_rewards.pubkey(),
    );
    let (_, logs) = env.send_logged(&[ix], &[&rewards_recipient]).unwrap();
    assert_eq!(events::<RecipientChanged>(&logs).len(), 1);
    let after = env.state(&market);
    assert_eq!(after.fee_recipient.to_bytes(), new_fee.pubkey().to_bytes());
    assert_eq!(
        after.rewards_recipient.to_bytes(),
        new_rewards.pubkey().to_bytes()
    );
    // Nothing else changed: what each role is owed stays with it.
    let mut unchanged = after;
    unchanged.fee_recipient = before.fee_recipient;
    unchanged.rewards_recipient = before.rewards_recipient;
    assert_eq!(bytemuck::bytes_of(&unchanged), bytemuck::bytes_of(&before));

    // The old recipients can no longer act for the role, and the payouts follow it.
    let ix = handover_ix(
        &market,
        false,
        &fee_recipient.pubkey(),
        &fee_recipient.pubkey(),
    );
    assert_refused(
        env.send(&[ix], &[&fee_recipient]),
        StrategyError::NotRecipient,
    );
    let payer = wallet(&mut env);
    assert_refused(
        sweep(&mut env, &market, &payer, &fee_recipient.pubkey(), 0),
        StrategyError::WrongAccount,
    );
    sweep(&mut env, &market, &payer, &new_fee.pubkey(), 0).unwrap();
    assert_eq!(
        held(&env, &new_fee.pubkey(), &WSOL, &TOKEN),
        before.fees_recipient()
    );
    pay_rewards(&mut env, &market, &payer, &new_rewards.pubkey()).unwrap();
    assert_eq!(
        held(&env, &new_rewards.pubkey(), &market.token_mint, &TOKEN),
        1_250_000_001
    );
    assert_eq!(
        held(
            &env,
            &rewards_recipient.pubkey(),
            &market.token_mint,
            &TOKEN
        ),
        0
    );

    // And the new recipient can hand it on again.
    let ix = handover_ix(&market, false, &new_fee.pubkey(), &fee_recipient.pubkey());
    env.send(&[ix], &[&new_fee]).unwrap();
}

#[test]
fn a_market_created_with_no_recipient_never_gets_one() {
    use buy_wall_amm::errors::StrategyError;
    let mut env = Env::new();
    // The whole market share to the wall and no reward share: no recipient at all.
    let mut params = params_with(&env, Pubkey::default(), Pubkey::default());
    params.wall_split_bps = 10_000;
    params.reward_share_bps = 0;
    let (market, trader) = worked_example_walled_no_check(&mut env, &params);
    let stranger = wallet(&mut env);
    for rewards in [false, true] {
        let ix = handover_ix(&market, rewards, &stranger.pubkey(), &stranger.pubkey());
        assert_refused(env.send(&[ix], &[&stranger]), StrategyError::RecipientUnset);
    }
    // Every retired token burns, nothing is ever owed to the missing roles, and their
    // payouts are refused.
    set_supply(&mut env, &market.token_mint, TOKENS + 300_000_000_000);
    let retired = env.state(&market).retired_tokens();
    env.send(&[settle_ix(&market)], &[]).unwrap();
    let state = env.state(&market);
    assert_eq!(
        (state.rewards_owed(), state.tokens_burned()),
        (0, retired as u128)
    );
    assert_eq!(state.fees_recipient(), 0);
    let payer = wallet(&mut env);
    assert_refused(
        pay_rewards(&mut env, &market, &payer, &Pubkey::default()),
        StrategyError::RecipientUnset,
    );
    assert_refused(
        sweep(&mut env, &market, &payer, &Pubkey::default(), 0),
        StrategyError::RecipientUnset,
    );
    let _ = trader;
}

/// `worked_example_walled` for any parameters: the same trades and `place_wall`, without the
/// worked example's numbers.
fn worked_example_walled_no_check(
    env: &mut Env,
    params: &buy_wall_amm::InitParams,
) -> (Market, Keypair) {
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(token, TOKEN, params, TOKENS, LAMPORTS)
        .unwrap();
    let trader = env.trader(&market, 300_000_000_000, 100 * SOL);
    later(env, 3_600);
    let bought = swap(env, &market, &trader, BUY, SOL);
    later(env, 60);
    swap(env, &market, &trader, SELL, bought);
    let keeper = env.keeper();
    env.place_wall(&market, &keeper).unwrap();
    assert!(env.state(&market).retired_tokens() > 0);
    (market, trader)
}

/// A market of a token whose transfer hook was cleared (`POOL4-48`), traded and walled as
/// the worked example's is, then settled.
fn hooked_owing(
    env: &mut Env,
    token: Pubkey,
    params: &buy_wall_amm::InitParams,
    trader: &Keypair,
) -> Market {
    let market = env
        .create_and_seed_hooked(token, params, TOKENS, LAMPORTS)
        .unwrap();
    env.fund(
        &trader.pubkey(),
        &token,
        &TOKEN_2022,
        300_000_000_000,
        100 * SOL,
    );
    later(env, 3_600);
    let bought = swap(env, &market, trader, BUY, SOL);
    assert_eq!(bought, 90_081_892_629);
    later(env, 60);
    assert_eq!(swap(env, &market, trader, SELL, bought), 980_099_999);
    let keeper = env.keeper();
    env.place_wall(&market, &keeper).unwrap();
    set_supply(env, &token, TOKENS + 300_000_000_000);
    env.send(&[settle_ix(&market)], &[]).unwrap();
    assert_eq!(env.state(&market).rewards_owed(), 1_250_000_001);
    market
}

/// A token carries a transfer hook into a market only once the hook is cleared
/// (`POOL4-48`; the seed's refusal of a live one is `sos_h001_*` in tests/seed.rs), so no
/// hook can refuse a payout any more and the earlier test of a recipient a hook refused is
/// gone; the recipient accounts that can still refuse one are those of
/// `a_missing_closed_or_reassigned_recipient_account_blocks_nothing_else`.
#[test]
fn a_token_whose_transfer_hook_was_cleared_goes_through_the_seed_swaps_and_pay_rewards() {
    let mut env = Env::new();
    let token = env.seedable_hooked_token();
    let (fee_recipient, rewards_recipient) = (wallet(&mut env), wallet(&mut env));
    let params = params_with(&env, fee_recipient.pubkey(), rewards_recipient.pubkey());
    let trader = wallet(&mut env);
    let market = hooked_owing(&mut env, token, &params, &trader);
    // No hook accounts are needed, and no hook is called.
    let payer = wallet(&mut env);
    let ix = pay_rewards_ix(
        &market,
        &payer.pubkey(),
        &rewards_recipient.pubkey(),
        vec![],
    );
    let (_, logs) = env.send_logged(&[ix], &[&payer]).unwrap();
    let hook = format!("Program {TEST_HOOK_PROGRAM} invoke");
    assert!(
        !logs.iter().any(|line| line.starts_with(&hook)),
        "no hook ran"
    );
    assert_eq!(
        held(&env, &rewards_recipient.pubkey(), &token, &TOKEN_2022),
        1_250_000_001
    );
    assert_eq!(env.state(&market).rewards_owed(), 0);
    assert_books(&env, &market);
}

/// Hands `account`'s ownership to `new_owner` (SPL Token allows it for any account, an
/// associated one included).
fn reassign(env: &mut Env, account: &Pubkey, owner: &Keypair, new_owner: &Pubkey) {
    let ix = spl_token_2022_interface::instruction::set_authority(
        &TOKEN,
        account,
        Some(new_owner),
        spl_token_2022_interface::instruction::AuthorityType::AccountOwner,
        &owner.pubkey(),
        &[],
    )
    .unwrap();
    env.send(&[ix], &[owner]).unwrap();
}

#[test]
fn a_missing_closed_or_reassigned_recipient_account_blocks_nothing_else() {
    use buy_wall_amm::errors::StrategyError;
    let Owing {
        mut env,
        market,
        trader,
        fee_recipient,
        rewards_recipient,
    } = owing();
    let payer = wallet(&mut env);
    let suite = buy_wall_amm::config::SUITE_TREASURY.to_bytes().into();

    // The fee recipient's wrapped SOL account and the rewards recipient's token account both
    // exist, and each recipient has handed its account's ownership to someone else.
    let thief = Pubkey::new_unique();
    for (owner, mint) in [
        (&fee_recipient, WSOL),
        (&rewards_recipient, market.token_mint),
    ] {
        write_token_account(&mut env.svm, &mint, &TOKEN, &owner.pubkey(), 0).unwrap();
        let account = pipeline_client::pda::associated_token(&owner.pubkey(), &mint, &TOKEN);
        reassign(&mut env, &account, owner, &thief);
    }
    let before = env.state(&market);
    assert_refused(
        sweep(&mut env, &market, &payer, &fee_recipient.pubkey(), 0),
        StrategyError::RecipientAccountNotTheirs,
    );
    assert_refused(
        pay_rewards(&mut env, &market, &payer, &rewards_recipient.pubkey()),
        StrategyError::RecipientAccountNotTheirs,
    );
    assert_eq!(
        env.state(&market).owed(),
        before.owed(),
        "nothing was paid to anyone"
    );

    // Trading, `settle` and the other fee slot go on.
    later(&mut env, 60);
    let bought = swap(&mut env, &market, &trader, BUY, SOL);
    later(&mut env, 60);
    swap(&mut env, &market, &trader, SELL, bought);
    let keeper = env.keeper();
    let _ = env.place_wall(&market, &keeper);
    let _ = env.send(&[settle_ix(&market)], &[]);
    sweep(&mut env, &market, &payer, &suite, 2).unwrap();
    assert_books(&env, &market);

    // Handed over to fresh wallets with no accounts at all, the roles are paid into
    // accounts the payouts create.
    let (new_fee, new_rewards) = (wallet(&mut env), wallet(&mut env));
    let ix = handover_ix(&market, false, &fee_recipient.pubkey(), &new_fee.pubkey());
    env.send(&[ix], &[&fee_recipient]).unwrap();
    let ix = handover_ix(
        &market,
        true,
        &rewards_recipient.pubkey(),
        &new_rewards.pubkey(),
    );
    env.send(&[ix], &[&rewards_recipient]).unwrap();
    let state = env.state(&market);
    let (fees, rewards) = (state.fees_recipient(), state.rewards_owed());
    sweep(&mut env, &market, &payer, &new_fee.pubkey(), 0).unwrap();
    pay_rewards(&mut env, &market, &payer, &new_rewards.pubkey()).unwrap();
    assert_eq!(held(&env, &new_fee.pubkey(), &WSOL, &TOKEN), fees);
    assert_eq!(
        held(&env, &new_rewards.pubkey(), &market.token_mint, &TOKEN),
        rewards
    );

    // The new fee recipient unwraps by closing its account; the next sweep creates it again.
    let account = pipeline_client::pda::associated_token(&new_fee.pubkey(), &WSOL, &TOKEN);
    let close = spl_token_2022_interface::instruction::close_account(
        &TOKEN,
        &account,
        &new_fee.pubkey(),
        &new_fee.pubkey(),
        &[],
    )
    .unwrap();
    env.send(&[close], &[&new_fee]).unwrap();
    assert!(env.svm.get_account(&account).is_none());
    later(&mut env, 60);
    swap(&mut env, &market, &trader, BUY, SOL);
    let fees = env.state(&market).fees_recipient();
    assert!(fees > 0);
    sweep(&mut env, &market, &payer, &new_fee.pubkey(), 0).unwrap();
    assert_eq!(held(&env, &new_fee.pubkey(), &WSOL, &TOKEN), fees);

    // Lamports someone sent to a missing account's address never block its creation: the
    // rewards role, handed to a wallet whose account address already holds SOL, is paid
    // into an account the payout creates there.
    let prefunded = wallet(&mut env);
    let ix = handover_ix(&market, true, &new_rewards.pubkey(), &prefunded.pubkey());
    env.send(&[ix], &[&new_rewards]).unwrap();
    let address =
        pipeline_client::pda::associated_token(&prefunded.pubkey(), &market.token_mint, &TOKEN);
    env.svm.airdrop(&address, 1_000_000).unwrap();
    later(&mut env, 3_600);
    let bought = swap(&mut env, &market, &trader, BUY, 3 * SOL);
    later(&mut env, 60);
    // More than the buy took, so the curve ends above the cap and trims.
    swap(&mut env, &market, &trader, SELL, bought + 100_000_000_000);
    let _ = env.place_wall(&market, &keeper);
    env.send(&[settle_ix(&market)], &[]).unwrap();
    let rewards = env.state(&market).rewards_owed();
    assert!(rewards > 0);
    pay_rewards(&mut env, &market, &payer, &prefunded.pubkey()).unwrap();
    assert_eq!(env.balance(&address), rewards);
}

#[test]
fn payouts_wait_for_the_seed_and_handovers_do_not() {
    use buy_wall_amm::errors::StrategyError;
    let mut env = Env::new();
    let (fee_recipient, rewards_recipient) = (wallet(&mut env), wallet(&mut env));
    let params = params_with(&env, fee_recipient.pubkey(), rewards_recipient.pubkey());
    let token = env.seedable_token(&TOKEN);
    let market = env.create_market(token, TOKEN, &params).unwrap();
    let payer = wallet(&mut env);
    assert_refused(
        env.send(&[settle_ix(&market)], &[]),
        StrategyError::MarketNotOpen,
    );
    assert_refused(
        pay_rewards(&mut env, &market, &payer, &rewards_recipient.pubkey()),
        StrategyError::MarketNotOpen,
    );
    assert_refused(
        sweep(&mut env, &market, &payer, &fee_recipient.pubkey(), 0),
        StrategyError::MarketNotOpen,
    );
    // A recipient may hand its role over before the seed (`POOL4-38`).
    let new = Pubkey::new_unique();
    let ix = handover_ix(&market, false, &fee_recipient.pubkey(), &new);
    env.send(&[ix], &[&fee_recipient]).unwrap();
    assert_eq!(env.state(&market).fee_recipient.to_bytes(), new.to_bytes());
}

/// The `test-designer-recipient` build pays fee slot 1 to a key nobody holds, so it has a
/// program id of its own: deployed at the program's real address it refuses every
/// instruction (`POOL4-39`).
#[cfg(feature = "test-designer-recipient")]
#[test]
fn the_designer_test_build_refuses_everything_at_the_real_address() {
    let real: Pubkey = pipeline_client::pubkey!("BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6");
    assert_ne!(strategy_id(), real);
    let mut env = Env::new();
    env.svm.add_program(real, &strategy_so()).unwrap();
    let mut ix = settle_ix(&Market::addresses(
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        TOKEN,
    ));
    ix.program_id = real;
    let message = env.send(&[ix], &[]).expect_err("refused");
    // Anchor's DeclaredProgramIdMismatch.
    assert!(message.contains("Custom(4100)"), "{message}");
}
