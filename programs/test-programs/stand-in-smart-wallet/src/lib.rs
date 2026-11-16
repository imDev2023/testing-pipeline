//! Test only, never deployed to devnet: a stand-in for a smart wallet, which signs a trader's
//! instruction with the trader's own key and sends it to its program by CPI, so the program
//! runs one call level deeper than it would from a plain wallet (Pipeline's strategy guide,
//! section 4: "traders using smart wallets use one more level").
//!
//! `forward { data }` calls the program in its first remaining account with `data` and the
//! other remaining accounts, each with the signer and writable flags it was passed with, and
//! sets the callee's return data as its own. A strategy that calls another protocol inside a
//! swap proves with it that the deepest swap a trader can send, a smart wallet calling the
//! router, still fits Solana's call-depth limit (docs/spec/README.md, "Test layers", layer 5).
//!
//! The lending AMM's call-depth test uses it; `scripts/build-programs.sh` builds it into
//! `fixtures/test-programs`, and nothing deploys it anywhere but LiteSVM or a local validator.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke, set_return_data};

declare_id!("StandinSmartWa11et1111111111111111111111111");

#[program]
pub mod stand_in_smart_wallet {
    use super::*;

    /// Calls the program in the first remaining account with `data` and the other remaining
    /// accounts, as passed.
    pub fn forward<'info>(ctx: Context<'info, Forward>, data: Vec<u8>) -> Result<()> {
        let (program, accounts) = ctx
            .remaining_accounts
            .split_first()
            .ok_or(ErrorCode::AccountNotEnoughKeys)?;
        let instruction = Instruction {
            program_id: *program.key,
            accounts: accounts
                .iter()
                .map(|account| AccountMeta {
                    pubkey: *account.key,
                    is_signer: account.is_signer,
                    is_writable: account.is_writable,
                })
                .collect(),
            data,
        };
        invoke(&instruction, ctx.remaining_accounts)?;
        if let Some((from, returned)) = get_return_data() {
            if from == *program.key {
                set_return_data(&returned);
            }
        }
        Ok(())
    }
}

/// No fixed accounts: everything the forwarded instruction needs is a remaining account.
#[derive(Accounts)]
pub struct Forward {}
