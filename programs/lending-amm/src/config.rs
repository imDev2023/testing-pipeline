//! The lending AMM's build-time values, in one place, so each is cheap to find and change
//! (docs/spec/lending-pool.md, "Constants").
//!
//! Every value here is compiled into the program: changing one is a program upgrade, which
//! ends when the program is frozen. Values a market creator chooses are creation parameters
//! instead (`crate::params::InitParams`), and the mint extension allowlist for the other
//! side lives in the `mint-rules` crate, which the suite's programs share.
//!
//! `LENT_MINTS` depends on the cluster the program is built for, chosen by the `devnet` or
//! `mainnet` feature (exactly one; `devnet` is the default). The devnet rows must equal
//! `deployments/kamino-devnet.json`, which `tests/policy_values.rs` checks.
//!
//! Like every decision in the spec, these are defaults MetalLegBob may change.

use anchor_lang::prelude::*;

#[cfg(all(feature = "devnet", feature = "mainnet"))]
compile_error!(
    "build the lending AMM for one cluster: the `devnet` or the `mainnet` feature, not both"
);
#[cfg(not(any(feature = "devnet", feature = "mainnet")))]
compile_error!("build the lending AMM for a cluster: the `devnet` or the `mainnet` feature");

/// The buffer's target share of the lent side's total, in basis points: 20%. Exported in the
/// IDL, as is the band, from which forms, keepers and the demo read them.
#[constant]
pub const BUFFER_TARGET_BPS: u16 = 2_000;
/// The band: `rebalance` acts only when the buffer's share is below this...
#[constant]
pub const BUFFER_MIN_BPS: u16 = 1_000;
/// ...or above this.
#[constant]
pub const BUFFER_MAX_BPS: u16 = 3_000;
/// Enter withdraw mode when Kamino's freely available liquidity is below this many times
/// the larger of the market's lent value and its target lent value.
pub const WITHDRAW_MODE_ENTER: u64 = 5;
/// Leave withdraw mode when it is back above this many times that amount.
pub const WITHDRAW_MODE_EXIT: u64 = 10;
/// The highest LP fee a market may charge, in basis points: 2%. Exported in the IDL, from
/// which forms and the demo read it.
#[constant]
pub const MAX_LP_FEE_BPS: u16 = 200;
/// LP base units the first deposit locks for good: counted in every market's share count
/// and never minted. Exported in the IDL, from which the demo reads it.
#[constant]
pub const MINIMUM_LIQUIDITY: u64 = 1_000;
/// Decimals of every market's LP mint.
pub const LP_DECIMALS: u8 = 9;
/// Kamino Lend, the same address on devnet and mainnet.
pub const KLEND_PROGRAM: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

/// A mint a market may lend, and the one Kamino reserve it lends to. Market creators never
/// choose a reserve (docs/spec/lending-pool.md, "Constants").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LentMint {
    /// The lent mint, owned by SPL Token.
    pub mint: Pubkey,
    /// The Kamino lending market the reserve belongs to.
    pub lending_market: Pubkey,
    /// The Kamino reserve the market's lent side is deposited into.
    pub reserve: Pubkey,
    /// The reserve's collateral (cToken) mint, which each market's cToken account holds.
    pub collateral_mint: Pubkey,
    /// `MIN_REBALANCE` for this mint: `rebalance` skips smaller moves, in base units.
    pub min_rebalance: u64,
}

/// WSOL, the native mint of SPL Token, on every cluster.
pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// The lent mints of the cluster this program is built for.
#[cfg(feature = "mainnet")]
pub const LENT_MINTS: [LentMint; 2] = [
    LentMint {
        mint: WSOL,
        lending_market: pubkey!("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"),
        reserve: pubkey!("d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"),
        collateral_mint: pubkey!("2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1"),
        // 0.05 SOL.
        min_rebalance: 50_000_000,
    },
    LentMint {
        mint: pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        lending_market: pubkey!("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"),
        reserve: pubkey!("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),
        collateral_mint: pubkey!("B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D"),
        // 5 USDC.
        min_rebalance: 5_000_000,
    },
];

/// The lent mints of the cluster this program is built for: our own Kamino lending market
/// on devnet (`deployments/kamino-devnet.json`).
#[cfg(all(feature = "devnet", not(feature = "mainnet")))]
pub const LENT_MINTS: [LentMint; 2] = [
    LentMint {
        mint: WSOL,
        lending_market: pubkey!("DCKrWS5G3YEcrRP1Ayu8S8nBR4QfgFsSaRzRdPrjqzj3"),
        reserve: pubkey!("5vJJ1sQi972Qcf6oUy3gHEx6prijjSj31CWo5He85Hjw"),
        collateral_mint: pubkey!("8gdtrmgc9QmintdEgJbZhRaqh286ti4wUHMUZw54pLr8"),
        // 0.05 SOL.
        min_rebalance: 50_000_000,
    },
    LentMint {
        // Our test USDC, 6 decimals.
        mint: pubkey!("CqHMaMB72rTsJGRDzeQmcAsVHuwoBw7V7gdaCexcjcC7"),
        lending_market: pubkey!("DCKrWS5G3YEcrRP1Ayu8S8nBR4QfgFsSaRzRdPrjqzj3"),
        reserve: pubkey!("72wAn7eQBbBSXQcb2eAMHz2SDxUgAM51LHhH3aGbY7T3"),
        collateral_mint: pubkey!("73WCFtKov59GmY4qJMV7NqqoD5wNNioHRMv29ay5tgFd"),
        // 5 test USDC.
        min_rebalance: 5_000_000,
    },
];

/// The entry of `LENT_MINTS` for `mint`, if it may be lent on this cluster.
pub fn lent_mint(mint: &Pubkey) -> Option<&'static LentMint> {
    LENT_MINTS.iter().find(|entry| entry.mint == *mint)
}

// The `security.txt` every program of ours embeds (docs/spec/README.md, "Verified builds").
// `name` is the program's public name, which lives only here and in `metadata.json`
// (docs/spec/README.md, "Names"). The contact is this repo's private vulnerability
// reporting page, never a personal address. Internal reviews are never presented as
// audits, so `auditors` stays "None".
//
// The macro joins its values with `concat!`, so they must be string literals.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Aviary Lending AMM",
    project_url: "https://github.com/imDev2023/testing-pipeline",
    contacts: "link:https://github.com/imDev2023/testing-pipeline/security/advisories/new",
    policy: "https://github.com/imDev2023/testing-pipeline/security/policy",
    preferred_languages: "en",
    source_code: "https://github.com/imDev2023/testing-pipeline",
    auditors: "None"
}
