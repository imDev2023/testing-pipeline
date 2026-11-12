//! What `bind` reads from a Token-2022 mint's bytes: its two authorities and its transfer
//! hook extension, as pure functions that take no accounts. Which extensions a mint may
//! carry at all is the shared `mint-rules` crate's check, which `bind` runs first.
//!
//! The bytes are read as Token-2022 lays them out, the extension entries by the shared
//! crate's own walk; `tests/layout.rs` checks the reading against Token-2022's own state
//! code.

use mint_rules::MINT_LEN;

/// `mint_authority`: a 4-byte option tag, then the key.
const MINT_AUTHORITY: usize = 0;
/// `freeze_authority`: a 4-byte option tag, then the key.
const FREEZE_AUTHORITY: usize = 46;
/// Token-2022's number for the transfer hook extension.
const TRANSFER_HOOK: u16 = mint_rules::extension::TRANSFER_HOOK;
/// The transfer hook extension's value: the hook authority, then the hook program, each an
/// optional key whose all-zero value means none.
const TRANSFER_HOOK_LEN: usize = 64;

/// A mint's authorities and transfer hook, as `bind` needs them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MintFacts {
    pub mint_authority: Option<[u8; 32]>,
    pub freeze_authority: Option<[u8; 32]>,
    /// The transfer hook extension's authority and program, if the mint carries one.
    pub transfer_hook: Option<TransferHook>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransferHook {
    pub authority: Option<[u8; 32]>,
    pub program: Option<[u8; 32]>,
}

/// Reads a mint's facts, or `None` if `data` is too short to be a mint.
pub fn read_mint(data: &[u8]) -> Option<MintFacts> {
    if data.len() < MINT_LEN {
        return None;
    }
    Some(MintFacts {
        mint_authority: read_option_key(data, MINT_AUTHORITY)?,
        freeze_authority: read_option_key(data, FREEZE_AUTHORITY)?,
        transfer_hook: match mint_rules::find_extension(data, TRANSFER_HOOK) {
            Some(value) if value.len() == TRANSFER_HOOK_LEN => Some(TransferHook {
                authority: read_nonzero_key(&value[..32]),
                program: read_nonzero_key(&value[32..]),
            }),
            // An entry of the wrong length is not a transfer hook Token-2022 would honour.
            _ => None,
        },
    })
}

/// A `COption<Pubkey>` at `offset`: tag 0 is none, tag 1 the key; any other tag is not a
/// mint.
fn read_option_key(data: &[u8], offset: usize) -> Option<Option<[u8; 32]>> {
    let tag = data.get(offset..offset + 4)?;
    let key: [u8; 32] = data.get(offset + 4..offset + 36)?.try_into().ok()?;
    match tag {
        [0, 0, 0, 0] => Some(None),
        [1, 0, 0, 0] => Some(Some(key)),
        _ => None,
    }
}

/// An `OptionalNonZeroPubkey`: the all-zero key means none.
fn read_nonzero_key(bytes: &[u8]) -> Option<[u8; 32]> {
    let key: [u8; 32] = bytes.try_into().ok()?;
    (key != [0; 32]).then_some(key)
}
