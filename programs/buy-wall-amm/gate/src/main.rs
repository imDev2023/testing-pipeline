//! `buy-wall-gate`, the buy wall AMM's release gate; the command is in `cli.rs`.

#[cfg(not(kani))]
fn main() -> std::process::ExitCode {
    buy_wall_gate::cli::main()
}

// Kani builds the crate without its dependencies (Cargo.toml), so without the gate.
#[cfg(kani)]
fn main() {}
