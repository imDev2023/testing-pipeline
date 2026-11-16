//! The containment hook: one Token-2022 transfer hook program, deployed once, that keeps
//! every contained token in its one home market until it unlocks
//! (docs/spec/containment-hook.md).
//!
//! | Instruction | Called by                       | Does                                            |
//! |-------------|---------------------------------|-------------------------------------------------|
//! | `bind`      | the launcher, as mint authority | binds a mint to its home market, once           |
//! | `execute`   | Token-2022, on every transfer   | passes it only into or out of the home market   |
//!
//! `execute` is the allow rule: while a token is contained, a transfer passes only into or
//! out of its home market's vault or that market's fee account, and anything the hook cannot
//! verify is refused, every transfer of a mint never bound included. `unlock` arrives with
//! [Containment hook: unlock by the goal or the
//! deadline](https://github.com/imDev2023/testing-pipeline/issues/70). No instruction
//! changes what `bind` wrote in a config: not the launcher, not us; the unlock will only
//! record its time, once, in the config's last field.
//!
//! Where things live: the build-time policy values in [`config`], the unlock terms' rules
//! in [`terms`], the accounts in [`state`], what is read from a mint in [`mint`], from a
//! token account in [`token_account`], from the router in [`router`] and from the tax AMM in
//! [`tax_market`], and each instruction in its own module of [`instructions`]. The mint
//! extension allowlist is the shared `mint-rules` crate.

use anchor_lang::prelude::*;

pub mod config;
pub mod errors;
pub mod instructions;
pub mod mint;
pub mod router;
pub mod state;
pub mod tax_market;
pub mod terms;
pub mod token_account;

pub use errors::HookError;
pub use instructions::*;
pub use state::Config;

// The program's address; its key is `~/.config/testing-pipeline/devnet/containment-hook.json`.
declare_id!("aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv");

#[program]
pub mod containment_hook {
    use super::*;

    /// Binds a Token-2022 mint to its home market, once and for good: the unlock goal, in
    /// quote-mint base units, and the unlock deadline, a Unix time.
    pub fn bind(ctx: Context<Bind>, unlock_goal: u64, unlock_deadline: i64) -> Result<()> {
        instructions::process_bind(ctx, unlock_goal, unlock_deadline)
    }

    /// The transfer hook interface's `Execute`, which Token-2022 calls on every transfer of
    /// a mint whose hook is this program.
    #[instruction(discriminator = &state::EXECUTE_DISCRIMINATOR)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        instructions::process_execute(ctx, amount)
    }
}
