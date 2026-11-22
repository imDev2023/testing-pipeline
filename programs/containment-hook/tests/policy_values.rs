//! One place for each policy value (owner, 2026-11-10; docs/spec/containment-hook.md, "Where
//! its policy values live"): the longest deadline and the tax AMM's program id are defined
//! once, in the program's config module, and no other file repeats them; the mint extension
//! allowlist is the shared mint-rules crate's and the hook keeps no copy of it; the goal and
//! the deadline are `bind`'s arguments, and the launch script has no default for either.
//!
//! The IDL and the client generated from it carry the longest deadline as a published
//! constant, which `tests/idl.rs` and `pnpm typecheck` keep equal to the program's, so they
//! are not counted as repeating it.

use std::path::{Path, PathBuf};

use containment_hook::config::{MAX_UNLOCK_DEADLINE_SECS, TAX_AMM_PROGRAM_ID};

fn hook_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every source file of the hook (program, tests, IDL, scripts and generated client),
/// skipping build output and installed packages.
fn hook_files() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if path.is_dir() {
                if !["target", "node_modules"].contains(&name.as_str()) {
                    walk(&path, out);
                }
            } else if ["rs", "ts", "json", "toml", "sh"]
                .iter()
                .any(|ext| path.extension().is_some_and(|e| e == *ext))
            {
                out.push(path);
            }
        }
    }
    let mut files = vec![];
    walk(&hook_dir(), &mut files);
    files
}

fn files_containing(needle: &str) -> Vec<String> {
    hook_files()
        .into_iter()
        .filter(|path| std::fs::read_to_string(path).unwrap().contains(needle))
        .map(|path| {
            path.strip_prefix(hook_dir())
                .unwrap()
                .to_string_lossy()
                .to_string()
        })
        .filter(|path| path != "tests/policy_values.rs")
        .filter(|path| !generated(path))
        .collect()
}

/// The IDL and the TypeScript client, generated from the program.
fn generated(path: &str) -> bool {
    path == "idl/containment_hook.json" || path.starts_with("scripts/client/")
}

#[test]
fn the_two_constants_are_defined_once_in_the_config_module() {
    for name in ["MAX_UNLOCK_DEADLINE_SECS", "TAX_AMM_PROGRAM_ID"] {
        assert_eq!(
            files_containing(&format!("const {name}")),
            vec!["src/config.rs".to_string()],
            "{name}"
        );
    }
    // Neither value is written out anywhere in the hook: not the tax AMM's address, which
    // the config module takes from the tax AMM's own crate, and not 90 days in seconds.
    assert!(files_containing(&TAX_AMM_PROGRAM_ID.to_string()).is_empty());
    assert!(files_containing(&MAX_UNLOCK_DEADLINE_SECS.to_string()).is_empty());
    assert!(files_containing("tax_amm::ID").contains(&"src/config.rs".to_string()));
    assert_eq!(
        files_containing("tax_amm::ID"),
        vec!["src/config.rs".to_string()]
    );
}

#[test]
fn the_extension_allowlist_is_the_mint_rules_crates() {
    assert!(files_containing("ALLOWED_MINT_EXTENSIONS").is_empty());
    let bind = std::fs::read_to_string(hook_dir().join("src/instructions/bind.rs")).unwrap();
    assert!(bind.contains("mint_rules::check_mint("));
}

#[test]
fn the_launch_script_has_no_default_for_the_goal_or_the_deadline() {
    let script = std::fs::read_to_string(hook_dir().join("scripts/launch.ts")).unwrap();
    let options = script
        .split("options: {")
        .nth(1)
        .and_then(|rest| rest.split("strict:").next())
        .expect("the script's parseArgs options");
    for flag in ["goal", "deadline"] {
        let line = options
            .lines()
            .find(|line| line.trim_start().starts_with(&format!("{flag}:")))
            .unwrap_or_else(|| panic!("the script has no --{flag} option"));
        assert!(!line.contains("default"), "--{flag} has a default: {line}");
    }
    // Nor does it repeat the program's limit on the deadline: it reads the generated client's.
    assert!(script.contains("MAX_UNLOCK_DEADLINE_SECS"));
    for value in ["90", &MAX_UNLOCK_DEADLINE_SECS.to_string()] {
        assert!(
            !script.contains(&format!("{value} days")) && !script.contains(&format!("= {value}")),
            "{value}"
        );
    }
}

/// The tax AMM admits a live transfer hook only when it is this hook with the mint's unlock
/// PDA as its authority (its "Mint rules", hardening finding H007 of #67). This program
/// depends on the tax AMM, so the tax AMM writes this program's id and unlock seed itself;
/// they must be this program's, or no contained token could ever have a home market.
#[test]
fn the_tax_amm_admits_this_hook_by_its_own_id_and_unlock_seed() {
    assert_eq!(
        tax_amm::config::CONTAINMENT_HOOK_ID.to_bytes(),
        containment_hook::ID.to_bytes()
    );
    assert_eq!(
        tax_amm::config::CONTAINMENT_UNLOCK_SEED,
        containment_hook::state::UNLOCK_SEED
    );
}
