//! What a trader, a terminal and our keeper runner send to a market, in a LiteSVM: account
//! resolution, quotes and swaps through the router, and the four keeper jobs, each built in
//! the account order `metadata.json` lists.

use borsh::BorshDeserialize;
use buy_wall_amm::state::MarketState;
use litesvm::LiteSVM;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey, TradeMode};
use pipeline_strategy_interface::{self as psi, discriminator};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_2022_interface::extension::{transfer_hook, StateWithExtensions};

use crate::snapshot::QuoteOutcome;

pub const SOL: u64 = 1_000_000_000;
pub const TOKEN: Pubkey = client::TOKEN_PROGRAM_ID;
pub const TOKEN_2022: Pubkey = client::TOKEN_2022_PROGRAM_ID;
pub const WSOL: Pubkey = client::wallet::NATIVE_MINT;
pub const ATA_PROGRAM: Pubkey = client::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// A market as the router records it, with what its trades and keeper jobs need.
#[derive(Clone, Debug)]
pub struct MarketView {
    pub market: Pubkey,
    pub market_state: Pubkey,
    pub mints: Vec<Pubkey>,
    pub vaults: Vec<Pubkey>,
    pub token_programs: Vec<Pubkey>,
    pub vault_authority: Pubkey,
}

impl MarketView {
    /// The index of the token and of wrapped SOL among the market's mints.
    pub fn sides(&self) -> Result<(usize, usize), String> {
        let sol = self
            .mints
            .iter()
            .position(|m| *m == WSOL)
            .ok_or("the market has no wrapped SOL side")?;
        if self.mints.len() != 2 {
            return Err(format!("the market has {} mints, not 2", self.mints.len()));
        }
        Ok((1 - sol, sol))
    }

    pub fn token_index(&self) -> usize {
        self.sides().map_or(0, |(token, _)| token)
    }

    pub fn sol_index(&self) -> usize {
        self.sides().map_or(1, |(_, sol)| sol)
    }
}

/// A LiteSVM, the program it trades and a wallet that pays for everything.
pub struct Session {
    pub svm: LiteSVM,
    pub program: Pubkey,
    pub payer: Keypair,
    /// The trader of the last swap, who holds what it bought.
    trader: Option<Keypair>,
}

impl Session {
    pub fn new(mut svm: LiteSVM, program: Pubkey) -> Self {
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000 * SOL)
            .expect("airdrop to the payer");
        Session {
            svm,
            program,
            payer,
            trader: None,
        }
    }

    /// Keeps `trader`, who now holds what its swap bought, for the next swap.
    pub fn keep_trader(&mut self, trader: Keypair) {
        self.trader = Some(trader);
    }

    /// The trader of the last swap.
    pub fn held_trader(&mut self) -> Option<Keypair> {
        self.trader.take()
    }

    /// Sends `instructions` paid for by the payer; the logs, or the error and the logs.
    pub fn send(
        &mut self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<(Vec<u8>, Vec<String>), String> {
        self.svm.expire_blockhash();
        let mut all = vec![&self.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(
            instructions,
            Some(&self.payer.pubkey()),
            &all,
            self.svm.latest_blockhash(),
        );
        self.svm
            .send_transaction(tx)
            .map(|meta| (meta.return_data.data, meta.logs))
            .map_err(|failed| failure(&failed.err, &failed.meta.logs))
    }

    /// Runs one instruction in simulation: its return data, or the error and the logs.
    pub fn simulate(&self, instruction: Instruction) -> Result<Vec<u8>, String> {
        let tx = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&self.payer.pubkey()),
            &[&self.payer],
            self.svm.latest_blockhash(),
        );
        self.svm
            .simulate_transaction(tx)
            .map(|info| info.meta.return_data.data)
            .map_err(|failed| failure(&failed.err, &failed.meta.logs))
    }

    /// The market whose market state is `market_state`, from the router's Market account.
    pub fn market(&self, market_state: &Pubkey) -> Result<MarketView, String> {
        let market = pda::market(&self.program, market_state);
        let record = self
            .svm
            .get_account(&market)
            .filter(|a| a.owner == client::PROGRAM_ID)
            .and_then(|a| client::decode_market(&a.data))
            .ok_or_else(|| format!("the router has no Market {market} for it"))?;
        let mints = record.mints().to_vec();
        let token_programs = mints
            .iter()
            .map(|mint| {
                self.svm
                    .get_account(mint)
                    .map(|a| a.owner)
                    .ok_or_else(|| format!("its mint {mint} is missing"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(MarketView {
            market,
            market_state: *market_state,
            vaults: record.vaults[..mints.len()].to_vec(),
            mints,
            token_programs,
            vault_authority: Pubkey::find_program_address(
                &[buy_wall_amm::state::AUTHORITY_SEED, market_state.as_ref()],
                &self.program,
            )
            .0,
        })
    }

    /// The market state read with layout version 1, the layout of this tree.
    pub fn state(&self, market_state: &Pubkey) -> Result<MarketState, String> {
        let data = self
            .svm
            .get_account(market_state)
            .ok_or_else(|| format!("the market state {market_state} is missing"))?
            .data;
        let body = data
            .get(8..)
            .filter(|body| body.len() == std::mem::size_of::<MarketState>())
            .ok_or_else(|| format!("the market state is {} bytes", data.len()))?;
        Ok(*bytemuck::from_bytes(body))
    }

    /// A token account's balance.
    pub fn balance(&self, account: &Pubkey) -> Option<u64> {
        let data = self.svm.get_account(account)?.data;
        Some(u64::from_le_bytes(data.get(64..72)?.try_into().ok()?))
    }

    /// The router's ten fixed trade accounts for a read-only call, with placeholders for
    /// the trader, as an integrator's quoter passes them.
    fn read_accounts(&self, view: &MarketView, input: usize, output: usize) -> Vec<AccountMeta> {
        let placeholder = client::SYSTEM_PROGRAM_ID;
        vec![
            AccountMeta::new_readonly(view.market, false),
            AccountMeta::new_readonly(view.market_state, false),
            AccountMeta::new_readonly(placeholder, false),
            AccountMeta::new_readonly(placeholder, false),
            AccountMeta::new_readonly(placeholder, false),
            AccountMeta::new_readonly(view.vaults[input], false),
            AccountMeta::new_readonly(view.mints[input], false),
            AccountMeta::new_readonly(view.mints[output], false),
            AccountMeta::new_readonly(view.token_programs[input], false),
            AccountMeta::new_readonly(view.token_programs[output], false),
        ]
    }

    /// `pipeline_resolve_accounts`, round after round until complete: the strategy accounts
    /// a trade of `amount` from mint `input` to mint `output` needs.
    pub fn resolve(
        &self,
        view: &MarketView,
        input: usize,
        output: usize,
        amount: u64,
    ) -> Result<Vec<AccountMeta>, String> {
        let trade = exact_in(input, output, amount);
        let mut known: Vec<AccountMeta> = vec![];
        for round in 0..psi::MAX_RESOLVE_ROUNDS {
            let mut accounts = self.read_accounts(view, input, output);
            accounts.extend(
                known
                    .iter()
                    .map(|m| AccountMeta::new_readonly(m.pubkey, false)),
            );
            let data = psi::instruction_data(
                discriminator::RESOLVE_ACCOUNTS,
                &psi::ResolveRequest {
                    trade: trade.clone(),
                    round,
                },
            );
            let output =
                self.simulate(Instruction::new_with_bytes(self.program, &data, accounts))?;
            let result = psi::ResolveResult::try_from_slice(&output)
                .map_err(|_| "malformed return data".to_string())?;
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
            if result.complete {
                return Ok(known);
            }
        }
        Err(format!(
            "not complete after {} rounds",
            psi::MAX_RESOLVE_ROUNDS
        ))
    }

    /// `pipeline_quote` for an exact-in trade, with the resolved accounts after the fixed
    /// ones, as an integrator's quoter runs it.
    pub fn quote(
        &self,
        view: &MarketView,
        input: usize,
        output: usize,
        amount: u64,
        resolved: &[AccountMeta],
    ) -> QuoteOutcome {
        let mut accounts = self.read_accounts(view, input, output);
        accounts.extend(
            resolved
                .iter()
                .map(|m| AccountMeta::new_readonly(m.pubkey, false)),
        );
        let data = psi::instruction_data(discriminator::QUOTE, &exact_in(input, output, amount));
        match self.simulate(Instruction::new_with_bytes(self.program, &data, accounts)) {
            Ok(output) => match psi::QuoteResult::try_from_slice(&output) {
                Ok(quote) => QuoteOutcome::AmountOut(quote.amount_out),
                Err(_) => QuoteOutcome::Refused("malformed return data".into()),
            },
            Err(error) => QuoteOutcome::Refused(first_line(&error)),
        }
    }

    /// A wallet holding `lamports` of wrapped SOL and an empty account for the token.
    pub fn trader(&mut self, view: &MarketView, lamports: u64) -> Result<Keypair, String> {
        let trader = Keypair::new();
        self.svm
            .airdrop(&trader.pubkey(), SOL)
            .map_err(|e| format!("{e:?}"))?;
        let token = view.token_index();
        pipeline_check::write_token_account(
            &mut self.svm,
            &view.mints[token],
            &view.token_programs[token],
            &trader.pubkey(),
            0,
        )?;
        pipeline_check::write_token_account(
            &mut self.svm,
            &WSOL,
            &TOKEN,
            &trader.pubkey(),
            lamports,
        )?;
        Ok(trader)
    }

    /// An exact-in swap through the router of `amount` of mint `input` by `trader`, from and
    /// to their associated token accounts, with the resolved strategy accounts and each
    /// side's transfer-hook accounts, refused below `min_amount_out`.
    #[allow(clippy::too_many_arguments)]
    pub fn swap(
        &mut self,
        view: &MarketView,
        trader: &Keypair,
        input: usize,
        output: usize,
        amount: u64,
        min_amount_out: u64,
        resolved: &[AccountMeta],
    ) -> Result<client::SwapResult, String> {
        let owner = trader.pubkey();
        let trader_input =
            pda::associated_token(&owner, &view.mints[input], &view.token_programs[input]);
        let trader_output =
            pda::associated_token(&owner, &view.mints[output], &view.token_programs[output]);
        let mut strategy_accounts = resolved.to_vec();
        strategy_accounts.extend(self.hook_accounts(
            &view.mints[output],
            view.vaults[output],
            trader_output,
            view.vault_authority,
        )?);
        let input_hook_accounts =
            self.hook_accounts(&view.mints[input], trader_input, view.vaults[input], owner)?;
        let accounts = client::SwapAccounts {
            trader: owner,
            strategy_program: self.program,
            market_state: view.market_state,
            trader_input,
            trader_output,
            input_vault: view.vaults[input],
            input_mint: view.mints[input],
            output_mint: view.mints[output],
            input_token_program: view.token_programs[input],
            output_token_program: view.token_programs[output],
            integrator_fee_account: None,
            strategy_accounts,
            input_hook_accounts,
        };
        let args = client::SwapArgs {
            mode: TradeMode::ExactIn,
            amount_in: amount,
            amount_out: 0,
            min_amount_out,
            integrator_fee_bps: 0,
            input_hook_accounts: 0,
            extra: vec![],
        };
        let (data, _) = self.send(&[client::swap(&accounts, &args)], &[trader])?;
        client::SwapResult::try_from_slice(&data).map_err(|e| e.to_string())
    }

    /// The transfer-hook accounts a transfer of `mint` needs, or none when it has no hook.
    pub fn hook_accounts(
        &self,
        mint: &Pubkey,
        source: Pubkey,
        destination: Pubkey,
        authority: Pubkey,
    ) -> Result<Vec<AccountMeta>, String> {
        let Some(hook_program) = self.hook_program(mint) else {
            return Ok(vec![]);
        };
        let transfer = pipeline_check::hooks::Transfer {
            source,
            mint: *mint,
            destination,
            authority,
            amount: 0,
        };
        pipeline_check::hooks::resolve(&hook_program, &transfer, |key| {
            self.svm.get_account(key).map(|account| account.data)
        })
        .map_err(|e| format!("the transfer hook's accounts: {e}"))
    }

    /// The transfer-hook program of a Token-2022 mint, if it has one.
    pub fn hook_program(&self, mint: &Pubkey) -> Option<Pubkey> {
        let account = self.svm.get_account(mint)?;
        if account.owner != TOKEN_2022 {
            return None;
        }
        let state =
            StateWithExtensions::<spl_token_2022_interface::state::Mint>::unpack(&account.data)
                .ok()?;
        transfer_hook::get_program_id(&state).map(|id| Pubkey::new_from_array(id.to_bytes()))
    }

    /// A keeper with an empty wrapped SOL account for its tips.
    pub fn keeper(&mut self) -> Result<Keypair, String> {
        let keeper = Keypair::new();
        self.svm
            .airdrop(&keeper.pubkey(), SOL)
            .map_err(|e| format!("{e:?}"))?;
        pipeline_check::write_token_account(&mut self.svm, &WSOL, &TOKEN, &keeper.pubkey(), 0)?;
        Ok(keeper)
    }
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

/// An anonymous exact-in trade request.
pub fn exact_in(input: usize, output: usize, amount: u64) -> psi::TradeRequest {
    psi::TradeRequest {
        mode: TradeMode::ExactIn,
        input_index: input as u8,
        output_index: output as u8,
        amount,
        trader: None,
        extra: vec![],
    }
}

/// `place_wall`, called by `caller`, tipping `tip_account`.
pub fn place_wall_ix(
    program: &Pubkey,
    view: &MarketView,
    caller: &Pubkey,
    tip_account: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        *program,
        &client::instruction_discriminator("place_wall"),
        vec![
            AccountMeta::new_readonly(*caller, true),
            AccountMeta::new(view.market_state, false),
            AccountMeta::new(view.vaults[view.sol_index()], false),
            AccountMeta::new(*tip_account, false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new_readonly(view.vault_authority, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
    )
}

/// `settle`: nobody signs it but the fee payer.
pub fn settle_ix(program: &Pubkey, view: &MarketView) -> Instruction {
    let token = view.token_index();
    Instruction::new_with_bytes(
        *program,
        &client::instruction_discriminator("settle"),
        vec![
            AccountMeta::new(view.market_state, false),
            AccountMeta::new(view.vaults[token], false),
            AccountMeta::new(view.mints[token], false),
            AccountMeta::new_readonly(view.vault_authority, false),
            AccountMeta::new_readonly(view.token_programs[token], false),
        ],
    )
}

/// `pay_rewards`, paid for by `payer`, to `recipient`'s associated token account for the
/// token, with `hook_accounts` after.
pub fn pay_rewards_ix(
    program: &Pubkey,
    view: &MarketView,
    payer: &Pubkey,
    recipient: &Pubkey,
    hook_accounts: Vec<AccountMeta>,
) -> Instruction {
    let token = view.token_index();
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new(view.market_state, false),
        AccountMeta::new(view.vaults[token], false),
        AccountMeta::new_readonly(view.mints[token], false),
        AccountMeta::new_readonly(*recipient, false),
        AccountMeta::new(
            pda::associated_token(recipient, &view.mints[token], &view.token_programs[token]),
            false,
        ),
        AccountMeta::new_readonly(view.vault_authority, false),
        AccountMeta::new_readonly(view.token_programs[token], false),
        AccountMeta::new_readonly(ATA_PROGRAM, false),
        AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
    ];
    accounts.extend(hook_accounts);
    Instruction::new_with_bytes(
        *program,
        &client::instruction_discriminator("pay_rewards"),
        accounts,
    )
}

/// `sweep_fees { slot }`, paid for by `payer`, to `recipient`'s associated wrapped SOL
/// account.
pub fn sweep_fees_ix(
    program: &Pubkey,
    view: &MarketView,
    payer: &Pubkey,
    recipient: &Pubkey,
    slot: u8,
) -> Instruction {
    let mut data = client::instruction_discriminator("sweep_fees").to_vec();
    data.push(slot);
    Instruction::new_with_bytes(
        *program,
        &data,
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(view.market_state, false),
            AccountMeta::new(view.vaults[view.sol_index()], false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new_readonly(*recipient, false),
            AccountMeta::new(pda::associated_token(recipient, &WSOL, &TOKEN), false),
            AccountMeta::new_readonly(view.vault_authority, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        ],
    )
}

/// A pubkey of the program's own (`anchor_lang`) type as the client's.
pub fn key(anchor: &anchor_lang::prelude::Pubkey) -> Pubkey {
    Pubkey::new_from_array(anchor.to_bytes())
}

fn failure(error: &impl std::fmt::Debug, logs: &[String]) -> String {
    format!("{error:?}\n{}", logs.join("\n"))
}

/// The error alone, without the logs.
pub fn first_line(message: &str) -> String {
    message.lines().next().unwrap_or_default().to_string()
}
