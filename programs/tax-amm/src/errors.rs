//! The tax AMM's errors. Anchor numbers them from 6000 in this order, and Aviary and
//! integrators show them by number, so new errors only ever go at the end.

use anchor_lang::prelude::*;

#[error_code]
pub enum StrategyError {
    #[msg("Init data is not valid creation parameters")]
    BadInitData,
    #[msg("Caller is not this market's Pipeline market")]
    NotPipeline,
    #[msg("Unexpected account")]
    WrongAccount,
    #[msg("A market's two mints must differ")]
    EqualMints,
    #[msg("A market's mints must be SPL Token or Token-2022 mints")]
    NotAMint,
    #[msg("The mint carries an extension the mint rules refuse")]
    MintExtensionNotAllowed,
    #[msg("The token program is not the mint's")]
    WrongTokenProgram,
    #[msg("The tax side must be 0 or 1")]
    BadTaxSide,
    #[msg("The virtual side must be 0 or 1")]
    BadVirtualSide,
    #[msg("A tax range may not go above MAX_TAX_BPS")]
    TaxAboveCap,
    #[msg("A tax range's minimum is above its maximum")]
    RangeInverted,
    #[msg("A tax rate is outside its range")]
    RateOutsideRange,
    #[msg("The seeder must not be the default key")]
    NoSeeder,
    #[msg("A market needs at least one tax recipient")]
    NoRecipient,
    #[msg("Used recipient slots come first, unused slots after them")]
    RecipientsOutOfOrder,
    #[msg("A used recipient slot needs a share above 0")]
    ZeroShare,
    #[msg("An unused recipient slot must have no share")]
    ShareWithoutRecipient,
    #[msg("The recipients' shares and the burn share must sum to 10,000")]
    SharesNotWhole,
    #[msg("Native SOL can't be burned, so its tax side has no burn share")]
    BurnOnNativeSol,
    #[msg("The market is not open: it has not been seeded")]
    MarketNotOpen,
    #[msg("Exact-out swaps are not supported")]
    ExactOutNotSupported,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Only the market's seeder can seed it")]
    NotSeeder,
    #[msg("The market has already been seeded")]
    AlreadySeeded,
    #[msg("A side without a virtual reserve needs a seed above 0")]
    ZeroSeed,
    #[msg("The trade's output would be 0")]
    ZeroOutput,
    #[msg("The trade would pay out more than the market's real reserve")]
    InsufficientLiquidity,
    #[msg("The market has no tax authority, so its taxes and recipients never change")]
    NoTaxAuthority,
    #[msg("The tax authority renounced, so the market's taxes and recipients never change again")]
    AlreadyRenounced,
    #[msg("Only the market's tax authority can change its taxes and recipients")]
    NotTaxAuthority,
    #[msg("A recipient slot still owed tax can't be emptied; pay it out or name another wallet")]
    OwedSlotLeftEmpty,
    #[msg("A seed request gives one amount for each of the market's two mints")]
    BadSeedAmounts,
    #[msg(
        "No such tax slot: there is one per tax recipient, then the burn's and the suite share's"
    )]
    NoSuchSlot,
    #[msg("The tax recipient slot is unused: it has no wallet to pay")]
    UnusedSlot,
    #[msg("The wallet is not the tax slot's")]
    NotSlotWallet,
    #[msg(
        "The token account is not the slot wallet's associated token account for the tax-side mint"
    )]
    NotSlotTokenAccount,
    #[msg("The burn lowers the tax-side mint's supply, so it needs the mint writable")]
    BurnNeedsWritableMint,
    #[msg(
        "A tax recipient can't be one of the market's own addresses or programs, which could never move what it is paid"
    )]
    NotAWallet,
    #[msg("The market state was written by a newer version of this program than the one running")]
    NewerStateVersion,
    #[msg("Arithmetic underflow")]
    Underflow,
}
