//! Hostile trades, modelled on Pipeline's `adversarial.rs` and `test-strategy-evil`
//! (docs/spec/README.md, "Test layers" 1): bypass and a wrong market signer, aliased and
//! substituted vaults, authorities and mints, and a swap whose output account is not the
//! trader's. Every refused trade leaves the market state and both vaults exactly as they
//! were.

mod common;

use buy_wall_amm::errors::StrategyError::*;
use common::*;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;

const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;
const BUY: (usize, usize) = (1, 0);
const SELL: (usize, usize) = (0, 1);

struct Setup {
    env: Env,
    market: Market,
    /// A second market of the same strategy, whose accounts are substituted in.
    other: Market,
    trader: Keypair,
}

fn setup() -> Setup {
    let mut env = Env::new();
    let mut markets = vec![];
    for _ in 0..2 {
        let token = env.seedable_token(&TOKEN);
        let (market, _) = env
            .create_and_seed(
                token,
                TOKEN,
                &launch_params(env.admin.pubkey()),
                TOKENS,
                LAMPORTS,
            )
            .unwrap();
        markets.push(market);
    }
    let other = markets.pop().unwrap();
    let market = markets.pop().unwrap();
    let trader = env.trader(&market, 100_000_000_000, 10 * SOL);
    Setup {
        env,
        market,
        other,
        trader,
    }
}

/// The market state and both vaults, to compare before and after a refused trade.
fn snapshot(env: &Env, market: &Market) -> (Vec<u8>, u64, u64) {
    (
        env.market_state(market),
        env.balance(&market.token_vault),
        env.balance(&market.sol_vault),
    )
}

/// The index in a router swap of the strategy account `key` (the output vault, then the
/// vault authority, after the router's own accounts).
fn position(ix: &Instruction, key: &Pubkey) -> usize {
    ix.accounts
        .iter()
        .rposition(|account| account.pubkey == *key)
        .expect("account in the swap")
}

#[test]
fn a_direct_call_with_any_other_market_signer_is_refused() {
    // Bypass (ADR 0001): `pipeline_swap` called directly, with someone else signing as the
    // market signer, or with the market's real signer address unsigned.
    let Setup {
        mut env,
        market,
        trader,
        ..
    } = setup();
    let before = snapshot(&env, &market);
    let request = SwapRequest {
        trade: exact_in(1, 0, SOL),
        amount_sent: SOL,
        min_amount_out: 0,
    };
    let owner = trader.pubkey();
    let mut base = env.read_accounts(&market, &request.trade);
    {
        let accounts = &mut base;
        accounts[1] = AccountMeta::new(market.market_state, false);
        accounts[2] = AccountMeta::new_readonly(owner, false);
        accounts[3] = AccountMeta::new(pda::associated_token(&owner, &WSOL, &TOKEN), false);
        accounts[4] = AccountMeta::new(
            pda::associated_token(&owner, &market.token_mint, &TOKEN),
            false,
        );
        accounts[5] = AccountMeta::new(market.sol_vault, false);
        accounts.extend(market.strategy_accounts(0));
    }
    let accounts = |signer: AccountMeta| {
        let mut accounts = base.clone();
        accounts[0] = signer;
        accounts
    };
    let impostor = Keypair::new();
    let ix = strategy_call(
        client::interface::discriminator::SWAP,
        &request,
        accounts(AccountMeta::new_readonly(impostor.pubkey(), true)),
    );
    assert_refused(env.send(&[ix], &[&impostor]), NotPipeline);
    // The trader signing as the market signer.
    let ix = strategy_call(
        client::interface::discriminator::SWAP,
        &request,
        accounts(AccountMeta::new_readonly(owner, true)),
    );
    assert_refused(env.send(&[ix], &[&trader]), NotPipeline);
    // The real market signer's address, which only the router can sign for, unsigned.
    let ix = strategy_call(
        client::interface::discriminator::SWAP,
        &request,
        accounts(AccountMeta::new_readonly(market.market, false)),
    );
    assert_fails(env.send(&[ix], &[]));
    assert_eq!(snapshot(&env, &market), before);
}

#[test]
fn substituted_or_missing_strategy_accounts_are_refused() {
    let Setup {
        mut env,
        market,
        other,
        trader,
    } = setup();
    let before = snapshot(&env, &market);
    let stranger = env.trader(&market, 1, 1);
    let strangers_sol = pda::associated_token(&stranger.pubkey(), &WSOL, &TOKEN);
    for (direction, output_vault) in [(BUY, market.token_vault), (SELL, market.sol_vault)] {
        let (input, output) = direction;
        let substitutes_for_vault = [
            other.vaults()[output],
            market.vaults()[input],
            strangers_sol,
            market.vault_authority,
        ];
        for substitute in substitutes_for_vault {
            let mut ix = env.swap_ix(
                &market,
                &trader.pubkey(),
                direction,
                TradeMode::ExactIn,
                SOL / 10,
                0,
            );
            let at = position(&ix, &market.vault_authority) - 1;
            assert_eq!(ix.accounts[at].pubkey, output_vault);
            ix.accounts[at].pubkey = substitute;
            assert_refused(env.send(&[ix], &[&trader]), WrongAccount);
        }
        for substitute in [
            other.vault_authority,
            Pubkey::new_unique(),
            market.market_state,
        ] {
            let mut ix = env.swap_ix(
                &market,
                &trader.pubkey(),
                direction,
                TradeMode::ExactIn,
                SOL / 10,
                0,
            );
            let at = position(&ix, &market.vault_authority);
            ix.accounts[at].pubkey = substitute;
            assert_refused(env.send(&[ix], &[&trader]), WrongAccount);
        }
        // Without the vault authority, or without both strategy accounts.
        for drop in [1, 2] {
            let mut ix = env.swap_ix(
                &market,
                &trader.pubkey(),
                direction,
                TradeMode::ExactIn,
                SOL / 10,
                0,
            );
            let at = position(&ix, &market.vault_authority);
            for _ in 0..drop {
                ix.accounts.remove(at + 1 - drop);
            }
            assert_refused(env.send(&[ix], &[&trader]), WrongAccount);
        }
    }
    assert_eq!(snapshot(&env, &market), before);
}

#[test]
fn substituted_input_vaults_and_mints_are_refused() {
    // The router checks the input vault and both mints against the market it recorded; the
    // strategy checks them again, so neither layer alone keeps a trade honest.
    let Setup {
        mut env,
        market,
        other,
        trader,
    } = setup();
    let before = snapshot(&env, &market);
    let swap = |env: &Env| {
        env.swap_ix(
            &market,
            &trader.pubkey(),
            BUY,
            TradeMode::ExactIn,
            SOL / 10,
            0,
        )
    };
    // Router accounts: 7 the input vault, 8 the input mint, 9 the output mint.
    for (index, substitute) in [
        (7, other.sol_vault),
        (7, market.token_vault),
        (8, market.token_mint),
        (8, other.token_mint),
        (9, other.token_mint),
        (9, WSOL),
    ] {
        let mut ix = swap(&env);
        ix.accounts[index].pubkey = substitute;
        assert_fails(env.send(&[ix], &[&trader]));
    }
    assert_eq!(snapshot(&env, &market), before);
}

#[test]
fn a_substituted_output_token_program_is_refused() {
    // The swap signs the output transfer as the vault authority, so it must only ever lend
    // that signature to the output vault's own token program. The router refuses a token
    // program that does not own the mint (`WrongTokenProgram`) before the strategy runs;
    // the strategy checks again (an SPL Token or Token-2022 program that owns the output
    // vault), so neither layer alone keeps the vault safe.
    let Setup {
        mut env,
        market,
        trader,
        ..
    } = setup();
    let before = snapshot(&env, &market);
    for direction in [BUY, SELL] {
        // Router account 11 is the output token program.
        for substitute in [
            TOKEN_2022,
            TEST_HOOK_PROGRAM,
            strategy_id(),
            client::SYSTEM_PROGRAM_ID,
        ] {
            let mut ix = env.swap_ix(
                &market,
                &trader.pubkey(),
                direction,
                TradeMode::ExactIn,
                SOL / 10,
                0,
            );
            assert_eq!(ix.accounts[11].pubkey, TOKEN);
            ix.accounts[11].pubkey = substitute;
            assert_fails(env.send(&[ix], &[&trader]));
        }
    }
    assert_eq!(snapshot(&env, &market), before);
}

#[test]
fn a_swap_whose_output_account_is_not_the_traders_pays_nothing_wrong() {
    let Setup {
        mut env,
        market,
        trader,
        ..
    } = setup();
    let before = snapshot(&env, &market);
    // The output vault itself as the trader's output account: the market would book a
    // payout while nothing moved.
    for (direction, vault) in [(BUY, market.token_vault), (SELL, market.sol_vault)] {
        let mut ix = env.swap_ix(
            &market,
            &trader.pubkey(),
            direction,
            TradeMode::ExactIn,
            SOL / 10,
            0,
        );
        // Router account 6 is the trader's output account.
        ix.accounts[6].pubkey = vault;
        assert_fails(env.send(&[ix], &[&trader]));
    }
    assert_eq!(snapshot(&env, &market), before);

    // Someone else's token account as the output account: the router allows it (the
    // trader chooses where its output goes), and the strategy pays that account exactly
    // the quote, from the right vault, booking exactly what left it.
    let stranger = env.trader(&market, 0, 0);
    let strangers_token = pda::associated_token(&stranger.pubkey(), &market.token_mint, &TOKEN);
    let quote = env.quote(&market, &exact_in(1, 0, SOL / 10)).unwrap();
    let mut ix = env.swap_ix(
        &market,
        &trader.pubkey(),
        BUY,
        TradeMode::ExactIn,
        SOL / 10,
        0,
    );
    ix.accounts[6].pubkey = strangers_token;
    env.send(&[ix], &[&trader]).unwrap();
    assert_eq!(env.balance(&strangers_token), quote.amount_out);
    let (_, token_vault, sol_vault) = snapshot(&env, &market);
    assert_eq!(token_vault, before.1 - quote.amount_out);
    assert_eq!(sol_vault, before.2 + SOL / 10);
    let state = env.state(&market);
    assert_eq!(state.pool_tokens() as u128, token_vault as u128);
    assert_eq!(state.swap_count(), 1);
}

#[test]
fn account_resolution_names_the_output_vault_and_the_vault_authority() {
    let Setup { env, market, .. } = setup();
    for (input, output, vault) in [(0, 1, market.sol_vault), (1, 0, market.token_vault)] {
        let resolved = env
            .resolve(&market, &trade(TradeMode::ExactIn, input, output, 1))
            .unwrap();
        assert!(resolved.complete);
        let accounts: Vec<_> = resolved
            .accounts
            .iter()
            .map(|account| (Pubkey::new_from_array(account.address), account.writable))
            .collect();
        assert_eq!(
            accounts,
            vec![(vault, true), (market.vault_authority, false)]
        );
    }
    // Indices other than the two mints are refused.
    for (input, output) in [(0, 0), (1, 1), (0, 2), (2, 1)] {
        let request = trade(TradeMode::ExactIn, input, output, 1);
        assert_refused(env.resolve(&market, &request), WrongAccount);
        assert_refused(env.quote(&market, &request), WrongAccount);
    }
}
