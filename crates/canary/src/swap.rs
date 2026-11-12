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
use pipeline_check::hooks;

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
    /// What the quote said the strategy would send, for an output transfer hook that derives
    /// its accounts from the amount; 0 when the quote failed.
    pub expected_output: u64,
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
        let (strategy_accounts, input_hook_accounts) = hook_accounts(svm, market, request);
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
            input_hook_accounts,
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

/// The strategy's accounts with the output mint's transfer-hook accounts after them, and the
/// input mint's transfer-hook accounts, resolved as `pipeline-check` resolves them for its own
/// swaps: the input transfer runs from the trader to the vault, the output transfer from the
/// vault to the trader. Unresolvable hook accounts are left out; the swap then fails and says
/// why.
fn hook_accounts(
    svm: &LiteSVM,
    market: &Market,
    request: &SwapRequest,
) -> (Vec<AccountMeta>, Vec<AccountMeta>) {
    let (input, output, trader) = (request.input, request.output, request.trader);
    let data = |key: &Pubkey| svm.get_account(key).map(|a| a.data);
    let mut strategy_accounts = request.strategy_accounts.to_vec();
    let mut input_hook_accounts = vec![];
    if let Some(hook) = market.mints[input].transfer_hook {
        let transfer = hooks::Transfer {
            source: market.ata(&trader, input),
            mint: market.mint(input),
            destination: market.vault(input),
            authority: trader,
            amount: request.amount_in,
        };
        input_hook_accounts = hooks::resolve(&hook, &transfer, data).unwrap_or_default();
    }
    if let Some(hook) = market.mints[output].transfer_hook {
        let vault = market.vault(output);
        let transfer = hooks::Transfer {
            source: vault,
            mint: market.mint(output),
            destination: market.ata(&trader, output),
            authority: token_owner(svm, &vault).unwrap_or_default(),
            amount: request.expected_output,
        };
        strategy_accounts.extend(hooks::resolve(&hook, &transfer, data).unwrap_or_default());
    }
    (strategy_accounts, input_hook_accounts)
}

/// A token account's owner.
fn token_owner(svm: &LiteSVM, account: &Pubkey) -> Option<Pubkey> {
    const OWNER: std::ops::Range<usize> = 32..64;
    svm.get_account(account).and_then(|a| {
        a.data
            .get(OWNER)
            .map(|b| Pubkey::new_from_array(b.try_into().expect("32 bytes")))
    })
}

/// The compute budget program's "set compute unit limit".
pub fn compute_limit(units: u32) -> client::Instruction {
    const SET_COMPUTE_UNIT_LIMIT: u8 = 2;
    let program: Pubkey = client::pubkey!("ComputeBudget111111111111111111111111111111");
    let mut data = vec![SET_COMPUTE_UNIT_LIMIT];
    data.extend_from_slice(&units.to_le_bytes());
    client::Instruction::new_with_bytes(program, &data, vec![])
}
