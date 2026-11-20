//! The `buy-wall-gate` command (docs/spec/pool4-for-solana.md, "A release gate", "How to run
//! it"). Run from `programs/` with `cargo run -p buy-wall-gate --`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::record::{self, Record, SharedFailure, Target};
use crate::release::Release;
use crate::snapshot::{parse_key, Snapshot};
use crate::source::{cluster_url, redacted, Rpc};
use crate::{check, download, programs, stranding, synthetic};
use pipeline_check::AccountSource;
use pipeline_client::{pda, Pubkey};

const USAGE: &str = "\
buy-wall-gate: the buy wall AMM's release gate (docs/spec/pool4-for-solana.md, \"A release gate\")

  run --cluster <devnet|localnet|URL> --candidate <program.so>
      [--release <release.json>] [--records <dir>] [--snapshot-out <file>] [--program <id>]
        Downloads every market of the program from the cluster and replays it with the
        candidate and the cluster's router, then makes and trades a market of its own in
        a world of its own (POOL4-53). Exits 0 and records the pass if every step passes on
        every market, or fails only as it does under the deployed build, and every step on
        its own market passes, else exits 1 naming each market and step that failed.

  verify-record --cluster <...> --candidate <program.so> [--records <dir>] [--program <id>]
        Exits 0 only if a passing run covers deploying the candidate to the cluster now:
        same build, against the build deployed now, covering every market there now.

  check --snapshot <file> --candidate <program.so> [--router <pipeline.so>] [--release <...>]
        The same checks on a saved snapshot or fixture, its own market included, recording
        nothing.

  snapshot --cluster <...> --out <file> [--program <id>]
        Saves the cluster's markets as a fixture (no programs, the deployed build's quotes).

  synthesize --out <file> [--build <program.so>] [--router <pipeline.so>]
        Writes the synthetic layout fixture from a LiteSVM run (POOL4-20).

  rerecord --fixture <file> --build <program.so> [--router <pipeline.so>]
        Re-records a fixture's baseline (the quotes and each step's outcome) with a build,
        after a pricing change deploys.

  test-builds [--out <dir>]
        Builds the stranding test builds (programs/target/gate-test-builds).

  hash <program.so>
        The executable's SHA-256, as solana-verify computes it.
";

/// Runs the command with the process's arguments.
pub fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(error) => {
            eprintln!("buy-wall-gate: {error}");
            ExitCode::from(2)
        }
    }
}

struct Options(HashMap<String, String>);

impl Options {
    fn parse(args: &[String], allowed: &[&str]) -> Result<Self, String> {
        let mut map = HashMap::new();
        let mut iter = args.iter();
        while let Some(flag) = iter.next() {
            let name = flag
                .strip_prefix("--")
                .filter(|name| allowed.contains(name))
                .ok_or_else(|| format!("unexpected argument {flag:?}\n\n{USAGE}"))?;
            let value = iter.next().ok_or_else(|| format!("{flag} needs a value"))?;
            map.insert(name.to_string(), value.clone());
        }
        Ok(Options(map))
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }

    fn required(&self, name: &str) -> Result<&str, String> {
        self.get(name)
            .ok_or_else(|| format!("--{name} is required\n\n{USAGE}"))
    }

    fn path_or(&self, name: &str, default: PathBuf) -> PathBuf {
        self.get(name).map(PathBuf::from).unwrap_or(default)
    }

    fn program(&self) -> Result<Pubkey, String> {
        self.get("program")
            .map_or(Ok(programs::program_id()), parse_key)
    }
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

fn records_dir() -> PathBuf {
    programs::repo_root().join("deployments/release-gate/buy-wall-amm")
}

fn run(args: &[String]) -> Result<bool, String> {
    let (command, rest) = args.split_first().ok_or(USAGE)?;
    match command.as_str() {
        "run" => gate_run(&Options::parse(
            rest,
            &[
                "cluster",
                "candidate",
                "release",
                "records",
                "snapshot-out",
                "program",
            ],
        )?),
        "verify-record" => verify_record(&Options::parse(
            rest,
            &["cluster", "candidate", "records", "program"],
        )?),
        "check" => {
            let options = Options::parse(rest, &["snapshot", "candidate", "router", "release"])?;
            let snapshot = Snapshot::read(Path::new(options.required("snapshot")?))?;
            let candidate = read(Path::new(options.required("candidate")?))?;
            let release = Release::read(&options.path_or("release", programs::release_path()))?;
            let router = match options.get("router") {
                Some(path) => Some(read(Path::new(path))?),
                None if snapshot
                    .program_elf(&pipeline_client::PROGRAM_ID)?
                    .is_none() =>
                {
                    Some(programs::pinned_router())
                }
                None => None,
            };
            let report = check::run(&snapshot, &candidate, router.as_deref(), &release);
            print!("{report}");
            Ok(report.passed())
        }
        "snapshot" => {
            let options = Options::parse(rest, &["cluster", "out", "program"])?;
            let url = cluster_url(options.required("cluster")?)?;
            let program = options.program()?;
            let mut rpc = Rpc::new(&url);
            let markets = download::find_markets(&mut rpc, &program)?;
            let snapshot =
                download::snapshot(&mut rpc, &program, &markets, Some(url.clone()), false, "")?;
            let versions: Vec<String> = snapshot
                .markets
                .iter()
                .map(|m| m.layout_version.to_string())
                .collect();
            let snapshot = Snapshot {
                note: format!(
                    "Layout version(s) {}: {} market(s) saved from {} at slot {}.",
                    versions.join(", "),
                    snapshot.markets.len(),
                    snapshot.cluster.name.as_deref().unwrap_or(&redacted(&url)),
                    snapshot.cluster.slot
                ),
                ..snapshot
            }
            .without_programs()?;
            snapshot.write(Path::new(options.required("out")?))?;
            println!(
                "saved {} market(s) to {}",
                snapshot.markets.len(),
                options.required("out")?
            );
            Ok(true)
        }
        "synthesize" => {
            let options = Options::parse(rest, &["out", "build", "router"])?;
            let build = read(&options.path_or("build", programs::current_build_path()))?;
            let router = match options.get("router") {
                Some(path) => read(Path::new(path))?,
                None => programs::pinned_router(),
            };
            let snapshot = synthetic::build(&build, &router)?;
            snapshot.write(Path::new(options.required("out")?))?;
            println!(
                "wrote {} synthetic market(s) to {}",
                snapshot.markets.len(),
                options.required("out")?
            );
            Ok(true)
        }
        "rerecord" => {
            let options = Options::parse(rest, &["fixture", "build", "router"])?;
            let path = PathBuf::from(options.required("fixture")?);
            let mut snapshot = Snapshot::read_any(&path)?;
            let build = read(Path::new(options.required("build")?))?;
            let router = match options.get("router") {
                Some(path) => read(Path::new(path))?,
                None => programs::pinned_router(),
            };
            snapshot.baseline = check::record_baseline(&snapshot, &build, Some(&router))?;
            snapshot.format = crate::snapshot::FORMAT.into();
            snapshot.write(&path)?;
            println!(
                "re-recorded {} quote(s) and {} step outcome(s) in {}",
                snapshot.baseline.quotes.len(),
                snapshot.baseline.steps.len(),
                path.display()
            );
            Ok(true)
        }
        "test-builds" => {
            let options = Options::parse(rest, &["out"])?;
            let out = options.path_or("out", programs::test_builds_dir());
            stranding::build_all(&programs::crate_dir().join("../.."), &out)?;
            for build in stranding::TestBuild::ALL {
                println!("{}", stranding::path(&out, build).display());
            }
            Ok(true)
        }
        "hash" => {
            let [path] = rest else {
                return Err(USAGE.into());
            };
            println!(
                "{}",
                pipeline_check::executable_sha256(&read(Path::new(path))?).0
            );
            Ok(true)
        }
        "help" | "--help" | "-h" => {
            print!("{USAGE}");
            Ok(true)
        }
        other => Err(format!("unknown command {other:?}\n\n{USAGE}")),
    }
}

fn gate_run(options: &Options) -> Result<bool, String> {
    let url = cluster_url(options.required("cluster")?)?;
    let candidate = read(Path::new(options.required("candidate")?))?;
    let release_path = options.path_or("release", programs::release_path());
    let release = Release::read(&release_path)?;
    let program = options.program()?;
    let mut rpc = Rpc::new(&url);
    let markets = match download::find_markets(&mut rpc, &program) {
        Ok(markets) => markets,
        Err(error) => {
            println!("REFUSED: {error}");
            return Ok(false);
        }
    };
    let shown = redacted(&url);
    println!("{} market state(s) of {program} on {shown}", markets.len());
    let snapshot = download::snapshot(
        &mut rpc,
        &program,
        &markets,
        Some(url.clone()),
        false,
        "A cluster run of the release gate.",
    )?;
    if let Some(path) = options.get("snapshot-out") {
        snapshot.write(Path::new(path))?;
        println!("snapshot saved to {path}");
    }
    let report = check::run(&snapshot, &candidate, None, &release);
    print!("{report}");
    if !report.passed() {
        return Ok(false);
    }
    // A pricing change unlocks a deploy only as committed with the release (POOL4-42).
    if report.relied_on_pricing_change {
        if let Err(why) = committed_unchanged(&release_path) {
            println!("REFUSED to record the pass: it relied on a pricing change that {why}");
            return Ok(false);
        }
    }
    let record = Record {
        program: program.to_string(),
        genesis_hash: snapshot
            .cluster
            .genesis_hash
            .clone()
            .ok_or("the cluster gave no genesis hash")?,
        cluster: snapshot.cluster.name.clone(),
        url: shown,
        slot: snapshot.cluster.slot,
        unix_timestamp: snapshot.cluster.unix_timestamp,
        recorded_at: now(),
        candidate_sha256: report.candidate_sha256.clone(),
        deployed_sha256: report.baseline_sha256.clone(),
        market_states: snapshot
            .markets
            .iter()
            .map(|m| m.market_state.clone())
            .collect(),
        pricing_change_declared: report.relied_on_pricing_change,
        shared_failures: report
            .shared_failures()
            .into_iter()
            .map(|failure| SharedFailure {
                market_state: failure.market_state,
                step: failure.step,
                detail: failure.detail,
            })
            .collect(),
        own_market: report.own_market.is_some(),
    };
    let path = record::append(&options.path_or("records", records_dir()), &record)?;
    println!("recorded the pass in {}", path.display());
    Ok(true)
}

fn verify_record(options: &Options) -> Result<bool, String> {
    let url = cluster_url(options.required("cluster")?)?;
    let candidate = read(Path::new(options.required("candidate")?))?;
    let program = options.program()?;
    let mut rpc = Rpc::new(&url);
    let genesis_hash = rpc.genesis_hash()?;
    let deployed = rpc
        .get_accounts(&[pda::program_data(&program)])?
        .pop()
        .flatten()
        .and_then(|account| {
            account
                .data
                .get(crate::snapshot::PROGRAMDATA_HEADER_LEN..)
                .map(<[u8]>::to_vec)
        })
        .map(|elf| pipeline_check::executable_sha256(&elf).0);
    let market_states = download::find_markets(&mut rpc, &program)?
        .iter()
        .map(Pubkey::to_string)
        .collect();
    let target = Target {
        program: program.to_string(),
        genesis_hash,
        candidate_sha256: pipeline_check::executable_sha256(&candidate).0,
        deployed_sha256: deployed,
        market_states,
    };
    let found =
        record::find(&options.path_or("records", records_dir()), &target).and_then(|record| {
            // A pass that relied on a pricing change counts only while the committed release still
            // declares it from the build deployed now.
            if record.pricing_change_declared
                && !committed_release()?.changes_pricing_of(target.deployed_sha256.as_deref())
            {
                return Err(format!(
                    "the pass relied on a pricing change from build {}, which the committed {} no \
                 longer declares",
                    target.deployed_sha256.as_deref().unwrap_or("(none)"),
                    RELEASE_IN_REPO
                ));
            }
            Ok(record)
        });
    match found {
        Ok(record) => {
            println!(
                "build {} passed the release gate on this cluster at slot {} against deployed build {}, \
                 covering all {} market(s) and a market of its own",
                record.candidate_sha256,
                record.slot,
                record.deployed_sha256.as_deref().unwrap_or("(none)"),
                target.market_states.len()
            );
            Ok(true)
        }
        Err(reason) => {
            println!("REFUSED: {reason}");
            Ok(false)
        }
    }
}

/// The release declaration's path in the repo.
const RELEASE_IN_REPO: &str = "programs/buy-wall-amm/release.json";

/// Why `path` is not the release declaration as committed, if it is not: another file, or
/// the repo's with changes git has not committed.
fn committed_unchanged(path: &Path) -> Result<(), String> {
    let repo = programs::repo_root().join(RELEASE_IN_REPO);
    let same = |a: &Path, b: &Path| a.canonicalize().ok() == b.canonicalize().ok();
    if !same(path, &repo) {
        return Err(format!(
            "is declared in {}, not in {RELEASE_IN_REPO}",
            path.display()
        ));
    }
    let status = git(&["status", "--porcelain", "--", RELEASE_IN_REPO])?;
    if !status.trim().is_empty() {
        return Err(format!(
            "is not committed: {RELEASE_IN_REPO} has changes git has not committed"
        ));
    }
    Ok(())
}

/// The release declaration as committed at `HEAD`.
fn committed_release() -> Result<Release, String> {
    let text = git(&["show", &format!("HEAD:{RELEASE_IN_REPO}")])?;
    serde_json::from_str(&text).map_err(|e| format!("the committed {RELEASE_IN_REPO}: {e}"))
}

fn git(args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(programs::repo_root())
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_repos_committed_declaration_can_unlock_a_deploy() {
        let elsewhere = std::env::temp_dir().join("release.json");
        let error = committed_unchanged(&elsewhere).unwrap_err();
        assert!(
            error.contains("not in programs/buy-wall-amm/release.json"),
            "{error}"
        );
        // The repo's own, as committed, declares no pricing change.
        assert_eq!(committed_release().unwrap(), Release::default());
    }
}
