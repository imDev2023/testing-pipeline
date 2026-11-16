//! One place for each policy value (owner, 2026-11-10; docs/spec/lending-pool.md,
//! "Constants"): every constant is defined once, in the program's config module, the lent
//! mints and their reserves are written nowhere else in the on-chain workspace, the devnet
//! rows equal `deployments/kamino-devnet.json`, and neither the metadata nor the demo script
//! states a policy value. Every other policy value is a creation parameter.

use std::path::{Path, PathBuf};

use lending_amm::config::{self, LENT_MINTS};

fn programs_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Every source file of the on-chain workspace and the programs' scripts, skipping build
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
            } else if ["rs", "ts", "json", "toml", "py", "sh"]
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
        .filter(|path| path != "lending-amm/tests/policy_values.rs")
        // The IDL and the client generated from it carry the constants the program
        // exports, generated from the config module, never written by hand.
        .filter(|path| {
            !path.starts_with("lending-amm/idl/")
                && !path.starts_with("lending-amm/scripts/client/")
        })
        // The Kamino accounts dumped from each cluster are data read from the chain, never
        // written by hand; `tests/kamino.rs` checks they are the reserves the config module
        // names.
        .filter(|path| !path.starts_with("lending-amm/tests/fixtures/"))
        .collect()
}

const CONFIG: &str = "lending-amm/src/config.rs";

#[test]
fn every_constant_is_defined_once_in_the_config_module() {
    for name in [
        "BUFFER_TARGET_BPS",
        "BUFFER_MIN_BPS",
        "BUFFER_MAX_BPS",
        "WITHDRAW_MODE_ENTER",
        "WITHDRAW_MODE_EXIT",
        "MAX_LP_FEE_BPS",
        "MINIMUM_LIQUIDITY",
        "LP_DECIMALS",
        "KLEND_PROGRAM",
        "LENT_MINTS",
    ] {
        assert_eq!(
            files_containing(&format!("const {name}")),
            vec![CONFIG.to_string()],
            "{name}"
        );
    }
}

#[test]
fn the_lent_mints_reserves_and_kamino_are_written_only_in_the_config_module() {
    // WSOL's address is the native mint, which tests and scripts may name as such; every
    // other address of the list (USDC, the lending markets, reserves and collateral mints)
    // and klend's lives only in the config module. The devnet ones also live in
    // deployments/kamino-devnet.json, outside the on-chain workspace, which they must equal.
    let mut addresses = vec![config::KLEND_PROGRAM.to_string()];
    for entry in LENT_MINTS {
        if entry.mint != config::WSOL {
            addresses.push(entry.mint.to_string());
        }
        addresses.push(entry.lending_market.to_string());
        addresses.push(entry.reserve.to_string());
        addresses.push(entry.collateral_mint.to_string());
    }
    for address in addresses {
        let files = files_containing(&address);
        // Metadata cannot read the config module, so `rebalance`'s accounts name klend there,
        // as a fixed account and as the program of its lending market authority; the test
        // below checks those are the config module's klend, and tests/metadata.rs that the
        // instruction built from them is the program's.
        let allowed = |f: &String| {
            f == CONFIG
                || (address == config::KLEND_PROGRAM.to_string()
                    && f == "lending-amm/metadata.json")
        };
        assert!(
            files.iter().all(allowed),
            "{address} is written outside the config module: {files:?}"
        );
    }
}

#[test]
fn the_metadata_names_only_the_config_modules_klend() {
    let text = std::fs::read_to_string(programs_dir().join("lending-amm/metadata.json")).unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&text).unwrap();
    let rebalance = metadata["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "rebalance")
        .expect("the rebalance action");
    let sources: Vec<&str> = rebalance["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["source"].as_str().unwrap())
        .collect();
    let klend = config::KLEND_PROGRAM.to_string();
    assert!(sources.contains(&format!("fixed:{klend}").as_str()));
    assert!(sources.contains(&format!("pda:{klend}:str:lma,key:input:lending_market").as_str()));
    // Nowhere else, and no other address that looks like Kamino's.
    assert_eq!(text.matches(&klend).count(), 2);
    assert_eq!(text.matches("KLend").count(), 2);
}

#[cfg(feature = "devnet")]
#[test]
fn the_devnet_rows_equal_the_committed_kamino_deployment() {
    let path = programs_dir().join("../deployments/kamino-devnet.json");
    let deployment: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(
        deployment["klendProgram"],
        config::KLEND_PROGRAM.to_string()
    );
    let market = deployment["lendingMarket"]["address"].as_str().unwrap();
    for (entry, key) in LENT_MINTS.iter().zip(["wsol", "testUsdc"]) {
        let reserve = &deployment["reserves"][key];
        assert_eq!(
            entry.mint.to_string(),
            reserve["liquidityMint"].as_str().unwrap()
        );
        assert_eq!(entry.lending_market.to_string(), market);
        assert_eq!(
            entry.reserve.to_string(),
            reserve["address"].as_str().unwrap()
        );
        assert_eq!(
            entry.collateral_mint.to_string(),
            reserve["collateralMint"].as_str().unwrap()
        );
    }
    assert_eq!(
        LENT_MINTS[1].mint.to_string(),
        deployment["testUsdc"]["mint"].as_str().unwrap()
    );
}

#[test]
fn the_metadata_and_the_demo_state_no_policy_value() {
    for file in ["lending-amm/metadata.json", "lending-amm/scripts/demo.ts"] {
        let text = std::fs::read_to_string(programs_dir().join(file)).unwrap();
        for value in [
            "2%",
            "20%",
            "200 bps",
            "MAX_LP_FEE_BPS =",
            "MINIMUM_LIQUIDITY =",
            "1_000n",
        ] {
            assert!(!text.contains(value), "{file} repeats {value:?}");
        }
    }
}

#[test]
fn the_constants_have_the_specs_values() {
    // docs/spec/lending-pool.md, "Constants"; a change there is a change here, in one edit.
    assert_eq!(
        (
            config::BUFFER_TARGET_BPS,
            config::BUFFER_MIN_BPS,
            config::BUFFER_MAX_BPS
        ),
        (2_000, 1_000, 3_000)
    );
    assert_eq!(
        (config::WITHDRAW_MODE_ENTER, config::WITHDRAW_MODE_EXIT),
        (5, 10)
    );
    assert_eq!(config::MAX_LP_FEE_BPS, 200);
    assert_eq!(config::MINIMUM_LIQUIDITY, 1_000);
    assert_eq!(config::LP_DECIMALS, 9);
    assert_eq!(
        LENT_MINTS.map(|entry| entry.min_rebalance),
        [50_000_000, 5_000_000]
    );
}

#[test]
fn the_pinned_klend_program_is_the_config_modules() {
    // fetch-klend.sh and the local validator read klend's address from fixtures/pins.env,
    // beside the hashes they check its bytes against; it must be the config module's.
    let pins = std::fs::read_to_string(programs_dir().join("../fixtures/pins.env")).unwrap();
    let pinned: Vec<&str> = pins
        .lines()
        .filter_map(|line| line.strip_prefix("KLEND_PROGRAM="))
        .collect();
    assert_eq!(pinned, vec![config::KLEND_PROGRAM.to_string().as_str()]);
}
