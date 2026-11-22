//! The account-owner escape found by the hook's internal adversarial review (#74): Token-2022
//! lets the owner of a token account hand the whole account to another wallet with
//! `SetAuthority(AccountOwner)`, which moves no tokens and so never calls the hook. Only the
//! `ImmutableOwner` extension stops it, and only associated token accounts carry it by default.
//! So a buy delivered into an account without it could leave the home market as a change of
//! owner, wallet to wallet, or let an escrow trade whole accounts as a second market.
//!
//! The hook therefore lets a contained token go only into the home market's vault, its fee
//! account, or an account whose owner can never change (docs/spec/containment-hook.md, "The
//! allow rule").

mod support;

use containment_hook::HookError;
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use support::*;

/// A buy of one whole quote unit.
const BUY: u64 = 1_000_000;

/// A Token-2022 account of `mint` for `owner` at a fresh address, with the transfer hook
/// account extension and, when `immutable_owner`, the `ImmutableOwner` extension, created the
/// way a wallet would create a non-associated account.
fn keypair_account(env: &mut Env, owner: &Pubkey, mint: &Pubkey, immutable_owner: bool) -> Pubkey {
    use spl_token_2022_interface::extension::ExtensionType;
    let account = Keypair::new();
    let mut extensions = vec![ExtensionType::TransferHookAccount];
    if immutable_owner {
        extensions.push(ExtensionType::ImmutableOwner);
    }
    let space = ExtensionType::try_calculate_account_len::<
        spl_token_2022_interface::state::Account,
    >(&extensions)
    .unwrap();
    let mut create = 0u32.to_le_bytes().to_vec();
    create.extend_from_slice(
        &env.svm
            .minimum_balance_for_rent_exemption(space)
            .to_le_bytes(),
    );
    create.extend_from_slice(&(space as u64).to_le_bytes());
    create.extend_from_slice(TOKEN_2022.as_ref());
    let mut instructions = vec![Instruction::new_with_bytes(
        pipeline_client::SYSTEM_PROGRAM_ID,
        &create,
        vec![
            AccountMeta::new(env.admin.pubkey(), true),
            AccountMeta::new(account.pubkey(), true),
        ],
    )];
    if immutable_owner {
        instructions.push(
            spl_token_2022_interface::instruction::initialize_immutable_owner(
                &TOKEN_2022,
                &account.pubkey(),
            )
            .unwrap(),
        );
    }
    instructions.push(
        spl_token_2022_interface::instruction::initialize_account3(
            &TOKEN_2022,
            &account.pubkey(),
            mint,
            owner,
        )
        .unwrap(),
    );
    env.send(&instructions, &[&account]).unwrap();
    account.pubkey()
}

/// Token-2022's `SetAuthority(AccountOwner)` of `account` from `owner` to `new_owner`.
fn set_owner(account: &Pubkey, owner: &Pubkey, new_owner: &Pubkey) -> Instruction {
    spl_token_2022_interface::instruction::set_authority(
        &TOKEN_2022,
        account,
        Some(new_owner),
        spl_token_2022_interface::instruction::AuthorityType::AccountOwner,
        owner,
        &[],
    )
    .unwrap()
}

#[test]
fn sos_account_owner_a_buy_into_an_account_whose_owner_can_change_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let buyer = trader(&mut env, &launched, 10 * BUY);
    let mutable = keypair_account(&mut env, &buyer.pubkey(), &launched.mint, false);
    let into_it = Swap {
        output_to: Some(mutable),
        ..Swap::default()
    };
    // Without the rule this buy lands, and the account then changes hands with no transfer:
    // `set_owner(&mutable, &buyer, &anyone)` passes Token-2022 without calling the hook.
    assert_hook_refused(
        swap(&mut env, &launched, &buyer, (QUOTE, CONTAINED), BUY, &into_it),
        HookError::DestinationOwnerCanChange,
    );
    assert_eq!(env.balance(&mutable), 0);
}

#[test]
fn sos_account_owner_a_buy_into_an_account_with_an_immutable_owner_passes_and_its_owner_stays() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let buyer = trader(&mut env, &launched, 10 * BUY);
    let immutable = keypair_account(&mut env, &buyer.pubkey(), &launched.mint, true);
    let into_it = Swap {
        output_to: Some(immutable),
        ..Swap::default()
    };
    swap(&mut env, &launched, &buyer, (QUOTE, CONTAINED), BUY, &into_it).unwrap();
    let bought = env.balance(&immutable);
    assert!(bought > 0);
    // Token-2022 refuses to hand such an account to another wallet.
    let elsewhere = Pubkey::new_unique();
    assert!(env
        .send(&[set_owner(&immutable, &buyer.pubkey(), &elsewhere)], &[&buyer])
        .is_err());
    assert_eq!(env.balance(&immutable), bought);
}

#[test]
fn sos_account_owner_a_buy_into_an_associated_token_account_still_passes() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let buyer = trader(&mut env, &launched, 10 * BUY);
    let bought = buy(&mut env, &launched, &buyer, BUY).received;
    assert!(bought > 0);
    let account = contained_account(&launched, &buyer.pubkey());
    assert_eq!(env.balance(&account), bought);
    assert!(env
        .send(
            &[set_owner(&account, &buyer.pubkey(), &Pubkey::new_unique())],
            &[&buyer]
        )
        .is_err());
}

#[test]
fn sos_account_owner_tokens_already_in_an_account_whose_owner_can_change_can_still_be_sold() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    // An account that took tokens before the rule existed, its balance written directly.
    let seller = trader(&mut env, &launched, 0);
    let mutable = keypair_account(&mut env, &seller.pubkey(), &launched.mint, false);
    let held: u64 = 1_000_000_000_000;
    edit_account(&mut env, &mutable, |account| {
        // A token account's amount is the u64 after its mint and owner.
        account.data[64..72].copy_from_slice(&held.to_le_bytes());
    });
    // A sell sends the token into the vault, which the rule always allows.
    let mut instruction = swap_instruction(
        &env,
        &launched,
        &seller.pubkey(),
        (CONTAINED, QUOTE),
        held / 2,
        &Swap::default(),
    );
    let associated = contained_account(&launched, &seller.pubkey());
    for meta in instruction.accounts.iter_mut() {
        if meta.pubkey == associated {
            meta.pubkey = mutable;
        }
    }
    let meta = env.send_meta(&[instruction], &[&seller]).unwrap();
    let sold: pipeline_client::SwapResult = borsh::from_slice(&meta.return_data.data).unwrap();
    assert!(sold.received > 0);
    // Pipeline's fee on this market is taken in the token, into the fee account.
    assert_eq!(
        env.balance(&mutable),
        held - held / 2 - sold.pipeline_fee
    );
}
