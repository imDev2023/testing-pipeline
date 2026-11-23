//! What `Execute` reads from the token accounts of a transfer: whether the source is a
//! Token-2022 account of the mint in the middle of a transfer, and whether the destination's
//! owner can ever change (docs/spec/containment-hook.md, "The allow rule").
//!
//! Token-2022 adds the transfer hook account extension to every account of a mint with a
//! transfer hook, sets its `transferring` flag on the source and the destination just before
//! it calls the hook, and clears it straight after, so the flag set on the source proves the
//! call comes from a transfer of that account. Token-2022 lets an account's owner hand the
//! whole account to another wallet (`SetAuthority(AccountOwner)`), which moves no tokens and
//! calls no hook, unless the account carries the immutable owner extension, as every
//! associated token account of Token-2022 does. The bytes are read as Token-2022 lays them
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
/// A Token-2022 multisig's length: Token-2022 never reads an account of this length as a
/// token account, so neither does the hook.
const MULTISIG_LEN: usize = 355;
/// Token-2022's number for the immutable owner extension, which has no value: an account
/// that carries it can never change its owner.
const IMMUTABLE_OWNER: u16 = 7;

/// Whether `account` is a Token-2022 token account of `mint` with its `transferring` flag
/// set.
pub fn is_mid_transfer(account: &AccountInfo, mint: &Pubkey) -> bool {
    *account.owner == anchor_spl::token_2022::ID
        && account
            .try_borrow_data()
            .is_ok_and(|data| is_mid_transfer_data(&data, mint))
}

/// [`is_mid_transfer`] on a Token-2022 account's data: not a multisig's length, its mint is
/// `mint`, its account type is a token account's, and its transfer hook account extension
/// holds `transferring` set.
pub fn is_mid_transfer_data(data: &[u8], mint: &Pubkey) -> bool {
    data.len() != MULTISIG_LEN
        && data.get(..32) == Some(mint.as_ref())
        && data.get(ACCOUNT_LEN) == Some(&ACCOUNT_TYPE_ACCOUNT)
        && mint_rules::find_extension(data, TRANSFER_HOOK_ACCOUNT) == Some(&[1])
}

/// Whether `account` is a Token-2022 token account of `mint` whose owner can never change.
pub fn owner_is_immutable(account: &AccountInfo, mint: &Pubkey) -> bool {
    *account.owner == anchor_spl::token_2022::ID
        && account
            .try_borrow_data()
            .is_ok_and(|data| owner_is_immutable_data(&data, mint))
}

/// [`owner_is_immutable`] on a Token-2022 account's data: not a multisig's length, its mint is
/// `mint`, its account type is a token account's, and it carries the immutable owner
/// extension.
pub fn owner_is_immutable_data(data: &[u8], mint: &Pubkey) -> bool {
    data.len() != MULTISIG_LEN
        && data.get(..32) == Some(mint.as_ref())
        && data.get(ACCOUNT_LEN) == Some(&ACCOUNT_TYPE_ACCOUNT)
        && mint_rules::find_extension(data, IMMUTABLE_OWNER).is_some()
}
