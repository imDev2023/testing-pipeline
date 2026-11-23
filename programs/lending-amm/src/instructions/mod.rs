//! One module per instruction, so parallel tickets rarely touch the same lines.

pub mod add_liquidity;
pub mod init_market;
pub mod lock_lp;
pub mod market_info;
pub mod quote;
pub mod rebalance;
pub mod remove_lent_side;
pub mod remove_liquidity;
pub mod resolve_accounts;
pub mod seed_liquidity;
pub mod swap;
pub mod trade_accounts;

pub use add_liquidity::*;
pub use init_market::*;
pub use lock_lp::*;
pub use market_info::*;
pub use quote::*;
pub use rebalance::*;
pub use remove_lent_side::*;
pub use remove_liquidity::*;
pub use resolve_accounts::*;
pub use seed_liquidity::*;
pub use swap::*;
pub use trade_accounts::*;
