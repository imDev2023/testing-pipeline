//! `contained_mint`: for each mint with a transfer hook, reads the hook program, whether it
//! can still be upgraded, and the hook's authority, as `docs/spec/containment-hook.md`
//! recognises a contained token: our containment hook ([`CONTAINMENT_HOOK_PROGRAM`]) with
//! the mint's unlock PDA as its authority.
//!
//! - Fail: never.
//! - Warn: the hook is not our containment hook with the mint's unlock PDA as its authority,
//!   or the hook program can still be upgraded.
//! - Pass: the hook is our containment hook, its authority is the mint's unlock PDA and the
//!   hook program is frozen.
//! - "Not run" when no mint has a hook, and for a mint whose transfer hook extension has
//!   both its program and its authority unset, as a contained token's has after its unlock
//!   (`CANARY-29`).

use litesvm::LiteSVM;
use pipeline_client::{self as client, pda, pubkey, Pubkey};
use serde::Serialize;
use serde_json::json;

use crate::config::{CONTAINMENT_HOOK_PROGRAM, CONTAINMENT_HOOK_UNLOCK_SEED};
use crate::market::Session;
use crate::record::{Outcome, Verdict};

const LOADER_V1: Pubkey = pubkey!("BPFLoader1111111111111111111111111111111111");
const LOADER_V2: Pubkey = pubkey!("BPFLoader2111111111111111111111111111111111");
const LOADER_V4: Pubkey = pubkey!("LoaderV411111111111111111111111111111111111");
/// Loader-v3 ProgramData: a 4-byte tag, the deploy slot, then an optional authority.
const PROGRAM_DATA_AUTHORITY_TAG: usize = 12;
const PROGRAM_DATA_AUTHORITY: std::ops::Range<usize> = 13..45;
/// Loader-v4 program header: deploy slot, authority, status (2 is finalized).
const LOADER_V4_AUTHORITY: std::ops::Range<usize> = 8..40;
const LOADER_V4_STATUS: std::ops::Range<usize> = 40..48;
const LOADER_V4_FINALIZED: u64 = 2;

/// Whether a program can still change: its upgrade authority, `None` once frozen; an error
/// when the copy does not hold it as a deployed program.
pub fn upgrade_authority(svm: &LiteSVM, program: &Pubkey) -> Result<Option<Pubkey>, String> {
    let account = svm
        .get_account(program)
        .filter(|a| a.executable)
        .ok_or_else(|| format!("{program} is not a deployed program"))?;
    let key = |bytes: &[u8]| Pubkey::new_from_array(bytes.try_into().expect("32 bytes"));
    if account.owner == client::BPF_LOADER_UPGRADEABLE_ID {
        let data = svm
            .get_account(&pda::program_data(program))
            .map(|a| a.data)
            .filter(|d| d.len() >= PROGRAM_DATA_AUTHORITY.end)
            .ok_or_else(|| format!("{program}'s ProgramData is not in the copy"))?;
        return Ok(
            (data[PROGRAM_DATA_AUTHORITY_TAG] == 1).then(|| key(&data[PROGRAM_DATA_AUTHORITY]))
        );
    }
    if account.owner == LOADER_V4 {
        let data = account.data;
        let status = data
            .get(LOADER_V4_STATUS)
            .map(|b| u64::from_le_bytes(b.try_into().expect("8 bytes")))
            .ok_or_else(|| format!("{program}'s loader-v4 header is too short"))?;
        return Ok((status != LOADER_V4_FINALIZED).then(|| key(&data[LOADER_V4_AUTHORITY])));
    }
    if account.owner == LOADER_V1 || account.owner == LOADER_V2 {
        return Ok(None);
    }
    Err(format!(
        "{program} is owned by {}, not a program loader",
        account.owner
    ))
}

/// A contained mint's unlock PDA.
pub fn unlock_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[CONTAINMENT_HOOK_UNLOCK_SEED, mint.as_ref()],
        &CONTAINMENT_HOOK_PROGRAM,
    )
    .0
}

/// What one hooked mint is.
#[derive(Clone, Debug, Serialize)]
pub struct HookedMint {
    pub mint: usize,
    pub address: String,
    pub program: Option<String>,
    pub authority: Option<String>,
    pub unlock_pda: String,
    pub ours: bool,
    pub authority_is_unlock_pda: bool,
    /// The hook program's upgrade authority, `None` once frozen.
    pub upgrade_authority: Option<String>,
    /// Why the program's upgradeability could not be read.
    pub unreadable: Option<String>,
    /// Both fields unset, as after a contained token's unlock.
    pub emptied: bool,
}

/// Reads every hooked mint of the market.
pub fn measure(session: &mut Session) -> Vec<HookedMint> {
    let mut svm = session.fresh();
    let mut out = vec![];
    for (i, mint) in session.market.mints.clone().iter().enumerate() {
        let Some(hook) = mint.transfer_hook else {
            continue;
        };
        let mut read = HookedMint {
            mint: i,
            address: mint.address.to_string(),
            program: hook.program.map(|p| p.to_string()),
            authority: hook.authority.map(|a| a.to_string()),
            unlock_pda: unlock_pda(&mint.address).to_string(),
            ours: hook.program == Some(CONTAINMENT_HOOK_PROGRAM),
            authority_is_unlock_pda: hook.authority == Some(unlock_pda(&mint.address)),
            upgrade_authority: None,
            unreadable: None,
            emptied: hook.program.is_none() && hook.authority.is_none(),
        };
        if let Some(program) = hook.program {
            session.load(&mut svm, &[program]);
            match upgrade_authority(&svm, &program) {
                Ok(authority) => read.upgrade_authority = authority.map(|a| a.to_string()),
                Err(error) => read.unreadable = Some(error),
            }
        }
        out.push(read);
    }
    out
}

pub fn judge(hooked: &[HookedMint]) -> Verdict {
    let inputs = json!({
        "containment_hook": CONTAINMENT_HOOK_PROGRAM.to_string(),
        "unlock_pda_seeds": ["unlock", "mint"],
    });
    let numbers = json!({ "hooked_mints": hooked });
    let mut warns = vec![];
    let mut passes = vec![];
    for h in hooked.iter().filter(|h| !h.emptied) {
        let mint = format!("mint {}", h.mint);
        let program = h.program.as_deref().unwrap_or("no program");
        if !h.ours {
            warns.push(format!(
                "{mint}'s transfer hook is {program}, not our containment hook"
            ));
            continue;
        }
        if !h.authority_is_unlock_pda {
            warns.push(format!(
                "{mint}'s hook authority is {}, not the mint's unlock PDA {}",
                h.authority.as_deref().unwrap_or("unset"),
                h.unlock_pda
            ));
        }
        match (&h.upgrade_authority, &h.unreadable) {
            (Some(authority), _) => warns.push(format!(
                "our containment hook can still be upgraded by {authority}"
            )),
            (None, Some(error)) => warns.push(format!(
                "whether our containment hook can still be upgraded could not be read ({error})"
            )),
            (None, None) => {}
        }
        if h.authority_is_unlock_pda && h.upgrade_authority.is_none() && h.unreadable.is_none() {
            passes.push(mint);
        }
    }
    if !warns.is_empty() {
        let mut reason = warns.join("; ");
        reason[..1].make_ascii_uppercase();
        return Verdict::new(Outcome::Warn, format!("{reason}."), inputs, numbers);
    }
    if !passes.is_empty() {
        return Verdict::new(
            Outcome::Pass,
            format!(
                "{} {} contained by our containment hook, frozen, with the mint's unlock PDA as hook authority.",
                passes.join(" and "),
                if passes.len() == 1 { "is" } else { "are" }
            ),
            inputs,
            numbers,
        );
    }
    let reason = match hooked.iter().find(|h| h.emptied) {
        Some(h) => format!(
            "Not run: mint {}'s transfer hook extension has both its program and its authority unset, as a contained token's has after its unlock.",
            h.mint
        ),
        None => "Not run: no mint has a transfer hook.".to_string(),
    };
    Verdict::new(Outcome::NotRun, reason, inputs, numbers)
}
