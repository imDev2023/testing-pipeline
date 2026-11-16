//! What `Execute` reads from the source token account: whether it is a Token-2022 account of
//! the mint in the middle of a transfer (docs/spec/containment-hook.md, "The allow rule").
//!
//! Token-2022 adds the transfer hook account extension to every account of a mint with a
//! transfer hook, sets its `transferring` flag on the source and the destination just before
//! it calls the hook, and clears it straight after, so the flag set on the source proves the
//! call comes from a transfer of that account. The bytes are read as Token-2022 lays them
//! out, the extension entries by the shared mint-rules crate's walk (an account's entries
//! follow its account type exactly as a mint's do); `tests/layout.rs` checks the reading
//! against Token-2022's own state code.

use anchor_lang::prelude::*;

/// A token account's base length, which a mint's base is padded to.
const ACCOUNT_LEN: usize = 165;
/// The account type byte after the base: 2 for a token account.
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;
/// Token-2022's number for the transfer hook account extension, whose one-byte value is the
/// `transferring` flag.
const TRANSFER_HOOK_ACCOUNT: u16 = 15;

/// Whether `account` is a Token-2022 token account of `mint` with its `transferring` flag
/// set.
pub fn is_mid_transfer(account: &AccountInfo, mint: &Pubkey) -> bool {
    *account.owner == anchor_spl::token_2022::ID
        && account
            .try_borrow_data()
            .is_ok_and(|data| is_mid_transfer_data(&data, mint))
}

/// [`is_mid_transfer`] on a Token-2022 account's data: its mint is `mint`, its account type
/// is a token account's, and its transfer hook account extension holds `transferring` set.
pub fn is_mid_transfer_data(data: &[u8], mint: &Pubkey) -> bool {
    data.get(..32) == Some(mint.as_ref())
        && data.get(ACCOUNT_LEN) == Some(&ACCOUNT_TYPE_ACCOUNT)
        && mint_rules::find_extension(data, TRANSFER_HOOK_ACCOUNT) == Some(&[1])
}
