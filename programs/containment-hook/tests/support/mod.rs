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

fn cp_strategy_so() -> Vec<u8> {
    let path =
        crate_dir().join("../../fixtures/pipeline/programs/target/deploy/test_strategy_cp.so");
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Run `scripts/fetch-pipeline.sh` first.",
            path.display()
        )
    })
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
/// authority, and nothing else.
pub fn contained_mint(env: &mut Env) -> Pubkey {
    contained_mint_with(env, MintOptions::default())
}

/// [`contained_mint`] with other mint options, such as a freeze authority.
pub fn contained_mint_with(env: &mut Env, options: MintOptions) -> Pubkey {
    env.create_hooked_mint(&hook_id(), unlock_pda, options)
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
        BindArgs {
            mint_authority: admin,
            payer: admin,
            mint,
            market: market.market,
            market_state: market.market_state,
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

/// Registers Pipeline's constant-product test strategy and creates a market of it trading
/// `mints` (each with its token program), with its fee accounts: a router market on another
/// strategy than the tax AMM.
pub fn cp_market(env: &mut Env, mints: [(Pubkey, Pubkey); 2]) -> Market {
    let cp = cp_strategy_id();
    env.svm.add_program(cp, &cp_strategy_so()).unwrap();
    let admin = env.admin.pubkey();
    let program_data = pda::program_data(&cp);
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
        &cp,
        &config.listing_fee_recipient,
        "https://example.com/metadata.json",
        config.listing_fee_lamports,
    );
    env.send(&[register], &[]).unwrap();

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
    let account = pda::associated_token(owner, mint, &TOKEN_2022);
    let data = [1u8]; // CreateIdempotent
    let create = Instruction::new_with_bytes(
        client::ASSOCIATED_TOKEN_PROGRAM_ID,
        &data,
        vec![
            AccountMeta::new(env.admin.pubkey(), true),
            AccountMeta::new(account, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
    );
    env.send(&[create], &[]).unwrap();
    account
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
