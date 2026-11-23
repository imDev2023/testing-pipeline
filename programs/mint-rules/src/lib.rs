//! The mint rules every market of the suite's strategies applies, in one place
//! (docs/spec/tax-amm.md, "Mint rules" and "Where its policy values live").
//!
//! A mint must belong to SPL Token or Token-2022, and a Token-2022 mint may carry only the
//! extensions in [`ALLOWED_MINT_EXTENSIONS`]: every other one, including any Token-2022
//! adds later, is refused, because an extension such as a permanent delegate or a transfer
//! fee could take from a market's vaults or change what a trade delivers. This crate says
//! nothing of a mint's authorities or of which program its transfer hook names: those are
//! each product's own stricter rules on top (the tax AMM admits only a cleared hook or the
//! containment hook, and at the seed no mint or freeze authority but on a quote mint such as
//! USDC, in its `mint_levers` module).
//!
//! The tax AMM, the containment hook and the lending AMM all depend on this crate, so there
//! is one list and never a second copy; a product with a stricter rule adds it on top. The
//! list is fixed on-chain because traders rely on it: it can change until a program is
//! frozen, and like every decision in the spec it is a default MetalLegBob may change.
//!
//! The crate depends on nothing, so a program that uses it pulls in no other program. It
//! reads the mint's bytes the way Token-2022 does, which its tests check against
//! Token-2022's own state code.

/// SPL Token, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.
pub const TOKEN_PROGRAM_ID: [u8; 32] = [
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
];

/// Token-2022, `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.
pub const TOKEN_2022_PROGRAM_ID: [u8; 32] = [
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
];

/// Token-2022's numbers for the extensions the rules allow (its `ExtensionType`).
pub mod extension {
    pub const TRANSFER_HOOK: u16 = 14;
    pub const METADATA_POINTER: u16 = 18;
    pub const TOKEN_METADATA: u16 = 19;
    pub const GROUP_POINTER: u16 = 20;
    pub const TOKEN_GROUP: u16 = 21;
    pub const GROUP_MEMBER_POINTER: u16 = 22;
    pub const TOKEN_GROUP_MEMBER: u16 = 23;
}

/// The only mint extensions a market's mint may carry: a transfer hook (which program it may
/// name is each product's own rule), and the metadata and group extensions, which describe a
/// token without acting on it.
pub const ALLOWED_MINT_EXTENSIONS: [u16; 7] = [
    extension::TRANSFER_HOOK,
    extension::METADATA_POINTER,
    extension::TOKEN_METADATA,
    extension::GROUP_POINTER,
    extension::TOKEN_GROUP,
    extension::GROUP_MEMBER_POINTER,
    extension::TOKEN_GROUP_MEMBER,
];

/// Why a mint is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MintRefusal {
    /// The account belongs to neither SPL Token nor Token-2022.
    NotATokenProgram,
    /// The account is not an initialized mint as its token program lays one out.
    NotAMint,
    /// The mint carries an extension outside [`ALLOWED_MINT_EXTENSIONS`], by Token-2022's
    /// number for it; an extension Token-2022 has not defined yet is refused the same way.
    ExtensionNotAllowed(u16),
}

/// An SPL Token mint, and a Token-2022 mint's base, before any extension.
pub const MINT_LEN: usize = 82;
const IS_INITIALIZED: usize = 45;
/// Token-2022 pads an extended mint to a token account's length, then writes the account
/// type, then its type-length-value extension entries.
const ACCOUNT_LEN: usize = 165;
const ACCOUNT_TYPE_MINT: u8 = 1;
/// A multisig's length, which Token-2022 never reads as a mint.
const MULTISIG_LEN: usize = 355;
/// Token-2022's `Uninitialized` type, which ends the list of entries.
const UNINITIALIZED: u16 = 0;

/// Checks that `data`, an account owned by `owner`, is a mint a market may trade.
pub fn check_mint(owner: &[u8; 32], data: &[u8]) -> Result<(), MintRefusal> {
    let token_2022 = if *owner == TOKEN_PROGRAM_ID {
        false
    } else if *owner == TOKEN_2022_PROGRAM_ID {
        true
    } else {
        return Err(MintRefusal::NotATokenProgram);
    };
    if data.len() < MINT_LEN || data.get(IS_INITIALIZED) != Some(&1) {
        return Err(MintRefusal::NotAMint);
    }
    if data.len() == MINT_LEN {
        return Ok(());
    }
    // Only Token-2022 mints are longer than the base, and never a multisig's length.
    if !token_2022 || data.len() == MULTISIG_LEN || data.len() <= ACCOUNT_LEN {
        return Err(MintRefusal::NotAMint);
    }
    let padding = data
        .get(MINT_LEN..ACCOUNT_LEN)
        .ok_or(MintRefusal::NotAMint)?;
    if padding.iter().any(|&b| b != 0) || data.get(ACCOUNT_LEN) != Some(&ACCOUNT_TYPE_MINT) {
        return Err(MintRefusal::NotAMint);
    }
    check_extensions(data.get(ACCOUNT_LEN + 1..).ok_or(MintRefusal::NotAMint)?)
}

/// Walks the type-length-value entries as Token-2022 does: an `Uninitialized` type, or too
/// few bytes left for a type, ends the list; an entry whose length runs past the account
/// is malformed.
fn check_extensions(entries: &[u8]) -> Result<(), MintRefusal> {
    for entry in ExtensionEntries(entries) {
        let (extension_type, _) = entry?;
        if !ALLOWED_MINT_EXTENSIONS.contains(&extension_type) {
            return Err(MintRefusal::ExtensionNotAllowed(extension_type));
        }
    }
    Ok(())
}

/// The value of the first extension entry of `extension_type` in a Token-2022 mint's
/// `data`, read the way [`check_mint`] walks the entries; `None` for a mint without
/// extensions, without that entry, or whose entries are malformed before it. Programs that
/// read an extension (the containment hook reads the transfer hook's) call this after
/// [`check_mint`], so the layout is walked by one piece of code.
pub fn find_extension(data: &[u8], extension_type: u16) -> Option<&[u8]> {
    let entries = data.get(ACCOUNT_LEN + 1..)?;
    for entry in ExtensionEntries(entries) {
        match entry {
            Ok((found, value)) if found == extension_type => return Some(value),
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    None
}

/// The type-length-value entries after a mint's account type, as Token-2022 walks them: an
/// `Uninitialized` type, or too few bytes left for a type, ends the list; an entry whose
/// length runs past the account is malformed, and ends the walk with an error.
struct ExtensionEntries<'a>(&'a [u8]);

impl<'a> Iterator for ExtensionEntries<'a> {
    type Item = Result<(u16, &'a [u8]), MintRefusal>;

    fn next(&mut self) -> Option<Self::Item> {
        let entries = self.0;
        let &[low, high] = entries.get(0..2)? else {
            return None;
        };
        let extension_type = u16::from_le_bytes([low, high]);
        if extension_type == UNINITIALIZED {
            self.0 = &[];
            return None;
        }
        // A malformed entry ends the walk after its error.
        self.0 = &[];
        let len = match entries.get(2..4) {
            Some(&[low, high]) => u16::from_le_bytes([low, high]) as usize,
            _ => return Some(Err(MintRefusal::NotAMint)),
        };
        let rest = entries.get(4..).unwrap_or(&[]);
        let (Some(value), Some(after)) = (rest.get(..len), rest.get(len..)) else {
            return Some(Err(MintRefusal::NotAMint));
        };
        self.0 = after;
        Some(Ok((extension_type, value)))
    }
}
