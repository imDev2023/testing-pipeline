//! `pipeline_swap`: settles a trade the router sends.
//!
//! Only this market's router market may call it, so every trade pays Pipeline's fee,
//! emits a swap event and counts in the market's counters (bypass is refused: ADR 0001).
//! A market trades only once it is seeded, which arrives with the pricing and the taxes
//! ([Tax AMM: seed a market and trade it](https://github.com/imDev2023/testing-pipeline/issues/60)),
//! so until then every swap is refused.

use anchor_lang::prelude::*;

use crate::errors::StrategyError;
use crate::instructions::SwapAccounts;
use crate::interface::SwapRequest;
use crate::state::MarketStatus;

pub fn swap(ctx: Context<SwapAccounts>, _request: SwapRequest) -> Result<()> {
    let market = &ctx.accounts.market_state;
    require_keys_eq!(
        ctx.accounts.market_signer.key(),
        market.market_signer,
        StrategyError::NotPipeline
    );
    match market.status {
        MarketStatus::Created => err!(StrategyError::MarketNotOpen),
    }
}
