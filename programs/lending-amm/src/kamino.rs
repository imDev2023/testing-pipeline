//! Every read of Kamino Lend (klend), in one place (docs/spec/lending-pool.md, "Building it"):
//! the reserve check, the reserve's total supply and stored exchange rate, its flags, and what
//! Kamino can pay right now. [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80)
//! adds Kamino's deposit and redeem calls here too, so a later strategy version can add
//! another lending market without touching the pool's maths.
//!
//! The offsets, discriminators and formulas are written by hand from klend release 1.28.0
//! (`686913e`), as the Kamino facts, section 4, list them; the program never depends on
//! klend's crate, which is BSL 1.1 (docs/spec/lending-pool.md, "Building it").
//!
//! The maths is in pure functions of numbers ([`total_supply_sf`], [`collateral_value`],
//! [`withdrawal_cap_remaining`], [`can_pay`]), which Proptest, Kani and Z3 check on their
//! own; the account functions only check and decode.
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
    pub const EMERGENCY_MODE: usize = 122;
}

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

    /// What `ctokens` cTokens are worth at the stored rate, `V`.
    pub fn lent_value(&self, ctokens: u64) -> core::result::Result<u64, StrategyError> {
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

    /// What Kamino can pay a market holding `ctokens` right now, at Unix time `now`
    /// (docs/spec/lending-pool.md, "Redeeming the shortfall").
    pub fn can_pay_now(&self, market: &LendingMarket, ctokens: u64, now: i64) -> u64 {
        let stopped = market.emergency_mode || self.emergency_mode || self.deprecated();
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
    fn kamino_pays_the_smallest_term_and_nothing_when_stopped() {
        assert_eq!(can_pay(5, 7, 9, false), 5);
        assert_eq!(can_pay(9, 5, 7, false), 5);
        assert_eq!(can_pay(7, 9, 5, false), 5);
        assert_eq!(can_pay(7, 9, 5, true), 0);
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
}
