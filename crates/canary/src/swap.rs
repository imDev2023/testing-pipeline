//! The one swap function every trade in the checks goes through, behind the licence seam
//! (`CANARY-26`; `docs/spec/pipescope-architecture.md`, "Canary runner").
//!
//! [`ThroughRouter`] executes the router's own deployed bytes, as on devnet. The router is
//! BSL 1.1 until 2028-11-08, so [`DirectToStrategy`] can replace it without touching any
//! check: it does what a router swap does, step by step, from Pipeline's published strategy
//! interface and its Apache-2.0 settlement code, never the router's. Which one a run uses is
//! chosen in one place, [`crate::config::SWAP_PATH`]. `conformance` runs the router inside
//! `pipeline-check` itself, so it is "not run" on a path that does not.

use borsh::BorshDeserialize;
use litesvm::LiteSVM;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey, TradeMode};
use pipeline_strategy_interface::settlement::{self, SettleError};
use pipeline_strategy_interface::{self as psi, discriminator};
use serde::Serialize;
use solana_account::ReadableAccount;
use solana_transaction::Transaction;

use crate::config::SWAP_COMPUTE_LIMIT;
use crate::failure::{Failure, FailureClass, Stage};
use crate::hooks::HookAccounts;
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
    /// The trade's transfer-hook accounts.
    pub hooks: &'a HookAccounts,
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
            strategy_accounts: strategy_accounts(request),
            input_hook_accounts: request.hooks.input.clone(),
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
            strategy_compute_units: strategy_units(&meta.logs, &strategy_line),
        })
    }
}

/// Swaps without the router: Canary itself does what the router's `swap` does, in the same
/// order, as Pipeline's strategy interface and its Apache-2.0 settlement code define it.
///
/// 1. The router's own refusals that a trade can meet: a paused router, and a trader
///    account that is not a token account of its mint.
/// 2. In one transaction, the trader's transfer of `amount_in` into the input vault (with
///    the input mint's hook accounts), then the strategy's `pipeline_swap`, its fixed
///    accounts as the router passes them and the market PDA marked as signing (signature
///    checks are off in the copy), followed by the strategy's accounts and the input
///    mint's hook accounts, none signing.
/// 3. `settlement::settle` on the balances the router measures; a refusal undoes the
///    whole swap, as the router's would.
/// 4. Pipeline's fee from the trader's input account to the market's fee account for that
///    mint, in the same transaction as the swap, so a refused fee transfer undoes it too.
///
/// The strategy runs one call level higher than under the router, so a strategy that
/// depends on its call depth can behave differently; nothing else differs.
pub struct DirectToStrategy;

/// Why the router's own rules refuse a swap, in the words of Pipeline's settlement code.
fn settle_words(error: SettleError) -> &'static str {
    match error {
        SettleError::InsufficientOutput => {
            "InsufficientOutput: less than the minimum output arrived"
        }
        SettleError::SpendLimitExceeded => {
            "SpendLimitExceeded: the trader lost more than the amount in before fees"
        }
        SettleError::OutputWithoutInput => {
            "OutputWithoutInput: output arrived but the market kept no input"
        }
        SettleError::NothingSwapped => "NothingSwapped: nothing was sent and nothing received",
        SettleError::MathOverflow => "MathOverflow: the integrator fee does not fit",
    }
}

fn router_refused(words: impl Into<String>) -> Failure {
    Failure::plain(
        Stage::Swap,
        FailureClass::RouterRefused,
        &client::PROGRAM_ID,
        words,
    )
}

/// A token account's balance, refused as the router refuses an account that is not a
/// token account of `mint` under `token_program`.
fn checked_balance(
    svm: &LiteSVM,
    account: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Result<u64, Failure> {
    let data = svm
        .get_account(account)
        .filter(|a| a.owner == *token_program)
        .map(|a| a.data)
        .filter(|d| d.get(..32) == Some(mint.as_ref()));
    match data {
        Some(_) => Ok(token_amount(svm, account).unwrap_or(0)),
        None => Err(router_refused(format!(
            "InvalidTokenAccount: {account} is not a token account of mint {mint}"
        ))),
    }
}

/// The token program's `transfer_checked`, with a hook's accounts after its own.
fn transfer_checked(
    market: &Market,
    mint: usize,
    from: &Pubkey,
    to: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    hooks: &[AccountMeta],
) -> Instruction {
    let mut ix = spl_token_2022_interface::instruction::transfer_checked(
        &market.token_program(mint),
        from,
        &market.mint(mint),
        to,
        authority,
        &[],
        amount,
        market.mints[mint].decimals,
    )
    .expect("both token programs take transfer_checked");
    ix.accounts.extend(hooks.iter().cloned());
    ix
}

impl SwapPath for DirectToStrategy {
    fn runs_router(&self) -> bool {
        false
    }

    fn swap(
        &self,
        svm: &mut LiteSVM,
        market: &Market,
        request: &SwapRequest,
    ) -> Result<SwapReceipt, Failure> {
        let (input, output, trader) = (request.input, request.output, request.trader);
        let paused = svm
            .get_account(&pda::config())
            .and_then(|a| client::decode_config(&a.data))
            .is_some_and(|config| config.paused);
        if paused {
            return Err(router_refused("Paused: the router is paused"));
        }
        let trader_input = market.ata(&trader, input);
        let trader_output = market.ata(&trader, output);
        let vault = market.vault(input);
        let balances = |svm: &LiteSVM| -> Result<[u64; 3], Failure> {
            Ok([
                checked_balance(svm, &trader_input, &market.mint(input), &market.token_program(input))?,
                checked_balance(svm, &trader_output, &market.mint(output), &market.token_program(output))?,
                checked_balance(svm, &vault, &market.mint(input), &market.token_program(input))?,
            ])
        };
        let [input_before, output_before, vault_before] = balances(svm)?;

        let instructions = direct_swap(
            market,
            request,
            AccountMeta::new_readonly(market.address, true),
        );
        let transaction = |instructions: &[Instruction], svm: &LiteSVM| {
            let mut tx = Transaction::new_with_payer(instructions, Some(&trader));
            tx.message.recent_blockhash = svm.latest_blockhash();
            tx
        };
        let fail = |failed: &litesvm::types::FailedTransactionMetadata| {
            Failure::from_transaction(Stage::Swap, &market.strategy(), failed)
        };

        // The swap as the router would measure it, before anything is committed.
        let simulated = svm
            .simulate_transaction(transaction(&instructions, svm))
            .map_err(|failed| fail(&failed))?;
        let mut after = svm.clone();
        for (key, account) in &simulated.post_accounts {
            if account.owner() == &market.token_program(input) || account.owner() == &market.token_program(output) {
                let _ = after.set_account(*key, account.clone().into());
            }
        }
        let [input_after, output_after, vault_after] = balances(&after)?;
        let settled = settlement::settle(
            &settlement::Measured {
                input_before,
                input_after,
                output_before,
                output_after,
                vault_before,
                vault_after,
            },
            request.amount_in,
            0,
            0,
        )
        .map_err(|e| router_refused(settle_words(e)))?;

        let mut instructions = instructions;
        if settled.pipeline_fee > 0 {
            let fee_account = pda::fee_account(&market.address, &market.mint(input), &market.token_program(input));
            instructions.push(transfer_checked(
                market,
                input,
                &trader_input,
                &fee_account,
                &trader,
                settled.pipeline_fee,
                &request.hooks.input,
            ));
        }
        let meta = svm
            .send_transaction(transaction(&instructions, svm))
            .map_err(|failed| fail(&failed))?;
        let strategy_line = format!("Program {} consumed ", market.strategy());
        Ok(SwapReceipt {
            trader_spent: input_before.saturating_sub(token_amount(svm, &trader_input).unwrap_or(0)),
            trader_received: token_amount(svm, &trader_output)
                .unwrap_or(0)
                .saturating_sub(output_before),
            net_sent: settled.net_sent,
            received: settled.received,
            pipeline_fee: settled.pipeline_fee,
            compute_units: meta.compute_units_consumed,
            strategy_compute_units: strategy_units(&meta.logs, &strategy_line),
        })
    }
}

/// The input's transfer into the vault and the strategy's `pipeline_swap` after it, as one
/// transaction's instructions, with `market_signer` as the call's first account: the market
/// PDA signing, as the router passes it, or anything else `direct_call` tries.
pub fn direct_swap(
    market: &Market,
    request: &SwapRequest,
    market_signer: AccountMeta,
) -> Vec<Instruction> {
    let (input, output, trader) = (request.input, request.output, request.trader);
    let swap_request = psi::SwapRequest {
        trade: psi::TradeRequest {
            mode: TradeMode::ExactIn,
            input_index: input as u8,
            output_index: output as u8,
            amount: request.amount_in,
            trader: Some(trader.to_bytes()),
            extra: request.extra.to_vec(),
        },
        amount_sent: request.amount_in,
        min_amount_out: 0,
    };
    let mut accounts = strategy_call_accounts(market, &trader, input, output);
    accounts[psi::trade_accounts::MARKET_SIGNER] = market_signer;
    accounts.extend(
        strategy_accounts(request)
            .into_iter()
            .chain(request.hooks.input.iter().cloned())
            .map(|m| AccountMeta {
                is_signer: false,
                ..m
            }),
    );
    vec![
        compute_limit(SWAP_COMPUTE_LIMIT),
        transfer_checked(
            market,
            input,
            &market.ata(&trader, input),
            &market.vault(input),
            &trader,
            request.amount_in,
            &request.hooks.input,
        ),
        Instruction::new_with_bytes(
            market.strategy(),
            &psi::instruction_data(discriminator::SWAP, &swap_request),
            accounts,
        ),
    ]
}

/// The fixed accounts of `pipeline_swap` as the router passes them
/// (`pipeline_strategy_interface::trade_accounts`): the market PDA signing, then the market
/// state, the trader (never signing), the trader's two accounts, the input vault, both
/// mints and both token programs.
fn strategy_call_accounts(
    market: &Market,
    trader: &Pubkey,
    input: usize,
    output: usize,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(market.address, true),
        AccountMeta::new(market.record.market_state, false),
        AccountMeta::new_readonly(*trader, false),
        AccountMeta::new(market.ata(trader, input), false),
        AccountMeta::new(market.ata(trader, output), false),
        AccountMeta::new(market.vault(input), false),
        AccountMeta::new_readonly(market.mint(input), false),
        AccountMeta::new_readonly(market.mint(output), false),
        AccountMeta::new_readonly(market.token_program(input), false),
        AccountMeta::new_readonly(market.token_program(output), false),
    ]
}

/// The strategy's own compute units, from the line the runtime logs when it returns.
fn strategy_units(logs: &[String], strategy_line: &str) -> Option<u64> {
    logs.iter()
        .find_map(|line| line.strip_prefix(strategy_line))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse().ok())
}

/// The accounts the strategy's own `pipeline_swap` reads after the fixed ones: those
/// `pipeline_resolve_accounts` listed, then the output mint's hook accounts, which its
/// transfer out of the vault needs.
pub fn strategy_accounts(request: &SwapRequest) -> Vec<AccountMeta> {
    let mut accounts = request.strategy_accounts.to_vec();
    accounts.extend(request.hooks.output.iter().cloned());
    accounts
}

/// The compute budget program's "set compute unit limit".
pub fn compute_limit(units: u32) -> client::Instruction {
    const SET_COMPUTE_UNIT_LIMIT: u8 = 2;
    let program: Pubkey = client::pubkey!("ComputeBudget111111111111111111111111111111");
    let mut data = vec![SET_COMPUTE_UNIT_LIMIT];
    data.extend_from_slice(&units.to_le_bytes());
    client::Instruction::new_with_bytes(program, &data, vec![])
}
