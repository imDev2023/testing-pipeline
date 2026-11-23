//! Kamino Lend in the gate: the accounts of each lent mint's reserve the gate copies and
//! replays, bringing a reserve's stored rate up to date in the replay, and klend's instructions
//! the gate sends, written by hand from klend 1.28.0 as the program's own Kamino module is
//! (nothing here depends on klend's crate, BSL 1.1).
//!
//! A reserve on devnet may have gone millions of slots without a refresh, and a quote or a swap
//! refuses a reserve not refreshed within `TRADE_MAX_RESERVE_AGE_SLOTS`. A keeper or a trader
//! puts klend's `refresh_reserve` first, with the reserve's oracle; the replay has no live
//! oracle, so [`refresh_all`] marks each reserve's saved price as checked and updated now and
//! makes the lending market read an oracle only for a price as old as its maximum age, then
//! refreshes it with klend's own id in the oracle slots, as the lending AMM's tests do
//! (`programs/lending-amm/tests/common/states.rs`). Klend accrues the interest since the
//! reserve's last refresh, at the snapshot's clock. Every replay of a snapshot does the same,
//! the deployed build's and the candidate's alike, so their quotes compare on the same state.

use lending_amm::config::{LentMint, KLEND_PROGRAM, LENT_MINTS};
use lending_amm::kamino::{lending_market_offsets, offsets, LENDING_MARKET_AUTHORITY_SEED};
use litesvm::LiteSVM;
use pipeline_client::{AccountMeta, Instruction, Pubkey};

/// The lending market's `price_refresh_trigger_to_max_age_pct`.
const MARKET_PRICE_REFRESH_TRIGGER_PCT: usize = 125;
/// A reserve's `last_update.price_status` byte.
const RESERVE_PRICE_STATUS: usize = 25;
/// A reserve's `liquidity.market_price_last_updated_ts`.
const RESERVE_PRICE_UPDATED_AT: usize = 264;
/// Every price check klend makes passed (`PriceStatusFlags::ALL_CHECKS`).
const ALL_PRICE_CHECKS: u8 = 0b11_1111;

/// Kamino Lend's program, the same address on every cluster.
pub fn klend() -> Pubkey {
    key(&KLEND_PROGRAM)
}

/// The instructions sysvar, which klend's deposit and redeem introspect.
pub fn instructions_sysvar() -> Pubkey {
    key(&lending_amm::kamino::INSTRUCTIONS_SYSVAR)
}

pub fn key(anchor: &anchor_lang::prelude::Pubkey) -> Pubkey {
    Pubkey::new_from_array(anchor.to_bytes())
}

/// The Kamino accounts of one lent mint that `rebalance`, a swap's redeem and a removal touch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accounts {
    pub mint: Pubkey,
    pub reserve: Pubkey,
    pub lending_market: Pubkey,
    pub lending_market_authority: Pubkey,
    pub collateral_mint: Pubkey,
    /// The reserve's liquidity supply, read from the reserve.
    pub liquidity_supply: Pubkey,
}

impl Accounts {
    /// The accounts of `entry`, the liquidity supply read from the reserve's data.
    pub fn of(entry: &LentMint, reserve_data: &[u8]) -> Option<Self> {
        let lending_market = key(&entry.lending_market);
        Some(Accounts {
            mint: key(&entry.mint),
            reserve: key(&entry.reserve),
            lending_market,
            lending_market_authority: lending_market_authority(&lending_market),
            collateral_mint: key(&entry.collateral_mint),
            liquidity_supply: Pubkey::new_from_array(
                reserve_data
                    .get(offsets::LIQUIDITY_SUPPLY..offsets::LIQUIDITY_SUPPLY + 32)?
                    .try_into()
                    .ok()?,
            ),
        })
    }

    /// The accounts of the lent mint `mint`, read from `svm`.
    pub fn in_svm(svm: &LiteSVM, mint: &Pubkey) -> Result<Self, String> {
        let entry = entry_of(mint).ok_or_else(|| format!("{mint} is not a lent mint"))?;
        let reserve = svm
            .get_account(&key(&entry.reserve))
            .ok_or_else(|| format!("the reserve {} is missing", key(&entry.reserve)))?;
        Self::of(entry, &reserve.data).ok_or_else(|| "the reserve is too short".to_string())
    }

    /// Every address here, for copying them from a cluster.
    pub fn addresses(&self) -> [Pubkey; 6] {
        [
            self.mint,
            self.reserve,
            self.lending_market,
            self.lending_market_authority,
            self.collateral_mint,
            self.liquidity_supply,
        ]
    }
}

/// The `LENT_MINTS` entry of `mint`, on the cluster this tree is built for.
pub fn entry_of(mint: &Pubkey) -> Option<&'static LentMint> {
    LENT_MINTS.iter().find(|entry| key(&entry.mint) == *mint)
}

/// The lending market's authority, klend's PDA `["lma", lending_market]`.
pub fn lending_market_authority(lending_market: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[LENDING_MARKET_AUTHORITY_SEED, lending_market.as_ref()],
        &klend(),
    )
    .0
}

/// The program's view of the reserve of `mint` as `svm` holds it.
pub fn reserve(svm: &LiteSVM, mint: &Pubkey) -> Result<lending_amm::kamino::Reserve, String> {
    let entry = entry_of(mint).ok_or_else(|| format!("{mint} is not a lent mint"))?;
    let data = svm
        .get_account(&key(&entry.reserve))
        .ok_or("the reserve is missing")?
        .data;
    lending_amm::kamino::read_reserve(&entry.reserve, &KLEND_PROGRAM, &data, entry)
        .map_err(|e| format!("the reserve does not read: {e:?}"))
}

/// klend's `refresh_reserve`, with klend's own id in the four oracle slots.
pub fn refresh_reserve(accounts: &Accounts) -> Instruction {
    let mut metas = vec![
        AccountMeta::new(accounts.reserve, false),
        AccountMeta::new_readonly(accounts.lending_market, false),
    ];
    metas.extend((0..4).map(|_| AccountMeta::new_readonly(klend(), false)));
    Instruction::new_with_bytes(klend(), &lending_amm::kamino::REFRESH_RESERVE, metas)
}

/// Brings the stored rate of every lent mint's reserve in `svm` up to date at its clock, with
/// `send` sending klend's `refresh_reserve`; a reserve klend will not refresh (in a lending
/// market in emergency mode, say) is left as it was, and the reason returned, since quotes and
/// swaps then fail alike under every build.
pub fn refresh_all(
    svm: &mut LiteSVM,
    mut send: impl FnMut(&mut LiteSVM, Instruction) -> Result<(), String>,
) -> Vec<String> {
    let mut notes = vec![];
    if svm.get_account(&klend()).is_none_or(|a| !a.executable) {
        return vec!["klend is not loaded, so no reserve was refreshed".into()];
    }
    let now: solana_clock::Clock = svm.get_sysvar();
    for entry in &LENT_MINTS {
        let Ok(accounts) = Accounts::in_svm(svm, &key(&entry.mint)) else {
            continue;
        };
        if svm.get_account(&accounts.lending_market).is_none() {
            continue;
        }
        patch(
            svm,
            &accounts.lending_market,
            MARKET_PRICE_REFRESH_TRIGGER_PCT,
            &[100],
        );
        patch(
            svm,
            &accounts.reserve,
            RESERVE_PRICE_STATUS,
            &[ALL_PRICE_CHECKS],
        );
        patch(
            svm,
            &accounts.reserve,
            RESERVE_PRICE_UPDATED_AT,
            &(now.unix_timestamp as u64).to_le_bytes(),
        );
        if let Err(error) = send(svm, refresh_reserve(&accounts)) {
            notes.push(format!(
                "klend refused to refresh reserve {}: {}",
                accounts.reserve,
                release_gate::errors::first_line(&error)
            ));
        }
    }
    notes
}

/// Clears what lets Kamino's owner and council stop a reserve (its emergency mode, its
/// `block_ctoken_usage`, the lending market's emergency mode), for the gate's own market only:
/// a stop on the cluster must not refuse every candidate there, an emergency fix among them.
pub fn clear_stops(svm: &mut LiteSVM) {
    for entry in &LENT_MINTS {
        let Ok(accounts) = Accounts::in_svm(svm, &key(&entry.mint)) else {
            continue;
        };
        patch(svm, &accounts.reserve, offsets::EMERGENCY_MODE, &[0]);
        patch(svm, &accounts.reserve, offsets::BLOCK_CTOKEN_USAGE, &[0]);
        patch(
            svm,
            &accounts.lending_market,
            lending_market_offsets::EMERGENCY_MODE,
            &[0],
        );
    }
}

/// What a second depositor keeps freely available in each reserve for the gate's own market,
/// by `LENT_MINTS` entry: 2,500 SOL and 100,000 USDC, as in the lending AMM's tests
/// (`programs/lending-amm/tests/common/kamino.rs`), so the cluster's Kamino liquidity at the
/// time of the run, which a test borrower may have borrowed down, cannot put that market into
/// withdraw mode or leave its sale beyond the buffer unpaid.
pub const OWN_MARKET_FREE: [u64; 2] = [2_500_000_000_000, 100_000_000_000];

/// Tops each reserve up to [`OWN_MARKET_FREE`] as klend's own deposit by a second depositor
/// would leave it: the liquidity joins the reserve's liquidity supply (lamports and all, for
/// WSOL) and its `total_available_amount`, and the cTokens it is worth at the reserve's rate,
/// rounded down as klend rounds, join the reserve's and the collateral mint's supply, so the
/// rate never falls.
pub fn second_depositor(svm: &mut LiteSVM) -> Result<(), String> {
    for (i, entry) in LENT_MINTS.iter().enumerate() {
        let Ok(accounts) = Accounts::in_svm(svm, &key(&entry.mint)) else {
            continue;
        };
        let read = reserve(svm, &accounts.mint)?;
        let Some(deposit) = OWN_MARKET_FREE[i]
            .checked_sub(read.freely_available())
            .filter(|d| *d > 0)
        else {
            continue;
        };
        let ctokens = lending_amm::kamino::ctokens_for_value(
            deposit,
            read.total_supply_sf().map_err(|e| format!("{e:?}"))?,
            read.mint_total_supply,
        )
        .ok_or("the reserve has no supply")?;
        add_u64(
            svm,
            &accounts.reserve,
            offsets::TOTAL_AVAILABLE_AMOUNT,
            deposit,
        )?;
        add_u64(svm, &accounts.reserve, offsets::MINT_TOTAL_SUPPLY, ctokens)?;
        add_u64(svm, &accounts.liquidity_supply, 64, deposit)?;
        if entry.mint == lending_amm::config::WSOL {
            let mut vault = svm
                .get_account(&accounts.liquidity_supply)
                .ok_or("the liquidity supply is missing")?;
            vault.lamports += deposit;
            svm.set_account(accounts.liquidity_supply, vault)
                .map_err(|e| e.to_string())?;
        }
        add_u64(svm, &accounts.collateral_mint, 36, ctokens)?;
    }
    Ok(())
}

fn add_u64(svm: &mut LiteSVM, address: &Pubkey, at: usize, amount: u64) -> Result<(), String> {
    let mut account = svm
        .get_account(address)
        .ok_or_else(|| format!("{address} is missing"))?;
    let field = account
        .data
        .get_mut(at..at + 8)
        .ok_or_else(|| format!("{address} is too short"))?;
    let value = u64::from_le_bytes(field.try_into().expect("8 bytes")) + amount;
    field.copy_from_slice(&value.to_le_bytes());
    svm.set_account(*address, account)
        .map_err(|e| e.to_string())
}

fn patch(svm: &mut LiteSVM, address: &Pubkey, at: usize, bytes: &[u8]) {
    if let Some(mut account) = svm.get_account(address) {
        if let Some(field) = account.data.get_mut(at..at + bytes.len()) {
            field.copy_from_slice(bytes);
            let _ = svm.set_account(*address, account);
        }
    }
}
