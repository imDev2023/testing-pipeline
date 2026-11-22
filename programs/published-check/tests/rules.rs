//! The rules of `published-check`, on a made-up program: what the metadata may publish
//! before and after a deploy, and which conformance reports count.

use published_check::{check_published, check_report, sha256_hex, Program, RAW, REPO, REPORT};
use serde_json::{json, Value};

const DIR: &str = "programs/x-amm";
const P: Program = Program {
    dir: DIR,
    name: "x-amm",
    idl: "x_amm.json",
};

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
    // A report whose every check was skipped passed nothing.
    let mut skipped = report("Prog", "aa", 0, 0);
    skipped["summary"] = json!({ "pass": 0, "warn": 0, "fail": 0, "skip": 14 });
    let err = check_report(&skipped, &deployed).unwrap_err();
    assert!(err.contains("no check passed"), "{err}");
    let mut no_summary = report("Prog", "aa", 0, 0);
    no_summary.as_object_mut().unwrap().remove("summary");
    let err = check_report(&no_summary, &deployed).unwrap_err();
    assert!(err.contains("no warn count"), "{err}");
    let mut no_pass = report("Prog", "aa", 0, 0);
    no_pass["summary"]["pass"] = json!("13");
    let err = check_report(&no_pass, &deployed).unwrap_err();
    assert!(err.contains("no pass count"), "{err}");
}

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const OTHER: &str = "89abcdef0123456789abcdef0123456789abcdef";

fn unpinned() -> Value {
    json!({
        "links": {
            "source": format!("{REPO}/tree/main/{DIR}"),
            "idl": format!("{RAW}/main/{DIR}/idl/x_amm.json"),
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
    m["links"]["idl"] = json!(format!("{RAW}/{at}/{DIR}/idl/x_amm.json"));
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
    check_published(&P, &unpinned(), &[], None).unwrap();
    // A deploy recorded before the metadata is pinned: the pinning PR follows it.
    check_published(&P, &unpinned(), &[COMMIT], None).unwrap();
}

#[test]
fn pinned_links_are_at_the_deployed_commit() {
    check_published(&P, &pinned(COMMIT), &[COMMIT], None).unwrap();
    let report = br#"{"checks":[]}"#;
    check_published(
        &P,
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
    check_published(&P, &pinned(COMMIT), &[OTHER, COMMIT], None).unwrap();
    let err = check_published(&P, &pinned(COMMIT), &[OTHER], None).unwrap_err();
    assert!(err.contains("records"), "{err}");
}

#[test]
fn a_redeploys_record_merges_while_the_metadata_still_names_the_earlier_report() {
    // The record PR of a redeploy commits the new report while metadata.json still pins the
    // earlier deploy and its report; the hash check waits for the metadata to be pinned again.
    let earlier_report = b"the earlier deploy's report";
    let m = with_report(pinned(COMMIT), OTHER, earlier_report);
    check_published(&P, &m, &[OTHER, COMMIT], Some(b"the new deploy's report")).unwrap();
    // Pinned to the current deploy, the report must be the committed one.
    let err = check_published(&P, &m, &[COMMIT], Some(b"the new deploy's report")).unwrap_err();
    assert!(err.contains("hashes to"), "{err}");
    // Even before the new pin, the earlier report's hash must be a SHA-256.
    let mut typo = m.clone();
    typo["conformance"]["sha256"] = json!("not a hash");
    let err = check_published(
        &P,
        &typo,
        &[OTHER, COMMIT],
        Some(b"the new deploy's report"),
    )
    .unwrap_err();
    assert!(err.contains("lowercase hex"), "{err}");
}

#[test]
fn a_commit_that_is_not_the_deployed_one_is_refused() {
    let err = check_published(&P, &pinned(COMMIT), &[OTHER], None).unwrap_err();
    assert!(err.contains("records"), "{err}");
    let err = check_published(&P, &pinned(COMMIT), &[], None).unwrap_err();
    assert!(err.contains("no deploy"), "{err}");
    let mut short = pinned(COMMIT);
    short["source"]["commit"] = json!("0123456");
    assert!(check_published(&P, &short, &["0123456"], None).is_err());
}

#[test]
fn a_link_left_at_another_commit_or_at_main_is_refused() {
    let mut m = pinned(COMMIT);
    m["links"]["idl"] = json!(format!("{RAW}/{OTHER}/{DIR}/idl/x_amm.json"));
    assert!(check_published(&P, &m, &[COMMIT], None)
        .unwrap_err()
        .contains("links.idl"));
    let mut m = pinned(COMMIT);
    m["links"]["docs"] = json!(format!("{REPO}/blob/main/{DIR}/README.md"));
    assert!(check_published(&P, &m, &[COMMIT], None)
        .unwrap_err()
        .contains("links.docs"));
    // With a report, the README is the one at the report's commit, which records the deploy.
    let report = b"r";
    let mut m = with_report(pinned(COMMIT), OTHER, report);
    m["links"]["docs"] = json!(format!("{REPO}/blob/{COMMIT}/{DIR}/README.md"));
    let err = check_published(&P, &m, &[COMMIT], Some(report)).unwrap_err();
    assert!(err.contains("links.docs"), "{err}");
}

#[test]
fn a_report_that_does_not_match_its_hash_is_refused() {
    let m = with_report(pinned(COMMIT), OTHER, b"the report published");
    let err = check_published(&P, &m, &[COMMIT], Some(b"another report")).unwrap_err();
    assert!(err.contains("hashes to"), "{err}");
    let err = check_published(&P, &m, &[COMMIT], None).unwrap_err();
    assert!(err.contains("not committed"), "{err}");
    let mut at_main = m.clone();
    at_main["conformance"]["report"] = json!(format!("{RAW}/main/{DIR}/{REPORT}"));
    assert!(check_published(&P, &at_main, &[COMMIT], Some(b"the report published")).is_err());
}

#[test]
fn a_report_without_the_deployed_commit_is_refused() {
    let report = b"r";
    let err = check_published(
        &P,
        &with_report(unpinned(), OTHER, report),
        &[],
        Some(report),
    )
    .unwrap_err();
    assert!(err.contains("source.commit"), "{err}");
}

#[test]
fn an_audit_listed_is_refused() {
    let mut m = unpinned();
    m["security"]["audits"] = json!([{ "by": "anyone" }]);
    assert!(check_published(&P, &m, &[], None)
        .unwrap_err()
        .contains("audits"));
    let mut m = unpinned();
    m["security"].as_object_mut().unwrap().remove("audits");
    assert!(check_published(&P, &m, &[], None).is_err());
}
