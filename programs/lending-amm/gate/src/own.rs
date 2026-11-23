//! The market the gate makes of its own on every run, so a cluster with no market still
//! exercises the candidate (the buy wall AMM's `POOL4-53`, made for the lending AMM): in a
//! world holding the router, klend and the lent mints' Kamino accounts (`world::own`), it
//! readies the router as devnet has it, registers the program paying the listing fee, creates
//! a WSOL-lent market through the router with both fee accounts and its first deposit in one
//! transaction, as the demo and Aviary do, and lends its surplus with `rebalance`; then the
//! gate checks it as it checks the cluster's markets, every step counting.
//!
//! The same steps make the markets of the tests' clusters.

use lending_amm::InitParams;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::kamino;
use crate::session::{rebalance_ix, role_key, MarketView, Session, SOL, TOKEN};

/// The gate's own market: a fresh SPL Token mint of 6 decimals, a million of it against
/// `OWN_LENT` lamports of WSOL, at `OWN_LP_FEE_BPS`, the demo market's LP fee.
pub const OWN_OTHER: u64 = 1_000_000_000_000;
pub const OWN_LENT: u64 = 10 * SOL;
pub const OWN_LP_FEE_BPS: u16 = 30;
/// Devnet's listing fee, which the router's config is made with.
pub const LISTING_FEE: u64 = 10_000_000;

/// Readies the router as devnet has it (its config, a 0.01 SOL listing fee), registers the
/// program paying the listing fee, and makes the gate's own market, lending its surplus; the
/// market state, and what was done.
pub fn make_market(session: &mut Session) -> Result<(Pubkey, String), String> {
    ready_router(session)?;
    let market_state = create_market(session, b"own", OWN_LP_FEE_BPS, [OWN_OTHER, OWN_LENT])?;
    let view = session.market(&market_state)?;
    let lent = lend(session, &view)?;
    Ok((
        market_state,
        format!(
            "the router configured, the program registered, the market created through the \
             router with both fee accounts and a first deposit of {OWN_OTHER} and {OWN_LENT} \
             lamports, then rebalanced: {lent}"
        ),
    ))
}

/// The router's config as devnet has it and the program's registration, with the gate's payer
/// as the router's and the program's upgrade authority, as the replay may make it.
pub fn ready_router(session: &mut Session) -> Result<(), String> {
    let payer = session.payer.pubkey();
    for program in [client::PROGRAM_ID, session.program] {
        set_upgrade_authority(session, &program, &payer)?;
    }
    let fee_recipient = role_key(&session.program, b"listing fee", &session.program).pubkey();
    let treasury = role_key(&session.program, b"treasury", &session.program).pubkey();
    let config = client::initialize_config(
        &payer,
        &client::ConfigArgs {
            listing_fee_lamports: LISTING_FEE,
            listing_fee_recipient: fee_recipient,
            treasury_owner: treasury,
        },
    );
    let register = client::register_strategy(
        &payer,
        &payer,
        &session.program,
        &fee_recipient,
        "https://example.com/lending-gate.json",
        LISTING_FEE,
    );
    session
        .send(&[config], &[])
        .map_err(|e| format!("the router's config: {e}"))?;
    session
        .send(&[register], &[])
        .map_err(|e| format!("register_strategy: {e}"))?;
    Ok(())
}

fn set_upgrade_authority(
    session: &mut Session,
    program: &Pubkey,
    authority: &Pubkey,
) -> Result<(), String> {
    let address = pda::program_data(program);
    let mut account = session
        .svm
        .get_account(&address)
        .ok_or_else(|| format!("{program} has no ProgramData"))?;
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    session
        .svm
        .set_account(address, account)
        .map_err(|e| e.to_string())
}

/// Creates a WSOL-lent market through the router's `create_market` with both fee accounts and
/// the first deposit of `amounts` (the other mint, then WSOL) from `add_liquidity`, in one
/// transaction: the other side a fresh SPL Token mint with no authorities at an address derived
/// from `name`, so every replay makes the same market.
pub fn create_market(
    session: &mut Session,
    name: &[u8],
    lp_fee_bps: u16,
    amounts: [u64; 2],
) -> Result<Pubkey, String> {
    let program = session.program;
    let wsol = client::wallet::NATIVE_MINT;
    let other = role_key(&program, b"mint", &pda_of(&program, name)).pubkey();
    write_mint(session, &other, 6, amounts[0])?;
    let mints = [other, wsol];
    let lp = role_key(&program, b"lp", &other);
    session
        .svm
        .airdrop(&lp.pubkey(), 10 * SOL)
        .map_err(|e| format!("{e:?}"))?;
    for (mint, amount) in mints.iter().zip(amounts) {
        pipeline_check::write_token_account(&mut session.svm, mint, &TOKEN, &lp.pubkey(), amount)?;
    }
    let params = InitParams {
        lent_index: 1,
        lp_fee_bps,
    };
    let market_state = Pubkey::find_program_address(
        &[
            lending_amm::state::MARKET_SEED,
            other.as_ref(),
            wsol.as_ref(),
            &lp_fee_bps.to_le_bytes(),
        ],
        &program,
    )
    .0;
    let entry = kamino::entry_of(&wsol).ok_or("WSOL is not a lent mint of this build")?;
    let find = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &program).0;
    let authority = find(&[lending_amm::state::AUTHORITY_SEED, market_state.as_ref()]);
    let vaults = mints.map(|mint| {
        find(&[
            lending_amm::state::VAULT_SEED,
            market_state.as_ref(),
            mint.as_ref(),
        ])
    });
    let ctoken_account = find(&[lending_amm::state::CTOKEN_SEED, market_state.as_ref()]);
    let lp_mint = find(&[lending_amm::state::LP_MINT_SEED, market_state.as_ref()]);
    let init_accounts = vec![
        AccountMeta::new_readonly(mints[0], false),
        AccountMeta::new_readonly(mints[1], false),
        AccountMeta::new_readonly(authority, false),
        AccountMeta::new(vaults[0], false),
        AccountMeta::new(vaults[1], false),
        AccountMeta::new_readonly(kamino::key(&entry.collateral_mint), false),
        AccountMeta::new(ctoken_account, false),
        AccountMeta::new(lp_mint, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(TOKEN, false),
    ];
    let payer = session.payer.pubkey();
    let create = client::create_market(&client::CreateMarket {
        creator: payer,
        strategy_program: program,
        market_state,
        market_state_signs: false,
        init_data: borsh::to_vec(&params).map_err(|e| e.to_string())?,
        max_creator_lamports: SOL,
        strategy_accounts: init_accounts,
    });
    let market = pda::market(&program, &market_state);
    let mut instructions = vec![create];
    instructions.extend(
        mints
            .iter()
            .map(|mint| client::init_fee_account(&payer, &market, mint, &TOKEN)),
    );
    instructions.push(add_liquidity_ix(
        &program,
        &market_state,
        &lp.pubkey(),
        mints,
        vaults,
        authority,
        lp_mint,
        kamino::key(&entry.reserve),
        amounts,
    ));
    session
        .send(&instructions, &[&lp])
        .map_err(|e| format!("create_market with its first deposit: {e}"))?;
    Ok(market_state)
}

/// The program derives `name`'s mint from this address, so markets of different names differ.
fn pda_of(program: &Pubkey, name: &[u8]) -> Pubkey {
    Pubkey::find_program_address(&[b"lending-gate market", name], program).0
}

/// The lending AMM's `add_liquidity` by `lp` from their associated token accounts, in the
/// account order `metadata.json`'s `add_liquidity` action lists, with no minimum of shares.
#[allow(clippy::too_many_arguments)]
pub fn add_liquidity_ix(
    program: &Pubkey,
    market_state: &Pubkey,
    lp: &Pubkey,
    mints: [Pubkey; 2],
    vaults: [Pubkey; 2],
    authority: Pubkey,
    lp_mint: Pubkey,
    reserve: Pubkey,
    max: [u64; 2],
) -> Instruction {
    let mut data = client::instruction_discriminator("add_liquidity").to_vec();
    for value in [max[0], max[1], 0] {
        data.extend_from_slice(&value.to_le_bytes());
    }
    let shares = Pubkey::find_program_address(
        &[
            lending_amm::state::LP_SHARES_SEED,
            market_state.as_ref(),
            lp.as_ref(),
        ],
        program,
    )
    .0;
    let accounts = vec![
        AccountMeta::new(*lp, true),
        AccountMeta::new(*market_state, false),
        AccountMeta::new(pda::associated_token(lp, &mints[0], &TOKEN), false),
        AccountMeta::new(pda::associated_token(lp, &mints[1], &TOKEN), false),
        AccountMeta::new(vaults[0], false),
        AccountMeta::new(vaults[1], false),
        AccountMeta::new_readonly(mints[0], false),
        AccountMeta::new_readonly(mints[1], false),
        AccountMeta::new(lp_mint, false),
        AccountMeta::new(shares, false),
        AccountMeta::new_readonly(authority, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(reserve, false),
    ];
    Instruction::new_with_bytes(*program, &data, accounts)
}

/// `rebalance` by the market's keeper: what it moved.
pub fn lend(session: &mut Session, view: &MarketView) -> Result<String, String> {
    let kamino = kamino::Accounts::in_svm(&session.svm, &view.mints[view.lent])?;
    let keeper: Keypair = session.keeper(&view.market_state)?;
    let ix = rebalance_ix(&session.program, view, &keeper.pubkey(), &kamino);
    session
        .send(&[ix], &[&keeper])
        .map_err(|e| format!("rebalance: {e}"))?;
    let state = session.state(&view.market_state)?;
    // Its buffer holds the whole lent side, far above its band, in a world whose reserve can take
    // it, so a rebalance that leaves it holding no cTokens has not lent: every later step would
    // pass without the market ever lending, or a sale ever redeeming from Kamino.
    if state.ctokens == 0 {
        return Err(format!(
            "rebalance lent nothing: 0 cTokens, a buffer of {}",
            state.reserves[view.lent]
        ));
    }
    Ok(format!(
        "{} cTokens, a buffer of {}",
        state.ctokens, state.reserves[view.lent]
    ))
}

/// An SPL Token mint with no mint or freeze authority and `supply` minted.
fn write_mint(
    session: &mut Session,
    mint: &Pubkey,
    decimals: u8,
    supply: u64,
) -> Result<(), String> {
    let mut data = vec![0u8; 82];
    data[36..44].copy_from_slice(&supply.to_le_bytes());
    data[44] = decimals;
    data[45] = 1;
    let account = solana_account::Account {
        lamports: session.svm.minimum_balance_for_rent_exemption(data.len()),
        data,
        owner: TOKEN,
        executable: false,
        rent_epoch: 0,
    };
    session
        .svm
        .set_account(*mint, account)
        .map_err(|e| e.to_string())
}
