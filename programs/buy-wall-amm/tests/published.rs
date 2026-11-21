//! What the metadata publishes about the deployed program (docs/spec/README.md, "Metadata, IDL
//! and conformance report"): `security.audits` is empty, `links.docs` is the program's README,
//! and once the metadata names a commit, the source and IDL links are at that commit, which is
//! the one `deployments/devnet.json` records for the program; once it names a conformance
//! report, the report is the one committed beside the program, with its SHA-256, and the
//! README is linked at the report's commit, the one that records the deploy.
//!
//! Before the first deploy the links point at `main` and name no commit; the devnet ticket
//! pins them (docs/toolchain.md, "Deploy to devnet").

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const REPO: &str = "https://github.com/imDev2023/testing-pipeline";
const RAW: &str = "https://raw.githubusercontent.com/imDev2023/testing-pipeline";
const DIR: &str = "programs/buy-wall-amm";
/// The program's name in `deployments/devnet.json`, its crate's name.
const PROGRAM: &str = "buy-wall-amm";
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

/// Checks the published facts of `metadata` against the commits `deployments/devnet.json`
/// records for the program (its current deploy first, then earlier ones; none before the
/// first deploy) and the committed conformance report (if any).
fn check_published(
    metadata: &Value,
    deployed: &[&str],
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
        Some(other) => {
            return Err(format!(
                "source.commit must be a full commit hash, not {other}"
            ))
        }
    };
    match (commit, deployed) {
        (Some(commit), []) => {
            return Err(format!(
                "source.commit is {commit}, but deployments/devnet.json records no deploy"
            ))
        }
        (Some(commit), deployed) if !deployed.contains(&commit) => {
            return Err(format!(
                "source.commit is {commit}, but deployments/devnet.json records {deployed:?}"
            ))
        }
        _ => {}
    }
    let at = commit.unwrap_or("main");
    let Some(conformance) = metadata.get("conformance") else {
        return check_links(metadata, at, at);
    };
    if commit.is_none() {
        return Err(
            "conformance is published only with the deployed commit in source.commit".into(),
        );
    }
    let url = conformance["report"].as_str().unwrap_or_default();
    let Some(report_commit) = url
        .strip_prefix(&format!("{RAW}/"))
        .and_then(|rest| rest.strip_suffix(&format!("/{DIR}/{REPORT}")))
        .filter(|c| is_commit(c))
    else {
        return Err(format!(
            "conformance.report must be {RAW}/<commit>/{DIR}/{REPORT}, not {url}"
        ));
    };
    check_links(metadata, at, report_commit)?;
    // While a redeploy's record is merged and the metadata still pins the earlier deploy (a
    // commit in the record's history), the committed report is already the new deploy's.
    if commit != deployed.first().copied() {
        // The earlier report is not committed any more, but its hash must still be one.
        let sha = conformance["sha256"].as_str().unwrap_or_default();
        if sha.len() != 64 || !sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(format!(
                "conformance.sha256 must be a SHA-256 in lowercase hex, not {}",
                conformance["sha256"]
            ));
        }
        return Ok(());
    }
    let Some(report) = report else {
        return Err(format!(
            "conformance names a report, but {DIR}/{REPORT} is not committed"
        ));
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

/// The source and IDL links at `code` (the deployed commit, or `main` before the deploy), and
/// the README at `docs` (the commit that records the deploy, once there is one).
fn check_links(metadata: &Value, code: &str, docs: &str) -> Result<(), String> {
    let expected = [
        ("source", format!("{REPO}/tree/{code}/{DIR}")),
        ("idl", format!("{RAW}/{code}/{DIR}/idl/buy_wall_amm.json")),
        ("docs", format!("{REPO}/blob/{docs}/{DIR}/README.md")),
    ];
    for (key, want) in expected {
        if metadata["links"][key] != want.as_str() {
            return Err(format!(
                "links.{key} must be {want}, not {}",
                metadata["links"][key]
            ));
        }
    }
    Ok(())
}

/// The commits `deployments/devnet.json` records for the program: its current deploy, then
/// its earlier ones (`history`), newest first; none before the first deploy.
fn deployed_commits() -> Vec<String> {
    let path = manifest_dir().join("../../deployments/devnet.json");
    if !path.exists() {
        return Vec::new();
    }
    let entry = &read_json(&path)["programs"][PROGRAM];
    std::iter::once(entry)
        .chain(entry["history"].as_array().into_iter().flatten())
        .filter_map(|deploy| deploy["commit"].as_str().map(str::to_owned))
        .collect()
}

/// Checks that a `pipeline-check` report is of the deployed code (its program and executable
/// hash are the deploy record's, as Pipeline's own staleness check compares them) and that it
/// passed with no warning and no failure (the bar's "Test layers" 7).
fn check_report(report: &Value, deployed: &Value) -> Result<(), String> {
    let field = |value: &Value, key: &str, what: &str| match value[key].as_str() {
        Some(text) if !text.is_empty() => Ok(text.to_owned()),
        _ => Err(format!("{what} names no {key}")),
    };
    if report["source"]["cluster"] != "devnet" {
        return Err(format!(
            "the report was taken on {}, not devnet",
            report["source"]["cluster"]
        ));
    }
    let program = field(&report["strategy"], "program_id", "the report")?;
    let hash = field(&report["strategy"], "executable_sha256", "the report")?;
    let deployed_program = field(deployed, "programId", "the deploy record")?;
    let deployed_hash = field(deployed, "executableHash", "the deploy record")?;
    if program != deployed_program {
        return Err(format!(
            "the report checks program {program}, not the deployed {deployed_program}"
        ));
    }
    if hash != deployed_hash {
        return Err(format!(
            "the report checks executable {hash}, not the deployed {deployed_hash}"
        ));
    }
    for outcome in ["warn", "fail"] {
        match report["summary"][outcome].as_u64() {
            None => return Err(format!("the report has no {outcome} count")),
            Some(0) => {}
            Some(count) => return Err(format!("the report has {count} {outcome} results")),
        }
    }
    if report["summary"]["pass"].as_u64().unwrap_or(0) == 0 {
        return Err("no check passed in the report".into());
    }
    Ok(())
}

/// The program's current entry in `deployments/devnet.json`, if it records one.
fn deployed_entry() -> Option<Value> {
    let path = manifest_dir().join("../../deployments/devnet.json");
    path.exists()
        .then(|| read_json(&path)["programs"][PROGRAM].clone())
        .filter(|entry| !entry.is_null())
}

#[test]
fn the_committed_report_is_of_the_deployed_code_and_passes() {
    let Ok(report) = std::fs::read(manifest_dir().join(REPORT)) else {
        return; // before the first deploy's record there is no report
    };
    let report: Value = serde_json::from_slice(&report).unwrap();
    let deployed = deployed_entry().expect("a committed report needs the deploy it describes");
    check_report(&report, &deployed).unwrap();
}

#[test]
fn a_report_of_other_code_or_with_a_warning_is_refused() {
    let deployed = json!({ "programId": "Prog", "executableHash": "aa" });
    let report = |program: &str, hash: &str, warn: u64, fail: u64| {
        json!({
            "source": { "cluster": "devnet" },
            "strategy": { "program_id": program, "executable_sha256": hash },
            "summary": { "pass": 13, "warn": warn, "fail": fail, "skip": 1 },
        })
    };
    check_report(&report("Prog", "aa", 0, 0), &deployed).unwrap();
    let err = check_report(&report("Other", "aa", 0, 0), &deployed).unwrap_err();
    assert!(err.contains("program"), "{err}");
    let err = check_report(&report("Prog", "bb", 0, 0), &deployed).unwrap_err();
    assert!(err.contains("executable"), "{err}");
    let err = check_report(&report("Prog", "aa", 1, 0), &deployed).unwrap_err();
    assert!(err.contains("warn"), "{err}");
    let err = check_report(&report("Prog", "aa", 0, 1), &deployed).unwrap_err();
    assert!(err.contains("fail"), "{err}");
    // A report taken on a local validator of the same bytes is not the devnet market's.
    let mut local = report("Prog", "aa", 0, 0);
    local["source"]["cluster"] = json!(null);
    let err = check_report(&local, &deployed).unwrap_err();
    assert!(err.contains("devnet"), "{err}");
    // Missing fields are refused as missing, never matched as empty.
    let err = check_report(&json!({ "source": { "cluster": "devnet" } }), &json!({})).unwrap_err();
    assert!(err.contains("names no"), "{err}");
    // A report in which no check passed (every one skipped) is not a pass.
    let none_passed = json!({
        "source": { "cluster": "devnet" },
        "strategy": { "program_id": "Prog", "executable_sha256": "aa" },
        "summary": { "pass": 0, "warn": 0, "fail": 0, "skip": 14 },
    });
    let err = check_report(&none_passed, &deployed).unwrap_err();
    assert!(err.contains("no check passed"), "{err}");
    let mut no_summary = report("Prog", "aa", 0, 0);
    no_summary.as_object_mut().unwrap().remove("summary");
    let err = check_report(&no_summary, &deployed).unwrap_err();
    assert!(err.contains("no warn count"), "{err}");
}

#[test]
fn the_committed_metadata_publishes_what_was_deployed() {
    let metadata = read_json(&manifest_dir().join("metadata.json"));
    let report = std::fs::read(manifest_dir().join(REPORT)).ok();
    let deployed = deployed_commits();
    let deployed: Vec<&str> = deployed.iter().map(String::as_str).collect();
    check_published(&metadata, &deployed, report.as_deref()).unwrap();
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
            "idl": format!("{RAW}/main/{DIR}/idl/buy_wall_amm.json"),
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
    m["links"]["idl"] = json!(format!("{RAW}/{at}/{DIR}/idl/buy_wall_amm.json"));
    m["links"]["docs"] = json!(format!("{REPO}/blob/{at}/{DIR}/README.md"));
    m["source"]["commit"] = json!(at);
    m
}

fn with_report(mut m: Value, report_commit: &str, report: &[u8]) -> Value {
    m["links"]["docs"] = json!(format!("{REPO}/blob/{report_commit}/{DIR}/README.md"));
    m["conformance"] = json!({
        "report": format!("{RAW}/{report_commit}/{DIR}/{REPORT}"),
        "sha256": sha256_hex(report),
    });
    m
}

#[test]
fn before_the_deploy_the_links_point_at_main() {
    check_published(&unpinned(), &[], None).unwrap();
    // A deploy recorded before the metadata is pinned: the pinning PR follows it.
    check_published(&unpinned(), &[COMMIT], None).unwrap();
}

#[test]
fn pinned_links_are_at_the_deployed_commit() {
    check_published(&pinned(COMMIT), &[COMMIT], None).unwrap();
    let report = br#"{"checks":[]}"#;
    check_published(
        &with_report(pinned(COMMIT), OTHER, report),
        &[COMMIT],
        Some(report),
    )
    .unwrap();
}

#[test]
fn a_redeploy_recorded_before_the_metadata_is_pinned_again_passes() {
    // The record of a new deploy merges first; the metadata still names the earlier deploy,
    // now in the record's history, until the next PR pins it (docs/toolchain.md).
    check_published(&pinned(COMMIT), &[OTHER, COMMIT], None).unwrap();
    let err = check_published(&pinned(COMMIT), &[OTHER], None).unwrap_err();
    assert!(err.contains("records"), "{err}");
}

#[test]
fn a_redeploys_record_merges_while_the_metadata_still_names_the_earlier_report() {
    // The record PR of a redeploy commits the new report while metadata.json still pins the
    // earlier deploy and its report; the hash check waits for the metadata to be pinned again.
    let earlier_report = b"the earlier deploy's report";
    let m = with_report(pinned(COMMIT), OTHER, earlier_report);
    check_published(&m, &[OTHER, COMMIT], Some(b"the new deploy's report")).unwrap();
    // Pinned to the current deploy, the report must be the committed one.
    let err = check_published(&m, &[COMMIT], Some(b"the new deploy's report")).unwrap_err();
    assert!(err.contains("hashes to"), "{err}");
    // Even then the earlier report's hash must be a SHA-256, never a typo the check skips.
    let mut typo = m.clone();
    typo["conformance"]["sha256"] = json!("3f3a7784");
    let err =
        check_published(&typo, &[OTHER, COMMIT], Some(b"the new deploy's report")).unwrap_err();
    assert!(err.contains("SHA-256"), "{err}");
}

#[test]
fn a_commit_that_is_not_the_deployed_one_is_refused() {
    let err = check_published(&pinned(COMMIT), &[OTHER], None).unwrap_err();
    assert!(err.contains("records"), "{err}");
    let err = check_published(&pinned(COMMIT), &[], None).unwrap_err();
    assert!(err.contains("no deploy"), "{err}");
    let mut short = pinned(COMMIT);
    short["source"]["commit"] = json!("0123456");
    assert!(check_published(&short, &["0123456"], None).is_err());
}

#[test]
fn a_link_left_at_another_commit_or_at_main_is_refused() {
    let mut m = pinned(COMMIT);
    m["links"]["idl"] = json!(format!("{RAW}/{OTHER}/{DIR}/idl/buy_wall_amm.json"));
    assert!(check_published(&m, &[COMMIT], None)
        .unwrap_err()
        .contains("links.idl"));
    let mut m = pinned(COMMIT);
    m["links"]["docs"] = json!(format!("{REPO}/blob/main/{DIR}/README.md"));
    assert!(check_published(&m, &[COMMIT], None)
        .unwrap_err()
        .contains("links.docs"));
    // With a report, the README is the one at the report's commit, which records the deploy.
    let report = b"r";
    let mut m = with_report(pinned(COMMIT), OTHER, report);
    m["links"]["docs"] = json!(format!("{REPO}/blob/{COMMIT}/{DIR}/README.md"));
    let err = check_published(&m, &[COMMIT], Some(report)).unwrap_err();
    assert!(err.contains("links.docs"), "{err}");
}

#[test]
fn a_report_that_does_not_match_its_hash_is_refused() {
    let m = with_report(pinned(COMMIT), OTHER, b"the report published");
    let err = check_published(&m, &[COMMIT], Some(b"another report")).unwrap_err();
    assert!(err.contains("hashes to"), "{err}");
    let err = check_published(&m, &[COMMIT], None).unwrap_err();
    assert!(err.contains("not committed"), "{err}");
    let mut at_main = m.clone();
    at_main["conformance"]["report"] = json!(format!("{RAW}/main/{DIR}/{REPORT}"));
    assert!(check_published(&at_main, &[COMMIT], Some(b"the report published")).is_err());
}

#[test]
fn a_report_without_the_deployed_commit_is_refused() {
    let report = b"r";
    let err =
        check_published(&with_report(unpinned(), OTHER, report), &[], Some(report)).unwrap_err();
    assert!(err.contains("source.commit"), "{err}");
}

#[test]
fn an_audit_listed_is_refused() {
    let mut m = unpinned();
    m["security"]["audits"] = json!([{ "by": "anyone" }]);
    assert!(check_published(&m, &[], None)
        .unwrap_err()
        .contains("audits"));
    let mut m = unpinned();
    m["security"].as_object_mut().unwrap().remove("audits");
    assert!(check_published(&m, &[], None).is_err());
}
