//! One module per instruction, so parallel tickets rarely touch the same lines.

pub mod init_market;
pub mod market_info;
pub mod pay_rewards;
pub mod place_wall;
pub mod read_trade;
pub mod seed;
pub mod seed_liquidity;
pub mod set_recipient;
pub mod settle;
pub mod swap;
pub mod sweep_fees;

pub use init_market::*;
pub use market_info::*;
pub use pay_rewards::*;
pub use place_wall::*;
pub use read_trade::*;
pub use seed::*;
pub use seed_liquidity::*;
pub use set_recipient::*;
pub use settle::*;
pub use swap::*;
pub use sweep_fees::*;
