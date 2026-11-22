//! The in-swap redeem (docs/spec/lending-pool.md, "Redeeming the shortfall" and "Accounts"):
//! a swap that must pay out more of the lent side than the buffer holds redeems just the
//! shortfall from Kamino inside the same swap, through klend's real `redeem_reserve_collateral`,
//! sent through the router copied from devnet, on the Kamino accounts dumped from the cluster
//! this build lends on.

mod common;

use common::rebalance::units;
use common::redeem::ctokens_for_shortfall;
use common::*;
use lending_amm::events::ShortfallRedeemed;
use lending_amm::StrategyError;
use pipeline_client::{Pubkey, TradeMode};
use solana_signer::Signer;

#[test]
fn a_sell_beyond_the_buffer_redeems_its_shortfall_inside_the_swap() {
    for lent in 0..2 {
        for lp_fee_bps in [0u16, 30, 200] {
            let mut env = Env::new();
            let market = env.lending_market(lent, lp_fee_bps);
            let (other, lent_side) = (market.other_index(), market.lent_index);
            let buffer = env.buffer(&market);
            let amount = env.sell_paying(&market, buffer + buffer / 2);
            let quote = env
                .quote(&market, &exact_in(other, lent_side, amount))
                .unwrap();
            assert!(quote.amount_out > buffer);
            let shortfall = quote.amount_out - buffer;

            let reserve = env.program_reserve(&market);
            let burned = ctokens_for_shortfall(&reserve, shortfall);
            let before = env.market_state(&market.market_state);
            let ctokens_before = env.balance(&market.addresses.ctoken_account);
            let trader = env.funded_wallet(&market, [2 * amount, 0]);
            let paid_into = env.wallet_token_account(&market, &trader.pubkey(), lent_side);
            let meta = env
                .swap_meta(&market, &trader, (other, lent_side), amount)
                .unwrap();

            // The quote arrives, and the trader keeps it less Pipeline's fee when that is taken
            // in the output (a sale into wrapped SOL, since Pipeline 0.3).
            assert_eq!(
                env.balance(&paid_into),
                env.kept(&market, lent_side, quote.amount_out)
            );
            // The redeem event carries the shortfall and what klend's real redeem paid.
            let redeemed = events::<ShortfallRedeemed>(&meta.logs);
            assert_eq!(redeemed.len(), 1, "one redeem");
            let event = &redeemed[0];
            assert_eq!(event.shortfall, shortfall);
            assert_eq!(event.ctokens, burned);
            assert!(
                event.liquidity >= shortfall,
                "the market receives at least the shortfall"
            );

            // The market's cTokens fall by the amount burned, in its account and its record;
            // anything klend paid above the shortfall stays in the buffer.
            let after = env.market_state(&market.market_state);
            assert_eq!(
                env.balance(&market.addresses.ctoken_account),
                ctokens_before - burned
            );
            assert_eq!(after.ctokens, before.ctokens - burned);
            assert_eq!(after.reserves[lent_side], event.liquidity - shortfall);
            assert_eq!(event.buffer, after.reserves[lent_side]);
            assert_eq!(event.ctokens_held, after.ctokens);
            assert_eq!(after.redeemed, before.redeemed + event.liquidity as u128);
            assert_eq!(event.redeemed, after.redeemed);
            assert_eq!(after.deposited, before.deposited);
            assert_eq!(
                env.balance(&market.vaults[lent_side]),
                after.reserves[lent_side]
            );
            println!(
                "lent {lent}, fee {lp_fee_bps}: buffer {buffer}, out {}, shortfall {shortfall}, \
                 burned {burned}, received {}",
                quote.amount_out, event.liquidity
            );
        }
    }
}

/// The strategy accounts as `(address, writable)`.
fn flags(accounts: &[pipeline_client::AccountMeta]) -> Vec<(Pubkey, bool)> {
    accounts.iter().map(|a| (a.pubkey, a.is_writable)).collect()
}

#[test]
fn a_swap_the_buffer_covers_never_redeems_and_passes_the_reserve_read_only() {
    for lent in 0..2 {
        let mut env = Env::new();
        let market = env.lending_market(lent, 30);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let reserve = env.reserve_of(&market);
        let buffer = env.buffer(&market);

        // Up to the buffer's edge: the reserve read-only and no redeem accounts. Paying out the
        // other side resolves in one round; the lent side in two, the second reading the reserve.
        let within = env.largest_sell_within(&market, buffer);
        for (trade, rounds) in [
            (exact_in(lent_side, other, units(lent, 3)), 1),
            (exact_in(other, lent_side, within), 2),
        ] {
            let (accounts, metas) = env.resolve_rounds(&market, &trade).unwrap();
            assert_eq!(metas.len(), rounds);
            let output = trade.output_index as usize;
            assert_eq!(
                flags(&accounts),
                vec![
                    (market.vaults[output], true),
                    (market.addresses.authority, false),
                    (reserve, false),
                ]
            );
        }

        // A sell the buffer covers to the unit pays out of the buffer alone.
        let quote = env
            .quote(&market, &exact_in(other, lent_side, within))
            .unwrap();
        assert!(quote.amount_out <= buffer && buffer - quote.amount_out < units(lent, 1) / 1000);
        let before = env.market_state(&market.market_state);
        let ctokens_before = env.balance(&market.addresses.ctoken_account);
        let trader = env.funded_wallet(&market, [2 * within, 0]);
        let meta = env
            .swap_meta(&market, &trader, (other, lent_side), within)
            .unwrap();
        assert!(events::<ShortfallRedeemed>(&meta.logs).is_empty());
        let after = env.market_state(&market.market_state);
        assert_eq!(after.ctokens, before.ctokens);
        assert_eq!(
            (after.deposited, after.redeemed),
            (before.deposited, before.redeemed)
        );
        assert_eq!(
            env.balance(&market.addresses.ctoken_account),
            ctokens_before
        );
        assert_eq!(after.reserves[lent_side], buffer - quote.amount_out);
        // The swap's transaction write-locked no Kamino account.
        let swap = env
            .swap_instruction(
                &market,
                &trader.pubkey(),
                (lent_side, other),
                units(lent, 1),
                TradeMode::ExactIn,
            )
            .unwrap();
        assert!(swap
            .accounts
            .iter()
            .all(|a| a.pubkey != reserve || !a.is_writable));
    }
}

#[test]
fn only_a_redeeming_swap_asks_for_the_reserve_writable_with_the_redeem_accounts() {
    for lent in 0..2 {
        let mut env = Env::new();
        let market = env.lending_market(lent, 30);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let buffer = env.buffer(&market);
        let amount = env.sell_paying(&market, buffer + 1);
        let (accounts, metas) = env
            .resolve_rounds(&market, &exact_in(other, lent_side, amount))
            .unwrap();
        assert_eq!(metas.len(), 2);
        let k = &env.kamino;
        let name = common::kamino::lent_name(lent);
        assert_eq!(
            flags(&accounts),
            vec![
                (market.vaults[lent_side], true),
                (market.addresses.authority, false),
                (env.reserve_of(&market), true),
                (common::kamino::klend(), false),
                (k.address("lending-market"), false),
                (k.address("lending-market-authority"), false),
                (k.address(&format!("liquidity-supply-{name}")), true),
                (k.address(&format!("collateral-mint-{name}")), true),
                (market.addresses.ctoken_account, true),
                (TOKEN, false),
                (common::kamino::instructions_sysvar(), false),
            ]
        );
    }
}

#[test]
fn a_swap_built_before_the_buffer_shrank_fails_with_its_own_error_until_resolved_again() {
    for lent in 0..2 {
        let mut env = Env::new();
        let market = env.lending_market(lent, 30);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let buffer = env.buffer(&market);

        // A trader resolves a sell that 90% of the buffer covers.
        let amount = env.largest_sell_within(&market, buffer / 10 * 9);
        let resolved = env
            .resolve_accounts(&market, &exact_in(other, lent_side, amount))
            .unwrap();
        assert_eq!(resolved.len(), 3);

        // Another sell then drains half the buffer, so the first now needs a redeem.
        let first = env.funded_wallet(&market, [10 * amount, 0]);
        let second = env.funded_wallet(&market, [10 * amount, 0]);
        let drain = env.largest_sell_within(&market, buffer / 2);
        env.swap(&market, &second, (other, lent_side), drain)
            .unwrap();
        assert!(
            env.quote(&market, &exact_in(other, lent_side, amount))
                .unwrap()
                .amount_out
                > env.buffer(&market)
        );

        // Sent with the accounts resolved before, it fails cleanly and changes nothing.
        let state = env.market_state(&market.market_state);
        let balances = |env: &Env| {
            [
                env.balance(&market.vaults[0]),
                env.balance(&market.vaults[1]),
                env.balance(&market.addresses.ctoken_account),
                env.balance_or_zero(&env.wallet_token_account(&market, &first.pubkey(), other)),
                env.balance_or_zero(&env.wallet_token_account(&market, &first.pubkey(), lent_side)),
            ]
        };
        let held = balances(&env);
        let reserve_data = env.data(&env.reserve_of(&market));
        let stale = env.swap_instruction_with(
            &market,
            &first.pubkey(),
            (other, lent_side),
            amount,
            TradeMode::ExactIn,
            resolved,
        );
        assert_refused(
            env.send(&[stale], &[&first]),
            StrategyError::RedeemAccountsMissing,
        );
        assert_eq!(env.market_state(&market.market_state), state);
        assert_eq!(balances(&env), held);
        assert_eq!(env.data(&env.reserve_of(&market)), reserve_data);

        // Resolved again, the same sell succeeds and redeems.
        let quote = env
            .quote(&market, &exact_in(other, lent_side, amount))
            .unwrap();
        let meta = env
            .swap_meta(&market, &first, (other, lent_side), amount)
            .unwrap();
        assert_eq!(events::<ShortfallRedeemed>(&meta.logs).len(), 1);
        assert_eq!(
            balances(&env)[4],
            held[4] + env.kept(&market, lent_side, quote.amount_out)
        );
    }
}

#[test]
fn a_trade_needing_more_than_the_buffer_plus_what_kamino_can_pay_is_refused_by_quote_and_swap() {
    use lending_amm::kamino::{offsets::WITHDRAWAL_CAP, with_rate_headroom};
    for lent in 0..2 {
        let mut env = Env::new();
        let market = env.lending_market(lent, 30);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let buffer = env.buffer(&market);

        // Kamino's withdrawal cap allows one more whole unit this hour, so the swap may plan to
        // redeem that less the rate headroom.
        let cap = units(lent, 1);
        let reserve = env.reserve_of(&market);
        let now = env.clock().unix_timestamp as u64;
        let mut fields = (cap as i64).to_le_bytes().to_vec();
        fields.extend(0i64.to_le_bytes());
        fields.extend(now.to_le_bytes());
        fields.extend(3_600u64.to_le_bytes());
        env.patch(&reserve, WITHDRAWAL_CAP, &fields);
        let can_pay = with_rate_headroom(cap);

        // One unit of input past the largest sell Kamino can pay for is refused by the quote and
        // by the swap alike, and changes nothing.
        let largest = env.largest_sell_within(&market, buffer + can_pay);
        let beyond = exact_in(other, lent_side, largest + 1);
        assert_refused(env.quote(&market, &beyond), StrategyError::BeyondBuffer);
        let trader = env.funded_wallet(&market, [10 * largest, 0]);
        let state = env.market_state(&market.market_state);
        assert_refused(
            env.swap(&market, &trader, (other, lent_side), largest + 1),
            StrategyError::BeyondBuffer,
        );
        assert_eq!(env.market_state(&market.market_state), state);

        // The largest one quotes and swaps, and klend's real redeem accepts it under its cap.
        let quote = env
            .quote(&market, &exact_in(other, lent_side, largest))
            .unwrap();
        assert!(quote.amount_out > buffer && quote.amount_out - buffer <= can_pay);
        let meta = env
            .swap_meta(&market, &trader, (other, lent_side), largest)
            .unwrap();
        let event = &events::<ShortfallRedeemed>(&meta.logs)[0];
        assert_eq!(event.shortfall, quote.amount_out - buffer);
    }
}

#[test]
fn substituted_redeem_accounts_are_refused_and_a_redeem_pays_only_the_markets_own_vault() {
    for lent in 0..2 {
        let mut env = Env::new();
        let market = env.lending_market(lent, 30);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let buffer = env.buffer(&market);
        let amount = env.sell_paying(&market, buffer + buffer / 2);
        let trade = exact_in(other, lent_side, amount);
        let resolved = env.resolve_accounts(&market, &trade).unwrap();
        assert_eq!(resolved.len(), 11);
        let trader = env.funded_wallet(&market, [10 * amount, 0]);
        let attacker = solana_keypair::Keypair::new();

        // Real accounts of the wrong kind: the other lent mint's reserve accounts, an attacker's
        // token accounts, the other token program and another sysvar.
        let k = env.kamino.clone();
        let wrong = common::kamino::lent_name(1 - lent);
        let collateral = k.address(&format!(
            "collateral-mint-{}",
            common::kamino::lent_name(lent)
        ));
        let attacker_ctokens = env.spl_account(&attacker.pubkey(), &collateral, 1_000);
        let attacker_lent = env.spl_account(&attacker.pubkey(), &market.mints[lent_side], 0);
        let clock_sysvar: Pubkey = "SysvarC1ock11111111111111111111111111111111"
            .parse()
            .unwrap();
        let substitutes = [
            (0, attacker_lent, StrategyError::WrongAccount),
            (
                2,
                k.address(&format!("reserve-{wrong}")),
                StrategyError::ReserveWrongAddress,
            ),
            (
                3,
                Pubkey::new_unique(),
                StrategyError::RedeemAccountsMissing,
            ),
            (
                4,
                k.address(&format!("reserve-{wrong}")),
                StrategyError::LendingMarketWrongAccount,
            ),
            (5, Pubkey::new_unique(), StrategyError::KaminoAccountWrong),
            (
                6,
                k.address(&format!("liquidity-supply-{wrong}")),
                StrategyError::KaminoAccountWrong,
            ),
            (
                7,
                k.address(&format!("collateral-mint-{wrong}")),
                StrategyError::KaminoAccountWrong,
            ),
            (8, attacker_ctokens, StrategyError::KaminoAccountWrong),
            (9, TOKEN_2022, StrategyError::KaminoAccountWrong),
            (10, clock_sysvar, StrategyError::KaminoAccountWrong),
        ];
        let state = env.market_state(&market.market_state);
        for (position, substitute, error) in substitutes {
            let mut accounts = resolved.clone();
            accounts[position].pubkey = substitute;
            // The output vault is not read by a quote; every other substitution refuses it.
            if position != 0 {
                assert_refused(env.quote_with(&market, &trade, &accounts), error);
            }
            let swap = env.swap_instruction_with(
                &market,
                &trader.pubkey(),
                (other, lent_side),
                amount,
                TradeMode::ExactIn,
                accounts,
            );
            assert_refused(env.send(&[swap], &[&trader]), error);
            assert_eq!(
                env.market_state(&market.market_state),
                state,
                "position {position}"
            );
            assert_eq!(env.balance(&attacker_lent), 0);
        }

        // The same swap with the accounts it resolved pays the trader from the market's vault.
        env.swap(&market, &trader, (other, lent_side), amount)
            .unwrap();
        assert_eq!(env.balance(&attacker_lent), 0);
    }
}

#[test]
fn what_klend_pays_above_the_shortfall_stays_in_the_buffer() {
    use lending_amm::kamino::offsets;
    // A day after the market lent, klend's redeem refreshes the reserve to a higher rate than
    // the stored one the swap planned at, so the cTokens burned for the shortfall fetch more.
    // Each reserve is given borrowers first, as many as its available liquidity, by editing its
    // cloned `borrowed_amount_sf`, so it accrues interest at half utilisation.
    let rate = |r: &lending_amm::kamino::Reserve| {
        r.total_supply_sf().unwrap() as f64 / r.mint_total_supply as f64
    };
    for lent in 0..2 {
        let mut env = Env::new();
        let reserve = ck(&lending_amm::config::LENT_MINTS[lent].reserve);
        let data = env.data(&reserve);
        let available = u64::from_le_bytes(
            data[offsets::TOTAL_AVAILABLE_AMOUNT..][..8]
                .try_into()
                .unwrap(),
        );
        env.patch(
            &reserve,
            offsets::BORROWED_AMOUNT_SF,
            &((available as u128) << 60).to_le_bytes(),
        );
        let market = env.lending_market(lent, 30);
        env.advance_clock(216_000, 86_400);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let buffer = env.buffer(&market);
        let amount = env.sell_paying(&market, 2 * buffer);
        let quote = env
            .quote(&market, &exact_in(other, lent_side, amount))
            .unwrap();
        let stored = env.program_reserve(&market);
        let trader = env.funded_wallet(&market, [2 * amount, 0]);
        let meta = env
            .swap_meta(&market, &trader, (other, lent_side), amount)
            .unwrap();
        let event = &events::<ShortfallRedeemed>(&meta.logs)[0];
        let shortfall = quote.amount_out - buffer;
        assert_eq!(event.shortfall, shortfall);
        assert!(event.liquidity >= shortfall);
        let excess = event.liquidity - shortfall;
        let after = env.market_state(&market.market_state);
        assert_eq!(after.reserves[lent_side], excess);
        assert_eq!(env.balance(&market.vaults[lent_side]), excess);
        let refreshed = env.program_reserve(&market);
        println!(
            "lent {lent}: shortfall {shortfall}, received {}, rate {} -> {}",
            event.liquidity,
            rate(&stored),
            rate(&refreshed)
        );
        assert!(rate(&refreshed) > rate(&stored));
        assert!(excess > 0, "a higher rate pays more than the shortfall");
    }
}

#[test]
fn a_round_not_passed_the_reserve_asks_for_another_rather_than_answering_without_a_redeem() {
    // A client that sends a later round with something else third, such as leftovers from
    // another trade, is asked for another round, never told the sale needs no redeem.
    use pipeline_client::AccountMeta;
    let mut env = Env::new();
    let market = env.lending_market(0, 30);
    let (other, lent_side) = (market.other_index(), market.lent_index);
    let buffer = env.buffer(&market);
    let trade = exact_in(other, lent_side, env.sell_paying(&market, 2 * buffer));
    let known = vec![
        AccountMeta::new(market.vaults[lent_side], false),
        AccountMeta::new_readonly(market.addresses.authority, false),
        AccountMeta::new_readonly(market.addresses.ctoken_account, false),
    ];
    let meta = env.resolve_round_meta(&market, &trade, 1, &known).unwrap();
    let result: ResolveResult = borsh::from_slice(&meta.return_data.data).unwrap();
    assert!(!result.complete);
    assert_eq!(result.accounts.len(), 3);
    assert_eq!(
        Pubkey::new_from_array(result.accounts[2].address),
        env.reserve_of(&market)
    );
    // Given the reserve, the next round lists the redeem accounts.
    let (accounts, _) = env.resolve_rounds(&market, &trade).unwrap();
    assert_eq!(accounts.len(), 11);
}
