//! The containment hook's release gate (hardening findings H011, H002 and R2T-01 to R2T-06,
//! #74): before a new build replaces the one deployed, it must serve every config the
//! deployed build wrote, so a redeploy strands no contained token. Tokens contained before it
//! must still trade in their home market and still unlock; appending even one byte to
//! `Config` would keep trading working but make every `unlock` fail, which nothing else would
//! notice until a deadline.
//!
//! `scripts/gate_snapshot.py` reads every account the hook owns on a cluster (the census),
//! copies every config with the accounts its binding names (the mint, the validation account,
//! the router `Market`, the market state, both mints and vaults and both fee accounts) and the
//! Token-2022 accounts of each contained mint, and writes a `manifest.json` naming the
//! program, the cluster's genesis hash, its clock, whether the hook is deployed, the census
//! and every file it wrote. The gate loads only what the manifest lists into LiteSVM with the
//! build under test, after the router's own setup ([`Env::new`]), its clock at the snapshot's
//! slot and Unix time, and checks:
//!
//! - the census: the snapshot is of the build's own program id, every config and validation
//!   account the manifest lists is there and pairs up, no other hook-owned account is, the
//!   hook deployed with no config at all is refused unless `HOOK_GATE_ALLOW_EMPTY` says why,
//!   and on devnet (known by its genesis hash) every config of the committed fixture and every
//!   mint of `deployments/devnet-demo-containment-hook.json` is still there unless
//!   `HOOK_GATE_ALLOW_FEWER` says why, and the hook `deployments/devnet.json` records is
//!   deployed (R2T-01, R2T-04, R2T-05);
//! - that a fresh mint binds to a fresh home market on the router with the candidate, and is
//!   seeded through the hook (R2T-03);
//! - for every config, in a VM of its own: the candidate's `Config` decodes the bytes and
//!   serialises them back identically;
//! - for each token still contained: a router buy into a fresh associated token account the
//!   associated token program creates; a buy into a fresh keypair account without
//!   `ImmutableOwner` refused with `DestinationOwnerCanChange` (H001); a direct `Execute`
//!   refused with `NotTransferring`; a sell of part of it back; where the sell pays Pipeline's
//!   fee in the token, the fee arriving in the fee account and a `sweep_fees` of it with the
//!   hook tail (R2T-03); a wallet-to-wallet `transfer_checked` refused with
//!   `TransferRefused`; `unlock` refused with `UnlockNotDue` unless it is already due; in fresh
//!   VMs, with the market state's `tax_collected` written through the tax AMM's own
//!   `TaxMarket`, `unlock` refused one below the goal before the deadline and passing at the
//!   goal, logging the goal (R2T-02); then, with the clock at its deadline, `unlock` succeeds;
//!   each unlock clears both of the mint's hook fields and changes the config only by
//!   `unlocked_at`;
//! - for each token already unlocked: `unlock` refused with `AlreadyUnlocked`.
//!
//! For each token still contained it also reports, as a warning and never a refusal, the
//! balances held in Token-2022 accounts whose owner can change (no `ImmutableOwner`), which
//! the hook's rule cannot reach (H002), and whether the accounts found add up to the supply.
//!
//! On devnet it also checks that the tax AMM compiled into the hook
//! (`containment_hook::config::TAX_AMM_PROGRAM_ID`) is the one `deployments/devnet.json`
//! records (H072).
//!
//! - In every `cargo test`, the gate runs the build under test, with the tax AMM build the
//!   harness loads, against `tests/fixtures/release-gate/devnet/`, devnet's six configs copied
//!   on 2026-11-23, three of them still contained (the program dumps are not committed).
//! - `scripts/pre-deploy.sh`, which `scripts/deploy-devnet.sh` runs on the very bytes it is
//!   about to deploy, copies the cluster afresh and runs
//!   [`the_release_gate_passes_the_candidate_on_the_clusters_configs`] on it:
//!
//! ```sh
//! HOOK_GATE_SNAPSHOT=<dir> HOOK_GATE_CANDIDATE=<containment_hook.so> HOOK_GATE_PROGRAM=<id> \
//!   [HOOK_GATE_TAX_AMM=<dir>/tax_amm_deployed.so] [HOOK_GATE_DEPLOYED=<dir>/deployed.so] \
//!   [HOOK_GATE_REPORT=<report.json>] [HOOK_GATE_ALLOW_EMPTY=<why>] [HOOK_GATE_ALLOW_FEWER=<why>] \
//!   cargo test -p containment-hook --test release_gate -- --ignored
//! ```
//!
//! The v1 layout of `Config` is frozen (H011): [`config_v1_bytes_are_pinned`] pins it.

mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anchor_lang::{AccountDeserialize, AccountSerialize, Discriminator};
use base64::Engine;
use containment_hook::mint::TransferHook;
use containment_hook::{tax_market, terms, Config, HookError};
use litesvm::types::TransactionMetadata;
use pipeline_client::{self as client, pda, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use support::*;

/// The files of a snapshot folder that are not accounts.
const MANIFEST_FILE: &str = "manifest.json";
const HOLDERS_FILE: &str = "holders.json";
/// Devnet's genesis hash, by which the gate knows devnet whatever RPC served it (R2T-04).
const DEVNET_GENESIS_HASH: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/// The validation account's size: the extra account metas `bind` writes for every mint.
const VALIDATION_LEN: usize = 51;

/// The Token-2022 accounts of one contained mint, as the snapshot found them (H002).
#[derive(Clone, Debug, Default)]
struct HolderRead {
    /// How they were found (a `getProgramAccounts`, or the mint's transaction history).
    source: String,
    /// Why they could not be read, when they could not.
    error: Option<String>,
    accounts: Vec<(Pubkey, Vec<u8>)>,
}

/// A copy of a cluster's bindings, as `scripts/gate_snapshot.py` writes it.
#[derive(Clone)]
struct Snapshot {
    accounts: Vec<(Pubkey, solana_account::Account)>,
    slot: u64,
    unix_timestamp: i64,
    url: String,
    genesis_hash: String,
    /// The program the census read.
    program: Pubkey,
    /// Whether the program is deployed on the cluster.
    deployed: bool,
    /// The census: every config and validation account the program owns.
    configs: Vec<Pubkey>,
    validation_accounts: Vec<Pubkey>,
    /// Each contained mint's Token-2022 accounts; `None` when the snapshot has none.
    holders: Option<BTreeMap<Pubkey, HolderRead>>,
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn keys(value: &serde_json::Value, field: &str) -> Result<Vec<Pubkey>, String> {
    value[field]
        .as_array()
        .ok_or(format!("the manifest has no {field} list"))?
        .iter()
        .map(|key| {
            key.as_str()
                .and_then(|key| key.parse().ok())
                .ok_or(format!("{field} lists {key}, not an address"))
        })
        .collect()
}

fn account_file(path: &Path) -> Result<(Pubkey, solana_account::Account), String> {
    let record = read_json(path)?;
    let account = &record["account"];
    let bad = || {
        format!(
            "{} is not an account in the solana CLI's JSON",
            path.display()
        )
    };
    let data = base64::engine::general_purpose::STANDARD
        .decode(account["data"][0].as_str().ok_or_else(bad)?)
        .map_err(|_| bad())?;
    Ok((
        record["pubkey"]
            .as_str()
            .and_then(|key| key.parse().ok())
            .ok_or_else(bad)?,
        solana_account::Account {
            lamports: account["lamports"].as_u64().ok_or_else(bad)?,
            data,
            owner: account["owner"]
                .as_str()
                .and_then(|key| key.parse().ok())
                .ok_or_else(bad)?,
            executable: account["executable"].as_bool().ok_or_else(bad)?,
            rent_epoch: 0,
        },
    ))
}

fn holders_file(path: &Path) -> Result<BTreeMap<Pubkey, HolderRead>, String> {
    let record = read_json(path)?;
    let mut holders = BTreeMap::new();
    for (mint, read) in record.as_object().ok_or("holders.json is not an object")? {
        let mint: Pubkey = mint
            .parse()
            .map_err(|_| format!("holders.json names {mint}, not a mint"))?;
        let mut accounts = vec![];
        for entry in read["accounts"].as_array().cloned().unwrap_or_default() {
            let address = entry["pubkey"]
                .as_str()
                .and_then(|key| key.parse().ok())
                .ok_or("a holder without an address")?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(entry["data"].as_str().unwrap_or_default())
                .map_err(|e| format!("holder {address}: {e}"))?;
            accounts.push((address, data));
        }
        holders.insert(
            mint,
            HolderRead {
                source: read["source"].as_str().unwrap_or_default().to_string(),
                error: read["error"].as_str().map(str::to_string),
                accounts,
            },
        );
    }
    Ok(holders)
}

/// The snapshot in `dir`: exactly the accounts its manifest lists, and nothing it does not
/// (R2T-06), with the census and the cluster's clock when they were read.
fn load_snapshot(dir: &Path) -> Result<Snapshot, String> {
    let manifest = read_json(&dir.join(MANIFEST_FILE))?;
    let listed: Vec<String> = manifest["accounts"]
        .as_array()
        .ok_or("the manifest lists no accounts")?
        .iter()
        .map(|file| file.as_str().map(str::to_string).ok_or("a file name"))
        .collect::<Result<_, _>>()?;
    for entry in std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let name = entry
            .map_err(|e| e.to_string())?
            .file_name()
            .to_string_lossy()
            .to_string();
        if name.ends_with(".json")
            && name != MANIFEST_FILE
            && name != HOLDERS_FILE
            && !listed.contains(&name)
        {
            return Err(format!(
                "{name} is in the snapshot folder but not in its manifest; snapshot into an empty folder"
            ));
        }
    }
    let mut accounts = listed
        .iter()
        .map(|file| account_file(&dir.join(file)))
        .collect::<Result<Vec<_>, _>>()?;
    accounts.sort_by_key(|(address, _)| *address);
    let holders = match manifest["holders"].as_str() {
        Some(file) => Some(holders_file(&dir.join(file))?),
        None => None,
    };
    let text = |field: &str| {
        manifest[field]
            .as_str()
            .map(str::to_string)
            .ok_or(format!("the manifest has no {field}"))
    };
    Ok(Snapshot {
        accounts,
        slot: manifest["slot"]
            .as_u64()
            .ok_or("the manifest has no slot")?,
        unix_timestamp: manifest["unix_timestamp"]
            .as_i64()
            .ok_or("the manifest has no Unix time")?,
        url: text("url")?,
        genesis_hash: text("genesis_hash")?,
        program: text("program")?
            .parse()
            .map_err(|_| "the manifest's program is not an address")?,
        deployed: manifest["deployed"]
            .as_bool()
            .ok_or("the manifest does not say whether the hook is deployed")?,
        configs: keys(&manifest, "configs")?,
        validation_accounts: keys(&manifest, "validation_accounts")?,
        holders,
    })
}

fn snapshot(dir: &Path) -> Snapshot {
    load_snapshot(dir).unwrap_or_else(|why| panic!("{why}"))
}

impl Snapshot {
    /// The hook configs the census found, which the gate reads one by one.
    fn configs(&self) -> Vec<Pubkey> {
        self.configs.clone()
    }

    fn get(&self, address: &Pubkey) -> Option<&solana_account::Account> {
        self.accounts
            .iter()
            .find(|(key, _)| key == address)
            .map(|(_, account)| account)
    }

    fn account(&self, address: &Pubkey) -> &solana_account::Account {
        self.get(address)
            .unwrap_or_else(|| panic!("{address} is not in the snapshot"))
    }

    fn account_mut(&mut self, address: &Pubkey) -> &mut solana_account::Account {
        &mut self
            .accounts
            .iter_mut()
            .find(|(key, _)| key == address)
            .unwrap_or_else(|| panic!("{address} is not in the snapshot"))
            .1
    }

    /// Devnet, known by its genesis hash whatever RPC served it (R2T-04).
    fn is_devnet(&self) -> bool {
        self.genesis_hash == DEVNET_GENESIS_HASH
    }
}

/// A VM with the router configured and the tax AMM registered ([`Env::new`]), `tax_amm` in
/// place of the harness's tax AMM build when given, `hook` as the containment hook, every
/// account of the snapshot loaded after the router's setup, and the clock at the snapshot's
/// slot and Unix time.
fn vm(snapshot: &Snapshot, hook: &[u8], tax_amm: Option<&[u8]>) -> Env {
    let mut env = Env::new();
    if let Some(program) = tax_amm {
        env.svm.add_program(strategy_id(), program).unwrap();
    }
    env.svm.add_program(hook_id(), hook).unwrap();
    for (address, account) in &snapshot.accounts {
        env.svm.set_account(*address, account.clone()).unwrap();
    }
    let mut clock: solana_clock::Clock = env.svm.get_sysvar();
    clock.slot = snapshot.slot;
    clock.unix_timestamp = snapshot.unix_timestamp;
    env.svm.set_sysvar(&clock);
    env
}

/// What one step of the gate returned: what it saw when it passed, or why it failed.
#[derive(Clone, Debug)]
struct Step {
    name: &'static str,
    outcome: Result<String, String>,
}

impl Step {
    fn failure(&self) -> Option<String> {
        self.outcome
            .as_ref()
            .err()
            .map(|why| format!("{}: {why}", self.name))
    }

    fn report(&self) -> serde_json::Value {
        serde_json::json!({
            "step": self.name,
            "passed": self.outcome.is_ok(),
            "result": match &self.outcome { Ok(said) | Err(said) => said },
        })
    }
}

/// What the gate saw of one config.
#[derive(Debug)]
struct Reading {
    config: Pubkey,
    mint: Option<Pubkey>,
    contained: Option<bool>,
    steps: Vec<Step>,
    /// What the gate reports without refusing: balances the hook's rule cannot reach (H002).
    warnings: Vec<String>,
}

impl Reading {
    fn failures(&self) -> Vec<String> {
        self.steps
            .iter()
            .filter_map(|step| {
                step.outcome
                    .as_ref()
                    .err()
                    .map(|why| format!("{} ({:?}): {}: {why}", self.config, self.mint, step.name))
            })
            .collect()
    }

    fn step(&self, name: &str) -> Option<&Step> {
        self.steps.iter().find(|step| step.name == name)
    }

    fn report(&self) -> serde_json::Value {
        serde_json::json!({
            "config": self.config.to_string(),
            "mint": self.mint.map(|mint| mint.to_string()),
            "state": match self.contained {
                Some(true) => "contained",
                Some(false) => "unlocked",
                None => "unreadable",
            },
            "steps": self.steps.iter().map(Step::report).collect::<Vec<_>>(),
            "warnings": self.warnings,
        })
    }
}

/// Records a step's outcome in `steps`, and gives its value on to the next step, or stops
/// the config's steps when it failed.
fn step<T>(
    steps: &mut Vec<Step>,
    name: &'static str,
    outcome: Result<(T, String), String>,
) -> Result<T, ()> {
    match outcome {
        Ok((value, said)) => {
            steps.push(Step {
                name,
                outcome: Ok(said),
            });
            Ok(value)
        }
        Err(why) => {
            steps.push(Step {
                name,
                outcome: Err(why),
            });
            Err(())
        }
    }
}

/// The error name Anchor logs for a failed transaction, or the failure's first line.
fn error_name(failure: &str) -> String {
    failure
        .split("Error Code: ")
        .nth(1)
        .and_then(|rest| rest.split('.').next())
        .unwrap_or_else(|| failure.lines().next().unwrap_or(failure))
        .to_string()
}

/// Passes when `result` is the hook refusing with `error` (its number and its name), as
/// `assert_hook_refused` checks, without panicking.
fn refused_with<T>(result: Result<T, String>, error: HookError) -> Result<((), String), String> {
    let name = format!("{error:?}");
    let number = anchor_lang::error::ERROR_CODE_OFFSET + error as u32;
    match result {
        Ok(_) => Err(format!("passed; the hook should refuse it with {name}")),
        Err(failure)
            if failure.contains(&format!("Custom({number})"))
                && failure.contains(&format!("Error Code: {name}.")) =>
        {
            Ok(((), format!("refused with {name}")))
        }
        Err(failure) => Err(format!(
            "the hook should refuse it with {name}, got {}",
            error_name(&failure)
        )),
    }
}

/// A binding's home market as the harness knows markets, with where its contained mint is.
struct Home {
    market: Market,
    contained: usize,
    mint: Pubkey,
    decimals: u8,
}

/// The home market the config names, read from the router `Market` in the VM.
fn home(env: &Env, config: &Config) -> Result<(Home, String), String> {
    let address = ck(&config.market);
    let data = env
        .svm
        .get_account(&address)
        .ok_or("the Market is not in the snapshot")?
        .data;
    let market = containment_hook::router::read_market(&data)
        .ok_or("the Market can't be read as the router's")?;
    if market.mint_count != 2 {
        return Err(format!("the Market trades {} mints", market.mint_count));
    }
    let mints = [ck(&market.mints[0]), ck(&market.mints[1])];
    let vaults = [ck(&market.vaults[0]), ck(&market.vaults[1])];
    let mint = ck(&config.mint);
    let contained = mints
        .iter()
        .position(|m| *m == mint)
        .ok_or("the Market does not trade the contained mint")?;
    let owner = |mint: &Pubkey| env.svm.get_account(mint).map(|account| account.owner);
    let token_programs = [
        owner(&mints[0]).ok_or("a mint of the Market is not in the snapshot")?,
        owner(&mints[1]).ok_or("a mint of the Market is not in the snapshot")?,
    ];
    let market_state = ck(&market.market_state);
    let decimals = env.svm.get_account(&mint).ok_or("no mint")?.data[44];
    let said = format!(
        "the Market {address} trades the contained mint at index {contained} against {}",
        mints[1 - contained]
    );
    Ok((
        Home {
            market: Market {
                market: address,
                market_state,
                authority: tax_market_addresses(&market_state, mints).0,
                mints,
                token_programs,
                vaults,
                created: Default::default(),
            },
            contained,
            mint,
            decimals,
        },
        said,
    ))
}

/// The side the router takes Pipeline's fee on in a trade into side `output` of the home
/// market, from its record of the market.
fn fee_side(env: &Env, home: &Home, output: usize) -> client::FeeSide {
    client::FeeSide::of(
        &env.router_market(&home.market.market),
        &home.market.mints[output],
    )
}

/// The router's exact-in `swap` of `amount_in` from side `input` to the other side of the
/// home market, as a terminal builds it: the tax AMM's resolved accounts, then the hook
/// accounts after them on a buy, or as the input's hook accounts on a sell; into the trader's
/// associated token account, or `output_to`.
fn swap(
    env: &mut Env,
    home: &Home,
    trader: &Keypair,
    input: usize,
    amount_in: u64,
    output_to: Option<Pubkey>,
) -> Result<client::SwapResult, String> {
    let market = &home.market;
    let output = 1 - input;
    let mut strategy_accounts =
        env.resolve_accounts(market, &exact_in(input, output, amount_in))?;
    let mut input_hook_accounts = vec![];
    if output == home.contained {
        strategy_accounts.extend(hook_tail(&home.mint));
    } else {
        input_hook_accounts = hook_tail(&home.mint);
    }
    let accounts = client::SwapAccounts {
        trader: trader.pubkey(),
        strategy_program: strategy_id(),
        market_state: market.market_state,
        trader_input: pda::associated_token(
            &trader.pubkey(),
            &market.mints[input],
            &market.token_programs[input],
        ),
        trader_output: output_to.unwrap_or_else(|| {
            pda::associated_token(
                &trader.pubkey(),
                &market.mints[output],
                &market.token_programs[output],
            )
        }),
        input_vault: market.vaults[input],
        input_mint: market.mints[input],
        output_mint: market.mints[output],
        input_token_program: market.token_programs[input],
        output_token_program: market.token_programs[output],
        integrator_fee_account: None,
        strategy_accounts,
        input_hook_accounts: input_hook_accounts.clone(),
    };
    let args = client::SwapArgs {
        mode: client::TradeMode::ExactIn,
        amount_in,
        amount_out: 0,
        min_amount_out: 0,
        integrator_fee_bps: 0,
        input_hook_accounts: input_hook_accounts.len() as u8,
        extra: vec![],
    };
    let side = fee_side(env, home, output);
    let meta = env.send_meta(
        &[client::swap_with_fee_side(&accounts, &args, side)],
        &[trader],
    )?;
    borsh::from_slice(&meta.return_data.data).map_err(|e| e.to_string())
}

/// A trader holding twice `amount_in` of the quote mint (Pipeline's fee on a buy is taken in
/// the quote mint on top of it).
fn quote_trader(env: &mut Env, home: &Home, amount_in: u64) -> Keypair {
    let quote = 1 - home.contained;
    let trader = stranger(env);
    env.write_token_account(
        &home.market.mints[quote],
        &home.market.token_programs[quote],
        &trader.pubkey(),
        2 * amount_in,
    );
    trader
}

/// A Token-2022 `transfer_checked` of the contained token at its own decimals, with the hook
/// accounts after its own.
fn transfer_instruction(
    home: &Home,
    source: &Pubkey,
    destination: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut instruction = spl_token_2022_interface::instruction::transfer_checked(
        &TOKEN_2022,
        source,
        &home.mint,
        destination,
        owner,
        &[],
        amount,
        home.decimals,
    )
    .unwrap();
    instruction.accounts.extend(hook_tail(&home.mint));
    instruction
}

/// Sends `unlock` for the config's mint from a fresh wallet.
fn send_unlock(env: &mut Env, config: &Config) -> Result<TransactionMetadata, String> {
    let caller = stranger(env);
    let instruction = unlock_instruction(&ck(&config.mint), &ck(&config.market_state));
    send_as(env, &caller, &[instruction])
}

/// After an `unlock` at `at`: both of the mint's hook fields are cleared, and the config is
/// unchanged but for `unlocked_at`.
fn check_unlocked(
    env: &Env,
    address: &Pubkey,
    original: &[u8],
    config: &Config,
    at: i64,
) -> Result<(), String> {
    let hook = mint_hook(env, &ck(&config.mint));
    let cleared = Some(TransferHook {
        authority: None,
        program: None,
    });
    if hook != cleared {
        return Err(format!("the mint's hook fields are {hook:?}, not cleared"));
    }
    let data = env.svm.get_account(address).unwrap().data;
    let mut expected = Config {
        unlocked_at: Some(at),
        ..*config
    };
    let after = Config::try_deserialize(&mut &data[..])
        .map_err(|e| format!("the config no longer decodes: {e}"))?;
    if data.len() != original.len() || after != expected {
        expected.unlocked_at = after.unlocked_at;
        return Err(format!(
            "the config changed otherwise than by its unlock time ({} bytes, {})",
            data.len(),
            if after == expected {
                "unlocked_at differs"
            } else {
                "other fields differ"
            }
        ));
    }
    Ok(())
}

/// Writes `tax_collected` into a tax AMM market state's data. The gate's own writer goes
/// through the tax AMM's `TaxMarket` (its published Anchor account), not the hook's reader, so
/// a candidate that misreads the counter fails the goal steps (R2T-02).
type CounterWriter = fn(&mut [u8], u128) -> Result<(), String>;

fn write_tax_collected(data: &mut [u8], tax_collected: u128) -> Result<(), String> {
    let mut state = tax_amm::TaxMarket::try_deserialize(&mut &data[..])
        .map_err(|e| format!("the market state can't be read as the tax AMM's TaxMarket: {e}"))?;
    state.tax_collected = tax_collected;
    let mut bytes = vec![];
    state
        .try_serialize(&mut bytes)
        .map_err(|e| format!("the TaxMarket can't be written back: {e}"))?;
    if bytes.len() > data.len() {
        return Err("the TaxMarket no longer fits its account".into());
    }
    data[..bytes.len()].copy_from_slice(&bytes);
    Ok(())
}

/// A fresh VM of the snapshot with the config's market state counting `tax_collected`, and
/// an `unlock` sent in it at the snapshot's time.
fn unlock_at_count(
    snapshot: &Snapshot,
    hook: &[u8],
    tax_amm: Option<&[u8]>,
    config: &Config,
    counter: CounterWriter,
    tax_collected: u128,
) -> Result<(Env, Result<TransactionMetadata, String>), String> {
    let mut env = vm(snapshot, hook, tax_amm);
    let state_address = ck(&config.market_state);
    let mut state = env
        .svm
        .get_account(&state_address)
        .ok_or("the market state is not in the snapshot")?;
    if state.owner != ck(&containment_hook::config::TAX_AMM_PROGRAM_ID) {
        return Err(format!(
            "the market state is owned by {}, not the tax AMM",
            state.owner
        ));
    }
    counter(&mut state.data, tax_collected)?;
    env.svm.set_account(state_address, state).unwrap();
    let result = send_unlock(&mut env, config);
    Ok((env, result))
}

/// The candidate's `Config` decodes the account and serialises it back to the same bytes (a
/// contained config's spare bytes after `unlocked_at`'s tag stay zero).
fn decode(address: &Pubkey, data: &[u8]) -> Result<(Config, String), String> {
    let config = Config::try_deserialize(&mut &data[..])
        .map_err(|e| format!("the candidate's Config can't decode it: {e}"))?;
    let mut bytes = vec![];
    config
        .try_serialize(&mut bytes)
        .map_err(|e| format!("the candidate's Config can't serialise it: {e}"))?;
    if bytes.len() > data.len() {
        return Err(format!(
            "the candidate's Config serialises it to {} bytes, more than the account's {}",
            bytes.len(),
            data.len()
        ));
    }
    if bytes[..] != data[..bytes.len()] || data[bytes.len()..].iter().any(|&byte| byte != 0) {
        return Err("the candidate's Config serialises it to other bytes".into());
    }
    let mint = ck(&config.mint);
    if config_pda(&mint) != *address {
        return Err(format!("it is not the config PDA of its mint {mint}"));
    }
    let said = format!(
        "version {}, {} bytes, serialised back identically",
        config.version,
        data.len()
    );
    Ok((config, said))
}

/// One Token-2022 account holding the contained token whose owner can change (H002).
#[derive(Clone, Debug, PartialEq, Eq)]
struct MutableHolding {
    account: Pubkey,
    owner: Pubkey,
    amount: u64,
}

/// What the gate makes of a contained mint's Token-2022 accounts (H002): the balances held in
/// accounts without `ImmutableOwner`, other than `allowed` (the home market's vault and fee
/// account, which the hook allows by address), the total the accounts hold, and the accounts
/// that could not be read as token accounts of the mint.
#[derive(Debug, Default, PartialEq, Eq)]
struct Holdings {
    mutable: Vec<MutableHolding>,
    total: u128,
    unreadable: Vec<Pubkey>,
}

fn classify_holdings(
    mint: &Pubkey,
    accounts: &[(Pubkey, Vec<u8>)],
    allowed: &[Pubkey],
) -> Holdings {
    use spl_token_2022_interface::extension::{
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    };
    use spl_token_2022_interface::state::Account as TokenAccount;
    let mut holdings = Holdings::default();
    for (address, data) in accounts {
        let Ok(state) = StateWithExtensions::<TokenAccount>::unpack(data) else {
            holdings.unreadable.push(*address);
            continue;
        };
        if state.base.mint.to_bytes() != mint.to_bytes() {
            holdings.unreadable.push(*address);
            continue;
        }
        holdings.total += u128::from(state.base.amount);
        let immutable = state
            .get_extension_types()
            .is_ok_and(|types| types.contains(&ExtensionType::ImmutableOwner));
        if state.base.amount > 0 && !immutable && !allowed.contains(address) {
            holdings.mutable.push(MutableHolding {
                account: *address,
                owner: Pubkey::new_from_array(state.base.owner.to_bytes()),
                amount: state.base.amount,
            });
        }
    }
    holdings
}

/// The gate's warnings about a contained mint's holders (H002): never a refusal.
fn holder_warnings(snapshot: &Snapshot, config: &Config, home: &Home) -> Vec<String> {
    let mint = ck(&config.mint);
    let Some(read) = snapshot
        .holders
        .as_ref()
        .and_then(|holders| holders.get(&mint))
    else {
        return vec![format!(
            "the Token-2022 accounts of {mint} were not copied, so balances whose owner can change are not reported (H002)"
        )];
    };
    if let Some(error) = &read.error {
        return vec![format!(
            "the Token-2022 accounts of {mint} could not be read ({error}), so balances whose owner can change are not reported (H002)"
        )];
    }
    let allowed = [home.market.vaults[home.contained], ck(&config.fee_account)];
    let holdings = classify_holdings(&mint, &read.accounts, &allowed);
    let mut warnings = vec![];
    let supply = snapshot
        .get(&mint)
        .and_then(|account| account.data.get(36..44))
        .map(|bytes| u64::from_le_bytes(bytes.try_into().unwrap()));
    if supply.map(u128::from) != Some(holdings.total) {
        warnings.push(format!(
            "the {} Token-2022 accounts of {mint} found ({}) hold {} of its supply {supply:?}, so some holders may be missing from this report (H002)",
            read.accounts.len(),
            read.source,
            holdings.total
        ));
    }
    for account in &holdings.unreadable {
        warnings.push(format!(
            "{account}, found among the accounts of {mint}, is not a token account of it"
        ));
    }
    for holding in &holdings.mutable {
        warnings.push(format!(
            "{} of {mint} is held in {}, owned by {}, which lacks ImmutableOwner: its owner can change, which the hook's rule cannot reach (H002)",
            holding.amount, holding.account, holding.owner
        ));
    }
    warnings
}

/// How the gate runs beyond its defaults: tests change the counter writer to stand in for a
/// candidate that misreads it.
#[derive(Clone, Copy)]
struct Options {
    counter: CounterWriter,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            counter: write_tax_collected,
        }
    }
}

/// The steps of the gate for one config, in a VM of its own.
fn check_config(
    snapshot: &Snapshot,
    hook: &[u8],
    tax_amm: Option<&[u8]>,
    address: Pubkey,
) -> Reading {
    check_config_with(snapshot, hook, tax_amm, address, Options::default())
}

fn check_config_with(
    snapshot: &Snapshot,
    hook: &[u8],
    tax_amm: Option<&[u8]>,
    address: Pubkey,
    options: Options,
) -> Reading {
    let mut reading = Reading {
        config: address,
        mint: None,
        contained: None,
        steps: vec![],
        warnings: vec![],
    };
    let _ = run_steps(snapshot, hook, tax_amm, &mut reading, options);
    reading
}

fn run_steps(
    snapshot: &Snapshot,
    hook: &[u8],
    tax_amm: Option<&[u8]>,
    reading: &mut Reading,
    options: Options,
) -> Result<(), ()> {
    let mut env = vm(snapshot, hook, tax_amm);
    let address = reading.config;
    let original = snapshot
        .get(&address)
        .map(|account| account.data.clone())
        .unwrap_or_default();
    let steps = &mut reading.steps;
    let config = step(steps, "decode", decode(&address, &original))?;
    reading.mint = Some(ck(&config.mint));
    reading.contained = Some(config.unlocked_at.is_none());

    if config.unlocked_at.is_some() {
        step(
            steps,
            "unlock refused",
            refused_with(send_unlock(&mut env, &config), HookError::AlreadyUnlocked),
        )?;
        return Ok(());
    }

    let home = step(steps, "home market", home(&env, &config))?;
    reading.warnings = holder_warnings(snapshot, &config, &home);
    let quote = 1 - home.contained;
    let (quote_mint, quote_program) = (home.market.mints[quote], home.market.token_programs[quote]);

    // A buy into a fresh associated token account the associated token program creates.
    let quote_decimals = env.svm.get_account(&quote_mint).unwrap().data[44];
    let amount_in = (10u64.pow(quote_decimals.into()) / 100).max(1);
    let trader = quote_trader(&mut env, &home, amount_in);
    let holding = token_2022_account(&mut env, &trader.pubkey(), &home.mint);
    let bought = {
        let result = swap(&mut env, &home, &trader, quote, amount_in, None).and_then(|swapped| {
            let balance = env.balance(&holding);
            if balance == 0 {
                return Err(format!(
                    "the swap passed but delivered nothing: {swapped:?}"
                ));
            }
            Ok((
                balance,
                format!("{amount_in} of {quote_mint} bought {balance} of the token"),
            ))
        });
        step(steps, "buy", result)?
    };

    // A buy into a keypair account of the trader's without ImmutableOwner, whose owner can
    // change, which the hook refuses to deliver to (H001).
    let other = quote_trader(&mut env, &home, amount_in);
    let mutable = second_token_account(&mut env, &other.pubkey(), &home.mint);
    step(
        steps,
        "buy into an account whose owner can change refused",
        refused_with(
            swap(&mut env, &home, &other, quote, amount_in, Some(mutable)),
            HookError::DestinationOwnerCanChange,
        ),
    )?;

    // The hook's Execute called directly, outside any transfer.
    let caller = stranger(&mut env);
    let execute = execute_instruction(
        home.market.vaults[home.contained],
        home.mint,
        holding,
        home.market.authority,
        validation_pda(&home.mint),
        address,
    );
    step(
        steps,
        "direct Execute refused",
        refused_with(
            send_as(&mut env, &caller, &[execute]),
            HookError::NotTransferring,
        ),
    )?;

    // A sell of half of it back.
    let quote_account = pda::associated_token(&trader.pubkey(), &quote_mint, &quote_program);
    let quote_before = env.balance(&quote_account);
    let fees_before = env.balance_or_zero(&ck(&config.fee_account));
    let sold = bought / 2;
    let result = swap(&mut env, &home, &trader, home.contained, sold, None).and_then(|_| {
        let received = env.balance(&quote_account) - quote_before;
        if received == 0 {
            return Err("the sell passed but delivered nothing".into());
        }
        Ok((
            (),
            format!("{sold} of the token sold for {received} of {quote_mint}"),
        ))
    });
    step(steps, "sell", result)?;

    // Where the sell pays Pipeline's fee in the token: the fee arrived in the config's fee
    // account, and the router sweeps it out with the hook tail (R2T-03).
    let result = match fee_side(&env, &home, quote) {
        client::FeeSide::Output => Ok((
            (),
            format!("not applicable: a sell pays Pipeline's fee in {quote_mint}, not in the token"),
        )),
        client::FeeSide::Input => {
            let fees = ck(&config.fee_account);
            let collected = env.balance_or_zero(&fees) - fees_before;
            if collected == 0 {
                Err(format!(
                    "the sell paid Pipeline's fee in the token, but the config's fee account {fees} received none"
                ))
            } else {
                let owner = treasury_owner(&env);
                let treasury = token_2022_account(&mut env, &owner, &home.mint);
                let held = env.balance(&fees);
                let sweep = client::sweep_fees(
                    &home.market.market,
                    &home.mint,
                    &TOKEN_2022,
                    &owner,
                    hook_tail(&home.mint),
                );
                env.send_meta(&[sweep], &[])
                    .map_err(|failure| format!("sweep_fees refused with {}", error_name(&failure)))
                    .and_then(|_| {
                        if env.balance(&fees) != 0 || env.balance(&treasury) != held {
                            return Err(format!(
                                "sweep_fees left {} in the fee account and moved {} of {held}",
                                env.balance(&fees),
                                env.balance(&treasury)
                            ));
                        }
                        Ok((
                            (),
                            format!("the sell paid {collected} of the token into the fee account; sweep_fees moved all {held} to the treasury"),
                        ))
                    })
            }
        }
    };
    step(steps, "fee account", result)?;

    // A wallet-to-wallet transfer, which the hook refuses.
    let friend = stranger(&mut env);
    let friend_account = token_2022_account(&mut env, &friend.pubkey(), &home.mint);
    let transfer = transfer_instruction(&home, &holding, &friend_account, &trader.pubkey(), 1);
    step(
        steps,
        "wallet-to-wallet transfer refused",
        refused_with(
            env.send_meta(&[transfer], &[&trader]),
            HookError::TransferRefused,
        ),
    )?;

    // `unlock` before it is due.
    let state = env.svm.get_account(&home.market.market_state).unwrap();
    let collected = (state.owner == ck(&containment_hook::config::TAX_AMM_PROGRAM_ID))
        .then(|| tax_market::tax_collected(&state.data))
        .flatten();
    let due = terms::unlock_due(
        collected,
        config.unlock_goal,
        now(&env),
        config.unlock_deadline,
    );
    let result = match due {
        None => refused_with(send_unlock(&mut env, &config), HookError::UnlockNotDue),
        Some(by) => Ok((
            (),
            format!("already due by the {by:?} ({collected:?} of {} collected, deadline {}), so not tried", config.unlock_goal, config.unlock_deadline),
        )),
    };
    step(steps, "unlock refused before it is due", result)?;

    // In fresh VMs, the goal path: one below the goal is not due before the deadline, the
    // goal itself unlocks, and says so (R2T-02).
    let goal = u128::from(config.unlock_goal);
    let result = if snapshot.unix_timestamp >= config.unlock_deadline {
        Ok((
            (),
            format!(
                "not tried: the deadline {} has passed, so one below the goal unlocks by it",
                config.unlock_deadline
            ),
        ))
    } else if goal == 0 {
        Err("the config's goal is zero".to_string())
    } else {
        unlock_at_count(snapshot, hook, tax_amm, &config, options.counter, goal - 1)
            .and_then(|(_, result)| refused_with(result, HookError::UnlockNotDue))
            .map(|(value, said)| {
                (
                    value,
                    format!("{said} with {} of {goal} collected", goal - 1),
                )
            })
    };
    step(steps, "unlock refused one below the goal", result)?;
    let result = unlock_at_count(snapshot, hook, tax_amm, &config, options.counter, goal).and_then(
        |(env, result)| {
            let meta =
                result.map_err(|failure| format!("refused with {}", error_name(&failure)))?;
            let said = format!("Unlocked by the goal: {goal} of {goal} collected");
            if !meta.logs.iter().any(|line| line.ends_with(&said)) {
                return Err(format!("unlocked, but the logs do not say \"{said}\""));
            }
            check_unlocked(&env, &address, &original, &config, snapshot.unix_timestamp)?;
            Ok((
                (),
                format!("{said}; both hook fields cleared, the config changed only by unlocked_at"),
            ))
        },
    );
    step(steps, "unlock by the goal", result)?;

    // `unlock` at the deadline.
    let at = now(&env).max(config.unlock_deadline);
    warp_to(&mut env, at);
    let result = send_unlock(&mut env, &config)
        .map_err(|failure| format!("refused with {}", error_name(&failure)))
        .and_then(|_| {
            check_unlocked(&env, &address, &original, &config, at)?;
            Ok(((), format!("unlocked at {at}, both hook fields cleared, the config changed only by unlocked_at")))
        });
    step(steps, "unlock at the deadline", result)?;
    Ok(())
}

/// The tax AMM program id compiled into the hook, against `records.devnet`'s when the
/// snapshot is devnet's (H072); elsewhere there is no record to compare with.
fn tax_amm_id_check(snapshot: &Snapshot, records: &Records) -> Step {
    let compiled = ck(&containment_hook::config::TAX_AMM_PROGRAM_ID);
    let outcome = if snapshot.is_devnet() {
        let recorded = records.devnet["programs"]["tax-amm"]["programId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if recorded == compiled.to_string() {
            Ok(format!("{compiled}, as deployments/devnet.json records"))
        } else {
            Err(format!(
                "the hook is built for the tax AMM {compiled}, but deployments/devnet.json records {recorded:?}"
            ))
        }
    } else {
        Ok(format!("{compiled} (not devnet, so no record to compare)"))
    };
    Step {
        name: "tax AMM program id",
        outcome,
    }
}

/// What the repository records about devnet, which the gate holds a devnet snapshot to.
#[derive(Clone)]
struct Records {
    /// `deployments/devnet.json`.
    devnet: serde_json::Value,
    /// The mints `deployments/devnet-demo-containment-hook.json` launched.
    demo_mints: Vec<Pubkey>,
    /// The configs of the committed fixture, `tests/fixtures/release-gate/devnet/`.
    fixture_configs: Vec<Pubkey>,
}

fn repo_file(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

impl Records {
    fn committed() -> Records {
        let demo = read_json(&repo_file("deployments/devnet-demo-containment-hook.json")).unwrap();
        let demo_mints = demo["record"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row[0] == "mint")
            .map(|row| row[1].as_str().unwrap().parse().unwrap())
            .collect();
        let manifest = read_json(&fixture().join(MANIFEST_FILE)).unwrap();
        Records {
            devnet: read_json(&repo_file("deployments/devnet.json")).unwrap(),
            demo_mints,
            fixture_configs: keys(&manifest, "configs").unwrap(),
        }
    }
}

/// The census checks' explicit exceptions, each naming why (R2T-01).
#[derive(Clone, Default)]
struct Overrides {
    /// Lets a deployed hook with no config at all pass.
    allow_empty: Option<String>,
    /// Lets a devnet snapshot miss configs of the fixture or mints of the demo record.
    allow_fewer: Option<String>,
}

/// The census of the snapshot, checked (R2T-01, R2T-04, R2T-05).
fn census_steps(snapshot: &Snapshot, records: &Records, overrides: &Overrides) -> Vec<Step> {
    let mut steps = vec![];
    let hook = hook_id();
    steps.push(Step {
        name: "program id",
        outcome: if snapshot.program == hook {
            Ok(format!("the snapshot is of {hook}, the build's declare_id!"))
        } else {
            Err(format!(
                "the snapshot is of {}, but the build under test is the hook {hook} (its declare_id!)",
                snapshot.program
            ))
        },
    });

    let mut problems = vec![];
    let mut mints = vec![];
    for config in &snapshot.configs {
        match snapshot.get(config) {
            None => problems.push(format!(
                "the config {config} the census lists is not in the snapshot"
            )),
            Some(account)
                if account.owner != hook
                    || account.data.len() != Config::SPACE
                    || account.data[..8] != *Config::DISCRIMINATOR =>
            {
                problems.push(format!(
                    "{config}, listed as a config, is not one of the hook's"
                ))
            }
            Some(account) => mints.push(Pubkey::new_from_array(
                account.data[9..41].try_into().unwrap(),
            )),
        }
    }
    let expected: Vec<Pubkey> = mints.iter().map(validation_pda).collect();
    for validation in &snapshot.validation_accounts {
        match snapshot.get(validation) {
            None => problems.push(format!(
                "the validation account {validation} the census lists is not in the snapshot"
            )),
            Some(account) if account.owner != hook || account.data.len() != VALIDATION_LEN => {
                problems.push(format!(
                    "{validation}, listed as a validation account, is not one of the hook's"
                ))
            }
            Some(_) if !expected.contains(validation) => problems.push(format!(
                "the validation account {validation} belongs to no config"
            )),
            Some(_) => {}
        }
    }
    for (validation, mint) in expected.iter().zip(&mints) {
        if !snapshot.validation_accounts.contains(validation) {
            problems.push(format!(
                "the config of mint {mint} has no validation account at {validation}"
            ));
        }
    }
    for (address, account) in &snapshot.accounts {
        if account.owner == hook
            && !snapshot.configs.contains(address)
            && !snapshot.validation_accounts.contains(address)
        {
            problems.push(format!(
                "{address}, owned by the hook, is not in the census"
            ));
        }
    }
    steps.push(Step {
        name: "census",
        outcome: if problems.is_empty() {
            Ok(format!(
                "{} configs and {} validation accounts, paired, and no other hook account",
                snapshot.configs.len(),
                snapshot.validation_accounts.len()
            ))
        } else {
            Err(problems.join("; "))
        },
    });

    steps.push(Step {
        name: "configs found",
        outcome: match (&overrides.allow_empty, snapshot.deployed, snapshot.configs.len()) {
            (_, false, 0) => Ok("the hook is not deployed yet and holds no config".into()),
            (Some(why), true, 0) => Ok(format!("no config, allowed by HOOK_GATE_ALLOW_EMPTY: {why}")),
            (None, true, 0) => Err(format!(
                "the hook is deployed on {} but the census found no config; an RPC that answered with an empty list must not pass the gate (set HOOK_GATE_ALLOW_EMPTY to why, if the cluster really holds none)",
                snapshot.url
            )),
            (_, _, count) => Ok(format!("{count} configs")),
        },
    });

    if snapshot.is_devnet() {
        let mut problems = vec![];
        let recorded_hook = records.devnet["programs"]["containment-hook"]["programId"].as_str();
        if recorded_hook == Some(hook.to_string().as_str()) && !snapshot.deployed {
            problems.push(format!(
                "deployments/devnet.json records the hook {hook}, but the snapshot read it as not deployed"
            ));
        }
        let mut fewer = vec![];
        for config in &records.fixture_configs {
            if !snapshot.configs.contains(config) {
                fewer.push(format!(
                    "the config {config} of the committed fixture is missing"
                ));
            }
        }
        for mint in &records.demo_mints {
            if !mints.contains(mint) {
                fewer.push(format!("the demo mint {mint} of deployments/devnet-demo-containment-hook.json has no config"));
            }
        }
        let allowed = match (&overrides.allow_fewer, fewer.is_empty()) {
            (Some(why), false) => format!(
                " (missing, allowed by HOOK_GATE_ALLOW_FEWER: {why}: {})",
                fewer.join("; ")
            ),
            (None, false) => {
                problems.extend(fewer);
                String::new()
            }
            (_, true) => String::new(),
        };
        steps.push(Step {
            name: "devnet records",
            outcome: if problems.is_empty() {
                Ok(format!(
                    "every config of the fixture ({}) and every demo mint ({}) is there, and the recorded hook is deployed{allowed}",
                    records.fixture_configs.len(),
                    records.demo_mints.len()
                ))
            } else {
                Err(problems.join("; "))
            },
        });
    }
    steps
}

/// A fresh mint bound to a fresh home market on the router with the candidate, and seeded
/// through the hook tail as the launch script does (R2T-03).
fn bind_fresh_mint(hook: &[u8], tax_amm: Option<&[u8]>) -> Step {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut env = Env::new();
        if let Some(program) = tax_amm {
            env.svm.add_program(strategy_id(), program).unwrap();
        }
        env.svm.add_program(hook_id(), hook).unwrap();
        let launched = launch(&mut env);
        (env, launched)
    }))
    .map_err(|panic| {
        let why = panic
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        format!("the launch failed: {}", error_name(&why))
    })
    .and_then(|(env, launched)| {
        let bound = config(&env, &launched.mint);
        let hook_fields = mint_hook(&env, &launched.mint);
        let expected = Some(TransferHook {
            authority: Some(unlock_pda(&launched.mint).to_bytes()),
            program: Some(hook_id().to_bytes()),
        });
        if bound.unlocked_at.is_some()
            || ck(&bound.market) != launched.market.market
            || hook_fields != expected
        {
            return Err(format!(
                "bound, but the config is {bound:?} and the mint's hook fields {hook_fields:?}"
            ));
        }
        Ok(format!(
            "the fresh mint {} bound to its home market {} and seeded through the hook",
            launched.mint, launched.market.market
        ))
    });
    Step {
        name: "bind a fresh mint",
        outcome,
    }
}

/// The gate's whole reading of a snapshot with `hook`, and `tax_amm` when given.
struct Gate {
    census: Vec<Step>,
    tax_amm_id: Step,
    bind: Step,
    readings: Vec<Reading>,
}

impl Gate {
    fn failures(&self) -> Vec<String> {
        let mut failures: Vec<String> = self
            .census
            .iter()
            .chain([&self.tax_amm_id, &self.bind])
            .filter_map(Step::failure)
            .collect();
        for reading in &self.readings {
            failures.extend(reading.failures());
        }
        failures
    }

    fn census_step(&self, name: &str) -> &Step {
        self.census
            .iter()
            .find(|step| step.name == name)
            .unwrap_or_else(|| panic!("no census step {name}: {:#?}", self.census))
    }
}

fn gate(snapshot: &Snapshot, hook: &[u8], tax_amm: Option<&[u8]>) -> Gate {
    gate_with(
        snapshot,
        hook,
        tax_amm,
        &Records::committed(),
        &Overrides::default(),
        Options::default(),
    )
}

fn gate_with(
    snapshot: &Snapshot,
    hook: &[u8],
    tax_amm: Option<&[u8]>,
    records: &Records,
    overrides: &Overrides,
    options: Options,
) -> Gate {
    Gate {
        census: census_steps(snapshot, records, overrides),
        tax_amm_id: tax_amm_id_check(snapshot, records),
        bind: bind_fresh_mint(hook, tax_amm),
        readings: snapshot
            .configs()
            .into_iter()
            .map(|config| check_config_with(snapshot, hook, tax_amm, config, options))
            .collect(),
    }
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

/// The steps of a contained config's reading, in order.
const CONTAINED_STEPS: [&str; 12] = [
    "decode",
    "home market",
    "buy",
    "buy into an account whose owner can change refused",
    "direct Execute refused",
    "sell",
    "fee account",
    "wallet-to-wallet transfer refused",
    "unlock refused before it is due",
    "unlock refused one below the goal",
    "unlock by the goal",
    "unlock at the deadline",
];

/// The build under test serves every config devnet held on 2026-11-23: each of the three
/// contained tokens trades, refuses a buy into an account whose owner can change, a direct
/// `Execute` and a wallet-to-wallet transfer, unlocks by its goal and at its deadline, and
/// each of the three unlocked ones stays unlocked; a fresh mint binds.
#[test]
fn sos_h011_the_build_serves_every_devnet_config() {
    let snapshot = snapshot(&fixture());
    let gate = gate(&snapshot, &hook_so(), None);
    let failures = gate.failures();
    assert!(failures.is_empty(), "{failures:#?}");
    let contained: Vec<_> = gate
        .readings
        .iter()
        .filter(|reading| reading.contained == Some(true))
        .collect();
    assert_eq!(gate.readings.len(), 6, "devnet's six configs");
    assert_eq!(contained.len(), 3, "three of them still contained");
    for reading in contained {
        let names: Vec<_> = reading.steps.iter().map(|step| step.name).collect();
        assert_eq!(names, CONTAINED_STEPS, "{reading:#?}");
    }
}

/// The gate refuses a build whose `Config` no longer fits the deployed build's accounts.
/// The one-byte-larger `Config` of H011 is shown here from the other side: a contained
/// config one byte shorter than the build's `Config` still decodes and trades, but `unlock`
/// can't write it back, which only the gate's unlock catches.
#[test]
fn sos_h011_the_gate_refuses_a_config_the_build_cant_write_back() {
    let mut snapshot = snapshot(&fixture());
    let contained = snapshot
        .configs()
        .into_iter()
        .find(|address| snapshot.account(address).data[228] == 0)
        .expect("a contained config");
    snapshot.account_mut(&contained).data.pop();
    let reading = check_config(&snapshot, &hook_so(), None, contained);
    let outcome = |name: &str| {
        reading
            .step(name)
            .unwrap_or_else(|| panic!("no step {name}: {reading:#?}"))
            .outcome
            .clone()
    };
    assert!(outcome("buy").is_ok(), "{reading:#?}");
    assert!(outcome("sell").is_ok(), "{reading:#?}");
    let unlock = outcome("unlock by the goal").expect_err("the unlock must fail");
    assert!(unlock.contains("AccountDidNotSerialize"), "{unlock}");
}

/// H072: the tax AMM compiled into the hook is the one deployed on devnet.
#[test]
fn sos_h072_the_hooks_tax_amm_is_devnets() {
    let step = tax_amm_id_check(&snapshot(&fixture()), &Records::committed());
    assert!(step.outcome.is_ok(), "{step:?}");
}

/// The fixture's first contained config whose deadline is still ahead of the snapshot.
fn contained_before_its_deadline(snapshot: &Snapshot) -> Pubkey {
    snapshot
        .configs()
        .into_iter()
        .find(|address| {
            let config = Config::try_deserialize(&mut &snapshot.account(address).data[..]).unwrap();
            config.unlocked_at.is_none() && config.unlock_deadline > snapshot.unix_timestamp
        })
        .expect("a contained config before its deadline")
}

/// R2T-01: a snapshot whose census lists a config it does not hold, as a partial or failed
/// read leaves it, is refused; and one whose census itself misses a config devnet held is
/// refused against the committed fixture, unless an override names why.
#[test]
fn sos_r2t01_the_gate_refuses_a_snapshot_missing_a_config() {
    let full = snapshot(&fixture());
    let records = Records::committed();
    let census = |snapshot: &Snapshot, overrides: &Overrides| Gate {
        census: census_steps(snapshot, &records, overrides),
        tax_amm_id: tax_amm_id_check(snapshot, &records),
        bind: Step {
            name: "bind a fresh mint",
            outcome: Ok(String::new()),
        },
        readings: vec![],
    };
    let whole = census(&full, &Overrides::default());
    assert!(whole.failures().is_empty(), "{:#?}", whole.census);

    // The census lists six configs; one of their files is gone.
    let dropped = full.configs[0];
    let mut missing_file = full.clone();
    missing_file
        .accounts
        .retain(|(address, _)| *address != dropped);
    let gate = census(&missing_file, &Overrides::default());
    let why = gate
        .census_step("census")
        .outcome
        .clone()
        .expect_err("refused");
    assert!(
        why.contains(&format!(
            "the config {dropped} the census lists is not in the snapshot"
        )),
        "{why}"
    );

    // An RPC that answered with five of the six: the census and its files agree, but devnet
    // held six.
    let mut partial = missing_file.clone();
    let mint = Config::try_deserialize(&mut &full.account(&dropped).data[..])
        .unwrap()
        .mint;
    let validation = validation_pda(&ck(&mint));
    partial.configs.retain(|address| *address != dropped);
    partial
        .validation_accounts
        .retain(|address| *address != validation);
    partial
        .accounts
        .retain(|(address, _)| *address != validation);
    let gate = census(&partial, &Overrides::default());
    assert!(
        gate.census_step("census").outcome.is_ok(),
        "{:#?}",
        gate.census
    );
    let why = gate
        .census_step("devnet records")
        .outcome
        .clone()
        .expect_err("refused");
    assert!(
        why.contains(&format!(
            "the config {dropped} of the committed fixture is missing"
        )),
        "{why}"
    );
    let allowed = census(
        &partial,
        &Overrides {
            allow_fewer: Some("the config was closed on purpose".into()),
            ..Overrides::default()
        },
    );
    assert!(allowed.failures().is_empty(), "{:#?}", allowed.census);

    // A hook-owned account the census does not list.
    let mut unlisted = full.clone();
    unlisted.configs.retain(|address| *address != dropped);
    let why = census(&unlisted, &Overrides::default())
        .census_step("census")
        .outcome
        .clone()
        .expect_err("refused");
    assert!(
        why.contains(&format!(
            "{dropped}, owned by the hook, is not in the census"
        )),
        "{why}"
    );
}

/// R2T-01: a snapshot of another program than the build's own id is refused, by the
/// manifest's program and by the `--program` `pre-deploy.sh` passed.
#[test]
fn sos_r2t01_the_gate_refuses_another_program_id() {
    let mut other = snapshot(&fixture());
    other.program = strategy_id();
    let steps = census_steps(&other, &Records::committed(), &Overrides::default());
    let program = steps.iter().find(|step| step.name == "program id").unwrap();
    let why = program.outcome.clone().expect_err("refused");
    assert!(
        why.contains(&format!("the snapshot is of {}", strategy_id())),
        "{why}"
    );

    assert!(program_given_check(&strategy_id().to_string())
        .outcome
        .is_err());
    assert!(program_given_check(&hook_id().to_string()).outcome.is_ok());
}

/// R2T-01: a deployed hook with no config at all is refused, unless an override names why;
/// a hook not yet deployed may hold none.
#[test]
fn sos_r2t01_a_deployed_hook_with_no_config_is_refused_unless_allowed() {
    let mut empty = snapshot(&fixture());
    empty
        .accounts
        .retain(|(_, account)| account.owner != hook_id());
    empty.configs.clear();
    empty.validation_accounts.clear();
    empty.genesis_hash = "a local validator".into();
    let records = Records::committed();
    let found = |snapshot: &Snapshot, overrides: &Overrides| {
        census_steps(snapshot, &records, overrides)
            .into_iter()
            .find(|step| step.name == "configs found")
            .unwrap()
            .outcome
    };
    let why = found(&empty, &Overrides::default()).expect_err("refused");
    assert!(why.contains("the census found no config"), "{why}");
    let allowed = Overrides {
        allow_empty: Some("a fresh local validator".into()),
        ..Overrides::default()
    };
    assert!(found(&empty, &allowed).is_ok());
    empty.deployed = false;
    assert!(found(&empty, &Overrides::default()).is_ok());

    // On devnet the empty census also misses every recorded config.
    empty.genesis_hash = DEVNET_GENESIS_HASH.into();
    empty.deployed = true;
    let steps = census_steps(&empty, &records, &allowed);
    let devnet = steps
        .iter()
        .find(|step| step.name == "devnet records")
        .unwrap();
    assert!(devnet.outcome.is_err(), "{devnet:?}");
}

/// R2T-02: each contained token unlocks by its goal, and the goal step logs the goal.
#[test]
fn sos_r2t02_the_gate_unlocks_by_the_goal() {
    let snapshot = snapshot(&fixture());
    let address = contained_before_its_deadline(&snapshot);
    let reading = check_config(&snapshot, &hook_so(), None, address);
    assert!(reading.failures().is_empty(), "{reading:#?}");
    let below = reading.step("unlock refused one below the goal").unwrap();
    assert!(
        below
            .outcome
            .as_ref()
            .unwrap()
            .starts_with("refused with UnlockNotDue"),
        "{below:?}"
    );
    let goal = reading.step("unlock by the goal").unwrap();
    assert!(
        goal.outcome
            .as_ref()
            .unwrap()
            .starts_with("Unlocked by the goal: "),
        "{goal:?}"
    );
}

/// The counter written 16 bytes off the tax AMM's `tax_collected`: what a candidate that
/// reads the counter at a moved offset sees of a market that reached its goal.
fn write_counter_misread(data: &mut [u8], tax_collected: u128) -> Result<(), String> {
    let at = tax_amm::state::layout::TAX_COLLECTED + 16;
    data[at..at + 16].copy_from_slice(&tax_collected.to_le_bytes());
    Ok(())
}

/// R2T-02: a candidate that misreads the counter low passes the old gate's "not due" step,
/// but fails the goal step: the token would stay contained past its goal.
#[test]
fn sos_r2t02_the_gate_refuses_a_counter_misread() {
    let snapshot = snapshot(&fixture());
    let address = contained_before_its_deadline(&snapshot);
    let options = Options {
        counter: write_counter_misread,
    };
    let reading = check_config_with(&snapshot, &hook_so(), None, address, options);
    assert!(
        reading
            .step("unlock refused before it is due")
            .unwrap()
            .outcome
            .is_ok(),
        "{reading:#?}"
    );
    let why = reading
        .step("unlock by the goal")
        .unwrap_or_else(|| panic!("{reading:#?}"))
        .outcome
        .clone()
        .expect_err("the goal step must fail");
    assert!(why.contains("UnlockNotDue"), "{why}");
}

/// R2T-03: on a home market whose sell pays Pipeline's fee in the token (devnet's token 3,
/// quoted in its own SPL Token quote mint), the fee arrives in the config's fee account and
/// `sweep_fees` moves it out through the hook; on a wrapped SOL market the step says why it
/// does not apply. Every contained reading has the buy into an account whose owner can
/// change refused and a direct `Execute` refused.
#[test]
fn sos_r2t03_the_gate_runs_the_fee_account_and_the_refusals() {
    let snapshot = snapshot(&fixture());
    let gate = gate(&snapshot, &hook_so(), None);
    assert!(gate.bind.outcome.is_ok(), "{:?}", gate.bind);
    let contained: Vec<_> = gate
        .readings
        .iter()
        .filter(|reading| reading.contained == Some(true))
        .collect();
    let fee = |reading: &Reading| {
        reading
            .step("fee account")
            .unwrap()
            .outcome
            .clone()
            .unwrap()
    };
    assert!(
        contained
            .iter()
            .any(|reading| fee(reading).contains("sweep_fees moved all")),
        "{contained:#?}"
    );
    assert!(
        contained
            .iter()
            .any(|reading| fee(reading).starts_with("not applicable")),
        "{contained:#?}"
    );
    for reading in contained {
        for name in [
            "buy into an account whose owner can change refused",
            "direct Execute refused",
        ] {
            assert!(reading.step(name).unwrap().outcome.is_ok(), "{reading:#?}");
        }
    }
}

/// R2T-03: a candidate that cannot bind fails the gate's fresh bind.
#[test]
fn sos_r2t03_a_build_that_cannot_bind_fails_the_gate() {
    // Pipeline's constant-product test strategy stands in for a build that is no hook.
    let not_a_hook = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/pipeline/programs/target/deploy/test_strategy_cp.so"),
    )
    .expect("scripts/fetch-pipeline.sh builds test_strategy_cp.so");
    let step = bind_fresh_mint(&not_a_hook, None);
    assert!(step.outcome.is_err(), "{step:?}");
    assert!(bind_fresh_mint(&hook_so(), None).outcome.is_ok());
}

/// R2T-04: devnet is known by its genesis hash, so a snapshot read through another devnet
/// RPC is still held to `deployments/devnet.json`.
#[test]
fn sos_r2t04_devnet_is_known_by_its_genesis_hash() {
    let mut other_rpc = snapshot(&fixture());
    other_rpc.url = "https://devnet.helius-rpc.com/".into();
    assert!(other_rpc.is_devnet());
    let mut wrong = Records::committed();
    wrong.devnet["programs"]["tax-amm"]["programId"] = cp_strategy_id().to_string().into();
    let step = tax_amm_id_check(&other_rpc, &wrong);
    assert!(step.outcome.is_err(), "{step:?}");

    other_rpc.genesis_hash = "a local validator".into();
    other_rpc.url = "https://api.devnet.solana.com".into();
    assert!(
        !other_rpc.is_devnet(),
        "the URL alone does not make it devnet"
    );
}

/// A new empty folder under the system's temporary folder.
fn temp_folder(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("release-gate-{tag}-{}", Keypair::new().pubkey()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn script(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join(name)
}

/// R2T-05: an RPC that cannot be reached stops the snapshot; it is never read as "the hook is
/// not deployed".
#[test]
fn sos_r2t05_the_snapshot_stops_on_an_rpc_error() {
    let out = temp_folder("unreachable").join("snapshot");
    let run = std::process::Command::new("python3")
        .arg("-I")
        .arg(script("gate_snapshot.py"))
        .args([
            "--url",
            "http://127.0.0.1:9",
            "--program",
            &hook_id().to_string(),
            "--out",
        ])
        .arg(&out)
        .output()
        .expect("python3");
    assert!(!run.status.success(), "{run:?}");
    assert!(!out.join(MANIFEST_FILE).exists());
    std::fs::remove_dir_all(out.parent().unwrap()).unwrap();
}

/// R2T-06: the gate loads only what the manifest lists, the snapshot script and
/// `pre-deploy.sh` refuse a folder that is not empty.
#[test]
fn sos_r2t06_a_stale_snapshot_folder_is_refused() {
    let dir = temp_folder("stale");
    for entry in std::fs::read_dir(fixture()).unwrap() {
        let path = entry.unwrap().path();
        std::fs::copy(&path, dir.join(path.file_name().unwrap())).unwrap();
    }
    assert!(load_snapshot(&dir).is_ok());
    let extra = fixture().join(format!("{}.json", snapshot(&fixture()).configs[0]));
    std::fs::copy(extra, dir.join("11111111111111111111111111111111.json")).unwrap();
    let why = load_snapshot(&dir).err().expect("refused");
    assert!(why.contains("not in its manifest"), "{why}");

    let run = std::process::Command::new("python3")
        .arg("-I")
        .arg(script("gate_snapshot.py"))
        .args([
            "--url",
            "http://127.0.0.1:9",
            "--program",
            &hook_id().to_string(),
            "--out",
        ])
        .arg(&dir)
        .output()
        .expect("python3");
    assert!(!run.status.success(), "{run:?}");
    assert!(
        String::from_utf8_lossy(&run.stderr).contains("is not empty"),
        "{run:?}"
    );

    let run = std::process::Command::new("bash")
        .arg(script("pre-deploy.sh"))
        .args(["--url", "http://127.0.0.1:9", "--so"])
        .arg(script("pre-deploy.sh"))
        .args(["--program", &hook_id().to_string()])
        .env("HOOK_GATE_DIR", &dir)
        .output()
        .expect("bash");
    assert!(!run.status.success(), "{run:?}");
    assert!(
        String::from_utf8_lossy(&run.stderr).contains("is not empty"),
        "{run:?}"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

/// `pre-deploy.sh` given a relative `HOOK_GATE_DIR` passes absolute paths on: the gate's
/// `cargo test` runs from `programs/`, where a relative snapshot or report path would name
/// another folder. A stand-in `python3` records what the snapshot step was given and stops the
/// script there, before it needs a cluster.
#[test]
fn a_relative_gate_folder_is_passed_on_as_an_absolute_path() {
    let cwd = temp_folder("relative");
    let bin = cwd.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let args = cwd.join("python3-args");
    let python = bin.join("python3");
    std::fs::write(
        &python,
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$PYTHON_ARGS\"\nexit 3\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let run = std::process::Command::new("bash")
        .arg(script("pre-deploy.sh"))
        .args(["--url", "http://127.0.0.1:9", "--so"])
        .arg(script("pre-deploy.sh"))
        .args(["--program", &hook_id().to_string()])
        .current_dir(&cwd)
        .env("HOOK_GATE_DIR", "gate")
        .env("PYTHON_ARGS", &args)
        .env("PATH", path)
        .output()
        .expect("bash");
    assert_eq!(run.status.code(), Some(3), "{run:?}");
    let given = std::fs::read_to_string(&args).unwrap();
    let given: Vec<&str> = given.lines().collect();
    let out = given
        .iter()
        .position(|arg| *arg == "--out")
        .map(|i| Path::new(given[i + 1]))
        .unwrap_or_else(|| panic!("no --out in {given:?}"));
    assert!(out.is_absolute(), "--out {}", out.display());
    assert_eq!(out.file_name().unwrap(), "snapshot");
    assert_eq!(
        std::fs::canonicalize(out.parent().unwrap()).unwrap(),
        std::fs::canonicalize(cwd.join("gate")).unwrap()
    );
    std::fs::remove_dir_all(&cwd).unwrap();
}

/// H002: of a contained mint's Token-2022 accounts, the gate reports the balances in accounts
/// without `ImmutableOwner`, other than the home market's vault and fee account, and counts
/// what they all hold.
#[test]
fn sos_h002_balances_whose_owner_can_change_are_classified() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let wallet = Keypair::new().pubkey();
    let keypair_account = second_token_account(&mut env, &wallet, &launched.mint);
    // Seven tokens in it, written directly: the launch has revoked the mint authority.
    edit_account(&mut env, &keypair_account, |account| {
        account.data[64..72].copy_from_slice(&7u64.to_le_bytes());
    });
    let empty_keypair_account =
        second_token_account(&mut env, &Keypair::new().pubkey(), &launched.mint);
    let fees = fee_account(&launched.market, &launched.mint);
    let vault = launched.market.vaults[CONTAINED];
    let not_a_token_account = Pubkey::new_unique();
    let mut accounts: Vec<(Pubkey, Vec<u8>)> = [
        launched.holder,
        keypair_account,
        empty_keypair_account,
        fees,
        vault,
    ]
    .iter()
    .map(|address| (*address, env.svm.get_account(address).unwrap().data))
    .collect();
    accounts.push((not_a_token_account, vec![0; 10]));

    let holdings = classify_holdings(&launched.mint, &accounts, &[vault, fees]);

    assert_eq!(
        holdings.mutable,
        vec![MutableHolding {
            account: keypair_account,
            owner: wallet,
            amount: 7
        }]
    );
    assert_eq!(holdings.unreadable, vec![not_a_token_account]);
    assert_eq!(holdings.total, u128::from(SUPPLY) + 7);
    // The associated token account carries ImmutableOwner; the vault does not, but the hook
    // allows it by address.
    assert!(classify_holdings(&launched.mint, &accounts[..1], &[])
        .mutable
        .is_empty());
    assert_eq!(
        classify_holdings(&launched.mint, &accounts[4..5], &[])
            .mutable
            .len(),
        1
    );
}

/// H002: devnet's three contained mints, read through their transaction history, hold their
/// whole supply and nothing in an account whose owner can change, so the gate warns of
/// nothing; a snapshot without their accounts warns that it cannot tell.
#[test]
fn sos_h002_the_gate_reports_devnets_holders() {
    let mut snapshot = snapshot(&fixture());
    let gate = gate(&snapshot, &hook_so(), None);
    for reading in gate
        .readings
        .iter()
        .filter(|reading| reading.contained == Some(true))
    {
        assert!(reading.warnings.is_empty(), "{reading:#?}");
    }
    snapshot.holders = None;
    let address = contained_before_its_deadline(&snapshot);
    let reading = check_config(&snapshot, &hook_so(), None, address);
    assert_eq!(reading.warnings.len(), 1, "{reading:#?}");
    assert!(
        reading.warnings[0].contains("were not copied"),
        "{reading:#?}"
    );
}

/// The `--program` `pre-deploy.sh` gave, against the build's own id (R2T-01).
fn program_given_check(given: &str) -> Step {
    let hook = hook_id();
    Step {
        name: "program given",
        outcome: if given == hook.to_string() {
            Ok(format!("--program {given} is the build's declare_id!"))
        } else {
            Err(format!(
                "--program {given} is not the build's declare_id! {hook}; deployed there, the build would refuse every Execute and unlock"
            ))
        },
    }
}

/// With configs to serve, the gate runs the tax AMM deployed on the cluster, never the
/// harness's build (R2T-05).
fn tax_amm_given_check(snapshot: &Snapshot, given: bool) -> Step {
    Step {
        name: "deployed tax AMM given",
        outcome: match (snapshot.configs.is_empty(), given) {
            (true, _) => Ok("no config, so no home market's tax AMM to run".into()),
            (false, true) => Ok("the tax AMM the home markets run on, dumped from the cluster".into()),
            (false, false) => Err(
                "the snapshot holds configs but no deployed tax AMM (tax_amm_deployed.so); the gate would run them against the harness's build"
                    .into(),
            ),
        },
    }
}

/// `Config`'s v1 layout, byte for byte. It is frozen (H011): every build that serves
/// existing bindings must read and write exactly these bytes, since configs are never
/// reallocated and `unlock` writes the whole struct back into the 237 bytes `bind` made.
/// New state goes in a new account, never in `Config`.
mod v1 {
    pub const VERSION: usize = 8;
    pub const MINT: usize = 9;
    pub const MARKET: usize = 41;
    pub const MARKET_STATE: usize = 73;
    pub const VAULT: usize = 105;
    pub const FEE_ACCOUNT: usize = 137;
    pub const QUOTE_MINT: usize = 169;
    pub const UNLOCK_GOAL: usize = 201;
    pub const UNLOCK_DEADLINE: usize = 209;
    pub const BOUND_AT: usize = 217;
    pub const CONFIG_BUMP: usize = 225;
    pub const EXTRA_ACCOUNT_METAS_BUMP: usize = 226;
    pub const UNLOCK_BUMP: usize = 227;
    pub const UNLOCKED_AT_TAG: usize = 228;
    pub const UNLOCKED_AT: usize = 229;
    pub const LEN: usize = 237;
    /// `sha256("account:Config")[..8]`.
    pub const DISCRIMINATOR: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];
}

/// Fails unless `data` holds `config` at the v1 offsets.
fn assert_v1_bytes(data: &[u8], config: &Config) {
    let key = |at: usize| &data[at..at + 32];
    let int = |at: usize| <[u8; 8]>::try_from(&data[at..at + 8]).unwrap();
    assert_eq!(data[..8], v1::DISCRIMINATOR);
    assert_eq!(data[v1::VERSION], config.version);
    assert_eq!(key(v1::MINT), config.mint.as_ref());
    assert_eq!(key(v1::MARKET), config.market.as_ref());
    assert_eq!(key(v1::MARKET_STATE), config.market_state.as_ref());
    assert_eq!(key(v1::VAULT), config.vault.as_ref());
    assert_eq!(key(v1::FEE_ACCOUNT), config.fee_account.as_ref());
    assert_eq!(key(v1::QUOTE_MINT), config.quote_mint.as_ref());
    assert_eq!(u64::from_le_bytes(int(v1::UNLOCK_GOAL)), config.unlock_goal);
    assert_eq!(
        i64::from_le_bytes(int(v1::UNLOCK_DEADLINE)),
        config.unlock_deadline
    );
    assert_eq!(i64::from_le_bytes(int(v1::BOUND_AT)), config.bound_at);
    assert_eq!(data[v1::CONFIG_BUMP], config.config_bump);
    assert_eq!(
        data[v1::EXTRA_ACCOUNT_METAS_BUMP],
        config.extra_account_metas_bump
    );
    assert_eq!(data[v1::UNLOCK_BUMP], config.unlock_bump);
    match config.unlocked_at {
        None => {
            assert_eq!(data[v1::UNLOCKED_AT_TAG], 0);
            assert!(data[v1::UNLOCKED_AT..].iter().all(|&byte| byte == 0));
        }
        Some(at) => {
            assert_eq!(data[v1::UNLOCKED_AT_TAG], 1);
            assert_eq!(i64::from_le_bytes(int(v1::UNLOCKED_AT)), at);
        }
    }
}

/// The v1 layout of `Config` is pinned: a config of distinct field values serialises to
/// exactly these bytes, 237 with the discriminator, and every real config in the devnet
/// fixture decodes at these offsets.
#[test]
fn config_v1_bytes_are_pinned() {
    use anchor_lang::prelude::Pubkey as Key;
    use sha2::Digest;
    assert_eq!(
        sha2::Sha256::digest(b"account:Config")[..8],
        v1::DISCRIMINATOR
    );
    assert_eq!(*Config::DISCRIMINATOR, v1::DISCRIMINATOR);
    assert_eq!(Config::SPACE, v1::LEN);
    assert_eq!(containment_hook::state::CONFIG_VERSION, 1);

    let config = Config {
        version: 1,
        mint: Key::new_from_array([0x11; 32]),
        market: Key::new_from_array([0x22; 32]),
        market_state: Key::new_from_array([0x33; 32]),
        vault: Key::new_from_array([0x44; 32]),
        fee_account: Key::new_from_array([0x55; 32]),
        quote_mint: Key::new_from_array([0x66; 32]),
        unlock_goal: 0x0807_0605_0403_0201,
        unlock_deadline: 0x1817_1615_1413_1211,
        bound_at: 0x2827_2625_2423_2221,
        config_bump: 0xf1,
        extra_account_metas_bump: 0xf2,
        unlock_bump: 0xf3,
        unlocked_at: Some(0x3837_3635_3433_3231),
    };
    let mut bytes = vec![];
    config.try_serialize(&mut bytes).unwrap();
    assert_eq!(bytes.len(), v1::LEN);
    let mut expected = v1::DISCRIMINATOR.to_vec();
    expected.push(1);
    for fill in [0x11, 0x22, 0x33, 0x44, 0x55, 0x66] {
        expected.extend([fill; 32]);
    }
    for start in [0x01u8, 0x11, 0x21] {
        expected.extend((start..start + 8).collect::<Vec<u8>>());
    }
    expected.extend([0xf1, 0xf2, 0xf3, 1]);
    expected.extend((0x31u8..0x39).collect::<Vec<u8>>());
    assert_eq!(bytes, expected);
    assert_v1_bytes(&bytes, &config);

    let contained = Config {
        unlocked_at: None,
        ..config
    };
    let mut bytes = vec![];
    contained.try_serialize(&mut bytes).unwrap();
    assert_eq!(
        bytes.len(),
        v1::UNLOCKED_AT,
        "a contained config leaves 8 spare bytes"
    );
    let mut expected_contained = expected[..v1::UNLOCKED_AT].to_vec();
    expected_contained[v1::UNLOCKED_AT_TAG] = 0;
    assert_eq!(bytes, expected_contained);

    let snapshot = snapshot(&fixture());
    let configs = snapshot.configs();
    assert_eq!(configs.len(), 6, "devnet's six configs");
    for address in configs {
        let data = &snapshot.account(&address).data;
        assert_eq!(data.len(), v1::LEN);
        let config = Config::try_deserialize(&mut &data[..]).unwrap();
        assert_v1_bytes(data, &config);
        let mint = ck(&config.mint);
        assert_eq!(address, config_pda(&mint));
        let bump = |seed: &[u8]| Pubkey::find_program_address(&[seed, mint.as_ref()], &hook_id()).1;
        assert_eq!(config.config_bump, bump(b"config"));
        assert_eq!(
            config.extra_account_metas_bump,
            bump(b"extra-account-metas")
        );
        assert_eq!(config.unlock_bump, bump(b"unlock"));
    }
}

/// The live gate, which `scripts/pre-deploy.sh` runs on a fresh copy of the cluster's
/// bindings (see the module's docs for its environment variables). It writes what it read
/// to `HOOK_GATE_REPORT` when that is set, then fails if any step failed.
#[test]
#[ignore = "run by scripts/pre-deploy.sh on a copy of the cluster's bindings"]
fn the_release_gate_passes_the_candidate_on_the_clusters_configs() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
    let set = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let optional = |name: &str| {
        set(name).map(|path| std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
    };
    let snapshot = snapshot(Path::new(&var("HOOK_GATE_SNAPSHOT")));
    let candidate = std::fs::read(var("HOOK_GATE_CANDIDATE")).unwrap();
    let program = var("HOOK_GATE_PROGRAM");
    let tax_amm = optional("HOOK_GATE_TAX_AMM");
    let deployed = optional("HOOK_GATE_DEPLOYED");
    let overrides = Overrides {
        allow_empty: set("HOOK_GATE_ALLOW_EMPTY"),
        allow_fewer: set("HOOK_GATE_ALLOW_FEWER"),
    };
    let mut gate = gate_with(
        &snapshot,
        &candidate,
        tax_amm.as_deref(),
        &Records::committed(),
        &overrides,
        Options::default(),
    );
    gate.census.push(program_given_check(&program));
    gate.census
        .push(tax_amm_given_check(&snapshot, tax_amm.is_some()));
    let failures = gate.failures();
    for step in gate.census.iter().chain([&gate.tax_amm_id, &gate.bind]) {
        println!("{step:?}");
    }
    for reading in &gate.readings {
        println!("{reading:?}");
        for warning in &reading.warnings {
            println!("warning: {warning}");
        }
    }
    if let Ok(path) = std::env::var("HOOK_GATE_REPORT") {
        let record = serde_json::json!({
            "cluster": snapshot.url,
            "genesis_hash": snapshot.genesis_hash,
            "program": snapshot.program.to_string(),
            "slot": snapshot.slot,
            "unix_timestamp": snapshot.unix_timestamp,
            "candidate": executable_hash(&candidate),
            "deployed": deployed.as_deref().map(executable_hash),
            "tax_amm": executable_hash(&tax_amm.unwrap_or_else(strategy_so)),
            "overrides": {
                "allow_empty": overrides.allow_empty,
                "allow_fewer": overrides.allow_fewer,
            },
            "census": gate.census.iter().map(Step::report).collect::<Vec<_>>(),
            "tax_amm_program_id": gate.tax_amm_id.report(),
            "bind": gate.bind.report(),
            "passed": failures.is_empty(),
            "configs": gate.readings.iter().map(Reading::report).collect::<Vec<_>>(),
        });
        std::fs::write(&path, serde_json::to_string_pretty(&record).unwrap() + "\n").unwrap();
    }
    assert!(
        failures.is_empty(),
        "the candidate strands a contained token:\n{}",
        failures.join("\n")
    );
    println!(
        "the candidate served all {} configs ({} still contained)",
        gate.readings.len(),
        gate.readings
            .iter()
            .filter(|reading| reading.contained == Some(true))
            .count()
    );
}
