//! A created tax market before its seed: what it reports to the router and integrators, and
//! that it refuses every quote and swap (docs/spec/tax-amm.md, "The seed" and
//! "`pipeline-check` warns").

mod common;

use common::*;
use pipeline_check::{check_market, CheckOptions, Status};
use pipeline_client::interface::MarketInfo;
use pipeline_client::{self as client, pda, Pubkey, TradeMode};
use tax_amm::StrategyError;

const ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;
const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;

fn created_market() -> (Env, Market) {
    let mut env = Env::new();
    let mint_0 = env.create_mint(&TOKEN);
    let mint_1 = env.create_mint(&TOKEN_2022);
    let params = valid_params(&Pubkey::new_unique());
    let market = env
        .create_tax_market([(mint_0, TOKEN), (mint_1, TOKEN_2022)], &params)
        .unwrap();
    (env, market)
}

#[test]
fn market_info_given_only_the_market_state_reports_what_the_router_recorded() {
    let (env, market) = created_market();
    let data = env
        .market_info_meta(&market.market_state)
        .unwrap()
        .return_data
        .data;
    let info: MarketInfo = borsh::from_slice(&data).unwrap();
    let recorded = env.router_market(&market.market);
    let mints: Vec<Pubkey> = info
        .mints
        .iter()
        .map(|m| Pubkey::new_from_array(*m))
        .collect();
    let vaults: Vec<Pubkey> = info
        .vaults
        .iter()
        .map(|v| Pubkey::new_from_array(*v))
        .collect();
    assert_eq!(mints, recorded.mints());
    assert_eq!(vaults, &recorded.vaults[..2]);
    assert_eq!(info.supports_exact_out, recorded.supports_exact_out);
    assert!(!info.supports_exact_out);
    // In the creator's order, with the vaults at their PDAs.
    assert_eq!(mints, market.mints);
    assert_eq!(vaults, market.vaults);
}

#[test]
fn market_info_refuses_an_account_that_is_not_a_tax_market() {
    let (mut env, market) = created_market();

    // A vault, a wallet: not the program's.
    let wallet = Pubkey::new_unique();
    env.svm.airdrop(&wallet, SOL).unwrap();
    for account in [market.vaults[0], wallet] {
        let failure = env.market_info_meta(&account).unwrap_err();
        assert!(
            failure.contains(&format!("Custom({ACCOUNT_OWNED_BY_WRONG_PROGRAM})"))
                || failure.contains("Custom(3012)"),
            "{failure}"
        );
    }

    // An account the program owns whose bytes are not a market state: a copy of a real
    // market state with its discriminator changed.
    let mut fake = env.svm.get_account(&market.market_state).unwrap();
    fake.data[0] ^= 1;
    let fake_address = Pubkey::new_unique();
    env.svm.set_account(fake_address, fake).unwrap();
    let failure = env.market_info_meta(&fake_address).unwrap_err();
    assert!(
        failure.contains(&format!("Custom({ACCOUNT_DISCRIMINATOR_MISMATCH})")),
        "{failure}"
    );

    // So nobody can record it as a market with the router's register_existing_market.
    let register = client::register_existing_market(
        &env.admin.pubkey(),
        &strategy_id(),
        &fake_address,
        vec![],
    );
    let failure = env.send(&[register], &[]).unwrap_err();
    assert!(
        failure.contains(&format!("Custom({ACCOUNT_DISCRIMINATOR_MISMATCH})")),
        "{failure}"
    );
    assert!(env
        .svm
        .get_account(&pda::market(&strategy_id(), &fake_address))
        .is_none());
}

#[test]
fn resolve_accounts_lists_the_output_vault_in_one_round() {
    let (env, market) = created_market();
    for (input, output) in [(0, 1), (1, 0)] {
        let accounts = env
            .resolve_accounts(&market, &exact_in(input, output, 1_000))
            .unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].pubkey, market.vaults[output]);
        assert!(accounts[0].is_writable);
    }
    // A direction that isn't one of the market's two, with the accounts of a real one.
    for (input, output) in [(0, 0), (1, 1), (0, 2), (2, 0)] {
        let request = ResolveRequest {
            trade: exact_in(input, output, 1_000),
            round: 0,
        };
        let call = strategy_call(
            client::interface::discriminator::RESOLVE_ACCOUNTS,
            &request,
            env.read_accounts(&market, &exact_in(0, 1, 1_000)),
        );
        assert_refused(env.simulate(call), StrategyError::WrongAccount);
    }
}

#[test]
fn an_unseeded_market_refuses_every_quote_and_swap() {
    let (mut env, market) = created_market();
    for (input, output) in [(0, 1), (1, 0)] {
        for amount in [1, 1_000_000, u64::MAX] {
            assert_refused(
                env.quote(&market, &exact_in(input, output, amount)),
                StrategyError::MarketNotOpen,
            );
        }
        let mut exact_out = exact_in(input, output, 1_000);
        exact_out.mode = TradeMode::ExactOut;
        assert_refused(
            env.quote(&market, &exact_out),
            StrategyError::ExactOutNotSupported,
        );
    }

    // Swaps through the router are refused, and leave the trader's tokens where they were.
    let trader = env.funded_wallet(&market, 1_000_000_000);
    let trader_input = pda::associated_token(&trader.pubkey(), &market.mints[0], &TOKEN);
    for (input, output) in [(0, 1), (1, 0)] {
        assert_refused(
            env.swap(&market, &trader, (input, output), 1_000_000),
            StrategyError::MarketNotOpen,
        );
    }
    assert_eq!(env.balance(&trader_input), 1_000_000_000);
    assert_eq!(env.balance(&market.vaults[0]), 0);
}

#[test]
fn pipeline_check_reports_nothing_worse_than_its_quotes_warn_on_an_unseeded_market() {
    let (env, market) = created_market();
    let report = check_market(&env.svm, market.market, &CheckOptions::default());
    println!("{}", report.to_text());
    let worse: Vec<_> = report
        .checks
        .iter()
        .filter(|check| {
            check.status == Status::Fail || (check.status == Status::Warn && check.id != "quotes")
        })
        .map(|check| format!("{} ({:?})", check.id, check.status))
        .collect();
    assert!(
        worse.is_empty(),
        "checks worse than the quotes warn: {worse:?}"
    );
    assert_eq!(report.status("quotes"), Some(Status::Warn));
}

use solana_signer::Signer;
