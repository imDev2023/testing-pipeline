//! A passing run against a cluster records the build's executable hash, and the deploy
//! script accepts only a build with a passing record against the cluster it deploys to,
//! made against the build deployed there now and covering every market there now.

use buy_wall_gate::record::{self, Record, Target};

fn scratch_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "buy-wall-gate-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const DEVNET: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

fn passing() -> Record {
    Record {
        program: "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6".into(),
        genesis_hash: DEVNET.into(),
        cluster: Some("devnet".into()),
        url: "https://api.devnet.solana.com".into(),
        slot: 523_000_000,
        unix_timestamp: 1_763_280_000,
        recorded_at: 1_763_280_100,
        candidate_sha256: "c".repeat(64),
        deployed_sha256: Some("d".repeat(64)),
        market_states: vec!["A".into(), "B".into()],
        pricing_change_declared: false,
        shared_failures: vec![],
    }
}

fn target() -> Target {
    Target {
        program: "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6".into(),
        genesis_hash: DEVNET.into(),
        candidate_sha256: "c".repeat(64),
        deployed_sha256: Some("d".repeat(64)),
        market_states: vec!["A".into(), "B".into()],
    }
}

#[test]
fn a_passing_record_is_kept_per_cluster_and_found_for_the_same_build_state_and_markets() {
    let dir = scratch_dir("found");
    record::append(&dir, &passing()).unwrap();
    assert!(dir.join("devnet.json").exists());
    assert_eq!(record::find(&dir, &target()).unwrap(), passing());
}

#[test]
fn a_local_validators_records_go_to_a_file_named_after_its_genesis_hash() {
    let dir = scratch_dir("local");
    let local = Record {
        genesis_hash: "8XgSpTzQ4TaqxaMxyVkeU9GsFpv5Gq9JCvbFJv1Q7mFB".into(),
        cluster: None,
        ..passing()
    };
    record::append(&dir, &local).unwrap();
    assert!(dir.join("local-8XgSpTzQ.json").exists());
}

#[test]
fn the_deploy_is_refused_without_a_passing_record_for_this_build_on_this_cluster() {
    let dir = scratch_dir("refused");
    let none = record::find(&dir, &target()).unwrap_err();
    assert!(none.contains("no passing release gate run"), "{none}");
    record::append(&dir, &passing()).unwrap();

    let other_build = Target {
        candidate_sha256: "e".repeat(64),
        ..target()
    };
    assert!(record::find(&dir, &other_build).is_err());

    let other_cluster = Target {
        genesis_hash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d".into(),
        ..target()
    };
    assert!(record::find(&dir, &other_cluster).is_err());
}

#[test]
fn a_record_made_against_another_deployed_build_or_fewer_markets_no_longer_counts() {
    let dir = scratch_dir("stale");
    record::append(&dir, &passing()).unwrap();

    let upgraded_since = Target {
        deployed_sha256: Some("f".repeat(64)),
        ..target()
    };
    let error = record::find(&dir, &upgraded_since).unwrap_err();
    assert!(error.contains("deployed build"), "{error}");

    let new_market = Target {
        market_states: vec!["A".into(), "B".into(), "C".into()],
        ..target()
    };
    let error = record::find(&dir, &new_market).unwrap_err();
    assert!(error.contains("C"), "{error}");
}

#[test]
fn the_newest_passing_record_that_fits_is_the_one_found() {
    let dir = scratch_dir("newest");
    let older = Record {
        recorded_at: 1,
        ..passing()
    };
    record::append(&dir, &older).unwrap();
    record::append(&dir, &passing()).unwrap();
    assert_eq!(
        record::find(&dir, &target()).unwrap().recorded_at,
        passing().recorded_at
    );
}
