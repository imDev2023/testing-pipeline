//! What a strategy's metadata publishes about its deployed program (docs/spec/README.md,
//! "Metadata, IDL and conformance report"), checked the same way for every program of ours:
//! `security.audits` is empty, `links.docs` is the program's README, and once the metadata
//! names a commit, the source and IDL links are at that commit, which is the one
//! `deployments/devnet.json` records for the program; once it names a conformance report, the
//! report is the one committed beside the program, with its SHA-256, and the README is linked
//! at the report's commit, the one that records the deploy.
//!
//! Before the first deploy the links point at `main` and name no commit; the devnet ticket
//! pins them (docs/toolchain.md, "Deploy to devnet").
//!
//! Each program's `tests/published.rs` runs [`check_committed`] on its own files; the rules
//! themselves are tested once, in this crate's tests. The TypeScript side of the same steps,
//! pinning and verifying what is published, is `packages/strategy-publish`.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const REPO: &str = "https://github.com/imDev2023/testing-pipeline";
pub const RAW: &str = "https://raw.githubusercontent.com/imDev2023/testing-pipeline";
/// The devnet demo market's `pipeline-check` report, beside each program.
pub const REPORT: &str = "conformance/devnet.json";

/// One of our programs, as its metadata and `deployments/devnet.json` name it.
#[derive(Clone, Copy, Debug)]
pub struct Program {
    /// Its folder from the repository's root, `programs/tax-amm`.
    pub dir: &'static str,
    /// Its name in `deployments/devnet.json`, its crate's name, `tax-amm`.
    pub name: &'static str,
    /// Its IDL's file name in `idl/`, `tax_amm.json`.
    pub idl: &'static str,
}

impl Program {
    /// The program's folder on disk.
    pub fn path(&self) -> PathBuf {
        repo_root().join(self.dir)
    }
}

/// The repository's root, from this crate's folder, `programs/published-check`.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub fn is_commit(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Checks the published facts of `metadata` against the commits `deployments/devnet.json`
/// records for the program (its current deploy first, then earlier ones; none before the
/// first deploy) and the committed conformance report (if any).
pub fn check_published(
    program: &Program,
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
        return check_links(program, metadata, at, at);
    };
    if commit.is_none() {
        return Err(
            "conformance is published only with the deployed commit in source.commit".into(),
        );
    }
    let dir = program.dir;
    let url = conformance["report"].as_str().unwrap_or_default();
    let Some(report_commit) = url
        .strip_prefix(&format!("{RAW}/"))
        .and_then(|rest| rest.strip_suffix(&format!("/{dir}/{REPORT}")))
        .filter(|c| is_commit(c))
    else {
        return Err(format!(
            "conformance.report must be {RAW}/<commit>/{dir}/{REPORT}, not {url}"
        ));
    };
    check_links(program, metadata, at, report_commit)?;
    // While a redeploy's record is merged and the metadata still pins the earlier deploy (a
    // commit in the record's history), the committed report is already the new deploy's.
    if commit != deployed.first().copied() {
        // The earlier report is not committed any more, but its hash must still be a SHA-256,
        // never a typo the check skips.
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
            "conformance names a report, but {dir}/{REPORT} is not committed"
        ));
    };
    let sha = sha256_hex(report);
    if conformance["sha256"] != sha.as_str() {
        return Err(format!(
            "conformance.sha256 is {}, but {dir}/{REPORT} hashes to {sha}",
            conformance["sha256"]
        ));
    }
    Ok(())
}

/// The links `metadata.json` must carry: the source and the IDL at `code` (the deployed
/// commit, or `main` before the deploy), the README at `docs` (the commit that records the
/// deploy, once there is one).
pub fn links(program: &Program, code: &str, docs: &str) -> [(&'static str, String); 3] {
    let dir = program.dir;
    [
        ("source", format!("{REPO}/tree/{code}/{dir}")),
        ("idl", format!("{RAW}/{code}/{dir}/idl/{}", program.idl)),
        ("docs", format!("{REPO}/blob/{docs}/{dir}/README.md")),
    ]
}

fn check_links(program: &Program, metadata: &Value, code: &str, docs: &str) -> Result<(), String> {
    for (key, want) in links(program, code, docs) {
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
pub fn deployed_commits(program: &Program) -> Vec<String> {
    let Some(entry) = deployed_entry(program) else {
        return Vec::new();
    };
    std::iter::once(&entry)
        .chain(entry["history"].as_array().into_iter().flatten())
        .filter_map(|deploy| deploy["commit"].as_str().map(str::to_owned))
        .collect()
}

/// The program's current entry in `deployments/devnet.json`, if it records one.
pub fn deployed_entry(program: &Program) -> Option<Value> {
    let path = repo_root().join("deployments/devnet.json");
    path.exists()
        .then(|| read_json(&path)["programs"][program.name].clone())
        .filter(|entry| !entry.is_null())
}

/// Checks that a `pipeline-check` report is of the deployed code (its program and executable
/// hash are the deploy record's, as Pipeline's own staleness check compares them) and that it
/// passed with no warning and no failure (the bar's "Test layers" 7).
pub fn check_report(report: &Value, deployed: &Value) -> Result<(), String> {
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
    match report["summary"]["pass"].as_u64() {
        None => Err("the report has no pass count".into()),
        Some(0) => Err("no check passed in the report".into()),
        Some(_) => Ok(()),
    }
}

/// What each program's `tests/published.rs` checks on its own committed files: the README
/// the metadata links exists, the committed report (once there is one) is of the deployed code
/// and passes, and the committed metadata publishes what was deployed.
pub fn check_committed(program: &Program) -> Result<(), String> {
    let dir = program.path();
    if !dir.join("README.md").is_file() {
        return Err(format!(
            "{}/README.md, which links.docs names, is missing",
            program.dir
        ));
    }
    let report = std::fs::read(dir.join(REPORT)).ok();
    if let Some(report) = &report {
        let report: Value = serde_json::from_slice(report)
            .map_err(|e| format!("{}/{REPORT} is not JSON: {e}", program.dir))?;
        let deployed = deployed_entry(program)
            .ok_or("a committed report needs the deploy it describes in deployments/devnet.json")?;
        check_report(&report, &deployed)?;
    }
    let metadata = read_json(&dir.join("metadata.json"));
    let deployed = deployed_commits(program);
    let deployed: Vec<&str> = deployed.iter().map(String::as_str).collect();
    check_published(program, &metadata, &deployed, report.as_deref())
}
