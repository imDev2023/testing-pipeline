//! Call depth (docs/spec/README.md, "Test layers", layer 5): the deepest swap a trader can send
//! is a smart wallet calling the router, and an in-swap redeem then runs Kamino's redeem and
//! its token transfer at Solana's last call level (docs/spec/lending-pool.md, "Redeeming the
//! shortfall"):
//!
//! | Stack height | Program |
//! | --- | --- |
//! | 1 | the smart wallet (the stand-in in `programs/test-programs/stand-in-smart-wallet`) |
//! | 2 | Pipeline's router |
//! | 3 | the lending AMM, and Token-2022 for the hooked input |
//! | 4 | klend's redeem, and the input's transfer hook |
//! | 5 | SPL Token, burning the cTokens and paying the lent mint |
//!
//! It runs with SIMD-0268's deeper limit switched off, as on devnet and mainnet, where a
//! transaction may nest five levels.

mod common;

use common::smart_wallet::through_smart_wallet;
use common::*;
use lending_amm::events::ShortfallRedeemed;
use litesvm::LiteSVM;
use pipeline_client::{Pubkey, TradeMode};
use solana_signer::Signer;

/// SIMD-0268, "Raise CPI nesting limit from 4 to 8".
const SIMD_0268: &str = "6TkHkRmP7JZy1fdM6fg5uXn76wChQBWGokHBJzrLB3mj";

/// A VM with SIMD-0268 switched off, the router, the lending AMM, klend and the stand-in smart
/// wallet, and a market lending WSOL against a Token-2022 mint with Pipeline's test-hook, which
/// has lent four fifths of its WSOL through `rebalance`.
fn hooked_market_without_simd_0268() -> (Env, Market) {
    // The features active on mainnet, as `LiteSVM::new` sets them, with SIMD-0268 off whether
    // or not that list has it yet.
    let feature: Pubkey = SIMD_0268.parse().unwrap();
    let mut features = LiteSVM::mainnet_feature_set();
    features.deactivate(&feature);
    assert!(!features.is_active(&feature));
    let mut env = Env::with_svm(LiteSVM::new().with_feature_set(features));
    env.load_klend();
    env.load_smart_wallet();
    let (hooked, _) = env.create_hooked_mint();
    let spec = MarketSpec {
        mints: [(hooked, TOKEN_2022), (wsol(), TOKEN)],
        params: lending_amm::InitParams {
            lent_index: 1,
            lp_fee_bps: 30,
        },
    };
    let (market, _) = env
        .create_funded_market(&spec, [1_000_000_000_000, 50 * SOL])
        .unwrap();
    env.rebalance(&market, None).unwrap();
    (env, market)
}

#[test]
fn an_in_swap_redeem_from_a_smart_wallet_with_a_hooked_token_fits_the_call_depth_limit() {
    let (mut env, market) = hooked_market_without_simd_0268();
    let (other, lent) = (market.other_index(), market.lent_index);
    let buffer = env.buffer(&market);
    let amount = env.sell_paying(&market, buffer + buffer / 2);
    let quote = env.quote(&market, &exact_in(other, lent, amount)).unwrap();
    assert!(quote.amount_out > buffer);
    let trader = env.funded_wallet(&market, [2 * amount, 0]);
    let swap = env
        .swap_instruction(
            &market,
            &trader.pubkey(),
            (other, lent),
            amount,
            TradeMode::ExactIn,
        )
        .unwrap();
    let meta = env
        .send_meta(&[through_smart_wallet(swap)], &[&trader])
        .unwrap();

    let paid_into = env.wallet_token_account(&market, &trader.pubkey(), lent);
    assert_eq!(
        env.balance(&paid_into),
        env.kept(&market, lent, quote.amount_out)
    );
    let redeemed = events::<ShortfallRedeemed>(&meta.logs);
    assert_eq!(redeemed.len(), 1);
    assert_eq!(redeemed[0].shortfall, quote.amount_out - buffer);
    // The redeem's token transfer ran at the fifth level, the last there is, and the input's
    // transfer hook ran at the fourth.
    let klend = common::kamino::klend();
    assert!(meta
        .logs
        .iter()
        .any(|line| *line == format!("Program {klend} invoke [4]")));
    assert!(meta
        .logs
        .iter()
        .any(|line| *line == format!("Program {TOKEN} invoke [5]")));
    assert!(meta
        .logs
        .iter()
        .any(|line| *line == format!("Program {} invoke [4]", test_hook_id())));
    for line in meta.logs.iter().filter(|line| line.contains(" invoke [")) {
        println!("{line}");
    }
}

#[test]
fn one_more_outer_level_goes_past_the_limit() {
    // Two smart wallets, one inside the other, push the redeem's transfer to a sixth level, which
    // the VM refuses with SIMD-0268 off: the limit the test above fits is the real one.
    let (mut env, market) = hooked_market_without_simd_0268();
    let (other, lent) = (market.other_index(), market.lent_index);
    let buffer = env.buffer(&market);
    let amount = env.sell_paying(&market, buffer + buffer / 2);
    let trader = env.funded_wallet(&market, [2 * amount, 0]);
    let swap = env
        .swap_instruction(
            &market,
            &trader.pubkey(),
            (other, lent),
            amount,
            TradeMode::ExactIn,
        )
        .unwrap();
    let nested = through_smart_wallet(through_smart_wallet(swap));
    let failure = env.send_meta(&[nested], &[&trader]).unwrap_err();
    assert!(failure.contains("CallDepth"), "{failure}");
}
