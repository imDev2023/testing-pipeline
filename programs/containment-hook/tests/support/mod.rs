//! Test setup for the containment hook: the tax AMM's own test support (the real Pipeline
//! router and the tax AMM in LiteSVM), with this program added, and helpers for contained
//! mints, home markets and `bind`.
//!
//! Programs are loaded from files, so build both first:
//! `scripts/build-programs.sh` writes `programs/target/deploy/tax_amm.so` and
//! `containment_hook.so`; `scripts/fetch-router.sh` copies devnet's router. Hostile tests
//! that need a second strategy also load Pipeline's `test_strategy_cp.so`, built by
//! `scripts/fetch-pipeline.sh`.

#![allow(dead_code)]

#[path = "../../../tax-amm/tests/common/mod.rs"]
pub mod common;

pub mod ceilings;

use std::path::PathBuf;

use anchor_lang::{AccountDeserialize, InstructionData};
use containment_hook::{Config, HookError};
use litesvm::types::TransactionMetadata;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;

pub use common::*;

/// A day, in seconds.
pub const DAY: i64 = 24 * 60 * 60;
/// A valid unlock goal: 5 SOL of tax, in lamports.
pub const GOAL: u64 = 5 * SOL;

/// The hook's program address, from its `declare_id!`.
pub fn hook_id() -> Pubkey {
    ck(&containment_hook::ID)
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn deploy_dir() -> PathBuf {
    std::env::var("SBF_OUT_DIR")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("CARGO_TARGET_DIR").map(|dir| PathBuf::from(dir).join("deploy")))
        .unwrap_or_else(|_| crate_dir().join("../target/deploy"))
}

/// The hook's compiled program.
pub fn hook_so() -> Vec<u8> {
    let path = deploy_dir().join("containment_hook.so");
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Build it first: cargo build-sbf --manifest-path programs/containment-hook/Cargo.toml",
            path.display()
        )
    })
}

/// Pipeline's constant-product test strategy, a strategy that is not the tax AMM.
pub fn cp_strategy_id() -> Pubkey {
    "yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx"
        .parse()
        .unwrap()
}

pub fn config_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"config", mint.as_ref()], &hook_id()).0
}

pub fn validation_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], &hook_id()).0
}

pub fn unlock_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"unlock", mint.as_ref()], &hook_id()).0
}

/// A VM with the router configured, the tax AMM registered and the hook deployed.
pub fn hook_env() -> Env {
    let mut env = Env::new();
    env.svm.add_program(hook_id(), &hook_so()).unwrap();
    env
}

/// A contained mint as the launch script creates it: Token-2022, the hook as its transfer
/// hook and its unlock PDA as hook authority, no freeze authority, the admin as mint
/// authority, which `bind` needs and a launch revokes before the seed
/// ([`revoke_mint_authority`]), and nothing else.
pub fn contained_mint(env: &mut Env) -> Pubkey {
    contained_mint_with(env, MintOptions::default())
}

/// [`contained_mint`] with other mint options, such as a freeze authority.
pub fn contained_mint_with(env: &mut Env, options: MintOptions) -> Pubkey {
    let options = MintOptions {
        mint_authority: true,
        ..options
    };
    env.create_hooked_mint(&hook_id(), unlock_pda, options)
}

/// Revokes a mint's mint authority, the admin, as a launch does between `bind` and the seed:
/// the tax AMM's seed refuses a mint that keeps one (docs/spec/tax-amm.md, "Mint rules").
pub fn revoke_mint_authority(env: &mut Env, mint: &Pubkey) {
    use spl_token_2022_interface::instruction::{set_authority, AuthorityType};
    let admin = env.admin.pubkey();
    let revoke = set_authority(
        &TOKEN_2022,
        mint,
        None,
        AuthorityType::MintTokens,
        &admin,
        &[],
    )
    .unwrap();
    env.send(&[revoke], &[]).unwrap();
}

/// A home market for `contained`: a tax market trading it against a new SPL Token quote
/// mint, with the contained mint at `contained_index` and the tax on the quote mint.
pub fn home_market(env: &mut Env, contained: Pubkey, contained_index: usize) -> Market {
    let quote = (env.create_mint(&TOKEN), TOKEN);
    let mut mints = [quote, quote];
    mints[contained_index] = (contained, TOKEN_2022);
    let quote_index = 1 - contained_index as u8;
    let params = quote_taxed_params(&Pubkey::new_unique(), quote_index);
    env.create_tax_market(mints, &params).unwrap()
}

/// A contained mint and its home market, with the contained mint first.
pub fn contained_market(env: &mut Env) -> (Pubkey, Market) {
    let mint = contained_mint(env);
    let market = home_market(env, mint, 0);
    (mint, market)
}

/// The Unix time the VM's clock shows.
pub fn now(env: &Env) -> i64 {
    env.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp
}

/// `bind`'s accounts and arguments.
#[derive(Clone, Debug)]
pub struct BindArgs {
    pub mint_authority: Pubkey,
    pub payer: Pubkey,
    pub mint: Pubkey,
    pub market: Pubkey,
    pub market_state: Pubkey,
    /// The market's other mint, whose transfer hook and authorities `bind` checks.
    pub quote_mint: Pubkey,
    pub unlock_goal: u64,
    pub unlock_deadline: i64,
    /// Accounts after `bind`'s own, which it must ignore.
    pub extra: Vec<AccountMeta>,
}

impl BindArgs {
    /// A valid binding of `mint` to `market`, signed and paid for by the admin, with the
    /// goal [`GOAL`] and a deadline 30 days away.
    pub fn new(env: &Env, mint: Pubkey, market: &Market) -> Self {
        let admin = env.admin.pubkey();
        let quote_mint = if market.mints[0] == mint {
            market.mints[1]
        } else {
            market.mints[0]
        };
        BindArgs {
            mint_authority: admin,
            payer: admin,
            mint,
            market: market.market,
            market_state: market.market_state,
            quote_mint,
            unlock_goal: GOAL,
            unlock_deadline: now(env) + 30 * DAY,
            extra: vec![],
        }
    }
}

/// The `bind` instruction.
pub fn bind_instruction(args: &BindArgs) -> Instruction {
    let data = containment_hook::instruction::Bind {
        unlock_goal: args.unlock_goal,
        unlock_deadline: args.unlock_deadline,
    }
    .data();
    let mut accounts = vec![
        AccountMeta::new_readonly(args.mint_authority, true),
        AccountMeta::new(args.payer, true),
        AccountMeta::new_readonly(args.mint, false),
        AccountMeta::new(config_pda(&args.mint), false),
        AccountMeta::new(validation_pda(&args.mint), false),
        AccountMeta::new_readonly(unlock_pda(&args.mint), false),
        AccountMeta::new_readonly(args.market, false),
        AccountMeta::new_readonly(args.market_state, false),
        AccountMeta::new_readonly(args.quote_mint, false),
        AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
    ];
    accounts.extend(args.extra.iter().cloned());
    Instruction::new_with_bytes(hook_id(), &data, accounts)
}

/// Sends `bind`, paid for by the admin, with `signers` beside it.
pub fn send_bind(
    env: &mut Env,
    args: &BindArgs,
    signers: &[&Keypair],
) -> Result<TransactionMetadata, String> {
    env.send_meta(&[bind_instruction(args)], signers)
}

/// Binds `mint` to `market` with [`BindArgs::new`]'s valid terms.
pub fn bind(env: &mut Env, mint: Pubkey, market: &Market) -> Result<TransactionMetadata, String> {
    let args = BindArgs::new(env, mint, market);
    send_bind(env, &args, &[])
}

/// The config of `mint`, decoded with its discriminator checked.
pub fn config(env: &Env, mint: &Pubkey) -> Config {
    let data = env.svm.get_account(&config_pda(mint)).expect("config").data;
    Config::try_deserialize(&mut data.as_slice()).expect("a config")
}

/// The fee account the router's `init_fee_account` creates for `mint` in `market`.
pub fn fee_account(market: &Market, mint: &Pubkey) -> Pubkey {
    pda::fee_account(&market.market, mint, &TOKEN_2022)
}

/// Fails unless `result` is the hook refusing with `error`: Anchor's error number for it in
/// the transaction error, and its name in the logs.
pub fn assert_hook_refused<T: std::fmt::Debug>(result: Result<T, String>, error: HookError) {
    let name = format!("{error:?}");
    let number = anchor_lang::error::ERROR_CODE_OFFSET + error as u32;
    match result {
        Ok(value) => panic!("expected the hook to refuse with {name}, but it passed: {value:?}"),
        Err(failure) => assert!(
            failure.contains(&format!("Custom({number})"))
                && failure.contains(&format!("Error Code: {name}.")),
            "expected the hook to refuse with {name} ({number}), got:\n{failure}"
        ),
    }
}

/// Pipeline's hostile test strategy, whose markets record whatever vaults their creator
/// names, at the address of the keypair `scripts/fetch-pipeline.sh` builds it with.
pub fn evil_strategy_id() -> Pubkey {
    "DB9tGhQjp8VgK7mLWPmQD2pzQavPzrAU6sTtSC9v8SXD"
        .parse()
        .unwrap()
}

/// Loads one of Pipeline's test strategies at `id` from its compiled `name.so`, makes the
/// admin its upgrade authority and registers it with the router.
pub fn register_test_strategy(env: &mut Env, id: &Pubkey, name: &str) {
    let path = crate_dir().join(format!(
        "../../fixtures/pipeline/programs/target/deploy/{name}.so"
    ));
    let so = std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Run `scripts/fetch-pipeline.sh` first.",
            path.display()
        )
    });
    env.svm.add_program(*id, &so).unwrap();
    let admin = env.admin.pubkey();
    let program_data = pda::program_data(id);
    let mut account = env.svm.get_account(&program_data).expect("program data");
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(admin.as_ref());
    env.svm.set_account(program_data, account).unwrap();
    let config = client::decode_config(
        &env.svm
            .get_account(&pda::config())
            .expect("router config")
            .data,
    )
    .unwrap();
    let register = client::register_strategy(
        &admin,
        &admin,
        id,
        &config.listing_fee_recipient,
        "https://example.com/metadata.json",
        config.listing_fee_lamports,
    );
    env.send(&[register], &[]).unwrap();
}

/// Registers Pipeline's constant-product test strategy and creates a market of it trading
/// `mints` (each with its token program), with its fee accounts: a router market on another
/// strategy than the tax AMM.
pub fn cp_market(env: &mut Env, mints: [(Pubkey, Pubkey); 2]) -> Market {
    let cp = cp_strategy_id();
    register_test_strategy(env, &cp, "test_strategy_cp");
    let admin = env.admin.pubkey();

    let fee_bps: u16 = 30;
    let mint_keys = [mints[0].0, mints[1].0];
    let token_programs = [mints[0].1, mints[1].1];
    let pool = Pubkey::find_program_address(
        &[
            b"pool",
            mint_keys[0].as_ref(),
            mint_keys[1].as_ref(),
            &fee_bps.to_le_bytes(),
        ],
        &cp,
    )
    .0;
    let vaults = [0, 1].map(|i| pda::associated_token(&pool, &mint_keys[i], &token_programs[i]));
    let accounts = vec![
        AccountMeta::new_readonly(mint_keys[0], false),
        AccountMeta::new_readonly(mint_keys[1], false),
        AccountMeta::new(vaults[0], false),
        AccountMeta::new(vaults[1], false),
        AccountMeta::new_readonly(token_programs[0], false),
        AccountMeta::new_readonly(token_programs[1], false),
        AccountMeta::new_readonly(client::ASSOCIATED_TOKEN_PROGRAM_ID, false),
    ];
    let create = client::create_market(&client::CreateMarket {
        creator: admin,
        strategy_program: cp,
        market_state: pool,
        market_state_signs: false,
        init_data: fee_bps.to_le_bytes().to_vec(),
        max_creator_lamports: SOL,
        strategy_accounts: accounts,
    });
    let market = pda::market(&cp, &pool);
    let fees = (0..2)
        .map(|i| client::init_fee_account(&admin, &market, &mint_keys[i], &token_programs[i]));
    let instructions: Vec<Instruction> = std::iter::once(create).chain(fees).collect();
    let created = env.send_meta(&instructions, &[]).unwrap();
    Market {
        market,
        market_state: pool,
        authority: pool,
        mints: mint_keys,
        token_programs,
        vaults,
        created,
    }
}

/// Copies `address`'s account to a new address, owned by `owner`: how the tests make an
/// account hold exactly the bytes of a real one somewhere it does not belong.
pub fn copy_account(env: &mut Env, address: &Pubkey, owner: &Pubkey) -> Pubkey {
    let mut account = env.svm.get_account(address).expect("account to copy");
    account.owner = *owner;
    let copy = Pubkey::new_unique();
    env.svm.set_account(copy, account).unwrap();
    copy
}

/// Rewrites the account at `address` in place with `edit`.
pub fn edit_account(
    env: &mut Env,
    address: &Pubkey,
    edit: impl FnOnce(&mut solana_account::Account),
) {
    let mut account = env.svm.get_account(address).expect("account to edit");
    edit(&mut account);
    env.svm.set_account(*address, account).unwrap();
}

/// A wallet's associated token account for a Token-2022 mint, created by the admin.
pub fn token_2022_account(env: &mut Env, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let create = create_token_account_idempotent(&env.admin.pubkey(), owner, mint, &TOKEN_2022);
    env.send(&[create], &[]).unwrap();
    pda::associated_token(owner, mint, &TOKEN_2022)
}

/// Mints `amount` of a Token-2022 `mint` into `account`, signed by the admin as mint
/// authority. Minting never calls a transfer hook.
pub fn mint_to(env: &mut Env, mint: &Pubkey, account: &Pubkey, amount: u64) -> Result<(), String> {
    let instruction = spl_token_2022_interface::instruction::mint_to(
        &TOKEN_2022,
        mint,
        account,
        &env.admin.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    env.send(&[instruction], &[]).map(|_| ())
}

/// Credits `amount` of a contained `mint` to `account` after its launch, when nobody can
/// mint it any more: the balance and the supply written straight into the VM, standing in
/// for tokens bought through the home market, which tests that are not about the buy need
/// in accounts the home market never pays.
pub fn credit(env: &mut Env, mint: &Pubkey, account: &Pubkey, amount: u64) {
    let balance = env.balance(account);
    let mut token = env.svm.get_account(account).unwrap();
    token.data[64..72].copy_from_slice(&(balance + amount).to_le_bytes());
    env.svm.set_account(*account, token).unwrap();
    let supply = env.supply(mint);
    env.set_supply(mint, supply + amount);
}

/// The hook accounts every transfer of a contained token passes, after Token-2022's own:
/// the hook program, the validation account and the config, read-only
/// (docs/spec/containment-hook.md, "Hook accounts callers must pass").
pub fn hook_tail(mint: &Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(hook_id(), false),
        AccountMeta::new_readonly(validation_pda(mint), false),
        AccountMeta::new_readonly(config_pda(mint), false),
    ]
}

/// A Token-2022 `transfer_checked` of `amount` (6 decimals) from `source`, owned by
/// `owner`, to `destination`, with `tail` after its own accounts.
pub fn transfer_checked(
    mint: &Pubkey,
    source: &Pubkey,
    destination: &Pubkey,
    owner: &Pubkey,
    amount: u64,
    tail: Vec<AccountMeta>,
) -> Instruction {
    let mut instruction = spl_token_2022_interface::instruction::transfer_checked(
        &TOKEN_2022,
        source,
        mint,
        destination,
        owner,
        &[],
        amount,
        6,
    )
    .unwrap();
    instruction.accounts.extend(tail);
    instruction
}

/// What a launched contained token looks like in the tests: its mint, its home market with
/// the contained mint at index 0 and an SPL Token quote mint at index 1, taxed in the quote
/// mint, bound and seeded through the hook tail by `seeder`, who also holds the rest of the
/// supply.
pub struct Launched {
    pub mint: Pubkey,
    pub quote: Pubkey,
    pub market: Market,
    pub seeder: Keypair,
    /// The seeder's associated token account for the contained mint.
    pub holder: Pubkey,
}

/// The contained token's index in a [`Launched`] home market, and the quote mint's.
pub const CONTAINED: usize = 0;
pub const QUOTE: usize = 1;
/// What [`launch`] mints and seeds.
pub const SUPPLY: u64 = 1_000_000_000_000_000;
pub const SEED: [u64; 2] = [500_000_000_000_000, 100_000_000_000];

/// How [`launch_with`] departs from [`launch`]: the unlock terms and the home market's tax
/// authority.
#[derive(Clone, Copy, Debug)]
pub struct LaunchOptions {
    pub unlock_goal: u64,
    /// The unlock deadline, in seconds after the binding.
    pub deadline_after: i64,
    /// The home market's tax authority; a key nobody holds when `None`.
    pub tax_authority: Option<Pubkey>,
}

impl Default for LaunchOptions {
    /// [`BindArgs::new`]'s terms: the goal [`GOAL`] and a deadline 30 days away.
    fn default() -> Self {
        LaunchOptions {
            unlock_goal: GOAL,
            deadline_after: 30 * DAY,
            tax_authority: None,
        }
    }
}

/// Launches a contained token as the launch script does: the mint, the home market with its
/// fee accounts, `bind`, the supply minted to the seeder (minting never calls the hook), the
/// mint authority revoked, then the tax AMM's `seed` with the hook tail after its own
/// accounts.
pub fn launch(env: &mut Env) -> Launched {
    launch_with(env, LaunchOptions::default())
}

/// [`launch`] with other unlock terms or a tax authority.
pub fn launch_with(env: &mut Env, options: LaunchOptions) -> Launched {
    let mint = contained_mint(env);
    let quote = env.create_mint(&TOKEN);
    let seeder = Keypair::new();
    env.svm.airdrop(&seeder.pubkey(), SOL).unwrap();
    let mut params = quote_taxed_params(&seeder.pubkey(), QUOTE as u8);
    if let Some(authority) = options.tax_authority {
        params.tax_authority = ak(&authority);
    }
    let market = env
        .create_tax_market([(mint, TOKEN_2022), (quote, TOKEN)], &params)
        .unwrap();
    let mut args = BindArgs::new(env, mint, &market);
    args.unlock_goal = options.unlock_goal;
    args.unlock_deadline = now(env) + options.deadline_after;
    send_bind(env, &args, &[]).unwrap();
    let holder = token_2022_account(env, &seeder.pubkey(), &mint);
    mint_to(env, &mint, &holder, SUPPLY).unwrap();
    revoke_mint_authority(env, &mint);
    env.write_token_account(&quote, &TOKEN, &seeder.pubkey(), SEED[QUOTE]);
    env.seed_with(&market, &seeder, SEED, hook_tail(&mint))
        .unwrap();
    assert_eq!(env.balance(&market.vaults[CONTAINED]), SEED[CONTAINED]);
    Launched {
        mint,
        quote,
        market,
        seeder,
        holder,
    }
}

/// A wallet with SOL, `quote_amount` of the quote mint and an empty associated token account
/// for the contained mint, created by Token-2022 itself.
pub fn trader(env: &mut Env, launched: &Launched, quote_amount: u64) -> Keypair {
    let wallet = Keypair::new();
    env.svm.airdrop(&wallet.pubkey(), SOL).unwrap();
    env.write_token_account(&launched.quote, &TOKEN, &wallet.pubkey(), quote_amount);
    token_2022_account(env, &wallet.pubkey(), &launched.mint);
    wallet
}

/// The associated token account of `owner` for the contained mint.
pub fn contained_account(launched: &Launched, owner: &Pubkey) -> Pubkey {
    pda::associated_token(owner, &launched.mint, &TOKEN_2022)
}

/// The router's `swap` of a [`Launched`] market as a terminal builds it with the hook tail:
/// the strategy accounts resolved by the tax AMM, the hook tail after them when the contained
/// token is the output (a buy), and the hook tail as `input_hook_accounts` when it is the
/// input (a sell). `output_to` replaces the trader's own output account, and the integrator
/// fee is paid into `integrator` at `integrator_fee_bps`.
#[derive(Clone, Debug, Default)]
pub struct Swap {
    pub output_to: Option<Pubkey>,
    pub integrator: Option<Pubkey>,
    pub integrator_fee_bps: u16,
    /// Leaves the hook tail out.
    pub without_tail: bool,
}

pub fn swap_instruction(
    env: &Env,
    launched: &Launched,
    trader: &Pubkey,
    (input, output): (usize, usize),
    amount_in: u64,
    options: &Swap,
) -> Instruction {
    let market = &launched.market;
    let tail = if options.without_tail {
        vec![]
    } else {
        hook_tail(&launched.mint)
    };
    let mut strategy_accounts = env
        .resolve_accounts(market, &exact_in(input, output, amount_in))
        .unwrap();
    let mut input_hook_accounts = vec![];
    if output == CONTAINED {
        strategy_accounts.extend(tail);
    } else {
        input_hook_accounts = tail;
    }
    let accounts = client::SwapAccounts {
        trader: *trader,
        strategy_program: strategy_id(),
        market_state: market.market_state,
        trader_input: pda::associated_token(
            trader,
            &market.mints[input],
            &market.token_programs[input],
        ),
        trader_output: options.output_to.unwrap_or_else(|| {
            pda::associated_token(
                trader,
                &market.mints[output],
                &market.token_programs[output],
            )
        }),
        input_vault: market.vaults[input],
        input_mint: market.mints[input],
        output_mint: market.mints[output],
        input_token_program: market.token_programs[input],
        output_token_program: market.token_programs[output],
        integrator_fee_account: options.integrator,
        strategy_accounts,
        input_hook_accounts,
    };
    let args = client::SwapArgs {
        mode: client::TradeMode::ExactIn,
        amount_in,
        amount_out: 0,
        min_amount_out: 0,
        integrator_fee_bps: options.integrator_fee_bps,
        input_hook_accounts: 0,
        extra: vec![],
    };
    client::swap(&accounts, &args)
}

/// Sends [`swap_instruction`], signed by `trader`.
pub fn swap(
    env: &mut Env,
    launched: &Launched,
    trader: &Keypair,
    direction: (usize, usize),
    amount_in: u64,
    options: &Swap,
) -> Result<TransactionMetadata, String> {
    let instruction = swap_instruction(
        env,
        launched,
        &trader.pubkey(),
        direction,
        amount_in,
        options,
    );
    env.send_meta(&[instruction], &[trader])
}

/// A buy of the contained token with `amount_in` of the quote mint.
pub fn buy(
    env: &mut Env,
    launched: &Launched,
    trader: &Keypair,
    amount_in: u64,
) -> client::SwapResult {
    let meta = swap(
        env,
        launched,
        trader,
        (QUOTE, CONTAINED),
        amount_in,
        &Swap::default(),
    )
    .unwrap();
    borsh::from_slice(&meta.return_data.data).unwrap()
}

/// A sell of `amount_in` of the contained token for the quote mint.
pub fn sell(
    env: &mut Env,
    launched: &Launched,
    trader: &Keypair,
    amount_in: u64,
) -> client::SwapResult {
    let meta = swap(
        env,
        launched,
        trader,
        (CONTAINED, QUOTE),
        amount_in,
        &Swap::default(),
    )
    .unwrap();
    borsh::from_slice(&meta.return_data.data).unwrap()
}

/// The router's treasury owner, from its config.
pub fn treasury_owner(env: &Env) -> Pubkey {
    client::decode_config(
        &env.svm
            .get_account(&pda::config())
            .expect("router config")
            .data,
    )
    .unwrap()
    .treasury_owner
}

/// The router's `sweep_fees` of the home market's contained-token fee account into the
/// treasury owner's associated token account, with `tail` as its remaining accounts.
pub fn sweep_fees_instruction(
    launched: &Launched,
    treasury_owner: &Pubkey,
    tail: Vec<AccountMeta>,
) -> Instruction {
    client::sweep_fees(
        &launched.market.market,
        &launched.mint,
        &TOKEN_2022,
        treasury_owner,
        tail,
    )
}

/// How many times the hook ran in a transaction, and at which call depths, from its logs.
pub fn hook_depths(logs: &[String]) -> Vec<u32> {
    let prefix = format!("Program {} invoke [", hook_id());
    logs.iter()
        .filter_map(|line| line.strip_prefix(&prefix))
        .map(|rest| rest.trim_end_matches(']').parse().unwrap())
        .collect()
}

/// The compute units each invocation of the hook consumed, in order, from a transaction's
/// logs.
pub fn hook_compute(logs: &[String]) -> Vec<u64> {
    let prefix = format!("Program {} consumed ", hook_id());
    logs.iter()
        .filter_map(|line| line.strip_prefix(&prefix))
        .map(|rest| rest.split(' ').next().unwrap().parse().unwrap())
        .collect()
}

/// A Token-2022 token account of `mint` owned by `owner` at a new keypair's address rather
/// than the associated one, sized for the transfer hook account extension Token-2022 adds
/// for a hooked mint: how a holder gets a second account of their own.
pub fn second_token_account(env: &mut Env, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    second_token_account_at(env, &Keypair::new(), owner, mint)
}

/// [`second_token_account`] at `account`'s address.
pub fn second_token_account_at(
    env: &mut Env,
    account: &Keypair,
    owner: &Pubkey,
    mint: &Pubkey,
) -> Pubkey {
    use spl_token_2022_interface::extension::ExtensionType;
    let space =
        ExtensionType::try_calculate_account_len::<spl_token_2022_interface::state::Account>(&[
            ExtensionType::TransferHookAccount,
        ])
        .unwrap();
    let mut create = 0u32.to_le_bytes().to_vec();
    create.extend_from_slice(
        &env.svm
            .minimum_balance_for_rent_exemption(space)
            .to_le_bytes(),
    );
    create.extend_from_slice(&(space as u64).to_le_bytes());
    create.extend_from_slice(TOKEN_2022.as_ref());
    let create = Instruction::new_with_bytes(
        client::SYSTEM_PROGRAM_ID,
        &create,
        vec![
            AccountMeta::new(env.admin.pubkey(), true),
            AccountMeta::new(account.pubkey(), true),
        ],
    );
    let initialize = spl_token_2022_interface::instruction::initialize_account3(
        &TOKEN_2022,
        &account.pubkey(),
        mint,
        owner,
    )
    .unwrap();
    env.send(&[create, initialize], &[account]).unwrap();
    account.pubkey()
}

/// The hook's `Execute` instruction with its six accounts, in the order Token-2022 passes
/// them: source, mint, destination, owner, validation account, config.
pub fn execute_instruction(
    source: Pubkey,
    mint: Pubkey,
    destination: Pubkey,
    owner: Pubkey,
    validation: Pubkey,
    config: Pubkey,
) -> Instruction {
    let mut data = containment_hook::state::EXECUTE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&1_000_000u64.to_le_bytes());
    let accounts = [source, mint, destination, owner, validation, config]
        .into_iter()
        .map(|key| AccountMeta::new_readonly(key, false))
        .collect();
    Instruction::new_with_bytes(hook_id(), &data, accounts)
}

/// The `unlock` instruction for `mint`, with `market_state` as the home market's state.
pub fn unlock_instruction(mint: &Pubkey, market_state: &Pubkey) -> Instruction {
    let data = containment_hook::instruction::Unlock {}.data();
    let accounts = vec![
        AccountMeta::new(*mint, false),
        AccountMeta::new(config_pda(mint), false),
        AccountMeta::new_readonly(unlock_pda(mint), false),
        AccountMeta::new_readonly(*market_state, false),
        AccountMeta::new_readonly(TOKEN_2022, false),
    ];
    Instruction::new_with_bytes(hook_id(), &data, accounts)
}

/// A wallet with SOL and no tie to any token: it holds none, minted none, bound none and
/// owns no market.
pub fn stranger(env: &mut Env) -> Keypair {
    let wallet = Keypair::new();
    env.svm.airdrop(&wallet.pubkey(), SOL).unwrap();
    wallet
}

/// Sends `instructions` signed and paid for by `payer` alone.
pub fn send_as(
    env: &mut Env,
    payer: &Keypair,
    instructions: &[Instruction],
) -> Result<TransactionMetadata, String> {
    env.svm.expire_blockhash();
    let tx = solana_transaction::Transaction::new_signed_with_payer(
        instructions,
        Some(&payer.pubkey()),
        &[payer],
        env.svm.latest_blockhash(),
    );
    env.svm
        .send_transaction(tx)
        .map_err(|failed| format!("{:?}\n{}", failed.err, failed.meta.logs.join("\n")))
}

/// Sends `unlock` for a [`Launched`] token from a fresh [`stranger`], with the market state
/// recorded at binding.
pub fn unlock(env: &mut Env, launched: &Launched) -> Result<TransactionMetadata, String> {
    let caller = stranger(env);
    let instruction = unlock_instruction(&launched.mint, &launched.market.market_state);
    send_as(env, &caller, &[instruction])
}

/// Sets the VM's clock to the Unix time `unix_timestamp`, leaving the rest of it alone.
pub fn warp_to(env: &mut Env, unix_timestamp: i64) {
    let mut clock = env.svm.get_sysvar::<solana_clock::Clock>();
    clock.unix_timestamp = unix_timestamp;
    env.svm.set_sysvar(&clock);
}

/// The mint's transfer hook authority and program, each `None` when unset; `None` when the
/// mint has no transfer hook extension.
pub fn mint_hook(env: &Env, mint: &Pubkey) -> Option<containment_hook::mint::TransferHook> {
    let data = env.svm.get_account(mint).expect("mint").data;
    containment_hook::mint::read_mint(&data)
        .expect("a mint")
        .transfer_hook
}
