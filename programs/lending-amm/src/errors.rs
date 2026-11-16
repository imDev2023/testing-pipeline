//! The lending AMM's errors. Anchor numbers them from 6000 in this order, and Aviary and
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
    #[msg("The market state is not the PDA of its mints, lent side and fee")]
    WrongMarketState,
    #[msg("A market's two mints must differ")]
    EqualMints,
    #[msg("A market's mints must be SPL Token or Token-2022 mints")]
    NotAMint,
    #[msg("The mint carries an extension the mint rules refuse")]
    MintExtensionNotAllowed,
    #[msg("The token program is not the mint's")]
    WrongTokenProgram,
    #[msg("The lent index must be 0 or 1")]
    BadLentIndex,
    #[msg("The lent mint is not on this cluster's list of lent mints")]
    LentMintNotListed,
    #[msg("The lent mint must be owned by SPL Token")]
    LentMintNotSplToken,
    #[msg("The LP fee may not go above MAX_LP_FEE_BPS")]
    LpFeeAboveCap,
    #[msg("The collateral mint is not the lent mint's Kamino reserve's")]
    WrongCollateralMint,
    #[msg("The market is not open: it has had no first deposit")]
    MarketNotOpen,
    #[msg("Exact-out swaps are not supported")]
    ExactOutNotSupported,
    #[msg("The trade would pay out nothing")]
    ZeroOutput,
    #[msg("The trade would pay out a side's whole reserve")]
    WouldEmptySide,
    #[msg("The trade would pay out more of the lent side than the buffer holds plus what Kamino can pay right now")]
    BeyondBuffer,
    #[msg("The first deposit needs both amounts above 0")]
    ZeroDeposit,
    #[msg("The first deposit is too small to mint any shares above the locked minimum")]
    FirstDepositTooSmall,
    #[msg("The deposit would mint no shares")]
    ZeroShares,
    #[msg("The deposit would mint fewer shares than min_lp")]
    BelowMinLp,
    /// No longer returned: cTokens are valued from Kamino's reserve since
    /// [#79](https://github.com/imDev2023/testing-pipeline/issues/79). Kept so that every later
    /// error keeps its number.
    #[msg("The market holds cTokens, which this version cannot value yet")]
    LentValueUnavailable,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("A side of the market holds nothing to price a deposit against")]
    EmptySide,
    #[msg("The Kamino reserve is not the one the market's lent mint lends to")]
    ReserveWrongAddress,
    #[msg("The Kamino reserve is not owned by Kamino Lend")]
    ReserveNotKamino,
    #[msg("The Kamino reserve does not have a reserve's size")]
    ReserveWrongSize,
    #[msg("The Kamino reserve does not carry a reserve's discriminator")]
    ReserveWrongDiscriminator,
    #[msg("The Kamino reserve belongs to another lending market")]
    ReserveWrongLendingMarket,
    #[msg("The Kamino reserve lends another mint")]
    ReserveWrongLiquidityMint,
    #[msg("The Kamino reserve has another collateral mint")]
    ReserveWrongCollateralMint,
    #[msg("The Kamino reserve's total supply cannot be computed")]
    ReserveSupplyInvalid,
    #[msg("The Kamino lending market account is not the lent mint's lending market")]
    LendingMarketWrongAccount,
    #[msg("The buffer's share of the lent side is inside its band: there is nothing to rebalance")]
    WithinBand,
    #[msg("The move is smaller than the lent mint's MIN_REBALANCE, so it is skipped")]
    BelowMinRebalance,
    #[msg("A Kamino account is not the one the lent mint's reserve names")]
    KaminoAccountWrong,
    #[msg("The trade needs a redeem from Kamino, but was built without the redeem accounts: resolve its accounts again")]
    RedeemAccountsMissing,
    #[msg("Kamino's redeem paid the market less than the swap's shortfall")]
    RedeemPaidShort,
    #[msg("The removal would burn no LP shares or pay out nothing")]
    ZeroRemoval,
    #[msg("The removal burns more LP shares than the market has minted")]
    NotEnoughShares,
    #[msg("The removal would pay out less of the other mint than min_other")]
    BelowMinOther,
    #[msg("The removal would pay out less of the lent mint than min_lent")]
    BelowMinLent,
    #[msg("A removal in cash needs the lent mint's Kamino accounts: add them, or remove in kind")]
    KaminoAccountsMissing,
    #[msg("Kamino cannot pay the cTokens' part right now: remove in kind")]
    KaminoCannotPay,
    #[msg("Locking needs at least one LP share")]
    ZeroLock,
    #[msg("Kamino redeems nothing right now (reserve or lending market emergency mode, or a deprecated reserve): rebalance refuses")]
    KaminoStopped,
    #[msg("Kamino blocks cToken deposits into the reserve: rebalance skips the deposit")]
    KaminoDepositsBlocked,
    #[msg("The Kamino reserve is deprecated after a total write-off: adding liquidity is refused, and removal is in kind only")]
    ReserveDeprecated,
    #[msg("rebalance must be called directly, beside nothing but compute budget instructions, klend's refresh_reserve and other rebalance calls")]
    RebalanceNotAlone,
}
