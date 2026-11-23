//! The tax AMM's release gate (hardening finding H038, #67; docs/spec/tax-amm.md, "Upgrades
//! and freezing"): before a new build replaces the one deployed, it must read and quote
//! every tax market on the cluster, so the upgrade strands none.
//!
//! `scripts/gate_snapshot.py` copies every tax market on a cluster (each market state with
//! its mints and vaults), the cluster's slot and the deployed program into a folder. The gate
//! loads them into LiteSVM, its clock at that slot, since the rates a market charges depend
//! on it (a pending rate change, docs/spec/tax-amm.md, "Rates"), and, for every market, with
//! the new build: reads the market state, asks
//! `pipeline_market_info` for it, and quotes a trade each way, which must equal the spec's
//! price (`common/model.rs`). With the deployed build beside it, every quote and every
//! refusal must also be the deployed build's.
//!
//! - In every `cargo test`, the gate runs the build under test against
//!   `tests/fixtures/release-gate/devnet/`, the devnet markets copied on 2026-11-22.
//! - `scripts/pre-deploy.sh`, which `scripts/deploy-devnet.sh` runs on the very bytes it is
//!   about to deploy, copies the cluster's markets afresh and runs
//!   [`the_release_gate_passes_the_candidate_on_the_clusters_markets`] on them:
//!
//! ```sh
//! TAX_AMM_GATE_SNAPSHOT=<dir> TAX_AMM_GATE_CANDIDATE=<tax_amm.so> \
//!   [TAX_AMM_GATE_DEPLOYED=<dir>/deployed.so] [TAX_AMM_GATE_REPORT=<report.json>] \
//!   cargo test -p tax-amm --test release_gate -- --ignored
//! ```

mod common;

use std::path::{Path, PathBuf};

use anchor_lang::{AccountDeserialize, Discriminator};
use base64::Engine;
use common::model::{Model, Refusal};
use common::*;
use litesvm::LiteSVM;
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::state::{layout, MarketStatus};
use tax_amm::TaxMarket;

/// What the gate saw of one market under one build.
#[derive(Debug, PartialEq, Eq)]
struct Reading {
    market_state: Pubkey,
    status: MarketStatus,
    reserves: [u64; 2],
    /// The quote each way (0 to 1, then 1 to 0): its amount, or the refusal's name.
    quotes: [(u64, Result<u64, String>); 2],
}

/// Every account in a snapshot folder: the solana CLI's account JSON, one file each.
fn snapshot(dir: &Path) -> Vec<(Pubkey, solana_account::Account)> {
    let mut accounts = vec![];
    for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|ext| ext != "json") || path.ends_with(SLOT_FILE) {
            continue;
        }
        let record: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let account = &record["account"];
        let data = base64::engine::general_purpose::STANDARD
            .decode(account["data"][0].as_str().unwrap())
            .unwrap();
        accounts.push((
            record["pubkey"].as_str().unwrap().parse().unwrap(),
            solana_account::Account {
                lamports: account["lamports"].as_u64().unwrap(),
                data,
                owner: account["owner"].as_str().unwrap().parse().unwrap(),
                executable: account["executable"].as_bool().unwrap(),
                rent_epoch: 0,
            },
        ));
    }
    accounts
}

/// The file of a snapshot folder holding the cluster's slot when its accounts were read.
const SLOT_FILE: &str = "slot.json";

/// The cluster's slot when the snapshot in `dir` was taken.
fn snapshot_slot(dir: &Path) -> u64 {
    let path = dir.join(SLOT_FILE);
    let record: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap();
    record["slot"].as_u64().expect("a slot")
}

/// A VM running `program` as the tax AMM, holding every account of the snapshot, its clock at
/// the snapshot's slot.
fn vm(program: &[u8], accounts: &[(Pubkey, solana_account::Account)], slot: u64) -> Env {
    let mut svm = LiteSVM::new();
    let mut clock: solana_clock::Clock = svm.get_sysvar();
    clock.slot = slot;
    svm.set_sysvar(&clock);
    svm.add_program(strategy_id(), program).unwrap();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10 * SOL).unwrap();
    for (address, account) in accounts {
        svm.set_account(*address, account.clone()).unwrap();
    }
    Env { svm, admin }
}

/// The market states in a snapshot: accounts the tax AMM owns, of a market state's size,
/// carrying its discriminator.
fn market_states(accounts: &[(Pubkey, solana_account::Account)]) -> Vec<Pubkey> {
    let mut states: Vec<Pubkey> = accounts
        .iter()
        .filter(|(_, account)| {
            account.owner == strategy_id()
                && account.data.len() == layout::LEN
                && account.data[..8] == *TaxMarket::DISCRIMINATOR
        })
        .map(|(address, _)| *address)
        .collect();
    states.sort();
    states
}

/// What `program` makes of the market at `market_state`: it reads it, gives its market info,
/// and quotes a trade each way of a hundredth of the input side's effective reserve.
fn read(env: &Env, market_state: &Pubkey) -> Result<Reading, String> {
    let data = env.svm.get_account(market_state).unwrap().data;
    let state = TaxMarket::try_deserialize(&mut data.as_slice()).map_err(|e| e.to_string())?;
    env.market_info_meta(market_state)
        .map_err(|e| format!("market info refused: {e}"))?;
    let mints = state.mints.map(|mint| ck(&mint));
    let token_programs = mints.map(|mint| env.svm.get_account(&mint).unwrap().owner);
    let (authority, vaults) = tax_market_addresses(market_state, mints);
    let market = Market {
        market: Pubkey::default(),
        market_state: *market_state,
        authority,
        mints,
        token_programs,
        vaults,
        created: Default::default(),
    };
    // The rates in force at the VM's slot, the cluster's when the snapshot was taken.
    let model = Model::of(&state).at(env.slot());
    let quote = |input: usize| {
        let effective = state.reserves[input] as u128
            + if state.virtual_side as usize == input {
                state.virtual_reserve as u128
            } else {
                0
            };
        let amount = (effective / 100).clamp(1, u64::MAX as u128) as u64;
        let quoted = env
            .quote(&market, &exact_in(input, 1 - input, amount))
            .map(|quote| quote.amount_out)
            .map_err(|failure| harness_refusal(&failure));
        (amount, quoted)
    };
    let quotes = [quote(0), quote(1)];
    if state.status == MarketStatus::Open {
        for (input, (amount, quoted)) in quotes.iter().enumerate() {
            let spec = model
                .price(input, 1 - input, *amount)
                .map(|trade| trade.out);
            let agrees = match (quoted, &spec) {
                (Ok(out), Ok(price)) => out == price,
                (Err(name), Err(Refusal::ZeroOutput)) => name == "ZeroOutput",
                (Err(name), Err(Refusal::BeyondRealReserve)) => name == "InsufficientLiquidity",
                _ => false,
            };
            if !agrees {
                return Err(format!(
                    "{market_state}: a quote of {amount} from side {input} gave {quoted:?}, the spec's price is {spec:?}"
                ));
            }
        }
    }
    Ok(Reading {
        market_state: *market_state,
        status: state.status,
        reserves: state.reserves,
        quotes,
    })
}

/// The tax AMM's error name in a refusal, or the whole failure.
fn harness_refusal(failure: &str) -> String {
    failure
        .split("Error Code: ")
        .nth(1)
        .and_then(|rest| rest.split('.').next())
        .unwrap_or(failure)
        .to_string()
}

/// Runs the gate: every market of the snapshot read and quoted by `candidate`, and by
/// `deployed` when given, which must agree. Returns what the candidate read.
fn gate(snapshot_dir: &Path, candidate: &[u8], deployed: Option<&[u8]>) -> Vec<Reading> {
    let accounts = snapshot(snapshot_dir);
    let slot = snapshot_slot(snapshot_dir);
    let states = market_states(&accounts);
    let new = vm(candidate, &accounts, slot);
    let old = deployed.map(|program| vm(program, &accounts, slot));
    let mut readings = vec![];
    for state in &states {
        let reading = read(&new, state)
            .unwrap_or_else(|e| panic!("the candidate build strands the tax market {state}: {e}"));
        if let Some(old) = &old {
            let before = read(old, state)
                .unwrap_or_else(|e| panic!("the deployed build can't read {state}: {e}"));
            assert_eq!(
                reading, before,
                "the candidate build reads or quotes {state} otherwise than the deployed one"
            );
        }
        readings.push(reading);
    }
    readings
}

/// A program's executable hash as `solana-verify get-program-hash` gives it: the SHA-256 of
/// its bytes without the trailing zeros a program account pads them with.
fn executable_hash(program: &[u8]) -> String {
    use sha2::Digest;
    let end = program
        .iter()
        .rposition(|&byte| byte != 0)
        .map_or(0, |i| i + 1);
    sha2::Sha256::digest(&program[..end])
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/release-gate/devnet")
}

/// The build under test reads and quotes every tax market that was on devnet on
/// 2026-11-22, at the spec's price, so it strands none of them.
#[test]
fn sos_h038_the_build_reads_and_quotes_every_devnet_market_at_the_specs_price() {
    let readings = gate(&fixture(), &strategy_so(), None);
    assert!(!readings.is_empty(), "the fixture holds devnet's markets");
    for reading in &readings {
        assert_eq!(reading.status, MarketStatus::Open);
        for (amount, quote) in &reading.quotes {
            assert!(
                quote.is_ok(),
                "{reading:?}: a quote of {amount} was refused"
            );
        }
    }
}

/// The gate refuses a build that can't read a market: here a market state whose version
/// byte says a newer build wrote it, which every instruction refuses (H069).
#[test]
#[should_panic(expected = "the candidate build strands the tax market")]
fn the_gate_refuses_a_build_that_strands_a_market() {
    let dir = std::env::temp_dir().join(format!("tax-amm-gate-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for entry in std::fs::read_dir(fixture()).unwrap() {
        let path = entry.unwrap().path();
        std::fs::copy(&path, dir.join(path.file_name().unwrap())).unwrap();
    }
    let accounts = snapshot(&dir);
    let state = market_states(&accounts)[0];
    let path = dir.join(format!("{state}.json"));
    let mut record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let engine = base64::engine::general_purpose::STANDARD;
    let mut data = engine
        .decode(record["account"]["data"][0].as_str().unwrap())
        .unwrap();
    data[8] = tax_amm::state::STATE_VERSION + 1;
    record["account"]["data"][0] = engine.encode(&data).into();
    std::fs::write(&path, record.to_string()).unwrap();
    gate(&dir, &strategy_so(), None);
}

/// A copy of the fixture whose first market state has `edit` applied to its bytes, in a
/// folder of its own named by `tag`.
fn edited_fixture(tag: &str, edit: impl FnOnce(&mut Vec<u8>)) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tax-amm-gate-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for entry in std::fs::read_dir(fixture()).unwrap() {
        let path = entry.unwrap().path();
        std::fs::copy(&path, dir.join(path.file_name().unwrap())).unwrap();
    }
    let accounts = snapshot(&dir);
    let state = market_states(&accounts)[0];
    let path = dir.join(format!("{state}.json"));
    let mut record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let engine = base64::engine::general_purpose::STANDARD;
    let mut data = engine
        .decode(record["account"]["data"][0].as_str().unwrap())
        .unwrap();
    edit(&mut data);
    record["account"]["data"][0] = engine.encode(&data).into();
    std::fs::write(&path, record.to_string()).unwrap();
    dir
}

/// A market with a pending rate change (docs/spec/tax-amm.md, "Rates") is quoted at the rates
/// in force at the snapshot's slot: the pending ones once their slot is reached, the market's
/// before then, each at the spec's price, which `read` checks.
#[test]
fn the_gate_quotes_a_market_with_a_pending_rate_change_at_the_rates_in_force() {
    let slot = snapshot_slot(&fixture());
    let mut quotes = vec![];
    for (tag, from_slot) in [("due", slot), ("waiting", slot + 1)] {
        let dir = edited_fixture(tag, |data| {
            // The pending buy and sell tax, each its range's minimum (offsets 178 and 182),
            // then the slot they apply from, at the offsets `tests/layout.rs` pins.
            let (buy_min, sell_min) = (data[178..180].to_vec(), data[182..184].to_vec());
            assert_ne!(
                (&data[174..176], &data[176..178]),
                (&buy_min[..], &sell_min[..]),
                "a change from the rates in force"
            );
            data[532..534].copy_from_slice(&buy_min);
            data[534..536].copy_from_slice(&sell_min);
            data[536..544].copy_from_slice(&from_slot.to_le_bytes());
        });
        let readings = gate(&dir, &strategy_so(), None);
        quotes.push(readings[0].quotes.clone());
    }
    assert_ne!(
        quotes[0], quotes[1],
        "a due change is in force, a waiting one is not"
    );
}

/// The live gate, which `scripts/pre-deploy.sh` runs on a fresh copy of the cluster's
/// markets (see the module's docs for its environment variables). It writes what it read
/// to `TAX_AMM_GATE_REPORT` when that is set.
#[test]
#[ignore = "run by scripts/pre-deploy.sh on a copy of the cluster's markets"]
fn the_release_gate_passes_the_candidate_on_the_clusters_markets() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
    let snapshot_dir = PathBuf::from(var("TAX_AMM_GATE_SNAPSHOT"));
    let candidate = std::fs::read(var("TAX_AMM_GATE_CANDIDATE")).unwrap();
    let deployed = std::env::var("TAX_AMM_GATE_DEPLOYED")
        .ok()
        .filter(|path| !path.is_empty())
        .map(|path| std::fs::read(path).unwrap());
    let readings = gate(&snapshot_dir, &candidate, deployed.as_deref());
    println!(
        "the candidate read and quoted all {} tax markets{}",
        readings.len(),
        if deployed.is_some() {
            ", exactly as the deployed build does"
        } else {
            ""
        }
    );
    let report: Vec<serde_json::Value> = readings
        .iter()
        .map(|r| {
            println!("{r:?}");
            serde_json::json!({
                "market_state": r.market_state.to_string(),
                "status": format!("{:?}", r.status),
                "reserves": r.reserves,
                "quotes": r.quotes.iter().enumerate().map(|(input, (amount, quote))| serde_json::json!({
                    "input": input,
                    "amount": amount,
                    "quote": match quote { Ok(out) => serde_json::json!(out), Err(name) => serde_json::json!(name) },
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    if let Ok(path) = std::env::var("TAX_AMM_GATE_REPORT") {
        let record = serde_json::json!({
            "candidate": executable_hash(&candidate),
            "deployed": deployed.as_deref().map(executable_hash),
            "markets": report,
        });
        std::fs::write(&path, serde_json::to_string_pretty(&record).unwrap() + "\n").unwrap();
    }
}
