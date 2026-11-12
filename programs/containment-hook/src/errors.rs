//! The containment hook's errors. Anchor numbers them from 6000 in this order, and Aviary
//! and integrators show them by number, so new errors only ever go at the end.

use anchor_lang::prelude::*;

#[error_code]
pub enum HookError {
    #[msg("A contained token can't be transferred there")]
    TransferRefused,
    #[msg("The mint is not owned by Token-2022")]
    MintNotToken2022,
    #[msg("The account is not an initialized mint")]
    NotAMint,
    #[msg("The mint carries an extension the mint rules refuse")]
    MintExtensionNotAllowed,
    #[msg("A contained mint must have no freeze authority")]
    FreezeAuthoritySet,
    #[msg("The signer is not the mint's mint authority")]
    NotMintAuthority,
    #[msg("The mint's transfer hook program is not this program")]
    WrongHookProgram,
    #[msg("The mint's transfer hook authority is not its unlock PDA")]
    WrongHookAuthority,
    #[msg("The unlock goal must be above zero")]
    ZeroGoal,
    #[msg("The unlock deadline must be later than now")]
    DeadlineNotInFuture,
    #[msg("The unlock deadline may be at most MAX_UNLOCK_DEADLINE_SECS after the binding")]
    DeadlineTooFar,
    #[msg("The market is not a Market account of Pipeline's router")]
    NotARouterMarket,
    #[msg("The Market account is not at its router PDA")]
    MarketNotAtItsAddress,
    #[msg("The home market must run on the tax AMM")]
    NotATaxMarket,
    #[msg("The home market must trade the mint against one quote mint")]
    MarketDoesNotHoldMint,
    #[msg("The market state is not the one the Market records")]
    WrongMarketState,
    #[msg("The market state is not a tax AMM market state")]
    NotATaxMarketState,
    #[msg("The home market's tax must be taken in the quote mint")]
    TaxSideNotQuote,
    #[msg("Execute runs only inside a Token-2022 transfer of this mint")]
    NotTransferring,
    #[msg("The config is not this mint's, at its address and owned by the hook")]
    WrongConfig,
    #[msg("The validation account is not this mint's, at its address and owned by the hook")]
    WrongValidationAccount,
}
