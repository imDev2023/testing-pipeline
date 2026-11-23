//! Clusters for the gate's tests: LiteSVMs holding devnet's router, Kamino Lend's devnet build
//! with our devnet lending market's accounts as the lending AMM's tests dump them, a build of
//! the program as the one deployed, and markets made through the router as their creators would
//! make them; each read through pipeline-check's `SvmSource`, exactly as a cluster is read.

#![allow(dead_code)]

use base64::Engine;
use lending_gate::session::Session;
use lending_gate::snapshot::Snapshot;
use lending_gate::world::Programs;
use lending_gate::{check, download, kamino, own, programs, release::Release};
use litesvm::LiteSVM;
use pipeline_check::SvmSource;
use pipeline_client::{self as client, Pubkey};

/// A VM with the router, `deployed` at `program`, klend and our devnet lending market's
/// accounts, at the clock just past the slot they were dumped at.
pub fn bare(deployed: &[u8], program: Pubkey) -> LiteSVM {
    let mut svm = LiteSVM::new();
    let dir = programs::kamino_dump_dir();
    let read = |name: &str| -> serde_json::Value {
        let path = dir.join(name);
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
    };
    let manifest = read("manifest.json");
    svm.warp_to_slot(manifest["slot"].as_u64().unwrap() + 1);
    let mut clock: solana_clock::Clock = svm.get_sysvar();
    clock.unix_timestamp = manifest["unixTimestamp"].as_i64().unwrap() + 1;
    svm.set_sysvar(&clock);
    for entry in manifest["accounts"].as_array().unwrap() {
        let label = entry["label"].as_str().unwrap();
        let record = read(&format!("{label}.json"));
        let account = &record["account"];
        let address: Pubkey = record["pubkey"].as_str().unwrap().parse().unwrap();
        let data = base64::engine::general_purpose::STANDARD
            .decode(account["data"][0].as_str().unwrap())
            .unwrap();
        svm.set_account(
            address,
            solana_account::Account {
                lamports: account["lamports"].as_u64().unwrap(),
                data,
                owner: account["owner"].as_str().unwrap().parse().unwrap(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    }
    svm.add_program(client::PROGRAM_ID, &programs::pinned_router())
        .unwrap();
    svm.add_program(kamino::klend(), &programs::pinned_klend())
        .unwrap();
    svm.add_program(program, deployed).unwrap();
    svm
}

/// A session on a cluster readied as devnet is once the program is registered: the router's
/// config and the registration, and a second depositor in each reserve.
pub fn registered(deployed: &[u8]) -> Session {
    let program = programs::program_id();
    let mut session = Session::new(bare(deployed, program), program);
    own::ready_router(&mut session).unwrap();
    kamino::second_depositor(&mut session.svm).unwrap();
    assert!(session.refresh_reserves().is_empty());
    session
}

/// Two markets made with `deployed`: one lending its surplus to Kamino and traded since, one
/// holding its whole lent side in the buffer, as before its first `rebalance`.
pub fn with_markets(deployed: &[u8]) -> (Session, Vec<Pubkey>) {
    let mut session = registered(deployed);
    let lent = own::create_market(
        &mut session,
        b"lent",
        30,
        [1_000_000_000_000, 20_000_000_000],
    )
    .unwrap();
    let view = session.market(&lent).unwrap();
    own::lend(&mut session, &view).unwrap();
    let fresh =
        own::create_market(&mut session, b"fresh", 0, [500_000_000_000, 5_000_000_000]).unwrap();
    (session, vec![lent, fresh])
}

/// The snapshot of `session`'s cluster with `markets`, as `run` takes one.
pub fn snapshot(session: Session, markets: &[Pubkey]) -> Snapshot {
    let program = session.program;
    let mut source = SvmSource::new(session.svm);
    download::snapshot(
        &mut source,
        &program,
        markets,
        None,
        "a test cluster",
        Programs::default(),
    )
    .unwrap()
}

pub fn run(snapshot: &Snapshot, candidate: &[u8]) -> check::Report {
    check::run(
        snapshot,
        candidate,
        Programs::default(),
        &Release::default(),
    )
}

/// The names of the steps of a market's report, without their amounts.
pub fn step_names(market: &check::MarketReport) -> Vec<String> {
    market
        .steps
        .iter()
        .map(|step| step.name.split(" (").next().unwrap().to_string())
        .collect()
}
