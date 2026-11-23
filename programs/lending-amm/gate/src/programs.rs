//! Where the builds, the router, Kamino Lend and the records live in this repo, for the tests
//! and the command's defaults.

use std::path::PathBuf;

use pipeline_client::Pubkey;

/// The lending AMM's program address, from its `declare_id!`.
pub fn program_id() -> Pubkey {
    Pubkey::new_from_array(lending_amm::ID.to_bytes())
}

/// This crate's folder, `programs/lending-amm/gate`.
pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The repository's root.
pub fn repo_root() -> PathBuf {
    crate_dir().join("../../..")
}

/// Where `cargo build-sbf --manifest-path programs/lending-amm/Cargo.toml` writes the
/// program: `programs/target/deploy`, `$CARGO_TARGET_DIR/deploy`, or `$SBF_OUT_DIR`.
pub fn deploy_dir() -> PathBuf {
    std::env::var("SBF_OUT_DIR")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("CARGO_TARGET_DIR").map(|dir| PathBuf::from(dir).join("deploy")))
        .unwrap_or_else(|_| crate_dir().join("../../target/deploy"))
}

pub fn current_build_path() -> PathBuf {
    deploy_dir().join("lending_amm.so")
}

/// The program as built from this tree.
pub fn current_build() -> Vec<u8> {
    read(
        current_build_path(),
        "Build it first: cargo build-sbf --manifest-path programs/lending-amm/Cargo.toml",
    )
}

/// Pipeline's router as devnet runs it: `fixtures/router/pipeline.so`, checked against its
/// pinned hash by `scripts/fetch-router.sh` (or `$PIPELINE_ROUTER_SO`).
pub fn pinned_router() -> Vec<u8> {
    let path = std::env::var("PIPELINE_ROUTER_SO")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root().join("fixtures/router/pipeline.so"));
    read(path, "Run `scripts/fetch-router.sh` first.")
}

/// Kamino Lend as devnet runs it: `fixtures/klend/devnet.so`, checked against its pinned hash
/// by `programs/lending-amm/scripts/fetch-klend.sh` (or `$KLEND_SO`).
pub fn pinned_klend() -> Vec<u8> {
    let path = std::env::var("KLEND_SO")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root().join("fixtures/klend/devnet.so"));
    read(
        path,
        "Run `bash programs/lending-amm/scripts/fetch-klend.sh` first.",
    )
}

/// The committed dump of our devnet Kamino lending market's accounts, which the lending AMM's
/// own tests load (`programs/lending-amm/tests/fixtures/kamino/devnet/`).
pub fn kamino_dump_dir() -> PathBuf {
    crate_dir().join("../tests/fixtures/kamino/devnet")
}

/// Where `programs/lending-amm/scripts/broken-builds.py` writes the deliberately broken builds,
/// the fuzzer's and the gate's: `programs/target/lending-broken-builds`, or
/// `$LENDING_BROKEN_BUILDS`.
pub fn broken_builds_dir() -> PathBuf {
    std::env::var("LENDING_BROKEN_BUILDS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| crate_dir().join("../../target/lending-broken-builds"))
}

/// One of the broken builds, by its name in `tests/broken-builds.json` or the gate's
/// `test-builds.json`.
pub fn broken_build(name: &str) -> Vec<u8> {
    read(
        broken_builds_dir().join(format!("{name}.so")),
        "Build the broken builds first: python3 programs/lending-amm/scripts/broken-builds.py",
    )
}

/// The release declaration committed with the program (`programs/lending-amm/release.json`).
pub fn release_path() -> PathBuf {
    crate_dir().join("../release.json")
}

/// The release declaration's path from the repo's root.
pub const RELEASE_IN_REPO: &str = "programs/lending-amm/release.json";

/// Where passing runs are recorded: `deployments/release-gate/lending-amm/`.
pub fn records_dir() -> PathBuf {
    repo_root().join("deployments/release-gate/lending-amm")
}

fn read(path: PathBuf, hint: &str) -> Vec<u8> {
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}. {hint}", path.display()))
}
