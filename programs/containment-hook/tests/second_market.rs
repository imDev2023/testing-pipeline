//! A second market for a contained token (docs/spec/containment-hook.md, "What this
//! refuses"): anyone may create one, on the tax AMM or on another strategy, since neither
//! knows about containment, but the hook refuses every transfer that would fund it (a seed,
//! a deposit, a sell into it, a transfer into its vault) and every transfer that would pay
//! out of it, so it can never trade the token. A home-market buy cannot deliver into its
//! vault either, since a strategy creates its vaults without the immutable owner extension
//! (`HOOK-47`), and a balance that reached one before that rule could still not be traded.

mod support;

use containment_hook::HookError;
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use support::*;
use tax_amm::state::MarketStatus;

const AMOUNT: u64 = 1_000_000_000_000;

/// A second tax market for the contained token against a new quote mint, created by a
/// fresh seeder who holds some of the token (bought through the home market would be the
/// honest way; here it is credited to them, see `credit`) and the quote mint.
fn second_tax_market(env: &mut Env, launched: &Launched) -> (Market, Keypair) {
    let seeder = Keypair::new();
    env.svm.airdrop(&seeder.pubkey(), SOL).unwrap();
    let quote = env.create_mint(&TOKEN);
    let params = quote_taxed_params(&seeder.pubkey(), QUOTE as u8);
    let market = env
        .create_tax_market([(launched.mint, TOKEN_2022), (quote, TOKEN)], &params)
        .unwrap();
    let holder = token_2022_account(env, &seeder.pubkey(), &launched.mint);
    credit(env, &launched.mint, &holder, AMOUNT);
    env.write_token_account(&quote, &TOKEN, &seeder.pubkey(), AMOUNT);
    (market, seeder)
}

#[test]
fn funding_a_second_tax_market_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let (market, seeder) = second_tax_market(&mut env, &launched);
    assert_hook_refused(
        env.seed_with(
            &market,
            &seeder,
            [AMOUNT, AMOUNT],
            hook_tail(&launched.mint),
        ),
        HookError::TransferRefused,
    );
    assert_eq!(env.balance(&market.vaults[CONTAINED]), 0);
}

#[test]
fn funding_a_market_on_another_strategy_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let quote = env.create_mint(&TOKEN);
    let market = cp_market(&mut env, [(launched.mint, TOKEN_2022), (quote, TOKEN)]);
    let depositor = Keypair::new();
    env.svm.airdrop(&depositor.pubkey(), SOL).unwrap();
    let holder = token_2022_account(&mut env, &depositor.pubkey(), &launched.mint);
    credit(&mut env, &launched.mint, &holder, AMOUNT);
    let quote_account = env.write_token_account(&quote, &TOKEN, &depositor.pubkey(), AMOUNT);

    let deposit = cp_deposit(
        &market,
        &depositor.pubkey(),
        [holder, quote_account],
        &launched.mint,
    );
    assert_hook_refused(
        env.send(&[deposit], &[&depositor]),
        HookError::TransferRefused,
    );
    // Nor can anyone send the token into its vault directly.
    let transfer = transfer_checked(
        &launched.mint,
        &holder,
        &market.vaults[0],
        &depositor.pubkey(),
        AMOUNT,
        hook_tail(&launched.mint),
    );
    assert_hook_refused(
        env.send(&[transfer], &[&depositor]),
        HookError::TransferRefused,
    );
    assert_eq!(env.balance(&market.vaults[0]), 0);
}

#[test]
fn paying_out_of_a_second_tax_market_is_refused() {
    // A second market holding the token (written in here; a home-market buy delivering to its
    // vault, below, is the real way) still cannot pay it out: a buy from it is refused.
    let mut env = hook_env();
    let launched = launch(&mut env);
    let (market, _) = second_tax_market(&mut env, &launched);
    let mut state = env.tax_market(&market.market_state);
    state.status = MarketStatus::Open;
    state.reserves = [AMOUNT, AMOUNT];
    let mut data = vec![];
    anchor_lang::AccountSerialize::try_serialize(&state, &mut data).unwrap();
    edit_account(&mut env, &market.market_state, |account| {
        account.data = data
    });
    for vault in market.vaults {
        set_balance(&mut env, &vault, AMOUNT);
    }
    let buyer = env.funded_wallet(&market, AMOUNT);
    // The tax AMM's own test support adds the hook tail after the strategy's accounts.
    assert_hook_refused(
        env.swap_with(
            &market,
            &buyer,
            (QUOTE, CONTAINED),
            1_000_000,
            &SwapOptions::default(),
        ),
        HookError::TransferRefused,
    );
    assert_eq!(env.balance(&market.vaults[CONTAINED]), AMOUNT);
}

#[test]
fn paying_out_of_a_market_on_another_strategy_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let quote = env.create_mint(&TOKEN);
    let market = cp_market(&mut env, [(launched.mint, TOKEN_2022), (quote, TOKEN)]);
    for vault in market.vaults {
        set_balance(&mut env, &vault, AMOUNT);
    }
    // The pool's reserves, after its discriminator and four keys: reserve_a, reserve_b.
    edit_account(&mut env, &market.market_state, |account| {
        account.data[136..144].copy_from_slice(&AMOUNT.to_le_bytes());
        account.data[144..152].copy_from_slice(&AMOUNT.to_le_bytes());
    });
    let buyer = env.funded_wallet(&market, AMOUNT);
    let swap = cp_buy(&env, &market, &buyer.pubkey(), 1_000_000, &launched.mint);
    assert_hook_refused(env.send(&[swap], &[&buyer]), HookError::TransferRefused);
    assert_eq!(env.balance(&market.vaults[0]), AMOUNT);
}

#[test]
fn a_buy_delivered_into_a_second_markets_vault_is_refused_and_a_balance_there_is_never_traded() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let (market, _) = second_tax_market(&mut env, &launched);
    let buyer = trader(&mut env, &launched, 10 * SOL);
    let into_its_vault = Swap {
        output_to: Some(market.vaults[CONTAINED]),
        ..Swap::default()
    };
    // A transfer out of the home vault, but into an account whose owner could change.
    assert_hook_refused(
        swap(
            &mut env,
            &launched,
            &buyer,
            (QUOTE, CONTAINED),
            SOL,
            &into_its_vault,
        ),
        HookError::DestinationOwnerCanChange,
    );
    assert_eq!(env.balance(&market.vaults[CONTAINED]), 0);

    // A balance that reached the vault before the rule, written here, and the market opened
    // with it as its reserve: the second market can still trade it with nobody.
    let gift = AMOUNT;
    set_balance(&mut env, &market.vaults[CONTAINED], gift);
    let mut state = env.tax_market(&market.market_state);
    state.status = MarketStatus::Open;
    state.reserves = [gift, AMOUNT];
    let mut data = vec![];
    anchor_lang::AccountSerialize::try_serialize(&state, &mut data).unwrap();
    edit_account(&mut env, &market.market_state, |account| {
        account.data = data
    });
    set_balance(&mut env, &market.vaults[QUOTE], AMOUNT);
    let trader = env.funded_wallet(&market, AMOUNT);
    for (direction, what) in [
        ((QUOTE, CONTAINED), "a buy from it"),
        ((CONTAINED, QUOTE), "a sell into it"),
    ] {
        println!("{what}");
        assert_hook_refused(
            env.swap_with(
                &market,
                &trader,
                direction,
                1_000_000,
                &SwapOptions::default(),
            ),
            HookError::TransferRefused,
        );
    }
    assert_eq!(env.balance(&market.vaults[CONTAINED]), gift);
}

/// Writes a token account's balance.
fn set_balance(env: &mut Env, account: &Pubkey, amount: u64) {
    edit_account(env, account, |account| {
        account.data[64..72].copy_from_slice(&amount.to_le_bytes());
    });
}

/// Pipeline's constant-product test strategy's `deposit` of `AMOUNT` of each mint, with the
/// hook tail as its remaining accounts.
fn cp_deposit(
    market: &Market,
    depositor: &Pubkey,
    from: [Pubkey; 2],
    mint: &Pubkey,
) -> Instruction {
    let mut data = pipeline_client::instruction_discriminator("deposit").to_vec();
    data.extend_from_slice(&AMOUNT.to_le_bytes());
    data.extend_from_slice(&AMOUNT.to_le_bytes());
    let mut accounts = vec![
        AccountMeta::new_readonly(*depositor, true),
        AccountMeta::new(market.market_state, false),
        AccountMeta::new(from[0], false),
        AccountMeta::new(from[1], false),
        AccountMeta::new(market.vaults[0], false),
        AccountMeta::new(market.vaults[1], false),
        AccountMeta::new_readonly(market.mints[0], false),
        AccountMeta::new_readonly(market.mints[1], false),
        AccountMeta::new_readonly(market.token_programs[0], false),
        AccountMeta::new_readonly(market.token_programs[1], false),
    ];
    accounts.extend(hook_tail(mint));
    Instruction::new_with_bytes(cp_strategy_id(), &data, accounts)
}

/// A router swap buying the contained mint (index 0) from a constant-product test market
/// with `amount_in` of its other mint, with the hook tail after the strategy's accounts.
fn cp_buy(
    env: &Env,
    market: &Market,
    buyer: &Pubkey,
    amount_in: u64,
    mint: &Pubkey,
) -> Instruction {
    let trade = exact_in(1, 0, amount_in);
    let read = env.read_accounts(market, &trade);
    let request = ResolveRequest {
        trade: trade.clone(),
        round: 0,
    };
    let mut data = pipeline_client::interface::discriminator::RESOLVE_ACCOUNTS.to_vec();
    data.extend(borsh::to_vec(&request).unwrap());
    let resolve = Instruction::new_with_bytes(cp_strategy_id(), &data, read);
    let resolved: ResolveResult = borsh::from_slice(&env.simulate(resolve).unwrap()).unwrap();
    let mut strategy_accounts: Vec<AccountMeta> = resolved
        .accounts
        .iter()
        .map(|a| {
            let address = Pubkey::new_from_array(a.address);
            if a.writable {
                AccountMeta::new(address, false)
            } else {
                AccountMeta::new_readonly(address, false)
            }
        })
        .collect();
    strategy_accounts.extend(hook_tail(mint));
    let accounts = pipeline_client::SwapAccounts {
        trader: *buyer,
        strategy_program: cp_strategy_id(),
        market_state: market.market_state,
        trader_input: pipeline_client::pda::associated_token(
            buyer,
            &market.mints[1],
            &market.token_programs[1],
        ),
        trader_output: pipeline_client::pda::associated_token(
            buyer,
            &market.mints[0],
            &market.token_programs[0],
        ),
        input_vault: market.vaults[1],
        input_mint: market.mints[1],
        output_mint: market.mints[0],
        input_token_program: market.token_programs[1],
        output_token_program: market.token_programs[0],
        integrator_fee_account: None,
        strategy_accounts,
        input_hook_accounts: vec![],
    };
    let args = pipeline_client::SwapArgs {
        mode: pipeline_client::TradeMode::ExactIn,
        amount_in,
        amount_out: 0,
        min_amount_out: 0,
        integrator_fee_bps: 0,
        input_hook_accounts: 0,
        extra: vec![],
    };
    pipeline_client::swap(&accounts, &args)
}
