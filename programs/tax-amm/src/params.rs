//! The creation parameters and every rule on them (docs/spec/tax-amm.md, "Creation
//! parameters"). Every policy value that is not a build-time constant (`crate::config`) is
//! one of these, chosen per market and kept in its market state.

use anchor_lang::prelude::*;

use crate::config::{MAX_RECIPIENTS, MAX_TAX_BPS};
use crate::errors::StrategyError;

/// The native SOL mints of SPL Token and Token-2022: tokens that can't be burned.
pub const NATIVE_MINTS: [Pubkey; 2] = [
    pubkey!("So11111111111111111111111111111111111111112"),
    pubkey!("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP"),
];

/// `create_market`'s `init_data`: these fields, Borsh-encoded in this order.
///
/// `metadata.json`'s `init.args` lists the same fields, with the arrays flattened into
/// `recipient_0` to `recipient_3` and `share_0` to `share_3`, because metadata arguments
/// have no arrays; a fixed-size array encodes exactly as its elements one after another,
/// so both describe the same bytes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitParams {
    /// The mint index (0 or 1) every tax is taken in, fixed for the market's life.
    pub tax_side: u8,
    pub buy_tax_bps: u16,
    pub sell_tax_bps: u16,
    pub buy_tax_min_bps: u16,
    pub buy_tax_max_bps: u16,
    pub sell_tax_min_bps: u16,
    pub sell_tax_max_bps: u16,
    /// May change the rates inside their ranges and the recipients; the default key means
    /// none, so the market's taxes and recipients never change.
    pub tax_authority: Pubkey,
    /// The only signer the seed action accepts.
    pub seeder: Pubkey,
    /// Owner wallets; used slots first, unused slots the default key.
    pub recipients: [Pubkey; MAX_RECIPIENTS],
    /// Each used slot's share in basis points of the creator's part, above 0; unused 0.
    pub shares: [u16; MAX_RECIPIENTS],
    /// The burn's share of the creator's part.
    pub burn_share_bps: u16,
    /// The mint index (0 or 1) whose reserve the virtual reserve adds to in pricing.
    pub virtual_side: u8,
    /// 0 for none.
    pub virtual_reserve: u64,
}

impl InitParams {
    /// Checks every rule on the parameters of a market trading `mints`, in index order.
    pub fn validate(&self, mints: &[Pubkey; 2]) -> core::result::Result<(), StrategyError> {
        if self.tax_side > 1 {
            return Err(StrategyError::BadTaxSide);
        }
        if self.virtual_side > 1 {
            return Err(StrategyError::BadVirtualSide);
        }
        check_rates(
            [self.buy_tax_bps, self.sell_tax_bps],
            [
                [self.buy_tax_min_bps, self.buy_tax_max_bps],
                [self.sell_tax_min_bps, self.sell_tax_max_bps],
            ],
        )?;
        if self.seeder == Pubkey::default() {
            return Err(StrategyError::NoSeeder);
        }
        check_split(
            &self.recipients,
            &self.shares,
            self.burn_share_bps,
            &mints[self.tax_side as usize],
        )
    }
}

/// The rules on the buy and sell tax (`rates`, in that order), each inside its `[min, max]`
/// range, every range inside `[0, MAX_TAX_BPS]`: checked at creation and by `set_taxes`,
/// so no sequence of calls can take a rate past its range or the cap.
pub fn check_rates(
    rates: [u16; 2],
    ranges: [[u16; 2]; 2],
) -> core::result::Result<(), StrategyError> {
    for (rate, [min, max]) in rates.into_iter().zip(ranges) {
        if max > MAX_TAX_BPS {
            return Err(StrategyError::TaxAboveCap);
        }
        if min > max {
            return Err(StrategyError::RangeInverted);
        }
        if rate < min || rate > max {
            return Err(StrategyError::RateOutsideRange);
        }
    }
    Ok(())
}

/// The rules on the tax recipients, their shares and the burn share of a market whose tax
/// is taken in `tax_mint`: checked at creation and by `set_recipients`, which follows the
/// rules of creation exactly.
pub fn check_split(
    recipients: &[Pubkey; MAX_RECIPIENTS],
    shares: &[u16; MAX_RECIPIENTS],
    burn_share_bps: u16,
    tax_mint: &Pubkey,
) -> core::result::Result<(), StrategyError> {
    let used = used_slots(recipients);
    if used == 0 {
        return Err(StrategyError::NoRecipient);
    }
    if recipients[used..]
        .iter()
        .any(|recipient| *recipient != Pubkey::default())
    {
        return Err(StrategyError::RecipientsOutOfOrder);
    }
    if shares[..used].contains(&0) {
        return Err(StrategyError::ZeroShare);
    }
    if shares[used..].iter().any(|&share| share != 0) {
        return Err(StrategyError::ShareWithoutRecipient);
    }
    let total: u32 = shares.iter().map(|&share| share as u32).sum::<u32>() + burn_share_bps as u32;
    // Every share is in basis points of the creator's part of the tax.
    if total as u64 != pipeline_strategy_interface::BPS_DENOMINATOR {
        return Err(StrategyError::SharesNotWhole);
    }
    if burn_share_bps > 0 && NATIVE_MINTS.contains(tax_mint) {
        return Err(StrategyError::BurnOnNativeSol);
    }
    Ok(())
}

/// How many recipient slots are used: the leading slots that name a wallet.
pub fn used_slots(recipients: &[Pubkey; MAX_RECIPIENTS]) -> usize {
    recipients
        .iter()
        .take_while(|recipient| **recipient != Pubkey::default())
        .count()
}

// Kani proofs of the rules on rates and shares (`cargo kani`, docs/toolchain.md), which
// creation, `set_taxes` and `set_recipients` all apply; the property IDs are
// docs/security/tax-amm/maths-properties.md's.
#[cfg(kani)]
mod proofs {
    use super::*;

    fn any_key() -> Pubkey {
        Pubkey::new_from_array(kani::any())
    }

    /// T2 where rates are stored: for any rates and ranges, the rules accept them only
    /// with every range inside `[0, MAX_TAX_BPS]` and each rate inside its range, so no
    /// market state ever holds a rate above the cap, at creation or after `set_taxes`.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_rules_accept_only_capped_rates() {
        let rates: [u16; 2] = kani::any();
        let ranges: [[u16; 2]; 2] = kani::any();
        if check_rates(rates, ranges).is_ok() {
            for (rate, [min, max]) in rates.into_iter().zip(ranges) {
                assert!(min <= rate && rate <= max && max <= MAX_TAX_BPS);
            }
        }
    }

    /// P1 where shares are stored: for any recipients, shares, burn share and tax mint, the
    /// rules accept them only when the shares and the burn share sum to exactly 10,000, the
    /// shares `split_tax` books, at creation or after `set_recipients`.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_rules_accept_only_whole_shares() {
        let recipients = [any_key(), any_key(), any_key(), any_key()];
        let shares: [u16; MAX_RECIPIENTS] = kani::any();
        let burn: u16 = kani::any();
        if check_split(&recipients, &shares, burn, &any_key()).is_ok() {
            let whole = shares.iter().map(|&share| share as u32).sum::<u32>() + burn as u32;
            assert!(whole as u64 == pipeline_strategy_interface::BPS_DENOMINATOR);
        }
    }
}
