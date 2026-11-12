//! One place for each policy value (owner, 2026-11-10; docs/spec/tax-amm.md, "Where its
//! policy values live"): the four build-time constants are defined once, in the program's
//! config module, and the mint extension allowlist once, in the mint-rules crate, which
//! depends on nothing, so another program can use it without pulling in the tax AMM. No
//! other file of the on-chain workspace, the strategy metadata or the demo script repeats
//! them; every other policy value is a creation parameter. The two the program publishes in
//! its IDL with `#[constant]` also appear in the TypeScript client generated from it, which
//! `pnpm typecheck` keeps equal to the IDL.
//!
//! One named place per product: another program of the workspace keeps its own config (the
//! buy wall AMM has its own suite share and names the same suite treasury, with no
//! dependency on the tax AMM), so the constants are checked among the tax AMM's own files
//! and the workspace's shared ones.

use std::path::{Path, PathBuf};

use tax_amm::config::SUITE_TREASURY;

fn programs_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Every source file of the on-chain workspace and the program's scripts, skipping build
/// output and installed packages.
fn source_files() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if path.is_dir() {
                if !["target", "node_modules"].contains(&name.as_str()) {
                    walk(&path, out);
                }
            } else if ["rs", "ts", "json", "toml"]
                .iter()
                .any(|ext| path.extension().is_some_and(|e| e == *ext))
            {
                out.push(path);
            }
        }
    }
    let mut files = vec![];
    walk(&programs_dir(), &mut files);
    files
}

/// Whether `path` (relative to the workspace) is the tax AMM's, a shared crate's or the
/// workspace's own, rather than another program's.
fn tax_amm_or_shared(path: &str) -> bool {
    path.starts_with("tax-amm/") || path.starts_with("mint-rules/") || !path.contains('/')
}

fn files_containing(needle: &str) -> Vec<String> {
    let programs = programs_dir().canonicalize().unwrap();
    source_files()
        .into_iter()
        .filter(|path| std::fs::read_to_string(path).unwrap().contains(needle))
        .map(|path| {
            path.canonicalize()
                .unwrap()
                .strip_prefix(&programs)
                .unwrap()
                .to_string_lossy()
                .to_string()
        })
        .filter(|path| path != "tax-amm/tests/policy_values.rs")
        .collect()
}

#[test]
fn the_four_constants_are_defined_once_in_the_config_module() {
    for (name, published) in [
        ("MAX_TAX_BPS", true),
        ("SUITE_SHARE_BPS", true),
        ("SUITE_TREASURY", true),
        ("MAX_RECIPIENTS", false),
    ] {
        let mut defined: Vec<String> = files_containing(&format!("const {name}"))
            .into_iter()
            .filter(|path| tax_amm_or_shared(path))
            .collect();
        defined.sort();
        let mut expected = vec!["tax-amm/src/config.rs".to_string()];
        if published {
            expected.insert(0, "tax-amm/scripts/client/constants/taxAmm.ts".to_string());
        }
        assert_eq!(defined, expected, "{name}");
    }
    // The treasury's address is written nowhere else but the IDL, which publishes it, and
    // the client generated from the IDL.
    let mut written: Vec<String> = files_containing(&SUITE_TREASURY.to_string())
        .into_iter()
        .filter(|path| tax_amm_or_shared(path))
        .collect();
    written.sort();
    assert_eq!(
        written,
        [
            "tax-amm/idl/tax_amm.json",
            "tax-amm/scripts/client/constants/taxAmm.ts",
            "tax-amm/src/config.rs"
        ]
    );
}

#[test]
fn the_extension_allowlist_is_defined_once_in_the_mint_rules_crate() {
    assert_eq!(
        files_containing("const ALLOWED_MINT_EXTENSIONS"),
        vec!["mint-rules/src/lib.rs".to_string()]
    );
    // The tax AMM applies the one check and keeps no list of its own.
    let program =
        std::fs::read_to_string(programs_dir().join("tax-amm/src/instructions/init_market.rs"))
            .unwrap();
    assert!(program.contains("mint_rules::check_mint("));
    // The crate depends on nothing, so a program using it pulls in no other program.
    let manifest = std::fs::read_to_string(programs_dir().join("mint-rules/Cargo.toml")).unwrap();
    let manifest: toml::Table = manifest.parse().unwrap();
    assert!(manifest.get("dependencies").is_none());
}

#[test]
fn the_metadata_and_the_demo_state_no_policy_value() {
    // The suite share and the cap are both 10%, which prose would be tempted to repeat.
    for file in ["tax-amm/metadata.json", "tax-amm/scripts/demo.ts"] {
        let text = std::fs::read_to_string(programs_dir().join(file)).unwrap();
        for value in [
            "10%",
            "1,000 bps",
            "MAX_TAX_BPS =",
            &SUITE_TREASURY.to_string(),
        ] {
            assert!(!text.contains(value), "{file} repeats {value:?}");
        }
    }
}
