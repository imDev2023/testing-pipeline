//! PROTOTYPE, throwaway. A rough Canary harness for the wayfinder ticket "Canary checks on
//! the four devnet strategies". It answers one question: which checks should Canary v1
//! run, and what do they find that Pipeline's own `pipeline-check` and trust flags do not?
//!
//! It clones one deployed market into LiteSVM with `pipeline-check`'s own cloner, runs
//! `pipeline-check` on that snapshot for a baseline, then trades the same snapshot the way
//! a trader would: buys that are committed, sells from the same wallet, the clock moved
//! forward, other wallets, transferred tokens and several buyers leaving in turn.
//! Signature checks are off, so the harness can act as any key.
//!
//!   canary-proto <RPC> list
//!   canary-proto <RPC> run <OUT_DIR> <MARKET>...
//!   canary-proto <RPC> all <OUT_DIR>
//!   canary-proto <RPC> probe6002 <MARKET>
//!   canary-proto summary <OUT_DIR>
//!
//! <RPC> is `devnet` or an http(s) URL. Only reads from the cluster; never signs or sends.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use borsh::BorshDeserialize;
use litesvm::LiteSVM;
use pipeline_check::clone::{AccountSource, ClusterInfo};
use pipeline_check::rpc::{cluster_url, RpcSource};
use pipeline_check::{check_market_with_source, clone_market, write_token_account, CheckOptions};
use pipeline_client::{self as client, pda, pubkey, AccountMeta, Instruction, Pubkey};
use pipeline_quoter::{MarketView, QuoteRequest, Quoter, TraderQuote};
use pipeline_strategy_interface::{self as psi, fees, TradeMode};
use serde_json::{json, Value};
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const COMPUTE_BUDGET: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
const SYSVAR_OWNER: Pubkey = pubkey!("Sysvar1111111111111111111111111111111111111");
const NATIVE_LOADER: Pubkey = pubkey!("NativeLoader1111111111111111111111111111111");
const SLOTS_PER_EPOCH: u64 = 432_000;
const MAX_UNITS: u32 = 1_400_000;

/// Exact-in sizes in lamports when one side of the market is wrapped SOL.
const SOL_LADDER: &[u64] = &[
    10_000,         // 0.00001 SOL, the smallest probe
    1_000_000,      // 0.001
    10_000_000,     // 0.01, the reference size for the other checks
    100_000_000,    // 0.1
    1_000_000_000,  // 1
    10_000_000_000, // 10
];
const SOL_REFERENCE: u64 = 10_000_000;
/// Otherwise, parts per million of the input vault's balance.
const VAULT_LADDER_PPM: &[u64] = &[1, 100, 1_000, 10_000, 50_000];
const VAULT_REFERENCE_PPM: u64 = 1_000;

struct Delay {
    label: &'static str,
    slots: u64,
    secs: u64,
}

/// How long a buyer waits before selling. Slots are 400 ms.
const DELAYS: &[Delay] = &[
    Delay {
        label: "same slot",
        slots: 0,
        secs: 0,
    },
    Delay {
        label: "next slot",
        slots: 1,
        secs: 0,
    },
    Delay {
        label: "10 seconds",
        slots: 25,
        secs: 10,
    },
    Delay {
        label: "1 minute",
        slots: 150,
        secs: 60,
    },
    Delay {
        label: "10 minutes",
        slots: 1_500,
        secs: 600,
    },
    Delay {
        label: "1 hour",
        slots: 9_000,
        secs: 3_600,
    },
    Delay {
        label: "1 day",
        slots: 216_000,
        secs: 86_400,
    },
    Delay {
        label: "3 days",
        slots: 648_000,
        secs: 259_200,
    },
    Delay {
        label: "30 days",
        slots: 6_480_000,
        secs: 2_592_000,
    },
];

// ---------------------------------------------------------------------------------------
// Reading the cluster: pipeline-check's read-only RPC source, with programs cached
// ---------------------------------------------------------------------------------------

struct Source {
    rpc: RpcSource,
    programs: HashMap<Pubkey, Account>,
}

impl AccountSource for Source {
    fn get_accounts(&mut self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, String> {
        let missing: Vec<Pubkey> = keys
            .iter()
            .filter(|k| !self.programs.contains_key(*k))
            .copied()
            .collect();
        let mut fresh: HashMap<Pubkey, Option<Account>> = HashMap::new();
        if !missing.is_empty() {
            let got = self.rpc.get_accounts(&missing)?;
            fresh = missing.into_iter().zip(got).collect();
        }
        let mut out = vec![];
        for key in keys {
            if let Some(account) = self.programs.get(key) {
                out.push(Some(account.clone()));
                continue;
            }
            let account = fresh.get(key).cloned().flatten();
            if let Some(a) = &account {
                let program_data = a.owner == client::BPF_LOADER_UPGRADEABLE_ID
                    && a.data.len() > 45
                    && a.data[..4] == [3, 0, 0, 0];
                if a.executable || program_data {
                    self.programs.insert(*key, a.clone());
                }
            }
            out.push(account);
        }
        Ok(out)
    }

    fn cluster_info(&mut self) -> Result<ClusterInfo, String> {
        self.rpc.cluster_info()
    }
}

// ---------------------------------------------------------------------------------------
// The market and small VM helpers
// ---------------------------------------------------------------------------------------

struct Ctx {
    market: Pubkey,
    record: client::Market,
    view: MarketView,
    payer: Pubkey,
}

impl Ctx {
    fn n(&self) -> usize {
        self.record.mint_count as usize
    }
    fn mint(&self, i: usize) -> Pubkey {
        self.view.mints[i]
    }
    fn tp(&self, i: usize) -> Pubkey {
        self.view.token_programs[i]
    }
    fn vault(&self, i: usize) -> Pubkey {
        self.view.vaults[i]
    }
    fn ata(&self, owner: &Pubkey, i: usize) -> Pubkey {
        pda::associated_token(owner, &self.mint(i), &self.tp(i))
    }
    fn strategy(&self) -> Pubkey {
        self.record.strategy_program
    }
}

/// Counts every swap whose quote was taken in the same state just before it.
#[derive(Default)]
struct Parity {
    compared: u64,
    matched: u64,
    mismatches: Vec<Value>,
    quote_failed_swap_ok: Vec<Value>,
    quote_ok_swap_failed: Vec<Value>,
    /// Sysvars and other accounts that describe the transaction rather than the market.
    watched_accounts: BTreeSet<String>,
    swaps: u64,
    max_swap_units: u64,
    max_strategy_units: u64,
}

fn token_amount(svm: &LiteSVM, account: &Pubkey) -> u64 {
    svm.get_account(account)
        .and_then(|a| {
            a.data
                .get(64..72)
                .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
        })
        .unwrap_or(0)
}

fn fund_wallet(svm: &mut LiteSVM, key: &Pubkey) {
    svm.set_account(
        *key,
        Account {
            lamports: 100_000_000_000,
            data: vec![],
            owner: client::SYSTEM_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("a system account can always be written");
}

fn compute_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET, &data, vec![])
}

/// An unsigned transaction: the VM runs with signature checks off, so any key can "sign".
fn tx(svm: &LiteSVM, payer: &Pubkey, ixs: &[Instruction]) -> Transaction {
    let mut tx = Transaction::new_with_payer(ixs, Some(payer));
    tx.message.recent_blockhash = svm.latest_blockhash();
    tx
}

fn clock_json(svm: &LiteSVM) -> Value {
    let clock: Clock = svm.get_sysvar();
    json!({ "slot": clock.slot, "epoch": clock.epoch, "unix_timestamp": clock.unix_timestamp })
}

/// Moves slot, epoch and Unix time forward together. Devnet epochs are 432,000 slots.
fn warp(svm: &mut LiteSVM, delay: &Delay) {
    if delay.slots == 0 {
        return;
    }
    let before: Clock = svm.get_sysvar();
    let slot = before.slot + delay.slots;
    svm.warp_to_slot(slot);
    let mut clock: Clock = svm.get_sysvar();
    clock.slot = slot;
    clock.epoch = before.epoch + (slot / SLOTS_PER_EPOCH - before.slot / SLOTS_PER_EPOCH);
    clock.leader_schedule_epoch = clock.epoch + 1;
    clock.unix_timestamp = before.unix_timestamp + delay.secs as i64;
    clock.epoch_start_timestamp = before.epoch_start_timestamp;
    svm.set_sysvar(&clock);
}

fn between<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = text.find(start)? + start.len();
    let to = text[from..].find(end)? + from;
    Some(&text[from..to])
}

/// Says why a transaction failed: which program refused, with which error, or a crash.
fn failure(stage: &str, err: &str, logs: &[String], ctx: &Ctx) -> Value {
    let mut failed_program = None;
    let mut reason = None;
    // The innermost program fails first; its callers then report the same failure.
    for line in logs {
        if let Some(rest) = line.strip_prefix("Program ") {
            if let Some((id, why)) = rest.split_once(" failed: ") {
                failed_program = Some(id.to_string());
                reason = Some(why.to_string());
                break;
            }
        }
    }
    let anchor = logs.iter().find(|l| l.contains("Error Code: "));
    let name = anchor.and_then(|l| between(l, "Error Code: ", ". Error Number"));
    let number = anchor
        .and_then(|l| between(l, "Error Number: ", ". Error Message"))
        .and_then(|n| n.parse::<u32>().ok());
    let message = anchor
        .and_then(|l| l.split_once("Error Message: "))
        .map(|(_, m)| m.trim_end_matches('.').to_string());
    let account = anchor.and_then(|l| between(l, "caused by account: ", ". Error Code"));
    let origin = anchor.and_then(|l| between(l, "thrown in ", ". Error Code"));
    let panic = logs
        .iter()
        .find(|l| l.contains("panicked at"))
        .cloned()
        .or_else(|| {
            reason.as_ref().filter(|r| r.contains("panicked")).map(|_| {
                logs.iter()
                    .rev()
                    .find(|l| l.starts_with("Program log:"))
                    .cloned()
                    .unwrap_or_default()
            })
        });
    let custom = between(err, "Custom(", ")").and_then(|n| n.parse::<u32>().ok());
    let out_of_compute = err.contains("ComputationalBudgetExceeded")
        || logs.iter().any(|l| {
            l.contains("exceeded CUs meter") || l.contains("Computational budget exceeded")
        });
    let who = match failed_program.as_deref() {
        Some(p) if p == client::PROGRAM_ID.to_string() => "router",
        Some(p) if p == ctx.strategy().to_string() => "strategy",
        Some(p)
            if p == client::TOKEN_PROGRAM_ID.to_string()
                || p == client::TOKEN_2022_PROGRAM_ID.to_string() =>
        {
            "token program"
        }
        Some(_) => "another program",
        None => "unknown",
    };
    let code = number.or(custom);
    let kind = if panic.is_some() {
        "crash".to_string()
    } else if out_of_compute {
        "out of compute".to_string()
    } else if matches!(code, Some(3002) | Some(3003)) {
        "cannot read state".to_string()
    } else {
        format!("{who} refused")
    };
    json!({
        "stage": stage,
        "kind": kind,
        "program": failed_program,
        "who": who,
        "code": code,
        "name": name,
        "message": message,
        "account": account,
        "origin": origin,
        "panic": panic,
        "error": err,
        "reason": reason,
    })
}

/// A short label for a failure, for tables.
fn failure_label(f: &Value) -> String {
    let kind = f["kind"].as_str().unwrap_or("failed");
    match (f["name"].as_str(), f["code"].as_u64()) {
        (Some(name), Some(code)) => format!("{kind}: {name} ({code})"),
        (None, Some(code)) => format!("{kind}: error {code}"),
        _ => match f["panic"].as_str() {
            Some(p) => format!("{kind}: {p}"),
            None => format!(
                "{kind}: {}",
                f["reason"].as_str().or(f["error"].as_str()).unwrap_or("")
            ),
        },
    }
}

/// Simulates one read-only call to the strategy and returns its return data.
fn sim(
    svm: &LiteSVM,
    ctx: &Ctx,
    stage: &str,
    ix: Instruction,
    units: u32,
) -> Result<(Vec<u8>, u64), Value> {
    let program = ix.program_id;
    match svm.simulate_transaction(tx(svm, &ctx.payer, &[compute_ix(units), ix])) {
        Ok(info) => {
            if info.meta.return_data.program_id != program {
                return Err(json!({ "stage": stage, "kind": "no return data" }));
            }
            Ok((
                info.meta.return_data.data.clone(),
                info.meta.compute_units_consumed,
            ))
        }
        Err(failed) => Err(failure(
            stage,
            &format!("{:?}", failed.err),
            &failed.meta.logs,
            ctx,
        )),
    }
}

fn read_accounts(ctx: &Ctx, input: usize, output: usize, trader: &Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(ctx.market, false),
        AccountMeta::new_readonly(ctx.record.market_state, false),
        AccountMeta::new_readonly(*trader, false),
        AccountMeta::new_readonly(ctx.ata(trader, input), false),
        AccountMeta::new_readonly(ctx.ata(trader, output), false),
        AccountMeta::new_readonly(ctx.vault(input), false),
        AccountMeta::new_readonly(ctx.mint(input), false),
        AccountMeta::new_readonly(ctx.mint(output), false),
        AccountMeta::new_readonly(ctx.tp(input), false),
        AccountMeta::new_readonly(ctx.tp(output), false),
    ]
}

/// Copies accounts the VM does not hold yet from the cluster (programs with their data).
fn fetch_missing(svm: &mut LiteSVM, src: &mut Source, keys: &[Pubkey]) {
    let missing: Vec<Pubkey> = keys
        .iter()
        .filter(|k| svm.get_account(k).is_none())
        .copied()
        .collect();
    if missing.is_empty() {
        return;
    }
    let Ok(accounts) = src.get_accounts(&missing) else {
        return;
    };
    for (key, account) in missing.into_iter().zip(accounts) {
        let Some(account) = account else { continue };
        if account.owner == SYSVAR_OWNER || account.owner == NATIVE_LOADER {
            continue;
        }
        if account.executable && account.owner == client::BPF_LOADER_UPGRADEABLE_ID {
            let data_key = pda::program_data(&key);
            if let Ok(mut data) = src.get_accounts(&[data_key]) {
                if let Some(Some(data)) = data.pop() {
                    let _ = svm.set_account(data_key, data);
                }
            }
        }
        let _ = svm.set_account(key, account);
    }
}

fn trade(input: usize, output: usize, amount: u64, trader: Option<Pubkey>) -> psi::TradeRequest {
    psi::TradeRequest {
        mode: TradeMode::ExactIn,
        input_index: input as u8,
        output_index: output as u8,
        amount,
        trader: trader.map(|t| t.to_bytes()),
        extra: vec![],
    }
}

/// Runs `pipeline_resolve_accounts` in the VM's current state, loading what it lists.
fn resolve(
    svm: &mut LiteSVM,
    src: &mut Source,
    ctx: &Ctx,
    request: &psi::TradeRequest,
) -> Result<Vec<AccountMeta>, Value> {
    let trader = request
        .trader
        .map(Pubkey::new_from_array)
        .unwrap_or_default();
    let fixed = read_accounts(
        ctx,
        request.input_index as usize,
        request.output_index as usize,
        &trader,
    );
    let mut known: Vec<AccountMeta> = vec![];
    for round in 0..psi::MAX_RESOLVE_ROUNDS {
        let mut accounts = fixed.clone();
        accounts.extend(
            known
                .iter()
                .map(|m| AccountMeta::new_readonly(m.pubkey, false)),
        );
        let data = psi::instruction_data(
            psi::discriminator::RESOLVE_ACCOUNTS,
            &psi::ResolveRequest {
                trade: request.clone(),
                round,
            },
        );
        let ix = Instruction::new_with_bytes(ctx.strategy(), &data, accounts);
        let (out, _) = sim(svm, ctx, "resolve accounts", ix, MAX_UNITS)?;
        let result = psi::ResolveResult::try_from_slice(&out)
            .map_err(|_| json!({ "stage": "resolve accounts", "kind": "malformed return data" }))?;
        known = result
            .accounts
            .iter()
            .map(|a| {
                let key = Pubkey::new_from_array(a.address);
                if a.writable {
                    AccountMeta::new(key, false)
                } else {
                    AccountMeta::new_readonly(key, false)
                }
            })
            .collect();
        let keys: Vec<Pubkey> = known.iter().map(|m| m.pubkey).collect();
        fetch_missing(svm, src, &keys);
        if result.complete {
            return Ok(known);
        }
    }
    Err(json!({ "stage": "resolve accounts", "kind": "not complete after 4 rounds" }))
}

fn program_elf(svm: &LiteSVM, program: &Pubkey) -> Option<Vec<u8>> {
    let account = svm.get_account(program)?;
    if account.owner == client::BPF_LOADER_UPGRADEABLE_ID {
        let data = svm.get_account(&pda::program_data(program))?.data;
        return data.get(45..).map(|d| d.to_vec());
    }
    Some(account.data)
}

/// A fresh `pipeline-quoter` holding only what an integrator would have: the market's fixed
/// accounts and the accounts resolution listed, copied from the VM's current state.
fn quoter_from(svm: &LiteSVM, ctx: &Ctx, extra: &[Pubkey]) -> Result<Quoter, String> {
    let mut quoter = Quoter::new();
    let clock: Clock = svm.get_sysvar();
    quoter.set_clock(clock.slot, clock.epoch, clock.unix_timestamp);
    let mut keys = vec![
        ctx.strategy(),
        ctx.market,
        pda::config(),
        ctx.record.market_state,
    ];
    keys.extend(ctx.view.mints.iter());
    keys.extend(ctx.view.vaults.iter());
    keys.extend(extra.iter());
    for key in keys {
        let Some(account) = svm.get_account(&key) else {
            continue;
        };
        if account.owner == SYSVAR_OWNER {
            continue;
        }
        if account.executable {
            if let Some(elf) = program_elf(svm, &key) {
                quoter.load_program(key, &elf).map_err(|e| e.to_string())?;
            }
            continue;
        }
        quoter
            .set_account(key, account)
            .map_err(|e| e.to_string())?;
    }
    Ok(quoter)
}

fn quote(
    svm: &LiteSVM,
    ctx: &Ctx,
    input: usize,
    output: usize,
    amount: u64,
    trader: Option<Pubkey>,
    resolved: &[AccountMeta],
) -> Result<TraderQuote, String> {
    let keys: Vec<Pubkey> = resolved.iter().map(|m| m.pubkey).collect();
    let mut quoter = quoter_from(svm, ctx, &keys)?;
    quoter
        .quote(
            &ctx.view,
            &QuoteRequest {
                input_mint: ctx.mint(input),
                output_mint: ctx.mint(output),
                mode: TradeMode::ExactIn,
                amount,
                trader,
                integrator_fee_bps: 0,
                extra: vec![],
            },
            resolved,
        )
        .map_err(|e| e.to_string())
}

/// The strategy's own `pipeline_quote`, simulated in the VM, to learn why a quote failed.
fn quote_failure(
    svm: &LiteSVM,
    ctx: &Ctx,
    request: &psi::TradeRequest,
    resolved: &[AccountMeta],
) -> Option<Value> {
    let trader = request
        .trader
        .map(Pubkey::new_from_array)
        .unwrap_or_default();
    let mut accounts = read_accounts(
        ctx,
        request.input_index as usize,
        request.output_index as usize,
        &trader,
    );
    accounts.extend(
        resolved
            .iter()
            .map(|m| AccountMeta::new_readonly(m.pubkey, false)),
    );
    let data = psi::instruction_data(psi::discriminator::QUOTE, request);
    sim(
        svm,
        ctx,
        "quote",
        Instruction::new_with_bytes(ctx.strategy(), &data, accounts),
        200_000,
    )
    .err()
}

// ---------------------------------------------------------------------------------------
// One committed swap through the real router
// ---------------------------------------------------------------------------------------

struct Leg {
    ok: bool,
    /// What left the trader's input account, Pipeline's fee included.
    spent: u64,
    /// What arrived in the trader's output account.
    received: u64,
    pipeline_fee: u64,
    net_sent: u64,
    json: Value,
}

#[allow(clippy::too_many_arguments)]
fn swap(
    svm: &mut LiteSVM,
    src: &mut Source,
    ctx: &Ctx,
    parity: &mut Parity,
    trader: &Pubkey,
    input: usize,
    output: usize,
    amount_in: u64,
) -> Leg {
    let mut leg = Leg {
        ok: false,
        spent: 0,
        received: 0,
        pipeline_fee: 0,
        net_sent: 0,
        json: Value::Null,
    };
    let mut out = json!({ "input": input, "output": output, "amount_in": amount_in, "clock": clock_json(svm) });
    let request = trade(input, output, amount_in, Some(*trader));
    let resolved = match resolve(svm, src, ctx, &request) {
        Ok(resolved) => resolved,
        Err(f) => {
            out["ok"] = json!(false);
            out["failure"] = f;
            leg.json = out;
            return leg;
        }
    };
    for meta in &resolved {
        let key = meta.pubkey.to_string();
        if key.starts_with("Sysvar")
            && key != "SysvarC1ock11111111111111111111111111111111"
            && key != "SysvarRent111111111111111111111111111111111"
        {
            parity.watched_accounts.insert(key);
        }
    }
    let quoted = quote(svm, ctx, input, output, amount_in, Some(*trader), &resolved);
    match &quoted {
        Ok(q) => {
            out["quote"] = json!({
                "amount_out": q.amount_out,
                "net_sent": q.net_sent,
                "pipeline_fee": q.pipeline_fee,
                "total_spend": q.total_spend,
                "strategy_units": q.compute_units,
            });
        }
        Err(e) => {
            out["quote"] =
                json!({ "error": e, "failure": quote_failure(svm, ctx, &request, &resolved) });
        }
    }

    let accounts = client::SwapAccounts {
        trader: *trader,
        strategy_program: ctx.strategy(),
        market_state: ctx.record.market_state,
        trader_input: ctx.ata(trader, input),
        trader_output: ctx.ata(trader, output),
        input_vault: ctx.vault(input),
        input_mint: ctx.mint(input),
        output_mint: ctx.mint(output),
        input_token_program: ctx.tp(input),
        output_token_program: ctx.tp(output),
        integrator_fee_account: None,
        strategy_accounts: resolved.clone(),
        // Transfer hooks are not handled by this prototype: no devnet mint has one.
        input_hook_accounts: vec![],
    };
    let args = client::SwapArgs {
        mode: TradeMode::ExactIn,
        amount_in,
        amount_out: 0,
        min_amount_out: 0,
        integrator_fee_bps: 0,
        input_hook_accounts: 0,
        extra: vec![],
    };
    let in_before = token_amount(svm, &accounts.trader_input);
    let out_before = token_amount(svm, &accounts.trader_output);
    let vaults_before: Vec<u64> = (0..ctx.n())
        .map(|i| token_amount(svm, &ctx.vault(i)))
        .collect();
    let strategy_line = format!("Program {} consumed ", ctx.strategy());
    let strategy_units = |logs: &[String]| -> Option<u64> {
        logs.iter()
            .find_map(|line| line.strip_prefix(&strategy_line))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|n| n.parse().ok())
    };
    parity.swaps += 1;
    let sent = svm.send_transaction(tx(
        svm,
        trader,
        &[compute_ix(MAX_UNITS), client::swap(&accounts, &args)],
    ));
    match sent {
        Ok(meta) => {
            let result = (meta.return_data.program_id == client::PROGRAM_ID)
                .then(|| client::SwapResult::try_from_slice(&meta.return_data.data).ok())
                .flatten();
            leg.spent = in_before.saturating_sub(token_amount(svm, &accounts.trader_input));
            leg.received = token_amount(svm, &accounts.trader_output).saturating_sub(out_before);
            leg.ok = true;
            let units = strategy_units(&meta.logs);
            parity.max_swap_units = parity.max_swap_units.max(meta.compute_units_consumed);
            parity.max_strategy_units = parity.max_strategy_units.max(units.unwrap_or(0));
            out["ok"] = json!(true);
            out["spent"] = json!(leg.spent);
            out["received"] = json!(leg.received);
            out["units"] = json!(meta.compute_units_consumed);
            out["strategy_units"] = json!(units);
            let vaults_after: Vec<u64> = (0..ctx.n())
                .map(|i| token_amount(svm, &ctx.vault(i)))
                .collect();
            out["vault_change"] = json!(vaults_after
                .iter()
                .zip(&vaults_before)
                .map(|(a, b)| *a as i128 - *b as i128)
                .map(|d| d as i64)
                .collect::<Vec<_>>());
            if let Some(r) = &result {
                leg.pipeline_fee = r.pipeline_fee;
                leg.net_sent = r.net_sent;
                out["result"] = json!({ "net_sent": r.net_sent, "received": r.received, "pipeline_fee": r.pipeline_fee });
            }
            match (&quoted, &result) {
                (Ok(q), Some(r)) => {
                    parity.compared += 1;
                    let same = q.amount_out == r.received
                        && q.net_sent == r.net_sent
                        && q.pipeline_fee == r.pipeline_fee
                        && q.total_spend == leg.spent
                        && q.amount_out == leg.received;
                    out["matches_quote"] = json!(same);
                    if same {
                        parity.matched += 1;
                    } else {
                        parity.mismatches.push(out.clone());
                    }
                }
                (Err(_), _) => parity.quote_failed_swap_ok.push(out.clone()),
                _ => {}
            }
        }
        Err(failed) => {
            out["ok"] = json!(false);
            out["failure"] = failure("swap", &format!("{:?}", failed.err), &failed.meta.logs, ctx);
            out["units"] = json!(failed.meta.compute_units_consumed);
            if quoted.is_ok() {
                parity.quote_ok_swap_failed.push(out.clone());
            }
        }
    }
    leg.json = out;
    leg
}

/// Gives `trader` SOL for fees, `budget` of the input mint and an empty output account.
fn fund_trader(
    svm: &mut LiteSVM,
    ctx: &Ctx,
    trader: &Pubkey,
    input: usize,
    output: usize,
    budget: u64,
) -> Result<(), String> {
    fund_wallet(svm, trader);
    write_token_account(svm, &ctx.mint(input), &ctx.tp(input), trader, budget)?;
    write_token_account(svm, &ctx.mint(output), &ctx.tp(output), trader, 0)?;
    Ok(())
}

fn pct(part: u64, whole: u64) -> Value {
    if whole == 0 {
        return Value::Null;
    }
    json!(((part as f64 / whole as f64) * 1_000_000.0).round() / 10_000.0)
}

/// Buys `amount` of `token` with `money`, optionally waits, then sells everything bought.
#[allow(clippy::too_many_arguments)]
fn round_trip(
    svm: &mut LiteSVM,
    src: &mut Source,
    ctx: &Ctx,
    parity: &mut Parity,
    trader: &Pubkey,
    money: usize,
    token: usize,
    amount: u64,
    hold: Option<&Delay>,
) -> Value {
    let budget = fees::max_total_spend(amount, 0).unwrap_or(u64::MAX);
    if let Err(e) = fund_trader(svm, ctx, trader, money, token, budget) {
        return json!({ "amount": amount, "error": format!("cannot fund the trader: {e}") });
    }
    let buy = swap(svm, src, ctx, parity, trader, money, token, amount);
    let mut out = json!({ "amount": amount, "buy": buy.json });
    if !buy.ok || buy.received == 0 {
        out["bought"] = json!(false);
        return out;
    }
    out["bought"] = json!(true);
    if let Some(delay) = hold {
        warp(svm, delay);
    }
    let held = token_amount(svm, &ctx.ata(trader, token));
    let sell_amount = fees::amount_for_budget(held, 0);
    let sell = swap(svm, src, ctx, parity, trader, token, money, sell_amount);
    out["sold"] = json!(sell.ok);
    out["put_in"] = json!(buy.spent);
    out["tokens"] = json!(buy.received);
    out["got_back"] = json!(sell.received);
    out["returned_pct"] = pct(sell.received, buy.spent);
    // Pipeline's own share of the loss: its fee on the buy, plus its fee on the sale
    // (charged in the token) valued at the sale's own price.
    if sell.ok && sell.net_sent > 0 {
        let sell_fee_in_money =
            (sell.pipeline_fee as u128 * sell.received as u128 / sell.net_sent as u128) as u64;
        out["pipeline_fee_pct"] = pct(buy.pipeline_fee + sell_fee_in_money, buy.spent);
    }
    out["sell"] = sell.json;
    out
}

// ---------------------------------------------------------------------------------------
// Facts read from bytes
// ---------------------------------------------------------------------------------------

/// `PipelineSwap` to `pipeline_swap`, the name Anchor hashes into the discriminator.
fn snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Instruction names Anchor compiles into a program: the "Instruction: Name" log strings,
/// each kept only if the discriminator of that name is in the code too. Rust stores string
/// constants back to back, so a raw name can run on into the next string; the longest
/// prefix whose discriminator is present is the real name. Returns (verified, unverified).
fn instruction_names(elf: &[u8]) -> (Vec<String>, Vec<String>) {
    // Discriminators sit in the code whole, or as the two 32-bit halves of a 64-bit
    // constant in neighbouring instructions (four bytes of opcode between them).
    let mut whole: HashSet<[u8; 8]> = HashSet::new();
    let mut split: HashSet<[u8; 8]> = HashSet::new();
    for w in elf.windows(12) {
        whole.insert(w[..8].try_into().unwrap());
        let mut halves = [0u8; 8];
        halves[..4].copy_from_slice(&w[..4]);
        halves[4..].copy_from_slice(&w[8..]);
        split.insert(halves);
    }
    let needle = b"Instruction: ";
    let (mut verified, mut unverified) = (BTreeSet::new(), BTreeSet::new());
    let mut i = 0;
    while i + needle.len() < elf.len() {
        if &elf[i..i + needle.len()] != needle {
            i += 1;
            continue;
        }
        let start = i + needle.len();
        let mut end = start;
        while end < elf.len()
            && end - start < 80
            && (elf[end].is_ascii_alphanumeric() || elf[end] == b'_')
        {
            end += 1;
        }
        let raw = String::from_utf8_lossy(&elf[start..end]).to_string();
        let found = (2..=raw.len()).rev().map(|len| &raw[..len]).find(|prefix| {
            let d = client::instruction_discriminator(&snake(prefix));
            whole.contains(&d) || split.contains(&d)
        });
        match found {
            Some(name) => {
                verified.insert(name.to_string());
            }
            None if !raw.is_empty() => {
                unverified.insert(raw.chars().take(40).collect::<String>());
            }
            None => {}
        }
        i = start;
    }
    (
        verified.into_iter().collect(),
        unverified.into_iter().collect(),
    )
}

fn coption_key(bytes: &[u8]) -> Option<Pubkey> {
    (bytes.len() >= 36 && bytes[0] == 1)
        .then(|| Pubkey::new_from_array(bytes[4..36].try_into().unwrap()))
}

/// The authority that can change a Token-2022 mint's transfer fee, if it has one.
fn transfer_fee_authority(mint: &[u8]) -> Option<Pubkey> {
    // Extensions follow the 165-byte base and a 1-byte account type, as type, length, value.
    let mut i = 166;
    while i + 4 <= mint.len() {
        let kind = u16::from_le_bytes([mint[i], mint[i + 1]]);
        let len = u16::from_le_bytes([mint[i + 2], mint[i + 3]]) as usize;
        if kind == 0 {
            break;
        }
        if kind == 1 && len >= 32 && i + 36 <= mint.len() {
            let key: [u8; 32] = mint[i + 4..i + 36].try_into().unwrap();
            return (key != [0u8; 32]).then(|| Pubkey::new_from_array(key));
        }
        i += 4 + len;
    }
    None
}

fn upgrade_authority(svm: &LiteSVM, program: &Pubkey) -> Option<Pubkey> {
    let data = svm.get_account(&pda::program_data(program))?.data;
    (data.len() >= 45 && data[12] == 1)
        .then(|| Pubkey::new_from_array(data[13..45].try_into().unwrap()))
}

// ---------------------------------------------------------------------------------------
// The run on one market
// ---------------------------------------------------------------------------------------

fn run_market(src: &mut Source, market: Pubkey) -> Value {
    let run_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut out =
        json!({ "schema": "canary-proto/0", "market": market.to_string(), "run_at": run_at });
    let options = CheckOptions::default();
    let cloned = match clone_market(src, market, None, &options) {
        Ok(cloned) => cloned,
        Err(error) => {
            out["clone_error"] = json!(error);
            return out;
        }
    };
    out["source"] = json!({
        "slot": cloned.cluster.slot,
        "epoch": cloned.cluster.epoch,
        "unix_timestamp": cloned.cluster.unix_timestamp,
        "genesis_hash": cloned.cluster.genesis_hash,
        "accounts_cloned": cloned.accounts_cloned,
        "notes": cloned.notes,
    });

    // Pipeline's own checker on the very same snapshot, for the comparison.
    let report = check_market_with_source(&cloned.svm, market, &options, cloned.source());
    let report: Value = serde_json::from_str(&report.to_json()).unwrap_or(Value::Null);
    out["strategy"] = report["strategy"].clone();
    out["router"] = report["router"].clone();
    out["mints"] = report["market"]["mints"].clone();
    out["pipeline_check"] = json!({
        "summary": report["summary"],
        "checks": report["checks"].as_array().map(|checks| checks.iter().map(|c| json!({
            "id": c["id"], "status": c["status"], "message": c["message"],
        })).collect::<Vec<_>>()),
        "round_trip_details": report["checks"].as_array().and_then(|checks| {
            checks.iter().find(|c| c["id"] == "round_trip").map(|c| c["details"].clone())
        }),
    });

    let mut base = cloned.svm.with_sigverify(false).with_blockhash_check(false);
    let Some(record) = base
        .get_account(&market)
        .and_then(|a| client::decode_market(&a.data))
    else {
        out["clone_error"] = json!("the Market account does not decode");
        return out;
    };
    let mut token_programs = vec![];
    for mint in record.mints() {
        match base.get_account(mint) {
            Some(account) => token_programs.push(account.owner),
            None => {
                out["clone_error"] = json!(format!("mint {mint} does not exist"));
                return out;
            }
        }
    }
    let Ok(view) = MarketView::from_market(market, &record, token_programs) else {
        out["clone_error"] = json!("cannot build a market view");
        return out;
    };
    let payer = Keypair::new().pubkey();
    fund_wallet(&mut base, &payer);
    let ctx = Ctx {
        market,
        record,
        view,
        payer,
    };
    let n = ctx.n();

    // The first sale of a mint needs the market's fee account; anyone may create it.
    let mut fee_accounts_created = vec![];
    for i in 0..n {
        if base
            .get_account(&pda::fee_account(&market, &ctx.mint(i), &ctx.tp(i)))
            .is_none()
        {
            let ix = client::init_fee_account(&payer, &market, &ctx.mint(i), &ctx.tp(i));
            let sent = base.send_transaction(tx(&base, &payer, &[ix]));
            fee_accounts_created.push(json!({ "mint": i, "created_locally": sent.is_ok() }));
        }
    }
    out["fee_accounts_missing"] = json!(fee_accounts_created);

    // Control facts from bytes.
    let elf = program_elf(&base, &ctx.strategy()).unwrap_or_default();
    let (names, unverified_names) = instruction_names(&elf);
    let pipeline_names = [
        "PipelineInitMarket",
        "PipelineMarketInfo",
        "PipelineResolveAccounts",
        "PipelineQuote",
        "PipelineSwap",
        "PipelineSeedLiquidity",
    ];
    let custom: Vec<&String> = names
        .iter()
        .filter(|n| !pipeline_names.contains(&n.as_str()) && !n.starts_with("Idl"))
        .collect();
    let authority = upgrade_authority(&base, &ctx.strategy());
    out["control"] = json!({
        "upgrade_authority": authority.map(|a| a.to_string()),
        "created_by": ctx.record.created_by.to_string(),
        "instructions_in_bytecode": names,
        "instruction_names_without_a_discriminator": unverified_names,
        "custom_instructions": custom,
        "idl_instructions": names.iter().any(|n| n.starts_with("Idl")),
        "supports_exact_out": ctx.record.supports_exact_out,
    });

    // Which side is money: wrapped SOL when the market has it; otherwise the mint whose
    // vault holds the smallest share of its supply (a launched token sits mostly in its own
    // market, money mostly outside it). Sizes are always set on the money side, and a sale
    // only ever sells what a buy in the same run produced, so no run trades tokens that
    // could not exist.
    let supplies: Vec<u64> = (0..n)
        .map(|i| {
            base.get_account(&ctx.mint(i))
                .and_then(|a| {
                    a.data
                        .get(36..44)
                        .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
                })
                .unwrap_or(0)
        })
        .collect();
    let shares: Vec<f64> = (0..n)
        .map(|i| match supplies[i] {
            0 => 1.0,
            total => token_amount(&base, &ctx.vault(i)) as f64 / total as f64,
        })
        .collect();
    let money = (0..n).find(|i| ctx.mint(*i) == WSOL).unwrap_or_else(|| {
        (0..n)
            .min_by(|a, b| shares[*a].total_cmp(&shares[*b]))
            .unwrap_or(0)
    });
    out["money_side"] = json!({ "mint": money, "is_sol": ctx.mint(money) == WSOL });
    let mut parity = Parity::default();

    // Readability: can this version read the market at all, and does it quote each way?
    let mut probes = vec![];
    let mut tradable = vec![];
    for input in 0..n {
        for output in (0..n).filter(|o| *o != input) {
            let amount = if ctx.mint(input) == WSOL {
                SOL_LADDER[0]
            } else {
                (token_amount(&base, &ctx.vault(input)) / 1_000_000).max(1_000)
            };
            let request = trade(input, output, amount, None);
            let state = match resolve(&mut base, src, &ctx, &request) {
                Err(f) => f,
                Ok(resolved) => match quote(&base, &ctx, input, output, amount, None, &resolved) {
                    Ok(q) => {
                        tradable.push((input, output));
                        json!({ "kind": "quotes", "amount_out": q.amount_out })
                    }
                    Err(e) => quote_failure(&base, &ctx, &request, &resolved).unwrap_or(
                        json!({ "stage": "quote", "kind": "quoter refused", "error": e }),
                    ),
                },
            };
            probes.push(
                json!({ "input": input, "output": output, "amount": amount, "state": state }),
            );
        }
    }
    let unreadable = probes
        .iter()
        .all(|p| p["state"]["kind"] == "cannot read state");
    out["readable"] = json!({ "unreadable": unreadable, "probes": probes });

    let pairs: Vec<(usize, usize)> = (0..n).filter(|t| *t != money).map(|t| (money, t)).collect();
    let decimals = |svm: &LiteSVM, i: usize| -> u32 {
        svm.get_account(&ctx.mint(i))
            .map(|m| m.data[44] as u32)
            .unwrap_or(0)
    };
    let ladder = |svm: &LiteSVM, first: usize| -> Vec<u64> {
        let balance = token_amount(svm, &ctx.vault(first)) as u128;
        if ctx.mint(first) == WSOL {
            SOL_LADDER.to_vec()
        } else if balance < 2_000_000 {
            // A nearly empty money vault (a curve that has sold nothing yet): whole tokens.
            let one = 10u64.pow(decimals(svm, first));
            vec![one / 100, one / 10, one, one * 10, one * 100]
        } else {
            VAULT_LADDER_PPM
                .iter()
                .map(|ppm| ((balance * *ppm as u128) / 1_000_000).max(1) as u64)
                .collect()
        }
    };
    let reference = |svm: &LiteSVM, first: usize| -> u64 {
        let balance = token_amount(svm, &ctx.vault(first)) as u128;
        if ctx.mint(first) == WSOL {
            SOL_REFERENCE
        } else if balance < 2_000_000 {
            10u64.pow(decimals(svm, first))
        } else {
            ((balance * VAULT_REFERENCE_PPM as u128) / 1_000_000).max(1) as u64
        }
    };

    let mut exits = vec![];
    for (first, second) in pairs {
        let mut pair =
            json!({ "money": first, "token": second, "money_is_sol": ctx.mint(first) == WSOL });

        // 1. Sizes: buy and sell straight back, each size from the same starting state.
        let mut sizes = vec![];
        for amount in ladder(&base, first) {
            let mut svm = base.clone();
            let trader = Keypair::new().pubkey();
            sizes.push(round_trip(
                &mut svm,
                src,
                &ctx,
                &mut parity,
                &trader,
                first,
                second,
                amount,
                None,
            ));
        }
        // The reference size for the remaining checks: the standard one if its round trip
        // worked, otherwise the largest size that did.
        let standard = reference(&base, first);
        let worked = |row: &Value| row["sold"] == true;
        let amount = sizes
            .iter()
            .find(|row| row["amount"] == standard && worked(row))
            .or_else(|| sizes.iter().rev().find(|row| worked(row)))
            .and_then(|row| row["amount"].as_u64());
        pair["sizes"] = json!(sizes);
        let Some(amount) = amount else {
            pair["not_run"] = json!("no size could be bought and sold back, so the timed, wallet, transfer and queue runs have nothing to use");
            exits.push(pair);
            continue;
        };
        pair["reference_amount"] = json!(amount);

        // 2. Hold: buy now, sell after a wait. Every wait starts from the same bought state.
        let mut bought = base.clone();
        let holder = Keypair::new().pubkey();
        let budget = fees::max_total_spend(amount, 0).unwrap_or(u64::MAX);
        let mut hold = vec![];
        if fund_trader(&mut bought, &ctx, &holder, first, second, budget).is_ok() {
            let buy = swap(
                &mut bought,
                src,
                &ctx,
                &mut parity,
                &holder,
                first,
                second,
                amount,
            );
            if buy.ok {
                for delay in DELAYS {
                    let mut svm = bought.clone();
                    warp(&mut svm, delay);
                    let held = token_amount(&svm, &ctx.ata(&holder, second));
                    let sell = swap(
                        &mut svm,
                        src,
                        &ctx,
                        &mut parity,
                        &holder,
                        second,
                        first,
                        fees::amount_for_budget(held, 0),
                    );
                    hold.push(json!({
                        "wait": delay.label,
                        "sold": sell.ok,
                        "put_in": buy.spent,
                        "got_back": sell.received,
                        "returned_pct": pct(sell.received, buy.spent),
                        "sell": sell.json,
                    }));
                }
            }
        }
        pair["hold"] = json!(hold);

        // 3. Late: arrive after a wait, buy and sell straight back.
        let mut late = vec![];
        for delay in DELAYS.iter().skip(1) {
            let mut svm = base.clone();
            warp(&mut svm, delay);
            let trader = Keypair::new().pubkey();
            let mut row = round_trip(
                &mut svm,
                src,
                &ctx,
                &mut parity,
                &trader,
                first,
                second,
                amount,
                None,
            );
            row["wait"] = json!(delay.label);
            late.push(row);
        }
        pair["late"] = json!(late);

        // 3b. Rewind: today's state with the clock set back to just after the market was
        //     created, to see launch-time rules (a sniper tax, a trading delay) that have
        //     since lapsed. The state is not what it was then; only the clock is.
        let now: Clock = base.get_sysvar();
        let mut rewind = vec![];
        for (label, after) in [
            ("at creation", 0i64),
            ("10 seconds after", 10),
            ("1 minute after", 60),
            ("10 minutes after", 600),
            ("1 hour after", 3_600),
            ("1 day after", 86_400),
        ] {
            let then = ctx.record.created_at + after;
            if then >= now.unix_timestamp {
                continue;
            }
            let mut svm = base.clone();
            let mut clock = now.clone();
            clock.slot = now
                .slot
                .saturating_sub((now.unix_timestamp - then) as u64 * 5 / 2);
            clock.epoch = now
                .epoch
                .saturating_sub(now.slot / SLOTS_PER_EPOCH - clock.slot / SLOTS_PER_EPOCH);
            clock.leader_schedule_epoch = clock.epoch + 1;
            clock.unix_timestamp = then;
            svm.set_sysvar(&clock);
            let trader = Keypair::new().pubkey();
            let mut row = round_trip(
                &mut svm,
                src,
                &ctx,
                &mut parity,
                &trader,
                first,
                second,
                amount,
                None,
            );
            row["wait"] = json!(label);
            rewind.push(row);
        }
        pair["rewind"] = json!(rewind);

        // 4. Wallets: fresh wallets and the insiders, each from the same starting state.
        let mut wallets = vec![];
        for _ in 0..5 {
            let mut svm = base.clone();
            let trader = Keypair::new().pubkey();
            let mut row = round_trip(
                &mut svm,
                src,
                &ctx,
                &mut parity,
                &trader,
                first,
                second,
                amount,
                None,
            );
            row["who"] = json!("fresh wallet");
            wallets.push(row);
        }
        let mut insiders: Vec<(String, Pubkey)> =
            vec![("market creator".into(), ctx.record.created_by)];
        if let Some(authority) = authority {
            insiders.push(("upgrade authority".into(), authority));
        }
        for i in 0..n {
            if let Some(key) = base
                .get_account(&ctx.mint(i))
                .and_then(|a| coption_key(&a.data[0..36]))
            {
                insiders.push((format!("mint authority of mint {i}"), key));
            }
        }
        let mut seen = BTreeSet::new();
        for (role, key) in insiders {
            if !seen.insert(key) {
                continue;
            }
            // A program-owned address (a PDA with data) cannot trade as a wallet.
            if base
                .get_account(&key)
                .is_some_and(|a| a.owner != client::SYSTEM_PROGRAM_ID)
            {
                wallets.push(
                    json!({ "who": role, "address": key.to_string(), "skipped": "not a wallet" }),
                );
                continue;
            }
            let mut svm = base.clone();
            let mut row = round_trip(
                &mut svm,
                src,
                &ctx,
                &mut parity,
                &key,
                first,
                second,
                amount,
                None,
            );
            row["who"] = json!(role);
            row["address"] = json!(key.to_string());
            wallets.push(row);
        }
        pair["wallets"] = json!(wallets);

        // 5. Transfer: A buys, sends the tokens to B, and B sells them.
        let mut svm = base.clone();
        let (a, b) = (Keypair::new().pubkey(), Keypair::new().pubkey());
        let mut transfer = json!({});
        if fund_trader(&mut svm, &ctx, &a, first, second, budget).is_ok() {
            let buy = swap(&mut svm, src, &ctx, &mut parity, &a, first, second, amount);
            transfer["bought"] = json!(buy.ok);
            if buy.ok && fund_trader(&mut svm, &ctx, &b, first, second, 0).is_ok() {
                let decimals = svm
                    .get_account(&ctx.mint(second))
                    .map(|m| m.data[44])
                    .unwrap_or(0);
                let mut data = vec![12u8];
                data.extend_from_slice(&buy.received.to_le_bytes());
                data.push(decimals);
                let ix = Instruction::new_with_bytes(
                    ctx.tp(second),
                    &data,
                    vec![
                        AccountMeta::new(ctx.ata(&a, second), false),
                        AccountMeta::new_readonly(ctx.mint(second), false),
                        AccountMeta::new(ctx.ata(&b, second), false),
                        AccountMeta::new_readonly(a, true),
                    ],
                );
                match svm.send_transaction(tx(&svm, &a, &[ix])) {
                    Ok(_) => {
                        let arrived = token_amount(&svm, &ctx.ata(&b, second));
                        transfer["transferred"] = json!(true);
                        transfer["sent"] = json!(buy.received);
                        transfer["arrived"] = json!(arrived);
                        let sell = swap(
                            &mut svm,
                            src,
                            &ctx,
                            &mut parity,
                            &b,
                            second,
                            first,
                            fees::amount_for_budget(arrived, 0),
                        );
                        transfer["sold"] = json!(sell.ok);
                        transfer["put_in"] = json!(buy.spent);
                        transfer["got_back"] = json!(sell.received);
                        transfer["returned_pct"] = pct(sell.received, buy.spent);
                        transfer["sell"] = sell.json;
                    }
                    Err(failed) => {
                        transfer["transferred"] = json!(false);
                        transfer["failure"] = failure(
                            "transfer",
                            &format!("{:?}", failed.err),
                            &failed.meta.logs,
                            &ctx,
                        );
                    }
                }
            } else {
                transfer["buy"] = buy.json;
            }
        }
        pair["transfer"] = transfer;

        // 6. Queue: five wallets buy one after another, then leave in the same order.
        let mut svm = base.clone();
        let traders: Vec<Pubkey> = (0..5).map(|_| Keypair::new().pubkey()).collect();
        let money_vault_start = token_amount(&svm, &ctx.vault(first));
        let mut rows = vec![];
        let mut buys = vec![];
        for trader in &traders {
            let _ = fund_trader(&mut svm, &ctx, trader, first, second, budget);
            buys.push(swap(
                &mut svm,
                src,
                &ctx,
                &mut parity,
                trader,
                first,
                second,
                amount,
            ));
        }
        let money_vault_full = token_amount(&svm, &ctx.vault(first));
        let (mut put_in, mut got_back, mut stuck) = (0u64, 0u64, 0u64);
        for (i, (trader, buy)) in traders.iter().zip(&buys).enumerate() {
            if !buy.ok {
                rows.push(json!({ "wallet": i + 1, "bought": false, "buy": buy.json }));
                continue;
            }
            let held = token_amount(&svm, &ctx.ata(trader, second));
            let sell = swap(
                &mut svm,
                src,
                &ctx,
                &mut parity,
                trader,
                second,
                first,
                fees::amount_for_budget(held, 0),
            );
            put_in += buy.spent;
            got_back += sell.received;
            if !sell.ok {
                stuck += 1;
            }
            rows.push(json!({
                "wallet": i + 1,
                "bought": true,
                "sold": sell.ok,
                "put_in": buy.spent,
                "got_back": sell.received,
                "returned_pct": pct(sell.received, buy.spent),
                "failure": sell.json["failure"],
            }));
        }
        pair["queue"] = json!({
            "wallets": rows,
            "put_in": put_in,
            "got_back": got_back,
            "returned_pct": pct(got_back, put_in),
            "could_not_sell": stuck,
            "money_vault": { "start": money_vault_start, "after_buys": money_vault_full, "after_sells": token_amount(&svm, &ctx.vault(first)) },
        });

        // 7. Bypass: call the strategy's pipeline_swap directly, as the router would, but
        //    without the router. A strategy that checks the market signer refuses.
        let mut bypass = vec![];
        for (label, signer, signs) in [
            (
                "another key signs as the market signer",
                Keypair::new().pubkey(),
                true,
            ),
            ("the real market signer, not signing", market, false),
        ] {
            let mut svm = base.clone();
            let trader = Keypair::new().pubkey();
            let _ = fund_trader(&mut svm, &ctx, &trader, first, second, budget);
            let request = trade(first, second, amount, Some(trader));
            let Ok(resolved) = resolve(&mut svm, src, &ctx, &request) else {
                continue;
            };
            let decimals = svm
                .get_account(&ctx.mint(first))
                .map(|m| m.data[44])
                .unwrap_or(0);
            // Send the input to the vault first, as the router does before its call.
            let mut data = vec![12u8];
            data.extend_from_slice(&amount.to_le_bytes());
            data.push(decimals);
            let pay = Instruction::new_with_bytes(
                ctx.tp(first),
                &data,
                vec![
                    AccountMeta::new(ctx.ata(&trader, first), false),
                    AccountMeta::new_readonly(ctx.mint(first), false),
                    AccountMeta::new(ctx.vault(first), false),
                    AccountMeta::new_readonly(trader, true),
                ],
            );
            let mut accounts = vec![
                AccountMeta::new_readonly(signer, signs),
                AccountMeta::new(ctx.record.market_state, false),
                AccountMeta::new_readonly(trader, false),
                AccountMeta::new(ctx.ata(&trader, first), false),
                AccountMeta::new(ctx.ata(&trader, second), false),
                AccountMeta::new(ctx.vault(first), false),
                AccountMeta::new_readonly(ctx.mint(first), false),
                AccountMeta::new_readonly(ctx.mint(second), false),
                AccountMeta::new_readonly(ctx.tp(first), false),
                AccountMeta::new_readonly(ctx.tp(second), false),
            ];
            accounts.extend(resolved);
            let data = psi::instruction_data(
                psi::discriminator::SWAP,
                &psi::SwapRequest {
                    trade: request,
                    amount_sent: amount,
                    min_amount_out: 0,
                },
            );
            let call = Instruction::new_with_bytes(ctx.strategy(), &data, accounts);
            let row = match svm.send_transaction(tx(
                &svm,
                &trader,
                &[compute_ix(MAX_UNITS), pay, call],
            )) {
                Ok(_) => json!({
                    "attempt": label,
                    "accepted": true,
                    "received": token_amount(&svm, &ctx.ata(&trader, second)),
                }),
                Err(failed) => json!({
                    "attempt": label,
                    "accepted": false,
                    "failure": failure("direct pipeline_swap", &format!("{:?}", failed.err), &failed.meta.logs, &ctx),
                }),
            };
            bypass.push(row);
        }
        pair["bypass"] = json!(bypass);

        // 8. Powers: act as each token authority found (signature checks are off), then
        //    trade again. The trust flags say an authority exists; this measures what it
        //    can do to a trader in this market.
        let mut powers = vec![];
        for i in [first, second] {
            let other = if i == first { second } else { first };
            let Some(mint_account) = base.get_account(&ctx.mint(i)) else {
                continue;
            };
            let is_wallet = |key: &Pubkey| {
                base.get_account(key)
                    .is_none_or(|a| a.owner == client::SYSTEM_PROGRAM_ID)
            };
            if let Some(minter) = coption_key(&mint_account.data[0..36]) {
                if !is_wallet(&minter) {
                    powers.push(json!({ "power": "mint authority", "mint": i, "authority": minter.to_string(), "not_run": "the authority is a program's address, not a wallet" }));
                } else {
                    // Mint 100 times what the market's vault holds and sell it all.
                    let mut svm = base.clone();
                    let _ = fund_trader(&mut svm, &ctx, &minter, i, other, 0);
                    let held = token_amount(&svm, &ctx.vault(i));
                    let amount = held.saturating_mul(100).min((u64::MAX - supplies[i]) / 2);
                    let mut data = vec![7u8];
                    data.extend_from_slice(&amount.to_le_bytes());
                    let mint_to = Instruction::new_with_bytes(
                        ctx.tp(i),
                        &data,
                        vec![
                            AccountMeta::new(ctx.mint(i), false),
                            AccountMeta::new(ctx.ata(&minter, i), false),
                            AccountMeta::new_readonly(minter, true),
                        ],
                    );
                    let before = token_amount(&svm, &ctx.vault(other));
                    let mut row = json!({ "power": "mint authority", "mint": i, "authority": minter.to_string(), "minted": amount });
                    match svm.send_transaction(tx(&svm, &minter, &[mint_to])) {
                        Ok(_) => {
                            let sell = swap(
                                &mut svm,
                                src,
                                &ctx,
                                &mut parity,
                                &minter,
                                i,
                                other,
                                fees::amount_for_budget(amount, 0),
                            );
                            let after = token_amount(&svm, &ctx.vault(other));
                            row["sold"] = json!(sell.ok);
                            row["other_vault_before"] = json!(before);
                            row["took"] = json!(before.saturating_sub(after));
                            row["took_pct"] = pct(before.saturating_sub(after), before);
                            row["sell"] = sell.json;
                        }
                        Err(failed) => {
                            row["failure"] = failure(
                                "mint",
                                &format!("{:?}", failed.err),
                                &failed.meta.logs,
                                &ctx,
                            );
                        }
                    }
                    powers.push(row);
                }
            }
            if let Some(freezer) = coption_key(&mint_account.data[46..82]) {
                // Buy, have the freeze authority freeze the buyer's account, then sell.
                let mut svm = base.clone();
                let trader = Keypair::new().pubkey();
                let mut row = json!({ "power": "freeze authority", "mint": i, "authority": freezer.to_string() });
                if i == second
                    && fund_trader(&mut svm, &ctx, &trader, first, second, budget).is_ok()
                {
                    let buy = swap(
                        &mut svm,
                        src,
                        &ctx,
                        &mut parity,
                        &trader,
                        first,
                        second,
                        amount,
                    );
                    fund_wallet(&mut svm, &freezer);
                    let freeze = Instruction::new_with_bytes(
                        ctx.tp(i),
                        &[10u8],
                        vec![
                            AccountMeta::new(ctx.ata(&trader, i), false),
                            AccountMeta::new_readonly(ctx.mint(i), false),
                            AccountMeta::new_readonly(freezer, true),
                        ],
                    );
                    row["bought"] = json!(buy.ok);
                    row["frozen"] =
                        json!(svm.send_transaction(tx(&svm, &freezer, &[freeze])).is_ok());
                    let held = token_amount(&svm, &ctx.ata(&trader, second));
                    let sell = swap(
                        &mut svm,
                        src,
                        &ctx,
                        &mut parity,
                        &trader,
                        second,
                        first,
                        fees::amount_for_budget(held, 0),
                    );
                    row["sold"] = json!(sell.ok);
                    row["sell"] = sell.json;
                }
                powers.push(row);
            }
            if let Some(fee_setter) = transfer_fee_authority(&mint_account.data) {
                // Set the Token-2022 transfer fee to 100%, wait until it applies (two
                // epochs), then round-trip again.
                let mut svm = base.clone();
                fund_wallet(&mut svm, &fee_setter);
                let mut data = vec![26u8, 5u8];
                data.extend_from_slice(&10_000u16.to_le_bytes());
                data.extend_from_slice(&u64::MAX.to_le_bytes());
                let set_fee = Instruction::new_with_bytes(
                    ctx.tp(i),
                    &data,
                    vec![
                        AccountMeta::new(ctx.mint(i), false),
                        AccountMeta::new_readonly(fee_setter, true),
                    ],
                );
                let mut row = json!({ "power": "transfer fee authority", "mint": i, "authority": fee_setter.to_string(), "set_to_bps": 10_000 });
                match svm.send_transaction(tx(&svm, &fee_setter, &[set_fee])) {
                    Ok(_) => {
                        warp(&mut svm, DELAYS.last().unwrap());
                        let trader = Keypair::new().pubkey();
                        row["after"] = round_trip(
                            &mut svm,
                            src,
                            &ctx,
                            &mut parity,
                            &trader,
                            first,
                            second,
                            amount,
                            None,
                        );
                    }
                    Err(failed) => {
                        row["failure"] = failure(
                            "set transfer fee",
                            &format!("{:?}", failed.err),
                            &failed.meta.logs,
                            &ctx,
                        );
                    }
                }
                powers.push(row);
            }
        }
        pair["powers"] = json!(powers);
        exits.push(pair);
    }
    out["exits"] = json!(exits);
    out["quote_parity"] = json!({
        "swaps": parity.swaps,
        "compared": parity.compared,
        "matched": parity.matched,
        "mismatches": parity.mismatches,
        "quote_failed_swap_ok": parity.quote_failed_swap_ok,
        "quote_ok_swap_failed": parity.quote_ok_swap_failed,
        "max_swap_units": parity.max_swap_units,
        "max_strategy_units": parity.max_strategy_units,
    });
    out["transaction_describing_accounts"] = json!(parity.watched_accounts);
    out["tradable_directions"] = json!(tradable);
    out
}

/// One line per market, for the terminal.
fn headline(result: &Value) -> String {
    if let Some(error) = result["clone_error"].as_str() {
        return format!("cannot clone: {error}");
    }
    let pc = &result["pipeline_check"]["summary"];
    let mut parts = vec![format!(
        "pipeline-check {} ({}p {}w {}f {}s)",
        pc["result"].as_str().unwrap_or("?"),
        pc["pass"],
        pc["warn"],
        pc["fail"],
        pc["skip"]
    )];
    if result["readable"]["unreadable"] == true {
        parts.push("this version cannot read the market".into());
    }
    for pair in result["exits"].as_array().into_iter().flatten() {
        let sizes: Vec<String> = pair["sizes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|row| {
                if row["sold"] == true {
                    format!("{}%", row["returned_pct"])
                } else if row["bought"] == true {
                    format!("STUCK[{}]", failure_label(&row["sell"]["failure"]))
                } else {
                    format!("no buy[{}]", failure_label(&row["buy"]["failure"]))
                }
            })
            .collect();
        parts.push(format!(
            "{}>{}>{} sizes: {}",
            pair["money"],
            pair["token"],
            pair["money"],
            sizes.join(", ")
        ));
    }
    let parity = &result["quote_parity"];
    parts.push(format!(
        "quotes matched {}/{}",
        parity["matched"], parity["compared"]
    ));
    parts.join(" | ")
}

/// What happened to one round trip, as a table cell.
fn cell(row: &Value) -> String {
    if row["sold"] == true {
        format!("{}%", row["returned_pct"])
    } else if row["bought"] == true || row["sold"] == false {
        format!("STUCK ({})", failure_label(&row["sell"]["failure"]))
    } else if row["skipped"].is_string() {
        "n/a".into()
    } else if row["buy"]["ok"] == true {
        "the buy took the money and delivered nothing".into()
    } else {
        format!("no buy ({})", failure_label(&row["buy"]["failure"]))
    }
}

/// "98.9% every time" when every run agrees, otherwise each run with its label.
fn series(rows: &[Value], label: &str) -> String {
    if rows.is_empty() {
        return "not run".into();
    }
    let cells: Vec<String> = rows.iter().map(cell).collect();
    if cells.iter().all(|c| *c == cells[0]) {
        return format!("{} ({} runs)", cells[0], cells.len());
    }
    rows.iter()
        .zip(&cells)
        .map(|(row, c)| format!("{}: {c}", row[label].as_str().unwrap_or("?")))
        .collect::<Vec<_>>()
        .join("; ")
}

/// A Markdown summary of every result file in a directory, grouped by strategy.
fn summary(dir: &str) {
    let mut by_strategy: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .expect("dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    paths.sort();
    for path in paths {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(result) = serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap())
        else {
            continue;
        };
        let key = result["strategy"]["program_id"]
            .as_str()
            .unwrap_or("(could not be cloned)")
            .to_string();
        by_strategy.entry(key).or_default().push(result);
    }
    for (strategy, markets) in &by_strategy {
        let first = &markets[0];
        println!("## Strategy `{strategy}`\n");
        println!(
            "Version sha256 `{}`, deployed in slot {}, upgrade authority `{}`.",
            first["strategy"]["executable_sha256"]
                .as_str()
                .unwrap_or("?"),
            first["strategy"]["deploy_slot"],
            first["strategy"]["upgrade_authority"]
                .as_str()
                .unwrap_or("none (frozen)"),
        );
        let custom: Vec<&str> = first["control"]["custom_instructions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .collect();
        println!(
            "Instructions beyond Pipeline's own: {}.",
            if custom.is_empty() {
                "none found".to_string()
            } else {
                custom.join(", ")
            }
        );
        let mut pc: BTreeMap<String, usize> = BTreeMap::new();
        let mut states: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for m in markets {
            *pc.entry(
                m["pipeline_check"]["summary"]["result"]
                    .as_str()
                    .unwrap_or("not run")
                    .to_string(),
            )
            .or_default() += 1;
            let short = m["market"]
                .as_str()
                .unwrap_or("?")
                .chars()
                .take(8)
                .collect::<String>();
            let trades = m["exits"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|p| p["reference_amount"].is_u64());
            let state = if let Some(e) = m["clone_error"].as_str() {
                format!("could not be cloned: {e}")
            } else if trades {
                "trades".to_string()
            } else {
                let probes = m["readable"]["probes"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let labels: BTreeSet<String> = probes
                    .iter()
                    .filter(|p| p["state"]["kind"] != "quotes")
                    .map(|p| failure_label(&p["state"]))
                    .collect();
                let buys: BTreeSet<String> = m["exits"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|p| p["sizes"].as_array().cloned().unwrap_or_default())
                    .filter(|row| row["sold"] != true)
                    .map(|row| cell(&row))
                    .collect();
                if labels.is_empty() {
                    format!(
                        "quotes but no round trip worked: {}",
                        buys.into_iter().collect::<Vec<_>>().join(", ")
                    )
                } else {
                    labels.into_iter().collect::<Vec<_>>().join(", ")
                }
            };
            states.entry(state).or_default().push(short);
        }
        println!(
            "{} markets. `pipeline-check` result: {}.\n",
            markets.len(),
            pc.iter()
                .map(|(k, v)| format!("{v} {k}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        for (state, list) in &states {
            println!("- {} market(s) {}: {}", list.len(), state, list.join(", "));
        }
        println!();
        println!("| Market | Pair | pipeline-check | Round trip by size | Hold then sell | Arrive later | Clock at launch | Wallets | Transferred | Queue of 5 | Quotes = swaps | Direct call | Token authorities acting |");
        println!("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
        for m in markets {
            let short = m["market"]
                .as_str()
                .unwrap_or("?")
                .chars()
                .take(8)
                .collect::<String>();
            let s = &m["pipeline_check"]["summary"];
            let pc = format!(
                "{} ({}p {}w {}f {}s)",
                s["result"].as_str().unwrap_or("?"),
                s["pass"],
                s["warn"],
                s["fail"],
                s["skip"]
            );
            for pair in m["exits"].as_array().into_iter().flatten() {
                if !pair["reference_amount"].is_u64() {
                    continue;
                }
                let rows = |key: &str| pair[key].as_array().cloned().unwrap_or_default();
                let sizes = rows("sizes")
                    .iter()
                    .map(|row| format!("{}: {}", row["amount"], cell(row)))
                    .collect::<Vec<_>>()
                    .join("; ");
                let wallets = rows("wallets");
                let fresh: Vec<Value> = wallets
                    .iter()
                    .filter(|w| w["who"] == "fresh wallet")
                    .cloned()
                    .collect();
                let insiders: Vec<String> = wallets
                    .iter()
                    .filter(|w| w["who"] != "fresh wallet")
                    .map(|w| format!("{}: {}", w["who"].as_str().unwrap_or("?"), cell(w)))
                    .collect();
                let transfer = &pair["transfer"];
                let transferred = if transfer["transferred"] == false {
                    format!("transfer refused ({})", failure_label(&transfer["failure"]))
                } else if transfer["transferred"] == true {
                    cell(transfer)
                } else {
                    "not run".to_string()
                };
                let queue = &pair["queue"];
                let parity = &m["quote_parity"];
                let bypass: Vec<String> = rows("bypass")
                    .iter()
                    .map(|b| {
                        if b["accepted"] == true {
                            "ACCEPTED".to_string()
                        } else {
                            format!("refused ({})", b["failure"]["name"].as_str().unwrap_or("?"))
                        }
                    })
                    .collect();
                let powers: Vec<String> = rows("powers")
                    .iter()
                    .map(|p| {
                        let who = format!(
                            "{} of mint {}",
                            p["power"].as_str().unwrap_or("?"),
                            p["mint"]
                        );
                        if let Some(why) = p["not_run"].as_str() {
                            format!("{who}: not run ({why})")
                        } else if p["power"] == "mint authority" {
                            if p["sold"] == true {
                                format!(
                                    "{who}: mints and sells, takes {}% of the other vault",
                                    p["took_pct"]
                                )
                            } else {
                                format!(
                                    "{who}: minted, sale failed ({})",
                                    failure_label(&p["sell"]["failure"])
                                )
                            }
                        } else if p["power"] == "freeze authority" {
                            format!(
                                "{who}: freezes the buyer, sale {}",
                                if p["sold"] == true {
                                    "still works"
                                } else {
                                    "fails"
                                }
                            )
                        } else if p["after"].is_object() {
                            format!(
                                "{who}: sets the fee to 100%, then a round trip gives {}",
                                cell(&p["after"])
                            )
                        } else {
                            format!("{who}: could not act ({})", failure_label(&p["failure"]))
                        }
                    })
                    .collect();
                let powers = if powers.is_empty() {
                    "none found".to_string()
                } else {
                    powers.join("; ")
                };
                println!(
                    "| `{short}` | {}>{}>{} | {pc} | {sizes} | {} | {} | {} | fresh {}; {} | {transferred} | {} of 5 sold, {}% back in all | {}/{} | {} | {powers} |",
                    pair["money"], pair["token"], pair["money"],
                    series(&rows("hold"), "wait"),
                    series(&rows("late"), "wait"),
                    series(&rows("rewind"), "wait"),
                    series(&fresh, "who"),
                    insiders.join("; "),
                    5 - queue["could_not_sell"].as_u64().unwrap_or(0),
                    queue["returned_pct"],
                    parity["matched"], parity["compared"],
                    bypass.join("; "),
                );
            }
        }
        println!();
    }
}

// ---------------------------------------------------------------------------------------
// The 6002 question from the quoter-hosting research
// ---------------------------------------------------------------------------------------

/// Re-runs the sale that failed with error 6002 in the quoter-hosting probe: once with the
/// buy direction's strategy accounts (the suspected mistake), once with the sale's own.
fn probe6002(src: &mut Source, market: Pubkey) {
    let cloned = clone_market(src, market, None, &CheckOptions::default()).expect("clone");
    let mut svm = cloned.svm.with_sigverify(false).with_blockhash_check(false);
    let record = svm
        .get_account(&market)
        .and_then(|a| client::decode_market(&a.data))
        .expect("market");
    let token_programs = record
        .mints()
        .iter()
        .map(|m| svm.get_account(m).unwrap().owner)
        .collect();
    let view = MarketView::from_market(market, &record, token_programs).expect("view");
    let payer = Keypair::new().pubkey();
    fund_wallet(&mut svm, &payer);
    let ctx = Ctx {
        market,
        record,
        view,
        payer,
    };
    println!(
        "market {market}, strategy {}, slot {}",
        ctx.strategy(),
        cloned.cluster.slot
    );
    println!(
        "router sha256 {}",
        pipeline_check::executable_sha256(&program_elf(&svm, &client::PROGRAM_ID).unwrap()).0
    );

    // The probe quoted mint 0 into mint 1, then tried "the sell direction": mint 1 into mint 0.
    let amount = 100_000u64;
    let buy_accounts =
        resolve(&mut svm, src, &ctx, &trade(0, 1, amount, None)).expect("resolve 0>1");
    let sell_accounts =
        resolve(&mut svm, src, &ctx, &trade(1, 0, amount, None)).expect("resolve 1>0");
    println!(
        "strategy accounts for 0>1: {:?}",
        buy_accounts
            .iter()
            .map(|m| m.pubkey.to_string())
            .collect::<Vec<_>>()
    );
    println!(
        "strategy accounts for 1>0: {:?}",
        sell_accounts
            .iter()
            .map(|m| m.pubkey.to_string())
            .collect::<Vec<_>>()
    );
    println!(
        "vaults: {:?}",
        ctx.view
            .vaults
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
    );

    for (label, strategy_accounts) in [
        ("the buy direction's accounts", &buy_accounts),
        ("the sale's own accounts", &sell_accounts),
    ] {
        let fee_accounts: Vec<Pubkey> = (0..ctx.n())
            .map(|i| pda::fee_account(&market, &ctx.mint(i), &ctx.tp(i)))
            .collect();
        let mut keys = vec![client::PROGRAM_ID, pda::event_authority()];
        keys.extend(fee_accounts);
        keys.extend(strategy_accounts.iter().map(|m| m.pubkey));
        let mut quoter = quoter_from(&svm, &ctx, &keys).expect("quoter");
        let accounts = client::SwapAccounts {
            trader: Pubkey::default(),
            strategy_program: ctx.strategy(),
            market_state: ctx.record.market_state,
            trader_input: Pubkey::default(),
            trader_output: Pubkey::default(),
            input_vault: ctx.vault(1),
            input_mint: ctx.mint(1),
            output_mint: ctx.mint(0),
            input_token_program: ctx.tp(1),
            output_token_program: ctx.tp(0),
            integrator_fee_account: None,
            strategy_accounts: strategy_accounts.clone(),
            input_hook_accounts: vec![],
        };
        let args = client::SwapArgs {
            mode: TradeMode::ExactIn,
            amount_in: amount,
            amount_out: 0,
            min_amount_out: 0,
            integrator_fee_bps: 0,
            input_hook_accounts: 0,
            extra: vec![],
        };
        println!("\nsell 1>0 of {amount} with {label}:");
        match quoter.simulate_swap(&accounts, &args) {
            Ok(result) => println!(
                "  Quoter::simulate_swap ok: received {}, net_sent {}, fee {}",
                result.received, result.net_sent, result.pipeline_fee
            ),
            Err(error) => println!("  Quoter::simulate_swap failed: {error}"),
        }
        // The same swap in the full VM, to read every log line and see who raised the error.
        let mut vm = svm.clone();
        let trader = Keypair::new().pubkey();
        fund_trader(
            &mut vm,
            &ctx,
            &trader,
            1,
            0,
            fees::max_total_spend(amount, 0).unwrap(),
        )
        .expect("fund");
        let mut accounts = accounts;
        accounts.trader = trader;
        accounts.trader_input = ctx.ata(&trader, 1);
        accounts.trader_output = ctx.ata(&trader, 0);
        match vm.send_transaction(tx(
            &vm,
            &trader,
            &[compute_ix(MAX_UNITS), client::swap(&accounts, &args)],
        )) {
            Ok(meta) => {
                let result = client::SwapResult::try_from_slice(&meta.return_data.data).ok();
                println!(
                    "  full VM ok: {:?}",
                    result.map(|r| (r.received, r.net_sent, r.pipeline_fee))
                );
            }
            Err(failed) => {
                let f = failure(
                    "swap",
                    &format!("{:?}", failed.err),
                    &failed.meta.logs,
                    &ctx,
                );
                println!("  full VM failed: {}", failure_label(&f));
                println!("  raised by: {} ({})", f["who"], f["program"]);
                for line in
                    failed.meta.logs.iter().filter(|l| {
                        l.contains("failed") || l.contains("Error") || l.contains("invoke")
                    })
                {
                    println!("    {line}");
                }
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: canary-proto <RPC> list | run <OUT_DIR> <MARKET>... | all <OUT_DIR> | probe6002 <MARKET>";
    if args.get(1).map(String::as_str) == Some("summary") {
        return summary(args.get(2).expect("summary <DIR>"));
    }
    let url = cluster_url(args.get(1).expect(usage)).expect("RPC");
    let mut src = Source {
        rpc: RpcSource::new(&url).expect("rpc"),
        programs: HashMap::new(),
    };
    match args.get(2).map(String::as_str) {
        Some("list") => {
            for (address, market) in src.rpc.markets().expect("markets") {
                println!(
                    "{address} {} {}",
                    market.strategy_program, market.created_at
                );
            }
        }
        Some("probe6002") => probe6002(
            &mut src,
            args.get(3).expect(usage).parse().expect("market address"),
        ),
        Some(mode @ ("run" | "all")) => {
            let out_dir = args.get(3).expect(usage);
            std::fs::create_dir_all(out_dir).expect("out dir");
            let markets: Vec<Pubkey> = if mode == "all" {
                src.rpc
                    .markets()
                    .expect("markets")
                    .into_iter()
                    .map(|(address, _)| address)
                    .collect()
            } else {
                args[4..]
                    .iter()
                    .map(|m| m.parse().expect("market address"))
                    .collect()
            };
            for market in markets {
                let result = run_market(&mut src, market);
                let path = format!("{out_dir}/{market}.json");
                std::fs::write(&path, serde_json::to_string_pretty(&result).unwrap())
                    .expect("write");
                println!(
                    "{market} {} | {}",
                    result["strategy"]["program_id"].as_str().unwrap_or("?"),
                    headline(&result)
                );
            }
            eprintln!("{} RPC requests", src.rpc.requests);
        }
        _ => eprintln!("{usage}"),
    }
}
