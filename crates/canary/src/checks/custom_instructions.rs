//! `custom_instructions`: lists every instruction in the strategy's code beyond Pipeline's
//! six, each with how often it has been called and by which signers (`CANARY-18`). Noted
//! only: Canary v1 never calls them.
//!
//! The list is not worked out here (`PIPESCOPE-92`): `terminal-api` works it out once per
//! strategy version when the indexer records it, with the callers from the indexer's history,
//! and the `CanaryRun` Durable Object posts it in the snapshot ([`StrategyInstructions`]). A
//! run given no list is "not run".

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::record::{Outcome, Verdict};

/// One instruction compiled into the strategy, with its callers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstructionCalls {
    /// Its name as Anchor compiles it in ("Instruction: Name").
    pub name: String,
    /// How many times it has been called.
    pub calls: u64,
    /// The signers that have called it.
    #[serde(default)]
    pub signers: Vec<String>,
}

/// A strategy version's instructions, as `terminal-api` stores them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StrategyInstructions {
    /// Whether the program is built with Anchor; when not, no names can be found.
    pub anchor: bool,
    /// Every instruction found, Pipeline's own included.
    #[serde(default)]
    pub instructions: Vec<InstructionCalls>,
}

/// Pipeline's six instructions, as names compare: lower case without underscores.
const PIPELINE_SIX: [&str; 6] = [
    "pipelineinitmarket",
    "pipelinemarketinfo",
    "pipelineresolveaccounts",
    "pipelinequote",
    "pipelineswap",
    "pipelineseedliquidity",
];

fn is_pipelines(name: &str) -> bool {
    let plain: String = name
        .chars()
        .filter(|c| *c != '_')
        .map(|c| c.to_ascii_lowercase())
        .collect();
    PIPELINE_SIX.contains(&plain.as_str())
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub fn judge(list: Option<&StrategyInstructions>) -> Verdict {
    let Some(list) = list else {
        return Verdict::not_run(
            "Not run: the run was given no instruction list; terminal-api works it out once per strategy version and the snapshot carries it.",
        );
    };
    let custom: Vec<&InstructionCalls> = list
        .instructions
        .iter()
        .filter(|i| !is_pipelines(&i.name))
        .collect();
    let inputs = json!({ "source": "the strategy version's instruction list, from terminal-api" });
    let numbers = json!({ "anchor": list.anchor, "instructions": custom });
    let reason = if !list.anchor {
        "Instructions beyond Pipeline's six: none found, because the program is not built with Anchor, so its instructions cannot be named.".to_string()
    } else if custom.is_empty() {
        "The strategy has no instructions beyond Pipeline's six.".to_string()
    } else {
        let each: Vec<String> = custom
            .iter()
            .map(|i| match i.calls {
                0 => format!("{} (never called)", i.name),
                calls => format!(
                    "{} (called {} by {})",
                    i.name,
                    plural(calls as usize, "time", "times"),
                    plural(i.signers.len(), "signer", "signers")
                ),
            })
            .collect();
        format!(
            "The strategy has {} beyond Pipeline's six, which Canary does not call: {}.",
            plural(custom.len(), "instruction", "instructions"),
            each.join(", ")
        )
    };
    Verdict::new(Outcome::Noted, reason, inputs, numbers)
}
