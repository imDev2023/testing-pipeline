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

    /// The market as its market state describes it, for a market the router has no Market
    /// for: its mints and vaults in the order `pipeline_market_info` gives them.
    pub fn from_state(
        svm: &LiteSVM,
        program: &Pubkey,
        market_state: &Pubkey,
        state: &MarketState,
    ) -> Result<MarketView, String> {
        let mints = vec![key(&state.token_mint), key(&state.wsol_mint)];
        let token_programs = mints
            .iter()
            .map(|mint| {
                svm.get_account(mint)
                    .map(|a| a.owner)
                    .ok_or_else(|| format!("its mint {mint} is missing"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(MarketView {
            market: pda::market(program, market_state),
            market_state: *market_state,
            mints,
            vaults: vec![key(&state.token_vault), key(&state.sol_vault)],
            token_programs,
            vault_authority: vault_authority(program, market_state),
        })
    }

    pub fn token_index(&self) -> usize {
        self.sides().map_or(0, |(token, _)| token)
    }

    pub fn sol_index(&self) -> usize {
        self.sides().map_or(1, |(_, sol)| sol)
    }
}

/// A LiteSVM, the program it trades and a wallet that pays for everything.
///
/// Every wallet the gate signs with (the payer, and each market's trader and keeper) has a
/// key derived from the program or the market, never a random one, so the deployed build's
/// replay and the candidate's sign with the same keys and derive the same addresses: a step
/// whose compute depends on a PDA's bump cannot pass in one replay and fail in the other.
pub struct Session {
    pub svm: LiteSVM,
    pub program: Pubkey,
    pub payer: Keypair,
    /// The trader of the last swap, who holds what it bought.
    trader: Option<Keypair>,
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

    /// Sends `instructions` paid for by the payer, with `signers` named as signers but not
    /// signing: the replay's LiteSVM does not check signatures (`world::load`), so the gate can
    /// act as a market's seeder, whose key it does not hold.
    pub fn send_as(
        &mut self,
        instructions: &[Instruction],
        signers: &[Pubkey],
    ) -> Result<(Vec<u8>, Vec<String>), String> {
        self.svm.expire_blockhash();
        let message = solana_message::Message::new(instructions, Some(&self.payer.pubkey()));
        let mut tx = Transaction::new_unsigned(message);
        tx.try_partial_sign(&[&self.payer], self.svm.latest_blockhash())
            .map_err(|e| e.to_string())?;
        debug_assert!(signers.iter().all(|s| tx.message.account_keys.contains(s)));
        self.svm
            .send_transaction(tx)
            .map(|meta| (meta.return_data.data, meta.logs))
            .map_err(|failed| failure(&failed.err, &failed.meta.logs))
    }

    /// Clears a mint's mint and freeze authorities, in the replay only.
    pub fn remove_mint_authorities(&mut self, mint: &Pubkey) -> Result<(), String> {
        let mut account = self
            .svm
            .get_account(mint)
            .ok_or_else(|| format!("the mint {mint} is missing"))?;
        // COption tags: the mint authority at byte 0, the freeze authority at byte 46.
        for (tag, key) in [(0usize, 4usize), (46, 50)] {
            account
                .data
                .get_mut(tag..tag + 4)
                .ok_or("a short mint")?
                .fill(0);
            account
                .data
                .get_mut(key..key + 32)
                .ok_or("a short mint")?
                .fill(0);
        }
        self.svm
            .set_account(*mint, account)
            .map_err(|e| e.to_string())
    }

    /// Clears a Token-2022 mint's transfer hook, its program and its authority, in the
    /// replay only, as a seed requires (`POOL4-48`); a mint without one is left as it is.
    pub fn clear_transfer_hook(&mut self, mint: &Pubkey) -> Result<(), String> {
        use spl_token_2022_interface::extension::{
            BaseStateWithExtensionsMut, StateWithExtensionsMut,
        };
        let mut account = self
            .svm
            .get_account(mint)
            .ok_or_else(|| format!("the mint {mint} is missing"))?;
        if account.owner != TOKEN_2022 {
            return Ok(());
        }
        {
            let mut state =
                StateWithExtensionsMut::<spl_token_2022_interface::state::Mint>::unpack(
                    &mut account.data,
                )
                .map_err(|e| format!("the mint {mint}: {e}"))?;
            match state.get_extension_mut::<transfer_hook::TransferHook>() {
                Ok(hook) => *hook = transfer_hook::TransferHook::default(),
                Err(_) => return Ok(()),
            }
        }
        self.svm
            .set_account(*mint, account)
            .map_err(|e| e.to_string())
    }

    /// Adds `amount` to a mint's supply, in the replay only, for tokens written into an
    /// account rather than minted.
    pub fn add_supply(&mut self, mint: &Pubkey, amount: u64) -> Result<(), String> {
        let mut account = self
            .svm
            .get_account(mint)
            .ok_or_else(|| format!("the mint {mint} is missing"))?;
        let bytes = account.data.get_mut(36..44).ok_or("a short mint")?;
        let supply = u64::from_le_bytes(bytes.try_into().map_err(|_| "a short mint")?);
        bytes.copy_from_slice(&supply.saturating_add(amount).to_le_bytes());
        self.svm
            .set_account(*mint, account)
            .map_err(|e| e.to_string())
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
            vault_authority: vault_authority(&self.program, market_state),
        })
    }

    /// `pipeline_market_info`, run in simulation as the router runs it: the mints, vaults and
    /// exact-out support the program reads from the market state.
    pub fn market_info(&self, market_state: &Pubkey) -> Result<psi::MarketInfo, String> {
        let ix = Instruction::new_with_bytes(
            self.program,
            &discriminator::MARKET_INFO,
            vec![AccountMeta::new_readonly(*market_state, false)],
        );
        let output = self.simulate(ix)?;
        psi::MarketInfo::try_from_slice(&output).map_err(|_| "malformed return data".to_string())
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
        match self.quote_amount(view, input, output, amount, resolved) {
            Ok(out) => QuoteOutcome::AmountOut(out),
            Err(error) => QuoteOutcome::Refused(first_line(&error)),
        }
    }

    /// What [`Session::quote`] quotes, or the error with the logs.
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

    /// The market's trader, holding `lamports` of wrapped SOL and an empty account for the
    /// token.
    pub fn trader(&mut self, view: &MarketView, lamports: u64) -> Result<Keypair, String> {
        let trader = role_key(&self.program, b"trader", &view.market_state);
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

    /// The market's keeper, with an empty wrapped SOL account for its tips.
    pub fn keeper(&mut self, market_state: &Pubkey) -> Result<Keypair, String> {
        let keeper = role_key(&self.program, b"keeper", market_state);
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

/// The strategy's `seed` action, signed by `seeder`, from `seeder`'s associated token
/// accounts, in the account order `metadata.json` lists, with `hook_accounts` after.
pub fn seed_ix(
    program: &Pubkey,
    view: &MarketView,
    seeder: &Pubkey,
    token_amount: u64,
    sol_amount: u64,
    hook_accounts: Vec<AccountMeta>,
) -> Instruction {
    let (token, sol) = (view.token_index(), view.sol_index());
    let mut data = client::instruction_discriminator("seed").to_vec();
    data.extend_from_slice(&token_amount.to_le_bytes());
    data.extend_from_slice(&sol_amount.to_le_bytes());
    let mut accounts = vec![
        AccountMeta::new_readonly(*seeder, true),
        AccountMeta::new(view.market_state, false),
        AccountMeta::new(
            pda::associated_token(seeder, &view.mints[token], &view.token_programs[token]),
            false,
        ),
        AccountMeta::new(pda::associated_token(seeder, &WSOL, &TOKEN), false),
        AccountMeta::new(view.vaults[token], false),
        AccountMeta::new(view.vaults[sol], false),
        AccountMeta::new_readonly(view.mints[token], false),
        AccountMeta::new_readonly(WSOL, false),
        AccountMeta::new_readonly(view.token_programs[token], false),
        AccountMeta::new_readonly(TOKEN, false),
    ];
    accounts.extend(hook_accounts);
    Instruction::new_with_bytes(*program, &data, accounts)
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

/// The vault authority of a market, the PDA `["authority", market_state]`.
pub fn vault_authority(program: &Pubkey, market_state: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[buy_wall_amm::state::AUTHORITY_SEED, market_state.as_ref()],
        program,
    )
    .0
}

/// The wallet the gate plays `role` with for `of` (the program, or a market state): its
/// secret key is the PDA `["buy-wall-gate", role, of]` of the program, so it is the same in
/// every replay of the same snapshot and no two roles or markets share one.
pub fn role_key(program: &Pubkey, role: &[u8], of: &Pubkey) -> Keypair {
    let seed = Pubkey::find_program_address(&[b"buy-wall-gate", role, of.as_ref()], program).0;
    Keypair::new_from_array(seed.to_bytes())
}

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

/// A program's name for the report: the buy wall AMM, the router or a token program by
/// name, any other by its address.
pub fn program_name(program: &str, ours: &Pubkey) -> String {
    let known = [
        (*ours, "the buy wall AMM"),
        (client::PROGRAM_ID, "the router"),
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

    #[test]
    fn a_failure_is_placed_in_the_innermost_program_that_failed() {
        let (hook, token, router) = (
            Pubkey::new_unique(),
            TOKEN_2022.to_string(),
            client::PROGRAM_ID.to_string(),
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
}
