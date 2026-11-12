//! Transfers of a contained mint through the real Token-2022 (docs/spec/containment-hook.md,
//! "Lifecycle"): before `bind`, and in this ticket after it too, every transfer is refused,
//! into the home market's vault included; minting never calls the hook and is not affected.

mod support;

use containment_hook::HookError;
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use support::*;

const SUPPLY: u64 = 1_000_000_000_000;
const AMOUNT: u64 = 1_000_000;

/// A contained mint, its home market and the launcher's token account holding the supply,
/// minted before any binding.
fn launched() -> (Env, Pubkey, Market, Pubkey) {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let admin = env.admin.pubkey();
    let holder = token_2022_account(&mut env, &admin, &mint);
    mint_to(&mut env, &mint, &holder, SUPPLY).unwrap();
    assert_eq!(env.balance(&holder), SUPPLY);
    (env, mint, market, holder)
}

/// Every transfer the launcher could try: into the home market's vault, into its fee
/// account and into another wallet, each with the hook accounts and without them.
fn assert_every_transfer_refused(
    env: &mut Env,
    mint: &Pubkey,
    market: &Market,
    holder: &Pubkey,
    bound: bool,
) {
    let admin = env.admin.pubkey();
    let wallet = token_2022_account(env, &Pubkey::new_unique(), mint);
    let destinations = [
        ("the home market's vault", market.vaults[0]),
        ("the home market's fee account", fee_account(market, mint)),
        ("another wallet", wallet),
    ];
    for (name, destination) in destinations {
        for (tail_name, tail) in [("with", hook_tail(mint)), ("without", vec![])] {
            let transfer = transfer_checked(mint, holder, &destination, &admin, AMOUNT, tail);
            let result = env.send(&[transfer], &[]);
            assert!(
                result.is_err(),
                "a transfer into {name} {tail_name} the hook accounts passed"
            );
            if bound && tail_name == "with" {
                // Token-2022 resolved the config and called the hook, which refused.
                let logs = result.as_ref().unwrap_err();
                assert!(
                    logs.contains(&format!("Program {} invoke", hook_id())),
                    "{logs}"
                );
                assert_hook_refused(result, HookError::TransferRefused);
            }
        }
    }
    assert_eq!(env.balance(holder), SUPPLY + if bound { AMOUNT } else { 0 });
}

#[test]
fn before_bind_every_transfer_is_refused() {
    let (mut env, mint, market, holder) = launched();
    assert!(env.svm.get_account(&validation_pda(&mint)).is_none());
    assert_every_transfer_refused(&mut env, &mint, &market, &holder, false);
}

#[test]
fn after_bind_every_transfer_is_still_refused_by_the_hook() {
    let (mut env, mint, market, holder) = launched();
    bind(&mut env, mint, &market).unwrap();
    // Minting after the binding still works, and never calls the hook.
    mint_to(&mut env, &mint, &holder, AMOUNT).unwrap();
    assert_every_transfer_refused(&mut env, &mint, &market, &holder, true);
}

#[test]
fn execute_called_directly_is_refused() {
    let (mut env, mint, market, holder) = launched();
    bind(&mut env, mint, &market).unwrap();
    let mut data = containment_hook::state::EXECUTE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&AMOUNT.to_le_bytes());
    let caller = Keypair::new();
    let accounts = [
        holder,
        mint,
        market.vaults[0],
        caller.pubkey(),
        validation_pda(&mint),
        config_pda(&mint),
    ]
    .into_iter()
    .map(|key| pipeline_client::AccountMeta::new_readonly(key, false))
    .collect();
    let call = pipeline_client::Instruction::new_with_bytes(hook_id(), &data, accounts);
    assert_hook_refused(env.send(&[call], &[]), HookError::TransferRefused);
}
