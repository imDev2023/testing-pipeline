//! One module per instruction, so parallel tickets rarely touch the same lines.

pub mod init_market;
pub mod market_info;
pub mod read_trade;
pub mod seed;
pub mod swap;

pub use init_market::*;
pub use market_info::*;
pub use read_trade::*;
pub use seed::*;
pub use swap::*;
