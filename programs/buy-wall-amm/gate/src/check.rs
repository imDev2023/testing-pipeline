//! The gate's checks on a snapshot (docs/spec/pool4-for-solana.md, "A release gate"): on
//! every market, with the candidate build and the real router, account resolution, the
//! quotes compared with the deployed build's on the same state, `pipeline_market_info`, each
//! keeper job that is due, a buy and a sell through the router.
//!
//! The same replay, run with the deployed build when the snapshot is taken
//! ([`record_baseline`]), records the deployed build's quotes and whether each other step
//! passed with it, every keeper job tried whether due or not. A step the candidate fails
//! counts against it unless the deployed build failed the same step on the same snapshot,
//! the failure starting in the same program (the relative rule): a market whose token's hook
//! refuses the gate's trader, or whose fee recipient made its account unpayable, fails those
//! steps under every build, so they cannot veto a release, while a candidate that newly fails
//! a step, or fails it in its own code where the deployed build failed in the hook, is
//! refused. The layout checks (reading the market state, finding the market, account
//! resolution, the quotes and `pipeline_market_info`) never count as shared and run on every
//! market whatever else fails, so a build that would strand a market is refused even on a
//! market whose trades are blocked.
//!
//! A keeper job runs if this tree's rules say it is due or the deployed build ran it on the
//! snapshot, so a candidate that narrows a rule cannot drop that job from its own test.
//! A market the router never recorded is registered first, and a missing router fee account
//! created, as anyone could, so such a market is checked like the rest.

use pipeline_client::{self as client, pda, Pubkey};
use pipeline_strategy_interface::fees;
use serde::Serialize;
use solana_signer::Signer;

use crate::keeper::{self, Job};
use crate::quotes;
use crate::release::Release;
use crate::session::{failing_program, first_line, program_name, spendable, MarketView, Session};
use crate::snapshot::{
    parse_key, Baseline, Cluster, Outcome, Quote, QuoteOutcome, RecordedStep, Snapshot, StepKind,
};
use crate::world;
use buy_wall_amm::state::{MarketState, STATUS_CREATED, STATUS_OPEN};

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub program: String,
    pub cluster: Cluster,
    pub synthetic: bool,
    pub candidate_sha256: String,
    pub baseline_sha256: Option<String>,
    /// Why the snapshot could not even be loaded with the candidate, if it could not.
    pub setup_error: Option<String>,
    /// Whether a quote passed only because the release declares a pricing change.
    pub relied_on_pricing_change: bool,
    pub markets: Vec<MarketReport>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketReport {
    pub market_state: String,
    pub steps: Vec<Step>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Step {
    pub name: String,
    pub kind: StepKind,
    pub passed: bool,
    pub detail: String,
    /// For a failed step, the program the failure started in, if a program raised it.
    pub program: Option<String>,
    /// For a failed step the deployed build failed the same way on the same snapshot, how it
    /// failed there; such a step does not count against the candidate.
    pub deployed_fails_too: Option<String>,
}

/// A step that failed, and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub market_state: String,
    pub step: String,
    pub detail: String,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.setup_error.is_none() && self.failures().is_empty()
    }

    /// The steps that count against the candidate: every failed step but those the deployed
    /// build failed the same way.
    pub fn failures(&self) -> Vec<Failure> {
        self.failed_steps(false)
    }

    /// The failed steps that do not count, because the deployed build failed them the same
    /// way on the same snapshot; each detail says how.
    pub fn shared_failures(&self) -> Vec<Failure> {
        self.failed_steps(true)
    }

    fn failed_steps(&self, shared: bool) -> Vec<Failure> {
        self.markets
            .iter()
            .flat_map(|market| {
                market
                    .steps
                    .iter()
                    .filter(|s| !s.passed && s.deployed_fails_too.is_some() == shared)
                    .map(|step| Failure {
                        market_state: market.market_state.clone(),
                        step: step.name.clone(),
                        detail: self.describe(step),
                    })
            })
            .collect()
    }

    /// A failed step's error in one line: where it started, and for a shared one how the
    /// deployed build failed.
    fn describe(&self, step: &Step) -> String {
        let mut text = first_line(&step.detail);
        if let Some(program) = &step.program {
            let ours = parse_key(&self.program).unwrap_or_default();
            text.push_str(&format!(", in {}", program_name(program, &ours)));
        }
        if let Some(deployed) = &step.deployed_fails_too {
            text.push_str(&format!("; {deployed}"));
        }
        text
    }
}

impl std::fmt::Display for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let cluster = self
            .cluster
            .name
            .clone()
            .or_else(|| self.cluster.url.clone())
            .unwrap_or_else(|| "a snapshot".into());
        writeln!(
            f,
            "Release gate for {} on {cluster}{} at slot {}",
            self.program,
            if self.synthetic { " (synthetic)" } else { "" },
            self.cluster.slot
        )?;
        writeln!(f, "  candidate build {}", self.candidate_sha256)?;
        writeln!(
            f,
            "  baseline build  {}",
            self.baseline_sha256.as_deref().unwrap_or("none")
        )?;
        if let Some(error) = &self.setup_error {
            writeln!(
                f,
                "REFUSED: the snapshot does not load with the candidate: {error}"
            )?;
            return Ok(());
        }
        for market in &self.markets {
            writeln!(f, "market state {}", market.market_state)?;
            for step in &market.steps {
                if step.passed {
                    writeln!(f, "  ok   {}: {}", step.name, first_line(&step.detail))?;
                } else {
                    let mark = if step.deployed_fails_too.is_some() {
                        "same"
                    } else {
                        "FAIL"
                    };
                    writeln!(f, "  {mark} {}: {}", step.name, self.describe(step))?;
                }
            }
        }
        let failures = self.failures();
        let shared = self.shared_failures();
        if failures.is_empty() {
            if shared.is_empty() {
                writeln!(f, "PASSED: {} market(s), every step", self.markets.len())?;
            } else {
                writeln!(
                    f,
                    "PASSED: {} market(s); {} step(s) failed, each as it fails under the \
                     deployed build, so none is a regression:",
                    self.markets.len(),
                    shared.len()
                )?;
            }
        } else {
            writeln!(f, "REFUSED: {} step(s) failed", failures.len())?;
            for failure in &failures {
                writeln!(
                    f,
                    "  market state {}, step {}: {}",
                    failure.market_state, failure.step, failure.detail
                )?;
            }
            if !shared.is_empty() {
                writeln!(
                    f,
                    "and {} step(s) failed as they fail under the deployed build, which do not \
                     count:",
                    shared.len()
                )?;
            }
        }
        for failure in &shared {
            writeln!(
                f,
                "  market state {}, step {}: {}",
                failure.market_state, failure.step, failure.detail
            )?;
        }
        Ok(())
    }
}

/// Runs the gate's checks on `snapshot` with `candidate` as the program, and `router_elf`
/// (else the snapshot's own copy of the cluster's router) as the router, each step judged
/// against what the snapshot records of the deployed build.
pub fn run(
    snapshot: &Snapshot,
    candidate: &[u8],
    router_elf: Option<&[u8]>,
    release: &Release,
) -> Report {
    let mut report = Report {
        program: snapshot.program.clone(),
        cluster: snapshot.cluster.clone(),
        synthetic: snapshot.synthetic,
        candidate_sha256: pipeline_check::executable_sha256(candidate).0,
        baseline_sha256: snapshot.baseline.executable_sha256.clone(),
        setup_error: None,
        relied_on_pricing_change: false,
        markets: vec![],
    };
    let loaded = snapshot
        .program_id()
        .and_then(|program| Ok((program, world::load(snapshot, candidate, router_elf)?)));
    let (program, svm) = match loaded {
        Ok(loaded) => loaded,
        Err(error) => {
            report.setup_error = Some(error);
            return report;
        }
    };
    let mut session = Session::new(svm, program);
    let mode = Mode::Check {
        baseline: &snapshot.baseline,
        release,
    };
    for saved in &snapshot.markets {
        let mut steps = Steps::default();
        match parse_key(&saved.market_state) {
            Ok(market_state) => check_market(&mut session, &market_state, &mode, &mut steps),
            Err(error) => steps.fail(StepKind::ReadState, "read the snapshot", error),
        }
        compare_with_deployed(&mut steps.steps, &snapshot.baseline, &saved.market_state);
        report.relied_on_pricing_change |= steps.relied_on_pricing_change;
        report.markets.push(MarketReport {
            market_state: saved.market_state.clone(),
            steps: steps.steps,
        });
    }
    report
}

/// The same replay with `deployed` as the program: its quotes, and whether each other step
/// passed with it, every keeper job tried, which is what a snapshot records of the deployed
/// build. `router_elf` as in [`run`].
pub fn record_baseline(
    snapshot: &Snapshot,
    deployed: &[u8],
    router_elf: Option<&[u8]>,
) -> Result<Baseline, String> {
    let program = snapshot.program_id()?;
    let mut session = Session::new(world::load(snapshot, deployed, router_elf)?, program);
    let mut baseline = Baseline {
        executable_sha256: Some(pipeline_check::executable_sha256(deployed).0),
        quotes: vec![],
        steps: vec![],
    };
    for saved in &snapshot.markets {
        let market_state = parse_key(&saved.market_state)?;
        let mut steps = Steps::default();
        check_market(&mut session, &market_state, &Mode::Record, &mut steps);
        baseline.quotes.append(&mut steps.quotes);
        baseline.steps.extend(
            steps
                .steps
                .into_iter()
                .filter(|step| !matches!(step.kind, StepKind::Quote { .. }))
                .map(|step| RecordedStep {
                    market_state: saved.market_state.clone(),
                    outcome: if step.passed {
                        Outcome::Passed
                    } else {
                        Outcome::Failed {
                            program: step.program,
                            error: first_line(&step.detail),
                        }
                    },
                    kind: step.kind,
                }),
        );
    }
    Ok(baseline)
}

/// Marks each failed step the deployed build failed the same way, the failure starting in
/// the same program, as not counting; never a layout check.
fn compare_with_deployed(steps: &mut [Step], baseline: &Baseline, market_state: &str) {
    for step in steps.iter_mut() {
        if step.passed || !step.kind.may_fail_under_any_build() {
            continue;
        }
        let Some(Outcome::Failed { program, error }) = baseline.outcome(market_state, &step.kind)
        else {
            continue;
        };
        if *program != step.program {
            continue;
        }
        step.deployed_fails_too = Some(if *error == first_line(&step.detail) {
            "the deployed build fails it the same way".into()
        } else {
            format!("the deployed build fails it there too, with {error}")
        });
    }
}

/// Whether the replay records the deployed build or checks a candidate against it.
enum Mode<'a> {
    Record,
    Check {
        baseline: &'a Baseline,
        release: &'a Release,
    },
}

#[derive(Default)]
struct Steps {
    steps: Vec<Step>,
    relied_on_pricing_change: bool,
    /// The quotes taken, when recording.
    quotes: Vec<Quote>,
}

impl Steps {
    fn pass(&mut self, kind: StepKind, name: impl Into<String>, detail: impl Into<String>) {
        self.steps.push(Step {
            name: name.into(),
            kind,
            passed: true,
            detail: detail.into(),
            program: None,
            deployed_fails_too: None,
        });
    }

    fn fail(&mut self, kind: StepKind, name: impl Into<String>, error: impl Into<String>) {
        let detail = error.into();
        self.steps.push(Step {
            name: name.into(),
            kind,
            passed: false,
            program: failing_program(&detail),
            detail,
            deployed_fails_too: None,
        });
    }

    fn record<T>(
        &mut self,
        kind: StepKind,
        name: impl Into<String>,
        result: Result<T, String>,
        detail: impl FnOnce(T) -> String,
    ) {
        match result {
            Ok(value) => self.pass(kind, name, detail(value)),
            Err(error) => self.fail(kind, name, error),
        }
    }
}

fn direction(view: &MarketView, input: u8) -> &'static str {
    if input as usize == view.sol_index() {
        "buy"
    } else {
        "sell"
    }
}

fn check_market(session: &mut Session, market_state: &Pubkey, mode: &Mode, steps: &mut Steps) {
    let state = match session.state(market_state) {
        Ok(state) => state,
        Err(error) => return steps.fail(StepKind::ReadState, "read the market state", error),
    };

    // A market the router never recorded (a wallet may seed one through
    // `pipeline_seed_liquidity` itself) is registered as anyone could, so it is checked like
    // the rest; if even that fails, every step that needs no router still runs.
    let mut registered = session.market(market_state).is_ok();
    if !registered {
        let result = register(session, market_state, &state);
        registered = result.is_ok();
        steps.record(
            StepKind::Register,
            "register (as anyone could)",
            result,
            |d| d,
        );
    }
    let view = if registered {
        session.market(market_state)
    } else {
        MarketView::from_state(&session.svm, &session.program, market_state, &state)
    };
    let view = match view.and_then(|view| view.sides().map(|_| view)) {
        Ok(view) => view,
        Err(error) => return steps.fail(StepKind::FindMarket, "find the market", error),
    };
    if registered {
        let missing = missing_fee_accounts(session, &view);
        if !missing.is_empty() {
            steps.record(
                StepKind::FeeAccounts,
                "init_fee_account (as anyone could)",
                create_fee_accounts(session, &view, &missing),
                |d| d,
            );
        }
    }
    let (token, sol) = (view.token_index(), view.sol_index());

    // Account resolution, both ways.
    for (input, output) in [(sol, token), (token, sol)] {
        let amount = quotes::amounts(session, &view, input)[0];
        let name = format!(
            "pipeline_resolve_accounts ({})",
            direction(&view, input as u8)
        );
        steps.record(
            StepKind::Resolve {
                input_index: input as u8,
            },
            name,
            session.resolve(&view, input, output, amount),
            |accounts| format!("{} accounts", accounts.len()),
        );
    }

    check_quotes(session, &view, mode, steps);
    steps.record(
        StepKind::MarketInfo,
        "pipeline_market_info",
        market_info(session, &view),
        |d| d,
    );

    // A market waiting for its seed is seeded as its seeder would seed it, so a build that
    // could not seed it is refused; then it is traded like every open market.
    let mut state = state;
    if state.status == STATUS_CREATED {
        let name = "seed (as its seeder would)";
        match seed_pending(session, &view, &state)
            .and_then(|detail| Ok((detail, session.state(market_state)?)))
        {
            Ok((detail, seeded)) => {
                steps.pass(StepKind::Seed, name, detail);
                state = seeded;
            }
            Err(error) => steps.fail(StepKind::Seed, name, error),
        }
    } else if state.status != STATUS_OPEN {
        return steps.fail(
            StepKind::ReadState,
            "read the market state",
            format!("status {} is neither created nor open", state.status),
        );
    }
    let open = state.status == STATUS_OPEN;

    // Keeper jobs, from the state as it was: recording, every job; checking, each this
    // tree's rules say is due and each the deployed build ran.
    if open {
        let jobs: Vec<Job> = match mode {
            Mode::Record => Job::ALL.to_vec(),
            Mode::Check { baseline, .. } => {
                let due = keeper::due(&state);
                Job::ALL
                    .into_iter()
                    .filter(|job| {
                        due.contains(job)
                            || baseline
                                .outcome(&market_state.to_string(), &StepKind::Job { job: *job })
                                == Some(&Outcome::Passed)
                    })
                    .collect()
            }
        };
        for job in jobs {
            let current = session.state(market_state).unwrap_or(state);
            steps.record(
                StepKind::Job { job },
                job.to_string(),
                keeper::run(session, &view, &current, job),
                |done| done,
            );
        }
    }

    // A buy, then a sell of what it bought, each at its quote.
    let not_run = if !registered {
        Some("not run: the router has no Market for it")
    } else if !open {
        Some("not run: the market is not open")
    } else {
        None
    };
    if let Some(why) = not_run {
        steps.fail(StepKind::Buy, "buy", why);
        steps.fail(StepKind::Sell, "sell", why);
        return;
    }
    let held = session.balance(&view.vaults[sol]).unwrap_or_default();
    let buy = (held / quotes::BUY_DIVISOR).max(1);
    let bought = trade(
        session,
        &view,
        (sol, token),
        buy,
        steps,
        format!("buy ({buy} lamports)"),
    );
    match bought {
        Some(bought) => {
            let sell = spendable(bought);
            trade(
                session,
                &view,
                (token, sol),
                sell,
                steps,
                format!("sell ({sell} units)"),
            );
        }
        None => steps.fail(StepKind::Sell, "sell", "not run: the buy before it failed"),
    }
}

/// The quotes: recording, at a tenth, a hundredth and a thousandth of each input vault;
/// checking, each the deployed build gave, compared with it.
fn check_quotes(session: &Session, view: &MarketView, mode: &Mode, steps: &mut Steps) {
    let (token, sol) = (view.token_index(), view.sol_index());
    let market_state = view.market_state.to_string();
    let (baseline, release) = match mode {
        Mode::Record => {
            for (input, output) in [(sol, token), (token, sol)] {
                for amount in quotes::amounts(session, view, input) {
                    let result = quotes::quote(session, view, input, output, amount);
                    steps.pass(
                        StepKind::Quote {
                            input_index: input as u8,
                            amount,
                        },
                        format!("quote ({} {amount})", direction(view, input as u8)),
                        format!("{result}, recorded"),
                    );
                    steps.quotes.push(Quote {
                        market_state: market_state.clone(),
                        input_index: input as u8,
                        output_index: output as u8,
                        amount,
                        result,
                    });
                }
            }
            return;
        }
        Mode::Check { baseline, release } => (*baseline, *release),
    };
    let hash = baseline.executable_sha256.as_deref();
    let recorded: Vec<_> = baseline
        .quotes
        .iter()
        .filter(|q| q.market_state == market_state)
        .collect();
    if recorded.is_empty() {
        steps.fail(
            StepKind::Quote {
                input_index: sol as u8,
                amount: 0,
            },
            "quote",
            "the snapshot records no baseline quote for this market",
        );
    }
    for q in recorded {
        let kind = StepKind::Quote {
            input_index: q.input_index,
            amount: q.amount,
        };
        let name = format!("quote ({} {})", direction(view, q.input_index), q.amount);
        let candidate = quotes::quote(
            session,
            view,
            q.input_index as usize,
            q.output_index as usize,
            q.amount,
        );
        // A declared pricing change lets amounts differ, never a quote the baseline served
        // turn into a refusal.
        let now_refused = matches!(q.result, QuoteOutcome::AmountOut(_))
            && matches!(candidate, QuoteOutcome::Refused(_));
        if candidate == q.result {
            steps.pass(kind, name, format!("{candidate}, as the baseline build"));
        } else if release.changes_pricing_of(hash) && !now_refused {
            steps.relied_on_pricing_change = true;
            steps.pass(
                kind,
                name,
                format!(
                    "{candidate}, the baseline build {}: a pricing change the release declares",
                    q.result
                ),
            );
        } else {
            let why = if now_refused {
                "and no pricing change covers refusing a quote the baseline served"
            } else {
                "and the release declares no pricing change from it"
            };
            steps.fail(
                kind,
                name,
                format!(
                    "the candidate quotes {candidate}; the baseline build {} quoted {} on the same \
                     state, {why}",
                    hash.unwrap_or("(unknown)"),
                    q.result
                ),
            );
        }
    }
}

/// `pipeline_market_info` with the candidate, which must give the mints and vaults the
/// router records (or, for a market it has not recorded, the ones the market state holds).
fn market_info(session: &Session, view: &MarketView) -> Result<String, String> {
    let info = session.market_info(&view.market_state)?;
    let keys = |list: &[[u8; 32]]| list.iter().map(|k| Pubkey::new_from_array(*k)).collect();
    let (mints, vaults): (Vec<Pubkey>, Vec<Pubkey>) = (keys(&info.mints), keys(&info.vaults));
    if mints != view.mints || vaults != view.vaults {
        return Err(format!(
            "it gives mints {mints:?} and vaults {vaults:?}, where the router records mints {:?} \
             and vaults {:?}",
            view.mints, view.vaults
        ));
    }
    Ok("the mints and vaults the router records".into())
}

/// Registers a market the router has no Market for, as anyone may: the router's
/// `register_existing_market`, which asks the program's `pipeline_market_info`, and
/// `init_fee_account` for both mints, from the gate's payer.
fn register(
    session: &mut Session,
    market_state: &Pubkey,
    state: &MarketState,
) -> Result<String, String> {
    let program = session.program;
    let payer = session.payer.pubkey();
    let view = MarketView::from_state(&session.svm, &program, market_state, state)?;
    let mut instructions = vec![client::register_existing_market(
        &payer,
        &program,
        market_state,
        vec![],
    )];
    instructions.extend(view.mints.iter().zip(&view.token_programs).map(
        |(mint, token_program)| client::init_fee_account(&payer, &view.market, mint, token_program),
    ));
    session.send(&instructions, &[])?;
    Ok("registered with the router's register_existing_market, both fee accounts created".into())
}

/// The indices of the market's mints whose router fee account does not exist, which a swap
/// selling that mint needs.
fn missing_fee_accounts(session: &Session, view: &MarketView) -> Vec<usize> {
    (0..view.mints.len())
        .filter(|&i| {
            let account = pda::fee_account(&view.market, &view.mints[i], &view.token_programs[i]);
            session.svm.get_account(&account).is_none()
        })
        .collect()
}

/// Creates the router's fee accounts at `missing`, as anyone may.
fn create_fee_accounts(
    session: &mut Session,
    view: &MarketView,
    missing: &[usize],
) -> Result<String, String> {
    let payer = session.payer.pubkey();
    let instructions: Vec<_> = missing
        .iter()
        .map(|&i| {
            client::init_fee_account(
                &payer,
                &view.market,
                &view.mints[i],
                &view.token_programs[i],
            )
        })
        .collect();
    session.send(&instructions, &[])?;
    let mints: Vec<String> = missing.iter().map(|&i| view.mints[i].to_string()).collect();
    Ok(format!(
        "created the router's fee account for mint(s) {}",
        mints.join(", ")
    ))
}

/// A swap through the router of `amount` of mint `input`, by the market's trader, with the
/// candidate's quote as the minimum; passes only if the trader got exactly the quote.
fn trade(
    session: &mut Session,
    view: &MarketView,
    (input, output): (usize, usize),
    amount: u64,
    steps: &mut Steps,
    name: String,
) -> Option<u64> {
    let kind = if input == view.sol_index() {
        StepKind::Buy
    } else {
        StepKind::Sell
    };
    let result = (|| {
        let resolved = session.resolve(view, input, output, amount)?;
        let quoted = session
            .quote_amount(view, input, output, amount, &resolved)
            .map_err(|error| format!("its quote was refused: {error}"))?;
        let trader = if input == view.sol_index() {
            let budget = fees::max_total_spend(amount, 0).ok_or("the budget overflows")?;
            session.trader(view, budget)?
        } else {
            session
                .held_trader()
                .ok_or("no trader holds the tokens bought")?
        };
        let swapped = session.swap(view, &trader, input, output, amount, quoted, &resolved)?;
        session.keep_trader(trader);
        if swapped.received != quoted {
            return Err(format!(
                "received {}, not the quote {quoted}",
                swapped.received
            ));
        }
        Ok(quoted)
    })();
    match result {
        Ok(out) => {
            steps.pass(kind, name, format!("received {out}, the quote"));
            Some(out)
        }
        Err(error) => {
            steps.fail(kind, name, error);
            None
        }
    }
}

/// The seed the gate gives a market waiting for one: the worked example's, 1,000,000 tokens
/// of 6 decimals against 10 SOL.
pub const PENDING_SEED_TOKENS: u64 = 1_000_000_000_000;
pub const PENDING_SEED_LAMPORTS: u64 = 10 * crate::session::SOL;

/// Seeds a market waiting for its seed, as its seeder would: funded with the gate's seed, the
/// mint's authorities removed as a seed requires, in the replay only. The replay does not
/// check signatures, so the seeder's own signature is not needed.
fn seed_pending(
    session: &mut Session,
    view: &MarketView,
    state: &MarketState,
) -> Result<String, String> {
    use crate::session::{key, seed_ix, TOKEN, WSOL};
    let seeder = key(&state.seeder);
    let token = view.token_index();
    let (mint, program) = (view.mints[token], view.token_programs[token]);
    session.remove_mint_authorities(&mint)?;
    pipeline_check::write_token_account(
        &mut session.svm,
        &mint,
        &program,
        &seeder,
        PENDING_SEED_TOKENS,
    )?;
    pipeline_check::write_token_account(
        &mut session.svm,
        &WSOL,
        &TOKEN,
        &seeder,
        PENDING_SEED_LAMPORTS,
    )?;
    session.add_supply(&mint, PENDING_SEED_TOKENS)?;
    let from = pipeline_client::pda::associated_token(&seeder, &mint, &program);
    let hooks = session.hook_accounts(&mint, from, view.vaults[token], seeder)?;
    let ix = seed_ix(
        &session.program,
        view,
        &seeder,
        PENDING_SEED_TOKENS,
        PENDING_SEED_LAMPORTS,
        hooks,
    );
    session.send_as(&[ix], &[seeder])?;
    Ok(format!(
        "seeded with {PENDING_SEED_TOKENS} units and {PENDING_SEED_LAMPORTS} lamports"
    ))
}
