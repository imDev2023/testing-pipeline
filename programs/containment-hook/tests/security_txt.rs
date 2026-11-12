//! The built program carries a `security.txt` (`solana-security-txt`) whose name is the
//! hook's public name, Aviary Containment Hook, whose contact is this repo's private
//! vulnerability reporting page and whose source is this repo (docs/spec/README.md,
//! "Verified builds"; docs/spec/containment-hook.md, "Where its policy values live").
//!
//! Reads the same `containment_hook.so` the LiteSVM tests load, so build first.

mod support;

use std::collections::HashMap;

const BEGIN: &[u8] = b"=======BEGIN SECURITY.TXT V1=======\0";
const END: &[u8] = b"=======END SECURITY.TXT V1=======\0";

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
    assert!(fields.len().is_multiple_of(2), "{fields:?}");
    fields
        .chunks(2)
        .map(|pair| (pair[0].clone(), pair[1].clone()))
        .collect()
}

#[test]
fn the_built_program_embeds_its_security_txt() {
    let fields = security_txt(&support::hook_so());
    let field = |key: &str| {
        fields
            .get(key)
            .unwrap_or_else(|| panic!("security.txt has no {key}: {fields:?}"))
            .as_str()
    };
    assert_eq!(field("name"), "Aviary Containment Hook");
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
    assert_eq!(field("auditors"), "None");
}

#[test]
fn the_public_name_lives_only_in_the_security_txt() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let config = std::fs::read_to_string(dir.join("src/config.rs")).unwrap();
    assert!(config.contains("name: \"Aviary Containment Hook\""));
    // The terminal is Aviary too, so only the hook's own public name is looked for.
    for file in [
        "src/lib.rs",
        "src/state.rs",
        "src/errors.rs",
        "idl/containment_hook.json",
        "scripts/launch.ts",
    ] {
        let text = std::fs::read_to_string(dir.join(file)).unwrap();
        assert!(
            !text.contains("Aviary Containment Hook"),
            "{file} names the public name"
        );
    }
}
