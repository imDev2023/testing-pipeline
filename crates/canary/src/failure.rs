//! How a failed step is named (`CANARY-14`; `docs/spec/pipescope-canary.md`, "How a
//! failure is named"): classed from the transaction's error and logs, with the program that
//! raised it and, for Anchor programs, the error's name, number, message and source line.

use std::fmt;

use litesvm::types::FailedTransactionMetadata;
use pipeline_client::{self as client, Pubkey};
use serde::Serialize;

/// Anchor's "the account does not hold the type I expect" errors.
const ANCHOR_DISCRIMINATOR_MISMATCH: u32 = 3002;
const ANCHOR_DID_NOT_DESERIALIZE: u32 = 3003;

/// Which step of a trade failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    MarketInfo,
    ResolveAccounts,
    Quote,
    Swap,
    /// A token authority's own instruction, in `token_authorities`.
    AuthorityAction,
}

impl Stage {
    pub fn describe(self) -> &'static str {
        match self {
            Stage::MarketInfo => "reading the market's info",
            Stage::ResolveAccounts => "resolving the trade's accounts",
            Stage::Quote => "quoting",
            Stage::Swap => "the swap",
            Stage::AuthorityAction => "the authority's own instruction",
        }
    }
}

/// The class of a failure, from the spec's list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    /// The strategy cannot deserialise the market's state.
    CannotReadState,
    StrategyRefused,
    RouterRefused,
    TokenProgramRefused,
    /// A clean error from another program, such as a transfer hook.
    OtherProgramRefused,
    /// A program panicked instead of returning an error.
    Crash,
    /// The step ran out of its compute limit.
    OutOfCompute,
}

impl FailureClass {
    /// A crash or an out-of-compute anywhere is at least a warn on its check.
    pub fn is_fault(self) -> bool {
        matches!(self, FailureClass::Crash | FailureClass::OutOfCompute)
    }

    pub fn words(self) -> &'static str {
        match self {
            FailureClass::CannotReadState => "cannot read state",
            FailureClass::StrategyRefused => "strategy refused",
            FailureClass::RouterRefused => "router refused",
            FailureClass::TokenProgramRefused => "token program refused",
            FailureClass::OtherProgramRefused => "another program refused",
            FailureClass::Crash => "crash",
            FailureClass::OutOfCompute => "out of compute",
        }
    }
}

/// An Anchor error as Anchor logs it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AnchorError {
    pub name: String,
    pub number: u32,
    pub message: String,
    /// The source line (`thrown in src/lib.rs:199`) or the account (`caused by account:
    /// pool`) Anchor names, as it logs it.
    pub origin: Option<String>,
}

/// One failed step.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub stage: Stage,
    pub class: FailureClass,
    /// The program that raised it, the innermost one that failed.
    pub program: Option<String>,
    pub anchor: Option<Box<AnchorError>>,
    /// The custom error code, when the program returned one.
    pub code: Option<u32>,
    /// The panic message, for a crash.
    pub panic: Option<String>,
    /// The transaction error as the VM reports it.
    pub error: String,
    pub compute_units: u64,
}

impl Failure {
    /// Classes a failed transaction. `strategy` is the market's strategy program.
    pub fn from_transaction(
        stage: Stage,
        strategy: &Pubkey,
        failed: &FailedTransactionMetadata,
    ) -> Self {
        classify(
            stage,
            strategy,
            &format!("{:?}", failed.err),
            &failed.meta.logs,
            failed.meta.compute_units_consumed,
        )
    }

    /// A failure with no transaction behind it, such as malformed return data.
    pub fn plain(
        stage: Stage,
        class: FailureClass,
        program: &Pubkey,
        error: impl Into<String>,
    ) -> Self {
        Failure {
            stage,
            class,
            program: Some(program.to_string()),
            anchor: None,
            code: None,
            panic: None,
            error: error.into(),
            compute_units: 0,
        }
    }

    /// The program's own words for the error: the Anchor name and message, the panic, or
    /// the VM's error.
    pub fn error_words(&self) -> String {
        if let Some(anchor) = &self.anchor {
            return format!("{}: {}", anchor.name, anchor.message);
        }
        if let Some(panic) = &self.panic {
            return panic.clone();
        }
        match self.code {
            // The classic token program's error codes are the first of Token-2022's.
            Some(code) if self.class == FailureClass::TokenProgramRefused => {
                match spl_token_2022_interface::error::TokenError::try_from(code) {
                    Ok(error) => format!("{error:?}: {error}"),
                    Err(_) => format!("error {code}"),
                }
            }
            Some(code) => format!("error {code}"),
            None => self.error.clone(),
        }
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.class.words(), self.error_words())
    }
}

fn between<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = text.find(start)? + start.len();
    let to = text[from..].find(end)? + from;
    Some(&text[from..to])
}

/// Classes a failure from the transaction error's debug text and the logs.
pub fn classify(
    stage: Stage,
    strategy: &Pubkey,
    error: &str,
    logs: &[String],
    compute_units: u64,
) -> Failure {
    // The innermost program fails first; its callers then report the same failure.
    let mut program = None;
    let mut reason = String::new();
    for line in logs {
        if let Some((id, why)) = line
            .strip_prefix("Program ")
            .and_then(|rest| rest.split_once(" failed: "))
        {
            program = Some(id.to_string());
            reason = why.to_string();
            break;
        }
    }
    let anchor = logs
        .iter()
        .find(|line| line.contains("Error Code: ") && line.contains("Error Number: "))
        .and_then(|line| {
            Some(Box::new(AnchorError {
                name: between(line, "Error Code: ", ". Error Number")?.to_string(),
                number: between(line, "Error Number: ", ". Error Message")?
                    .parse()
                    .ok()?,
                message: line
                    .split_once("Error Message: ")?
                    .1
                    .trim_end_matches('.')
                    .to_string(),
                origin: between(line, "AnchorError ", ". Error Code").map(str::to_string),
            }))
        });
    let panic = logs
        .iter()
        .find_map(|line| {
            line.find("panicked at")
                .map(|at| line[at..].trim().to_string())
        })
        .or_else(|| {
            // The VM's own words for a panic ("SBF program Panicked in src/lib.rs at 80:32")
            // or a memory fault.
            let words = reason.to_lowercase();
            let crashed = words.contains("panicked")
                || words.contains("access violation")
                || words.contains("failed to complete")
                || error.contains("ProgramFailedToComplete");
            crashed.then(|| reason.clone())
        });
    let code = between(error, "Custom(", ")").and_then(|n| n.parse::<u32>().ok());
    let out_of_compute = error.contains("ComputationalBudgetExceeded")
        || reason.contains("exceeded CUs meter")
        || logs.iter().any(|l| {
            l.contains("exceeded CUs meter") || l.contains("Computational budget exceeded")
        });
    let number = anchor.as_ref().map(|a| a.number).or(code);
    let raised_by = |id: &Pubkey| program.as_deref() == Some(id.to_string().as_str());
    let class = if out_of_compute {
        FailureClass::OutOfCompute
    } else if panic.is_some() {
        FailureClass::Crash
    } else if raised_by(strategy)
        && matches!(
            number,
            Some(ANCHOR_DISCRIMINATOR_MISMATCH | ANCHOR_DID_NOT_DESERIALIZE)
        )
    {
        FailureClass::CannotReadState
    } else if raised_by(strategy) {
        FailureClass::StrategyRefused
    } else if raised_by(&client::PROGRAM_ID) {
        FailureClass::RouterRefused
    } else if raised_by(&client::TOKEN_PROGRAM_ID) || raised_by(&client::TOKEN_2022_PROGRAM_ID) {
        FailureClass::TokenProgramRefused
    } else {
        FailureClass::OtherProgramRefused
    };
    Failure {
        stage,
        class,
        program,
        anchor,
        code,
        panic,
        error: error.to_string(),
        compute_units,
    }
}
