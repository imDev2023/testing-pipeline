//! One module per instruction, so parallel tickets rarely touch the same lines.

pub mod bind;
pub mod execute;

pub use bind::*;
pub use execute::*;
