//! The built program carries a `security.txt` (`solana-security-txt`) whose contact is
//! this repo's private vulnerability reporting page and whose source is this repo
//! (docs/spec/README.md, "Verified builds"; docs/spec/buy-wall-amm.md, "Custom actions and
//! metadata").
//!
//! Reads the same `buy_wall_amm.so` the LiteSVM tests load, so build first:
//! `cargo build-sbf --manifest-path programs/buy-wall-amm/Cargo.toml`.

mod common;

use std::collections::HashMap;

const BEGIN: &[u8] = b"=======BEGIN SECURITY.TXT V1=======\0";
const END: &[u8] = b"=======END SECURITY.TXT V1=======\0";

/// The fields of the `security.txt` embedded in `program`: NUL-separated key and value
/// pairs between the BEGIN and END markers.
fn security_txt(program: &[u8]) -> HashMap<String, String> {
    let find = |haystack: &[u8], needle: &[u8]| {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    };
    let start = find(program, BEGIN).expect("the program embeds no security.txt") + BEGIN.len();
    let end = start + find(&program[start..], END).expect("the security.txt has no END marker");
    let fields: Vec<String> = program[start..end]
        .split(|&b| b == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8(field.to_vec()).expect("a security.txt field is UTF-8"))
        .collect();
    assert!(
        fields.len().is_multiple_of(2),
        "security.txt fields come in pairs: {fields:?}"
    );
    fields
        .chunks(2)
        .map(|pair| (pair[0].clone(), pair[1].clone()))
        .collect()
}

#[test]
fn the_built_program_embeds_its_security_txt() {
    let fields = security_txt(&common::strategy_so());
    let field = |key: &str| {
        fields
            .get(key)
            .unwrap_or_else(|| panic!("security.txt has no {key}: {fields:?}"))
            .as_str()
    };

    assert_eq!(field("name"), "Aviary Buy Wall AMM");
    assert_eq!(
        field("contacts"),
        "link:https://github.com/imDev2023/testing-pipeline/security/advisories/new"
    );
    assert_eq!(
        field("source_code"),
        "https://github.com/imDev2023/testing-pipeline"
    );
    assert_eq!(
        field("policy"),
        "https://github.com/imDev2023/testing-pipeline/security/policy"
    );
    // Internal reviews are never presented as audits (docs/spec/README.md, "Internal
    // adversarial review").
    assert_eq!(field("auditors"), "None");
}
