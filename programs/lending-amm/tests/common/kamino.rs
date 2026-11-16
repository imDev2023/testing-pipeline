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

/// What the second depositor keeps freely available in each reserve the tests lend to, by
/// `LENT_MINTS` entry: 2,500 SOL and 100,000 USDC (docs/spec/lending-pool.md, "Devnet").
///
/// A reserve that held only our markets' own deposits would put every market into withdraw
/// mode at its first `rebalance`; on devnet our own wallet plays the second depositor for that
/// reason. Our devnet WSOL reserve was dumped with 5 SOL free, against the tests' 50 SOL
/// markets, so the `devnet` build's tests top it up; the mainnet reserves and our devnet USDC
/// reserve hold more already and are left as dumped. 2,500 SOL keeps the WSOL reserve's total
/// supply under half its 10,000 SOL deposit limit, so klend still takes the markets' deposits
/// when a test gives the reserve as much borrowed as it has free.
pub const SECOND_DEPOSITOR_FREE: [u64; 2] = [2_500 * super::SOL, 100_000 * 1_000_000];

/// Tops each reserve the build lends to up to [`SECOND_DEPOSITOR_FREE`], as klend's own
/// `deposit_reserve_liquidity` by a second depositor would leave it: the liquidity joins the
/// reserve's liquidity supply (lamports and all, for WSOL) and its `total_available_amount`, and
/// the cTokens it is worth at the reserve's rate, rounded down as klend rounds, are minted into
/// a token account of the depositor's, so the rate never falls.
pub fn second_depositor(svm: &mut LiteSVM, fixtures: &Fixtures) {
    use lending_amm::kamino::offsets;
    let u64_at = |data: &[u8], at: usize| u64::from_le_bytes(data[at..at + 8].try_into().unwrap());
    for (i, entry) in lending_amm::config::LENT_MINTS.iter().enumerate() {
        let name = lent_name(i);
        let address = fixtures.address(&format!("reserve-{name}"));
        let mut reserve = svm.get_account(&address).unwrap();
        let read = lending_amm::kamino::read_reserve(
            &entry.reserve,
            &lending_amm::config::KLEND_PROGRAM,
            &reserve.data,
            entry,
        )
        .unwrap();
        let free = read.freely_available();
        let Some(deposit) = SECOND_DEPOSITOR_FREE[i]
            .checked_sub(free)
            .filter(|d| *d > 0)
        else {
            continue;
        };
        let ctokens = lending_amm::kamino::ctokens_for_value(
            deposit,
            read.total_supply_sf().unwrap(),
            read.mint_total_supply,
        )
        .unwrap();
        let available = u64_at(&reserve.data, offsets::TOTAL_AVAILABLE_AMOUNT) + deposit;
        reserve.data[offsets::TOTAL_AVAILABLE_AMOUNT..][..8]
            .copy_from_slice(&available.to_le_bytes());
        let supply = read.mint_total_supply + ctokens;
        reserve.data[offsets::MINT_TOTAL_SUPPLY..][..8].copy_from_slice(&supply.to_le_bytes());
        svm.set_account(address, reserve).unwrap();

        let vault_address = fixtures.address(&format!("liquidity-supply-{name}"));
        let mut vault = svm.get_account(&vault_address).unwrap();
        let held = u64_at(&vault.data, 64) + deposit;
        vault.data[64..72].copy_from_slice(&held.to_le_bytes());
        if entry.mint == lending_amm::config::WSOL {
            vault.lamports += deposit;
        }
        svm.set_account(vault_address, vault).unwrap();

        let mint_address = fixtures.address(&format!("collateral-mint-{name}"));
        let mut mint = svm.get_account(&mint_address).unwrap();
        let minted = u64_at(&mint.data, 36) + ctokens;
        mint.data[36..44].copy_from_slice(&minted.to_le_bytes());
        svm.set_account(mint_address, mint).unwrap();
        super::write_token_account(
            svm,
            &mint_address,
            &super::TOKEN,
            &Pubkey::new_unique(),
            ctokens,
        )
        .unwrap();
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

/// klend's `refresh_reserve`, with no oracle account: klend reads the oracle only when the
/// reserve's saved price is old enough to need refreshing, so a test that wants a refresh
/// without one first marks the saved price as just updated. Accounts as klend 1.28.0 declares
/// them, the four optional oracles left out with klend's own id in their place.
pub fn refresh_reserve(fixtures: &Fixtures, lent: usize) -> Instruction {
    let name = lent_name(lent);
    Instruction::new_with_bytes(
        klend(),
        &klend_discriminator("refresh_reserve"),
        vec![
            AccountMeta::new(fixtures.address(&format!("reserve-{name}")), false),
            AccountMeta::new_readonly(fixtures.address("lending-market"), false),
            AccountMeta::new_readonly(klend(), false),
            AccountMeta::new_readonly(klend(), false),
            AccountMeta::new_readonly(klend(), false),
            AccountMeta::new_readonly(klend(), false),
        ],
    )
}

/// klend's `refresh_obligation` for an obligation whose only reserve is `LENT_MINTS[lent]`'s,
/// passed after the two declared accounts as klend expects (deposits, then borrows).
pub fn refresh_obligation(fixtures: &Fixtures, lent: usize, obligation: &Pubkey) -> Instruction {
    let name = lent_name(lent);
    Instruction::new_with_bytes(
        klend(),
        &klend_discriminator("refresh_obligation"),
        vec![
            AccountMeta::new_readonly(fixtures.address("lending-market"), false),
            AccountMeta::new(*obligation, false),
            AccountMeta::new_readonly(fixtures.address(&format!("reserve-{name}")), false),
        ],
    )
}

/// klend's `socialize_loss { liquidity_amount }`: the lending market's owner forgives up to
/// `liquidity_amount` of an obligation's debt to `LENT_MINTS[lent]`'s reserve, which lowers the
/// reserve's total supply, and so its rate. klend requires `refresh_reserve` and
/// `refresh_obligation` right before it in the same transaction.
pub fn socialize_loss(
    fixtures: &Fixtures,
    lent: usize,
    owner: &Pubkey,
    obligation: &Pubkey,
    liquidity_amount: u64,
) -> Instruction {
    let name = lent_name(lent);
    let mut data = klend_discriminator("socialize_loss").to_vec();
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    Instruction::new_with_bytes(
        klend(),
        &data,
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*obligation, false),
            AccountMeta::new_readonly(fixtures.address("lending-market"), false),
            AccountMeta::new(fixtures.address(&format!("reserve-{name}")), false),
            AccountMeta::new_readonly(instructions_sysvar(), false),
        ],
    )
}

/// Byte offsets in klend 1.28.0's accounts that only the tests edit, read from the Rust structs
/// and checked against the generated layouts of Kamino's MIT-licensed SDK
/// (`@kamino-finance/klend-sdk`, as `scripts/kamino-devnet` pins it).
pub mod klend_layout {
    /// The lending market's owner, who signs `socialize_loss`.
    pub const MARKET_OWNER: usize = 24;
    /// The lending market's `price_refresh_trigger_to_max_age_pct`: klend reads a reserve's
    /// oracle at a refresh once its saved price is this share of its maximum age old; at 0, the
    /// value both dumps hold, it reads it at every refresh.
    pub const MARKET_PRICE_REFRESH_TRIGGER_PCT: usize = 125;
    /// A reserve's `last_update.slot` (u64) and `last_update.timestamp` (u32), from which klend
    /// accrues interest at a refresh.
    pub const RESERVE_LAST_UPDATE_SLOT: usize = 16;
    pub const RESERVE_LAST_UPDATE_TIMESTAMP: usize = 28;
    /// A reserve's `last_update.price_status` byte.
    pub const RESERVE_PRICE_STATUS: usize = 25;
    /// A reserve's debt farm, which klend refreshes around `socialize_loss` when it is set.
    pub const RESERVE_FARM_DEBT: usize = 96;
    /// A reserve's `liquidity.market_price_last_updated_ts`.
    pub const RESERVE_PRICE_UPDATED_AT: usize = 264;
    /// A reserve's `liquidity.cumulative_borrow_rate_bsf`, 48 bytes.
    pub const RESERVE_CUMULATIVE_BORROW_RATE: usize = 296;
    /// An obligation's size, discriminator included.
    pub const OBLIGATION_LEN: usize = 3_344;
    pub const OBLIGATION_LENDING_MARKET: usize = 32;
    pub const OBLIGATION_OWNER: usize = 64;
    /// `borrows[0]`: its reserve, its cumulative borrow rate (48 bytes), when it was borrowed
    /// and how much is borrowed (u128, 60 fractional bits).
    pub const OBLIGATION_BORROW_RESERVE: usize = 1_208;
    pub const OBLIGATION_BORROW_RATE: usize = 1_240;
    pub const OBLIGATION_BORROWED_AT: usize = 1_288;
    pub const OBLIGATION_BORROWED_SF: usize = 1_296;
    pub const OBLIGATION_HAS_DEBT: usize = 2_287;
    /// Every price check klend makes passed (`PriceStatusFlags::ALL_CHECKS`).
    pub const ALL_PRICE_CHECKS: u8 = 0b11_1111;
    /// `sha256("account:Obligation")[..8]`.
    pub const OBLIGATION_DISCRIMINATOR: [u8; 8] = [168, 206, 141, 106, 88, 76, 172, 167];
}
