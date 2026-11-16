//! The payout keeper jobs and the recipients' handovers (docs/spec/pool4-for-solana.md,
//! "`settle`", "`pay_rewards`", "`sweep_fees { slot }`", "Recipients"), built in the account
//! order `metadata.json` lists, as a terminal or our keeper runner would send them.

use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};

use super::{strategy_id, Env, Market, TOKEN, WSOL};

/// The associated token account program.
pub const ATA_PROGRAM: Pubkey = client::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// `settle`: anyone may send it, and nobody signs but the fee payer.
pub fn settle_ix(market: &Market) -> Instruction {
    Instruction::new_with_bytes(
        strategy_id(),
        &client::instruction_discriminator("settle"),
        vec![
            AccountMeta::new(market.market_state, false),
            AccountMeta::new(market.token_vault, false),
            AccountMeta::new(market.token_mint, false),
            AccountMeta::new_readonly(market.vault_authority, false),
            AccountMeta::new_readonly(market.token_program, false),
        ],
    )
}

/// `pay_rewards`, paid for by `payer`, to `recipient`'s associated token account for the
/// token, with `hook_accounts` after.
pub fn pay_rewards_ix(
    market: &Market,
    payer: &Pubkey,
    recipient: &Pubkey,
    hook_accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new(market.market_state, false),
        AccountMeta::new(market.token_vault, false),
        AccountMeta::new_readonly(market.token_mint, false),
        AccountMeta::new_readonly(*recipient, false),
        AccountMeta::new(
            pda::associated_token(recipient, &market.token_mint, &market.token_program),
            false,
        ),
        AccountMeta::new_readonly(market.vault_authority, false),
        AccountMeta::new_readonly(market.token_program, false),
        AccountMeta::new_readonly(ATA_PROGRAM, false),
        AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
    ];
    accounts.extend(hook_accounts);
    Instruction::new_with_bytes(
        strategy_id(),
        &client::instruction_discriminator("pay_rewards"),
        accounts,
    )
}

/// `sweep_fees { slot }`, paid for by `payer`, to `recipient`'s associated wrapped SOL
/// account.
pub fn sweep_fees_ix(market: &Market, payer: &Pubkey, recipient: &Pubkey, slot: u8) -> Instruction {
    let mut data = client::instruction_discriminator("sweep_fees").to_vec();
    data.push(slot);
    Instruction::new_with_bytes(
        strategy_id(),
        &data,
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(market.market_state, false),
            AccountMeta::new(market.sol_vault, false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new_readonly(*recipient, false),
            AccountMeta::new(pda::associated_token(recipient, &WSOL, &TOKEN), false),
            AccountMeta::new_readonly(market.vault_authority, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        ],
    )
}

/// `set_fee_recipient { new }` or `set_rewards_recipient { new }`, signed by `signer`.
pub fn handover_ix(market: &Market, rewards: bool, signer: &Pubkey, new: &Pubkey) -> Instruction {
    let name = if rewards {
        "set_rewards_recipient"
    } else {
        "set_fee_recipient"
    };
    let mut data = client::instruction_discriminator(name).to_vec();
    data.extend_from_slice(new.as_ref());
    Instruction::new_with_bytes(
        strategy_id(),
        &data,
        vec![
            AccountMeta::new_readonly(*signer, true),
            AccountMeta::new(market.market_state, false),
        ],
    )
}

/// Sets a mint's supply. The harness funds wallets by writing their token accounts
/// straight into the VM, which leaves the supply at 0; a real mint's supply covers every
/// balance, so tests that burn set it first.
pub fn set_supply(env: &mut Env, mint: &Pubkey, value: u64) {
    let mut account = env.svm.get_account(mint).expect("the mint");
    account.data[36..44].copy_from_slice(&value.to_le_bytes());
    env.svm.set_account(*mint, account).unwrap();
}
