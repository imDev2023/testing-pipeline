//! The reward share is paid only on retired tokens matched by the cap's own fall
//! (docs/spec/pool4-for-solana.md, "After pricing" step 6, "`settle`"; `POOL4-49`), through
//! the real router: the rewards recipient's wash trade earns no more than the reward share of
//! the cap's fall (SOS H002, and the trim half of H056), a dip trimmed from a tight cap pays
//! no reward share (H005), and the tokens a closed wall bought burn whole (H007, and the wall
//! half of H056).

mod common;

use buy_wall_amm::cap::SECONDS_PER_DAY;
use buy_wall_amm::errors::StrategyError;
use buy_wall_amm::events::Settled;
use buy_wall_amm::InitParams;
use common::payouts::*;
use common::*;
use pipeline_client::{pda, Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;

const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;
const BUY: (usize, usize) = (1, 0);
const SELL: (usize, usize) = (0, 1);
/// Token units a wallet holds beyond what it trades, for Pipeline's 0.25% on sells, which the
/// router takes from the trader on top of the amount sent.
const SPARE: u64 = 1_000_000_000;

/// The most an exact-in buy may send from `lamports` of wrapped SOL, with Pipeline's 0.25%
/// on top.
fn spendable(lamports: u64) -> u64 {
    lamports * 10_000 / 10_025
}

/// Moves the clock `seconds` on, with slots to match.
fn later(env: &mut Env, seconds: i64) {
    let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    env.set_clock(
        clock.slot + seconds as u64 * 5 / 2 + 1,
        clock.unix_timestamp + seconds,
    );
}

/// The launch values with `recipient` as the rewards recipient and `reward_share_bps`.
fn params(env: &Env, recipient: &Keypair, reward_share_bps: u16) -> InitParams {
    InitParams {
        reward_share_bps,
        rewards_recipient: recipient.pubkey(),
        ..launch_params(env.admin.pubkey())
    }
}

/// A market seeded as the worked example's, its rewards recipient a wallet holding `tokens`
/// of the token and `lamports` of wrapped SOL.
fn seeded(env: &mut Env, reward_share_bps: u16, tokens: u64, lamports: u64) -> (Market, Keypair) {
    let recipient = Keypair::new();
    let params = params(env, &recipient, reward_share_bps);
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(token, TOKEN, &params, TOKENS, LAMPORTS)
        .unwrap();
    env.svm.airdrop(&recipient.pubkey(), SOL).unwrap();
    env.fund(
        &recipient.pubkey(),
        &market.token_mint,
        &TOKEN,
        tokens,
        lamports,
    );
    (market, recipient)
}

/// What an exact-in trade of `amount` pays, quoted (a quote equals its swap).
fn quoted(env: &Env, market: &Market, (input, output): (usize, usize), amount: u64) -> u64 {
    env.quote(market, &exact_in(input, output, amount))
        .unwrap()
        .amount_out
}

/// An exact-in swap instruction by `trader` with no minimum.
fn swap_ix(
    env: &Env,
    market: &Market,
    trader: &Keypair,
    direction: (usize, usize),
    amount: u64,
) -> pipeline_client::Instruction {
    env.swap_ix(
        market,
        &trader.pubkey(),
        direction,
        TradeMode::ExactIn,
        amount,
        0,
    )
}

/// `owner`'s balance of the market's token and of wrapped SOL.
fn balances(env: &Env, market: &Market, owner: &Pubkey) -> (u64, u64) {
    (
        env.balance(&pda::associated_token(owner, &market.token_mint, &TOKEN)),
        env.balance(&pda::associated_token(owner, &WSOL, &TOKEN)),
    )
}

/// SOS H002: a day after the seed, the rewards recipient buys 1 SOL of the token, sells it
/// straight back, settles and pays itself the reward share in one transaction, then sells
/// the rewards, settling and paying itself again after each sale, until nothing more comes.
/// The buy spends the decay credit to lower the cap and the sell back is trimmed by what the
/// cap fell, so the reward share of that trim is the creator's published budget at work; but
/// every sale of the rewards into the tightened cap is trimmed again, and if those trims
/// earned the reward share too the recipient would take more than the cap's fall allows.
/// Everything it is paid stays within `floor(cap's fall x reward_share_bps / 10,000)`, and
/// the round trip itself returns no more SOL than it cost.
#[test]
fn sos_h002_the_rewards_recipients_wash_trade_earns_no_more_than_the_cap_fall_budget() {
    let mut env = Env::new();
    let (market, recipient) = seeded(&mut env, 1_500, SPARE, 10 * SOL);
    later(&mut env, SECONDS_PER_DAY as i64);
    let before = env.state(&market);
    let (_, sol_before) = balances(&env, &market, &recipient.pubkey());

    let bought = quoted(&env, &market, BUY, SOL);
    env.send(
        &[
            swap_ix(&env, &market, &recipient, BUY, SOL),
            swap_ix(&env, &market, &recipient, SELL, bought),
            settle_ix(&market),
            pay_rewards_ix(&market, &recipient.pubkey(), &recipient.pubkey(), vec![]),
        ],
        &[&recipient],
    )
    .unwrap();
    let (_, sol_after_trip) = balances(&env, &market, &recipient.pubkey());
    let mut rewards = env.state(&market).rewards_paid() as u64;
    assert!(
        rewards > 0,
        "the wash trade's trim was matched by the cap's fall"
    );
    // The round trip alone returns less than it cost.
    assert!(sol_after_trip < sol_before);

    // Sell the rewards, settle and pay again, until nothing more is paid.
    for _ in 0..8 {
        if rewards == 0 {
            break;
        }
        let paid_before = env.state(&market).rewards_paid();
        // A sale too small to pay a lamport is refused, and ends the loop.
        if env
            .swap(&market, &recipient, SELL, TradeMode::ExactIn, rewards)
            .is_err()
        {
            break;
        }
        if env.state(&market).retired_tokens() > 0 {
            env.send(&[settle_ix(&market)], &[]).unwrap();
        }
        if env.state(&market).rewards_owed() > 0 {
            env.send(
                &[pay_rewards_ix(
                    &market,
                    &recipient.pubkey(),
                    &recipient.pubkey(),
                    vec![],
                )],
                &[&recipient],
            )
            .unwrap();
        }
        rewards = (env.state(&market).rewards_paid() - paid_before) as u64;
    }

    let after = env.state(&market);
    let fell = (before.cap() - after.cap()) as u128;
    let budget = fell * before.reward_share_bps() as u128 / 10_000;
    // The cap fell by the buy and the seed's rounding gap, 11 units.
    assert_eq!(fell, bought as u128 + 11);
    // What is left of the fall stays unmatched, and nothing rewardable is left unsettled.
    assert!(after.cap_fall_unmatched() <= 11);
    assert_eq!(after.retired_rewardable(), 0);
    assert!(
        after.rewards_paid() <= budget,
        "the rewards recipient was paid {} reward units, beyond the {budget} the cap's fall of \
         {fell} allows",
        after.rewards_paid()
    );
}

/// SOS H005: right after the seed the cap is tight, and the rewards recipient sells its own
/// tokens deep into it, buys back with what the sale paid and settles, in one transaction.
/// The sale is trimmed, but the cap has not fallen, so none of what it retired earns the
/// reward share: all of it burns and nothing is owed.
#[test]
fn sos_h005_a_dip_trimmed_from_a_tight_cap_pays_no_reward_share() {
    let mut env = Env::new();
    let sold = 300_000_000_000;
    let (market, recipient) = seeded(&mut env, 3_000, sold + SPARE, 0);
    let before = env.state(&market);
    let out = quoted(&env, &market, SELL, sold);
    let (_, logs) = env
        .send_logged(
            &[
                swap_ix(&env, &market, &recipient, SELL, sold),
                swap_ix(&env, &market, &recipient, BUY, spendable(out)),
                settle_ix(&market),
            ],
            &[&recipient],
        )
        .unwrap();
    let after = env.state(&market);
    assert_eq!(after.cap(), before.cap(), "the cap never fell");
    assert!(after.tokens_trimmed() > 0, "the dip was trimmed");
    let [settled] = events::<Settled>(&logs).try_into().unwrap();
    assert!(settled.retired > 0);
    assert_eq!(
        settled.rewardable, 0,
        "the cap's fall matched none of the dip"
    );
    assert_eq!(settled.to_rewards, 0, "a dip trim pays no reward share");
    assert_eq!(
        settled.burned, settled.retired,
        "everything the dip retired burns"
    );
    assert_eq!(after.rewards_owed(), 0);
    assert_refused(
        env.send(
            &[pay_rewards_ix(
                &market,
                &recipient.pubkey(),
                &recipient.pubkey(),
                vec![],
            )],
            &[&recipient],
        ),
        StrategyError::NothingOwed,
    );
    // And the recipient ends with fewer tokens than it had, having spent what it sold for.
    let (tokens, sol) = balances(&env, &market, &recipient.pubkey());
    assert!(tokens < sold + SPARE && sol < out / 100);
}

/// SOS H007 (and the wall half of H056): on the worked example's market with its wall
/// placed and its earlier rewards paid, the rewards recipient sells into the curve and the
/// wall, places the wall itself, taking the tip, and settles, in one transaction. Closing
/// the wall retires the tokens it bought, but none of them earns the reward share: they and
/// the dust burn whole, so nothing is owed, and buying back with everything the sale and
/// the tip paid returns fewer tokens than were sold.
#[test]
fn sos_h007_a_wall_closure_pays_no_reward_share() {
    let mut env = Env::new();
    let sold = 150_000_000_000;
    let (market, recipient) = seeded(&mut env, 1_500, sold, 0);
    // The worked example up to its `place_wall`, by another trader and keeper.
    let trader = env.trader(&market, 300_000_000_000, 100 * SOL);
    later(&mut env, 3_600);
    let bought = env
        .swap(&market, &trader, BUY, TradeMode::ExactIn, SOL)
        .unwrap()
        .received;
    assert_eq!(bought, 90_081_892_629);
    later(&mut env, 60);
    env.swap(&market, &trader, SELL, TradeMode::ExactIn, bought)
        .unwrap();
    let keeper = env.keeper();
    // From the next slot, since none may follow a swap in its own (`POOL4-50`).
    env.next_slot();
    env.place_wall(&market, &keeper).unwrap();
    // Its rewards settled and paid.
    env.send(&[settle_ix(&market)], &[]).unwrap();
    env.send(
        &[pay_rewards_ix(
            &market,
            &recipient.pubkey(),
            &recipient.pubkey(),
            vec![],
        )],
        &[&recipient],
    )
    .unwrap();
    let (tokens_before, sol_before) = balances(&env, &market, &recipient.pubkey());
    assert_eq!(sol_before, 0);

    later(&mut env, 60);
    let walled = env.state(&market);
    let out = quoted(&env, &market, SELL, sold);
    let tips = pda::associated_token(&recipient.pubkey(), &WSOL, &TOKEN);
    // The sell into the wall, then from the next slot (`POOL4-50`) the closing placement and
    // the settle.
    env.send(
        &[swap_ix(&env, &market, &recipient, SELL, sold)],
        &[&recipient],
    )
    .unwrap();
    env.next_slot();
    let (_, logs) = env
        .send_logged(
            &[
                place_wall_ix(&market, &recipient.pubkey(), &tips),
                settle_ix(&market),
            ],
            &[&recipient],
        )
        .unwrap();
    let after = env.state(&market);
    let closed = (after.wall_tokens_bought() - walled.wall_tokens_bought()) as u64;
    assert!(closed > 0, "the closed wall had bought tokens");
    let [settled] = events::<Settled>(&logs).try_into().unwrap();
    assert!(settled.retired >= closed);
    // Only the 4 units of the worked example's cap fall left unmatched were rewardable, from
    // the sale's trim, and their reward share rounds to nothing.
    assert_eq!(walled.cap_fall_unmatched(), 4);
    assert_eq!((settled.rewardable, after.cap_fall_unmatched()), (4, 0));
    assert_eq!(settled.to_rewards, 0, "a wall closure pays no reward share");
    assert_eq!(settled.burned, settled.retired);
    assert_eq!(after.rewards_owed(), 0);
    assert_refused(
        env.send(
            &[pay_rewards_ix(
                &market,
                &recipient.pubkey(),
                &recipient.pubkey(),
                vec![],
            )],
            &[&recipient],
        ),
        StrategyError::NothingOwed,
    );

    // Buying back with the sale's SOL and the tip returns fewer tokens than were sold.
    let (_, sol) = balances(&env, &market, &recipient.pubkey());
    assert!(sol > out, "the recipient took the tip");
    env.swap(&market, &recipient, BUY, TradeMode::ExactIn, spendable(sol))
        .unwrap();
    let (tokens_after, _) = balances(&env, &market, &recipient.pubkey());
    assert!(tokens_after < tokens_before);
}
