//! The validation account `bind` writes, read by the transfer hook interface's own crates as
//! Token-2022 and every client read it: one extra account for `Execute`, the config at
//! `["config", mint]`, read-only (docs/spec/containment-hook.md, "Accounts").

mod support;

use containment_hook::state::VALIDATION_DATA;
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use spl_tlv_account_resolution::account::ExtraAccountMeta;
use spl_tlv_account_resolution::seeds::Seed;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;
use support::*;

#[test]
fn the_validation_data_is_the_interfaces_list_of_the_config() {
    let config = ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal {
                bytes: b"config".to_vec(),
            },
            Seed::AccountKey { index: 1 },
        ],
        false,
        false,
    )
    .unwrap();
    let len = ExtraAccountMetaList::size_of(1).unwrap();
    let mut expected = vec![0u8; len];
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut expected, &[config]).unwrap();
    assert_eq!(VALIDATION_DATA.to_vec(), expected);
}

#[test]
fn a_bound_mints_validation_account_resolves_to_its_config() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    bind(&mut env, mint, &market).unwrap();

    // Resolve `Execute`'s extra accounts from the account on chain, as a wallet does.
    let (source, destination, owner) = (
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    );
    let mut data = containment_hook::state::EXECUTE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&1u64.to_le_bytes());
    let mut execute = Instruction::new_with_bytes(
        hook_id(),
        &data,
        vec![
            AccountMeta::new_readonly(source, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(destination, false),
            AccountMeta::new_readonly(owner, false),
            AccountMeta::new_readonly(validation_pda(&mint), false),
        ],
    );
    let validation = env.svm.get_account(&validation_pda(&mint)).unwrap().data;
    let fetch = |address: Pubkey| {
        let data = env.svm.get_account(&address).map(|account| account.data);
        std::future::ready(Ok(data))
    };
    let resolved = ExtraAccountMetaList::add_to_instruction::<ExecuteInstruction, _, _>(
        &mut execute,
        fetch,
        &validation,
    );
    ready(resolved).unwrap();
    assert_eq!(
        execute.accounts.last().unwrap(),
        &AccountMeta::new_readonly(config_pda(&mint), false)
    );
    assert_eq!(execute.accounts.len(), 6);
}

/// Runs a future that never waits, as `add_to_instruction`'s is with a fetch that answers
/// from memory.
fn ready<T>(future: impl std::future::Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut context) {
        std::task::Poll::Ready(value) => value,
        std::task::Poll::Pending => panic!("the resolution waited on something"),
    }
}
