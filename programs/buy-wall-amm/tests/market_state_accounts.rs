//! Every instruction accepts every layout version listed as deployed (only 1 so far) and
//! refuses a market state of any other size, owner, discriminator or version
//! (docs/spec/pool4-for-solana.md, "One fixed-size layout"). Anyone can call the router's
//! `register_existing_market` on any account this program owns, so the router's own path
//! is covered too.

mod common;

use buy_wall_amm::errors::StrategyError::*;
use common::*;
use pipeline_client::{self as client, AccountMeta, Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;

const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;

/// The vault authority's bump in the market state (docs/spec/pool4-for-solana.md, the layout
/// table; `authority_bump` in `src/state.rs`).
const AUTHORITY_BUMP_OFFSET: usize = 10;

/// A change to a planted copy's bytes.
type Change = Box<dyn Fn(&mut Vec<u8>)>;

/// Plants a copy of `market`'s state, changed by `change`, at a new address owned by
/// `owner`, and returns the market's addresses with the copy as its market state.
fn plant(env: &mut Env, market: &Market, owner: Pubkey, change: impl Fn(&mut Vec<u8>)) -> Market {
    let mut account = env.svm.get_account(&market.market_state).unwrap();
    let bump = account.data[AUTHORITY_BUMP_OFFSET];
    change(&mut account.data);
    account.owner = owner;
    account.lamports = env
        .svm
        .minimum_balance_for_rent_exemption(account.data.len());
    // The program derives the vault authority from the bump stored in the state, which is
    // the canonical bump for the original address only. At an address whose canonical bump
    // differs, that bump can fail to give a program address, and instructions that derive the
    // authority refuse with WrongAccount for a reason that is not the change under test; so
    // plant the copy where the stored bump is canonical (two tries on average).
    let address = loop {
        let candidate = Pubkey::new_unique();
        let (_, canonical) = Pubkey::find_program_address(
            &[buy_wall_amm::state::AUTHORITY_SEED, candidate.as_ref()],
            &strategy_id(),
        );
        if canonical == bump {
            break candidate;
        }
    };
    env.svm.set_account(address, account).unwrap();
    Market {
        market_state: address,
        market: client::pda::market(&strategy_id(), &address),
        ..market.clone()
    }
}

/// Each instruction run against `market`, by name.
fn every_instruction(
    env: &mut Env,
    market: &Market,
    seeder: &Keypair,
) -> Vec<(&'static str, Result<(), String>)> {
    let request = trade(TradeMode::ExactIn, 1, 0, SOL);
    let swap_request = SwapRequest {
        trade: request.clone(),
        amount_sent: SOL,
        min_amount_out: 0,
    };
    // Someone signing in the router's place, so Anchor reaches the market state.
    let impostor = Keypair::new();
    let mut swap_accounts = env.read_accounts(market, &request);
    swap_accounts[0] = AccountMeta::new_readonly(impostor.pubkey(), true);
    swap_accounts[1] = AccountMeta::new(market.market_state, false);
    swap_accounts[2] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    swap_accounts[3] = AccountMeta::new(Pubkey::new_unique(), false);
    swap_accounts[4] = AccountMeta::new(Pubkey::new_unique(), false);
    swap_accounts[5].is_writable = true;
    swap_accounts.push(AccountMeta::new(market.token_vault, false));
    let swap = strategy_call(
        client::interface::discriminator::SWAP,
        &swap_request,
        swap_accounts,
    );
    let seed = seed_ix(market, &seeder.pubkey(), TOKENS, LAMPORTS, vec![]);
    let register = client::register_existing_market(
        &env.admin.pubkey(),
        &strategy_id(),
        &market.market_state,
        vec![],
    );
    vec![
        (
            "pipeline_market_info",
            env.market_info(&market.market_state).map(|_| ()),
        ),
        (
            "pipeline_resolve_accounts",
            env.resolve(market, &request).map(|_| ()),
        ),
        ("pipeline_quote", env.quote(market, &request).map(|_| ())),
        ("pipeline_swap", env.send(&[swap], &[&impostor]).map(|_| ())),
        ("seed", env.send(&[seed], &[seeder]).map(|_| ())),
        (
            "register_existing_market",
            env.send(&[register], &[]).map(|_| ()),
        ),
    ]
}

/// A refusal because the account is not a market state of a deployed layout: ours
/// (`NotAMarket`), or Anchor's for a wrong owner (3007) or discriminator (3002) or an
/// account too short to hold one (3001). For an account the strategy does not own, the
/// router's `register_existing_market` refuses before calling the strategy
/// (`MarketStateNotOwnedByStrategy`, matched by name since the router's error numbers
/// shifted in Pipeline 0.2).
#[track_caller]
fn assert_not_a_market(name: &str, result: &Result<(), String>) {
    let ours: u32 = NotAMarket.into();
    let codes = [ours, 3007, 3002, 3001];
    // The router's own refusal is matched by name: its error numbers shifted in Pipeline 0.2.
    let routers = name
        .starts_with("register_existing_market (owned by")
        .then_some("Error Code: MarketStateNotOwnedByStrategy");
    match result {
        Ok(()) => panic!("{name} accepted it"),
        Err(message) => assert!(
            codes
                .iter()
                .any(|code| message.contains(&format!("Custom({code})")))
                || routers.is_some_and(|routers| message.contains(routers)),
            "{name} refused it, but not as a market state:\n{message}"
        ),
    }
}

#[test]
fn every_instruction_refuses_any_other_size_owner_discriminator_or_version() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let seeder = Keypair::new();
    env.svm.airdrop(&seeder.pubkey(), SOL).unwrap();
    env.fund(&seeder.pubkey(), &token, &TOKEN, TOKENS, LAMPORTS);
    let market = env
        .create_market(token, TOKEN, &launch_params(seeder.pubkey()))
        .unwrap();

    let program = strategy_id();
    let cases: Vec<(&str, Pubkey, Change)> = vec![
        (
            "one byte short",
            program,
            Box::new(|d: &mut Vec<u8>| {
                d.pop();
            }),
        ),
        (
            "one byte long",
            program,
            Box::new(|d: &mut Vec<u8>| d.push(0)),
        ),
        (
            "twice the size",
            program,
            Box::new(|d: &mut Vec<u8>| d.extend(vec![0; 1_024])),
        ),
        ("empty", program, Box::new(|d: &mut Vec<u8>| d.clear())),
        ("owned by SPL Token", TOKEN, Box::new(|_: &mut Vec<u8>| {})),
        (
            "owned by the router",
            client::PROGRAM_ID,
            Box::new(|_: &mut Vec<u8>| {}),
        ),
        (
            "another discriminator",
            program,
            Box::new(|d: &mut Vec<u8>| d[0] ^= 1),
        ),
        (
            "Anchor's derived discriminator",
            program,
            Box::new(|d: &mut Vec<u8>| {
                d[..8].copy_from_slice(&client::instruction_discriminator("x")[..8]);
            }),
        ),
        (
            "layout version 0",
            program,
            Box::new(|d: &mut Vec<u8>| d[8] = 0),
        ),
        (
            "layout version 2",
            program,
            Box::new(|d: &mut Vec<u8>| d[8] = 2),
        ),
        (
            "layout version 255",
            program,
            Box::new(|d: &mut Vec<u8>| d[8] = 255),
        ),
    ];
    for (case, owner, change) in &cases {
        let planted = plant(&mut env, &market, *owner, change);
        for (name, result) in every_instruction(&mut env, &planted, &seeder) {
            println!("{case}: {name}");
            assert_not_a_market(&format!("{name} ({case})"), &result);
        }
    }
}

#[test]
fn every_instruction_accepts_layout_version_one() {
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let seeder = Keypair::new();
    env.svm.airdrop(&seeder.pubkey(), SOL).unwrap();
    env.fund(&seeder.pubkey(), &token, &TOKEN, TOKENS, LAMPORTS);
    let market = env
        .create_market(token, TOKEN, &launch_params(Pubkey::new_unique()))
        .unwrap();
    // An unchanged copy reaches each instruction's own logic: each answers, or refuses
    // for a reason that is not the account's shape.
    let planted = plant(&mut env, &market, strategy_id(), |_| {});
    for (name, result) in every_instruction(&mut env, &planted, &seeder) {
        let expected: Option<buy_wall_amm::errors::StrategyError> = match name {
            "pipeline_market_info" | "pipeline_resolve_accounts" | "register_existing_market" => {
                None
            }
            "pipeline_quote" => Some(MarketNotOpen),
            "pipeline_swap" => Some(NotPipeline),
            "seed" => Some(NotSeeder),
            other => panic!("{other}"),
        };
        match expected {
            None => result.unwrap_or_else(|e| panic!("{name}: {e}")),
            Some(error) => assert_refused(result, error),
        }
    }
}
