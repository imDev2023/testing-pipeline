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
/// 1. The router's own refusal that a trade can meet before anything moves: a trader
///    account that is not a token account of its mint (the router has had no pause since
///    Pipeline 0.2.0).
/// 2. The trader's transfer of `amount_in` into the input vault, with the input mint's hook
///    accounts, signed by the trader.
/// 3. The strategy's `pipeline_swap` in a transaction the trader does not sign, its fixed
///    accounts as the router passes them and the market PDA marked as signing (signature
///    checks are off in the copy), followed by the strategy's accounts and the input mint's
///    hook accounts, none signing ([`call_directly`]).
/// 4. The router's refusal of a swap that lowered the trader's output balance, then
///    `settlement::settle` on the balances the router measures.
/// 5. Pipeline's fee from the trader's input account to the market's fee account for that
///    mint.
///
/// Any refusal puts the copy back as it was, as the router's refusal undoes its whole
/// transaction. The strategy runs one call level higher than under the router, and in a
/// transaction of its own, so a strategy that depends on its call depth or reads the
/// Instructions sysvar can behave differently; nothing else differs.
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
/// token account of `mint` under `token_program`. `read` gives the account as it stands.
fn checked_balance(
    read: &dyn Fn(&Pubkey) -> Option<solana_account::Account>,
    account: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Result<u64, Failure> {
    const AMOUNT: std::ops::Range<usize> = 64..72;
    read(account)
        .filter(|a| a.owner == *token_program && a.data.get(..32) == Some(mint.as_ref()))
        .and_then(|a| {
            a.data
                .get(AMOUNT)
                .map(|b| u64::from_le_bytes(b.try_into().expect("8 bytes")))
        })
        .ok_or_else(|| {
            router_refused(format!(
                "InvalidTokenAccount: {account} is not a token account of mint {mint}"
            ))
        })
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
        let trader_input = market.ata(&trader, input);
        let trader_output = market.ata(&trader, output);
        let vault = market.vault(input);
        let balances = |svm: &LiteSVM| -> Result<[u64; 3], Failure> {
            let read = |key: &Pubkey| svm.get_account(key);
            Ok([
                checked_balance(
                    &read,
                    &trader_input,
                    &market.mint(input),
                    &market.token_program(input),
                )?,
                checked_balance(
                    &read,
                    &trader_output,
                    &market.mint(output),
                    &market.token_program(output),
                )?,
                checked_balance(
                    &read,
                    &vault,
                    &market.mint(input),
                    &market.token_program(input),
                )?,
            ])
        };
        let [input_before, output_before, vault_before] = balances(svm)?;

        // Every step commits; a refusal at any of them puts the copy back, as the router's
        // refusal undoes its whole transaction.
        let before = svm.clone();
        let undo = |svm: &mut LiteSVM, failure: Failure| {
            *svm = before.clone();
            Err(failure)
        };
        let called = match call_directly(
            svm,
            market,
            request,
            AccountMeta::new_readonly(market.address, true),
        ) {
            Ok(called) => called,
            Err(failure) => return undo(svm, failure),
        };
        let [input_after, output_after, vault_after] = match balances(svm) {
            Ok(balances) => balances,
            Err(failure) => return undo(svm, failure),
        };
        // The router refuses any swap that leaves the trader with less of the output mint
        // than before, whatever its minimum (Pipeline 3fd85ce, `OutputDecreased`).
        if output_after < output_before {
            return undo(
                svm,
                router_refused("OutputDecreased: the trader's output balance fell during the swap"),
            );
        }
        let settled = match settlement::settle(
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
        ) {
            Ok(settled) => settled,
            Err(error) => return undo(svm, router_refused(settle_words(error))),
        };
        let mut compute_units = called.compute_units;
        if settled.pipeline_fee > 0 {
            let fee_account = pda::fee_account(
                &market.address,
                &market.mint(input),
                &market.token_program(input),
            );
            let fee = transfer_checked(
                market,
                input,
                &trader_input,
                &fee_account,
                &trader,
                settled.pipeline_fee,
                &request.hooks.input,
            );
            match send(svm, &[fee], &trader, &market.strategy()) {
                Ok(meta) => compute_units += meta.compute_units_consumed,
                Err(failure) => return undo(svm, failure),
            }
        }
        Ok(SwapReceipt {
            trader_spent: input_before
                .saturating_sub(token_amount(svm, &trader_input).unwrap_or(0)),
            trader_received: token_amount(svm, &trader_output)
                .unwrap_or(0)
                .saturating_sub(output_before),
            net_sent: settled.net_sent,
            received: settled.received,
            pipeline_fee: settled.pipeline_fee,
            compute_units,
            strategy_compute_units: called.strategy_compute_units,
        })
    }
}

/// Pays for the strategy's call in the direct path, so the trader, who signs only its own
/// transfer, is never a signer of the transaction the strategy runs in: in a transaction the
/// fee payer signs every instruction, and under the router the strategy never gets the
/// trader's signature.
const DIRECT_CALL_PAYER: Pubkey = Pubkey::new_from_array([0xca; 32]);

/// What a direct call to the strategy cost.
pub struct DirectCall {
    pub compute_units: u64,
    pub strategy_compute_units: Option<u64>,
}

fn send(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    payer: &Pubkey,
    strategy: &Pubkey,
) -> Result<litesvm::types::TransactionMetadata, Failure> {
    let mut all = vec![compute_limit(SWAP_COMPUTE_LIMIT)];
    all.extend_from_slice(instructions);
    let mut tx = Transaction::new_with_payer(&all, Some(payer));
    tx.message.recent_blockhash = svm.latest_blockhash();
    svm.send_transaction(tx)
        .map_err(|failed| Failure::from_transaction(Stage::Swap, strategy, &failed))
}

/// Sends the input into the vault as the router would, signed by the trader, then calls the
/// strategy's `pipeline_swap` in a transaction of its own with `market_signer` as its first
/// account: the market PDA signing, as the router passes it, or anything else `direct_call`
/// tries. Both commit; the caller undoes them if it must.
pub fn call_directly(
    svm: &mut LiteSVM,
    market: &Market,
    request: &SwapRequest,
    market_signer: AccountMeta,
) -> Result<DirectCall, Failure> {
    let (input, output, trader) = (request.input, request.output, request.trader);
    let strategy = market.strategy();
    let transferred = send(
        svm,
        &[transfer_checked(
            market,
            input,
            &market.ata(&trader, input),
            &market.vault(input),
            &trader,
            request.amount_in,
            &request.hooks.input,
        )],
        &trader,
        &strategy,
    )?;
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
    crate::market::fund_lamports(svm, &DIRECT_CALL_PAYER);
    let called = send(
        svm,
        &[Instruction::new_with_bytes(
            strategy,
            &psi::instruction_data(discriminator::SWAP, &swap_request),
            accounts,
        )],
        &DIRECT_CALL_PAYER,
        &strategy,
    )?;
    Ok(DirectCall {
        compute_units: transferred.compute_units_consumed + called.compute_units_consumed,
        strategy_compute_units: strategy_units(
            &called.logs,
            &format!("Program {strategy} consumed "),
        ),
    })
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
