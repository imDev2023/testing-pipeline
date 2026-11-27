//! The gate's checks on a snapshot (docs/spec/lending-pool.md, "A release gate"): on every
//! market, with the candidate build, the real router and Kamino Lend, account resolution both
//! ways, the quotes compared with the deployed build's on the same state,
//! `pipeline_market_info`, `rebalance` when it is due or the deployed build ran it, a buy and a
//! sell through the router, and a sale paying out more than the buffer holds, which redeems
//! the shortfall from Kamino inside the swap.
//!
//! The same replay, run with the deployed build when the snapshot is taken
//! ([`record_baseline`]), records the deployed build's quotes and whether each other step
//! passed with it, `rebalance` tried whether due or not. A step the candidate fails counts
//! against it unless the deployed build failed the same step on the same snapshot, with the
//! same error starting in the same program (the relative rule of the buy wall AMM's gate,
//! `POOL4-46`): a market whose token's hook refuses the gate's trader, or a reserve whose
//! emergency mode stops redeems, fails those steps under every build, so they cannot veto a
//! release, while a candidate that newly fails a step, or fails it with another error or in
//! another program, is refused. The layout checks (reading the market state, finding the
//! market, account resolution, the quotes and `pipeline_market_info`) never count as shared and
//! run on every market whatever else fails, so a build that would strand a market is refused
//! even on a market whose trades are blocked; a quote both builds refuse with the same error
//! is the same answer, and passes.
//!
//! Each replay first brings every lent mint's reserve up to date at the snapshot's clock
//! (`kamino::refresh_all`), so quotes and swaps may value the cTokens.
//!
//! Then, in a world of its own, the gate makes a market with the candidate (`own.rs`) and
//! checks it as it checks the cluster's, every step counting.

use pipeline_client::{self as client, pda, Pubkey};
use pipeline_strategy_interface::fees;
use release_gate::errors::{failing_program, failure_error, first_line, spendable};
use release_gate::release::Release;
use serde::Serialize;
use solana_signer::Signer;

use crate::kamino;
use crate::session::{program_name, rebalance_ix, MarketView, Session};
use crate::snapshot::{
    parse_key, Baseline, Cluster, Outcome, Quote, QuoteOutcome, RecordedStep, Snapshot, StepKind,
};
use crate::world::{self, Programs};

/// The gate's quotes are of what the input vault holds divided by each of these (`POOL4-41`'s
/// amounts): on the lent side the vault is the buffer.
pub const QUOTE_DIVISORS: [u64; 3] = [10, 100, 1_000];
/// The gate's buy is of what the buffer holds divided by this; its sell is of what the buy
/// bought.
pub const BUY_DIVISOR: u64 = 100;

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub program: String,
    pub cluster: Cluster,
    pub candidate_sha256: String,
    pub baseline_sha256: Option<String>,
    /// Why the snapshot could not even be loaded with the candidate, if it could not.
    pub setup_error: Option<String>,
    /// What bringing the reserves up to date noted (a reserve klend would not refresh).
    pub notes: Vec<String>,
    /// Whether a quote passed only because the release declares a pricing change.
    pub relied_on_pricing_change: bool,
    pub markets: Vec<MarketReport>,
    /// The market the gate made of its own in a world of its own, after the cluster's (`None`
    /// only when the snapshot did not load); every failed step there counts.
    pub own_market: Option<MarketReport>,
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
            .chain(&self.own_market)
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
            "Release gate for {} on {cluster} at slot {}",
            self.program, self.cluster.slot
        )?;
        writeln!(f, "  candidate build {}", self.candidate_sha256)?;
        writeln!(
            f,
            "  baseline build  {}",
            self.baseline_sha256.as_deref().unwrap_or("none")
        )?;
        for note in &self.notes {
            writeln!(f, "  note: {note}")?;
        }
        if let Some(error) = &self.setup_error {
            writeln!(
                f,
                "REFUSED: the snapshot does not load with the candidate: {error}"
            )?;
            return Ok(());
        }
        let own = self.own_market.iter().map(|market| (market, true));
        for (market, ours) in self.markets.iter().map(|m| (m, false)).chain(own) {
            let what = if ours {
                "market of its own"
            } else {
                "market state"
            };
            writeln!(f, "{what} {}", market.market_state)?;
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
        let checked = format!(
            "{} market(s) of the cluster{}",
            self.markets.len(),
            if self.own_market.is_some() {
                " and one of its own"
            } else {
                ""
            }
        );
        if failures.is_empty() {
            if shared.is_empty() {
                writeln!(f, "PASSED: {checked}, every step")?;
            } else {
                writeln!(
                    f,
                    "PASSED: {checked}; {} step(s) failed, each as it fails under the deployed \
                     build, so none is a regression:",
                    shared.len()
                )?;
            }
        } else {
            writeln!(f, "REFUSED: {} step(s) failed", failures.len())?;
            for failure in &failures {
                let what = match &self.own_market {
                    Some(own) if own.market_state == failure.market_state => "market of its own",
                    _ => "market state",
                };
                writeln!(
                    f,
                    "  {what} {}, step {}: {}",
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

/// Runs the gate's checks on `snapshot` with `candidate` as the program, and `programs` (else
/// the snapshot's own copies of the cluster's) as the router and klend, each step judged
/// against what the snapshot records of the deployed build.
pub fn run(snapshot: &Snapshot, candidate: &[u8], programs: Programs, release: &Release) -> Report {
    let mut report = Report {
        program: snapshot.program.clone(),
        cluster: snapshot.cluster.clone(),
        candidate_sha256: pipeline_check::executable_sha256(candidate).0,
        baseline_sha256: snapshot.baseline.executable_sha256.clone(),
        setup_error: None,
        notes: vec![],
        relied_on_pricing_change: false,
        markets: vec![],
        own_market: None,
    };
    let loaded = snapshot
        .program_id()
        .and_then(|program| Ok((program, world::load(snapshot, candidate, programs)?)));
    let (program, svm) = match loaded {
        Ok(loaded) => loaded,
        Err(error) => {
            report.setup_error = Some(error);
            return report;
        }
    };
    let mut session = Session::new(svm, program);
    report.notes = session.refresh_reserves();
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
    report.own_market = Some(own_market(snapshot, program, candidate, programs));
    report
}

/// The name of the step that makes the gate's own market.
pub const MAKE_MARKET: &str = "make a market of its own";

/// Makes a market of the gate's own with `candidate` and checks it ([`crate::own`]): every
/// step counts, since the deployed build never ran it.
fn own_market(
    snapshot: &Snapshot,
    program: Pubkey,
    candidate: &[u8],
    programs: Programs,
) -> MarketReport {
    let mut steps = Steps::default();
    let made = world::own(snapshot, candidate, programs).and_then(|svm| {
        let mut session = Session::new(svm, program);
        let notes = session.refresh_reserves();
        if let Some(note) = notes.first() {
            return Err(note.clone());
        }
        let (market_state, detail) = crate::own::make_market(&mut session)?;
        Ok((session, market_state, detail))
    });
    let (mut session, market_state, detail) = match made {
        Ok(made) => made,
        Err(error) => {
            steps.fail(StepKind::MakeMarket, MAKE_MARKET, error);
            return MarketReport {
                market_state: "(not made)".into(),
                steps: steps.steps,
            };
        }
    };
    steps.pass(StepKind::MakeMarket, MAKE_MARKET, detail);
    check_market(&mut session, &market_state, &Mode::Own, &mut steps);
    MarketReport {
        market_state: market_state.to_string(),
        steps: steps.steps,
    }
}

/// The same replay with `deployed` as the program: its quotes, and whether each other step
/// passed with it, `rebalance` tried on every market, which is what a snapshot records of the
/// deployed build. `programs` as in [`run`].
pub fn record_baseline(
    snapshot: &Snapshot,
    deployed: &[u8],
    programs: Programs,
) -> Result<Baseline, String> {
    let program = snapshot.program_id()?;
    let mut session = Session::new(world::load(snapshot, deployed, programs)?, program);
    session.refresh_reserves();
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

/// Marks each failed step the deployed build failed the same way, with the same error
/// starting in the same program, as not counting; never a layout check.
fn compare_with_deployed(steps: &mut [Step], baseline: &Baseline, market_state: &str) {
    for step in steps.iter_mut() {
        if step.passed || !step.kind.may_fail_under_any_build() {
            continue;
        }
        let Some(Outcome::Failed { program, error }) = baseline.outcome(market_state, &step.kind)
        else {
            continue;
        };
        if *program != step.program || failure_error(error) != failure_error(&step.detail) {
            continue;
        }
        step.deployed_fails_too = Some(if *error == first_line(&step.detail) {
            "the deployed build fails it the same way".into()
        } else {
            format!("the deployed build fails it there too, with {error}")
        });
    }
}

/// Whether the replay records the deployed build, checks a candidate against it, or checks
/// the gate's own market, which no baseline covers.
enum Mode<'a> {
    Record,
    Check {
        baseline: &'a Baseline,
        release: &'a Release,
    },
    Own,
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

/// "buy" for a trade paying the lent mint for the other, "sell" for the other way.
fn direction(view: &MarketView, input: u8) -> &'static str {
    if input as usize == view.lent {
        "buy"
    } else {
        "sell"
    }
}

/// The amounts quoted from mint `input`: shares of what its vault holds (on the lent side the
/// buffer), or 1 when it holds nothing.
pub fn quote_amounts(session: &Session, view: &MarketView, input: usize) -> Vec<u64> {
    let held = session.balance(&view.vaults[input]).unwrap_or_default();
    QUOTE_DIVISORS
        .iter()
        .map(|divisor| (held / divisor).max(1))
        .collect()
}

fn check_market(session: &mut Session, market_state: &Pubkey, mode: &Mode, steps: &mut Steps) {
    let state = match session.state(market_state) {
        Ok(state) => state,
        Err(error) => return steps.fail(StepKind::ReadState, "read the market state", error),
    };

    // A market the router never recorded is registered as anyone could, so it is checked like
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
    let view = match view.and_then(|view| {
        (view.mints.len() == 2)
            .then_some(view)
            .ok_or_else(|| "the market does not have two mints".to_string())
    }) {
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
    let (lent, other) = (view.lent, view.other());

    // Account resolution, both ways.
    for (input, output) in [(lent, other), (other, lent)] {
        let amount = quote_amounts(session, &view, input)[0];
        steps.record(
            StepKind::Resolve {
                input_index: input as u8,
            },
            format!(
                "pipeline_resolve_accounts ({})",
                direction(&view, input as u8)
            ),
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

    // `rebalance`: recording, always; checking, when this tree's band says it is due or the
    // deployed build ran it; on the gate's own market, when due.
    let due = rebalance_due(session, &view);
    let run_rebalance = match mode {
        Mode::Record => true,
        Mode::Own => due,
        Mode::Check { baseline, .. } => {
            due || baseline.outcome(&market_state.to_string(), &StepKind::Rebalance)
                == Some(&Outcome::Passed)
        }
    };
    if run_rebalance {
        steps.record(
            StepKind::Rebalance,
            "rebalance",
            rebalance(session, &view),
            |d| d,
        );
    }

    if !registered {
        let why = "not run: the router has no Market for it";
        steps.fail(StepKind::Buy, "buy", why);
        steps.fail(StepKind::Sell, "sell", why);
        steps.fail(StepKind::SellBeyondBuffer, "sell beyond the buffer", why);
        return;
    }

    // A buy, then a sell of what it bought, each at its quote.
    let buffer = session.balance(&view.vaults[lent]).unwrap_or_default();
    let buy = (buffer / BUY_DIVISOR).max(1);
    let bought = trade(
        session,
        &view,
        (lent, other),
        buy,
        StepKind::Buy,
        steps,
        format!("buy ({buy} of the lent mint)"),
    );
    match bought {
        Some(bought) => {
            let sell = spendable(bought);
            trade(
                session,
                &view,
                (other, lent),
                sell,
                StepKind::Sell,
                steps,
                format!("sell ({sell} of the other mint)"),
            );
        }
        None => steps.fail(StepKind::Sell, "sell", "not run: the buy before it failed"),
    }

    // A sale paying out the buffer and half the lent value besides, which redeems the rest from
    // Kamino inside the swap.
    let name = "sell beyond the buffer";
    match beyond_buffer_amount(session, &view) {
        Err(error) => steps.fail(StepKind::SellBeyondBuffer, name, error),
        // Nothing lent, so the buffer is the whole lent side and no sale can redeem from Kamino.
        // The deployed build's replay then records no such step; a candidate that leaves nothing
        // lent where the deployed build sold beyond the buffer has skipped a sale the deployed
        // build made, and on the gate's own market, whose rebalance must lend, it always counts.
        Ok(None) => match mode {
            Mode::Record => {}
            Mode::Own => steps.fail(
                StepKind::SellBeyondBuffer,
                name,
                "not run: the market has nothing lent, so no sale can redeem from Kamino",
            ),
            Mode::Check { baseline, .. } => {
                if baseline.outcome(&market_state.to_string(), &StepKind::SellBeyondBuffer)
                    == Some(&Outcome::Passed)
                {
                    steps.fail(
                        StepKind::SellBeyondBuffer,
                        name,
                        "not run: the candidate left nothing lent, where the deployed build sold \
                         beyond the buffer, redeeming from Kamino",
                    )
                } else {
                    steps.pass(
                        StepKind::SellBeyondBuffer,
                        name,
                        "not run: the market has nothing lent, as under the deployed build",
                    )
                }
            }
        },
        Ok(Some(amount)) => {
            trade(
                session,
                &view,
                (other, lent),
                amount,
                StepKind::SellBeyondBuffer,
                steps,
                format!("{name} ({amount} of the other mint)"),
            );
        }
    }
}

/// Whether this tree's rule says `rebalance` is due: the buffer outside its band, or the market
/// in withdraw mode, where only `rebalance` can bring it back.
fn rebalance_due(session: &Session, view: &MarketView) -> bool {
    let in_withdraw_mode = session
        .state(&view.market_state)
        .is_ok_and(|state| state.withdraw_mode);
    in_withdraw_mode
        || session.lent_total(view).is_ok_and(|(buffer, total)| {
            lending_amm::buffer::band(buffer, total) != lending_amm::buffer::Band::Within
        })
}

/// `rebalance` by the market's keeper, with the lent mint's Kamino accounts.
fn rebalance(session: &mut Session, view: &MarketView) -> Result<String, String> {
    let kamino = kamino::Accounts::in_svm(&session.svm, &view.mints[view.lent])?;
    let keeper = session.keeper(&view.market_state)?;
    let before = session.state(&view.market_state)?;
    let ix = rebalance_ix(&session.program, view, &keeper.pubkey(), &kamino);
    session.send(&[ix], &[&keeper])?;
    let after = session.state(&view.market_state)?;
    Ok(format!(
        "buffer {} to {}, cTokens {} to {}{}",
        before.reserves[view.lent],
        after.reserves[view.lent],
        before.ctokens,
        after.ctokens,
        if after.withdraw_mode {
            ", in withdraw mode"
        } else {
            ""
        }
    ))
}

/// The amount of the other mint whose sale pays out the buffer and half the lent value
/// besides, by the constant product on `L = B + V` with the LP fee; `None` when nothing is lent.
fn beyond_buffer_amount(session: &Session, view: &MarketView) -> Result<Option<u64>, String> {
    let state = session.state(&view.market_state)?;
    let (buffer, total) = session.lent_total(view)?;
    let value = total - buffer;
    if value == 0 {
        return Ok(None);
    }
    let out = buffer as u128 + value as u128 / 2;
    let reserve = state.reserves[view.other()] as u128;
    // out = L x a' / (R + a'), with a' the input after the LP fee: a' = out x R / (L - out).
    let after_fee = (out * reserve).div_ceil(total as u128 - out);
    let amount = after_fee * 10_000 / (10_000 - state.lp_fee_bps as u128) + 1;
    u64::try_from(amount)
        .map(Some)
        .map_err(|_| "the sale beyond the buffer does not fit in a u64".into())
}

/// The quotes: recording, at a tenth, a hundredth and a thousandth of each input vault;
/// checking, each the deployed build gave, compared with it; on the gate's own market, the
/// same amounts as recording, each of which must serve.
fn check_quotes(session: &Session, view: &MarketView, mode: &Mode, steps: &mut Steps) {
    let (lent, other) = (view.lent, view.other());
    let market_state = view.market_state.to_string();
    let (baseline, release) = match mode {
        Mode::Record | Mode::Own => {
            for (input, output) in [(lent, other), (other, lent)] {
                for amount in quote_amounts(session, view, input) {
                    let result = session.quote(view, input, output, amount);
                    let kind = StepKind::Quote {
                        input_index: input as u8,
                        amount,
                    };
                    let name = format!("quote ({} {amount})", direction(view, input as u8));
                    if matches!(mode, Mode::Own) {
                        match result {
                            QuoteOutcome::AmountOut(out) => steps.pass(kind, name, out.to_string()),
                            refused => steps.fail(
                                kind,
                                name,
                                format!(
                                    "{refused} on a market of the gate's own, which must serve it"
                                ),
                            ),
                        }
                        continue;
                    }
                    steps.pass(kind, name, format!("{result}, recorded"));
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
                input_index: lent as u8,
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
        let candidate = session.quote(
            view,
            q.input_index as usize,
            q.output_index as usize,
            q.amount,
        );
        // A declared pricing change lets amounts differ, never a quote the baseline served turn
        // into a refusal.
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

/// `pipeline_market_info` with the candidate, which must give the mints and vaults the router
/// records (or, for a market it has not recorded, the ones the market state holds).
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
    state: &lending_amm::LendingAmmMarket,
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

fn missing_fee_accounts(session: &Session, view: &MarketView) -> Vec<usize> {
    (0..view.mints.len())
        .filter(|&i| {
            let account = pda::fee_account(&view.market, &view.mints[i], &view.token_programs[i]);
            session.svm.get_account(&account).is_none()
        })
        .collect()
}

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

/// A swap through the router of `amount` of mint `input`, by the market's trader holding just
/// what it needs, with the candidate's quote, resolved for that amount, as the minimum to
/// arrive; passes only if exactly the quote arrived (the router's `received`, before any
/// Pipeline fee taken from the output).
fn trade(
    session: &mut Session,
    view: &MarketView,
    (input, output): (usize, usize),
    amount: u64,
    kind: StepKind,
    steps: &mut Steps,
    name: String,
) -> Option<u64> {
    let result = (|| {
        let resolved = session.resolve(view, input, output, amount)?;
        let quoted = session
            .quote_amount(view, input, output, amount, &resolved)
            .map_err(|error| format!("its quote was refused: {error}"))?;
        let budget = fees::max_total_spend(amount, 0).ok_or("the budget overflows")?;
        let trader = session.trader(view, input, budget)?;
        let swapped = session.swap(view, &trader, input, output, amount, quoted, &resolved)?;
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
