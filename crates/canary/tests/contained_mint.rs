//! `contained_mint`: for a mint with a transfer hook, reads the hook program, whether it can
//! still be upgraded, and the hook's authority, as `docs/spec/containment-hook.md`
//! recognises a contained token. Our hook is stood in for by Pipeline's `test-hook`
//! deployed at our containment hook's program id, from Canary's config module.

mod common;

use canary::config::{CONTAINMENT_HOOK_PROGRAM, CONTAINMENT_HOOK_UNLOCK_SEED};
use canary::{run_market, Outcome, Record, RunOptions};
use common::{deploy, Cluster, Extensions, TEST_HOOK};
use pipeline_check::SvmSource;
use pipeline_client::Pubkey;

fn record(cluster: &Cluster, market: Pubkey) -> Record {
    run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market,
        &RunOptions::default(),
    )
    .into_results()
    .expect("a full source never lacks an account")
    .record("contained_mint")
    .clone()
}

fn unlock_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[CONTAINMENT_HOOK_UNLOCK_SEED, mint.as_ref()],
        &CONTAINMENT_HOOK_PROGRAM,
    )
    .0
}

/// A wrapped SOL market whose token's hook is the stand-in at our hook's address, frozen or
/// upgradeable, with `authority` (the mint's unlock PDA when `None`) as the hook authority.
fn contained(upgradeable: bool, authority: Option<Pubkey>) -> (Cluster, Pubkey) {
    let mut cluster = Cluster::new();
    let admin = cluster.admin_key();
    deploy(
        &mut cluster.svm,
        CONTAINMENT_HOOK_PROGRAM,
        "test_hook",
        upgradeable.then_some(admin),
    );
    // The mint's address decides its unlock PDA, so the hook authority is set from it.
    let token = cluster.create_mint_2022(
        6,
        &Extensions {
            transfer_hook: Some((CONTAINMENT_HOOK_PROGRAM, Some(admin))),
            ..Extensions::default()
        },
    );
    let hook_authority = authority.unwrap_or_else(|| unlock_pda(&token));
    if hook_authority != admin {
        let ix = spl_token_2022_interface::instruction::set_authority(
            &common::TOKEN_2022,
            &token,
            Some(&hook_authority),
            spl_token_2022_interface::instruction::AuthorityType::TransferHookProgramId,
            &admin,
            &[],
        )
        .unwrap();
        cluster.send(&[ix], &[]);
    }
    cluster.init_test_hook(&CONTAINMENT_HOOK_PROGRAM, &token, &[]);
    let market = cluster.sol_market_of(token);
    (cluster, market.market)
}

#[test]
fn our_frozen_hook_with_the_unlock_pda_as_authority_passes() {
    let (cluster, market) = contained(false, None);

    let record = record(&cluster, market);

    assert_eq!(record.outcome, Outcome::Pass, "{}", record.reason);
}

#[test]
fn our_hook_while_it_can_still_be_upgraded_warns() {
    let (cluster, market) = contained(true, None);

    let record = record(&cluster, market);

    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    assert!(record.reason.contains("upgraded"), "{}", record.reason);
}

#[test]
fn our_hook_with_another_authority_warns() {
    let (cluster, market) = contained(false, Some(Pubkey::new_unique()));

    let record = record(&cluster, market);

    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    assert!(record.reason.contains("unlock PDA"), "{}", record.reason);
}

#[test]
fn a_hook_that_is_not_ours_warns() {
    let mut cluster = Cluster::new();
    let market = common::whitelist_hooked_market(&mut cluster);

    let record = record(&cluster, market.market);

    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    assert!(
        record.reason.contains(&TEST_HOOK.to_string()),
        "{}",
        record.reason
    );
}

#[test]
fn a_market_with_no_hooked_mint_is_not_run() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);

    let record = record(&cluster, market.market);

    assert_eq!(record.outcome, Outcome::NotRun, "{}", record.reason);
    assert!(
        record.reason.contains("no mint has a transfer hook"),
        "{}",
        record.reason
    );
}

#[test]
fn a_mint_whose_hook_extension_was_emptied_by_its_unlock_is_not_run() {
    let mut cluster = Cluster::new();
    let token = cluster.create_mint_2022(
        6,
        &Extensions {
            emptied_transfer_hook: true,
            ..Extensions::default()
        },
    );
    let market = cluster.sol_market_of(token);

    let record = record(&cluster, market.market);

    assert_eq!(record.outcome, Outcome::NotRun, "{}", record.reason);
    assert!(
        record
            .reason
            .contains("both its program and its authority unset"),
        "{}",
        record.reason
    );
}

#[test]
fn the_config_names_our_containment_hooks_own_program_id() {
    let lib = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../programs/containment-hook/src/lib.rs"),
    )
    .unwrap();
    let declared = lib
        .lines()
        .find_map(|l| l.strip_prefix("declare_id!(\""))
        .and_then(|rest| rest.split('"').next())
        .expect("the hook declares its id");

    assert_eq!(declared, CONTAINMENT_HOOK_PROGRAM.to_string());
}
