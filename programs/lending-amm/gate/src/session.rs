//! What a trader, a terminal and a keeper send to a lending AMM market, in a LiteSVM: account
//! resolution, quotes and swaps through the router, `pipeline_market_info` and `rebalance`,
//! each built in the account order `metadata.json` lists.

use anchor_lang::AccountDeserialize;
use borsh::BorshDeserialize;
use lending_amm::LendingAmmMarket;
use litesvm::LiteSVM;
use pipeline_client::{self as client, pda, AccountMeta, FeeSide, Instruction, Pubkey, TradeMode};
use pipeline_strategy_interface::{self as psi, discriminator, fees};
use release_gate::errors::{failure, first_line};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_2022_interface::extension::{transfer_hook, StateWithExtensions};

use crate::kamino::{self, key};
use crate::snapshot::QuoteOutcome;

pub const SOL: u64 = 1_000_000_000;
pub const TOKEN: Pubkey = client::TOKEN_PROGRAM_ID;
pub const TOKEN_2022: Pubkey = client::TOKEN_2022_PROGRAM_ID;
pub const ATA_PROGRAM: Pubkey = client::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// A market as the router records it, with what its trades and `rebalance` need.
#[derive(Clone, Debug)]
pub struct MarketView {
    pub market: Pubkey,
    pub market_state: Pubkey,
    pub mints: Vec<Pubkey>,
    pub vaults: Vec<Pubkey>,
    pub token_programs: Vec<Pubkey>,
    /// The mint index that is lent, from the market state.
    pub lent: usize,
    pub vault_authority: Pubkey,
    pub ctoken_account: Pubkey,
}

impl MarketView {
    /// The mint index that is not lent.
    pub fn other(&self) -> usize {
        1 - self.lent
    }

    /// The market as its market state describes it, for a market the router has no Market
    /// for: its mints and vaults in the order `pipeline_market_info` gives them.
    pub fn from_state(
        svm: &LiteSVM,
        program: &Pubkey,
        market_state: &Pubkey,
        state: &LendingAmmMarket,
    ) -> Result<MarketView, String> {
        let mints: Vec<Pubkey> = state.mints.iter().map(key).collect();
        Ok(MarketView {
            market: pda::market(program, market_state),
            market_state: *market_state,
            token_programs: token_programs(svm, &mints)?,
            mints,
            vaults: state.vaults.iter().map(key).collect(),
            lent: state.lent_side(),
            vault_authority: vault_authority(program, market_state),
            ctoken_account: key(&state.ctoken_account),
        })
    }
}

fn token_programs(svm: &LiteSVM, mints: &[Pubkey]) -> Result<Vec<Pubkey>, String> {
    mints
        .iter()
        .map(|mint| {
            svm.get_account(mint)
                .map(|a| a.owner)
                .ok_or_else(|| format!("its mint {mint} is missing"))
        })
        .collect()
}

/// A LiteSVM, the program it trades and a wallet that pays for everything.
///
/// Every wallet the gate signs with (the payer, and each market's trader, keeper and LP) has a
/// key derived from the program or the market, never a random one, so the deployed build's
/// replay and the candidate's sign with the same keys and derive the same addresses.
pub struct Session {
    pub svm: LiteSVM,
    pub program: Pubkey,
    pub payer: Keypair,
}

impl Session {
    pub fn new(mut svm: LiteSVM, program: Pubkey) -> Self {
        let payer = role_key(&program, b"payer", &program);
        svm.airdrop(&payer.pubkey(), 1_000 * SOL)
            .expect("airdrop to the payer");
        Session {
            svm,
            program,
            payer,
        }
    }

    /// Sends `instructions` paid for by the payer; the return data and logs, or the error and
    /// the logs.
    pub fn send(
        &mut self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<(Vec<u8>, Vec<String>), String> {
        send(&mut self.svm, &self.payer, instructions, signers)
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

    /// Brings every lent mint's reserve up to date at the VM's clock (`kamino::refresh_all`).
    pub fn refresh_reserves(&mut self) -> Vec<String> {
        let payer = self.payer.insecure_clone();
        kamino::refresh_all(&mut self.svm, |svm, ix| {
            send(svm, &payer, &[ix], &[]).map(|_| ())
        })
    }

    /// The market whose market state is `market_state`, from the router's Market account and
    /// the market state.
    pub fn market(&self, market_state: &Pubkey) -> Result<MarketView, String> {
        let market = pda::market(&self.program, market_state);
        let record = self
            .svm
            .get_account(&market)
            .filter(|a| a.owner == client::PROGRAM_ID)
            .and_then(|a| client::decode_market(&a.data))
            .ok_or_else(|| format!("the router has no Market {market} for it"))?;
        let state = self.state(market_state)?;
        let mints = record.mints().to_vec();
        Ok(MarketView {
            market,
            market_state: *market_state,
            vaults: record.vaults[..mints.len()].to_vec(),
            token_programs: token_programs(&self.svm, &mints)?,
            mints,
            lent: state.lent_side(),
            vault_authority: vault_authority(&self.program, market_state),
            ctoken_account: key(&state.ctoken_account),
        })
    }

    /// The market state, read with this tree's layout.
    pub fn state(&self, market_state: &Pubkey) -> Result<LendingAmmMarket, String> {
        let account = self
            .svm
            .get_account(market_state)
            .ok_or_else(|| format!("the market state {market_state} is missing"))?;
        if account.data.len() != lending_amm::state::layout::LEN {
            return Err(format!(
                "the market state is {} bytes, not {}",
                account.data.len(),
                lending_amm::state::layout::LEN
            ));
        }
        LendingAmmMarket::try_deserialize(&mut account.data.as_slice())
            .map_err(|e| format!("the market state does not read: {e}"))
    }

    /// The lent side's total `L = B + V`, from the market state and its reserve as this tree
    /// reads them.
    pub fn lent_total(&self, view: &MarketView) -> Result<(u64, u64), String> {
        let state = self.state(&view.market_state)?;
        let reserve = kamino::reserve(&self.svm, &view.mints[view.lent])?;
        let value = reserve
            .lent_value(state.ctokens)
            .map_err(|e| format!("{e:?}"))?;
        let buffer = state.reserves[view.lent];
        Ok((buffer, buffer + value))
    }

    /// `pipeline_market_info`, run in simulation as the router runs it.
    pub fn market_info(&self, market_state: &Pubkey) -> Result<psi::MarketInfo, String> {
        let ix = Instruction::new_with_bytes(
            self.program,
            &discriminator::MARKET_INFO,
            vec![AccountMeta::new_readonly(*market_state, false)],
        );
        let output = self.simulate(ix)?;
        psi::MarketInfo::try_from_slice(&output).map_err(|_| "malformed return data".to_string())
    }

    /// A token account's balance.
    pub fn balance(&self, account: &Pubkey) -> Option<u64> {
        let data = self.svm.get_account(account)?.data;
        Some(u64::from_le_bytes(data.get(64..72)?.try_into().ok()?))
    }

    /// The router's ten fixed trade accounts for a read-only call, with placeholders for the
    /// trader, as an integrator's quoter passes them.
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
    /// a trade of `amount` from mint `input` to mint `output` needs (the reserve, and for a
    /// sale beyond the buffer klend's redeem accounts).
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

    /// An exact-in quote, resolved for its own amount, as an integrator's quoter runs it.
    pub fn quote(
        &self,
        view: &MarketView,
        input: usize,
        output: usize,
        amount: u64,
    ) -> QuoteOutcome {
        let quoted = self
            .resolve(view, input, output, amount)
            .and_then(|resolved| self.quote_amount(view, input, output, amount, &resolved));
        match quoted {
            Ok(out) => QuoteOutcome::AmountOut(out),
            Err(error) => QuoteOutcome::Refused(first_line(&error)),
        }
    }

    /// `pipeline_quote` for an exact-in trade with the resolved accounts after the fixed ones;
    /// the amount out, or the error with the logs.
    pub fn quote_amount(
        &self,
        view: &MarketView,
        input: usize,
        output: usize,
        amount: u64,
        resolved: &[AccountMeta],
    ) -> Result<u64, String> {
        let mut accounts = self.read_accounts(view, input, output);
        accounts.extend(
            resolved
                .iter()
                .map(|m| AccountMeta::new_readonly(m.pubkey, false)),
        );
        let data = psi::instruction_data(discriminator::QUOTE, &exact_in(input, output, amount));
        let output = self.simulate(Instruction::new_with_bytes(self.program, &data, accounts))?;
        psi::QuoteResult::try_from_slice(&output)
            .map(|quote| quote.amount_out)
            .map_err(|_| "malformed return data".to_string())
    }

    /// The market's trader, holding `amount` of mint `input` and an empty account for the
    /// other mint, in their associated token accounts.
    pub fn trader(
        &mut self,
        view: &MarketView,
        input: usize,
        amount: u64,
    ) -> Result<Keypair, String> {
        let trader = role_key(&self.program, b"trader", &view.market_state);
        if self.svm.get_balance(&trader.pubkey()).unwrap_or(0) < SOL {
            self.svm
                .airdrop(&trader.pubkey(), SOL)
                .map_err(|e| format!("{e:?}"))?;
        }
        for i in 0..2 {
            pipeline_check::write_token_account(
                &mut self.svm,
                &view.mints[i],
                &view.token_programs[i],
                &trader.pubkey(),
                if i == input { amount } else { 0 },
            )?;
        }
        Ok(trader)
    }

    /// An exact-in swap through the router of `amount` of mint `input` by `trader`, from and to
    /// their associated token accounts, with the resolved strategy accounts and each side's
    /// transfer-hook accounts, refused unless at least `min_arriving` arrives. Pipeline's fee is
    /// paid on the side the router's record names: since Pipeline 0.3 a sale into wrapped SOL,
    /// the fee mint of a WSOL-lent market, pays it out of what arrived, so the router's minimum
    /// is what the trader keeps of `min_arriving`.
    #[allow(clippy::too_many_arguments)]
    pub fn swap(
        &mut self,
        view: &MarketView,
        trader: &Keypair,
        input: usize,
        output: usize,
        amount: u64,
        min_arriving: u64,
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
        let record = self
            .svm
            .get_account(&view.market)
            .and_then(|account| client::decode_market(&account.data))
            .ok_or_else(|| format!("the router has no Market at {}", view.market))?;
        let fee_side = FeeSide::of(&record, &view.mints[output]);
        let min_amount_out = match fee_side {
            FeeSide::Output => min_arriving - fees::pipeline_fee(min_arriving),
            FeeSide::Input => min_arriving,
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
        let (data, _) = self.send(
            &[client::swap_with_fee_side(&accounts, &args, fee_side)],
            &[trader],
        )?;
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

    /// The market's keeper, with SOL for its fees.
    pub fn keeper(&mut self, market_state: &Pubkey) -> Result<Keypair, String> {
        let keeper = role_key(&self.program, b"keeper", market_state);
        if self.svm.get_balance(&keeper.pubkey()).unwrap_or(0) < SOL {
            self.svm
                .airdrop(&keeper.pubkey(), SOL)
                .map_err(|e| format!("{e:?}"))?;
        }
        Ok(keeper)
    }
}

/// Sends `instructions` paid for by `payer`, with a fresh blockhash.
pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> Result<(Vec<u8>, Vec<String>), String> {
    svm.expire_blockhash();
    let mut all = vec![payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(
        instructions,
        Some(&payer.pubkey()),
        &all,
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
        .map(|meta| (meta.return_data.data, meta.logs))
        .map_err(|failed| failure(&failed.err, &failed.meta.logs))
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

/// The lending AMM's `rebalance` on `view`, called by `caller`, in the account order
/// `metadata.json`'s `rebalance` action lists, with the Kamino accounts of its lent mint.
pub fn rebalance_ix(
    program: &Pubkey,
    view: &MarketView,
    caller: &Pubkey,
    kamino: &kamino::Accounts,
) -> Instruction {
    let accounts = vec![
        AccountMeta::new_readonly(*caller, true),
        AccountMeta::new(view.market_state, false),
        AccountMeta::new_readonly(view.vault_authority, false),
        AccountMeta::new(view.vaults[view.lent], false),
        AccountMeta::new(view.ctoken_account, false),
        AccountMeta::new_readonly(view.mints[view.lent], false),
        AccountMeta::new(kamino.reserve, false),
        AccountMeta::new_readonly(kamino.lending_market, false),
        AccountMeta::new_readonly(kamino.lending_market_authority, false),
        AccountMeta::new(kamino.liquidity_supply, false),
        AccountMeta::new(kamino.collateral_mint, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(kamino::klend(), false),
        AccountMeta::new_readonly(kamino::instructions_sysvar(), false),
    ];
    Instruction::new_with_bytes(
        *program,
        &client::instruction_discriminator("rebalance"),
        accounts,
    )
}

/// The vault authority of a market, the PDA `["authority", market_state]`.
pub fn vault_authority(program: &Pubkey, market_state: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[lending_amm::state::AUTHORITY_SEED, market_state.as_ref()],
        program,
    )
    .0
}

/// The wallet the gate plays `role` with for `of` (the program, or a market state): its secret
/// key is the PDA `["lending-gate", role, of]` of the program, so it is the same in every replay
/// of the same snapshot and no two roles or markets share one.
pub fn role_key(program: &Pubkey, role: &[u8], of: &Pubkey) -> Keypair {
    let seed = Pubkey::find_program_address(&[b"lending-gate", role, of.as_ref()], program).0;
    Keypair::new_from_array(seed.to_bytes())
}

/// A program's name for the report: the lending AMM, the router, Kamino Lend or a token
/// program by name, any other by its address.
pub fn program_name(program: &str, ours: &Pubkey) -> String {
    let known = [
        (*ours, "the lending AMM"),
        (client::PROGRAM_ID, "the router"),
        (kamino::klend(), "Kamino Lend"),
        (TOKEN, "SPL Token"),
        (TOKEN_2022, "Token-2022"),
        (ATA_PROGRAM, "the associated token program"),
    ];
    known
        .iter()
        .find(|(id, _)| id.to_string() == program)
        .map_or_else(
            || format!("program {program}"),
            |(_, name)| name.to_string(),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gates_wallets_are_the_same_in_every_replay_and_differ_by_role_and_market() {
        let program = crate::programs::program_id();
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        let key = |role: &[u8], of: &Pubkey| role_key(&program, role, of).pubkey();
        assert_eq!(key(b"trader", &a), key(b"trader", &a));
        assert_ne!(key(b"trader", &a), key(b"trader", &b));
        assert_ne!(key(b"trader", &a), key(b"keeper", &a));
        let payer = |svm| Session::new(svm, program).payer.pubkey();
        assert_eq!(payer(LiteSVM::new()), payer(LiteSVM::new()));
    }
}
