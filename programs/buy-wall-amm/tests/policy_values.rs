//! One place for each policy value (owner, 2026-11-10; docs/spec/pool4-for-solana.md,
//! "Constants"): every constant of the spec's table is defined once, in the program's
//! `config.rs`, and no other file of the program, its metadata or its demo script repeats
//! it; the mint extension allowlist lives only in the shared mint-rules crate, which the
//! program calls; every other policy value is a creation parameter.

use std::path::{Path, PathBuf};

use buy_wall_amm::config::SUITE_TREASURY;

/// The spec's constants (docs/spec/pool4-for-solana.md, "Constants"), by name.
const CONSTANTS: [&str; 22] = [
    "MIN_FEE_BPS",
    "MAX_FEE_BPS",
    "DESIGNER_SHARE_BPS",
    "SUITE_SHARE_BPS",
    "DESIGNER_RECIPIENT",
    "SUITE_TREASURY",
    "MAX_REWARD_SHARE_BPS",
    "MIN_CAP_FLOOR_BPS",
    "MAX_CAP_DECAY_BPS",
    "WALL_THRESHOLD",
    "KEEPER_TIP_CAP",
    "FLOOR_CRAWL_BPS",
    "REF_STEP_BPS",
    "REF_STEP_WINDOW",
    "DECAY_CREDIT_WINDOW",
    "MIN_SQRT_PRICE",
    "MAX_SQRT_PRICE",
    "MIN_SEED_LAMPORTS",
    "MIN_OPENING_SQRT_PRICE",
    "MAX_OPENING_SQRT_PRICE",
    "MIN_LIQUIDITY",
    "MARKET_STATE_SIZE",
];

fn program_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every source file of the program, skipping build output, installed packages and the
/// client generated from its IDL.
fn source_files() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if path.is_dir() {
                if !["target", "node_modules", "client"].contains(&name.as_str()) {
                    walk(&path, out);
                }
            } else if ["rs", "ts", "json", "toml", "py"]
                .iter()
                .any(|ext| path.extension().is_some_and(|e| e == *ext))
            {
                out.push(path);
            }
        }
    }
    let mut files = vec![];
    walk(&program_dir(), &mut files);
    files
}

fn files_containing(needle: &str) -> Vec<String> {
    let root = program_dir();
    source_files()
        .into_iter()
        .filter(|path| std::fs::read_to_string(path).unwrap().contains(needle))
        .map(|path| {
            path.strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .to_string()
        })
        .filter(|path| path != "tests/policy_values.rs")
        .collect()
}

#[test]
fn every_constant_is_defined_once_in_config() {
    let config = std::fs::read_to_string(program_dir().join("src/config.rs")).unwrap();
    for name in CONSTANTS {
        assert!(
            config.contains(&format!("pub const {name}:")),
            "config.rs lacks {name}"
        );
        assert_eq!(
            files_containing(&format!("const {name}")),
            vec!["src/config.rs".to_string()],
            "{name}"
        );
    }
    // The treasury's address is written nowhere else in the program.
    assert_eq!(
        files_containing(&SUITE_TREASURY.to_string()),
        vec!["src/config.rs".to_string()]
    );
}

#[test]
fn the_mint_extension_allowlist_is_the_shared_crates() {
    assert!(files_containing("ALLOWED_MINT_EXTENSIONS").is_empty());
    let init =
        std::fs::read_to_string(program_dir().join("src/instructions/init_market.rs")).unwrap();
    assert!(init.contains("mint_rules::check_mint("));
}

#[test]
fn the_metadata_and_the_demo_state_no_policy_value() {
    for file in ["metadata.json", "scripts/demo.ts"] {
        let text = std::fs::read_to_string(program_dir().join(file)).unwrap();
        for value in ["%", "bps =", &SUITE_TREASURY.to_string()] {
            assert!(!text.contains(value), "{file} repeats {value:?}");
        }
    }
}
