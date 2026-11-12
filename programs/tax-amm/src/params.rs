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

/// Every share is in basis points of the creator's part of the tax.
pub const BPS: u32 = 10_000;

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
        for (rate, min, max) in [
            (self.buy_tax_bps, self.buy_tax_min_bps, self.buy_tax_max_bps),
            (
                self.sell_tax_bps,
                self.sell_tax_min_bps,
                self.sell_tax_max_bps,
            ),
        ] {
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
        if self.seeder == Pubkey::default() {
            return Err(StrategyError::NoSeeder);
        }
        let used = self
            .recipients
            .iter()
            .take_while(|recipient| **recipient != Pubkey::default())
            .count();
        if used == 0 {
            return Err(StrategyError::NoRecipient);
        }
        if self.recipients[used..]
            .iter()
            .any(|recipient| *recipient != Pubkey::default())
        {
            return Err(StrategyError::RecipientsOutOfOrder);
        }
        if self.shares[..used].contains(&0) {
            return Err(StrategyError::ZeroShare);
        }
        if self.shares[used..].iter().any(|&share| share != 0) {
            return Err(StrategyError::ShareWithoutRecipient);
        }
        let total: u32 =
            self.shares.iter().map(|&share| share as u32).sum::<u32>() + self.burn_share_bps as u32;
        if total != BPS {
            return Err(StrategyError::SharesNotWhole);
        }
        if self.burn_share_bps > 0 && NATIVE_MINTS.contains(&mints[self.tax_side as usize]) {
            return Err(StrategyError::BurnOnNativeSol);
        }
        Ok(())
    }
}
