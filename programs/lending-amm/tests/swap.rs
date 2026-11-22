//! Swaps through the real router (docs/spec/lending-pool.md, "Pricing" and "Bypass"):
//! exact-in only, the LP fee rounding up and the output down, the whole input joining its
//! side, each quote equal to its swap, and only the router's market signer allowed.

mod common;

use common::*;
use lending_amm::StrategyError;
use pipeline_client::{self as client, AccountMeta, Instruction, Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// The spec's formula, on its own: `a_net = a - ceil(a x fee / 10,000)`,
/// `out = floor(E_o x a_net / (E_i + a_net))`.
fn expected_out(reserve_in: u64, reserve_out: u64, a: u64, fee_bps: u16) -> u64 {
    let fee = (a as u128 * fee_bps as u128).div_ceil(10_000);
    let net = a as u128 - fee;
    (reserve_out as u128 * net / (reserve_in as u128 + net)) as u64
}

/// A WSOL-lent market at `fee_bps` with 20,000 of the other token per SOL, 50 SOL deep,
/// and a trader holding plenty of both.
fn funded(fee_bps: u16) -> (Env, Market, Keypair) {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(fee_bps);
    let (market, _) = env
        .create_funded_market(&spec, [1_000_000_000_000, 50 * SOL])
        .unwrap();
    let trader = env.funded_wallet(&market, [10_000_000_000_000, 10_000 * SOL]);
    (env, market, trader)
}

#[test]
fn exact_in_both_ways_at_lp_fees_of_0_30_and_200_bps() {
    for fee_bps in [0u16, 30, 200] {
        let (mut env, market, trader) = funded(fee_bps);
        // Buy the other token with WSOL, then sell it back, at several sizes.
        for (sides, amount) in [
            ((1, 0), 3 * SOL),
            ((0, 1), 7_000_000_000),
            ((1, 0), 1),
            ((0, 1), 123_456_789_012),
            ((1, 0), 40 * SOL),
        ] {
            let (input, output) = sides;
            let before = env.market_state(&market.market_state).reserves;
            let quote = env.quote(&market, &exact_in(input, output, amount));
            let out = expected_out(before[input], before[output], amount, fee_bps);
            if out == 0 {
                assert_refused(quote, StrategyError::ZeroOutput);
                continue;
            }
            let quote = quote.unwrap();
            assert_eq!(
                (quote.amount_in, quote.amount_out),
                (amount, out),
                "fee {fee_bps}"
            );

            let paid_out = env.wallet_token_account(&market, &trader.pubkey(), output);
            let held = env.balance(&paid_out);
            let vault_in = env.balance(&market.vaults[input]);
            let result = env.swap(&market, &trader, sides, amount).unwrap();
            assert_eq!(result.received, out, "the swap delivers its quote");
            assert_eq!(
                env.balance(&paid_out),
                held + env.kept(&market, output, out),
                "the trader keeps the quote, less Pipeline's fee when it is taken in the output"
            );
            // The whole input joins its side and stays in the input vault.
            assert_eq!(env.balance(&market.vaults[input]), vault_in + amount);
            let after = env.market_state(&market.market_state).reserves;
            assert_eq!(after[input], before[input] + amount);
            assert_eq!(after[output], before[output] - out);
            // The product of the reserves never falls.
            assert!(after[0] as u128 * after[1] as u128 >= before[0] as u128 * before[1] as u128);
        }
    }
}

#[test]
fn the_lp_fee_rounds_up() {
    // 1 unit in at 30 bps pays a whole unit of fee, so it buys nothing.
    let (env, market, _) = funded(30);
    assert_refused(
        env.quote(&market, &exact_in(0, 1, 1)),
        StrategyError::ZeroOutput,
    );
    // 334 units at 30 bps: the fee is ceil(1.002) = 2, not 1.
    let reserves = env.market_state(&market.market_state).reserves;
    let quote = env.quote(&market, &exact_in(1, 0, 334)).unwrap();
    assert_eq!(
        quote.amount_out,
        expected_out(reserves[1], reserves[0], 334, 30)
    );
    assert_eq!(
        quote.amount_out,
        (reserves[0] as u128 * 332 / (reserves[1] as u128 + 332)) as u64
    );
}

#[test]
fn a_huge_sell_never_empties_a_side() {
    let (env, market, _) = funded(0);
    let reserves = env.market_state(&market.market_state).reserves;
    for sides in [(0, 1), (1, 0)] {
        let quote = env
            .quote(&market, &exact_in(sides.0, sides.1, u64::MAX / 2))
            .unwrap();
        assert!(quote.amount_out < reserves[sides.1]);
    }
}

#[test]
fn quotes_and_swaps_are_refused_before_the_first_deposit() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let market = env.create_market(&spec).unwrap();
    assert_refused(
        env.quote(&market, &exact_in(1, 0, SOL)),
        StrategyError::MarketNotOpen,
    );
    let trader = env.funded_wallet(&market, [SOL, SOL]);
    assert_refused(
        env.swap(&market, &trader, (1, 0), SOL),
        StrategyError::MarketNotOpen,
    );
}

#[test]
fn exact_out_is_refused_in_quotes_and_swaps() {
    let (mut env, market, trader) = funded(30);
    let trade = TradeRequestExt::exact_out(1, 0, 1_000);
    assert_refused(
        env.quote(&market, &trade),
        StrategyError::ExactOutNotSupported,
    );
    let swap = env
        .swap_instruction(
            &market,
            &trader.pubkey(),
            (1, 0),
            1_000,
            TradeMode::ExactOut,
        )
        .unwrap();
    // The router itself refuses exact-out on a market that reported no support for it;
    // either way, the market's reserves never move.
    let before = env.market_state(&market.market_state).reserves;
    assert!(env.send(&[swap], &[&trader]).is_err());
    assert_eq!(env.market_state(&market.market_state).reserves, before);
}

/// An exact-out trade request.
struct TradeRequestExt;
impl TradeRequestExt {
    fn exact_out(input: usize, output: usize, amount: u64) -> TradeRequest {
        TradeRequest {
            mode: TradeMode::ExactOut,
            ..exact_in(input, output, amount)
        }
    }
}

#[test]
fn a_swap_with_zero_output_is_refused() {
    let (mut env, market, trader) = funded(30);
    let before = env.market_state(&market.market_state).reserves;
    assert_refused(
        env.swap(&market, &trader, (0, 1), 1),
        StrategyError::ZeroOutput,
    );
    assert_eq!(env.market_state(&market.market_state).reserves, before);
}

#[test]
fn input_is_credited_with_credited_input_so_donations_are_never_counted() {
    // Tokens sent to the input vault before a swap, even in the same transaction, are a
    // donation: the swap credits only what the router sent.
    let (mut env, market, trader) = funded(30);
    env.donate(&market, 1, &market.vaults[1], 25 * SOL);
    let before = env.market_state(&market.market_state).reserves;
    let quote = env.quote(&market, &exact_in(1, 0, SOL)).unwrap();
    // A donation in the same transaction as the swap, from the trader's own account.
    let from = env.wallet_token_account(&market, &trader.pubkey(), 1);
    let mut data = vec![12u8];
    data.extend_from_slice(&(5 * SOL).to_le_bytes());
    data.push(9);
    let donation = Instruction::new_with_bytes(
        TOKEN,
        &data,
        vec![
            AccountMeta::new(from, false),
            AccountMeta::new_readonly(market.mints[1], false),
            AccountMeta::new(market.vaults[1], false),
            AccountMeta::new_readonly(trader.pubkey(), true),
        ],
    );
    let swap = env
        .swap_instruction(&market, &trader.pubkey(), (1, 0), SOL, TradeMode::ExactIn)
        .unwrap();
    let meta = env.send_meta(&[donation, swap], &[&trader]).unwrap();
    let result: client::SwapResult = borsh::from_slice(&meta.return_data.data).unwrap();
    assert_eq!(result.received, quote.amount_out);
    let after = env.market_state(&market.market_state).reserves;
    assert_eq!(after[1], before[1] + SOL);
    assert_eq!(after[0], before[0] - quote.amount_out);
}

#[test]
fn bypass_is_refused() {
    // pipeline_swap called directly, not through the router: with an impostor signing as
    // the market signer, and with the router's PDA unsigned.
    let (mut env, market, trader) = funded(30);
    let trade = exact_in(1, 0, SOL);
    let request = client::interface::SwapRequest {
        trade: trade.clone(),
        amount_sent: SOL,
        min_amount_out: 0,
    };
    let trader_input = env.wallet_token_account(&market, &trader.pubkey(), 1);
    let trader_output = env.wallet_token_account(&market, &trader.pubkey(), 0);
    let call = |signer: Pubkey, signs: bool| {
        let mut accounts = vec![
            AccountMeta::new_readonly(signer, signs),
            AccountMeta::new(market.market_state, false),
            AccountMeta::new_readonly(trader.pubkey(), false),
            AccountMeta::new(trader_input, false),
            AccountMeta::new(trader_output, false),
            AccountMeta::new(market.vaults[1], false),
            AccountMeta::new_readonly(market.mints[1], false),
            AccountMeta::new_readonly(market.mints[0], false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(TOKEN, false),
        ];
        accounts.push(AccountMeta::new(market.vaults[0], false));
        accounts.push(AccountMeta::new_readonly(market.addresses.authority, false));
        strategy_call(client::interface::discriminator::SWAP, &request, accounts)
    };
    // The trader first moves their input into the vault themselves, as a bypass would.
    env.donate(&market, 1, &market.vaults[1], SOL);
    let before = env.market_state(&market.market_state).reserves;
    let impostor = Keypair::new();
    assert_refused(
        env.send(&[call(impostor.pubkey(), true)], &[&impostor]),
        StrategyError::NotPipeline,
    );
    assert_refused(
        env.send(&[call(trader.pubkey(), true)], &[&trader]),
        StrategyError::NotPipeline,
    );
    assert_anchor_error(env.send(&[call(market.market, false)], &[]), 3010);
    assert_eq!(env.market_state(&market.market_state).reserves, before);
}

#[test]
fn a_swap_with_another_markets_output_vault_is_refused() {
    let (mut env, market, trader) = funded(30);
    let spec = env.wsol_market_spec(31);
    let (other, _) = env.create_funded_market(&spec, [SOL, SOL]).unwrap();
    let mut swap = env
        .swap_instruction(&market, &trader.pubkey(), (1, 0), SOL, TradeMode::ExactIn)
        .unwrap();
    let vault = swap
        .accounts
        .iter_mut()
        .rev()
        .find(|a| a.pubkey == market.vaults[0])
        .unwrap();
    vault.pubkey = other.vaults[0];
    assert_refused(env.send(&[swap], &[&trader]), StrategyError::WrongAccount);
}

#[test]
fn a_market_whose_other_side_is_a_hooked_token_trades_both_ways() {
    let mut env = Env::new();
    let (hooked, _) = env.create_hooked_mint();
    let spec = MarketSpec {
        mints: [(hooked, TOKEN_2022), (wsol(), TOKEN)],
        params: lending_amm::InitParams {
            lent_index: 1,
            lp_fee_bps: 30,
        },
    };
    let (market, _) = env
        .create_funded_market(&spec, [500_000_000_000, 20 * SOL])
        .unwrap();
    assert_eq!(
        market.hook_accounts[0].len(),
        2,
        "the hook's accounts are forwarded"
    );
    let trader = env.funded_wallet(&market, [100_000_000_000, 100 * SOL]);
    for (sides, amount) in [((1, 0), 2 * SOL), ((0, 1), 30_000_000_000)] {
        let quote = env
            .quote(&market, &exact_in(sides.0, sides.1, amount))
            .unwrap();
        let result = env.swap(&market, &trader, sides, amount).unwrap();
        assert_eq!(result.received, quote.amount_out);
    }
    // Without the hook's accounts, paying the hooked token out fails.
    let mut bare = market.clone();
    bare.hook_accounts = [vec![], vec![]];
    assert!(env.swap(&bare, &trader, (1, 0), SOL).is_err());
}
