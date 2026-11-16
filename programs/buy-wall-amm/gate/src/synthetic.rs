//! The synthetic layout fixture (`POOL4-20`): until devnet has a market of ours, layout
//! version 1 is represented by markets made in a LiteSVM run through the real router, then
//! snapshotted exactly as a cluster is, through pipeline-check's cloning from that LiteSVM.
//!
//! Two markets, so the gate meets a market with every keeper job due and one with none:
//!
//! - market A, an SPL Token at IMD's launch values, is the worked example's market traded on
//!   past its first wall and settlement: an hour after the seed a buy of 1 SOL, a minute
//!   later the sell of what it bought (trimmed), the wall placed, the retired tokens settled,
//!   then an hour on a buy of 3 SOL and a minute later its sell (trimmed again). It is left
//!   with a wall placed, idle SOL past `WALL_THRESHOLD`, tokens retired, rewards owed and
//!   fees in slots 0, 1 and 2, so `place_wall`, `settle`, `pay_rewards` and `sweep_fees`
//!   slots 0 and 2 are due (slot 1 waits for `DESIGNER_RECIPIENT`);
//! - market B, a Token-2022 token with other parameters (a 2.5% fee all to the wall, no
//!   rewards, the ratchet off), is only seeded, so nothing is due.

use borsh::BorshSerialize;
use buy_wall_amm::InitParams;
use litesvm::LiteSVM;
use pipeline_check::SvmSource;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::download;
use crate::keeper::{self, Job};
use crate::session::{spendable, MarketView, Session, SOL, TOKEN, TOKEN_2022, WSOL};
use crate::snapshot::Snapshot;

/// The clock the run starts at: devnet's slot and time on 2026-11-16, roughly.
const START_SLOT: u64 = 523_000_000;
const START_TIME: i64 = 1_763_280_000;
const EPOCH: u64 = 1_210;

pub const NOTE: &str = "Layout version 1, synthetic (POOL4-20): two markets made by a LiteSVM run \
through devnet's router (gate/src/synthetic.rs), until the devnet deploy saves one from a real \
market.";

/// Builds the markets with `build` as the program and `router` as the router, and returns
/// their snapshot, without the programs, as the repo keeps it.
pub fn build(build: &[u8], router: &[u8]) -> Result<Snapshot, String> {
    let program = crate::programs::program_id();
    let mut session = setup(build, router, program)?;
    let admin = Keypair::new();
    session
        .svm
        .airdrop(&admin.pubkey(), 1_000 * SOL)
        .map_err(|e| format!("{e:?}"))?;

    // Market A: the worked example's market, traded on.
    let token_a = mint(&mut session, &admin, TOKEN)?;
    let params_a = InitParams {
        fee_bps: 100,
        wall_split_bps: 5_000,
        fee_recipient: anchor(Pubkey::new_unique()),
        reward_share_bps: 1_500,
        rewards_recipient: anchor(Pubkey::new_unique()),
        cap_floor_bps: 2_000,
        cap_decay_bps: 2_000,
        seeder: anchor(admin.pubkey()),
    };
    let a = create_and_seed(
        &mut session,
        &admin,
        token_a,
        TOKEN,
        &params_a,
        1_000_000_000_000,
        10 * SOL,
    )?;
    later(&mut session, 3_600);
    let bought = swap(&mut session, &a, true, SOL)?;
    later(&mut session, 60);
    swap(&mut session, &a, false, spendable(bought))?;
    job(&mut session, &a, Job::PlaceWall)?;
    job(&mut session, &a, Job::Settle)?;
    later(&mut session, 3_600);
    let bought = swap(&mut session, &a, true, 3 * SOL)?;
    later(&mut session, 60);
    swap(&mut session, &a, false, spendable(bought))?;

    // Market B: a Token-2022 token, only seeded.
    let token_b = mint(&mut session, &admin, TOKEN_2022)?;
    let params_b = InitParams {
        fee_bps: 250,
        wall_split_bps: 10_000,
        fee_recipient: anchor(Pubkey::default()),
        reward_share_bps: 0,
        rewards_recipient: anchor(Pubkey::default()),
        cap_floor_bps: 5_000,
        cap_decay_bps: 0,
        seeder: anchor(admin.pubkey()),
    };
    let b = create_and_seed(
        &mut session,
        &admin,
        token_b,
        TOKEN_2022,
        &params_b,
        500_000_000_000_000,
        5 * SOL,
    )?;
    later(&mut session, 600);

    let mut source = SvmSource::new(session.svm);
    download::snapshot(
        &mut source,
        &program,
        &[a.market_state, b.market_state],
        None,
        true,
        NOTE,
    )?
    .without_programs()
}

fn anchor(key: Pubkey) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(key.to_bytes())
}

/// A LiteSVM with the router configured as on devnet (a 0.01 SOL listing fee) and the
/// program deployed and registered, at the starting clock.
fn setup(build: &[u8], router: &[u8], program: Pubkey) -> Result<Session, String> {
    let mut svm = LiteSVM::new();
    svm.warp_to_slot(START_SLOT);
    let mut clock: solana_clock::Clock = svm.get_sysvar();
    clock.epoch = EPOCH;
    clock.leader_schedule_epoch = EPOCH + 1;
    clock.unix_timestamp = START_TIME;
    clock.epoch_start_timestamp = START_TIME;
    svm.set_sysvar(&clock);
    svm.add_program(client::PROGRAM_ID, router)
        .map_err(|e| format!("the router does not load: {e}"))?;
    svm.add_program(program, build)
        .map_err(|e| format!("the build does not load: {e}"))?;
    // The wrapped SOL mint, as every cluster has it.
    let mut data = vec![0u8; 82];
    data[44] = 9;
    data[45] = 1;
    let lamports = svm.minimum_balance_for_rent_exemption(82);
    svm.set_account(WSOL, account(lamports, data, TOKEN))
        .map_err(|e| e.to_string())?;

    let mut session = Session::new(svm, program);
    let admin = session.payer.pubkey();
    set_upgrade_authority(&mut session.svm, &client::PROGRAM_ID, &admin)?;
    set_upgrade_authority(&mut session.svm, &program, &admin)?;
    let fee_recipient = Pubkey::new_unique();
    let config = client::initialize_config(
        &admin,
        &client::ConfigArgs {
            listing_fee_lamports: 10_000_000,
            listing_fee_recipient: fee_recipient,
            treasury_owner: Pubkey::new_unique(),
        },
    );
    let register = client::register_strategy(
        &admin,
        &admin,
        &program,
        &fee_recipient,
        "https://example.com/metadata.json",
        10_000_000,
    );
    session.send(&[config], &[])?;
    session.send(&[register], &[])?;
    Ok(session)
}

fn account(lamports: u64, data: Vec<u8>, owner: Pubkey) -> solana_account::Account {
    solana_account::Account {
        lamports,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

/// Writes `authority` into a program's ProgramData header, as if it had deployed it.
fn set_upgrade_authority(
    svm: &mut LiteSVM,
    program: &Pubkey,
    authority: &Pubkey,
) -> Result<(), String> {
    let address = pda::program_data(program);
    let mut account = svm
        .get_account(&address)
        .ok_or_else(|| format!("{program} has no ProgramData"))?;
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(address, account).map_err(|e| e.to_string())
}

/// A 6-decimal mint of `token_program` with `admin` as its mint authority and no freeze
/// authority.
fn mint(session: &mut Session, admin: &Keypair, token_program: Pubkey) -> Result<Pubkey, String> {
    use spl_token_2022_interface::instruction::initialize_mint2;
    let mint = Keypair::new();
    let lamports = session.svm.minimum_balance_for_rent_exemption(82);
    let create = system_create_account(
        &admin.pubkey(),
        &mint.pubkey(),
        lamports,
        82,
        &token_program,
    );
    let init = initialize_mint2(&token_program, &mint.pubkey(), &admin.pubkey(), None, 6)
        .map_err(|e| e.to_string())?;
    session.send(&[create, init], &[admin, &mint])?;
    Ok(mint.pubkey())
}

fn system_create_account(
    from: &Pubkey,
    to: &Pubkey,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
) -> Instruction {
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction::new_with_bytes(
        client::SYSTEM_PROGRAM_ID,
        &data,
        vec![AccountMeta::new(*from, true), AccountMeta::new(*to, true)],
    )
}

/// Mints `tokens` to `admin` and gives it `lamports` of wrapped SOL, removes the mint
/// authority, then creates the market from the `init` form with both fee accounts and seeds
/// it through the `seed` action, in one transaction, as a creator would.
fn create_and_seed(
    session: &mut Session,
    admin: &Keypair,
    token_mint: Pubkey,
    token_program: Pubkey,
    params: &InitParams,
    tokens: u64,
    lamports: u64,
) -> Result<MarketView, String> {
    use spl_token_2022_interface::instruction::{mint_to, set_authority, AuthorityType};
    let owner = admin.pubkey();
    pipeline_check::write_token_account(&mut session.svm, &token_mint, &token_program, &owner, 0)?;
    pipeline_check::write_token_account(&mut session.svm, &WSOL, &TOKEN, &owner, lamports)?;
    let to = pda::associated_token(&owner, &token_mint, &token_program);
    let mint = mint_to(&token_program, &token_mint, &to, &owner, &[], tokens)
        .map_err(|e| e.to_string())?;
    let revoke = set_authority(
        &token_program,
        &token_mint,
        None,
        AuthorityType::MintTokens,
        &owner,
        &[],
    )
    .map_err(|e| e.to_string())?;
    session.send(&[mint, revoke], &[admin])?;

    let market_state = Keypair::new();
    let program = session.program;
    let pdas = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &program).0;
    let ms = market_state.pubkey();
    let vault_authority = pdas(&[b"authority", ms.as_ref()]);
    let token_vault = pdas(&[b"vault", ms.as_ref(), token_mint.as_ref()]);
    let sol_vault = pdas(&[b"vault", ms.as_ref(), WSOL.as_ref()]);
    let market = pda::market(&program, &ms);
    let mut init_data = vec![];
    params
        .serialize(&mut init_data)
        .map_err(|e| e.to_string())?;
    let create = client::create_market(&client::CreateMarket {
        creator: session.payer.pubkey(),
        strategy_program: program,
        market_state: ms,
        market_state_signs: true,
        init_data,
        max_creator_lamports: SOL,
        strategy_accounts: vec![
            AccountMeta::new_readonly(token_mint, false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new_readonly(vault_authority, false),
            AccountMeta::new(token_vault, false),
            AccountMeta::new(sol_vault, false),
            AccountMeta::new_readonly(token_program, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
    });
    let payer = session.payer.pubkey();
    let fee_accounts = [(token_mint, token_program), (WSOL, TOKEN)]
        .map(|(mint, program)| client::init_fee_account(&payer, &market, &mint, &program));
    let mut seed_data = client::instruction_discriminator("seed").to_vec();
    seed_data.extend_from_slice(&tokens.to_le_bytes());
    seed_data.extend_from_slice(&lamports.to_le_bytes());
    let seed = Instruction::new_with_bytes(
        program,
        &seed_data,
        vec![
            AccountMeta::new_readonly(owner, true),
            AccountMeta::new(ms, false),
            AccountMeta::new(to, false),
            AccountMeta::new(pda::associated_token(&owner, &WSOL, &TOKEN), false),
            AccountMeta::new(token_vault, false),
            AccountMeta::new(sol_vault, false),
            AccountMeta::new_readonly(token_mint, false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new_readonly(token_program, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
    );
    let mut instructions = vec![create];
    instructions.extend(fee_accounts);
    instructions.push(seed);
    session.send(&instructions, &[admin, &market_state])?;
    session.market(&ms)
}

/// Moves the clock `seconds` on, with slots to match.
fn later(session: &mut Session, seconds: i64) {
    let mut clock: solana_clock::Clock = session.svm.get_sysvar();
    session
        .svm
        .warp_to_slot(clock.slot + seconds as u64 * 5 / 2 + 1);
    clock = session.svm.get_sysvar();
    clock.unix_timestamp += seconds;
    session.svm.set_sysvar(&clock);
}

/// A buy (`buy`) of `amount` lamports, or a sell of `amount` units by the last buyer, at its
/// quote; what the trader received.
fn swap(session: &mut Session, view: &MarketView, buy: bool, amount: u64) -> Result<u64, String> {
    let (token, sol) = view.sides()?;
    let (input, output) = if buy { (sol, token) } else { (token, sol) };
    let resolved = session.resolve(view, input, output, amount)?;
    let trader = if buy {
        session.trader(view, amount * 2)?
    } else {
        session.held_trader().ok_or("nobody bought")?
    };
    let result = session.swap(view, &trader, input, output, amount, 0, &resolved)?;
    session.keep_trader(trader);
    Ok(result.received)
}

fn job(session: &mut Session, view: &MarketView, job: Job) -> Result<(), String> {
    let state = session.state(&view.market_state)?;
    keeper::run(session, view, &state, job).map(|_| ())
}
