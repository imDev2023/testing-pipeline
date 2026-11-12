//! Trading the copy as a trader would: resolve the strategy's accounts in the current
//! state, take a quote with `pipeline-quoter` holding only what an integrator holds, then
//! swap through the [`SwapPath`] and commit it. A sale only ever sells what a buy in the
//! same run produced.

use borsh::BorshDeserialize;
use litesvm::LiteSVM;
use pipeline_check::{hooks, write_token_account};
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use pipeline_quoter::{QuoteRequest, Quoter};
use pipeline_strategy_interface::{self as psi, discriminator, fees, TradeMode};
use serde::Serialize;
use solana_clock::Clock;
use solana_transaction::Transaction;

use crate::config::QUOTE_COMPUTE_LIMIT;
use crate::failure::{Failure, FailureClass, Stage};
use crate::market::{fund_lamports, program_elf, token_amount, Market, Session};
use crate::swap::{compute_limit, SwapPath, SwapReceipt, SwapRequest};

/// A quote in the trader's terms, as `pipeline-quoter` gives it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Quote {
    pub amount_in: u64,
    pub net_sent: u64,
    pub pipeline_fee: u64,
    pub total_spend: u64,
    pub amount_out: u64,
    /// What the strategy sends before any Token-2022 transfer fee on the output.
    pub strategy_amount_out: u64,
    pub compute_units: u64,
}

/// Where the clock stood for a trade.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ClockPosition {
    pub slot: u64,
    pub epoch: u64,
    pub unix_timestamp: i64,
}

/// One swap a trader sent, with the quote taken in the same state just before it.
#[derive(Clone, Debug, Serialize)]
pub struct Leg {
    pub input: usize,
    pub output: usize,
    pub amount_in: u64,
    pub clock: ClockPosition,
    pub quote: Result<Quote, Failure>,
    pub swap: Result<SwapReceipt, Failure>,
}

/// How a swap differs from its quote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Disagreement {
    /// Both worked and some figure differs.
    Figures { fields: Vec<&'static str> },
    /// The quote worked and the swap failed.
    QuotedSwapFailed,
    /// The swap worked although its quote failed.
    SwapWithoutQuote,
}

impl Leg {
    /// Whether the quote and the swap both worked, so their figures can be compared.
    pub fn compared(&self) -> bool {
        self.quote.is_ok() && self.swap.is_ok()
    }

    /// How the swap differs from its quote, if it does. A failed quote followed by a
    /// failed swap agrees.
    pub fn disagreement(&self) -> Option<Disagreement> {
        match (&self.quote, &self.swap) {
            (Ok(q), Ok(r)) => {
                let mut fields = vec![];
                if q.amount_out != r.received || q.amount_out != r.trader_received {
                    fields.push("output received");
                }
                if q.net_sent != r.net_sent {
                    fields.push("input sent");
                }
                if q.pipeline_fee != r.pipeline_fee {
                    fields.push("Pipeline fee");
                }
                if q.total_spend != r.trader_spent {
                    fields.push("the trader's input balance");
                }
                (!fields.is_empty()).then_some(Disagreement::Figures { fields })
            }
            (Ok(_), Err(_)) => Some(Disagreement::QuotedSwapFailed),
            (Err(_), Ok(_)) => Some(Disagreement::SwapWithoutQuote),
            (Err(_), Err(_)) => None,
        }
    }

    /// Every failure in the leg.
    pub fn failures(&self) -> impl Iterator<Item = &Failure> {
        self.quote
            .as_ref()
            .err()
            .into_iter()
            .chain(self.swap.as_ref().err())
    }
}

fn clock_position(svm: &LiteSVM) -> ClockPosition {
    let clock: Clock = svm.get_sysvar();
    ClockPosition {
        slot: clock.slot,
        epoch: clock.epoch,
        unix_timestamp: clock.unix_timestamp,
    }
}

/// The fixed accounts of a read-only trade call.
fn read_accounts(
    market: &Market,
    input: usize,
    output: usize,
    trader: &Pubkey,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(market.address, false),
        AccountMeta::new_readonly(market.record.market_state, false),
        AccountMeta::new_readonly(*trader, false),
        AccountMeta::new_readonly(market.ata(trader, input), false),
        AccountMeta::new_readonly(market.ata(trader, output), false),
        AccountMeta::new_readonly(market.vault(input), false),
        AccountMeta::new_readonly(market.mint(input), false),
        AccountMeta::new_readonly(market.mint(output), false),
        AccountMeta::new_readonly(market.token_program(input), false),
        AccountMeta::new_readonly(market.token_program(output), false),
    ]
}

/// Simulates one read-only strategy call and returns its return data and compute units.
fn simulate(
    svm: &LiteSVM,
    market: &Market,
    payer: &Pubkey,
    stage: Stage,
    ix: Instruction,
) -> Result<(Vec<u8>, u64), Failure> {
    let strategy = market.strategy();
    let mut tx =
        Transaction::new_with_payer(&[compute_limit(QUOTE_COMPUTE_LIMIT), ix], Some(payer));
    tx.message.recent_blockhash = svm.latest_blockhash();
    let info = svm
        .simulate_transaction(tx)
        .map_err(|failed| Failure::from_transaction(stage, &strategy, &failed))?;
    if info.meta.return_data.program_id != strategy {
        return Err(Failure::plain(
            stage,
            FailureClass::StrategyRefused,
            &strategy,
            "no return data",
        ));
    }
    Ok((info.meta.return_data.data, info.meta.compute_units_consumed))
}

fn trade_request(
    input: usize,
    output: usize,
    amount: u64,
    trader: Option<Pubkey>,
    extra: &[u8],
) -> psi::TradeRequest {
    psi::TradeRequest {
        mode: TradeMode::ExactIn,
        input_index: input as u8,
        output_index: output as u8,
        amount,
        trader: trader.map(|t| t.to_bytes()),
        extra: extra.to_vec(),
    }
}

impl Session<'_> {
    /// Calls the strategy's `pipeline_market_info` with the market state.
    pub fn market_info(&self, svm: &LiteSVM) -> Result<psi::MarketInfo, Failure> {
        let ix = Instruction::new_with_bytes(
            self.market.strategy(),
            &discriminator::MARKET_INFO,
            vec![AccountMeta::new_readonly(
                self.market.record.market_state,
                false,
            )],
        );
        let (data, _) = simulate(svm, &self.market, &self.payer, Stage::MarketInfo, ix)?;
        psi::MarketInfo::try_from_slice(&data).map_err(|_| {
            Failure::plain(
                Stage::MarketInfo,
                FailureClass::StrategyRefused,
                &self.market.strategy(),
                "malformed MarketInfo return data",
            )
        })
    }

    /// Runs `pipeline_resolve_accounts` in `svm`'s current state, loading every account it
    /// lists before the next round.
    pub fn resolve(
        &mut self,
        svm: &mut LiteSVM,
        request: &psi::TradeRequest,
    ) -> Result<Vec<AccountMeta>, Failure> {
        let trader = request
            .trader
            .map(Pubkey::new_from_array)
            .unwrap_or_default();
        let fixed = read_accounts(
            &self.market,
            request.input_index as usize,
            request.output_index as usize,
            &trader,
        );
        let mut known: Vec<AccountMeta> = vec![];
        for round in 0..psi::MAX_RESOLVE_ROUNDS {
            let mut accounts = fixed.clone();
            accounts.extend(
                known
                    .iter()
                    .map(|m| AccountMeta::new_readonly(m.pubkey, false)),
            );
            let data = psi::instruction_data(
                discriminator::RESOLVE_ACCOUNTS,
                &psi::ResolveRequest {
                    trade: request.clone(),
                    round,
                },
            );
            let ix = Instruction::new_with_bytes(self.market.strategy(), &data, accounts);
            let (out, _) = simulate(svm, &self.market, &self.payer, Stage::ResolveAccounts, ix)?;
            let result = psi::ResolveResult::try_from_slice(&out).map_err(|_| {
                Failure::plain(
                    Stage::ResolveAccounts,
                    FailureClass::StrategyRefused,
                    &self.market.strategy(),
                    "malformed ResolveResult return data",
                )
            })?;
            known = result
                .accounts
                .iter()
                .map(|a| {
                    let key = Pubkey::new_from_array(a.address);
                    if a.writable {
                        AccountMeta::new(key, false)
                    } else {
                        AccountMeta::new_readonly(key, false)
                    }
                })
                .collect();
            let keys: Vec<Pubkey> = known.iter().map(|m| m.pubkey).collect();
            self.load(svm, &keys);
            if result.complete {
                return Ok(known);
            }
        }
        Err(Failure::plain(
            Stage::ResolveAccounts,
            FailureClass::StrategyRefused,
            &self.market.strategy(),
            format!(
                "account resolution was not complete after {} rounds",
                psi::MAX_RESOLVE_ROUNDS
            ),
        ))
    }

    /// A quote from a fresh `pipeline-quoter` holding only what an integrator holds: the
    /// strategy, the market, the router config, the market state, mints and vaults and the
    /// resolved accounts, as they stand in `svm`. When it fails, the strategy's own quote is
    /// run in `svm` to name the failure from the full logs.
    pub fn quote(
        &self,
        svm: &LiteSVM,
        request: &psi::TradeRequest,
        resolved: &[AccountMeta],
    ) -> Result<Quote, Failure> {
        let market = &self.market;
        let quoted = (|| {
            let mut quoter = Quoter::new();
            quoter.set_compute_limit(QUOTE_COMPUTE_LIMIT);
            let clock: Clock = svm.get_sysvar();
            quoter.set_clock(clock.slot, clock.epoch, clock.unix_timestamp);
            let mut keys = vec![
                market.strategy(),
                market.address,
                pipeline_client::pda::config(),
                market.record.market_state,
            ];
            keys.extend(market.view.mints.iter());
            keys.extend(market.view.vaults.iter());
            keys.extend(resolved.iter().map(|m| m.pubkey));
            // An integrator quoting for a trader also knows the trader's own token accounts,
            // which the strategy is given and may read.
            if let Some(trader) = request.trader.map(Pubkey::new_from_array) {
                keys.push(market.ata(&trader, request.input_index as usize));
                keys.push(market.ata(&trader, request.output_index as usize));
            }
            for key in keys {
                let Some(account) = svm.get_account(&key) else {
                    continue;
                };
                if account.executable {
                    if let Some(elf) = program_elf(svm, &key) {
                        quoter.load_program(key, &elf).map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                quoter
                    .set_account(key, account)
                    .map_err(|e| e.to_string())?;
            }
            quoter
                .quote(
                    &market.view,
                    &QuoteRequest {
                        input_mint: market.mint(request.input_index as usize),
                        output_mint: market.mint(request.output_index as usize),
                        mode: TradeMode::ExactIn,
                        amount: request.amount,
                        trader: request.trader.map(Pubkey::new_from_array),
                        integrator_fee_bps: 0,
                        extra: request.extra.clone(),
                    },
                    resolved,
                )
                .map_err(|e| e.to_string())
        })();
        match quoted {
            Ok(q) => Ok(Quote {
                amount_in: q.amount_in,
                net_sent: q.net_sent,
                pipeline_fee: q.pipeline_fee,
                total_spend: q.total_spend,
                amount_out: q.amount_out,
                strategy_amount_out: q.strategy_amount_out,
                compute_units: q.compute_units,
            }),
            Err(error) => Err(self.quote_failure(svm, request, resolved, error)),
        }
    }

    fn quote_failure(
        &self,
        svm: &LiteSVM,
        request: &psi::TradeRequest,
        resolved: &[AccountMeta],
        quoter_error: String,
    ) -> Failure {
        let trader = request
            .trader
            .map(Pubkey::new_from_array)
            .unwrap_or_default();
        let mut accounts = read_accounts(
            &self.market,
            request.input_index as usize,
            request.output_index as usize,
            &trader,
        );
        accounts.extend(
            resolved
                .iter()
                .map(|m| AccountMeta::new_readonly(m.pubkey, false)),
        );
        let data = psi::instruction_data(discriminator::QUOTE, request);
        let ix = Instruction::new_with_bytes(self.market.strategy(), &data, accounts);
        match simulate(svm, &self.market, &self.payer, Stage::Quote, ix) {
            Err(failure) => failure,
            Ok(_) => Failure::plain(
                Stage::Quote,
                FailureClass::StrategyRefused,
                &self.market.strategy(),
                quoter_error,
            ),
        }
    }

    /// Resolves and quotes a trade without sending it.
    pub fn probe(
        &mut self,
        svm: &mut LiteSVM,
        input: usize,
        output: usize,
        amount: u64,
    ) -> Result<Quote, Failure> {
        let request = trade_request(input, output, amount, None, &self.extra.clone());
        let resolved = self.resolve(svm, &request)?;
        self.quote(svm, &request, &resolved)
    }

    /// One swap by `trader`: resolve, quote, then swap and commit, whatever the quote said.
    pub fn leg(
        &mut self,
        svm: &mut LiteSVM,
        path: &dyn SwapPath,
        trader: &Pubkey,
        input: usize,
        output: usize,
        amount_in: u64,
    ) -> Leg {
        let extra = self.extra.clone();
        let request = trade_request(input, output, amount_in, Some(*trader), &extra);
        let clock = clock_position(svm);
        let resolved = match self.resolve(svm, &request) {
            Ok(resolved) => resolved,
            Err(failure) => {
                return Leg {
                    input,
                    output,
                    amount_in,
                    clock,
                    quote: Err(failure.clone()),
                    swap: Err(failure),
                }
            }
        };
        let quote = self.quote(svm, &request, &resolved);
        let swap = path.swap(
            svm,
            &self.market,
            &SwapRequest {
                trader: *trader,
                input,
                output,
                amount_in,
                strategy_accounts: &resolved,
                extra: &extra,
                expected_output: quote.as_ref().map_or(0, |q| q.strategy_amount_out),
            },
        );
        Leg {
            input,
            output,
            amount_in,
            clock,
            quote,
            swap,
        }
    }

    /// Buys `amount` of `token` with `money` from the run's wallet for that size, on a fresh
    /// copy, then sells everything bought in the same slot.
    pub fn round_trip(
        &mut self,
        path: &dyn SwapPath,
        money: usize,
        token: usize,
        amount: u64,
    ) -> RoundTrip {
        let mut svm = self.fresh();
        let trader = self.seed.wallet(
            &self.market.address,
            &format!("round trip {money} to {token}, {amount}"),
        );
        self.round_trip_in(&mut svm, path, &trader, money, token, amount)
    }

    /// Funds `trader` in `svm`, buys `amount` of `token` with `money`, then sells everything
    /// bought in the same slot.
    pub fn round_trip_in(
        &mut self,
        svm: &mut LiteSVM,
        path: &dyn SwapPath,
        trader: &Pubkey,
        money: usize,
        token: usize,
        amount: u64,
    ) -> RoundTrip {
        self.fund(svm, trader, money, token, amount);
        let buy = self.leg(svm, path, trader, money, token, amount);
        let sell = self.sell_all(svm, path, &buy, trader, token, money);
        RoundTrip {
            amount,
            wallet: *trader,
            buy,
            sell,
        }
    }

    /// Gives `trader` SOL for fees, enough of the money mint to buy `amount` with Pipeline's
    /// fee on top, and an empty account of `token`, replacing whatever it held of either.
    pub fn fund(
        &mut self,
        svm: &mut LiteSVM,
        trader: &Pubkey,
        money: usize,
        token: usize,
        amount: u64,
    ) {
        fund_lamports(svm, trader);
        let budget = fees::max_total_spend(amount, 0).unwrap_or(u64::MAX);
        let funded = write_token_account(
            svm,
            &self.market.mint(money),
            &self.market.token_program(money),
            trader,
            budget,
        )
        .and_then(|_| {
            write_token_account(
                svm,
                &self.market.mint(token),
                &self.market.token_program(token),
                trader,
                0,
            )
        });
        if let Err(error) = funded {
            self.notes
                .push(format!("could not fund a trader for {amount}: {error}"));
        }
    }

    /// Gives `owner` SOL for fees and an empty account of mint `i`, leaving its other token
    /// accounts as they are.
    pub fn open_wallet(&mut self, svm: &mut LiteSVM, owner: &Pubkey, i: usize) {
        fund_lamports(svm, owner);
        if let Err(error) = write_token_account(
            svm,
            &self.market.mint(i),
            &self.market.token_program(i),
            owner,
            0,
        ) {
            self.notes.push(format!(
                "could not open a wallet's account of mint {i}: {error}"
            ));
        }
    }

    /// Sells everything `trader` holds of `token` for `money`, when `buy` delivered something;
    /// `None` when there is nothing to sell.
    pub fn sell_all(
        &mut self,
        svm: &mut LiteSVM,
        path: &dyn SwapPath,
        buy: &Leg,
        trader: &Pubkey,
        token: usize,
        money: usize,
    ) -> Option<Leg> {
        let held = token_amount(svm, &self.market.ata(trader, token)).unwrap_or(0);
        let sell_amount = fees::amount_for_budget(held, 0);
        match &buy.swap {
            Ok(receipt) if receipt.trader_received > 0 && sell_amount > 0 => {
                Some(self.leg(svm, path, trader, token, money, sell_amount))
            }
            _ => None,
        }
    }

    /// Sends `amount` of mint `token` from `from`'s token account to `to`'s, as one wallet
    /// sends a token to another, with the mint's transfer-hook accounts resolved; `to`'s
    /// account is created empty first. Returns what arrived.
    pub fn transfer(
        &mut self,
        svm: &mut LiteSVM,
        token: usize,
        from: &Pubkey,
        to: &Pubkey,
        amount: u64,
    ) -> Result<u64, Failure> {
        let mint = self.market.mints[token].clone();
        let (source, destination) = (self.market.ata(from, token), self.market.ata(to, token));
        if let Err(error) = write_token_account(svm, &mint.address, &mint.token_program, to, 0) {
            self.notes.push(format!(
                "could not open the receiving wallet's account: {error}"
            ));
        }
        let mut accounts = vec![
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(mint.address, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(*from, true),
        ];
        if let Some(hook) = mint.transfer_hook {
            let transfer = hooks::Transfer {
                source,
                mint: mint.address,
                destination,
                authority: *from,
                amount,
            };
            // Unresolvable hook accounts are left out; the transfer then fails and says why.
            accounts.extend(
                hooks::resolve(&hook, &transfer, |key| svm.get_account(key).map(|a| a.data))
                    .unwrap_or_default(),
            );
        }
        let mut data = vec![TRANSFER_CHECKED];
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(mint.decimals);
        let ix = Instruction::new_with_bytes(mint.token_program, &data, accounts);
        let before = token_amount(svm, &destination).unwrap_or(0);
        fund_lamports(svm, from);
        let mut tx = Transaction::new_with_payer(&[ix], Some(from));
        tx.message.recent_blockhash = svm.latest_blockhash();
        svm.send_transaction(tx).map_err(|failed| {
            Failure::from_transaction(Stage::Transfer, &self.market.strategy(), &failed)
        })?;
        Ok(token_amount(svm, &destination)
            .unwrap_or(0)
            .saturating_sub(before))
    }
}

/// The token programs' `TransferChecked` instruction.
const TRANSFER_CHECKED: u8 = 12;

/// A buy and the sale of everything it bought.
#[derive(Clone, Debug, Serialize)]
pub struct RoundTrip {
    pub amount: u64,
    /// The wallet that bought and sold.
    #[serde(serialize_with = "address")]
    pub wallet: Pubkey,
    pub buy: Leg,
    /// `None` when the buy failed or bought nothing that could be sold.
    pub sell: Option<Leg>,
}

impl RoundTrip {
    /// What left the trader's wallet on the buy, Pipeline's fee included.
    pub fn put_in(&self) -> Option<u64> {
        self.buy.swap.as_ref().ok().map(|r| r.trader_spent)
    }

    /// Whether the buy delivered something to sell.
    pub fn bought(&self) -> bool {
        self.sell.is_some()
    }

    /// The sale's receipt, when the tokens sold back.
    pub fn sold(&self) -> Option<&SwapReceipt> {
        self.sell.as_ref().and_then(|leg| leg.swap.as_ref().ok())
    }

    /// The sale's failure, when the buy worked and the sale did not.
    pub fn sale_failure(&self) -> Option<&Failure> {
        self.sell.as_ref().and_then(|leg| leg.swap.as_ref().err())
    }

    /// What came back, in parts per million of what was put in, rounded down.
    pub fn return_ppm(&self) -> Option<u64> {
        let put_in = self.put_in()?;
        let back = self.sold()?.trader_received;
        (put_in > 0).then(|| ((back as u128 * crate::config::PPM as u128) / put_in as u128) as u64)
    }

    pub fn legs(&self) -> impl Iterator<Item = &Leg> {
        std::iter::once(&self.buy).chain(self.sell.as_ref())
    }
}

/// Serializes an address as its base58 text.
fn address<S: serde::Serializer>(key: &Pubkey, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&key.to_string())
}
