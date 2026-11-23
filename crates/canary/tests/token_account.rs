//! The token accounts Canary writes for its traders are exactly what the associated token
//! program creates at the same address: for a Token-2022 mint, the immutable owner extension
//! first, then the extensions the mint requires (`HOOK-47`).

mod common;

use canary::token_account::write_token_account;
use common::{Cluster, Extensions, TEST_HOOK, TOKEN, TOKEN_2022};
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_account::Account;
use spl_token_2022_interface::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};

/// `owner`'s associated token account of `mint`, created by the associated token program.
fn created_by_the_associated_token_program(
    cluster: &mut Cluster,
    mint: &Pubkey,
    token_program: &Pubkey,
    owner: &Pubkey,
) -> Account {
    let address = pda::associated_token(owner, mint, token_program);
    let ix = Instruction::new_with_bytes(
        client::ASSOCIATED_TOKEN_PROGRAM_ID,
        &[0],
        vec![
            AccountMeta::new(cluster.admin_key(), true),
            AccountMeta::new(address, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
    );
    cluster.send(&[ix], &[]);
    cluster.svm.get_account(&address).unwrap()
}

fn assert_written_as_created(cluster: &mut Cluster, mint: &Pubkey, token_program: &Pubkey) {
    let owner = Pubkey::new_unique();
    let created = created_by_the_associated_token_program(cluster, mint, token_program, &owner);

    let address = write_token_account(&mut cluster.svm, mint, token_program, &owner, 0).unwrap();

    let written = cluster.svm.get_account(&address).unwrap();
    assert_eq!(address, pda::associated_token(&owner, mint, token_program));
    assert_eq!(written.data, created.data, "the data of {mint}'s account");
    assert_eq!(
        written.lamports, created.lamports,
        "rent of {mint}'s account"
    );
    assert_eq!(written.owner, created.owner);
}

#[test]
fn a_token_2022_account_is_the_associated_token_programs_with_its_immutable_owner() {
    let mut cluster = Cluster::new();
    let admin = cluster.admin_key();
    let hooked = cluster.create_mint_2022(
        6,
        &Extensions {
            transfer_hook: Some((TEST_HOOK, Some(admin))),
            transfer_fee: Some((100, 1_000_000)),
            pausable: true,
            ..Extensions::default()
        },
    );
    let plain = cluster.create_mint_2022(9, &Extensions::default());

    for mint in [hooked, plain] {
        assert_written_as_created(&mut cluster, &mint, &TOKEN_2022);
    }
}

#[test]
fn an_spl_token_account_is_written_as_pipeline_check_writes_it() {
    let mut cluster = Cluster::new();
    let mint = cluster.create_mint(6);

    assert_written_as_created(&mut cluster, &mint, &TOKEN);
}

#[test]
fn the_balance_is_what_was_asked_and_the_extensions_follow_the_mint() {
    let mut cluster = Cluster::new();
    let admin = cluster.admin_key();
    let mint = cluster.create_mint_2022(
        6,
        &Extensions {
            transfer_hook: Some((TEST_HOOK, Some(admin))),
            ..Extensions::default()
        },
    );
    let owner = Pubkey::new_unique();

    let address = write_token_account(&mut cluster.svm, &mint, &TOKEN_2022, &owner, 1_234).unwrap();

    let data = cluster.svm.get_account(&address).unwrap().data;
    let state =
        StateWithExtensions::<spl_token_2022_interface::state::Account>::unpack(&data).unwrap();
    assert_eq!(state.base.amount, 1_234);
    assert_eq!(state.base.owner, owner);
    assert_eq!(state.base.mint, mint);
    assert_eq!(
        state.get_extension_types().unwrap(),
        vec![
            ExtensionType::ImmutableOwner,
            ExtensionType::TransferHookAccount
        ]
    );
}
