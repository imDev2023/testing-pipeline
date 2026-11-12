//! No policy value is written outside `src/config.rs` (`CANARY-28`), and a change to any of
//! them changes the `harness` version every record carries.

use std::path::{Path, PathBuf};

use canary::config::*;
use sha2::{Digest, Sha256};

/// Every policy value, by name, as the spec's table lists them.
fn policy_values() -> Vec<(&'static str, Vec<u64>)> {
    let waits: Vec<u64> = WAITS
        .iter()
        .filter_map(|(_, wait)| match wait {
            Wait::Seconds(s) => Some(*s),
            _ => None,
        })
        .collect();
    vec![
        ("SOL_SIZES", SOL_SIZES.to_vec()),
        ("SOL_REFERENCE_SIZE", vec![SOL_REFERENCE_SIZE]),
        ("VAULT_SIZES_PPM", VAULT_SIZES_PPM.to_vec()),
        ("VAULT_REFERENCE_PPM", vec![VAULT_REFERENCE_PPM]),
        ("SMALL_VAULT_UNITS", vec![SMALL_VAULT_UNITS]),
        (
            "SMALL_VAULT_SIZES_HUNDREDTHS",
            SMALL_VAULT_SIZES_HUNDREDTHS.to_vec(),
        ),
        (
            "SMALL_VAULT_REFERENCE_HUNDREDTHS",
            vec![SMALL_VAULT_REFERENCE_HUNDREDTHS],
        ),
        ("WAITS", waits),
        (
            "LAUNCH_CLOCK_SECONDS",
            LAUNCH_CLOCK_SECONDS.iter().map(|(_, s)| *s).collect(),
        ),
        (
            "SLOTS_PER_SECOND",
            vec![SLOTS_PER_SECOND_NUMERATOR, SLOTS_PER_SECOND_DENOMINATOR],
        ),
        ("SLOTS_PER_EPOCH", vec![SLOTS_PER_EPOCH]),
        ("PASS_BAND_MIN_PPM", vec![PASS_BAND_MIN_PPM]),
        ("FAIL_BAND_BELOW_PPM", vec![FAIL_BAND_BELOW_PPM]),
        ("TOLERANCE_PPM", vec![TOLERANCE_PPM]),
        ("FRESH_WALLETS", vec![FRESH_WALLETS as u64]),
        ("QUEUE_BUYERS", vec![QUEUE_BUYERS as u64]),
        ("MINT_AUTHORITY_MULTIPLE", vec![MINT_AUTHORITY_MULTIPLE]),
        (
            "TRANSFER_FEE_ACTING_BPS",
            vec![TRANSFER_FEE_ACTING_BPS as u64],
        ),
        ("TRANSFER_FEE_EPOCHS_ON", vec![TRANSFER_FEE_EPOCHS_ON]),
        ("QUOTE_COMPUTE_LIMIT", vec![QUOTE_COMPUTE_LIMIT as u64]),
        ("SWAP_COMPUTE_LIMIT", vec![SWAP_COMPUTE_LIMIT as u64]),
        ("SNAPSHOT_ROUNDS", vec![SNAPSHOT_ROUNDS as u64]),
        ("SNAPSHOT_MAX_BYTES", vec![SNAPSHOT_MAX_BYTES as u64]),
        // Units, kept in config.rs so no other file writes them either.
        ("LAMPORTS_PER_SOL", vec![LAMPORTS_PER_SOL]),
        ("PPM", vec![PPM]),
        ("HUNDREDTHS", vec![HUNDREDTHS]),
    ]
}

/// The harness version and the fingerprint of the policy values it was released with.
/// Change a value, and this test fails until HARNESS and the fingerprint change with it.
const PINNED: (&str, &str) = ("canary/0.1.0", "e3d60f4b291334b8");

/// Values this small are everywhere in ordinary arithmetic and layouts (indices, decimal
/// digits, byte offsets), so the grep cannot tell them from a policy value; the spec's values
/// of this size are the snapshot rounds (4), the wallets (5), the epochs a fee waits (2),
/// the clock rate (5 / 2) and the 10-second wait.
const TOO_COMMON: u64 = 10;

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// The integer literals on a line of code, with comments cut.
fn literals(line: &str) -> Vec<u64> {
    let code = line.split("//").next().unwrap_or("");
    let bytes = code.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < bytes.len() {
        let starts_word = i == 0
            || !(bytes[i - 1].is_ascii_alphanumeric()
                || bytes[i - 1] == b'_'
                || bytes[i - 1] == b'.');
        if bytes[i].is_ascii_digit() && starts_word {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'_') {
                i += 1;
            }
            // A float or a hex literal is not an integer literal.
            let float = i < bytes.len()
                && bytes[i] == b'.'
                && bytes.get(i + 1).is_some_and(u8::is_ascii_digit);
            let hex = code[start..].starts_with("0x");
            if !float && !hex {
                if let Ok(value) = code[start..i].replace('_', "").parse::<u64>() {
                    out.push(value);
                }
            }
        } else {
            i += 1;
        }
    }
    out
}

#[test]
fn no_policy_value_is_written_outside_the_config_module() {
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![];
    rust_files(&src, &mut files);
    assert!(files.len() > 5, "found the sources");
    let forbidden: Vec<(&str, u64)> = policy_values()
        .into_iter()
        .flat_map(|(name, values)| values.into_iter().map(move |v| (name, v)))
        .filter(|(_, v)| *v > TOO_COMMON)
        .collect();
    let percents: Vec<String> = [PASS_BAND_MIN_PPM, FAIL_BAND_BELOW_PPM]
        .iter()
        .map(|ppm| format!("{}%", ppm / PPM_PER_POINT))
        .collect();
    let mut found = vec![];
    for file in files.iter().filter(|f| !f.ends_with("config.rs")) {
        let text = std::fs::read_to_string(file).unwrap();
        for (number, line) in text.lines().enumerate() {
            let place = format!(
                "{}:{}",
                file.strip_prefix(&src).unwrap().display(),
                number + 1
            );
            for value in literals(line) {
                for (name, _) in forbidden.iter().filter(|(_, v)| *v == value) {
                    found.push(format!("{place}: {value} is {name}"));
                }
            }
            let code = line.split("//").next().unwrap_or("");
            for percent in &percents {
                if code.contains(percent.as_str()) {
                    found.push(format!("{place}: {percent} is a band"));
                }
            }
        }
    }
    assert!(
        found.is_empty(),
        "policy values written outside config.rs:\n{}",
        found.join("\n")
    );
}

#[test]
fn the_grep_finds_a_policy_value_where_one_is_written() {
    assert_eq!(literals("let pass = 950_000u64; // 50_000"), vec![950_000]);
    assert_eq!(literals("x.0 + v2 + 1.5 + 0x10 + 3"), vec![3]);
}

#[test]
fn the_harness_version_changes_with_the_policy_values() {
    let digest = Sha256::digest(format!("{:?}", policy_values()).as_bytes());
    let fingerprint: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        (HARNESS, fingerprint.as_str()),
        PINNED,
        "a policy value changed: change HARNESS in src/config.rs, then PINNED here to the new pair"
    );
}
