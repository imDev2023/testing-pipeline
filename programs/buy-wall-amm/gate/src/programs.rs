//! Where the builds and the router live in this repo, for the tests and the command's
//! defaults.

use std::path::PathBuf;

use pipeline_client::Pubkey;

/// The buy wall AMM's program address, from its `declare_id!`.
pub fn program_id() -> Pubkey {
    Pubkey::new_from_array(buy_wall_amm::ID.to_bytes())
}

/// This crate's folder, `programs/buy-wall-amm/gate`.
pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The repository's root.
pub fn repo_root() -> PathBuf {
    crate_dir().join("../../..")
}

/// Where `cargo build-sbf --manifest-path programs/buy-wall-amm/Cargo.toml` writes the
/// program: `programs/target/deploy`, `$CARGO_TARGET_DIR/deploy`, or `$SBF_OUT_DIR`.
pub fn deploy_dir() -> PathBuf {
    std::env::var("SBF_OUT_DIR")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("CARGO_TARGET_DIR").map(|dir| PathBuf::from(dir).join("deploy")))
        .unwrap_or_else(|_| crate_dir().join("../../target/deploy"))
}

pub fn current_build_path() -> PathBuf {
    deploy_dir().join("buy_wall_amm.so")
}

/// The program as built from this tree.
pub fn current_build() -> Vec<u8> {
    read(
        current_build_path(),
        "Build it first: cargo build-sbf --manifest-path programs/buy-wall-amm/Cargo.toml",
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

/// The fixtures the repo keeps, one per layout version (`gate/fixtures/*.json`).
pub fn fixtures_dir() -> PathBuf {
    crate_dir().join("fixtures")
}

/// Every fixture, by path.
pub fn fixtures() -> Vec<(PathBuf, crate::snapshot::Snapshot)> {
    let dir = fixtures_dir();
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().is_some_and(|e| e == "json"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let snapshot = crate::snapshot::Snapshot::read(&path).unwrap_or_else(|e| panic!("{e}"));
            (path, snapshot)
        })
        .collect()
}

/// Where `buy-wall-gate test-builds` writes the stranding test builds:
/// `programs/target/gate-test-builds`, or `$GATE_TEST_BUILDS`.
pub fn test_builds_dir() -> PathBuf {
    std::env::var("GATE_TEST_BUILDS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| crate_dir().join("../../target/gate-test-builds"))
}

/// A stranding test build.
pub fn test_build(build: crate::stranding::TestBuild) -> Vec<u8> {
    read(
        crate::stranding::path(&test_builds_dir(), build),
        "Build the test builds first: cargo run -p buy-wall-gate -- test-builds",
    )
}

/// The release declaration committed with the program (`programs/buy-wall-amm/release.json`).
pub fn release_path() -> PathBuf {
    crate_dir().join("../release.json")
}

fn read(path: PathBuf, hint: &str) -> Vec<u8> {
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}. {hint}", path.display()))
}
