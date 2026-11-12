//! What a seeded tax market refuses (docs/spec/tax-amm.md, "Pricing and the tax" and
//! "Bypass"; docs/spec/README.md, "Strategy rules" and "Test layers" 1): exact-out, a trade
//! whose output is 0, and any swap that does not come from its router market. Every
//! refusal leaves the market exactly as it was.

mod common;

use common::model::Model;
use common::*;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::StrategyError;

/// Anchor's "account not signer".
const ACCOUNT_NOT_SIGNER: u32 = 3010;

fn seeded(tax_side: u8, buy: u16, sell: u16) -> (Env, Market) {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
    ];
    let mut p = valid_params(&Pubkey::new_unique());
    p.tax_side = tax_side;
    p.buy_tax_min_bps = 0;
    p.buy_tax_max_bps = 1_000;
    p.buy_tax_bps = buy;
    p.sell_tax_bps = sell;
    let market = env.seeded_market(mints, &p, [100_000_000_000, 200_000_000_000]);
    (env, market)
}

/// Runs `refuse` and checks it left the market state and both vaults as they were.
fn unchanged(env: &mut Env, market: &Market, refuse: impl FnOnce(&mut Env)) {
    let before = Model::of(&env.tax_market(&market.market_state));
    let vaults = market.vaults.map(|v| env.balance(&v));
    refuse(env);
    before.assert_matches(&env.tax_market(&market.market_state));
    assert_eq!(market.vaults.map(|v| env.balance(&v)), vaults);
}

#[test]
fn exact_out_quotes_and_swaps_are_refused() {
    let (mut env, market) = seeded(1, 300, 500);
    let trader = env.funded_wallet(&market, 10_000_000_000);
    for (i, o) in [(0, 1), (1, 0)] {
        let mut trade = exact_in(i, o, 1_000_000);
        trade.mode = TradeMode::ExactOut;
        assert_refused(
            env.quote(&market, &trade),
            StrategyError::ExactOutNotSupported,
        );
        unchanged(&mut env, &market, |env| {
            let options = SwapOptions {
                mode: Some(TradeMode::ExactOut),
                ..SwapOptions::default()
            };
            // The router knows from the market's info that exact-out is not supported, and
            // refuses before it reaches the strategy.
            let failure = env
                .swap_with(&market, &trader, (i, o), 1_000_000, &options)
                .unwrap_err();
            assert!(
                failure.contains("Error Code: ExactOutUnsupported.")
                    && !failure.contains("PipelineSwap"),
                "{failure}"
            );
        });
    }
}

#[test]
fn a_trade_whose_output_is_0_is_refused_as_a_quote_and_a_swap() {
    // One unit at a 10% buy tax is all tax; one unit of the deeper side buys less than one
    // unit of the shallower one.
    for (tax_side, (i, o)) in [(0u8, (0, 1)), (1, (1, 0)), (0, (1, 0))] {
        let (mut env, market) = seeded(tax_side, 1_000, 1_000);
        assert_refused(
            env.quote(&market, &exact_in(i, o, 1)),
            StrategyError::ZeroOutput,
        );
        let trader = env.funded_wallet(&market, 10_000_000_000);
        unchanged(&mut env, &market, |env| {
            assert_refused(
                env.swap(&market, &trader, (i, o), 1),
                StrategyError::ZeroOutput,
            );
        });
    }
}

/// The router's `swap` turned into a direct call of the strategy's `pipeline_swap`, as a
/// bypass would send it: the input already moved to the vault by a token transfer, as the
/// router moves it, then the strategy called with `market_signer` in the market signer's
/// place.
fn bypass(
    env: &mut Env,
    market: &Market,
    trader: &Keypair,
    market_signer: AccountMeta,
    signers: &[&Keypair],
) -> Result<Vec<u8>, String> {
    let (i, o) = (0, 1);
    let amount: u64 = 1_000_000_000;
    let owner = trader.pubkey();
    let trader_input = pda::associated_token(&owner, &market.mints[i], &market.token_programs[i]);
    let trader_output = pda::associated_token(&owner, &market.mints[o], &market.token_programs[o]);
    let mut transfer_data = vec![12u8];
    transfer_data.extend_from_slice(&amount.to_le_bytes());
    transfer_data.push(6);
    let send_input = Instruction::new_with_bytes(
        market.token_programs[i],
        &transfer_data,
        vec![
            AccountMeta::new(trader_input, false),
            AccountMeta::new_readonly(market.mints[i], false),
            AccountMeta::new(market.vaults[i], false),
            AccountMeta::new_readonly(owner, true),
        ],
    );
    let request = client::interface::SwapRequest {
        trade: exact_in(i, o, amount),
        amount_sent: amount,
        min_amount_out: 0,
    };
    let mut accounts = vec![
        market_signer,
        AccountMeta::new(market.market_state, false),
        AccountMeta::new_readonly(owner, false),
        AccountMeta::new(trader_input, false),
        AccountMeta::new(trader_output, false),
        AccountMeta::new(market.vaults[i], false),
        AccountMeta::new_readonly(market.mints[i], false),
        AccountMeta::new_readonly(market.mints[o], false),
        AccountMeta::new_readonly(market.token_programs[i], false),
        AccountMeta::new_readonly(market.token_programs[o], false),
    ];
    accounts.extend(
        env.resolve_accounts(market, &exact_in(i, o, amount))
            .unwrap(),
    );
    let call = strategy_call(client::interface::discriminator::SWAP, &request, accounts);
    let mut all = vec![trader];
    all.extend_from_slice(signers);
    env.send(&[send_input, call], &all)
}

#[test]
fn bypass_is_refused_with_another_key_signing_as_the_market_signer() {
    let (mut env, market) = seeded(1, 300, 500);
    let trader = env.funded_wallet(&market, 10_000_000_000);
    let impostor = Keypair::new();
    unchanged(&mut env, &market, |env| {
        assert_refused(
            bypass(
                env,
                &market,
                &trader,
                AccountMeta::new_readonly(impostor.pubkey(), true),
                &[&impostor],
            ),
            StrategyError::NotPipeline,
        );
    });
}

#[test]
fn bypass_is_refused_with_the_real_market_signer_not_signing() {
    let (mut env, market) = seeded(1, 300, 500);
    let trader = env.funded_wallet(&market, 10_000_000_000);
    unchanged(&mut env, &market, |env| {
        let failure = bypass(
            env,
            &market,
            &trader,
            AccountMeta::new_readonly(market.market, false),
            &[],
        )
        .unwrap_err();
        assert!(
            failure.contains(&format!("Custom({ACCOUNT_NOT_SIGNER})")),
            "{failure}"
        );
    });
}

#[test]
fn a_swap_paying_out_to_the_output_vault_itself_is_refused() {
    // A transfer from the vault to itself moves nothing, so the trader would receive 0
    // while the market booked a payout: its real reserve and volume would no longer match
    // what left the vault, or the swap event's `received`.
    let (mut env, market) = seeded(1, 300, 500);
    let trader = env.funded_wallet(&market, 10_000_000_000);
    for (i, o) in [(0, 1), (1, 0)] {
        let mut swap = env
            .swap_instruction(
                &market,
                &trader.pubkey(),
                (i, o),
                1_000_000_000,
                &SwapOptions::default(),
            )
            .unwrap();
        // The router's trade accounts follow its own: the trader's output is the fifth.
        let position = swap
            .accounts
            .iter()
            .position(|meta| {
                meta.pubkey
                    == pda::associated_token(
                        &trader.pubkey(),
                        &market.mints[o],
                        &market.token_programs[o],
                    )
            })
            .unwrap();
        swap.accounts[position].pubkey = market.vaults[o];
        unchanged(&mut env, &market, |env| {
            assert_refused(env.send(&[swap], &[&trader]), StrategyError::WrongAccount);
        });
    }
}
