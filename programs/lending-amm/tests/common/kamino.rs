//! Kamino Lend in the tests: the accounts dumped from the cluster this build lends on, and
//! klend's deployed program (docs/spec/README.md, "Test layers", layer 6).
//!
//! - The accounts are committed in `tests/fixtures/kamino/<cluster>/`, written by
//!   `scripts/kamino_accounts.py dump` with the slot they were read at, since an RPC cannot
//!   serve an account's past state. The `devnet` build loads our devnet lending market's, the
//!   `mainnet` build Kamino's main market's.
//! - klend's bytes are never committed: `scripts/fetch-klend.sh` copies them into
//!   `fixtures/klend/<cluster>.so`, checked against the hashes pinned in `fixtures/pins.env`
//!   (set `KLEND_SO` to read another file).
//!
//! klend's instructions are written by hand from klend 1.28.0, as the program's own Kamino
//! module is: nothing here depends on klend's crate (BSL 1.1).

use std::path::PathBuf;

use base64::Engine;
use litesvm::LiteSVM;
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use serde_json::Value;

/// Kamino Lend's program, the same address on every cluster.
pub fn klend() -> Pubkey {
    super::ck(&lending_amm::config::KLEND_PROGRAM)
}

/// The cluster this build lends on, and whose Kamino accounts it is tested against.
pub fn cluster() -> &'static str {
    if cfg!(feature = "mainnet") {
        "mainnet"
    } else {
        "devnet"
    }
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// One dumped account.
#[derive(Clone, Debug)]
pub struct Dumped {
    pub label: String,
    pub address: Pubkey,
    pub account: solana_account::Account,
}

/// The committed dump of a cluster's Kamino accounts.
#[derive(Clone, Debug)]
pub struct Fixtures {
    pub cluster: String,
    /// The slot every account was read at.
    pub slot: u64,
    /// That slot's Unix time.
    pub unix_timestamp: i64,
    pub accounts: Vec<Dumped>,
}

impl Fixtures {
    /// The committed dump for `cluster`.
    pub fn load(cluster: &str) -> Self {
        let dir = crate_dir().join("tests/fixtures/kamino").join(cluster);
        let read = |name: &str| -> Value {
            let path = dir.join(name);
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            serde_json::from_str(&text).unwrap()
        };
        let manifest = read("manifest.json");
        let accounts = manifest["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                let label = entry["label"].as_str().unwrap().to_string();
                let record = read(&format!("{label}.json"));
                let account = &record["account"];
                let data = base64::engine::general_purpose::STANDARD
                    .decode(account["data"][0].as_str().unwrap())
                    .unwrap();
                Dumped {
                    address: record["pubkey"].as_str().unwrap().parse().unwrap(),
                    account: solana_account::Account {
                        lamports: account["lamports"].as_u64().unwrap(),
                        data,
                        owner: account["owner"].as_str().unwrap().parse().unwrap(),
                        executable: account["executable"].as_bool().unwrap(),
                        rent_epoch: 0,
                    },
                    label,
                }
            })
            .collect();
        Fixtures {
            cluster: manifest["cluster"].as_str().unwrap().to_string(),
            slot: manifest["slot"].as_u64().unwrap(),
            unix_timestamp: manifest["unixTimestamp"].as_i64().unwrap(),
            accounts,
        }
    }

    /// The committed dump for this build's cluster.
    pub fn of_build() -> Self {
        Self::load(cluster())
    }

    /// The dumped account labelled `label`.
    pub fn get(&self, label: &str) -> &Dumped {
        self.accounts
            .iter()
            .find(|a| a.label == label)
            .unwrap_or_else(|| panic!("no {label} in the {} dump", self.cluster))
    }

    /// The address labelled `label`; the lending market's authority may have no account.
    pub fn address(&self, label: &str) -> Pubkey {
        match self.accounts.iter().find(|a| a.label == label) {
            Some(dumped) => dumped.address,
            None if label == "lending-market-authority" => {
                let market = self.address("lending-market");
                Pubkey::find_program_address(&[b"lma", market.as_ref()], &klend()).0
            }
            None => panic!("no {label} in the {} dump", self.cluster),
        }
    }

    /// Writes every dumped account into the VM, at its address.
    pub fn install(&self, svm: &mut LiteSVM) {
        for dumped in &self.accounts {
            svm.set_account(dumped.address, dumped.account.clone())
                .unwrap();
        }
    }
}

/// The name a dump gives a lent mint: `sol` for the first entry of `LENT_MINTS`, `usdc` for
/// the second.
pub fn lent_name(i: usize) -> &'static str {
    ["sol", "usdc"][i]
}

/// klend's deployed program for this build's cluster.
pub fn klend_so() -> Vec<u8> {
    let path = std::env::var("KLEND_SO")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            crate_dir()
                .join("../../fixtures/klend")
                .join(format!("{}.so", cluster()))
        });
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Run `bash programs/lending-amm/scripts/fetch-klend.sh` first.",
            path.display()
        )
    })
}

/// Anchor's instruction discriminator for one of klend's instructions.
fn klend_discriminator(name: &str) -> [u8; 8] {
    super::anchor_discriminator(name)
}

/// klend's `redeem_reserve_collateral { collateral_amount }`: burns `owner`'s cTokens from
/// `source_collateral` and pays the lent mint into `destination_liquidity`. The accounts in
/// the order klend 1.28.0 declares them.
pub fn redeem_reserve_collateral(
    fixtures: &Fixtures,
    lent: usize,
    owner: &Pubkey,
    source_collateral: &Pubkey,
    destination_liquidity: &Pubkey,
    collateral_amount: u64,
) -> Instruction {
    let name = lent_name(lent);
    let mut data = klend_discriminator("redeem_reserve_collateral").to_vec();
    data.extend_from_slice(&collateral_amount.to_le_bytes());
    Instruction::new_with_bytes(
        klend(),
        &data,
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new_readonly(fixtures.address("lending-market"), false),
            AccountMeta::new(fixtures.address(&format!("reserve-{name}")), false),
            AccountMeta::new_readonly(fixtures.address("lending-market-authority"), false),
            AccountMeta::new_readonly(fixtures.address(&format!("liquidity-mint-{name}")), false),
            AccountMeta::new(fixtures.address(&format!("collateral-mint-{name}")), false),
            AccountMeta::new(fixtures.address(&format!("liquidity-supply-{name}")), false),
            AccountMeta::new(*source_collateral, false),
            AccountMeta::new(*destination_liquidity, false),
            AccountMeta::new_readonly(super::TOKEN, false),
            AccountMeta::new_readonly(super::TOKEN, false),
            AccountMeta::new_readonly(instructions_sysvar(), false),
        ],
    )
}

/// The instructions sysvar, which klend's redeem introspects.
pub fn instructions_sysvar() -> Pubkey {
    "Sysvar1nstructions1111111111111111111111111"
        .parse()
        .unwrap()
}
