//! A Pipeline strategy for Canary's tests: a two-mint constant-product market with no fee,
//! whose behaviour is chosen once, when the market is created, by [`InitParams::mode`].
//!
//! - [`FAIR`]: every trader is treated alike, at every time.
//! - [`INSIDER_PAID_MORE`] and [`INSIDER_PAID_LESS`]: the wallet named at creation gets a
//!   tenth more or a tenth less output than anyone else, in quotes and swaps alike.
//! - [`LAUNCH_TAX`]: buys of the second mint are taxed by the time since the market was
//!   created: 99% in the first 10 seconds, 50% until 1 minute, 10% until 10 minutes, then
//!   nothing, like a sniper tax.
//! - [`CLOSES`]: every trade is refused once two days have passed since creation.
//! - [`VIRTUAL_RESERVE`]: the first mint's reserve is priced with [`VIRTUAL_RESERVE_A`] added,
//!   as a launch on a virtual quote reserve is, and no trade pays out more of a mint than its
//!   vault really holds.
//! - [`VIRTUAL_RESERVE_UNCAPPED`]: priced as [`VIRTUAL_RESERVE`], but its quote does not cap
//!   the payout at what the output vault really holds, so it quotes sales its swap cannot
//!   pay (the router's transfer out of the vault then fails).
//!
//! Written for these tests from Pipeline's Apache-2.0 strategy interface; nothing in it comes
//! from Pipeline's own programs.

use borsh::{BorshDeserialize, BorshSerialize};
use pipeline_strategy_interface::{self as psi, discriminator, trade_accounts as ix, TradeMode};
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

pub const FAIR: u8 = 0;
pub const INSIDER_PAID_MORE: u8 = 1;
pub const INSIDER_PAID_LESS: u8 = 2;
pub const LAUNCH_TAX: u8 = 3;
pub const CLOSES: u8 = 4;
pub const VIRTUAL_RESERVE: u8 = 5;
pub const VIRTUAL_RESERVE_UNCAPPED: u8 = 6;

/// [`VIRTUAL_RESERVE`]'s virtual reserve of the first mint: 30 SOL, the containment launch's
/// default (`docs/spec/containment-hook.md`).
pub const VIRTUAL_RESERVE_A: u64 = 30_000_000_000;

/// The launch tax: until each number of seconds after creation, this many basis points.
const LAUNCH_TAX_BPS: [(i64, u64); 3] = [(10, 9_900), (60, 5_000), (600, 1_000)];
/// [`CLOSES`] refuses trades after this many seconds.
const CLOSES_AFTER: i64 = 2 * 24 * 60 * 60;

/// Errors, as custom program errors.
const TRADING_CLOSED: u32 = 1;
const EMPTY_POOL: u32 = 2;
const WRONG_STATE: u32 = 3;
const INSUFFICIENT_LIQUIDITY: u32 = 4;

/// The init data a market is created with, inside `pipeline_init_market`'s byte vector.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct InitParams {
    pub mode: u8,
    /// The one wallet [`INSIDER_PAID_MORE`] and [`INSIDER_PAID_LESS`] treat differently.
    pub insider: [u8; 32],
}

/// The market state, at the state PDA `["state", mint_a, mint_b, [mode]]`.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct State {
    pub mints: [[u8; 32]; 2],
    pub vaults: [[u8; 32]; 2],
    pub mode: u8,
    pub insider: [u8; 32],
    pub created_at: i64,
    pub bump: u8,
}

const STATE_LEN: usize = 32 * 4 + 1 + 32 + 8 + 1;

pub fn state_address(program_id: &Pubkey, mint_a: &Pubkey, mint_b: &Pubkey, mode: u8) -> Pubkey {
    Pubkey::find_program_address(
        &[b"state", mint_a.as_ref(), mint_b.as_ref(), &[mode]],
        program_id,
    )
    .0
}

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (tag, rest) = data
        .split_at_checked(8)
        .ok_or(ProgramError::InvalidInstructionData)?;
    match <[u8; 8]>::try_from(tag).unwrap() {
        discriminator::INIT_MARKET => init_market(program_id, accounts, rest),
        discriminator::MARKET_INFO => {
            let state = load(program_id, accounts.first())?;
            let info = psi::MarketInfo {
                mints: state.mints.to_vec(),
                vaults: state.vaults.to_vec(),
                supports_exact_out: false,
            };
            set_return_data(&borsh::to_vec(&info).unwrap());
            Ok(())
        }
        discriminator::RESOLVE_ACCOUNTS => {
            let request: psi::ResolveRequest = decode(rest)?;
            let state = load(program_id, accounts.get(ix::MARKET_STATE))?;
            let output = *state
                .vaults
                .get(request.trade.output_index as usize)
                .ok_or(ProgramError::InvalidArgument)?;
            let result = psi::ResolveResult {
                accounts: vec![psi::AccountRef {
                    address: output,
                    writable: true,
                }],
                complete: true,
            };
            set_return_data(&borsh::to_vec(&result).unwrap());
            Ok(())
        }
        discriminator::QUOTE => {
            let request: psi::TradeRequest = decode(rest)?;
            let state = load(program_id, accounts.get(ix::MARKET_STATE))?;
            let input_vault = accounts.get(ix::INPUT_VAULT).ok_or(missing())?;
            let output_vault = accounts.get(ix::LEN).ok_or(missing())?;
            let trader = request.trader.map(Pubkey::new_from_array);
            let out = output_for(
                &state,
                &request,
                trader.as_ref(),
                balance(input_vault)?,
                balance(output_vault)?,
                request.amount,
            )?;
            let quote = psi::QuoteResult {
                amount_in: request.amount,
                amount_out: out,
            };
            set_return_data(&borsh::to_vec(&quote).unwrap());
            Ok(())
        }
        discriminator::SWAP => swap(program_id, accounts, decode(rest)?),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn missing() -> ProgramError {
    ProgramError::NotEnoughAccountKeys
}

fn decode<T: BorshDeserialize>(data: &[u8]) -> Result<T, ProgramError> {
    T::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
}

fn load(program_id: &Pubkey, account: Option<&AccountInfo>) -> Result<State, ProgramError> {
    let account = account.ok_or(missing())?;
    if account.owner != program_id {
        return Err(ProgramError::Custom(WRONG_STATE));
    }
    let data = account.try_borrow_data()?;
    State::deserialize(&mut &data[..]).map_err(|_| ProgramError::Custom(WRONG_STATE))
}

/// A token account's balance.
fn balance(account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = account.try_borrow_data()?;
    let bytes = data.get(64..72).ok_or(ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
}

/// The output of `amount` arriving in a pool holding `reserve_in` and `reserve_out`, after
/// the market's mode has had its say.
fn output_for(
    state: &State,
    request: &psi::TradeRequest,
    trader: Option<&Pubkey>,
    reserve_in: u64,
    reserve_out: u64,
    amount: u64,
) -> Result<u64, ProgramError> {
    if request.mode != TradeMode::ExactIn {
        return Err(ProgramError::InvalidArgument);
    }
    let now = Clock::get()?.unix_timestamp;
    let elapsed = now.saturating_sub(state.created_at);
    if state.mode == CLOSES && elapsed > CLOSES_AFTER {
        msg!("trading has closed");
        return Err(ProgramError::Custom(TRADING_CLOSED));
    }
    let virtual_of = |index: u8| {
        if matches!(state.mode, VIRTUAL_RESERVE | VIRTUAL_RESERVE_UNCAPPED) && index == 0 {
            VIRTUAL_RESERVE_A
        } else {
            0
        }
    };
    let priced_in = reserve_in + virtual_of(request.input_index);
    let priced_out = reserve_out + virtual_of(request.output_index);
    if priced_in == 0 || priced_out == 0 {
        return Err(ProgramError::Custom(EMPTY_POOL));
    }
    let mut out =
        (amount as u128 * priced_out as u128 / (priced_in as u128 + amount as u128)) as u64;
    if out > reserve_out && state.mode != VIRTUAL_RESERVE_UNCAPPED {
        msg!("the trade would pay out more than the vault holds");
        return Err(ProgramError::Custom(INSUFFICIENT_LIQUIDITY));
    }
    let insider = trader.is_some_and(|t| t.to_bytes() == state.insider);
    match state.mode {
        INSIDER_PAID_MORE if insider => out = (out + out / 10).min(reserve_out - 1),
        INSIDER_PAID_LESS if insider => out -= out / 10,
        LAUNCH_TAX if request.output_index == 1 => {
            if let Some((_, bps)) = LAUNCH_TAX_BPS.iter().find(|(until, _)| elapsed < *until) {
                out -= (out as u128 * *bps as u128 / 10_000) as u64;
            }
        }
        _ => {}
    }
    Ok(out)
}

/// Accounts: market signer, state (w), payer (s, w), system program, mint_a, mint_b,
/// vault_a, vault_b (token accounts the state PDA owns).
fn init_market(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [_signer, state, payer, system_program, mint_a, mint_b, vault_a, vault_b, ..] = accounts
    else {
        return Err(missing());
    };
    // The router passes the creator's init data as a Borsh byte vector.
    let init: Vec<u8> = decode(data)?;
    let params: InitParams = decode(&init)?;
    let seeds: &[&[u8]] = &[
        b"state",
        mint_a.key.as_ref(),
        mint_b.key.as_ref(),
        &[params.mode],
    ];
    let (expected, bump) = Pubkey::find_program_address(seeds, program_id);
    if expected != *state.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let lamports = Rent::get()?.minimum_balance(STATE_LEN);
    let mut create = 0u32.to_le_bytes().to_vec();
    create.extend_from_slice(&lamports.to_le_bytes());
    create.extend_from_slice(&(STATE_LEN as u64).to_le_bytes());
    create.extend_from_slice(program_id.as_ref());
    invoke_signed(
        &Instruction {
            program_id: *system_program.key,
            accounts: vec![
                AccountMeta::new(*payer.key, true),
                AccountMeta::new(*state.key, true),
            ],
            data: create,
        },
        &[payer.clone(), state.clone(), system_program.clone()],
        &[&[
            b"state",
            mint_a.key.as_ref(),
            mint_b.key.as_ref(),
            &[params.mode],
            &[bump],
        ]],
    )?;
    let record = State {
        mints: [mint_a.key.to_bytes(), mint_b.key.to_bytes()],
        vaults: [vault_a.key.to_bytes(), vault_b.key.to_bytes()],
        mode: params.mode,
        insider: params.insider,
        created_at: Clock::get()?.unix_timestamp,
        bump,
    };
    record.serialize(&mut &mut state.try_borrow_mut_data()?[..])?;
    Ok(())
}

fn swap(program_id: &Pubkey, accounts: &[AccountInfo], request: psi::SwapRequest) -> ProgramResult {
    let state_info = accounts.get(ix::MARKET_STATE).ok_or(missing())?;
    let state = load(program_id, Some(state_info))?;
    let output_vault = accounts.get(ix::LEN).ok_or(missing())?;
    let input_vault = &accounts[ix::INPUT_VAULT];
    let trader = accounts[ix::TRADER].key;
    // The router sent the input in just before this call.
    let reserve_in = balance(input_vault)?.saturating_sub(request.amount_sent);
    let out = output_for(
        &state,
        &request.trade,
        Some(trader),
        reserve_in,
        balance(output_vault)?,
        request.amount_sent,
    )?;
    let mint = &accounts[ix::OUTPUT_MINT];
    let decimals = mint.try_borrow_data()?[44];
    let mut data = vec![12u8];
    data.extend_from_slice(&out.to_le_bytes());
    data.push(decimals);
    let destination = &accounts[ix::TRADER_OUTPUT];
    let token_program = &accounts[ix::OUTPUT_TOKEN_PROGRAM];
    invoke_signed(
        &Instruction {
            program_id: *token_program.key,
            accounts: vec![
                AccountMeta::new(*output_vault.key, false),
                AccountMeta::new_readonly(*mint.key, false),
                AccountMeta::new(*destination.key, false),
                AccountMeta::new_readonly(*state_info.key, true),
            ],
            data,
        },
        &[
            output_vault.clone(),
            mint.clone(),
            destination.clone(),
            state_info.clone(),
            token_program.clone(),
        ],
        &[&[
            b"state",
            &state.mints[0],
            &state.mints[1],
            &[state.mode],
            &[state.bump],
        ]],
    )
}
