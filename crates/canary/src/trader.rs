//! A trader for the checks that act around a trade rather than only trade: a wallet of the
//! run funded on the money side, and a trade prepared (accounts resolved, quoted, hook
//! accounts found) without being sent.

use litesvm::LiteSVM;
use pipeline_check::write_token_account;
use pipeline_client::{AccountMeta, Pubkey};
use pipeline_strategy_interface::{self as psi, fees, TradeMode};

use crate::failure::Failure;
use crate::hooks::HookAccounts;
use crate::market::{fund_lamports, Session};
use crate::trade::Quote;

/// A trade ready to send.
pub struct Prepared {
    pub resolved: Vec<AccountMeta>,
    pub quote: Result<Quote, Failure>,
    pub hooks: HookAccounts,
}

impl Session<'_> {
    /// The run's wallet for `role`, holding SOL for fees, enough of mint `money` to send
    /// `amount` with Pipeline's fee, and an empty account of every other mint.
    pub fn funded_trader(
        &mut self,
        svm: &mut LiteSVM,
        role: &str,
        money: usize,
        amount: u64,
    ) -> Pubkey {
        let trader = self.seed.wallet(&self.market.address, role);
        fund_lamports(svm, &trader);
        for i in 0..self.market.len() {
            let held = if i == money {
                fees::max_total_spend(amount, 0).unwrap_or(u64::MAX)
            } else {
                0
            };
            if let Err(error) = write_token_account(
                svm,
                &self.market.mint(i),
                &self.market.token_program(i),
                &trader,
                held,
            ) {
                self.notes
                    .push(format!("could not fund the {role} wallet: {error}"));
            }
        }
        trader
    }

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
