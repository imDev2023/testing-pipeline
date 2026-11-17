//! A market nobody can fully trade must not veto every release (audit findings H013, H020
//! and H033; docs/spec/pool4-for-solana.md, "A release gate"): the gate registers a market
//! the router has never recorded, as anyone could, and counts a failed step against the
//! candidate only if the deployed build passes the same step on the same snapshot, while the
//! layout checks still refuse every build that would strand a market.
//!
//! Needs the stranding test builds (`cargo run -p buy-wall-gate -- test-builds`) and
//! Pipeline's `test-hook` (`scripts/fetch-pipeline.sh programs`).

use borsh::BorshSerialize;
use buy_wall_amm::InitParams;
use buy_wall_gate::keeper::Job;
use buy_wall_gate::session::{MarketView, Session, SOL, TOKEN, WSOL};
use buy_wall_gate::snapshot::{Outcome, Snapshot, StepKind};
use buy_wall_gate::stranding::TestBuild;
use buy_wall_gate::synthetic::{self, anchor, Lab};
use buy_wall_gate::{check, programs, release::Release};
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Builds that move, rename or resize the market state, which strand every open market.
const LAYOUT_BUILDS: [TestBuild; 3] = [
    TestBuild::MovedField,
    TestBuild::RenamedType,
    TestBuild::Resized,
];

fn run(snapshot: &Snapshot, build: &[u8]) -> check::Report {
    check::run(
        snapshot,
        build,
        Some(&programs::pinned_router()),
        &Release::default(),
    )
}

/// The names of the steps that failed on `market_state`, without their amounts.
fn failed_steps(report: &check::Report, market_state: &Pubkey) -> Vec<String> {
    report
        .failures()
        .into_iter()
        .filter(|f| f.market_state == market_state.to_string())
        .map(|f| f.step.split(" (").next().unwrap().to_string())
        .collect()
}

fn steps_of<'a>(report: &'a check::Report, market_state: &Pubkey) -> &'a [check::Step] {
    &report
        .markets
        .iter()
        .find(|m| m.market_state == market_state.to_string())
        .expect("the report names the market")
        .steps
}

/// A market made by a wallet calling `pipeline_seed_liquidity` directly, which the spec
/// allows, and never recorded with the router: an SPL Token seeded with 1,000,000 tokens
/// against 1 SOL at the launch values.
fn unregistered_market(lab: &mut Lab) -> Pubkey {
    let session = &mut lab.session;
    let seeder = Keypair::new();
    session.svm.airdrop(&seeder.pubkey(), 10 * SOL).unwrap();
    let mint = synthetic::mint(session, &seeder, TOKEN).unwrap();
    let (tokens, lamports) = (1_000_000_000_000u64, SOL);
    synthetic::fund_seeder(session, &seeder, mint, TOKEN, tokens, lamports).unwrap();

    let program = session.program;
    let pdas = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &program).0;
    let market_state = pdas(&[
        b"seeded",
        seeder.pubkey().as_ref(),
        mint.as_ref(),
        WSOL.as_ref(),
    ]);
    let request = buy_wall_amm::interface::SeedRequest {
        amounts: vec![tokens, lamports],
        data: borsh::to_vec(&synthetic::launch_values(seeder.pubkey())).unwrap(),
    };
    let mut data = client::interface::discriminator::SEED_LIQUIDITY.to_vec();
    request.serialize(&mut data).unwrap();
    let accounts = vec![
        AccountMeta::new_readonly(seeder.pubkey(), true),
        AccountMeta::new(market_state, false),
        AccountMeta::new(seeder.pubkey(), true),
        AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        AccountMeta::new_readonly(mint, false),
        AccountMeta::new(
            pda::associated_token(&seeder.pubkey(), &mint, &TOKEN),
            false,
        ),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(WSOL, false),
        AccountMeta::new(
            pda::associated_token(&seeder.pubkey(), &WSOL, &TOKEN),
            false,
        ),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(pdas(&[b"authority", market_state.as_ref()]), false),
        AccountMeta::new(
            pdas(&[b"vault", market_state.as_ref(), mint.as_ref()]),
            false,
        ),
        AccountMeta::new(
            pdas(&[b"vault", market_state.as_ref(), WSOL.as_ref()]),
            false,
        ),
    ];
    let ix = Instruction::new_with_bytes(program, &data, accounts);
    session.send(&[ix], &[&seeder]).unwrap();
    assert!(
        session.market(&market_state).is_err(),
        "the router recorded it"
    );
    market_state
}

#[test]
fn sos_h013_a_market_the_router_never_recorded_is_registered_in_the_replay_and_checked_like_the_rest(
) {
    let build = programs::current_build();
    let mut lab = Lab::new(&build, &programs::pinned_router()).unwrap();
    let ordinary = lab.traded_market().unwrap().market_state;
    let orphan = unregistered_market(&mut lab);
    let snapshot = lab
        .snapshot(&[ordinary, orphan], "H013")
        .expect("the snapshot loads a market the router never recorded");

    let report = run(&snapshot, &build);
    assert!(report.passed(), "{report}");
    println!("{report}");
    let steps = steps_of(&report, &orphan);
    assert!(
        steps
            .iter()
            .any(|s| s.name == "register (as anyone could)" && s.passed),
        "{report}"
    );
    // Once registered, it is traded like any market.
    for name in ["buy", "sell"] {
        assert!(
            steps.iter().any(|s| s.name.starts_with(name) && s.passed),
            "{report}"
        );
    }

    for build in LAYOUT_BUILDS {
        let report = run(&snapshot, &programs::test_build(build));
        assert!(!report.passed(), "{} passed:\n{report}", build.name());
        for market in [ordinary, orphan] {
            assert!(
                !failed_steps(&report, &market).is_empty(),
                "{} left market {market} working:\n{report}",
                build.name()
            );
        }
    }
}

/// Pipeline's `test-hook` program, as its `declare_id!` names it.
const TEST_HOOK_PROGRAM: Pubkey = client::pubkey!("BfAcC8daPZSS4iEYz1figEshePUr96gDFwtytn7DyNZ3");

/// A Token-2022 mint of 6 decimals with `admin` as its mint authority whose transfer hook
/// is Pipeline's `test-hook`, approving only transfers from or to `admin`'s own token
/// account, as an allowlist-gated token's hook does.
fn allowlisted_mint(session: &mut Session, admin: &Keypair) -> Pubkey {
    use spl_token_2022_interface::extension::{transfer_hook, ExtensionType};
    use spl_token_2022_interface::instruction::initialize_mint2;
    use spl_token_2022_interface::state::Mint;
    if session.svm.get_account(&TEST_HOOK_PROGRAM).is_none() {
        session
            .svm
            .add_program(TEST_HOOK_PROGRAM, &programs::test_hook())
            .unwrap();
    }
    let token_2022 = client::TOKEN_2022_PROGRAM_ID;
    let mint = Keypair::new();
    let space =
        ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook]).unwrap();
    let lamports = session.svm.minimum_balance_for_rent_exemption(space);
    let create = synthetic::system_create_account(
        &admin.pubkey(),
        &mint.pubkey(),
        lamports,
        space as u64,
        &token_2022,
    );
    let hook = transfer_hook::instruction::initialize(
        &token_2022,
        &mint.pubkey(),
        Some(admin.pubkey()),
        Some(TEST_HOOK_PROGRAM),
    )
    .unwrap();
    let init = initialize_mint2(&token_2022, &mint.pubkey(), &admin.pubkey(), None, 6).unwrap();
    session
        .send(&[create, hook, init], &[admin, &mint])
        .unwrap();

    let mint = mint.pubkey();
    let validation = pipeline_check::hooks::validation_address(&TEST_HOOK_PROGRAM, &mint);
    let whitelist =
        Pubkey::find_program_address(&[b"whitelist", mint.as_ref()], &TEST_HOOK_PROGRAM).0;
    let mut data = b"tsthkini".to_vec();
    data.extend_from_slice(pda::associated_token(&admin.pubkey(), &mint, &token_2022).as_ref());
    let initialize = Instruction::new_with_bytes(
        TEST_HOOK_PROGRAM,
        &data,
        vec![
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(validation, false),
            AccountMeta::new(whitelist, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        ],
    );
    session.send(&[initialize], &[admin]).unwrap();
    mint
}

/// A market no build can fully trade, made only through what the spec allows: its token's
/// hook approves only the creator's own account, so the gate's trader can never buy, and its
/// fee recipient, owed fees from the creator's buy, handed its wrapped SOL account to
/// another owner, so `sweep_fees { slot: 0 }` refuses with `RecipientAccountNotTheirs`.
fn blocked_market(lab: &mut Lab) -> (MarketView, Pubkey) {
    let (session, admin) = (&mut lab.session, &lab.admin);
    let token = allowlisted_mint(session, admin);
    let fee_recipient = Keypair::new();
    session.svm.airdrop(&fee_recipient.pubkey(), SOL).unwrap();
    let params = InitParams {
        fee_recipient: anchor(fee_recipient.pubkey()),
        reward_share_bps: 0,
        rewards_recipient: anchor(Pubkey::default()),
        ..synthetic::launch_values(admin.pubkey())
    };
    let token_2022 = client::TOKEN_2022_PROGRAM_ID;
    let view = synthetic::create(
        session,
        admin,
        token,
        token_2022,
        &params,
        Some((1_000_000_000_000, 10 * SOL)),
    )
    .unwrap();

    // The creator buys, which its own hook allows, so the fee slots are owed.
    synthetic::later(session, 3_600);
    let (token_index, sol_index) = view.sides().unwrap();
    let amount = SOL;
    pipeline_check::write_token_account(&mut session.svm, &WSOL, &TOKEN, &admin.pubkey(), 2 * SOL)
        .unwrap();
    let resolved = session
        .resolve(&view, sol_index, token_index, amount)
        .unwrap();
    session
        .swap(&view, admin, sol_index, token_index, amount, 0, &resolved)
        .unwrap();
    assert!(
        session
            .state(&view.market_state)
            .unwrap()
            .owed()
            .fees_recipient
            > 0
    );

    // The fee recipient hands its wrapped SOL account to another owner, as SPL Token allows.
    use spl_token_2022_interface::instruction::{set_authority, AuthorityType};
    pipeline_check::write_token_account(
        &mut session.svm,
        &WSOL,
        &TOKEN,
        &fee_recipient.pubkey(),
        0,
    )
    .unwrap();
    let account = pda::associated_token(&fee_recipient.pubkey(), &WSOL, &TOKEN);
    let reassign = set_authority(
        &TOKEN,
        &account,
        Some(&Pubkey::new_unique()),
        AuthorityType::AccountOwner,
        &fee_recipient.pubkey(),
        &[],
    )
    .unwrap();
    session.send(&[reassign], &[&fee_recipient]).unwrap();
    synthetic::later(session, 60);
    (view, token)
}

/// The snapshot of market A and the blocked market, from a run with the current build as
/// the deployed build.
fn blocked_snapshot() -> (Snapshot, Pubkey, Pubkey) {
    let build = programs::current_build();
    let mut lab = Lab::new(&build, &programs::pinned_router()).unwrap();
    let ordinary = lab.traded_market().unwrap().market_state;
    let (blocked, _) = blocked_market(&mut lab);
    let blocked = blocked.market_state;
    let snapshot = lab.snapshot(&[ordinary, blocked], "H020").unwrap();
    (snapshot, ordinary, blocked)
}

/// The names of the steps on `market_state` that failed the same way under the deployed
/// build, without their amounts.
fn shared_steps(report: &check::Report, market_state: &Pubkey) -> Vec<String> {
    report
        .shared_failures()
        .into_iter()
        .filter(|f| f.market_state == market_state.to_string())
        .map(|f| f.step.split(" (").next().unwrap().to_string())
        .collect()
}

#[test]
fn sos_h020_a_step_that_fails_under_the_deployed_build_too_does_not_count_against_the_candidate() {
    let (snapshot, ordinary, blocked) = blocked_snapshot();
    let build = programs::current_build();

    // The deployed build, checked as its own candidate, passes; the blocked market's steps
    // that fail under it too are reported as such, and the ordinary market has none.
    let report = run(&snapshot, &build);
    assert_eq!(
        report.baseline_sha256.as_deref(),
        Some(report.candidate_sha256.as_str())
    );
    assert!(report.passed(), "{report}");
    println!("{report}");
    assert_eq!(
        shared_steps(&report, &blocked),
        ["sweep_fees { slot: 0 }", "buy", "sell"],
        "{report}"
    );
    assert!(shared_steps(&report, &ordinary).is_empty(), "{report}");
    let shown = report.to_string();
    assert!(
        shown.contains(&format!("in program {TEST_HOOK_PROGRAM}")),
        "{report}"
    );
    assert!(
        shown.contains("the deployed build fails it the same way"),
        "{report}"
    );

    // A build that would strand a market is refused on both markets, the blocked one through
    // the layout checks, which never count as shared.
    for build in LAYOUT_BUILDS {
        let report = run(&snapshot, &programs::test_build(build));
        assert!(!report.passed(), "{} passed:\n{report}", build.name());
        for market in [ordinary, blocked] {
            assert!(
                !failed_steps(&report, &market).is_empty(),
                "{} left market {market} working:\n{report}",
                build.name()
            );
        }
    }

    // A candidate that newly fails `sweep_fees` with its own error is refused.
    let report = run(&snapshot, &programs::test_build(TestBuild::NarrowedSweep));
    assert!(!report.passed(), "{report}");
    for market in [ordinary, blocked] {
        assert_eq!(
            failed_steps(&report, &market),
            ["sweep_fees { slot: 2 }"],
            "{report}"
        );
    }

    // A failure shared with the deployed build must start in the same program: had the
    // deployed build failed slot 0 in the token program, the candidate failing it in its own
    // code would count.
    let mut moved = snapshot.clone();
    for step in &mut moved.baseline.steps {
        let slot_0 = StepKind::Job {
            job: Job::SweepFees(0),
        };
        if step.market_state == blocked.to_string() && step.kind == slot_0 {
            let Outcome::Failed { program, .. } = &mut step.outcome else {
                panic!("the deployed build swept slot 0 on the blocked market");
            };
            *program = Some(TOKEN.to_string());
        }
    }
    let report = run(&moved, &build);
    assert!(!report.passed(), "{report}");
    assert_eq!(
        failed_steps(&report, &blocked),
        ["sweep_fees { slot: 0 }"],
        "{report}"
    );
}

#[test]
fn sos_h033_a_keeper_job_the_deployed_build_ran_is_run_whatever_the_candidates_rules_say() {
    // As if the deployed build had settled market B, where this tree's rules say nothing is
    // due: the gate runs `settle` there with the candidate, which refuses it, so it is
    // refused. The jobs come from the deployed build's behaviour, not the candidate's rules.
    let build = programs::current_build();
    let mut snapshot = synthetic::build(&build, &programs::pinned_router()).unwrap();
    let b = snapshot.markets[1].market_state.clone();
    let settle = StepKind::Job { job: Job::Settle };
    let step = snapshot
        .baseline
        .steps
        .iter_mut()
        .find(|s| s.market_state == b && s.kind == settle)
        .expect("the deployed build tried every job on market B");
    assert_ne!(step.outcome, Outcome::Passed);
    step.outcome = Outcome::Passed;

    let report = run(&snapshot, &build);
    assert!(!report.passed(), "{report}");
    let failures = report.failures();
    assert_eq!(failures.len(), 1, "{report}");
    assert_eq!(
        (failures[0].market_state.as_str(), failures[0].step.as_str()),
        (b.as_str(), "settle")
    );
}
