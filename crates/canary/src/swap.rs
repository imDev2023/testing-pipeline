//! The one swap function every trade in the checks goes through, behind the licence seam
//! (`CANARY-26`; `docs/spec/pipescope-architecture.md`, "Canary runner").
//!
//! [`ThroughRouter`] executes the router's own deployed bytes, as on devnet. The router is
//! BSL 1.1 until 2028-11-08, so a second implementation, calling the strategy directly and
//! settling with Pipeline's Apache-2.0 settlement code, can replace it without touching any
//! check; it comes with the control checks. `conformance` runs the router inside
//! `pipeline-check` itself, so it is "not run" on a path that does not.

use borsh::BorshDeserialize;
use litesvm::LiteSVM;
use pipeline_client::{self as client, AccountMeta, Pubkey, TradeMode};
use serde::Serialize;
use solana_transaction::Transaction;

use crate::config::SWAP_COMPUTE_LIMIT;
use crate::failure::{Failure, FailureClass, Stage};
use crate::market::{token_amount, Market};

/// One exact-in swap a trader sends.
pub struct SwapRequest<'a> {
    pub trader: Pubkey,
    pub input: usize,
    pub output: usize,
    pub amount_in: u64,
    /// The accounts `pipeline_resolve_accounts` listed, in the state the swap runs in.
    pub strategy_accounts: &'a [AccountMeta],
    /// `TradeRequest::extra`.
    pub extra: &'a [u8],
    /// The input mint's transfer-hook accounts for the trader-to-vault transfer, and the
    /// output mint's for the vault-to-trader transfer, as [`Session::hook_accounts`] found
    /// them; empty for a mint without a hook.
    ///
    /// [`Session::hook_accounts`]: crate::market::Session::hook_accounts
    pub input_hook_accounts: &'a [AccountMeta],
    pub output_hook_accounts: &'a [AccountMeta],
}

/// What a committed swap did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SwapReceipt {
    /// What left the trader's input account, Pipeline's fee included.
    pub trader_spent: u64,
    /// What arrived in the trader's output account.
    pub trader_received: u64,
    /// The settlement's figures, as the router (or the settlement code) reported them.
    pub net_sent: u64,
    pub received: u64,
    /// Pipeline's fee as the router charged it in the copy, never a constant of ours.
    pub pipeline_fee: u64,
    pub compute_units: u64,
    /// The strategy's own share of the compute, when the logs show it.
    pub strategy_compute_units: Option<u64>,
}

/// The licence seam.
pub trait SwapPath: Sync {
    /// Whether this path executes the router's bytes, which `conformance` needs.
    fn runs_router(&self) -> bool;

    /// Sends one swap in `svm` and commits it, or says why it failed.
    fn swap(
        &self,
        svm: &mut LiteSVM,
        market: &Market,
        request: &SwapRequest,
    ) -> Result<SwapReceipt, Failure>;
}

/// Swaps through the router's real `swap`, as a trader on devnet does.
pub struct ThroughRouter;

impl SwapPath for ThroughRouter {
    fn runs_router(&self) -> bool {
        true
    }

    fn swap(
        &self,
        svm: &mut LiteSVM,
        market: &Market,
        request: &SwapRequest,
    ) -> Result<SwapReceipt, Failure> {
        let (input, output, trader) = (request.input, request.output, request.trader);
        // The strategy pays out of its vault itself, so it is handed the output mint's hook
        // accounts after its own; the router moves the input and takes the input's.
        let mut strategy_accounts = request.strategy_accounts.to_vec();
        strategy_accounts.extend_from_slice(request.output_hook_accounts);
        let accounts = client::SwapAccounts {
            trader,
            strategy_program: market.strategy(),
            market_state: market.record.market_state,
            trader_input: market.ata(&trader, input),
            trader_output: market.ata(&trader, output),
            input_vault: market.vault(input),
            input_mint: market.mint(input),
            output_mint: market.mint(output),
            input_token_program: market.token_program(input),
            output_token_program: market.token_program(output),
            integrator_fee_account: None,
            strategy_accounts,
            input_hook_accounts: request.input_hook_accounts.to_vec(),
        };
        let args = client::SwapArgs {
            mode: TradeMode::ExactIn,
            amount_in: request.amount_in,
            amount_out: 0,
            min_amount_out: 0,
            integrator_fee_bps: 0,
            input_hook_accounts: 0,
            extra: request.extra.to_vec(),
        };
        let input_before = token_amount(svm, &accounts.trader_input).unwrap_or(0);
        let output_before = token_amount(svm, &accounts.trader_output).unwrap_or(0);
        let mut tx = Transaction::new_with_payer(
            &[
                compute_limit(SWAP_COMPUTE_LIMIT),
                client::swap(&accounts, &args),
            ],
            Some(&trader),
        );
        tx.message.recent_blockhash = svm.latest_blockhash();
        let meta = svm.send_transaction(tx).map_err(|failed| {
            Failure::from_transaction(Stage::Swap, &market.strategy(), &failed)
        })?;
        let result = (meta.return_data.program_id == client::PROGRAM_ID)
            .then(|| client::SwapResult::try_from_slice(&meta.return_data.data).ok())
            .flatten()
            .ok_or_else(|| {
                Failure::plain(
                    Stage::Swap,
                    FailureClass::RouterRefused,
                    &client::PROGRAM_ID,
                    "the router's swap returned no SwapResult",
                )
            })?;
        let strategy_line = format!("Program {} consumed ", market.strategy());
        Ok(SwapReceipt {
            trader_spent: input_before
                .saturating_sub(token_amount(svm, &accounts.trader_input).unwrap_or(0)),
            trader_received: token_amount(svm, &accounts.trader_output)
                .unwrap_or(0)
                .saturating_sub(output_before),
            net_sent: result.net_sent,
            received: result.received,
            pipeline_fee: result.pipeline_fee,
            compute_units: meta.compute_units_consumed,
            strategy_compute_units: meta
                .logs
                .iter()
                .find_map(|line| line.strip_prefix(&strategy_line))
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|n| n.parse().ok()),
        })
    }
}

/// The compute budget program's "set compute unit limit".
pub fn compute_limit(units: u32) -> client::Instruction {
    const SET_COMPUTE_UNIT_LIMIT: u8 = 2;
    let program: Pubkey = client::pubkey!("ComputeBudget111111111111111111111111111111");
    let mut data = vec![SET_COMPUTE_UNIT_LIMIT];
    data.extend_from_slice(&units.to_le_bytes());
    client::Instruction::new_with_bytes(program, &data, vec![])
}
