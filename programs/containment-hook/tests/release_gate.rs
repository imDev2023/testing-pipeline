//! The containment hook's release gate (hardening finding H011, #74): before a new build
//! replaces the one deployed, it must serve every config the deployed build wrote, so a
//! redeploy strands no contained token. Tokens contained before it must still trade in their
//! home market and still unlock; appending even one byte to `Config` would keep trading
//! working but make every `unlock` fail, which nothing else would notice until a deadline.
//!
//! `scripts/gate_snapshot.py` copies every hook config on a cluster with the accounts its
//! binding names (the mint, the validation account, the router `Market`, the market state,
//! both mints and vaults and both fee accounts) and the cluster's clock into a folder. The
//! gate loads them into LiteSVM with the build under test, after the router's own setup
//! ([`Env::new`]), its clock at the snapshot's slot and Unix time, and for every config:
//!
//! - the candidate's `Config` decodes the bytes and serialises them back identically;
//! - for each token still contained: a router buy into a fresh associated token account the
//!   associated token program creates, a sell of part of it back, a wallet-to-wallet
//!   `transfer_checked` refused by the hook with `TransferRefused`, `unlock` refused with
//!   `UnlockNotDue` unless it is already due, then, with the clock at its deadline, `unlock`
//!   succeeds, both of the mint's hook fields are cleared and the config is unchanged but for
//!   `unlocked_at`;
//! - for each token already unlocked: `unlock` refused with `AlreadyUnlocked`.
//!
//! On devnet it also checks that the tax AMM compiled into the hook
//! (`containment_hook::config::TAX_AMM_PROGRAM_ID`) is the one `deployments/devnet.json`
//! records (H072).
//!
//! - In every `cargo test`, the gate runs the build under test, with the tax AMM build the
//!   harness loads, against `tests/fixtures/release-gate/devnet/`, devnet's six configs copied
//!   on 2026-11-23, three of them still contained.
//! - `scripts/pre-deploy.sh`, which `scripts/deploy-devnet.sh` runs on the very bytes it is
//!   about to deploy, copies the cluster afresh and runs
//!   [`the_release_gate_passes_the_candidate_on_the_clusters_configs`] on it:
//!
//! ```sh
//! HOOK_GATE_SNAPSHOT=<dir> HOOK_GATE_CANDIDATE=<containment_hook.so> \
//!   [HOOK_GATE_TAX_AMM=<dir>/tax_amm_deployed.so] [HOOK_GATE_DEPLOYED=<dir>/deployed.so] \
//!   [HOOK_GATE_REPORT=<report.json>] \
//!   cargo test -p containment-hook --test release_gate -- --ignored
//! ```
//!
//! The v1 layout of `Config` is frozen (H011): [`config_v1_bytes_are_pinned`] pins it.

mod support;

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
const CLOCK_FILE: &str = "clock.json";
const MISSING_FILE: &str = "missing.json";

/// A copy of a cluster's bindings, as `scripts/gate_snapshot.py` writes it.
struct Snapshot {
    accounts: Vec<(Pubkey, solana_account::Account)>,
    slot: u64,
    unix_timestamp: i64,
    url: String,
}

fn read_json(path: &Path) -> serde_json::Value {
    serde_json::from_str(
        &std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Every account in a snapshot folder (the solana CLI's account JSON, one file each) and the
/// cluster's clock when they were read.
fn snapshot(dir: &Path) -> Snapshot {
    let mut accounts = vec![];
    for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|ext| ext != "json")
            || path.ends_with(CLOCK_FILE)
            || path.ends_with(MISSING_FILE)
        {
            continue;
        }
        let record = read_json(&path);
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
    accounts.sort_by_key(|(address, _)| *address);
    let clock = read_json(&dir.join(CLOCK_FILE));
    Snapshot {
        accounts,
        slot: clock["slot"].as_u64().expect("a slot"),
        unix_timestamp: clock["unix_timestamp"].as_i64().expect("a Unix time"),
        url: clock["url"]
            .as_str()
            .expect("the cluster's URL")
            .to_string(),
    }
}

impl Snapshot {
    /// The hook configs in the snapshot: accounts the hook owns, of a v1 config's size,
    /// carrying the `Config` discriminator.
    fn configs(&self) -> Vec<Pubkey> {
        self.accounts
            .iter()
            .filter(|(_, account)| {
                account.owner == hook_id()
                    && account.data.len() == Config::SPACE
                    && account.data[..8] == *Config::DISCRIMINATOR
            })
            .map(|(address, _)| *address)
            .collect()
    }

    fn account(&self, address: &Pubkey) -> &solana_account::Account {
        &self
            .accounts
            .iter()
            .find(|(key, _)| key == address)
            .unwrap_or_else(|| panic!("{address} is not in the snapshot"))
            .1
    }

    fn is_devnet(&self) -> bool {
        self.url.contains("api.devnet.solana.com")
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
#[derive(Debug)]
struct Step {
    name: &'static str,
    outcome: Result<String, String>,
}

/// What the gate saw of one config.
#[derive(Debug)]
struct Reading {
    config: Pubkey,
    mint: Option<Pubkey>,
    contained: Option<bool>,
    steps: Vec<Step>,
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

    fn report(&self) -> serde_json::Value {
        serde_json::json!({
            "config": self.config.to_string(),
            "mint": self.mint.map(|mint| mint.to_string()),
            "state": match self.contained {
                Some(true) => "contained",
                Some(false) => "unlocked",
                None => "unreadable",
            },
            "steps": self.steps.iter().map(|step| serde_json::json!({
                "step": step.name,
                "passed": step.outcome.is_ok(),
                "result": match &step.outcome { Ok(said) | Err(said) => said },
            })).collect::<Vec<_>>(),
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
fn refused_with(
    result: Result<TransactionMetadata, String>,
    error: HookError,
) -> Result<((), String), String> {
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

/// The router's exact-in `swap` of `amount_in` from side `input` to the other side of the
/// home market, as a terminal builds it: the tax AMM's resolved accounts, then the hook
/// accounts after them on a buy, or as the input's hook accounts on a sell.
fn swap(
    env: &mut Env,
    home: &Home,
    trader: &Keypair,
    input: usize,
    amount_in: u64,
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
        trader_output: pda::associated_token(
            &trader.pubkey(),
            &market.mints[output],
            &market.token_programs[output],
        ),
        input_vault: market.vaults[input],
        input_mint: market.mints[input],
        output_mint: market.mints[output],
        input_token_program: market.token_programs[input],
        output_token_program: market.token_programs[output],
        integrator_fee_account: None,
        strategy_accounts,
        input_hook_accounts,
    };
    let args = client::SwapArgs {
        mode: client::TradeMode::ExactIn,
        amount_in,
        amount_out: 0,
        min_amount_out: 0,
        integrator_fee_bps: 0,
        input_hook_accounts: 0,
        extra: vec![],
    };
    let meta = env.send_meta(&[client::swap(&accounts, &args)], &[trader])?;
    borsh::from_slice(&meta.return_data.data).map_err(|e| e.to_string())
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

/// The steps of the gate for one config, in a VM of its own.
fn check_config(
    snapshot: &Snapshot,
    hook: &[u8],
    tax_amm: Option<&[u8]>,
    address: Pubkey,
) -> Reading {
    let mut reading = Reading {
        config: address,
        mint: None,
        contained: None,
        steps: vec![],
    };
    let _ = run_steps(snapshot, hook, tax_amm, &mut reading);
    reading
}

fn run_steps(
    snapshot: &Snapshot,
    hook: &[u8],
    tax_amm: Option<&[u8]>,
    reading: &mut Reading,
) -> Result<(), ()> {
    let mut env = vm(snapshot, hook, tax_amm);
    let address = reading.config;
    let original = snapshot.account(&address).data.clone();
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
    let quote = 1 - home.contained;
    let (quote_mint, quote_program) = (home.market.mints[quote], home.market.token_programs[quote]);

    // A buy into a fresh associated token account the associated token program creates.
    let trader = stranger(&mut env);
    let quote_decimals = env.svm.get_account(&quote_mint).unwrap().data[44];
    let amount_in = (10u64.pow(quote_decimals.into()) / 100).max(1);
    // Twice the buy, since Pipeline's fee on a buy is taken in the quote mint on top of it.
    env.write_token_account(&quote_mint, &quote_program, &trader.pubkey(), 2 * amount_in);
    let holding = token_2022_account(&mut env, &trader.pubkey(), &home.mint);
    let bought = {
        let result = swap(&mut env, &home, &trader, quote, amount_in).and_then(|swapped| {
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

    // A sell of half of it back.
    let quote_account = pda::associated_token(&trader.pubkey(), &quote_mint, &quote_program);
    let quote_before = env.balance(&quote_account);
    let sold = bought / 2;
    let result = swap(&mut env, &home, &trader, home.contained, sold).and_then(|_| {
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

    // `unlock` at the deadline.
    let at = now(&env).max(config.unlock_deadline);
    warp_to(&mut env, at);
    let result = send_unlock(&mut env, &config)
        .map_err(|failure| format!("refused with {}", error_name(&failure)))
        .and_then(|_| {
            let hook = mint_hook(&env, &ck(&config.mint));
            let cleared = Some(TransferHook {
                authority: None,
                program: None,
            });
            if hook != cleared {
                return Err(format!("the mint's hook fields are {hook:?}, not cleared"));
            }
            let data = env.svm.get_account(&address).unwrap().data;
            let mut expected = Config {
                unlocked_at: Some(at),
                ..config
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
            Ok(((), format!("unlocked at {at}, both hook fields cleared, the config changed only by unlocked_at")))
        });
    step(steps, "unlock at the deadline", result)?;
    Ok(())
}

/// The tax AMM program id compiled into the hook, against `deployments/devnet.json`'s when
/// the snapshot is devnet's (H072); elsewhere there is no record to compare with.
fn tax_amm_id_check(snapshot: &Snapshot) -> Step {
    let compiled = ck(&containment_hook::config::TAX_AMM_PROGRAM_ID);
    let outcome = if snapshot.is_devnet() {
        let record =
            read_json(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../deployments/devnet.json"));
        let recorded = record["programs"]["tax-amm"]["programId"]
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

/// The gate's whole reading of a snapshot with `hook`, and `tax_amm` when given.
struct Gate {
    tax_amm_id: Step,
    readings: Vec<Reading>,
}

impl Gate {
    fn failures(&self) -> Vec<String> {
        let mut failures: Vec<String> = self
            .tax_amm_id
            .outcome
            .as_ref()
            .err()
            .map(|why| format!("{}: {why}", self.tax_amm_id.name))
            .into_iter()
            .collect();
        for reading in &self.readings {
            failures.extend(reading.failures());
        }
        failures
    }
}

fn gate(snapshot: &Snapshot, hook: &[u8], tax_amm: Option<&[u8]>) -> Gate {
    Gate {
        tax_amm_id: tax_amm_id_check(snapshot),
        readings: snapshot
            .configs()
            .into_iter()
            .map(|config| check_config(snapshot, hook, tax_amm, config))
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

/// The build under test serves every config devnet held on 2026-11-23: each of the three
/// contained tokens trades, refuses a wallet-to-wallet transfer and unlocks at its deadline,
/// and each of the three unlocked ones stays unlocked.
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
        assert_eq!(reading.steps.len(), 7, "{reading:#?}");
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
    let account = &mut snapshot
        .accounts
        .iter_mut()
        .find(|(address, _)| *address == contained)
        .unwrap()
        .1;
    account.data.pop();
    let reading = check_config(&snapshot, &hook_so(), None, contained);
    let outcome = |name: &str| {
        reading
            .steps
            .iter()
            .find(|step| step.name == name)
            .unwrap_or_else(|| panic!("no step {name}: {reading:#?}"))
            .outcome
            .clone()
    };
    assert!(outcome("buy").is_ok(), "{reading:#?}");
    assert!(outcome("sell").is_ok(), "{reading:#?}");
    let unlock = outcome("unlock at the deadline").expect_err("the unlock must fail");
    assert!(unlock.contains("AccountDidNotSerialize"), "{unlock}");
}

/// H072: the tax AMM compiled into the hook is the one deployed on devnet.
#[test]
fn sos_h072_the_hooks_tax_amm_is_devnets() {
    let step = tax_amm_id_check(&snapshot(&fixture()));
    assert!(step.outcome.is_ok(), "{step:?}");
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
    let optional = |name: &str| {
        std::env::var(name)
            .ok()
            .filter(|path| !path.is_empty())
            .map(|path| std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
    };
    let snapshot = snapshot(Path::new(&var("HOOK_GATE_SNAPSHOT")));
    let candidate = std::fs::read(var("HOOK_GATE_CANDIDATE")).unwrap();
    let tax_amm = optional("HOOK_GATE_TAX_AMM");
    let deployed = optional("HOOK_GATE_DEPLOYED");
    let gate = gate(&snapshot, &candidate, tax_amm.as_deref());
    let failures = gate.failures();
    for reading in &gate.readings {
        println!("{reading:?}");
    }
    if let Ok(path) = std::env::var("HOOK_GATE_REPORT") {
        let record = serde_json::json!({
            "cluster": snapshot.url,
            "slot": snapshot.slot,
            "unix_timestamp": snapshot.unix_timestamp,
            "candidate": executable_hash(&candidate),
            "deployed": deployed.as_deref().map(executable_hash),
            "tax_amm": executable_hash(&tax_amm.unwrap_or_else(strategy_so)),
            "tax_amm_program_id": serde_json::json!({
                "passed": gate.tax_amm_id.outcome.is_ok(),
                "result": match &gate.tax_amm_id.outcome { Ok(said) | Err(said) => said },
            }),
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
