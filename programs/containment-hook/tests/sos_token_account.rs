//! What `Execute` reads from token accounts, hardened by the hook's internal adversarial review
//! (#74), each pinned by a test named after the finding
//! (docs/security/containment-hook/round-1.md).

use anchor_lang::prelude::Pubkey;
use containment_hook::token_account::is_mid_transfer_data;

/// Bytes laid out as a token account of `mint` with the transfer hook account extension's
/// `transferring` flag set, `len` bytes long.
fn mid_transfer_bytes(mint: &Pubkey, len: usize) -> Vec<u8> {
    let mut data = vec![0u8; len];
    data[..32].copy_from_slice(mint.as_ref());
    // The account type, then one extension entry: type 15, length 1, the flag set.
    data[165] = 2;
    data[166..168].copy_from_slice(&15u16.to_le_bytes());
    data[168..170].copy_from_slice(&1u16.to_le_bytes());
    data[170] = 1;
    data
}

/// H034: Token-2022 reads an account of a multisig's length, 355 bytes, as a multisig and
/// never as a token account, so the hook must not read one as a token account mid-transfer
/// either: such bytes, ground to look like one, are refused.
#[test]
fn sos_h034_a_multisig_length_account_is_not_read_as_mid_transfer() {
    let mint = Pubkey::new_unique();
    assert!(is_mid_transfer_data(&mid_transfer_bytes(&mint, 171), &mint));
    assert!(!is_mid_transfer_data(
        &mid_transfer_bytes(&mint, 355),
        &mint
    ));
}
