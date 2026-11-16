//! The fixtures the repo keeps (docs/spec/pool4-for-solana.md, "Fixtures in CI"): a saved
//! market state for every layout version ever deployed, with its mints and vaults, each
//! passing the gate's checks against the current build.

use buy_wall_amm::state::DEPLOYED_LAYOUT_VERSIONS;
use buy_wall_gate::{check, programs, release::Release};

#[test]
fn every_fixture_passes_the_gate_against_the_current_build() {
    let build = programs::current_build();
    let router = programs::pinned_router();
    let release = Release::read(&programs::release_path()).unwrap();
    for (path, snapshot) in programs::fixtures() {
        let report = check::run(&snapshot, &build, Some(&router), &release);
        assert!(report.passed(), "{}:\n{report}", path.display());
    }
}

#[test]
fn every_deployed_layout_version_has_a_fixture_with_its_mints_and_vaults() {
    let fixtures = programs::fixtures();
    for version in DEPLOYED_LAYOUT_VERSIONS {
        let holding: Vec<_> = fixtures
            .iter()
            .filter(|(_, s)| s.markets.iter().any(|m| m.layout_version == *version))
            .collect();
        assert!(
            !holding.is_empty(),
            "no fixture holds a layout version {version} market"
        );
    }
    for (path, snapshot) in &fixtures {
        let addresses: Vec<&str> = snapshot
            .accounts
            .iter()
            .map(|a| a.address.as_str())
            .collect();
        for market in &snapshot.markets {
            assert!(
                addresses.contains(&market.market_state.as_str()),
                "{}",
                path.display()
            );
            assert!(
                addresses.contains(&market.market.as_str()),
                "{}",
                path.display()
            );
        }
        // A fixture leaves the programs out: CI loads the pinned router and the build under test.
        assert!(
            snapshot.clone().without_programs().unwrap().accounts.len() == snapshot.accounts.len()
        );
        // Until the devnet deploy saves a real market, the fixture is marked synthetic (POOL4-20).
        assert!(
            snapshot.synthetic || snapshot.cluster.name.is_some(),
            "{}",
            path.display()
        );
        let mints_and_vaults = snapshot.markets.len() * 4;
        assert!(
            snapshot.accounts.len() > mints_and_vaults,
            "{}",
            path.display()
        );
    }
}
