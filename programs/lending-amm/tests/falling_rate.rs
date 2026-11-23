//! Kamino's losses fall on LPs: when Kamino's lending market owner writes off bad debt with
//! `socialize_loss`, the reserve's total supply falls, and with it the market's lent value `V`,
//! its price and every LP share, pro rata; there is no insurance fund
//! (docs/spec/lending-pool.md, "Kamino's losses fall on LPs").
//!
//! The write-off is klend's real `socialize_loss`, run on its deployed bytes against an edited
//! obligation that has debt and no collateral, as a liquidation that left bad debt would leave it.

mod common;

use common::rebalance::{lent_spec, units, OTHER};
use common::remove::Payout;
use common::states::Loss;
use common::*;
use lending_amm::config::LENT_MINTS;
use lending_amm::StrategyError;
use solana_signer::Signer;

/// What `lp`'s shares are worth of each side, `R x lp / N` and `L x lp / N`, rounded down.
fn claim(env: &Env, market: &Market, shares: u64) -> (u128, u128) {
    let state = env.market_state(&market.market_state);
    let count = env.share_count(market) as u128;
    let other = state.reserves[market.other_index()] as u128 * shares as u128 / count;
    let lent = env.lent_total(market) as u128 * shares as u128 / count;
    (other, lent)
}

#[test]
fn a_write_off_lowers_the_lent_value_the_price_and_every_lp_share_pro_rata() {
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        env.load_klend();
        let spec = lent_spec(&mut env, lent, 30);
        let (market, first) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        env.rebalance(&market, None).unwrap();
        let second = env.funded_wallet(&market, [OTHER, units(lent, 50)]);
        env.add_liquidity(&market, &second, [OTHER / 2, units(lent, 25)], 0)
            .unwrap();
        let lps = [&first, &second].map(|lp| env.lp_shares_of(&market, &lp.pubkey()));

        let (other, lent_side) = (market.other_index(), market.lent_index);
        let state = env.market_state(&market.market_state);
        let reserve = env.program_reserve(&market);
        let supply = reserve.total_supply_sf().unwrap();
        let value = reserve.lent_value(state.ctokens).unwrap();
        let count = env.share_count(&market);
        let sell = exact_in(other, lent_side, OTHER / 1_000);
        let buy = exact_in(lent_side, other, units(lent, 1) / 10);
        let (sell_out, buy_out) = (
            env.quote(&market, &sell).unwrap().amount_out,
            env.quote(&market, &buy).unwrap().amount_out,
        );
        let claims = lps.map(|shares| claim(&env, &market, shares));

        // Half of the reserve's free liquidity was lent to a borrower who left only bad debt.
        let loss = env.free_liquidity(&market) / 2;
        env.write_off(&market, Loss::Part(loss));

        let after = env.market_state(&market.market_state);
        let reserve_after = env.program_reserve(&market);
        let supply_after = reserve_after.total_supply_sf().unwrap();
        let value_after = reserve_after.lent_value(after.ctokens).unwrap();
        println!(
            "lent {lent}: wrote off {loss}: total supply {} -> {}, V {value} -> {value_after}",
            supply >> 60,
            supply_after >> 60
        );
        // klend lowered the reserve's total supply by the write-off (less the interest its refresh
        // accrued first), and its cToken supply did not move: the rate fell.
        assert_eq!(reserve_after.mint_total_supply, reserve.mint_total_supply);
        assert!(supply_after < supply);
        assert!((supply - supply_after) >> 60 <= loss as u128);
        // V fell with the rate, pro rata, to the unit: V' x S = V x S', within one unit of V'.
        // Both are rounded down from the reserve's true value, V' from the true value after the
        // write-off, not from V, so V' can sit up to S'/S (under one unit) above V x S' / S as
        // well as below it (seen on mainnet's USDC reserve as dumped in slot 472,946,807).
        assert!(value_after < value);
        let (scaled_after, scaled) = (
            value_after as u128 * (supply >> 30),
            value as u128 * (supply_after >> 30),
        );
        assert!(scaled_after.abs_diff(scaled) <= supply >> 30);
        // Nothing the market recorded moved, and no share was minted or burned.
        assert_eq!(after.reserves, state.reserves);
        assert_eq!(after.ctokens, state.ctokens);
        assert_eq!(env.share_count(&market), count);

        // The price fell: a sell of the other mint fetches less of the lent mint, a buy with the
        // lent mint fetches more of the other.
        let (sell_after, buy_after) = (
            env.quote(&market, &sell).unwrap().amount_out,
            env.quote(&market, &buy).unwrap().amount_out,
        );
        assert!(sell_after < sell_out && buy_after > buy_out);

        // Every LP share lost the same part of the lent side, `(V - V') x lp / N`, and none of
        // the other side.
        let lost = (value - value_after) as u128;
        for (i, shares) in lps.iter().enumerate() {
            let (other_claim, lent_claim) = claim(&env, &market, *shares);
            assert_eq!(other_claim, claims[i].0);
            let expected = lost * *shares as u128 / count as u128;
            let fell = claims[i].1 - lent_claim;
            assert!(
                fell.abs_diff(expected) <= 1,
                "lp {i}: fell {fell}, expected {expected}"
            );
        }

        // Quotes still equal swaps, within the buffer and beyond it, where the swap redeems from
        // Kamino at the lower rate.
        for out in [
            env.buffer(&market) / 2,
            env.buffer(&market) + units(lent, 1),
        ] {
            let amount = env.sell_paying(&market, out);
            let quote = env
                .quote(&market, &exact_in(other, lent_side, amount))
                .unwrap();
            let trader = env.funded_wallet(&market, [2 * amount, 0]);
            let swapped = env
                .swap(&market, &trader, (other, lent_side), amount)
                .unwrap();
            assert_eq!(swapped.received, quote.amount_out);
        }
    }
}

#[test]
fn a_write_off_of_the_reserves_whole_supply_deprecates_it_and_the_market_trades_from_its_buffer_alone(
) {
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        env.load_klend();
        let spec = lent_spec(&mut env, lent, 30);
        let (market, lp) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        env.rebalance(&market, None).unwrap();
        let (other, lent_side) = (market.other_index(), market.lent_index);
        // Sized before the write-off, on the market as it was.
        let within = env.sell_paying(&market, env.buffer(&market) / 2);

        let meta = env.write_off(&market, Loss::Everything);
        assert!(
            meta.logs
                .iter()
                .any(|line| line.contains("Reserve becomes deprecated")),
            "{:#?}",
            meta.logs
        );
        let reserve = env.program_reserve(&market);
        assert!(reserve.deprecated());
        let value = reserve
            .lent_value(env.market_state(&market.market_state).ctokens)
            .unwrap();
        println!("lent {lent}: deprecated, the market's cTokens now worth {value}");

        // Buffer only, for good: a sale the buffer covers trades. With the cTokens worth nothing
        // the lent side is the buffer alone, so even a sale of ten times the other side's reserve
        // pays out less than the buffer, and no swap calls klend.
        let trader = env.funded_wallet(&market, [20 * OTHER, 0]);
        for amount in [within, 10 * OTHER] {
            let quote = env
                .quote(&market, &exact_in(other, lent_side, amount))
                .unwrap();
            assert!(quote.amount_out < env.buffer(&market));
            let paid_into = env.wallet_token_account(&market, &trader.pubkey(), lent_side);
            let before = env.balance_or_zero(&paid_into);
            let meta = env
                .swap_meta(&market, &trader, (other, lent_side), amount)
                .unwrap();
            assert_eq!(
                env.balance(&paid_into) - before,
                env.kept(&market, lent_side, quote.amount_out)
            );
            assert!(!meta.logs.iter().any(
                |line| line.starts_with(&format!("Program {} invoke", common::kamino::klend()))
            ));
        }
        // `rebalance` and adding refuse; removal is in kind only.
        assert_refused(env.rebalance(&market, None), StrategyError::KaminoStopped);
        let adder = env.funded_wallet(&market, [OTHER, units(lent, 50)]);
        assert_refused(
            env.add_liquidity(&market, &adder, [OTHER / 10, units(lent, 5)], 0),
            StrategyError::ReserveDeprecated,
        );
        let shares = env.lp_shares_of(&market, &lp.pubkey()) / 2;
        assert_refused(
            env.remove_liquidity(&market, &lp, shares, [0, 0], Payout::Cash),
            StrategyError::KaminoCannotPay,
        );
        env.remove_liquidity(&market, &lp, shares, [0, 0], Payout::InKind)
            .unwrap();
    }
}
