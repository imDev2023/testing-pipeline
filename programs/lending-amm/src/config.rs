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
/// Headroom `rebalance` leaves below Kamino's own limits on a redeem (its freely available
/// liquidity and what remains of its withdrawal cap), in basis points of each: klend refreshes
/// the reserve inside the redeem and pays at the refreshed rate, which is above the stored rate
/// the redeem is planned at, so a redeem sized right up to a limit would overshoot it and be
/// refused. 10 bps covers about a week of interest at 5% a year since the reserve's last
/// refresh. The market's own cTokens' value needs none.
pub const KAMINO_RATE_HEADROOM_BPS: u16 = 10;
/// How many slots old the reserve's last refresh may be when `add_liquidity` values a market's
/// cTokens: 0, refreshed in the same slot, as klend itself asks before it states its exchange
/// rate. Adding and removing charge no fee, so any interest the stored rate has not counted yet
/// would go to whoever adds just before the reserve refreshes and leaves just after, out of the
/// LPs' yield (finding H001, docs/security/lending-amm/). A depositor puts klend's
/// `refresh_reserve` first in the same transaction. Exported in the IDL, as is the trade bound,
/// from which forms, keepers and the demo read them.
#[constant]
pub const ADD_MAX_RESERVE_AGE_SLOTS: u64 = 0;
/// How many slots old the reserve's last refresh may be when a quote or a swap values a market's
/// cTokens: about an hour. A trade at the stored rate and one back after a refresh pay Pipeline's
/// fee twice, 0.5%, besides the LP fee, which may be 0; 9,000 slots of interest at the steepest
/// rate the deploy sees, our devnet reserves' 1,000% a year, is about 0.14% as klend counts slots
/// (two a second), so no such round trip pays, with a margin of 1.7 to 3.5 times once reward and
/// time-based interest are allowed for (finding R2-12). Beyond it a trader, a keeper or Aviary puts klend's `refresh_reserve` first.
#[constant]
pub const TRADE_MAX_RESERVE_AGE_SLOTS: u64 = 9_000;
/// Enter withdraw mode when Kamino's freely available liquidity is below this many times
/// the larger of the market's lent value and its target lent value. Exported in the IDL, as is
/// the exit multiple, from which keepers and the demo read them. It must not be above
/// `WITHDRAW_MODE_EXIT`, which `crate::withdraw_mode` checks when the program is built.
#[constant]
pub const WITHDRAW_MODE_ENTER: u64 = 5;
/// Leave withdraw mode when it is back above this many times that amount.
#[constant]
pub const WITHDRAW_MODE_EXIT: u64 = 10;
/// How many slots a market in withdraw mode must have seen Kamino's freely available liquidity
/// above the exit threshold before it leaves: about an hour. Any `rebalance` in between that sees
/// it at or below the threshold starts the wait again. One reading can be inflated at no risk, by
/// a deposit and a redeem around `rebalance` in one Jito bundle, which would lend the market's
/// liquidity into a crunch; readings an hour apart, with the keeper's sweeps between them, cannot
/// (finding H004, docs/security/lending-amm/). Exported in the IDL, from which keepers read it.
#[constant]
pub const WITHDRAW_MODE_EXIT_DELAY_SLOTS: u64 = 9_000;
// A delay of 0 would let one reading take a market out again (finding R2-19).
const _: () = assert!(WITHDRAW_MODE_EXIT_DELAY_SLOTS > 0);
// Relations the program's maths relies on, checked when it is built so no change to one value
// can break them (finding H054, docs/security/lending-amm/): the band holds the target and stays
// below the whole, and the headroom and the LP fee are parts of a whole.
const _: () = assert!(
    BUFFER_MIN_BPS <= BUFFER_TARGET_BPS
        && BUFFER_TARGET_BPS <= BUFFER_MAX_BPS
        && BUFFER_MAX_BPS < 10_000
);
const _: () = assert!(KAMINO_RATE_HEADROOM_BPS < 10_000);

/// The highest LP fee a market may charge, in basis points: 2%. Exported in the IDL, from
/// which forms and the demo read it.
#[constant]
pub const MAX_LP_FEE_BPS: u16 = 200;
const _: () = assert!(MAX_LP_FEE_BPS < 10_000);
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
// audits, so `auditors` stays "None". `source_release` is the crate's version, which each
// release raises (tests/security_txt.rs keeps the two equal): 0.1.0, the first devnet deploy,
// had none; 0.1.1 adds it, the first upgrade, which the release gate must pass against the live
// devnet markets.
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
    source_release: "0.1.1",
    auditors: "None"
}
