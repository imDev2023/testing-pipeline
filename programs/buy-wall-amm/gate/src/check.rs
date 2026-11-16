//! The gate's checks on a snapshot (docs/spec/pool4-for-solana.md, "A release gate"): on
//! every market, with the candidate build and the real router, account resolution, the
//! quotes compared with the baseline build's on the same state, each keeper job that is due,
//! a buy and a sell through the router. The build passes only if every step passes on every
//! market.

use pipeline_client::Pubkey;
use pipeline_strategy_interface::fees;
use serde::Serialize;

use crate::keeper;
use crate::quotes;
use crate::release::Release;
use crate::session::{first_line, spendable, MarketView, Session};
use crate::snapshot::{parse_key, Cluster, QuoteOutcome, Snapshot};
use crate::world;

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub program: String,
    pub cluster: Cluster,
    pub synthetic: bool,
    pub candidate_sha256: String,
    pub baseline_sha256: Option<String>,
    /// Why the snapshot could not even be loaded with the candidate, if it could not.
    pub setup_error: Option<String>,
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
    pub passed: bool,
    pub detail: String,
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

    pub fn failures(&self) -> Vec<Failure> {
        self.markets
            .iter()
            .flat_map(|market| {
                market
                    .steps
                    .iter()
                    .filter(|s| !s.passed)
                    .map(|step| Failure {
                        market_state: market.market_state.clone(),
                        step: step.name.clone(),
                        detail: step.detail.clone(),
                    })
            })
            .collect()
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
                let mark = if step.passed { "ok  " } else { "FAIL" };
                writeln!(f, "  {mark} {}: {}", step.name, first_line(&step.detail))?;
            }
        }
        let failures = self.failures();
        if failures.is_empty() {
            writeln!(f, "PASSED: {} market(s), every step", self.markets.len())
        } else {
            writeln!(f, "REFUSED: {} step(s) failed", failures.len())?;
            for failure in failures {
                writeln!(
                    f,
                    "  market state {}, step {}: {}",
                    failure.market_state,
                    failure.step,
                    first_line(&failure.detail)
                )?;
            }
            Ok(())
        }
    }
}

/// Runs the gate's checks on `snapshot` with `candidate` as the program, and `router_elf`
/// (else the snapshot's own copy of the cluster's router) as the router.
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
    for saved in &snapshot.markets {
        let mut steps = Steps(vec![]);
        match parse_key(&saved.market_state) {
            Ok(market_state) => {
                check_market(&mut session, snapshot, &market_state, release, &mut steps)
            }
            Err(error) => steps.fail("read the snapshot", error),
        }
        report.markets.push(MarketReport {
            market_state: saved.market_state.clone(),
            steps: steps.0,
        });
    }
    report
}

struct Steps(Vec<Step>);

impl Steps {
    fn pass(&mut self, name: impl Into<String>, detail: impl Into<String>) {
        self.0.push(Step {
            name: name.into(),
            passed: true,
            detail: detail.into(),
        });
    }

    fn fail(&mut self, name: impl Into<String>, detail: impl Into<String>) {
        self.0.push(Step {
            name: name.into(),
            passed: false,
            detail: detail.into(),
        });
    }

    fn record<T>(
        &mut self,
        name: impl Into<String>,
        result: Result<T, String>,
        detail: impl FnOnce(T) -> String,
    ) {
        match result {
            Ok(value) => self.pass(name, detail(value)),
            Err(error) => self.fail(name, error),
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

fn check_market(
    session: &mut Session,
    snapshot: &Snapshot,
    market_state: &Pubkey,
    release: &Release,
    steps: &mut Steps,
) {
    let view = match session
        .market(market_state)
        .and_then(|view| view.sides().map(|_| view))
    {
        Ok(view) => view,
        Err(error) => return steps.fail("find the market", error),
    };
    let (token, sol) = (view.token_index(), view.sol_index());

    // Account resolution, both ways.
    for (input, output) in [(sol, token), (token, sol)] {
        let amount = quotes::amounts(session, &view, input)[0];
        let name = format!(
            "pipeline_resolve_accounts ({})",
            direction(&view, input as u8)
        );
        steps.record(
            name,
            session.resolve(&view, input, output, amount),
            |accounts| format!("{} accounts", accounts.len()),
        );
    }

    // Quotes, compared with the baseline build's on the same state.
    let baseline = snapshot.baseline.executable_sha256.as_deref();
    let recorded: Vec<_> = snapshot
        .baseline
        .quotes
        .iter()
        .filter(|q| q.market_state == market_state.to_string())
        .collect();
    if recorded.is_empty() {
        steps.fail(
            "quote",
            "the snapshot records no baseline quote for this market",
        );
    }
    for q in recorded {
        let name = format!("quote ({} {})", direction(&view, q.input_index), q.amount);
        let candidate = quotes::quote(
            session,
            &view,
            q.input_index as usize,
            q.output_index as usize,
            q.amount,
        );
        if candidate == q.result {
            steps.pass(name, format!("{candidate}, as the baseline build"));
        } else if release.changes_pricing_of(baseline) {
            steps.pass(
                name,
                format!(
                    "{candidate}, the baseline build {}: a pricing change the release declares",
                    q.result
                ),
            );
        } else {
            steps.fail(
                name,
                format!(
                    "the candidate quotes {candidate}; the baseline build {} quoted {} on the same \
                     state, and the release declares no pricing change from it",
                    baseline.unwrap_or("(unknown)"),
                    q.result
                ),
            );
        }
    }

    // What follows needs the market open; a market waiting for its seed refuses it all.
    let state = match session.state(market_state) {
        Ok(state) => state,
        Err(error) => return steps.fail("read the market state", error),
    };
    if state.status != buy_wall_amm::state::STATUS_OPEN {
        return steps.pass(
            "trade",
            format!(
                "not open (status {}), so no trade or keeper job is due",
                state.status
            ),
        );
    }

    // Each keeper job due on the state as it was.
    for job in keeper::due(&state) {
        let current = session.state(market_state).unwrap_or(state);
        steps.record(
            job.to_string(),
            keeper::run(session, &view, &current, job),
            |done| done,
        );
    }

    // A buy, then a sell of what it bought, each at its quote.
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
        None => steps.fail("sell", "not run: the buy before it failed"),
    }
}

/// A swap through the router of `amount` of mint `input`, by a fresh trader, with the
/// candidate's quote as the minimum; passes only if the trader got exactly the quote.
fn trade(
    session: &mut Session,
    view: &MarketView,
    (input, output): (usize, usize),
    amount: u64,
    steps: &mut Steps,
    name: String,
) -> Option<u64> {
    let result = (|| {
        let resolved = session.resolve(view, input, output, amount)?;
        let quoted = match session.quote(view, input, output, amount, &resolved) {
            QuoteOutcome::AmountOut(out) => out,
            QuoteOutcome::Refused(error) => return Err(format!("its quote was refused: {error}")),
        };
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
            steps.pass(name, format!("received {out}, the quote"));
            Some(out)
        }
        Err(error) => {
            steps.fail(name, error);
            None
        }
    }
}
