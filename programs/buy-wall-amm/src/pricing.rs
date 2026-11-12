//! The one pricing function `pipeline_quote` and `pipeline_swap` share, so a quote is exactly
//! what the swap does (docs/spec/pool4-for-solana.md, "Pricing").
//!
//! In this build every request is refused: exact-out always (`POOL4-14`), anything before
//! the seed, and every exact-in trade after it until plain trading lands
//! ([Buy wall AMM: plain trading through the router](https://github.com/imDev2023/testing-pipeline/issues/48)),
//! which prices here.

use anchor_lang::prelude::*;
use pipeline_strategy_interface::QuoteResult;

use crate::interface::{TradeMode, TradeRequest};

use crate::errors::StrategyError;
use crate::state::{MarketState, STATUS_OPEN};

/// Exact-in only (`POOL4-14`): an exact-out quote or swap is refused.
pub const SUPPORTS_EXACT_OUT: bool = false;

/// Prices `request` on `state`. Reads no clock, so a quote never depends on when it is
/// asked.
pub fn quote(state: &MarketState, request: &TradeRequest) -> Result<QuoteResult> {
    require!(
        request.mode == TradeMode::ExactIn,
        StrategyError::ExactOutNotSupported
    );
    state.vaults(request.input_index, request.output_index)?;
    require!(state.status == STATUS_OPEN, StrategyError::MarketNotOpen);
    err!(StrategyError::TradingNotAvailable)
}
