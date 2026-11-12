//! The program's errors. Their numbers are part of what clients see, so new errors are
//! only ever appended.

use anchor_lang::prelude::*;

#[error_code]
pub enum StrategyError {
    #[msg("Init data is not valid creation parameters")]
    BadInitData,
    #[msg("Caller is not this market's Pipeline market")]
    NotPipeline,
    #[msg("Unexpected account")]
    WrongAccount,
    #[msg("Not a buy wall market state of a deployed layout")]
    NotAMarket,
    #[msg("The fee must be between MIN_FEE_BPS and MAX_FEE_BPS")]
    FeeOutOfRange,
    #[msg("The wall split must be at most 10,000 basis points")]
    WallSplitOutOfRange,
    #[msg("A fee recipient is required unless the whole market share goes to the wall")]
    FeeRecipientRequired,
    #[msg("The reward share must be at most MAX_REWARD_SHARE_BPS")]
    RewardShareOutOfRange,
    #[msg("A rewards recipient is required exactly when the reward share is above 0")]
    RewardsRecipientMismatch,
    #[msg("The cap floor must be between MIN_CAP_FLOOR_BPS and 10,000 basis points")]
    CapFloorOutOfRange,
    #[msg("The cap decay must be at most MAX_CAP_DECAY_BPS")]
    CapDecayOutOfRange,
    #[msg("The seeder must not be the default key")]
    SeederRequired,
    #[msg("The token must not be wrapped SOL, SPL Token's or Token-2022's")]
    SameMint,
    #[msg("The token carries a Token-2022 extension outside the allowlist")]
    MintExtensionNotAllowed,
    #[msg("Only the market's seeder may seed it")]
    NotSeeder,
    #[msg("The market is already seeded")]
    AlreadySeeded,
    #[msg("The token's mint authority must be removed before the seed")]
    MintAuthorityLive,
    #[msg("The token's freeze authority must be removed before the seed")]
    FreezeAuthorityLive,
    #[msg("The seed brought no tokens")]
    EmptySeed,
    #[msg("The seed must bring at least MIN_SEED_LAMPORTS")]
    SeedTooSmall,
    #[msg("The opening price is outside the opening bounds")]
    OpeningPriceOutOfBounds,
    #[msg("The curve at the cap floor would hold less than MIN_LIQUIDITY")]
    CapFloorTooThin,
    #[msg("The market is not seeded yet")]
    MarketNotOpen,
    #[msg("Exact-out trades are not supported")]
    ExactOutNotSupported,
    #[msg("Trading is not available in this build")]
    TradingNotAvailable,
    #[msg("Arithmetic overflow")]
    Overflow,
}
