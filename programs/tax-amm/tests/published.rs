//! What the metadata publishes about the deployed program (docs/spec/README.md, "Metadata, IDL
//! and conformance report"): `security.audits` is empty, `links.docs` is the program's README,
//! and once the metadata names a commit, every link into this repo is at that commit, the
//! commit is the one `deployments/devnet.json` records for the program, and the conformance
//! report it names is the one committed beside the program, with its SHA-256.
//!
//! Before the first deploy the links point at `main` and name no commit; the devnet ticket
//! pins them (docs/toolchain.md, "Deploy to devnet").

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const REPO: &str = "https://github.com/imDev2023/testing-pipeline";
const RAW: &str = "https://raw.githubusercontent.com/imDev2023/testing-pipeline";
const DIR: &str = "programs/tax-amm";
/// The program's name in `deployments/devnet.json`, its crate's name.
const PROGRAM: &str = "tax-amm";
/// The devnet demo market's `pipeline-check` report, beside the program.
const REPORT: &str = "conformance/devnet.json";

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn is_commit(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Checks the published facts of `metadata` against the commit `deployments/devnet.json`
/// records for the program (if it is deployed) and the committed conformance report (if any).
fn check_published(
    metadata: &Value,
    deployed_commit: Option<&str>,
    report: Option<&[u8]>,
) -> Result<(), String> {
    if metadata["security"]["audits"] != json!([]) {
        return Err(format!(
            "security.audits must be an empty list, not {}",
            metadata["security"]["audits"]
        ));
    }
    let commit = match metadata["source"].get("commit") {
        None => None,
        Some(Value::String(commit)) if is_commit(commit) => Some(commit.as_str()),
        Some(other) => return Err(format!("source.commit must be a full commit hash, not {other}")),
    };
    match (commit, deployed_commit) {
        (Some(commit), Some(deployed)) if commit != deployed => {
            return Err(format!(
                "source.commit is {commit}, but deployments/devnet.json records {deployed}"
            ))
        }
        (Some(commit), None) => {
            return Err(format!(
                "source.commit is {commit}, but deployments/devnet.json records no deploy"
            ))
        }
        _ => {}
    }
    let at = commit.unwrap_or("main");
    let expected = [
        ("source", format!("{REPO}/tree/{at}/{DIR}")),
        ("idl", format!("{RAW}/{at}/{DIR}/idl/tax_amm.json")),
        ("docs", format!("{REPO}/blob/{at}/{DIR}/README.md")),
    ];
    for (key, want) in expected {
        if metadata["links"][key] != want.as_str() {
            return Err(format!("links.{key} must be {want}, not {}", metadata["links"][key]));
        }
    }
    let Some(conformance) = metadata.get("conformance") else {
        return Ok(());
    };
    if commit.is_none() {
        return Err("conformance is published only with the deployed commit in source.commit".into());
    }
    let url = conformance["report"].as_str().unwrap_or_default();
    let report_commit = url
        .strip_prefix(&format!("{RAW}/"))
        .and_then(|rest| rest.strip_suffix(&format!("/{DIR}/{REPORT}")))
        .filter(|c| is_commit(c));
    if report_commit.is_none() {
        return Err(format!(
            "conformance.report must be {RAW}/<commit>/{DIR}/{REPORT}, not {url}"
        ));
    }
    let Some(report) = report else {
        return Err(format!("conformance names a report, but {DIR}/{REPORT} is not committed"));
    };
    let sha = sha256_hex(report);
    if conformance["sha256"] != sha.as_str() {
        return Err(format!(
            "conformance.sha256 is {}, but {DIR}/{REPORT} hashes to {sha}",
            conformance["sha256"]
        ));
    }
    Ok(())
}

/// The commit `deployments/devnet.json` records for the program, if it records it.
fn deployed_commit() -> Option<String> {
    let path = manifest_dir().join("../../deployments/devnet.json");
    if !path.exists() {
        return None;
    }
    read_json(&path)["programs"][PROGRAM]["commit"]
        .as_str()
        .map(str::to_owned)
}

#[test]
fn the_committed_metadata_publishes_what_was_deployed() {
    let metadata = read_json(&manifest_dir().join("metadata.json"));
    let report = std::fs::read(manifest_dir().join(REPORT)).ok();
    check_published(&metadata, deployed_commit().as_deref(), report.as_deref()).unwrap();
}

#[test]
fn the_metadata_links_the_programs_readme_as_its_docs() {
    assert!(manifest_dir().join("README.md").is_file());
}

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const OTHER: &str = "89abcdef0123456789abcdef0123456789abcdef";

fn unpinned() -> Value {
    json!({
        "links": {
            "source": format!("{REPO}/tree/main/{DIR}"),
            "idl": format!("{RAW}/main/{DIR}/idl/tax_amm.json"),
            "docs": format!("{REPO}/blob/main/{DIR}/README.md"),
            "github": REPO,
        },
        "source": { "repository": REPO, "path": DIR },
        "security": { "contact": "x", "audits": [] },
    })
}

fn pinned(at: &str) -> Value {
    let mut m = unpinned();
    m["links"]["source"] = json!(format!("{REPO}/tree/{at}/{DIR}"));
    m["links"]["idl"] = json!(format!("{RAW}/{at}/{DIR}/idl/tax_amm.json"));
    m["links"]["docs"] = json!(format!("{REPO}/blob/{at}/{DIR}/README.md"));
    m["source"]["commit"] = json!(at);
    m
}

fn with_report(mut m: Value, report_commit: &str, report: &[u8]) -> Value {
    m["conformance"] = json!({
        "report": format!("{RAW}/{report_commit}/{DIR}/{REPORT}"),
        "sha256": sha256_hex(report),
    });
    m
}

#[test]
fn before_the_deploy_the_links_point_at_main() {
    check_published(&unpinned(), None, None).unwrap();
    // A deploy recorded before the metadata is pinned: the pinning PR follows it.
    check_published(&unpinned(), Some(COMMIT), None).unwrap();
}

#[test]
fn pinned_links_are_at_the_deployed_commit() {
    check_published(&pinned(COMMIT), Some(COMMIT), None).unwrap();
    let report = br#"{"checks":[]}"#;
    check_published(&with_report(pinned(COMMIT), OTHER, report), Some(COMMIT), Some(report)).unwrap();
}

#[test]
fn a_commit_that_is_not_the_deployed_one_is_refused() {
    let err = check_published(&pinned(COMMIT), Some(OTHER), None).unwrap_err();
    assert!(err.contains("records"), "{err}");
    let err = check_published(&pinned(COMMIT), None, None).unwrap_err();
    assert!(err.contains("no deploy"), "{err}");
    let mut short = pinned(COMMIT);
    short["source"]["commit"] = json!("0123456");
    assert!(check_published(&short, Some("0123456"), None).is_err());
}

#[test]
fn a_link_left_at_another_commit_or_at_main_is_refused() {
    let mut m = pinned(COMMIT);
    m["links"]["idl"] = json!(format!("{RAW}/{OTHER}/{DIR}/idl/tax_amm.json"));
    assert!(check_published(&m, Some(COMMIT), None).unwrap_err().contains("links.idl"));
    let mut m = pinned(COMMIT);
    m["links"]["docs"] = json!(format!("{REPO}/blob/main/{DIR}/README.md"));
    assert!(check_published(&m, Some(COMMIT), None).unwrap_err().contains("links.docs"));
}

#[test]
fn a_report_that_does_not_match_its_hash_is_refused() {
    let m = with_report(pinned(COMMIT), OTHER, b"the report published");
    let err = check_published(&m, Some(COMMIT), Some(b"another report")).unwrap_err();
    assert!(err.contains("hashes to"), "{err}");
    let err = check_published(&m, Some(COMMIT), None).unwrap_err();
    assert!(err.contains("not committed"), "{err}");
    let mut at_main = m.clone();
    at_main["conformance"]["report"] = json!(format!("{RAW}/main/{DIR}/{REPORT}"));
    assert!(check_published(&at_main, Some(COMMIT), Some(b"the report published")).is_err());
}

#[test]
fn a_report_without_the_deployed_commit_is_refused() {
    let report = b"r";
    let err = check_published(&with_report(unpinned(), OTHER, report), None, Some(report)).unwrap_err();
    assert!(err.contains("source.commit"), "{err}");
}

#[test]
fn an_audit_listed_is_refused() {
    let mut m = unpinned();
    m["security"]["audits"] = json!([{ "by": "anyone" }]);
    assert!(check_published(&m, None, None).unwrap_err().contains("audits"));
    let mut m = unpinned();
    m["security"].as_object_mut().unwrap().remove("audits");
    assert!(check_published(&m, None, None).is_err());
}
