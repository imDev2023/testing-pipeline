//! The token accounts Canary writes for the wallets it trades as: each one exactly what the
//! wallet's associated token account holds on a real cluster.

use litesvm::LiteSVM;
use pipeline_client::{self as client, Pubkey};
use solana_account::Account;
use spl_token_2022_interface::extension::account_len::{
    try_calculate_account_len_from_mint_data, try_for_each_required_init_account_extension,
};
use spl_token_2022_interface::extension::{
    BaseStateWithExtensions, BaseStateWithExtensionsMut, ExtensionType, PodStateWithExtensions,
    StateWithExtensions, StateWithExtensionsMut,
};
use spl_token_2022_interface::pod::PodMint;
use spl_token_2022_interface::state::Account as TokenAccount;

/// Writes `owner`'s associated token account of `mint` holding `amount`, as
/// `pipeline_check::write_token_account` does (same address, mint, owner, amount, state,
/// `is_native` and rent-exempt lamports), and for a Token-2022 mint also with the immutable
/// owner extension, which every Token-2022 associated token account carries: the associated
/// token program initialises it before `InitializeAccount3` adds the extensions the mint
/// requires, so the account is laid out and sized as Token-2022's `GetAccountDataSize` with
/// `ImmutableOwner` requested.
///
/// `pipeline-check` writes only the extensions the mint requires, and our containment hook
/// delivers a contained token only into its home market's vault and fee account or into an
/// account whose owner can never change (`HOOK-47`), so without the extension every buy of a
/// contained token in its own home market would be refused and Canary would report a
/// tradable token as untradable.
pub fn write_token_account(
    svm: &mut LiteSVM,
    mint: &Pubkey,
    token_program: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) -> Result<Pubkey, String> {
    let address = pipeline_check::write_token_account(svm, mint, token_program, owner, amount)?;
    if *token_program != client::TOKEN_2022_PROGRAM_ID {
        return Ok(address);
    }
    let written = svm
        .get_account(&address)
        .ok_or_else(|| format!("token account {address} was not written"))?;
    let mint_data = svm
        .get_account(mint)
        .ok_or_else(|| format!("mint {mint} does not exist"))?
        .data;
    let rent_before = svm.minimum_balance_for_rent_exemption(written.data.len());
    let (data, lamports) = with_immutable_owner(&mint_data, &written.data, |len| {
        svm.minimum_balance_for_rent_exemption(len)
    })
    .map(|(data, rent)| (data, written.lamports - rent_before + rent))
    .map_err(|e| format!("cannot lay out token account {address}: {e}"))?;
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner: *token_program,
            executable: false,
            rent_epoch: 0,
        },
    )
    .map_err(|e| format!("cannot write token account {address}: {e}"))?;
    Ok(address)
}

/// A Token-2022 account of the mint in `mint_data` carrying `ImmutableOwner` first, then the
/// extensions the mint requires, in the order and at the length the associated token
/// program and Token-2022 give it, with the base state of `written`; and its rent-exempt
/// minimum, which a wrapped SOL account's `is_native` holds.
fn with_immutable_owner(
    mint_data: &[u8],
    written: &[u8],
    rent_for: impl FnOnce(usize) -> u64,
) -> Result<(Vec<u8>, u64), String> {
    let len = try_calculate_account_len_from_mint_data(mint_data, &[ExtensionType::ImmutableOwner])
        .map_err(text)?;
    let rent = rent_for(len);
    let mut required = vec![];
    let mint = PodStateWithExtensions::<PodMint>::unpack(mint_data).map_err(text)?;
    try_for_each_required_init_account_extension(mint.get_tlv_data(), |extension| {
        required.push(extension);
        Ok(())
    })
    .map_err(text)?;
    let mut base = StateWithExtensions::<TokenAccount>::unpack(written)
        .map_err(text)?
        .base;
    if base.is_native.is_some() {
        base.is_native = Some(rent).into();
    }
    let mut data = vec![0u8; len];
    let mut state =
        StateWithExtensionsMut::<TokenAccount>::unpack_uninitialized(&mut data).map_err(text)?;
    state
        .init_account_extension_from_type(ExtensionType::ImmutableOwner)
        .map_err(text)?;
    for extension in required {
        state
            .init_account_extension_from_type(extension)
            .map_err(text)?;
    }
    state.base = base;
    state.pack_base();
    state.init_account_type().map_err(text)?;
    Ok((data, rent))
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}
