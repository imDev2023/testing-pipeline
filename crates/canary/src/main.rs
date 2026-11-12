//! The `canary` command.
//!
//! ```text
//! canary run --url <rpc> --market <MARKET>     # one market
//! canary run --url <rpc> --strategy <PROGRAM>  # every market of one strategy
//! canary run --url <rpc> --all                 # every market registered with the router
//! canary snapshot --url <rpc> --market <MARKET> # the snapshot the endpoint would be posted
//! canary serve [--listen 127.0.0.1:8080]       # the container's endpoint, locally
//! ```
//!
//! `<rpc>` is `devnet` or any http(s) RPC URL; the run only reads from it. `run` prints the
//! records and the roll-ups as JSON on stdout, and what it measured on stderr.

use std::net::SocketAddr;
use std::process::ExitCode;
use std::time::Instant;

use canary::run::{sweep, RunOptions};
use canary::source::{record_snapshot, RpcAccounts};
use clap::{Args, Parser, Subcommand};
use pipeline_check::rpc::cluster_url;
use pipeline_client::Pubkey;
use serde_json::json;

#[derive(Parser)]
#[command(
    name = "canary",
    version,
    about = "Canary checks: trade a private copy of a Pipeline market as a trader would"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Runs every check and prints the records and the roll-ups as JSON.
    Run(RunArgs),
    /// Prints the snapshot of one market that a full run reads, as the endpoint takes it.
    Snapshot {
        #[arg(long)]
        url: String,
        #[arg(long)]
        market: Pubkey,
    },
    /// Serves the container's endpoint: POST /run with a snapshot.
    Serve {
        #[arg(long, default_value = "127.0.0.1:8080")]
        listen: SocketAddr,
    },
}

#[derive(Args)]
#[group(required = true, multiple = false, id = "target")]
struct Target {
    /// One market.
    #[arg(long)]
    market: Option<Pubkey>,
    /// Every market of one strategy program.
    #[arg(long)]
    strategy: Option<Pubkey>,
    /// Every market registered with the router.
    #[arg(long)]
    all: bool,
}

#[derive(Args)]
struct RunArgs {
    /// `devnet`, `mainnet`, `testnet`, `localnet` or an http(s) RPC URL.
    #[arg(long)]
    url: String,
    #[command(flatten)]
    target: Target,
}

fn run(args: RunArgs) -> Result<(), String> {
    let started = Instant::now();
    let mut source = RpcAccounts::new(&cluster_url(&args.url)?)?;
    let markets: Vec<Pubkey> = match (args.target.market, args.target.strategy) {
        (Some(market), _) => vec![market],
        (None, strategy) => {
            let mut markets = source.markets()?;
            markets.sort_by_key(|(_, m)| (m.strategy_program, m.created_at));
            markets
                .into_iter()
                .filter(|(_, m)| strategy.is_none_or(|s| m.strategy_program == s))
                .map(|(address, _)| address)
                .collect()
        }
    };
    let result = sweep(&mut source, &markets, &RunOptions::default());
    let elapsed = started.elapsed();
    let output = json!({
        "harness": result.harness,
        "markets": markets.len(),
        "rpc_requests": source.requests(),
        "wall_seconds": elapsed.as_secs_f64(),
        "rollups": result.rollups,
        "records": result.records,
        "notes": result.notes,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|e| e.to_string())?
    );
    eprintln!(
        "canary: {} markets, {} records, {} RPC requests, {:.1} s",
        markets.len(),
        result.records.len(),
        source.requests(),
        elapsed.as_secs_f64()
    );
    Ok(())
}

fn snapshot(url: &str, market: Pubkey) -> Result<(), String> {
    let mut source = RpcAccounts::new(&cluster_url(url)?)?;
    let snapshot = record_snapshot(&mut source, market)?;
    println!(
        "{}",
        serde_json::to_string(&snapshot).map_err(|e| e.to_string())?
    );
    eprintln!(
        "canary: {} accounts, {} RPC requests",
        snapshot.accounts.len(),
        source.requests()
    );
    Ok(())
}

fn serve(listen: SocketAddr) -> Result<(), String> {
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(listen)
            .await
            .map_err(|e| format!("cannot listen on {listen}: {e}"))?;
        eprintln!("canary: serving POST /run on http://{listen}");
        axum::serve(listener, canary::http::router())
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await
            .map_err(|e| e.to_string())
    })
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Run(args) => run(args),
        Command::Snapshot { url, market } => snapshot(&url, market),
        Command::Serve { listen } => serve(listen),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("canary: {error}");
            ExitCode::FAILURE
        }
    }
}
