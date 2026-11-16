//! A trade prepared without being sent (accounts resolved, quoted, hook accounts found),
//! for every leg and for the checks that act around a trade rather than only trade.

use litesvm::LiteSVM;
use pipeline_client::{AccountMeta, Pubkey};
use pipeline_strategy_interface::{self as psi, TradeMode};

use crate::failure::Failure;
use crate::hooks::HookAccounts;
use crate::market::Session;
use crate::trade::Quote;

/// A trade ready to send.
pub struct Prepared {
    pub resolved: Vec<AccountMeta>,
    pub quote: Result<Quote, Failure>,
    pub hooks: HookAccounts,
}

impl Session<'_> {
    /// Resolves, quotes and finds the hook accounts of a trade by `trader`, without sending
    /// it. Fails when the strategy's accounts cannot be resolved.
    pub fn prepare(
        &mut self,
        svm: &mut LiteSVM,
        trader: &Pubkey,
        input: usize,
        output: usize,
        amount: u64,
    ) -> Result<Prepared, Failure> {
        let request = psi::TradeRequest {
            mode: TradeMode::ExactIn,
            input_index: input as u8,
            output_index: output as u8,
            amount,
            trader: Some(trader.to_bytes()),
            extra: self.extra.clone(),
        };
        let resolved = self.resolve(svm, &request)?;
        let quote = self.quote(svm, &request, &resolved);
        let expected_out = quote.as_ref().map_or(0, |q| q.strategy_amount_out);
        let hooks = self.hook_accounts(svm, trader, input, output, amount, expected_out);
        Ok(Prepared {
            resolved,
            quote,
            hooks,
        })
    }
}
