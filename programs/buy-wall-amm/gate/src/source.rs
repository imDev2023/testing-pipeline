//! Where accounts come from: a cluster over read-only JSON-RPC, or a LiteSVM (Pipeline's
//! `SvmSource`), each behind pipeline-check's `AccountSource`, and a wrapper that keeps
//! every account it served, which is what a snapshot saves.
//!
//! The JSON-RPC calls go through `curl` rather than an HTTP library: on the owner's Mac a
//! firewall (LuLu) holds back the network calls of every freshly built binary until it is
//! allowed by hand, which would hang the gate after each rebuild, while `curl` is allowed
//! once for good (`POOL4-41`). Only `getMultipleAccounts`, `getProgramAccounts`, `getSlot`,
//! `getEpochInfo`, `getBlockTime` and `getGenesisHash` are called; the gate has no way to
//! send a transaction to a cluster.

use std::collections::BTreeMap;
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use pipeline_check::{AccountSource, ClusterInfo};
use pipeline_client::Pubkey;
use serde_json::{json, Value};
use solana_account::Account;

/// An `AccountSource` that keeps every account it served.
pub struct Recording<'a> {
    inner: &'a mut dyn AccountSource,
    pub served: BTreeMap<String, (Pubkey, Account)>,
}

impl<'a> Recording<'a> {
    pub fn new(inner: &'a mut dyn AccountSource) -> Self {
        Recording {
            inner,
            served: BTreeMap::new(),
        }
    }
}

impl AccountSource for Recording<'_> {
    fn get_accounts(&mut self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, String> {
        let accounts = self.inner.get_accounts(keys)?;
        for (key, account) in keys.iter().zip(&accounts) {
            if let Some(account) = account {
                self.served.insert(key.to_string(), (*key, account.clone()));
            }
        }
        Ok(accounts)
    }

    fn cluster_info(&mut self) -> Result<ClusterInfo, String> {
        self.inner.cluster_info()
    }
}

/// `getMultipleAccounts` takes at most this many addresses a call.
const MAX_ACCOUNTS_PER_CALL: usize = 100;
const ATTEMPTS: u32 = 6;

/// A cluster, over read-only JSON-RPC.
pub struct Rpc {
    url: String,
    /// The highest slot any read was served at; later reads ask for at least this slot
    /// (`minContextSlot`), so a snapshot never mixes in older state.
    highest_slot: u64,
}

/// Expands `devnet`, `localnet` (`localhost`) and `mainnet` (`mainnet-beta`); anything else
/// must be an http(s) URL.
pub fn cluster_url(name: &str) -> Result<String, String> {
    Ok(match name {
        "devnet" => "https://api.devnet.solana.com".into(),
        "localnet" | "localhost" => "http://127.0.0.1:8899".into(),
        "mainnet" | "mainnet-beta" => "https://api.mainnet-beta.solana.com".into(),
        url if url.starts_with("http://") || url.starts_with("https://") => url.into(),
        other => {
            return Err(format!(
                "unknown cluster {other:?}: use devnet, localnet, mainnet or an http(s) URL"
            ))
        }
    })
}

impl Rpc {
    pub fn new(url: &str) -> Self {
        Rpc {
            url: url.to_string(),
            highest_slot: 0,
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// One JSON-RPC call through `curl`, retried with backoff on transport errors, rate
    /// limits and server errors.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let body =
            json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
        let mut delay = Duration::from_millis(500);
        let mut last_error = String::new();
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                std::thread::sleep(delay);
                delay *= 2;
            }
            let output = Command::new("curl")
                .args(["--silent", "--show-error", "--max-time", "60"])
                .args(["--header", "Content-Type: application/json"])
                .args(["--write-out", "\n%{http_code}", "--data-binary", "@-"])
                .arg(&self.url)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .and_then(|mut child| {
                    use std::io::Write;
                    child
                        .stdin
                        .take()
                        .expect("curl's stdin")
                        .write_all(body.as_bytes())?;
                    child.wait_with_output()
                })
                .map_err(|e| format!("cannot run curl: {e}"))?;
            if !output.status.success() {
                last_error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                continue;
            }
            let text = String::from_utf8_lossy(&output.stdout);
            let (response, status) = text.rsplit_once('\n').unwrap_or((&text, ""));
            if status == "429" || status.starts_with('5') {
                last_error = format!("HTTP {status}");
                continue;
            }
            let value: Value = serde_json::from_str(response)
                .map_err(|e| format!("{method}: unreadable response (HTTP {status}): {e}"))?;
            if let Some(error) = value.get("error") {
                return Err(format!("{method}: {error}"));
            }
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| format!("{method}: the response has no result"));
        }
        Err(format!("{method}: {last_error}"))
    }

    /// The addresses of every account `program` owns whose data starts with `prefix`.
    pub fn program_accounts(
        &mut self,
        program: &Pubkey,
        prefix: &[u8],
    ) -> Result<Vec<(Pubkey, usize)>, String> {
        let bytes = base64::engine::general_purpose::STANDARD.encode(prefix);
        let result = self.call(
            "getProgramAccounts",
            json!([
                program.to_string(),
                {
                    "encoding": "base64",
                    "commitment": "confirmed",
                    "withContext": true,
                    "filters": [{ "memcmp": { "offset": 0, "bytes": bytes, "encoding": "base64" } }],
                }
            ]),
        )?;
        if let Some(slot) = result["context"]["slot"].as_u64() {
            self.highest_slot = self.highest_slot.max(slot);
        }
        let entries = result["value"]
            .as_array()
            .ok_or("getProgramAccounts: expected a list")?;
        entries
            .iter()
            .map(|entry| {
                let address = entry["pubkey"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .ok_or("getProgramAccounts: a bad address")?;
                let account = parse_account(&entry["account"])?
                    .ok_or("getProgramAccounts: a null account")?;
                Ok((address, account.data.len()))
            })
            .collect()
    }

    pub fn genesis_hash(&mut self) -> Result<String, String> {
        self.call("getGenesisHash", json!([]))?
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "getGenesisHash: expected a string".into())
    }
}

impl AccountSource for Rpc {
    fn get_accounts(&mut self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, String> {
        let mut accounts = Vec::with_capacity(keys.len());
        for chunk in keys.chunks(MAX_ACCOUNTS_PER_CALL) {
            let addresses: Vec<String> = chunk.iter().map(Pubkey::to_string).collect();
            let mut config = json!({ "encoding": "base64", "commitment": "confirmed" });
            if self.highest_slot > 0 {
                config["minContextSlot"] = json!(self.highest_slot);
            }
            let result = self.call("getMultipleAccounts", json!([addresses, config]))?;
            if let Some(slot) = result["context"]["slot"].as_u64() {
                self.highest_slot = self.highest_slot.max(slot);
            }
            let values = result["value"]
                .as_array()
                .ok_or("getMultipleAccounts: expected a list")?;
            if values.len() != chunk.len() {
                return Err("getMultipleAccounts: the wrong number of accounts".into());
            }
            for value in values {
                accounts.push(parse_account(value)?);
            }
        }
        Ok(accounts)
    }

    fn cluster_info(&mut self) -> Result<ClusterInfo, String> {
        let slot = self
            .call("getSlot", json!([{ "commitment": "confirmed" }]))?
            .as_u64()
            .ok_or("getSlot: expected a number")?;
        self.highest_slot = self.highest_slot.max(slot);
        let epoch = self.call("getEpochInfo", json!([{ "commitment": "confirmed" }]))?["epoch"]
            .as_u64()
            .ok_or("getEpochInfo: no epoch")?;
        // A recent slot may have no block time yet; the local clock is close enough.
        let unix_timestamp = self
            .call("getBlockTime", json!([slot]))
            .ok()
            .and_then(|v| v.as_i64())
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs() as i64)
            });
        Ok(ClusterInfo {
            slot,
            epoch,
            unix_timestamp,
            genesis_hash: Some(self.genesis_hash()?),
        })
    }
}

fn parse_account(value: &Value) -> Result<Option<Account>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let data = value["data"][0]
        .as_str()
        .ok_or("an account has no base64 data")?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("account data is not base64: {e}"))?;
    let owner = value["owner"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or("an account has a bad owner")?;
    Ok(Some(Account {
        lamports: value["lamports"]
            .as_u64()
            .ok_or("an account has no lamports")?,
        data,
        owner,
        executable: value["executable"].as_bool().unwrap_or(false),
        // Read as a float when it overflows JSON's integers (u64::MAX for rent-exempt accounts).
        rent_epoch: value["rentEpoch"]
            .as_u64()
            .or_else(|| value["rentEpoch"].as_f64().map(|f| f as u64))
            .unwrap_or(0),
    }))
}
