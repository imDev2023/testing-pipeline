//! Every read of and call to Kamino Lend (klend), in one place (docs/spec/lending-pool.md,
//! "Building it"): the reserve check, the reserve's total supply and stored exchange rate, its
//! flags, what Kamino can pay right now, the cTokens a redeem burns, the check of every Kamino
//! account a call passes, and the deposit and redeem calls themselves ([`KaminoAccounts`]), so
//! a later strategy version can add another lending market without touching the pool's maths.
//!
//! The offsets, discriminators and formulas are written by hand from klend release 1.28.0
//! (`686913e`), as the Kamino facts, section 4, list them; the program never depends on
//! klend's crate, which is BSL 1.1 (docs/spec/lending-pool.md, "Building it").
//!
//! The maths is in pure functions of numbers ([`total_supply_sf`], [`collateral_value`],
//! [`ctokens_for_value`], [`ctokens_covering`], [`withdrawal_cap_remaining`], [`can_pay`]), which Proptest, Kani and
//! Z3 check on their own; the account functions only check, decode and call.
//!
//! # Valuing cTokens
//!
//! A market's `c` cTokens are worth `V = floor(c x S_total / S_ctoken)` (docs/spec/lending-pool.md,
//! "Total reserves"), where `S_total` is the reserve's total supply in 60-bit fixed point and
//! `S_ctoken` is the reserve's own `collateral.mint_total_supply`. That is exactly what klend's
//! `redeem_reserve_collateral` pays for `c` at the same rate: it multiplies `c` by the total
//! supply in 256-bit fixed point, divides by the cToken supply and rounds down, and
//! `floor(floor(x / n) / 2^60) = floor(x / (n x 2^60))`. klend refreshes the reserve inside the
//! redeem, and interest only raises the rate, so `V` at the stored rate is never above the
//! payout (docs/spec/lending-pool.md, "The stored rate, everywhere").

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::config::{LentMint, KLEND_PROGRAM};
use crate::errors::StrategyError;

/// The fractional bits of klend's fixed-point (`_sf`) fields.
pub const FRACTION_BITS: u32 = 60;

/// A klend `Reserve` account's size, discriminator included.
pub const RESERVE_LEN: usize = 8_624;
/// Anchor's discriminator of klend's `Reserve`, `sha256("account:Reserve")[..8]`.
pub const RESERVE_DISCRIMINATOR: [u8; 8] = [43, 242, 204, 202, 26, 247, 59, 127];
/// A reserve's `version` while klend can use it; klend sets it to `u64::MAX` when a write-off
/// reaches the reserve's whole supply, and refuses redeems from a reserve whose version is not
/// this one (`ReserveDeprecated`).
pub const RESERVE_VERSION: u64 = 1;

/// A klend `LendingMarket` account's size, discriminator included.
pub const LENDING_MARKET_LEN: usize = 4_664;
/// Anchor's discriminator of klend's `LendingMarket`, `sha256("account:LendingMarket")[..8]`.
pub const LENDING_MARKET_DISCRIMINATOR: [u8; 8] = [246, 114, 50, 98, 72, 157, 28, 120];

/// Byte offsets in a klend `Reserve` at 1.28.0, discriminator included.
pub mod offsets {
    pub const VERSION: usize = 8;
    pub const LENDING_MARKET: usize = 32;
    pub const LIQUIDITY_MINT: usize = 128;
    /// `liquidity.supply_vault`, the token account holding the reserve's liquidity.
    pub const LIQUIDITY_SUPPLY: usize = 160;
    pub const TOTAL_AVAILABLE_AMOUNT: usize = 224;
    pub const BORROWED_AMOUNT_SF: usize = 232;
    pub const ACCUMULATED_PROTOCOL_FEES_SF: usize = 344;
    pub const ACCUMULATED_REFERRER_FEES_SF: usize = 360;
    pub const PENDING_REFERRER_FEES_SF: usize = 376;
    pub const COLLATERAL_MINT: usize = 2_560;
    pub const MINT_TOTAL_SUPPLY: usize = 2_592;
    pub const BLOCK_CTOKEN_USAGE: usize = 4_862;
    pub const EMERGENCY_MODE: usize = 4_864;
    /// `config.deposit_withdrawal_cap`: i64 capacity, i64 current total, u64 interval start
    /// (Unix seconds), u64 interval length (seconds).
    pub const WITHDRAWAL_CAP: usize = 5_416;
    pub const QUEUED_COLLATERAL_AMOUNT: usize = 6_968;
}

/// Byte offsets in a klend `LendingMarket` at 1.28.0, discriminator included.
pub mod lending_market_offsets {
    /// `bump_seed`, a u64 holding the lending market authority PDA's bump.
    pub const BUMP_SEED: usize = 16;
    pub const EMERGENCY_MODE: usize = 122;
}

/// Seed of klend's lending market authority PDA, `["lma", lending_market]`, which owns every
/// reserve's liquidity supply and mints its cTokens.
pub const LENDING_MARKET_AUTHORITY_SEED: &[u8] = b"lma";

/// The instructions sysvar, which klend's deposit and redeem take for introspection.
pub const INSTRUCTIONS_SYSVAR: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");

/// Anchor's instruction discriminator of klend's `deposit_reserve_liquidity`,
/// `sha256("global:deposit_reserve_liquidity")[..8]`.
pub const DEPOSIT_RESERVE_LIQUIDITY: [u8; 8] = [169, 201, 30, 126, 6, 205, 102, 68];
/// Anchor's instruction discriminator of klend's `redeem_reserve_collateral`,
/// `sha256("global:redeem_reserve_collateral")[..8]`.
pub const REDEEM_RESERVE_COLLATERAL: [u8; 8] = [234, 117, 181, 125, 185, 142, 220, 29];
/// klend's `refresh_reserve`, `sha256("global:refresh_reserve")[..8]`: the one klend instruction
/// `rebalance` allows in its transaction, which a keeper puts first when the stored rate is stale.
pub const REFRESH_RESERVE: [u8; 8] = [2, 218, 138, 235, 79, 201, 25, 102];

/// A reserve's deposit withdrawal cap: how much may leave it, net of deposits, per interval.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WithdrawalCap {
    pub capacity: i64,
    /// Net outflow so far in the current interval; deposits make it smaller, even negative.
    pub current_total: i64,
    pub interval_start: u64,
    /// 0 means no cap.
    pub interval_length: u64,
}

/// What the lending AMM reads from a klend reserve that passed [`check_reserve`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Reserve {
    pub version: u64,
    pub total_available_amount: u64,
    pub borrowed_amount_sf: u128,
    pub accumulated_protocol_fees_sf: u128,
    pub accumulated_referrer_fees_sf: u128,
    pub pending_referrer_fees_sf: u128,
    /// `collateral.mint_total_supply`, the cToken supply as the reserve counts it, which the
    /// rate uses; never the SPL mint's supply.
    pub mint_total_supply: u64,
    pub block_ctoken_usage: bool,
    pub emergency_mode: bool,
    pub withdrawal_cap: WithdrawalCap,
    pub queued_collateral_amount: u64,
}

/// What the lending AMM reads from a klend lending market that passed its check.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LendingMarket {
    pub emergency_mode: bool,
}

/// Checks that `data`, owned by `owner` at `address`, is the reserve `lent` names, in the
/// layout this module reads: its address, owner, size, Anchor discriminator, lending market,
/// liquidity mint and collateral mint, in that order (docs/spec/lending-pool.md, "Checking the
/// reserve before reading it"). Any mismatch, such as a Kamino upgrade that changes the
/// layout, refuses rather than misprices.
pub fn check_reserve(
    address: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    lent: &LentMint,
) -> core::result::Result<(), StrategyError> {
    if *address != lent.reserve {
        return Err(StrategyError::ReserveWrongAddress);
    }
    if *owner != KLEND_PROGRAM {
        return Err(StrategyError::ReserveNotKamino);
    }
    if data.len() != RESERVE_LEN {
        return Err(StrategyError::ReserveWrongSize);
    }
    if data.get(..8) != Some(&RESERVE_DISCRIMINATOR[..]) {
        return Err(StrategyError::ReserveWrongDiscriminator);
    }
    if key_at(data, offsets::LENDING_MARKET) != Some(lent.lending_market) {
        return Err(StrategyError::ReserveWrongLendingMarket);
    }
    if key_at(data, offsets::LIQUIDITY_MINT) != Some(lent.mint) {
        return Err(StrategyError::ReserveWrongLiquidityMint);
    }
    if key_at(data, offsets::COLLATERAL_MINT) != Some(lent.collateral_mint) {
        return Err(StrategyError::ReserveWrongCollateralMint);
    }
    Ok(())
}

/// Checks a reserve with [`check_reserve`], then reads it.
pub fn read_reserve(
    address: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    lent: &LentMint,
) -> core::result::Result<Reserve, StrategyError> {
    check_reserve(address, owner, data, lent)?;
    let bad = StrategyError::ReserveWrongSize;
    let cap = offsets::WITHDRAWAL_CAP;
    Ok(Reserve {
        version: u64_at(data, offsets::VERSION).ok_or(bad)?,
        total_available_amount: u64_at(data, offsets::TOTAL_AVAILABLE_AMOUNT).ok_or(bad)?,
        borrowed_amount_sf: u128_at(data, offsets::BORROWED_AMOUNT_SF).ok_or(bad)?,
        accumulated_protocol_fees_sf: u128_at(data, offsets::ACCUMULATED_PROTOCOL_FEES_SF)
            .ok_or(bad)?,
        accumulated_referrer_fees_sf: u128_at(data, offsets::ACCUMULATED_REFERRER_FEES_SF)
            .ok_or(bad)?,
        pending_referrer_fees_sf: u128_at(data, offsets::PENDING_REFERRER_FEES_SF).ok_or(bad)?,
        mint_total_supply: u64_at(data, offsets::MINT_TOTAL_SUPPLY).ok_or(bad)?,
        block_ctoken_usage: *data.get(offsets::BLOCK_CTOKEN_USAGE).ok_or(bad)? != 0,
        emergency_mode: *data.get(offsets::EMERGENCY_MODE).ok_or(bad)? != 0,
        withdrawal_cap: WithdrawalCap {
            capacity: u64_at(data, cap).ok_or(bad)? as i64,
            current_total: u64_at(data, cap + 8).ok_or(bad)? as i64,
            interval_start: u64_at(data, cap + 16).ok_or(bad)?,
            interval_length: u64_at(data, cap + 24).ok_or(bad)?,
        },
        queued_collateral_amount: u64_at(data, offsets::QUEUED_COLLATERAL_AMOUNT).ok_or(bad)?,
    })
}

/// Checks that `data`, owned by `owner` at `address`, is the lending market `lent` names, in
/// the layout this module reads, then reads it.
pub fn read_lending_market(
    address: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    lent: &LentMint,
) -> core::result::Result<LendingMarket, StrategyError> {
    let wrong = StrategyError::LendingMarketWrongAccount;
    if *address != lent.lending_market
        || *owner != KLEND_PROGRAM
        || data.len() != LENDING_MARKET_LEN
        || data.get(..8) != Some(&LENDING_MARKET_DISCRIMINATOR[..])
    {
        return Err(wrong);
    }
    Ok(LendingMarket {
        emergency_mode: *data
            .get(lending_market_offsets::EMERGENCY_MODE)
            .ok_or(wrong)?
            != 0,
    })
}

/// The reserve a market lends to, from the account passed for it: the lent mint's entry in
/// `LENT_MINTS` names the reserve, so the account must be exactly that one.
pub fn reserve_of(lent_mint: &Pubkey, account: &AccountInfo) -> Result<Reserve> {
    let lent = crate::config::lent_mint(lent_mint).ok_or(StrategyError::LentMintNotListed)?;
    let data = account.try_borrow_data()?;
    read_reserve(account.key, account.owner, &data, lent).map_err(|refusal| {
        msg!("Reserve {} refused: {:?}", account.key, refusal);
        error!(refusal)
    })
}

/// The reserve's liquidity supply, the token account holding its liquidity, from a reserve's
/// data that passed [`check_reserve`].
pub fn liquidity_supply_of(data: &[u8]) -> Option<Pubkey> {
    key_at(data, offsets::LIQUIDITY_SUPPLY)
}

impl Reserve {
    /// The reserve's total supply, `S_total`, in 60-bit fixed point.
    pub fn total_supply_sf(&self) -> core::result::Result<u128, StrategyError> {
        total_supply_sf(
            self.total_available_amount,
            self.borrowed_amount_sf,
            self.accumulated_protocol_fees_sf,
            self.accumulated_referrer_fees_sf,
            self.pending_referrer_fees_sf,
        )
        .ok_or(StrategyError::ReserveSupplyInvalid)
    }

    /// What `ctokens` cTokens are worth at the stored rate, `V`. No cTokens are worth nothing
    /// whatever the reserve holds, so a market that has lent nothing keeps trading from its
    /// buffer even while the reserve's supply cannot be computed.
    pub fn lent_value(&self, ctokens: u64) -> core::result::Result<u64, StrategyError> {
        if ctokens == 0 {
            return Ok(0);
        }
        collateral_value(ctokens, self.total_supply_sf()?, self.mint_total_supply)
            .ok_or(StrategyError::Overflow)
    }

    /// Whether a write-off has reached the reserve's whole supply, after which klend never
    /// redeems from it again.
    pub fn deprecated(&self) -> bool {
        self.version != RESERVE_VERSION
    }

    /// The reserve's freely available liquidity: `total_available_amount` less the value of
    /// queued withdrawal tickets, as klend counts it for a plain redeem. 0 when klend could not
    /// compute it either.
    pub fn freely_available(&self) -> u64 {
        let Ok(supply) = self.total_supply_sf() else {
            return 0;
        };
        match collateral_value(
            self.queued_collateral_amount,
            supply,
            self.mint_total_supply,
        ) {
            Some(queued) => self.total_available_amount.saturating_sub(queued),
            None => 0,
        }
    }

    /// Whether klend redeems nothing from this reserve right now: either emergency mode is on,
    /// the reserve's or its lending market's, or the reserve is deprecated
    /// (docs/spec/lending-pool.md, "When Kamino can't pay").
    pub fn redeems_stopped(&self, market: &LendingMarket) -> bool {
        market.emergency_mode || self.emergency_mode || self.deprecated()
    }

    /// What Kamino can pay a market holding `ctokens` right now, at Unix time `now`
    /// (docs/spec/lending-pool.md, "Redeeming the shortfall").
    pub fn can_pay_now(&self, market: &LendingMarket, ctokens: u64, now: i64) -> u64 {
        let stopped = self.redeems_stopped(market);
        let Ok(supply) = self.total_supply_sf() else {
            return 0;
        };
        // A position worth more than a u64 is limited by the other two terms anyway.
        let own = collateral_value(ctokens, supply, self.mint_total_supply).unwrap_or(u64::MAX);
        let now = u64::try_from(now).unwrap_or(0);
        can_pay(
            self.freely_available(),
            withdrawal_cap_remaining(&self.withdrawal_cap, now),
            own,
            stopped,
        )
    }
}

impl Reserve {
    /// What a market holding `ctokens` may plan to redeem at Unix time `now`, in `rebalance` and
    /// in a swap's redeem of its shortfall alike: what Kamino can pay right now
    /// ([`Reserve::can_pay_now`]), but with each of Kamino's own limits, its freely available
    /// liquidity and what remains of its withdrawal cap, lowered by `KAMINO_RATE_HEADROOM_BPS`
    /// ([`with_rate_headroom`]), since klend pays at the rate it refreshes to inside the redeem,
    /// above the stored rate the redeem is planned at, and refuses a redeem that would pass either
    /// limit.
    pub fn can_pay_planned(&self, market: &LendingMarket, ctokens: u64, now: i64) -> u64 {
        self.can_pay_planned_unless(self.redeems_stopped(market), ctokens, now)
    }

    /// [`Reserve::can_pay_planned`], with whether Kamino redeems nothing (`stopped`) given.
    fn can_pay_planned_unless(&self, stopped: bool, ctokens: u64, now: i64) -> u64 {
        let Ok(supply) = self.total_supply_sf() else {
            return 0;
        };
        let own = collateral_value(ctokens, supply, self.mint_total_supply).unwrap_or(u64::MAX);
        let now = u64::try_from(now).unwrap_or(0);
        can_pay(
            with_rate_headroom(self.freely_available()),
            with_rate_headroom(withdrawal_cap_remaining(&self.withdrawal_cap, now)),
            own,
            stopped,
        )
    }
}

impl Reserve {
    /// What a market holding `ctokens` may plan to redeem at Unix time `now`, as far as the
    /// reserve alone shows: [`Reserve::can_pay_planned`] stopped only by the reserve's own
    /// emergency mode or deprecation. It is what account resolution counts, and a quote or swap
    /// built without the redeem accounts, which have no lending market account to read; the
    /// lending market's emergency mode can only lower it.
    pub fn can_pay_by_itself(&self, ctokens: u64, now: i64) -> u64 {
        self.can_pay_planned_unless(self.emergency_mode || self.deprecated(), ctokens, now)
    }
}

/// `amount` less `KAMINO_RATE_HEADROOM_BPS` of it, rounded so the headroom is never smaller.
pub fn with_rate_headroom(amount: u64) -> u64 {
    let headroom =
        (amount as u128 * crate::config::KAMINO_RATE_HEADROOM_BPS as u128).div_ceil(10_000);
    // The headroom is at most the amount, since the basis points are below 10,000.
    amount - headroom as u64
}

/// A reserve's total supply in 60-bit fixed point, klend's `total_supply`:
/// `total_available_amount + borrowed_amount_sf - accumulated_protocol_fees_sf -
/// accumulated_referrer_fees_sf - pending_referrer_fees_sf`, in that order. `None` where
/// klend's own fixed-point maths would fail too: a sum beyond 128 bits or a negative supply.
pub fn total_supply_sf(
    total_available_amount: u64,
    borrowed_amount_sf: u128,
    accumulated_protocol_fees_sf: u128,
    accumulated_referrer_fees_sf: u128,
    pending_referrer_fees_sf: u128,
) -> Option<u128> {
    ((total_available_amount as u128) << FRACTION_BITS)
        .checked_add(borrowed_amount_sf)?
        .checked_sub(accumulated_protocol_fees_sf)?
        .checked_sub(accumulated_referrer_fees_sf)?
        .checked_sub(pending_referrer_fees_sf)
}

/// What `ctokens` cTokens are worth: `floor(ctokens x total_supply_sf / (mint_total_supply x
/// 2^60))`, exactly, or `None` when that does not fit in a u64.
///
/// 0 when any input is 0: no cTokens are worth nothing, and a reserve with no supply or no
/// cTokens counts its cTokens as worth nothing rather than at klend's initial rate of one,
/// which can only understate.
///
/// Every intermediate fits: the product `ctokens x total_supply_sf` is below 2^192 and is
/// held as 64-bit digits, the divisor `mint_total_supply x 2^60` is below 2^124, and a
/// quotient of 2^64 or more is refused before dividing, so the long division below never
/// holds more than 125 bits.
pub fn collateral_value(
    ctokens: u64,
    total_supply_sf: u128,
    mint_total_supply: u64,
) -> Option<u64> {
    if ctokens == 0 || total_supply_sf == 0 || mint_total_supply == 0 {
        return Some(0);
    }
    let divisor = (mint_total_supply as u128) << FRACTION_BITS;
    // ctokens x total_supply_sf = top x 2^64 + low.
    let low_product = ctokens as u128 * (total_supply_sf as u64 as u128);
    let high_product = ctokens as u128 * (total_supply_sf >> 64);
    let low = low_product as u64;
    // At most (2^64 - 1)^2 + (2^64 - 1) < 2^128.
    let top = high_product.checked_add(low_product >> 64)?;
    // The quotient is below 2^64 exactly when top x 2^64 + low < divisor x 2^64.
    if top >= divisor {
        return None;
    }
    // Binary long division of top x 2^64 + low by the divisor, one bit of `low` at a time;
    // the remainder stays below the divisor, so doubling it stays below 2^125.
    let mut remainder = top;
    let mut quotient: u64 = 0;
    for bit in (0..64).rev() {
        remainder = (remainder << 1) | ((low >> bit) & 1) as u128;
        quotient <<= 1;
        if remainder >= divisor {
            remainder -= divisor;
            quotient |= 1;
        }
    }
    Some(quotient)
}

/// What remains of a withdrawal cap at Unix time `now`, as klend counts it: everything while
/// there is no cap (an interval length of 0), the capacity once the interval is over, and the
/// capacity less the net outflow so far otherwise. 0 for a negative capacity, and for an
/// interval that starts after `now`, where klend refuses every redeem.
pub fn withdrawal_cap_remaining(cap: &WithdrawalCap, now: u64) -> u64 {
    if cap.interval_length == 0 {
        return u64::MAX;
    }
    if cap.capacity < 0 || cap.interval_start > now {
        return 0;
    }
    let elapsed = now - cap.interval_start;
    let current = if elapsed >= cap.interval_length {
        0
    } else {
        cap.current_total
    };
    if current > cap.capacity {
        return 0;
    }
    // Between 0 and i64::MAX - i64::MIN, which is u64::MAX.
    u64::try_from(cap.capacity as i128 - current as i128).unwrap_or(u64::MAX)
}

/// What Kamino can pay right now: the smallest of the reserve's freely available liquidity,
/// what remains of its withdrawal cap, and the value of the market's own cTokens; nothing
/// while redeems are `stopped` (either emergency mode, or a deprecated reserve).
pub fn can_pay(freely_available: u64, cap_remaining: u64, own_value: u64, stopped: bool) -> u64 {
    if stopped {
        return 0;
    }
    freely_available.min(cap_remaining).min(own_value)
}

/// How many cTokens are worth at most `liquidity`: `floor(liquidity x mint_total_supply x
/// 2^60 / total_supply_sf)`, exactly, or `None` when the reserve has no supply or that does not
/// fit in a u64. By klend's own rounding they then redeem for at most `liquidity` at the same
/// rate, and for less than one cToken's worth below it.
pub fn ctokens_for_value(
    liquidity: u64,
    total_supply_sf: u128,
    mint_total_supply: u64,
) -> Option<u64> {
    ctokens_quotient(liquidity, total_supply_sf, mint_total_supply).map(|(quotient, _)| quotient)
}

/// How many cTokens are worth at least `liquidity`: `ceil(liquidity x mint_total_supply x 2^60
/// / total_supply_sf)`, exactly, or `None` when the reserve has no supply or that does not fit
/// in a u64. klend pays `floor(k x total_supply_sf / (mint_total_supply x 2^60))` for `k`
/// cTokens, which for these is at least `liquidity` at the same rate, and they are fewer than
/// one cToken more than `liquidity` needs: what a swap burns to redeem its shortfall
/// (docs/spec/lending-pool.md, "Redeeming the shortfall").
pub fn ctokens_covering(
    liquidity: u64,
    total_supply_sf: u128,
    mint_total_supply: u64,
) -> Option<u64> {
    let (quotient, remainder) = ctokens_quotient(liquidity, total_supply_sf, mint_total_supply)?;
    quotient.checked_add((remainder != 0) as u64)
}

/// `liquidity x mint_total_supply x 2^60` divided by `total_supply_sf`, as its quotient and
/// remainder, exactly, or `None` when the reserve has no supply or the quotient does not fit
/// in a u64.
///
/// Every intermediate fits: `liquidity x mint_total_supply` is below 2^128, so the numerator
/// `x x 2^60` is held as `(x >> 4) x 2^64 + (x mod 16) x 2^60`; a quotient of 2^64 or more is
/// refused before dividing; and the long division keeps the bit a doubled remainder would carry
/// out of 128 bits, since the divisor may use all 128.
fn ctokens_quotient(
    liquidity: u64,
    total_supply_sf: u128,
    mint_total_supply: u64,
) -> Option<(u64, u128)> {
    if total_supply_sf == 0 {
        return None;
    }
    let product = liquidity as u128 * mint_total_supply as u128;
    let top = product >> 4;
    let low = ((product & 0xf) as u64) << FRACTION_BITS;
    // The quotient is below 2^64 exactly when top x 2^64 + low < divisor x 2^64.
    if top >= total_supply_sf {
        return None;
    }
    let mut remainder = top;
    let mut quotient: u64 = 0;
    for bit in (0..64).rev() {
        // The remainder is below the divisor, so doubling it and adding a bit stays below
        // 2^129: `carry` is its 129th bit.
        let carry = remainder >> 127;
        remainder = (remainder << 1) | ((low >> bit) & 1) as u128;
        quotient <<= 1;
        if carry == 1 || remainder >= total_supply_sf {
            // The true remainder is below twice the divisor, so this is below the divisor and
            // the wrapped difference is exact.
            remainder = remainder.wrapping_sub(total_supply_sf);
            quotient |= 1;
        }
    }
    Some((quotient, remainder))
}

impl Reserve {
    /// The cTokens to burn to redeem `liquidity` from a market holding `ctokens`: all of them
    /// when `liquidity` is at least their whole value, otherwise as many as are worth at most
    /// `liquidity` at the stored rate ([`ctokens_for_value`]), so a redeem never carries the
    /// buffer past its target at that rate. klend refreshes the reserve inside the redeem, and
    /// interest only raises the rate, so they fetch at least their value at the stored rate.
    pub fn ctokens_to_redeem(
        &self,
        liquidity: u64,
        ctokens: u64,
    ) -> core::result::Result<u64, StrategyError> {
        if liquidity >= self.lent_value(ctokens)? {
            return Ok(ctokens);
        }
        let burn = ctokens_for_value(liquidity, self.total_supply_sf()?, self.mint_total_supply)
            .ok_or(StrategyError::Overflow)?;
        // Less than one cToken's worth redeems nothing, which klend refuses: below the floor.
        if burn == 0 {
            return Err(StrategyError::BelowMinRebalance);
        }
        Ok(burn.min(ctokens))
    }
}

impl Reserve {
    /// The cTokens a swap burns to redeem its `shortfall` from a market holding `ctokens`:
    /// `ceil(shortfall x S_ctoken / S_total)` at the stored rate ([`ctokens_covering`]), worth at
    /// least the shortfall at that rate and less than one cToken more. klend refreshes the
    /// reserve inside the redeem, and interest only raises the rate, so the market receives at
    /// least the shortfall. Refused when the market holds fewer, which a shortfall within the
    /// value of its cTokens never needs.
    pub fn ctokens_for_shortfall(
        &self,
        shortfall: u64,
        ctokens: u64,
    ) -> core::result::Result<u64, StrategyError> {
        let burn = ctokens_covering(shortfall, self.total_supply_sf()?, self.mint_total_supply)
            .ok_or(StrategyError::Overflow)?;
        if burn > ctokens {
            return Err(StrategyError::BeyondBuffer);
        }
        Ok(burn)
    }
}

/// The accounts klend's `deposit_reserve_liquidity` and `redeem_reserve_collateral` take besides
/// the depositor and its two token accounts.
pub struct KaminoAccounts<'a, 'info> {
    pub klend_program: &'a AccountInfo<'info>,
    pub reserve: &'a AccountInfo<'info>,
    pub lending_market: &'a AccountInfo<'info>,
    pub lending_market_authority: &'a AccountInfo<'info>,
    pub liquidity_mint: &'a AccountInfo<'info>,
    pub liquidity_supply: &'a AccountInfo<'info>,
    pub collateral_mint: &'a AccountInfo<'info>,
    /// SPL Token, the program of the lent mint and of every cToken mint.
    pub token_program: &'a AccountInfo<'info>,
    pub instructions_sysvar: &'a AccountInfo<'info>,
}

impl<'info> KaminoAccounts<'_, 'info> {
    /// Checks every account against the reserve `lent` names, before any is passed to klend,
    /// and reads the reserve and its lending market: the reserve passes [`check_reserve`], the
    /// lending market is the reserve's, the lending market authority is its PDA, the mints are
    /// the reserve's, the liquidity supply is the one the reserve records, and the programs and
    /// the sysvar are what they claim to be. So klend can never be handed another reserve's
    /// accounts, and nothing that is not klend is ever called as klend.
    pub fn check(&self, lent: &LentMint) -> Result<(Reserve, LendingMarket)> {
        let wrong = StrategyError::KaminoAccountWrong;
        require_keys_eq!(*self.klend_program.key, KLEND_PROGRAM, wrong);
        require_keys_eq!(*self.token_program.key, anchor_spl::token::ID, wrong);
        require_keys_eq!(*self.instructions_sysvar.key, INSTRUCTIONS_SYSVAR, wrong);
        require_keys_eq!(*self.liquidity_mint.key, lent.mint, wrong);
        require_keys_eq!(*self.collateral_mint.key, lent.collateral_mint, wrong);
        let reserve_data = self.reserve.try_borrow_data()?;
        let reserve = read_reserve(self.reserve.key, self.reserve.owner, &reserve_data, lent)
            .map_err(|refusal| {
                msg!("Reserve {} refused: {:?}", self.reserve.key, refusal);
                error!(refusal)
            })?;
        let supply_vault = key_at(&reserve_data, offsets::LIQUIDITY_SUPPLY);
        drop(reserve_data);
        require!(
            supply_vault == Some(*self.liquidity_supply.key),
            StrategyError::KaminoAccountWrong
        );

        let data = self.lending_market.try_borrow_data()?;
        let market = read_lending_market(
            self.lending_market.key,
            self.lending_market.owner,
            &data,
            lent,
        )
        .map_err(|refusal| error!(refusal))?;
        let bump = *data.get(lending_market_offsets::BUMP_SEED).ok_or(wrong)?;
        let authority = Pubkey::create_program_address(
            &[
                LENDING_MARKET_AUTHORITY_SEED,
                self.lending_market.key.as_ref(),
                &[bump],
            ],
            &KLEND_PROGRAM,
        )
        .map_err(|_| error!(wrong))?;
        require_keys_eq!(*self.lending_market_authority.key, authority, wrong);
        Ok((reserve, market))
    }

    /// klend's `deposit_reserve_liquidity { liquidity_amount }`: `owner`, signing with
    /// `signer_seeds`, moves up to `liquidity` of the lent mint from `source` into the reserve,
    /// and klend mints cTokens into `destination`. The accounts in the order klend 1.28.0
    /// declares them.
    pub fn deposit(
        &self,
        owner: &AccountInfo<'info>,
        source: &AccountInfo<'info>,
        destination: &AccountInfo<'info>,
        liquidity: u64,
        signer_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        let accounts = [
            (owner, false, true),
            (self.reserve, true, false),
            (self.lending_market, false, false),
            (self.lending_market_authority, false, false),
            (self.liquidity_mint, false, false),
            (self.liquidity_supply, true, false),
            (self.collateral_mint, true, false),
            (source, true, false),
            (destination, true, false),
            (self.token_program, false, false),
            (self.token_program, false, false),
            (self.instructions_sysvar, false, false),
        ];
        self.invoke(
            DEPOSIT_RESERVE_LIQUIDITY,
            liquidity,
            &accounts,
            signer_seeds,
        )
    }

    /// klend's `redeem_reserve_collateral { collateral_amount }`: `owner`, signing with
    /// `signer_seeds`, burns `ctokens` from `source`, and klend pays the lent mint into
    /// `destination` at the reserve's rate, refreshed in the call. The accounts in the order
    /// klend 1.28.0 declares them.
    pub fn redeem(
        &self,
        owner: &AccountInfo<'info>,
        source: &AccountInfo<'info>,
        destination: &AccountInfo<'info>,
        ctokens: u64,
        signer_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        let accounts = [
            (owner, false, true),
            (self.lending_market, false, false),
            (self.reserve, true, false),
            (self.lending_market_authority, false, false),
            (self.liquidity_mint, false, false),
            (self.collateral_mint, true, false),
            (self.liquidity_supply, true, false),
            (source, true, false),
            (destination, true, false),
            (self.token_program, false, false),
            (self.token_program, false, false),
            (self.instructions_sysvar, false, false),
        ];
        self.invoke(REDEEM_RESERVE_COLLATERAL, ctokens, &accounts, signer_seeds)
    }

    /// Calls klend's instruction `discriminator` with one u64 argument and `accounts` as
    /// (account, writable, signer), signed by the PDA `signer_seeds` names.
    fn invoke(
        &self,
        discriminator: [u8; 8],
        amount: u64,
        accounts: &[(&AccountInfo<'info>, bool, bool)],
        signer_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        let mut data = discriminator.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        let metas = accounts
            .iter()
            .map(|(account, writable, signer)| AccountMeta {
                pubkey: *account.key,
                is_writable: *writable,
                is_signer: *signer,
            })
            .collect();
        let mut infos: Vec<AccountInfo<'info>> = accounts
            .iter()
            .map(|(account, _, _)| (*account).clone())
            .collect();
        infos.push(self.klend_program.clone());
        let instruction = Instruction {
            program_id: KLEND_PROGRAM,
            accounts: metas,
            data,
        };
        invoke_signed(&instruction, &infos, signer_seeds)?;
        Ok(())
    }
}

fn u64_at(data: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        data.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

fn u128_at(data: &[u8], offset: usize) -> Option<u128> {
    Some(u128::from_le_bytes(
        data.get(offset..offset + 16)?.try_into().ok()?,
    ))
}

fn key_at(data: &[u8], offset: usize) -> Option<Pubkey> {
    let bytes: [u8; 32] = data.get(offset..offset + 32)?.try_into().ok()?;
    Some(Pubkey::new_from_array(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// A 256-bit number as four 64-bit digits, least significant first: a reference written
    /// apart from `collateral_value`, schoolbook digit by digit, for the properties below.
    type Wide = [u64; 4];

    fn wide(value: u128) -> Wide {
        [value as u64, (value >> 64) as u64, 0, 0]
    }

    fn mul(a: Wide, b: Wide) -> Wide {
        let mut out = [0u64; 4];
        for i in 0..4 {
            let mut carry = 0u128;
            for j in 0..4 - i {
                let t = out[i + j] as u128 + a[i] as u128 * b[j] as u128 + carry;
                out[i + j] = t as u64;
                carry = t >> 64;
            }
        }
        out
    }

    /// Division by a u64, digit by digit from the top: (quotient, remainder).
    fn div_small(a: Wide, d: u64) -> (Wide, u64) {
        let mut out = [0u64; 4];
        let mut remainder = 0u128;
        for i in (0..4).rev() {
            let t = (remainder << 64) | a[i] as u128;
            out[i] = (t / d as u128) as u64;
            remainder = t % d as u128;
        }
        (out, remainder as u64)
    }

    fn shr(a: Wide, bits: u32) -> Wide {
        let digits = (bits / 64) as usize;
        let bits = bits % 64;
        let mut out = [0u64; 4];
        for i in 0..4 - digits {
            out[i] = a[i + digits] >> bits;
            if bits > 0 && i + digits + 1 < 4 {
                out[i] |= a[i + digits + 1] << (64 - bits);
            }
        }
        out
    }

    /// klend's payout for `c` cTokens: its 256-bit fixed-point product `c x 2^60 x S >> 60`,
    /// divided by the cToken supply, then rounded down to whole units; `None` when klend's
    /// 128-bit fraction cannot hold it (klend panics), or when it exceeds a u64.
    fn klend_payout(c: u64, s: u128, n: u64) -> Option<u64> {
        let product = shr(mul(wide((c as u128) << 60), wide(s)), 60);
        let (fraction, _) = div_small(product, n);
        if fraction[2] != 0 || fraction[3] != 0 {
            return None;
        }
        let units = shr(fraction, 60);
        (units[1] == 0).then_some(units[0])
    }

    /// The exact floor of `c x S / (N x 2^60)` if it fits a u64, by the reference.
    fn exact(c: u64, s: u128, n: u64) -> Option<u64> {
        let (by_n, _) = div_small(mul(wide(c as u128), wide(s)), n);
        let units = shr(by_n, 60);
        (units[1] == 0 && units[2] == 0 && units[3] == 0).then_some(units[0])
    }

    #[test]
    fn the_values_of_the_examples() {
        // At a rate of exactly 1.5: 1,000 cTokens are worth 1,500.
        let s = 3u128 << 60;
        assert_eq!(collateral_value(1_000, s, 2), Some(1_500));
        // Rounds down: 1 cToken at 1.5 is worth 1.
        assert_eq!(collateral_value(1, s, 2), Some(1));
        // Zero anywhere is worth nothing.
        assert_eq!(collateral_value(0, s, 2), Some(0));
        assert_eq!(collateral_value(5, 0, 2), Some(0));
        assert_eq!(collateral_value(5, s, 0), Some(0));
        // The largest value that fits, and the first that does not.
        assert_eq!(collateral_value(u64::MAX, 1 << 60, 1), Some(u64::MAX));
        assert_eq!(collateral_value(u64::MAX, 2 << 60, 1), None);
        assert_eq!(collateral_value(u64::MAX, u128::MAX, 1), None);
        assert_eq!(
            collateral_value(u64::MAX, u128::MAX, u64::MAX),
            exact(u64::MAX, u128::MAX, u64::MAX)
        );
    }

    #[test]
    fn the_total_supply_is_klends_and_refuses_what_klend_cannot_compute() {
        assert_eq!(
            total_supply_sf(10, 5 << 60, 1 << 60, 1 << 59, 1 << 59),
            Some(13 << 60)
        );
        // A negative supply.
        assert_eq!(total_supply_sf(1, 0, 2 << 60, 0, 0), None);
        // Beyond 128 bits.
        assert_eq!(total_supply_sf(u64::MAX, u128::MAX, 0, 0, 0), None);
    }

    #[test]
    fn the_withdrawal_cap_is_counted_as_klend_counts_it() {
        let cap = |capacity, current_total, interval_start, interval_length| WithdrawalCap {
            capacity,
            current_total,
            interval_start,
            interval_length,
        };
        // No cap.
        assert_eq!(withdrawal_cap_remaining(&cap(0, 0, 0, 0), 100), u64::MAX);
        // 10 a day, 4 used, still inside the interval.
        assert_eq!(withdrawal_cap_remaining(&cap(10, 4, 50, 86_400), 100), 6);
        // Deposits made the running total negative.
        assert_eq!(withdrawal_cap_remaining(&cap(10, -5, 50, 86_400), 100), 15);
        // The interval is over: the whole capacity again.
        assert_eq!(withdrawal_cap_remaining(&cap(10, 10, 50, 50), 100), 10);
        // Used beyond the capacity, a negative capacity, an interval in the future.
        assert_eq!(withdrawal_cap_remaining(&cap(10, 11, 50, 86_400), 100), 0);
        assert_eq!(withdrawal_cap_remaining(&cap(-1, 0, 50, 86_400), 100), 0);
        assert_eq!(withdrawal_cap_remaining(&cap(10, 0, 101, 86_400), 100), 0);
        // The widest difference fits.
        assert_eq!(
            withdrawal_cap_remaining(&cap(i64::MAX, i64::MIN, 0, 86_400), 0),
            u64::MAX
        );
    }

    #[test]
    fn no_ctokens_are_worth_nothing_whatever_the_reserve_holds() {
        // Fees above everything supplied: klend could not compute the supply either.
        let reserve = Reserve {
            total_available_amount: 1,
            accumulated_protocol_fees_sf: 2 << 60,
            mint_total_supply: 10,
            ..Reserve::default()
        };
        assert_eq!(reserve.lent_value(0).map_err(|e| e as u32), Ok(0));
        assert_eq!(
            reserve.lent_value(1).map_err(|e| e as u32),
            Err(StrategyError::ReserveSupplyInvalid as u32)
        );
    }

    #[test]
    fn kamino_pays_the_smallest_term_and_nothing_when_stopped() {
        assert_eq!(can_pay(5, 7, 9, false), 5);
        assert_eq!(can_pay(9, 5, 7, false), 5);
        assert_eq!(can_pay(7, 9, 5, false), 5);
        assert_eq!(can_pay(7, 9, 5, true), 0);
    }

    /// The exact floor of `x x N x 2^60 / S` if it fits a u64, by the reference: a 256-bit
    /// numerator divided by a 128-bit divisor one bit at a time.
    fn exact_ctokens(x: u64, s: u128, n: u64) -> Option<u64> {
        if s == 0 {
            return None;
        }
        let numerator = mul(mul(wide(x as u128), wide(n as u128)), wide(1u128 << 60));
        let mut remainder = [0u64; 4];
        let mut quotient = [0u64; 4];
        let divisor = wide(s);
        let ge = |a: &Wide, b: &Wide| {
            (0..4)
                .rev()
                .find(|&i| a[i] != b[i])
                .is_none_or(|i| a[i] > b[i])
        };
        for bit in (0..256).rev() {
            remainder = mul(remainder, wide(2));
            remainder[0] |= (numerator[bit / 64] >> (bit % 64)) & 1;
            if ge(&remainder, &divisor) {
                let mut borrow = 0u128;
                for i in 0..4 {
                    let t = (remainder[i] as u128).wrapping_sub(divisor[i] as u128 + borrow);
                    borrow = ((remainder[i] as u128) < divisor[i] as u128 + borrow) as u128;
                    remainder[i] = t as u64;
                }
                quotient[bit / 64] |= 1 << (bit % 64);
            }
        }
        (quotient[1] == 0 && quotient[2] == 0 && quotient[3] == 0).then_some(quotient[0])
    }

    #[test]
    fn the_ctokens_for_a_value_are_the_examples() {
        // At a rate of exactly 1.5: 1,500 is worth 1,000 cTokens, and 1,501 still 1,000.
        let s = 3u128 << 60;
        assert_eq!(ctokens_for_value(1_500, s, 2), Some(1_000));
        assert_eq!(ctokens_for_value(1_501, s, 2), Some(1_000));
        assert_eq!(ctokens_for_value(1, s, 2), Some(0));
        assert_eq!(ctokens_for_value(0, s, 2), Some(0));
        // No supply: nothing can be computed.
        assert_eq!(ctokens_for_value(5, 0, 2), None);
        // The divisor may use all 128 bits.
        assert_eq!(
            ctokens_for_value(u64::MAX, u128::MAX, u64::MAX),
            exact_ctokens(u64::MAX, u128::MAX, u64::MAX)
        );
        // A quotient of 2^64 or more is refused.
        assert_eq!(ctokens_for_value(u64::MAX, 1 << 60, 2), None);
    }

    #[test]
    fn the_ctokens_covering_a_shortfall_are_the_examples() {
        // At a rate of exactly 1.5: 1,500 needs 1,000 cTokens, 1,501 needs 1,001 (1,000.67
        // rounded up), 1 needs 1, and nothing needs none.
        let s = 3u128 << 60;
        assert_eq!(ctokens_covering(1_500, s, 2), Some(1_000));
        assert_eq!(ctokens_covering(1_501, s, 2), Some(1_001));
        assert_eq!(ctokens_covering(1, s, 2), Some(1));
        assert_eq!(ctokens_covering(0, s, 2), Some(0));
        assert_eq!(ctokens_covering(5, 0, 2), None);
        // A quotient of 2^64 or more is refused, and so is one that rounds up to 2^64.
        assert_eq!(ctokens_covering(u64::MAX, 1 << 60, 2), None);
        assert_eq!(ctokens_covering(u64::MAX, 1 << 60, 1), Some(u64::MAX));
        // A swap burns them, and never more than the market holds.
        let reserve = Reserve {
            version: RESERVE_VERSION,
            total_available_amount: 3_000,
            mint_total_supply: 2_000,
            ..Reserve::default()
        };
        assert_eq!(
            reserve
                .ctokens_for_shortfall(1_501, 2_000)
                .map_err(|e| e as u32),
            Ok(1_001)
        );
        assert_eq!(
            reserve
                .ctokens_for_shortfall(1_501, 1_000)
                .map_err(|e| e as u32),
            Err(StrategyError::BeyondBuffer as u32)
        );
    }

    #[test]
    fn the_rate_headroom_is_taken_from_kaminos_limits_rounded_up() {
        let bps = crate::config::KAMINO_RATE_HEADROOM_BPS as u64;
        assert_eq!(
            with_rate_headroom(1_000_000),
            1_000_000 - 1_000_000 * bps / 10_000
        );
        assert_eq!(with_rate_headroom(1), 0);
        assert_eq!(with_rate_headroom(0), 0);
        assert!(with_rate_headroom(u64::MAX) < u64::MAX);
        // Kamino's limits get the headroom, and the market's own cTokens do not: here the
        // cTokens are worth the least, 1,500 at a rate of 1.5, so they bind exactly.
        let reserve = Reserve {
            version: RESERVE_VERSION,
            total_available_amount: 3_000_000,
            mint_total_supply: 2_000_000,
            ..Reserve::default()
        };
        let market = LendingMarket::default();
        assert_eq!(reserve.can_pay_planned(&market, 1_000, 0), 1_500);
        assert_eq!(
            reserve.can_pay_planned(&market, 4_000_000, 0),
            with_rate_headroom(3_000_000)
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// The headroom never exceeds the amount, never falls below the basis points' share,
        /// and so leaves at most what Kamino can pay.
        #[test]
        fn the_rate_headroom_is_never_negative_and_never_short(amount: u64) {
            let left = with_rate_headroom(amount);
            let bps = crate::config::KAMINO_RATE_HEADROOM_BPS as u128;
            prop_assert!(left <= amount);
            prop_assert!((amount - left) as u128 * 10_000 >= amount as u128 * bps);
        }
    }

    #[test]
    fn a_redeem_burns_everything_once_it_asks_for_the_whole_value() {
        let reserve = Reserve {
            total_available_amount: 3,
            mint_total_supply: 2,
            ..Reserve::default()
        };
        // 1,000 cTokens at 1.5 are worth 1,500.
        assert_eq!(
            reserve
                .ctokens_to_redeem(1_500, 1_000)
                .map_err(|e| e as u32),
            Ok(1_000)
        );
        assert_eq!(
            reserve
                .ctokens_to_redeem(9_999, 1_000)
                .map_err(|e| e as u32),
            Ok(1_000)
        );
        assert_eq!(
            reserve
                .ctokens_to_redeem(1_499, 1_000)
                .map_err(|e| e as u32),
            Ok(999)
        );
        // Less than one cToken's worth burns nothing, which klend would refuse: below the floor.
        assert_eq!(
            reserve.ctokens_to_redeem(1, 1_000).map_err(|e| e as u32),
            Err(StrategyError::BelowMinRebalance as u32)
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// The value is exactly floor(c x S / (N x 2^60)), and refused exactly when that does
        /// not fit a u64.
        #[test]
        fn the_value_is_the_exact_floor(c: u64, s: u128, n in 1u64..) {
            prop_assert_eq!(collateral_value(c, s, n), exact(c, s, n));
        }

        /// The same over the sizes real reserves have, where nothing is refused: up to 2^50
        /// units supplied, a rate between 1 and 4, positions up to the whole supply.
        #[test]
        fn the_value_is_the_exact_floor_on_real_sized_reserves(
            n in 1u64..(1 << 50),
            rate_sf in (1u128 << 60)..(4u128 << 60),
            share in 0u64..=1_000_000,
        ) {
            let s = n as u128 * rate_sf;
            let c = (n as u128 * share as u128 / 1_000_000) as u64;
            let value = collateral_value(c, s, n);
            prop_assert!(value.is_some());
            prop_assert_eq!(value, exact(c, s, n));
        }

        /// Never above what klend's redeem pays at the same rate, and equal to it wherever
        /// klend can pay.
        #[test]
        fn the_value_never_rounds_above_klends_payout(c: u64, s: u128, n in 1u64..) {
            match (collateral_value(c, s, n), klend_payout(c, s, n)) {
                (Some(value), Some(paid)) => prop_assert_eq!(value, paid),
                (Some(_), None) => prop_assert!(false, "valued what klend cannot pay"),
                _ => {}
            }
        }

        /// A higher rate never values the same cTokens lower.
        #[test]
        fn a_higher_rate_never_values_lower(c: u64, s: u128, extra: u128, n in 1u64..) {
            let higher = s.saturating_add(extra);
            if let (Some(low), Some(high)) = (collateral_value(c, s, n), collateral_value(c, higher, n)) {
                prop_assert!(low <= high);
            }
        }

        /// What Kamino can pay is never more than any of its three terms.
        #[test]
        fn kamino_never_pays_more_than_any_term(free: u64, cap: u64, own: u64, stopped: bool) {
            let paid = can_pay(free, cap, own, stopped);
            prop_assert!(paid <= free && paid <= cap && paid <= own);
            prop_assert!(stopped || paid == free || paid == cap || paid == own);
            prop_assert!(!stopped || paid == 0);
        }

        /// The cTokens for a value are exactly floor(x x N x 2^60 / S), refused exactly when
        /// that does not fit a u64 or there is no supply.
        #[test]
        fn the_ctokens_for_a_value_are_the_exact_floor(x: u64, s: u128, n: u64) {
            prop_assert_eq!(ctokens_for_value(x, s, n), exact_ctokens(x, s, n));
        }

        /// The cTokens covering a shortfall are the fewest worth at least it at the stored
        /// rate: worth at least the shortfall, and one fewer would be worth less, so they are at
        /// most one cToken more than needed; refused exactly when that count does not fit a u64
        /// or there is no supply.
        #[test]
        fn the_ctokens_covering_a_shortfall_are_the_fewest_worth_it(
            x: u64,
            n in 1u64..,
            s in 1u128..,
        ) {
            let floor = exact_ctokens(x, s, n);
            match ctokens_covering(x, s, n) {
                Some(k) => {
                    let floor = floor.unwrap();
                    prop_assert!(k == floor || k == floor + 1);
                    // klend's payout for k at the same rate.
                    let worth = |k: u64| klend_payout(k, s, n);
                    if let Some(value) = worth(k) {
                        prop_assert!(value >= x);
                    }
                    if k > 0 {
                        prop_assert!(worth(k - 1).unwrap() < x);
                    }
                }
                None => prop_assert!(floor.is_none_or(|q| q == u64::MAX)),
            }
        }

        /// The same, on real-sized reserves, against the program's own valuation.
        #[test]
        fn the_ctokens_covering_a_shortfall_are_worth_it_on_real_sized_reserves(
            x in 0u64..(1 << 60),
            n in 1u64..(1 << 50),
            rate_sf in (1u128 << 60)..(4u128 << 60),
        ) {
            let s = n as u128 * rate_sf;
            if let Some(k) = ctokens_covering(x, s, n) {
                prop_assert!(collateral_value(k, s, n).unwrap() >= x);
                if k > 0 {
                    prop_assert!(collateral_value(k - 1, s, n).unwrap() < x);
                }
            }
        }

        /// They are worth at most the value asked for, and less than one cToken's worth
        /// below it: a redeem lands within one cToken of its amount and never past it.
        #[test]
        fn the_ctokens_for_a_value_are_worth_it_within_one_ctoken(
            x: u64,
            n in 1u64..(1 << 50),
            rate_sf in (1u128 << 60)..(4u128 << 60),
        ) {
            let s = n as u128 * rate_sf;
            if let Some(k) = ctokens_for_value(x, s, n) {
                let value = collateral_value(k, s, n).unwrap();
                prop_assert!(value <= x);
                let one_ctoken = s.div_ceil((n as u128) << 60);
                prop_assert!((x - value) as u128 <= one_ctoken);
            }
        }

        /// The valuation is additive to within one unit: splitting cTokens in two loses at most
        /// one unit of the lent mint to rounding, `V(a) + V(b) <= V(a + b) <= V(a) + V(b) + 1`
        /// (Book of Knowledge KA-3). At rates up to 2 lamports a cToken, with any remainder of
        /// the total supply over the cToken supply, and parts up to 2^62, where nothing is
        /// refused.
        #[test]
        fn the_valuation_is_additive_within_one_unit(
            a in 0u64..(1 << 62),
            b in 0u64..(1 << 62),
            n in 1u64..,
            rate_sf in 0u128..(1 << 61),
            extra: u64,
        ) {
            let s = n as u128 * rate_sf + (extra % n) as u128;
            let value = |k: u64| collateral_value(k, s, n);
            let (Some(whole), Some(va), Some(vb)) = (value(a + b), value(a), value(b)) else {
                return Err(TestCaseError::fail("a value below 2^64 was refused"));
            };
            let parts = va as u128 + vb as u128;
            prop_assert!(parts <= whole as u128, "{} + {} > {}", va, vb, whole);
            prop_assert!(whole as u128 <= parts + 1, "{} > {} + {} + 1", whole, va, vb);
        }

        /// A shortfall within the cTokens' value can always be burned, and the burn is at most
        /// the cTokens held (Book of Knowledge KA-5): for any shortfall from 1 to `V(c)`, or of
        /// any size when the cTokens are worth more than a u64 holds (which `can_pay_now` counts
        /// as `u64::MAX`), the swap's burn succeeds and is at most `c`, so a quote and its swap
        /// never disagree. At rates up to 2 lamports a cToken, with any remainder.
        #[test]
        fn a_shortfall_within_the_ctokens_value_is_always_burned(
            c: u64,
            n in 1u64..,
            rate_sf in 0u128..(1 << 61),
            extra: u64,
            pick: u64,
        ) {
            let s = n as u128 * rate_sf + (extra % n) as u128;
            let reserve = Reserve {
                version: RESERVE_VERSION,
                borrowed_amount_sf: s,
                mint_total_supply: n,
                ..Reserve::default()
            };
            let shortfalls = match collateral_value(c, s, n) {
                Some(0) => return Ok(()),
                Some(value) => [1 + pick % value, value],
                None => [pick.max(1), u64::MAX],
            };
            for shortfall in shortfalls {
                let burn = ctokens_covering(shortfall, s, n);
                prop_assert!(burn.is_some_and(|k| k <= c), "{:?} for {}", burn, shortfall);
                prop_assert_eq!(
                    reserve.ctokens_for_shortfall(shortfall, c).map_err(|e| e as u32),
                    Ok(burn.unwrap())
                );
            }
        }
    }
}

// Kani proofs of the valuation (`cargo kani`, docs/toolchain.md), in the tiers `pricing.rs`
// uses: full domain for properties that need no reasoning about the quotient (nothing panics
// or overflows, whatever the reserve holds), bounded for the quotient's properties, and the
// same properties for every input behind `RUSTFLAGS="--cfg kani_full"`, which may not finish.
// `proofs/kamino_z3.py` proves those for every input with Z3.
#[cfg(kani)]
mod proofs {
    use super::*;

    /// For any cTokens, total supply and cToken supply the reserve's layout allows, the
    /// valuation runs without panicking or overflowing.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn collateral_value_never_panics() {
        let _ = collateral_value(kani::any(), kani::any(), kani::any());
    }

    /// For any fields the layout allows, the total supply never panics or overflows.
    #[kani::proof]
    fn total_supply_sf_never_panics() {
        let _ = total_supply_sf(
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
        );
    }

    /// For any withdrawal cap and time, its remainder never panics or overflows.
    #[kani::proof]
    fn withdrawal_cap_remaining_never_panics() {
        let cap = WithdrawalCap {
            capacity: kani::any(),
            current_total: kani::any(),
            interval_start: kani::any(),
            interval_length: kani::any(),
        };
        let _ = withdrawal_cap_remaining(&cap, kani::any());
    }

    /// Bound of the bounded tier, on the cTokens, the cToken supply and the total supply's
    /// whole units.
    const SMALL: u64 = 1 << 4;

    /// klend's payout, written as klend computes it for amounts small enough for u128:
    /// `floor(floor(c x 2^60 x S / 2^60 / N) / 2^60)`.
    fn klend_payout(c: u64, s: u128, n: u64) -> u128 {
        ((((c as u128) << FRACTION_BITS) * s >> FRACTION_BITS) / n as u128) >> FRACTION_BITS
    }

    fn assert_never_above_klend(c: u64, s: u128, n: u64) {
        if n > 0 {
            let value = collateral_value(c, s, n);
            assert!(value == Some(klend_payout(c, s, n) as u64) || s == 0);
        }
    }

    /// The valuation equals klend's payout, so it never rounds above it, for small amounts at
    /// any fractional rate.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn the_value_never_rounds_above_klends_payout_bounded() {
        let c: u64 = kani::any_where(|&c| c < SMALL);
        let n: u64 = kani::any_where(|&n| n < SMALL);
        let whole: u64 = kani::any_where(|&w| w < SMALL);
        let fraction: u64 = kani::any_where(|&f| f < (1 << FRACTION_BITS));
        let s = ((whole as u128) << FRACTION_BITS) | fraction as u128;
        assert_never_above_klend(c, s, n);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn the_value_never_rounds_above_klends_payout() {
        let (c, n): (u64, u64) = (kani::any(), kani::any());
        let s: u128 = kani::any_where(|&s: &u128| s < (1u128 << 64));
        assert_never_above_klend(c, s, n);
    }

    /// For any amount, the headroom never panics and leaves at most the amount.
    #[kani::proof]
    fn with_rate_headroom_never_panics_and_never_leaves_more() {
        let amount: u64 = kani::any();
        assert!(with_rate_headroom(amount) <= amount);
    }

    fn assert_headroom_never_short(amount: u64) {
        let left = with_rate_headroom(amount);
        let bps = crate::config::KAMINO_RATE_HEADROOM_BPS as u128;
        // The headroom is at least its basis points' share, rounded up: by less than a unit.
        let headroom = (amount - left) as u128;
        assert!(headroom * 10_000 >= amount as u128 * bps);
        assert!(headroom * 10_000 < amount as u128 * bps + 10_000);
    }

    /// The headroom is never short of `KAMINO_RATE_HEADROOM_BPS` of the amount, and rounds up
    /// by less than a unit: bounded below 2^16; `proofs/kamino_z3.py` for every amount.
    #[kani::proof]
    fn the_rate_headroom_is_never_short_bounded() {
        assert_headroom_never_short(kani::any_where(|&a| a < (1 << 16)));
    }

    #[cfg(kani_full)]
    #[kani::proof]
    fn the_rate_headroom_is_never_short() {
        assert_headroom_never_short(kani::any());
    }

    /// For any three terms, what Kamino can pay is never more than any of them, is one of them
    /// unless redeems are stopped, and is nothing while they are.
    #[kani::proof]
    fn kamino_never_pays_more_than_any_term() {
        let (free, cap, own, stopped): (u64, u64, u64, bool) = kani::any();
        let paid = can_pay(free, cap, own, stopped);
        assert!(paid <= free && paid <= cap && paid <= own);
        assert!(stopped || paid == free || paid == cap || paid == own);
        assert!(!stopped || paid == 0);
    }

    /// For any withdrawal cap and time, what remains is exactly klend's count: everything with
    /// no cap, nothing for a negative capacity or an interval that has not started, the whole
    /// capacity once the interval is over, and otherwise the capacity less the net outflow,
    /// nothing once the outflow has passed the capacity.
    #[kani::proof]
    fn the_withdrawal_cap_remaining_is_klends_count() {
        let cap = WithdrawalCap {
            capacity: kani::any(),
            current_total: kani::any(),
            interval_start: kani::any(),
            interval_length: kani::any(),
        };
        let now: u64 = kani::any();
        let left = withdrawal_cap_remaining(&cap, now);
        if cap.interval_length == 0 {
            assert!(left == u64::MAX);
        } else if cap.capacity < 0 || cap.interval_start > now {
            assert!(left == 0);
        } else if now - cap.interval_start >= cap.interval_length {
            assert!(left as i128 == cap.capacity as i128);
        } else if cap.current_total > cap.capacity {
            assert!(left == 0);
        } else {
            assert!(left as i128 == cap.capacity as i128 - cap.current_total as i128);
        }
    }

    /// For any reserve fields, the total supply is klend's: the available amount in fixed
    /// point plus what is borrowed less the three fee fields, in that order, or `None` exactly
    /// where that sum passes 128 bits or a subtraction would go below 0.
    #[kani::proof]
    fn the_total_supply_is_klends() {
        let (available, borrowed, protocol, referrer, pending): (u64, u128, u128, u128, u128) =
            kani::any();
        let gross = ((available as u128) << FRACTION_BITS).checked_add(borrowed);
        let result = total_supply_sf(available, borrowed, protocol, referrer, pending);
        match gross {
            None => assert!(result.is_none()),
            Some(gross) => {
                let after_protocol = gross.checked_sub(protocol);
                let after_referrer = after_protocol.and_then(|g| g.checked_sub(referrer));
                let after_pending = after_referrer.and_then(|g| g.checked_sub(pending));
                assert!(result == after_pending);
                if let Some(supply) = result {
                    assert!(supply + protocol + referrer + pending == gross);
                }
            }
        }
    }

    fn assert_higher_rate_never_values_lower(c: u64, s: u128, extra: u128, n: u64) {
        let higher = s.saturating_add(extra);
        if let (Some(low), Some(high)) = (collateral_value(c, s, n), collateral_value(c, higher, n))
        {
            assert!(low <= high);
        }
    }

    /// A higher rate never values the same cTokens lower, so only a fall in Kamino's rate can
    /// lower the lent side's value: for small amounts at any fractional rate and rise;
    /// `proofs/kamino_z3.py` for every input.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn a_higher_rate_never_values_lower_bounded() {
        let c: u64 = kani::any_where(|&c| c < SMALL);
        let n: u64 = kani::any_where(|&n| n < SMALL);
        let whole: u64 = kani::any_where(|&w| w < SMALL);
        let fraction: u64 = kani::any_where(|&f| f < (1 << FRACTION_BITS));
        let s = ((whole as u128) << FRACTION_BITS) | fraction as u128;
        let extra: u128 = kani::any_where(|&e: &u128| e < (SMALL as u128) << FRACTION_BITS);
        assert_higher_rate_never_values_lower(c, s, extra, n);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn a_higher_rate_never_values_lower() {
        assert_higher_rate_never_values_lower(kani::any(), kani::any(), kani::any(), kani::any());
    }

    /// For any reserve, no cTokens are worth nothing, whatever the reserve holds, even where
    /// its supply cannot be computed.
    #[kani::proof]
    fn no_ctokens_are_worth_nothing() {
        let reserve = Reserve {
            total_available_amount: kani::any(),
            borrowed_amount_sf: kani::any(),
            accumulated_protocol_fees_sf: kani::any(),
            mint_total_supply: kani::any(),
            ..Reserve::default()
        };
        assert!(matches!(reserve.lent_value(0), Ok(0)));
    }

    /// For any reserve, its freely available liquidity never panics and is never more than
    /// its available amount.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn the_freely_available_liquidity_is_at_most_the_available_amount() {
        let reserve = Reserve {
            total_available_amount: kani::any(),
            borrowed_amount_sf: kani::any(),
            mint_total_supply: kani::any(),
            queued_collateral_amount: kani::any(),
            ..Reserve::default()
        };
        assert!(reserve.freely_available() <= reserve.total_available_amount);
    }

    /// For a small reserve at any state of its switches and cap, what a redeem may plan to
    /// take is never more than what Kamino can pay right now, which is never more than the
    /// market's cTokens are worth, and both are nothing while redeems are stopped; what the
    /// reserve alone shows is never less than what the lending market's emergency mode allows.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn a_planned_redeem_never_asks_more_than_kamino_can_pay_bounded() {
        let small = |x: &u64| *x < SMALL;
        let reserve = Reserve {
            version: if kani::any() {
                RESERVE_VERSION
            } else {
                u64::MAX
            },
            total_available_amount: kani::any_where(small),
            mint_total_supply: kani::any_where(small),
            emergency_mode: kani::any(),
            withdrawal_cap: WithdrawalCap {
                capacity: kani::any_where(|&c| (-1..SMALL as i64).contains(&c)),
                current_total: kani::any_where(|&c| (-1..SMALL as i64).contains(&c)),
                interval_start: kani::any_where(small),
                interval_length: kani::any_where(small),
            },
            ..Reserve::default()
        };
        let market = LendingMarket {
            emergency_mode: kani::any(),
        };
        let ctokens: u64 = kani::any_where(small);
        let now: i64 = kani::any_where(|&t| (-1..SMALL as i64).contains(&t));
        let planned = reserve.can_pay_planned(&market, ctokens, now);
        let can_pay_now = reserve.can_pay_now(&market, ctokens, now);
        assert!(planned <= can_pay_now);
        assert!(can_pay_now <= reserve.lent_value(ctokens).unwrap_or(u64::MAX));
        assert!(can_pay_now <= reserve.freely_available());
        if reserve.redeems_stopped(&market) {
            assert!(planned == 0 && can_pay_now == 0);
        }
        assert!(reserve.can_pay_by_itself(ctokens, now) >= planned);
    }

    /// A small reserve at a rate of `whole` plus sixteenths: the total supply's 60 fractional
    /// bits, symbolic in the other bounded harnesses, are held to their top four here, since
    /// these harnesses run several long divisions each.
    fn small_reserve(whole: u64, sixteenths: u64, n: u64) -> Reserve {
        Reserve {
            total_available_amount: whole,
            borrowed_amount_sf: (sixteenths as u128) << (FRACTION_BITS - 4),
            mint_total_supply: n,
            ..Reserve::default()
        }
    }

    /// The cTokens `rebalance` burns for an amount are never more than the market holds, all of
    /// them once it asks for their whole value, and otherwise worth at most the amount at the
    /// stored rate: for small amounts at rates in sixteenths.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn a_redeem_burns_at_most_what_the_market_holds_and_what_it_asks_for_bounded() {
        let small = |x: &u64| *x < SMALL;
        let reserve = small_reserve(
            kani::any_where(small),
            kani::any_where(|&f| f < 16),
            kani::any_where(small),
        );
        let (liquidity, ctokens): (u64, u64) = (kani::any_where(small), kani::any_where(small));
        if let Ok(burn) = reserve.ctokens_to_redeem(liquidity, ctokens) {
            assert!(burn <= ctokens);
            let value = reserve.lent_value(ctokens).unwrap();
            if liquidity >= value {
                // Asking for the whole value burns everything.
                assert!(burn == ctokens);
            } else {
                assert!(burn > 0 && reserve.lent_value(burn).unwrap() <= liquidity);
            }
        }
    }

    /// The cTokens a swap burns for its shortfall are never more than the market holds and are
    /// worth at least the shortfall at the stored rate; a reserve with no cTokens values every
    /// cToken at nothing, so Kamino can pay nothing from it and no swap ever has a shortfall to
    /// cover there. For small amounts at rates in sixteenths.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn a_shortfall_burns_at_most_what_the_market_holds_and_covers_it_bounded() {
        let small = |x: &u64| *x < SMALL;
        let n: u64 = kani::any_where(small);
        let reserve = small_reserve(kani::any_where(small), kani::any_where(|&f| f < 16), n);
        let (shortfall, ctokens): (u64, u64) = (kani::any_where(small), kani::any_where(small));
        if let Ok(burn) = reserve.ctokens_for_shortfall(shortfall, ctokens) {
            assert!(burn <= ctokens);
            assert!(reserve.lent_value(burn).is_ok_and(|v| v >= shortfall) || n == 0);
        }
    }

    /// For any value, total supply and cToken supply, the cTokens for the value are computed
    /// without panicking or overflowing.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn ctokens_for_value_never_panics() {
        let _ = ctokens_for_value(kani::any(), kani::any(), kani::any());
    }

    fn assert_worth_at_most_and_within_one_ctoken(x: u64, s: u128, n: u64) {
        if let Some(k) = ctokens_for_value(x, s, n) {
            if n > 0 {
                let value = collateral_value(k, s, n).unwrap();
                assert!(value <= x);
                assert!(
                    ((x - value) as u128) << FRACTION_BITS
                        <= s.div_ceil(n as u128).saturating_add(1u128 << FRACTION_BITS)
                );
            }
        }
    }

    /// The cTokens for a value are worth at most it, within one cToken's worth, for small
    /// amounts at any fractional rate.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn the_ctokens_for_a_value_are_worth_it_within_one_ctoken_bounded() {
        let x: u64 = kani::any_where(|&x| x < SMALL);
        let n: u64 = kani::any_where(|&n| n > 0 && n < SMALL);
        let whole: u64 = kani::any_where(|&w| w > 0 && w < SMALL);
        let fraction: u64 = kani::any_where(|&f| f < (1 << FRACTION_BITS));
        let s = ((whole as u128) << FRACTION_BITS) | fraction as u128;
        assert_worth_at_most_and_within_one_ctoken(x, s, n);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn the_ctokens_for_a_value_are_worth_it_within_one_ctoken() {
        assert_worth_at_most_and_within_one_ctoken(kani::any(), kani::any(), kani::any());
    }

    /// For any shortfall, total supply and cToken supply, the cTokens covering it are computed
    /// without panicking or overflowing.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn ctokens_covering_never_panics() {
        let _ = ctokens_covering(kani::any(), kani::any(), kani::any());
    }

    fn assert_worth_at_least_and_at_most_one_ctoken_more(x: u64, s: u128, n: u64) {
        if let Some(k) = ctokens_covering(x, s, n) {
            if n > 0 {
                assert!(collateral_value(k, s, n).is_none_or(|value| value >= x));
                if k > 0 {
                    assert!(collateral_value(k - 1, s, n).unwrap() < x);
                }
            }
        }
    }

    /// The cTokens a swap burns for its shortfall are worth at least the shortfall at the
    /// stored rate, and one fewer would be worth less, so they are at most one cToken more than
    /// needed, for small amounts at any fractional rate.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn the_ctokens_covering_a_shortfall_are_the_fewest_worth_it_bounded() {
        let x: u64 = kani::any_where(|&x| x < SMALL);
        let n: u64 = kani::any_where(|&n| n > 0 && n < SMALL);
        let whole: u64 = kani::any_where(|&w| w > 0 && w < SMALL);
        let fraction: u64 = kani::any_where(|&f| f < (1 << FRACTION_BITS));
        let s = ((whole as u128) << FRACTION_BITS) | fraction as u128;
        assert_worth_at_least_and_at_most_one_ctoken_more(x, s, n);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn the_ctokens_covering_a_shortfall_are_the_fewest_worth_it() {
        assert_worth_at_least_and_at_most_one_ctoken_more(kani::any(), kani::any(), kani::any());
    }

    fn assert_valuation_is_additive_within_one_unit(a: u64, b: u64, s: u128, n: u64) {
        let Some(sum) = a.checked_add(b) else {
            return;
        };
        if let Some(whole) = collateral_value(sum, s, n) {
            // Each part is worth no more than the whole, so it is valued too.
            let parts = collateral_value(a, s, n).unwrap() as u128
                + collateral_value(b, s, n).unwrap() as u128;
            assert!(parts <= whole as u128 && whole as u128 <= parts + 1);
        }
    }

    /// The valuation is additive to within one unit, `V(a) + V(b) <= V(a + b) <= V(a) + V(b) +
    /// 1`, so splitting cTokens (a redeem, a burn, a removal's part) loses at most one unit to
    /// rounding (Book of Knowledge KA-3): for small amounts at any fractional rate;
    /// `proofs/kamino_z3.py` for every input.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn the_valuation_is_additive_within_one_unit_bounded() {
        let a: u64 = kani::any_where(|&a| a < SMALL);
        let b: u64 = kani::any_where(|&b| b < SMALL);
        let n: u64 = kani::any_where(|&n| n < SMALL);
        let whole: u64 = kani::any_where(|&w| w < SMALL);
        let fraction: u64 = kani::any_where(|&f| f < (1 << FRACTION_BITS));
        let s = ((whole as u128) << FRACTION_BITS) | fraction as u128;
        assert_valuation_is_additive_within_one_unit(a, b, s, n);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn the_valuation_is_additive_within_one_unit() {
        assert_valuation_is_additive_within_one_unit(
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
        );
    }

    fn assert_a_shortfall_within_the_value_is_burned(
        shortfall: u64,
        ctokens: u64,
        s: u128,
        n: u64,
    ) {
        // `can_pay_now` counts cTokens worth more than a u64 holds as worth `u64::MAX`.
        let within = collateral_value(ctokens, s, n).is_none_or(|value| shortfall <= value);
        if shortfall > 0 && within {
            assert!(ctokens_covering(shortfall, s, n).is_some_and(|burn| burn <= ctokens));
        }
    }

    /// A shortfall within the cTokens' value can always be burned, and the burn is at most the
    /// cTokens held, so a quote that accepts a shortfall up to what Kamino can pay never meets a
    /// swap that refuses it (Book of Knowledge KA-5): for small amounts at any fractional rate;
    /// `proofs/kamino_z3.py` for every input.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn a_shortfall_within_the_ctokens_value_is_always_burned_bounded() {
        let shortfall: u64 = kani::any_where(|&x| x < SMALL);
        let ctokens: u64 = kani::any_where(|&c| c < SMALL);
        let n: u64 = kani::any_where(|&n| n < SMALL);
        let whole: u64 = kani::any_where(|&w| w < SMALL);
        let fraction: u64 = kani::any_where(|&f| f < (1 << FRACTION_BITS));
        let s = ((whole as u128) << FRACTION_BITS) | fraction as u128;
        assert_a_shortfall_within_the_value_is_burned(shortfall, ctokens, s, n);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn a_shortfall_within_the_ctokens_value_is_always_burned() {
        assert_a_shortfall_within_the_value_is_burned(
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
        );
    }
}
