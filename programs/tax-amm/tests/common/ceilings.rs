//! The compute ceilings (docs/spec/tax-amm.md, "Compute ceilings"; docs/spec/README.md, "Test
//! layers" 5): the spec's table, and its one place in the tests. A ceiling changes only by a
//! PR to the spec file and this table together; `tests/compute.rs` checks they agree.
//!
//! A cost is what the tax AMM's own invocation consumes, its token program calls included,
//! measured on mints without a transfer hook. `tests/compute.rs` measures every instruction
//! once on typical markets, and the invariant fuzzer (`tests/fuzz.rs`) measures every
//! instruction it calls, on every market shape it builds, against the same ceilings.

#![allow(dead_code)]

/// The spec's table, in compute units.
pub const PIPELINE_QUOTE: u64 = 25_000;
pub const PIPELINE_SWAP: u64 = 60_000;
pub const PIPELINE_MARKET_INFO: u64 = 15_000;
pub const PIPELINE_RESOLVE_ACCOUNTS: u64 = 15_000;
pub const PIPELINE_INIT_MARKET: u64 = 120_000;
pub const PIPELINE_SEED_LIQUIDITY: u64 = 150_000;
pub const SEED: u64 = 80_000;
pub const DISTRIBUTE: u64 = 90_000;
pub const SET_TAXES: u64 = 20_000;
pub const SET_RECIPIENTS: u64 = 20_000;
pub const RENOUNCE_TAX_AUTHORITY: u64 = 20_000;

/// What a PDA's bump search costs for each bump it tries after the first: one more
/// `create_program_address`.
pub const BUMP_TRY: u64 = 1_500;

/// The compute `distribute` for `slot` will spend searching for the slot wallet's associated
/// token account beyond its first bump, which the ceilings leave out (docs/spec/tax-amm.md,
/// "Compute ceilings"), read from the market as it is before the payout. How many bumps
/// after the first the address takes depends on the wallet; the program derives it once, and
/// the associated token program twice more when the payout creates the account, which it
/// does for a tax recipient or the suite share owed something whose account is missing
/// (measured on 2026-11-12 by the invariant fuzzer, within the few units that comparing keys
/// costs).
pub fn distribute_bump_search(env: &super::Env, market: &super::Market, slot: u8) -> u64 {
    let state = env.tax_market(&market.market_state);
    let side = state.tax_side as usize;
    let (mint, token_program) = (market.mints[side], market.token_programs[side]);
    let wallet = super::slot_wallet(&state, slot);
    let account = pipeline_client::pda::associated_token(&wallet, &mint, &token_program);
    let owed = state.owed.get(slot as usize).copied().unwrap_or(0);
    let creates =
        env.svm.get_account(&account).is_none() && slot != tax_amm::state::BURN_SLOT && owed > 0;
    let (_, bump) = pipeline_client::Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &pipeline_client::ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    let derivations = if creates { 3 } else { 1 };
    (255 - bump as u64) * BUMP_TRY * derivations
}

/// Every instruction of the program, by its name in the IDL, with its ceiling.
pub const ALL: [(&str, u64); 11] = [
    ("pipeline_quote", PIPELINE_QUOTE),
    ("pipeline_swap", PIPELINE_SWAP),
    ("pipeline_market_info", PIPELINE_MARKET_INFO),
    ("pipeline_resolve_accounts", PIPELINE_RESOLVE_ACCOUNTS),
    ("pipeline_init_market", PIPELINE_INIT_MARKET),
    ("pipeline_seed_liquidity", PIPELINE_SEED_LIQUIDITY),
    ("seed", SEED),
    ("distribute", DISTRIBUTE),
    ("set_taxes", SET_TAXES),
    ("set_recipients", SET_RECIPIENTS),
    ("renounce_tax_authority", RENOUNCE_TAX_AUTHORITY),
];

/// The ceiling of the instruction named `name` in the IDL.
pub fn of(name: &str) -> u64 {
    ALL.iter()
        .find(|(instruction, _)| *instruction == name)
        .unwrap_or_else(|| panic!("no compute ceiling for {name}"))
        .1
}
