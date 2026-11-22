//! `lending-gate`, the lending AMM's release gate; the command is in `cli.rs`.

#[cfg(not(kani))]
fn main() -> std::process::ExitCode {
    lending_gate::cli::main()
}

// Kani builds the crate without its dependencies (Cargo.toml), so without the gate.
#[cfg(kani)]
fn main() {}
