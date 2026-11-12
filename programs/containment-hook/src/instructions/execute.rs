//! `execute`: the transfer hook interface's `Execute`, which Token-2022 calls on every
//! transfer of a mint whose hook is this program (docs/spec/containment-hook.md, "The allow
//! rule").
//!
//! For now it refuses every transfer of every mint, bound or not: it fails closed until the
//! allow rule arrives with [Containment hook: a contained token moves only through its home
//! market](https://github.com/imDev2023/testing-pipeline/issues/69). Minting never calls a
//! hook, so a launcher can still mint the supply.

use anchor_lang::prelude::*;

use crate::errors::HookError;

/// `Execute`'s accounts in the transfer hook interface's order, as `test-hook` takes them:
/// the four Token-2022 passes, the validation account, then its one extra account.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// The source token account.
    /// CHECK: not read while every transfer is refused.
    pub source: UncheckedAccount<'info>,
    /// The mint.
    /// CHECK: not read while every transfer is refused.
    pub mint: UncheckedAccount<'info>,
    /// The destination token account.
    /// CHECK: not read while every transfer is refused.
    pub destination: UncheckedAccount<'info>,
    /// The source's owner or delegate.
    /// CHECK: not read while every transfer is refused.
    pub owner: UncheckedAccount<'info>,
    /// The validation account `["extra-account-metas", mint]`.
    /// CHECK: not read while every transfer is refused.
    pub extra_account_metas: UncheckedAccount<'info>,
    /// The config `["config", mint]`.
    /// CHECK: not read while every transfer is refused.
    pub config: UncheckedAccount<'info>,
}

pub fn process_execute(_ctx: Context<Execute>, _amount: u64) -> Result<()> {
    err!(HookError::TransferRefused)
}
