//! The tax AMM's own mint rules, on top of the shared `mint-rules` crate's extension
//! allowlist (docs/spec/tax-amm.md, "Mint rules"): no lever a token's issuer could pull
//! once buyers are in. At creation a mint's transfer hook must be cleared or be the
//! containment hook with the mint's unlock PDA as its authority (hardening finding H007,
//! #67); at the seed, through either seed path, a mint outside the quote list
//! ([`QUOTE_MINTS`]) must have no mint authority and no freeze authority (H008, H016). None
//! of these can be undone once a market opens: Token-2022 never sets an authority that is
//! none again, so the hook of a cleared mint and the authorities checked at the seed stay
//! as they were checked.
//!
//! Each rule is a pure function of a mint's bytes, read as Token-2022 lays them out, the
//! extension entries by the shared crate's own walk, so `check_mint` has run first.

use anchor_lang::prelude::*;

use crate::config::{CONTAINMENT_HOOK_ID, CONTAINMENT_UNLOCK_SEED, QUOTE_MINTS};
use crate::errors::StrategyError;

/// `mint_authority`: a 4-byte option tag, then the key; the same in SPL Token and Token-2022.
const MINT_AUTHORITY: usize = 0;
/// `freeze_authority`: a 4-byte option tag, then the key.
const FREEZE_AUTHORITY: usize = 46;

/// The transfer hook extension's value: the hook authority, then the hook program, each a
/// key whose all-zero value means none.
const TRANSFER_HOOK_LEN: usize = 64;

/// Refuses a mint whose transfer hook could ever run code other than the containment hook's
/// inside a market's transfers: the extension, if the mint carries one, must be all zeros
/// (no program and no authority to set one), or name the containment hook with the mint's
/// unlock PDA as its authority, which only the containment hook can sign as and which it
/// uses only to clear the hook for good.
pub fn check_transfer_hook(mint: &Pubkey, data: &[u8]) -> core::result::Result<(), StrategyError> {
    let Some(hook) = mint_rules::find_extension(data, mint_rules::extension::TRANSFER_HOOK) else {
        return Ok(());
    };
    if hook.len() != TRANSFER_HOOK_LEN {
        return Err(StrategyError::TransferHookNotAllowed);
    }
    if hook.iter().all(|&byte| byte == 0) {
        return Ok(());
    }
    let (authority, program) = hook.split_at(32);
    if program != CONTAINMENT_HOOK_ID.as_ref() {
        return Err(StrategyError::TransferHookNotAllowed);
    }
    let (unlock, _) = Pubkey::find_program_address(
        &[CONTAINMENT_UNLOCK_SEED, mint.as_ref()],
        &CONTAINMENT_HOOK_ID,
    );
    if authority != unlock.as_ref() {
        return Err(StrategyError::TransferHookNotAllowed);
    }
    Ok(())
}

/// Refuses, unless `mint` is a quote mint, a mint that still has a mint authority, which
/// could mint and sell into the curve, or a freeze authority, which could freeze a vault or
/// any holder.
pub fn check_authorities(mint: &Pubkey, data: &[u8]) -> core::result::Result<(), StrategyError> {
    if QUOTE_MINTS.contains(mint) {
        return Ok(());
    }
    if authority_set(data, MINT_AUTHORITY)? {
        return Err(StrategyError::MintAuthoritySet);
    }
    if authority_set(data, FREEZE_AUTHORITY)? {
        return Err(StrategyError::FreezeAuthoritySet);
    }
    Ok(())
}

/// Whether the `COption<Pubkey>` at `offset` holds a key: tag 0 is none, tag 1 a key, and
/// any other tag is not a mint a token program wrote.
fn authority_set(data: &[u8], offset: usize) -> core::result::Result<bool, StrategyError> {
    match data.get(offset..offset + 4) {
        Some([0, 0, 0, 0]) => Ok(false),
        Some([1, 0, 0, 0]) => Ok(true),
        _ => Err(StrategyError::NotAMint),
    }
}
