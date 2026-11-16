//! The `buy-wall-gate` command (docs/spec/pool4-for-solana.md, "A release gate", "How to run
//! it"). Run from `programs/` with `cargo run -p buy-wall-gate --`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::record::{self, Record, Target};
use crate::release::Release;
use crate::session::Session;
use crate::snapshot::{parse_key, Snapshot};
use crate::source::{cluster_url, Rpc};
use crate::{check, download, programs, quotes, stranding, synthetic, world};
use pipeline_check::AccountSource;
use pipeline_client::{pda, Pubkey};

const USAGE: &str = "\
buy-wall-gate: the buy wall AMM's release gate (docs/spec/pool4-for-solana.md, \"A release gate\")

  run --cluster <devnet|localnet|URL> --candidate <program.so>
      [--release <release.json>] [--records <dir>] [--snapshot-out <file>] [--program <id>]
        Downloads every market of the program from the cluster and replays it with the
        candidate and the cluster's router. Exits 0 and records the pass if every step
        passes on every market, else exits 1 naming each market and step that failed.

  verify-record --cluster <...> --candidate <program.so> [--records <dir>] [--program <id>]
        Exits 0 only if a passing run covers deploying the candidate to the cluster now:
        same build, against the build deployed now, covering every market there now.

  check --snapshot <file> --candidate <program.so> [--router <pipeline.so>] [--release <...>]
        The same checks on a saved snapshot or fixture, recording nothing.

  snapshot --cluster <...> --out <file> [--program <id>]
        Saves the cluster's markets as a fixture (no programs, the deployed build's quotes).

  synthesize --out <file> [--build <program.so>] [--router <pipeline.so>]
        Writes the synthetic layout fixture from a LiteSVM run (POOL4-20).

  rerecord --fixture <file> --build <program.so> [--router <pipeline.so>]
        Re-records a fixture's baseline quotes with a build, after a pricing change deploys.

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
                    snapshot.cluster.name.as_deref().unwrap_or(&url),
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
            let mut snapshot = Snapshot::read(&path)?;
            let build = read(Path::new(options.required("build")?))?;
            let router = match options.get("router") {
                Some(path) => read(Path::new(path))?,
                None => programs::pinned_router(),
            };
            let program = snapshot.program_id()?;
            let session = Session::new(world::load(&snapshot, &build, Some(&router))?, program);
            let markets = snapshot
                .markets
                .iter()
                .map(|m| parse_key(&m.market_state))
                .collect::<Result<Vec<_>, _>>()?;
            snapshot.baseline.quotes = quotes::record(&session, &markets)?;
            snapshot.baseline.executable_sha256 = Some(pipeline_check::executable_sha256(&build).0);
            snapshot.write(&path)?;
            println!(
                "re-recorded {} quote(s) in {}",
                snapshot.baseline.quotes.len(),
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
    let release = Release::read(&options.path_or("release", programs::release_path()))?;
    let program = options.program()?;
    let mut rpc = Rpc::new(&url);
    let markets = match download::find_markets(&mut rpc, &program) {
        Ok(markets) => markets,
        Err(error) => {
            println!("REFUSED: {error}");
            return Ok(false);
        }
    };
    println!("{} market state(s) of {program} on {url}", markets.len());
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
    let record = Record {
        program: program.to_string(),
        genesis_hash: snapshot
            .cluster
            .genesis_hash
            .clone()
            .ok_or("the cluster gave no genesis hash")?,
        cluster: snapshot.cluster.name.clone(),
        url,
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
        pricing_change_declared: release.changes_pricing_of(report.baseline_sha256.as_deref()),
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
    match record::find(&options.path_or("records", records_dir()), &target) {
        Ok(record) => {
            println!(
                "build {} passed the release gate on this cluster at slot {} against deployed build {}, \
                 covering all {} market(s)",
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

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}
