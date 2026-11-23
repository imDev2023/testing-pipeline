//! Reading a failed step's error, as every gate judges it: the program a failure started in,
//! and the instruction error that tells one failure from another (decision `POOL4-46` and
//! review finding R2G-01, docs/spec/pool4-for-solana.md, "A release gate").
//!
//! A gate's step fails with the transaction error's `Debug` text on its first line and the
//! logs after it.

use pipeline_client::Pubkey;

/// The program whose failure an error's logs show first: the innermost one, where the
/// failure started (a transfer hook's, say, under the token program and the router). `None`
/// for an error no program raised, such as the gate's own.
pub fn failing_program(error: &str) -> Option<String> {
    error.lines().find_map(|line| {
        let rest = line.strip_prefix("Program ")?;
        let (program, tail) = rest.split_once(' ')?;
        let valid = program.len() >= 32 && program.parse::<Pubkey>().is_ok();
        (valid && tail.starts_with("failed")).then(|| program.to_string())
    })
}

/// What tells one failure from another: the instruction error in its first line, which
/// carries the failing program's own error code (`InstructionError(0, Custom(6033))`), or the
/// whole first line when no program raised it.
pub fn failure_error(message: &str) -> String {
    let line = first_line(message);
    let Some(start) = line.find("InstructionError(") else {
        return line;
    };
    let mut depth = 0;
    for (at, c) in line[start..].char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => continue,
        }
        if depth == 0 {
            return line[start..=start + at].to_string();
        }
    }
    line
}

/// The two keys a failed `require_keys_eq!` compared, as Anchor logs them: the left, then the
/// right.
pub fn compared_keys(message: &str) -> Option<(Pubkey, Pubkey)> {
    let logs: Vec<&str> = message
        .lines()
        .filter_map(|line| line.strip_prefix("Program log: "))
        .collect();
    let at = logs.iter().position(|line| *line == "Left:")?;
    match logs.get(at + 1..at + 4)? {
        [left, "Right:", right] => Some((left.parse().ok()?, right.parse().ok()?)),
        _ => None,
    }
}

/// The error alone, without the logs.
pub fn first_line(message: &str) -> String {
    message.lines().next().unwrap_or_default().to_string()
}

/// A failed transaction as a step's error: the error, then the logs.
pub fn failure(error: &impl std::fmt::Debug, logs: &[String]) -> String {
    format!("{error:?}\n{}", logs.join("\n"))
}

/// The most a wallet holding `held` can send in a swap, Pipeline's fee coming on top of
/// what it sends.
pub fn spendable(held: u64) -> u64 {
    let budget = |amount: u64| {
        pipeline_strategy_interface::fees::max_total_spend(amount, 0).unwrap_or(u64::MAX)
    };
    let mut amount = (held as u128 * 10_000 / 10_025) as u64;
    while amount > 0 && budget(amount) > held {
        amount -= 1;
    }
    while budget(amount + 1) <= held {
        amount += 1;
    }
    amount
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_failures_differ_by_their_instruction_error_or_else_their_whole_message() {
        assert_eq!(
            failure_error("InstructionError(0, Custom(6033))\nProgram log: anything"),
            "InstructionError(0, Custom(6033))"
        );
        assert_eq!(
            failure_error("its quote was refused: InstructionError(1, InvalidAccountData) then"),
            "InstructionError(1, InvalidAccountData)"
        );
        assert_eq!(
            failure_error("received 5, not the quote 6\nmore"),
            "received 5, not the quote 6"
        );
    }

    #[test]
    fn the_keys_a_failed_comparison_logged_are_read_back_in_order() {
        let (left, right) = (Pubkey::new_unique(), Pubkey::new_unique());
        let logs = format!(
            "InstructionError(0, Custom(6000))\nProgram log: AnchorError occurred.\nProgram log: \
             Left:\nProgram log: {left}\nProgram log: Right:\nProgram log: {right}\nProgram x \
             failed"
        );
        assert_eq!(compared_keys(&logs), Some((left, right)));
        assert_eq!(compared_keys("InstructionError(0, Custom(6000))"), None);
    }

    #[test]
    fn a_failure_is_placed_in_the_innermost_program_that_failed() {
        let (hook, token, router) = (
            Pubkey::new_unique(),
            pipeline_client::TOKEN_2022_PROGRAM_ID.to_string(),
            pipeline_client::PROGRAM_ID.to_string(),
        );
        let logs = format!(
            "InstructionError(0, Custom(32343))\nProgram {router} invoke [1]\nProgram log: \
             transfer failed to go through\nProgram {hook} invoke [3]\nProgram {hook} failed: \
             custom program error: 0x7e57\nProgram {token} failed: custom program error: \
             0x7e57\nProgram {router} failed: custom program error: 0x7e57"
        );
        assert_eq!(failing_program(&logs), Some(hook.to_string()));
        assert_eq!(failing_program("not run: the buy before it failed"), None);
    }

    #[test]
    fn a_wallet_spends_all_it_can_with_pipelines_fee_on_top() {
        for held in [0, 1, 1_000, 999_999_999, 1_000_000_000_000] {
            let amount = spendable(held);
            let budget = |a| pipeline_strategy_interface::fees::max_total_spend(a, 0).unwrap();
            assert!(budget(amount) <= held);
            assert!(budget(amount + 1) > held);
        }
    }
}
