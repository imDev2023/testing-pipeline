//! The token account layout constants the crate publishes for the programs that read token
//! accounts (the containment hook's `Execute`), checked against Token-2022's own definitions,
//! so no program writes them a second time (hardening finding H033 of #74).

use mint_rules::{account_extension, ACCOUNT_LEN, ACCOUNT_TYPE_ACCOUNT, MULTISIG_LEN};
use solana_program_pack::Pack;
use spl_token_2022_interface::extension::{AccountType, ExtensionType};
use spl_token_2022_interface::state::{Account, Multisig};

#[test]
fn the_account_layout_constants_are_token_2022s() {
    assert_eq!(ACCOUNT_LEN, Account::LEN);
    assert_eq!(MULTISIG_LEN, Multisig::LEN);
    assert_eq!(ACCOUNT_TYPE_ACCOUNT, AccountType::Account as u8);
    assert_eq!(
        account_extension::TRANSFER_HOOK_ACCOUNT,
        ExtensionType::TransferHookAccount as u16
    );
    assert_eq!(
        account_extension::IMMUTABLE_OWNER,
        ExtensionType::ImmutableOwner as u16
    );
}
