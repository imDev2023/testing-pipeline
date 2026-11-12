//! Test setup: the real Pipeline router and this strategy in LiteSVM, a local Solana VM.
//!
//! Programs are loaded from files, so build first:
//!
//! - this strategy: `cargo build-sbf --manifest-path programs/tax-amm/Cargo.toml`
//!   writes `programs/target/deploy/tax_amm.so`, or `$CARGO_TARGET_DIR/deploy` when that is
//!   set (set `SBF_OUT_DIR` to read it from somewhere else);
//! - the router: `scripts/fetch-router.sh` copies the devnet build to
//!   `fixtures/router/pipeline.so`, checked against the hash pinned in
//!   `fixtures/pins.env` (set `PIPELINE_ROUTER_SO` to use another file).
//!
//! Every helper sends real transactions through the router, the same instructions a
//! front end or desk would send on devnet.

#![allow(dead_code)]

use std::path::PathBuf;

use anchor_lang::{AccountDeserialize, AnchorDeserialize, Discriminator};
use base64::Engine;
use litesvm::types::TransactionMetadata;
use litesvm::LiteSVM;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use tax_amm::config::MAX_RECIPIENTS;
use tax_amm::events::MarketCreated;
use tax_amm::{InitParams, StrategyError, TaxMarket};

pub use pipeline_check::write_token_account;
pub use pipeline_client::interface::{QuoteResult, ResolveRequest, ResolveResult, TradeRequest};

pub const SOL: u64 = 1_000_000_000;
pub const TOKEN: Pubkey = client::TOKEN_PROGRAM_ID;
pub const TOKEN_2022: Pubkey = client::TOKEN_2022_PROGRAM_ID;

/// Size of an SPL Token mint account, and of a Token-2022 one's base.
const MINT_LEN: usize = 82;
/// Token-2022 pads an extended mint to a token account's length, then writes the account
/// type (1 for a mint), then its type-length-value extension entries.
const ACCOUNT_LEN: usize = 165;

/// The strategy's program address, from its `declare_id!`.
pub fn strategy_id() -> Pubkey {
    Pubkey::new_from_array(tax_amm::ID.to_bytes())
}

/// A key as the program's own (Anchor's) type.
pub fn ak(key: &Pubkey) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(key.to_bytes())
}

/// A key the program reported, as the client's type.
pub fn ck(key: &anchor_lang::prelude::Pubkey) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_program(path: PathBuf, hint: &str) -> Vec<u8> {
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}. {hint}", path.display()))
}

/// The strategy's compiled program.
pub fn strategy_so() -> Vec<u8> {
    let dir = std::env::var("SBF_OUT_DIR")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("CARGO_TARGET_DIR").map(|dir| PathBuf::from(dir).join("deploy")))
        .unwrap_or_else(|_| crate_dir().join("../target/deploy"));
    read_program(
        dir.join("tax_amm.so"),
        "Build it first: cargo build-sbf --manifest-path programs/tax-amm/Cargo.toml",
    )
}

/// The Pipeline router's compiled program.
pub fn router_so() -> Vec<u8> {
    let path = std::env::var("PIPELINE_ROUTER_SO")
        .map(PathBuf::from)
        .unwrap_or_else(|_| crate_dir().join("../../fixtures/router/pipeline.so"));
    read_program(path, "Run `scripts/fetch-router.sh` first.")
}

/// Rewrites the upgrade authority in an upgradeable program's ProgramData header, as if
/// `authority` had deployed it.
fn set_upgrade_authority(svm: &mut LiteSVM, program: &Pubkey, authority: &Pubkey) {
    let address = pda::program_data(program);
    let mut account = svm.get_account(&address).expect("program data");
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(address, account).unwrap();
}

/// The tax AMM's PDAs for a market state: the vault authority `["authority", market_state]`
/// and each vault `["vault", market_state, mint]` (docs/spec/tax-amm.md, "Addresses").
pub fn tax_market_addresses(market_state: &Pubkey, mints: [Pubkey; 2]) -> (Pubkey, [Pubkey; 2]) {
    let program = strategy_id();
    let authority =
        Pubkey::find_program_address(&[b"authority", market_state.as_ref()], &program).0;
    let vault = |mint: &Pubkey| {
        Pubkey::find_program_address(&[b"vault", market_state.as_ref(), mint.as_ref()], &program).0
    };
    (authority, [vault(&mints[0]), vault(&mints[1])])
}

/// `pipeline_init_market`'s own accounts, after the router's four, in the order
/// `metadata.json`'s `init.accounts` lists them.
pub fn init_accounts(
    market_state: &Pubkey,
    mints: [Pubkey; 2],
    token_programs: [Pubkey; 2],
) -> Vec<AccountMeta> {
    let (authority, vaults) = tax_market_addresses(market_state, mints);
    vec![
        AccountMeta::new_readonly(mints[0], false),
        AccountMeta::new_readonly(mints[1], false),
        AccountMeta::new_readonly(authority, false),
        AccountMeta::new(vaults[0], false),
        AccountMeta::new(vaults[1], false),
        AccountMeta::new_readonly(token_programs[0], false),
        AccountMeta::new_readonly(token_programs[1], false),
    ]
}

/// The creation parameters, Borsh-encoded as `create_market`'s `init_data`.
pub fn init_data(params: &InitParams) -> Vec<u8> {
    borsh::to_vec(params).unwrap()
}

/// Valid creation parameters: a buy tax and a sell tax inside their ranges, a tax
/// authority, two tax recipients and a burn. Tests change one field at a time.
pub fn valid_params(seeder: &Pubkey) -> InitParams {
    let none = anchor_lang::prelude::Pubkey::default();
    let mut recipients = [none; MAX_RECIPIENTS];
    recipients[0] = ak(&Pubkey::new_unique());
    recipients[1] = ak(&Pubkey::new_unique());
    let mut shares = [0u16; MAX_RECIPIENTS];
    shares[0] = 6_000;
    shares[1] = 3_000;
    InitParams {
        tax_side: 1,
        buy_tax_bps: 300,
        sell_tax_bps: 500,
        buy_tax_min_bps: 100,
        buy_tax_max_bps: 800,
        sell_tax_min_bps: 0,
        sell_tax_max_bps: 1_000,
        tax_authority: ak(&Pubkey::new_unique()),
        seeder: ak(seeder),
        recipients,
        shares,
        burn_share_bps: 1_000,
        virtual_side: 0,
        virtual_reserve: 0,
    }
}

/// A market recorded by the router.
#[derive(Debug)]
pub struct Market {
    /// The router's Market account, the address integrators and `pipeline-check` use.
    pub market: Pubkey,
    /// The tax AMM's market state, a fresh keypair's address.
    pub market_state: Pubkey,
    pub authority: Pubkey,
    pub mints: [Pubkey; 2],
    pub token_programs: [Pubkey; 2],
    pub vaults: [Pubkey; 2],
    /// The transaction that created it, for its logs and compute.
    pub created: TransactionMetadata,
}

/// The router's `create_market` for the tax AMM.
pub fn create_market_instruction(
    creator: &Pubkey,
    market_state: &Pubkey,
    market_state_signs: bool,
    init_data: Vec<u8>,
    strategy_accounts: Vec<AccountMeta>,
) -> Instruction {
    client::create_market(&client::CreateMarket {
        creator: *creator,
        strategy_program: strategy_id(),
        market_state: *market_state,
        market_state_signs,
        init_data,
        max_creator_lamports: SOL,
        strategy_accounts,
    })
}

/// A VM with the router configured and this strategy deployed and registered.
pub struct Env {
    pub svm: LiteSVM,
    /// Pays for everything, is the router's admin and the strategy's upgrade authority.
    pub admin: Keypair,
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 1_000 * SOL).unwrap();
        svm.add_program(client::PROGRAM_ID, &router_so()).unwrap();
        set_upgrade_authority(&mut svm, &client::PROGRAM_ID, &admin.pubkey());
        svm.add_program(strategy_id(), &strategy_so()).unwrap();
        set_upgrade_authority(&mut svm, &strategy_id(), &admin.pubkey());
        let mut env = Env { svm, admin };

        // The router's one-time configuration, as on devnet: a 0.01 SOL listing fee.
        let fee_recipient = Pubkey::new_unique();
        let config = client::initialize_config(
            &env.admin.pubkey(),
            &client::ConfigArgs {
                listing_fee_lamports: 10_000_000,
                listing_fee_recipient: fee_recipient,
                treasury_owner: Pubkey::new_unique(),
            },
        );
        env.send(&[config], &[]).unwrap();

        // Register the strategy, signed by its upgrade authority.
        let admin = env.admin.pubkey();
        let register = client::register_strategy(
            &admin,
            &admin,
            &strategy_id(),
            &fee_recipient,
            "https://example.com/metadata.json",
            10_000_000,
        );
        env.send(&[register], &[]).unwrap();
        env
    }

    /// Sends a transaction paid for by the admin. Returns its metadata, or the error and
    /// logs.
    pub fn send_meta(
        &mut self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, String> {
        self.svm.expire_blockhash();
        let mut all = vec![&self.admin];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(
            instructions,
            Some(&self.admin.pubkey()),
            &all,
            self.svm.latest_blockhash(),
        );
        self.svm
            .send_transaction(tx)
            .map_err(|failed| format!("{:?}\n{}", failed.err, failed.meta.logs.join("\n")))
    }

    /// [`Env::send_meta`], returning the router's or strategy's return data.
    pub fn send(
        &mut self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<Vec<u8>, String> {
        self.send_meta(instructions, signers)
            .map(|meta| meta.return_data.data)
    }

    /// Runs a read-only instruction in simulation and returns its metadata.
    pub fn simulate_meta(&self, instruction: Instruction) -> Result<TransactionMetadata, String> {
        let tx = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&self.admin.pubkey()),
            &[&self.admin],
            self.svm.latest_blockhash(),
        );
        self.svm
            .simulate_transaction(tx)
            .map(|info| info.meta)
            .map_err(|failed| format!("{:?}\n{}", failed.err, failed.meta.logs.join("\n")))
    }

    /// Runs a read-only instruction in simulation and returns its return data.
    pub fn simulate(&self, instruction: Instruction) -> Result<Vec<u8>, String> {
        self.simulate_meta(instruction)
            .map(|meta| meta.return_data.data)
    }

    /// A new mint with the admin as its mint authority. For Token-2022, `options` adds
    /// extensions and a freeze authority, each set up by Token-2022 itself.
    pub fn create_mint_with(&mut self, token_program: &Pubkey, options: MintOptions) -> Pubkey {
        use spl_token_2022_interface::extension::{transfer_fee, transfer_hook, ExtensionType};
        use spl_token_2022_interface::{instruction, state};

        let mint = Keypair::new();
        let authority = self.admin.pubkey();
        let mut extensions = vec![];
        if options.transfer_fee_bps.is_some() {
            extensions.push(ExtensionType::TransferFeeConfig);
        }
        if options.transfer_hook.is_some() {
            extensions.push(ExtensionType::TransferHook);
        }
        if options.permanent_delegate {
            extensions.push(ExtensionType::PermanentDelegate);
        }
        let space = if *token_program == TOKEN {
            assert!(extensions.is_empty(), "SPL Token mints have no extensions");
            MINT_LEN
        } else {
            ExtensionType::try_calculate_account_len::<state::Mint>(&extensions).unwrap()
        };
        let mut instructions = vec![create_account(
            &authority,
            &mint.pubkey(),
            self.svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            token_program,
        )];
        if let Some(bps) = options.transfer_fee_bps {
            instructions.push(
                transfer_fee::instruction::initialize_transfer_fee_config(
                    token_program,
                    &mint.pubkey(),
                    Some(&authority),
                    Some(&authority),
                    bps,
                    u64::MAX,
                )
                .unwrap(),
            );
        }
        if let Some(hook_program) = options.transfer_hook {
            instructions.push(
                transfer_hook::instruction::initialize(
                    token_program,
                    &mint.pubkey(),
                    Some(authority),
                    Some(hook_program),
                )
                .unwrap(),
            );
        }
        if options.permanent_delegate {
            instructions.push(
                instruction::initialize_permanent_delegate(
                    token_program,
                    &mint.pubkey(),
                    &authority,
                )
                .unwrap(),
            );
        }
        let freeze_authority = options.freeze_authority.then_some(authority);
        instructions.push(
            instruction::initialize_mint2(
                token_program,
                &mint.pubkey(),
                &authority,
                freeze_authority.as_ref(),
                options.decimals,
            )
            .unwrap(),
        );
        self.send(&instructions, &[&mint]).unwrap();
        mint.pubkey()
    }

    /// A plain mint of `token_program` with 6 decimals and no freeze authority.
    pub fn create_mint(&mut self, token_program: &Pubkey) -> Pubkey {
        self.create_mint_with(token_program, MintOptions::default())
    }

    /// A Token-2022 mint written straight into the VM, carrying one zeroed extension entry
    /// per `(type, value length)`: how the tests give a mint an extension Token-2022 would
    /// need its own setup for, or one it has not defined yet. The bytes are laid out as
    /// Token-2022 lays out a mint (mint-rules' tests check that layout against Token-2022's
    /// own state code).
    pub fn write_mint_with_extensions(&mut self, extensions: &[(u16, usize)]) -> Pubkey {
        let some_authority = [[1u8, 0, 0, 0].as_slice(), self.admin.pubkey().as_ref()].concat();
        let mut data = some_authority;
        data.extend_from_slice(&0u64.to_le_bytes());
        data.push(6);
        data.push(1);
        data.extend_from_slice(&[0u8; 36]);
        assert_eq!(data.len(), MINT_LEN);
        data.resize(ACCOUNT_LEN, 0);
        data.push(1);
        for &(extension_type, len) in extensions {
            data.extend_from_slice(&extension_type.to_le_bytes());
            data.extend_from_slice(&(len as u16).to_le_bytes());
            data.extend(std::iter::repeat_n(0, len));
        }
        let mint = Pubkey::new_unique();
        let account = solana_account::Account {
            lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: TOKEN_2022,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(mint, account).unwrap();
        mint
    }

    /// SPL Token's or Token-2022's native SOL mint as it exists on every cluster, written into
    /// the VM: initialized, no authorities, 9 decimals.
    pub fn write_native_mint(
        &mut self,
        mint: &anchor_lang::prelude::Pubkey,
        token_program: &Pubkey,
    ) -> Pubkey {
        let mut data = vec![0u8; MINT_LEN];
        data[44] = 9;
        data[45] = 1;
        let mint = ck(mint);
        let account = solana_account::Account {
            lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: *token_program,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(mint, account).unwrap();
        mint
    }

    /// Creates a tax market through the router's `create_market`, signed by a fresh market
    /// state keypair, and makes both mints sellable with `init_fee_account`, in one
    /// transaction, exactly as `metadata.json`'s `init` describes it.
    pub fn create_tax_market(
        &mut self,
        mints: [(Pubkey, Pubkey); 2],
        params: &InitParams,
    ) -> Result<Market, String> {
        self.create_tax_market_with(&Keypair::new(), mints, init_data(params))
    }

    /// [`Env::create_tax_market`] with a given market state keypair and raw `init_data`.
    pub fn create_tax_market_with(
        &mut self,
        market_state: &Keypair,
        mints: [(Pubkey, Pubkey); 2],
        init_data: Vec<u8>,
    ) -> Result<Market, String> {
        let state = market_state.pubkey();
        let mint_keys = [mints[0].0, mints[1].0];
        let token_programs = [mints[0].1, mints[1].1];
        let (authority, vaults) = tax_market_addresses(&state, mint_keys);
        let creator = self.admin.pubkey();
        let create = create_market_instruction(
            &creator,
            &state,
            true,
            init_data,
            init_accounts(&state, mint_keys, token_programs),
        );
        let market = pda::market(&strategy_id(), &state);
        let fees = (0..2).map(|i| {
            client::init_fee_account(&creator, &market, &mint_keys[i], &token_programs[i])
        });
        let instructions: Vec<Instruction> = std::iter::once(create).chain(fees).collect();
        let created = self.send_meta(&instructions, &[market_state])?;
        Ok(Market {
            market,
            market_state: state,
            authority,
            mints: mint_keys,
            token_programs,
            vaults,
            created,
        })
    }

    /// The tax AMM's market state, decoded with its discriminator checked.
    pub fn tax_market(&self, market_state: &Pubkey) -> TaxMarket {
        let data = self
            .svm
            .get_account(market_state)
            .expect("market state")
            .data;
        TaxMarket::try_deserialize(&mut data.as_slice()).expect("a tax market")
    }

    /// The router's Market account.
    pub fn router_market(&self, market: &Pubkey) -> client::Market {
        let data = self.svm.get_account(market).expect("router market").data;
        client::decode_market(&data).expect("a router market")
    }

    /// The router's ten fixed trade accounts for a read-only call, with placeholders for
    /// the trader, as an integrator's quoter passes them.
    pub fn read_accounts(&self, market: &Market, trade: &TradeRequest) -> Vec<AccountMeta> {
        let input = trade.input_index as usize;
        let output = trade.output_index as usize;
        let placeholder = client::SYSTEM_PROGRAM_ID;
        vec![
            AccountMeta::new_readonly(market.market, false),
            AccountMeta::new_readonly(market.market_state, false),
            AccountMeta::new_readonly(placeholder, false),
            AccountMeta::new_readonly(placeholder, false),
            AccountMeta::new_readonly(placeholder, false),
            AccountMeta::new_readonly(market.vaults[input], false),
            AccountMeta::new_readonly(market.mints[input], false),
            AccountMeta::new_readonly(market.mints[output], false),
            AccountMeta::new_readonly(market.token_programs[input], false),
            AccountMeta::new_readonly(market.token_programs[output], false),
        ]
    }

    /// `pipeline_resolve_accounts`, round 0, run in simulation.
    pub fn resolve_meta(
        &self,
        market: &Market,
        trade: &TradeRequest,
    ) -> Result<TransactionMetadata, String> {
        let request = ResolveRequest {
            trade: trade.clone(),
            round: 0,
        };
        let instruction = strategy_call(
            client::interface::discriminator::RESOLVE_ACCOUNTS,
            &request,
            self.read_accounts(market, trade),
        );
        self.simulate_meta(instruction)
    }

    /// The strategy accounts a swap needs, from `pipeline_resolve_accounts`.
    pub fn resolve_accounts(
        &self,
        market: &Market,
        trade: &TradeRequest,
    ) -> Result<Vec<AccountMeta>, String> {
        let data = self.resolve_meta(market, trade)?.return_data.data;
        let result: ResolveResult = borsh::from_slice(&data).map_err(|e| e.to_string())?;
        assert!(result.complete, "the tax AMM resolves in one round");
        Ok(result
            .accounts
            .iter()
            .map(|a| {
                let address = Pubkey::new_from_array(a.address);
                if a.writable {
                    AccountMeta::new(address, false)
                } else {
                    AccountMeta::new_readonly(address, false)
                }
            })
            .collect())
    }

    /// The strategy's `pipeline_quote`, in vault amounts (before Pipeline's fee).
    pub fn quote(&self, market: &Market, trade: &TradeRequest) -> Result<QuoteResult, String> {
        let strategy_accounts = self.resolve_accounts(market, trade)?;
        let mut accounts = self.read_accounts(market, trade);
        accounts.extend(
            strategy_accounts
                .iter()
                .map(|a| AccountMeta::new_readonly(a.pubkey, false)),
        );
        let instruction = strategy_call(client::interface::discriminator::QUOTE, trade, accounts);
        let data = self.simulate(instruction)?;
        borsh::from_slice(&data).map_err(|e| e.to_string())
    }

    /// `pipeline_market_info`, given only `market_state`, run in simulation.
    pub fn market_info_meta(&self, market_state: &Pubkey) -> Result<TransactionMetadata, String> {
        let instruction = Instruction::new_with_bytes(
            strategy_id(),
            &client::interface::discriminator::MARKET_INFO,
            vec![AccountMeta::new_readonly(*market_state, false)],
        );
        self.simulate_meta(instruction)
    }

    /// A new wallet holding `amount` of each of the market's mints, plus some SOL.
    pub fn funded_wallet(&mut self, market: &Market, amount: u64) -> Keypair {
        let wallet = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), SOL).unwrap();
        for (mint, token_program) in market.mints.iter().zip(&market.token_programs) {
            write_token_account(&mut self.svm, mint, token_program, &wallet.pubkey(), amount)
                .unwrap();
        }
        wallet
    }

    /// An exact-in swap through the router of `amount_in` of mint `input` for mint
    /// `output`, by `trader` from their associated token accounts, with the strategy
    /// accounts given rather than resolved (an unopened market resolves, but never trades).
    pub fn swap(
        &mut self,
        market: &Market,
        trader: &Keypair,
        (input, output): (usize, usize),
        amount_in: u64,
    ) -> Result<client::SwapResult, String> {
        let owner = trader.pubkey();
        let trade = exact_in(input, output, amount_in);
        let accounts = client::SwapAccounts {
            trader: owner,
            strategy_program: strategy_id(),
            market_state: market.market_state,
            trader_input: pda::associated_token(
                &owner,
                &market.mints[input],
                &market.token_programs[input],
            ),
            trader_output: pda::associated_token(
                &owner,
                &market.mints[output],
                &market.token_programs[output],
            ),
            input_vault: market.vaults[input],
            input_mint: market.mints[input],
            output_mint: market.mints[output],
            input_token_program: market.token_programs[input],
            output_token_program: market.token_programs[output],
            integrator_fee_account: None,
            strategy_accounts: self.resolve_accounts(market, &trade)?,
            input_hook_accounts: vec![],
        };
        let args = client::SwapArgs {
            mode: TradeMode::ExactIn,
            amount_in,
            amount_out: 0,
            min_amount_out: 0,
            integrator_fee_bps: 0,
            input_hook_accounts: 0,
            extra: vec![],
        };
        let data = self.send(&[client::swap(&accounts, &args)], &[trader])?;
        borsh::from_slice(&data).map_err(|e| e.to_string())
    }

    /// A token account's balance.
    pub fn balance(&self, account: &Pubkey) -> u64 {
        let data = self.svm.get_account(account).expect("token account").data;
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

/// What [`Env::create_mint_with`] sets up besides a plain mint.
#[derive(Clone, Copy, Debug)]
pub struct MintOptions {
    pub decimals: u8,
    pub freeze_authority: bool,
    pub transfer_hook: Option<Pubkey>,
    pub transfer_fee_bps: Option<u16>,
    pub permanent_delegate: bool,
}

impl Default for MintOptions {
    fn default() -> Self {
        MintOptions {
            decimals: 6,
            freeze_authority: false,
            transfer_hook: None,
            transfer_fee_bps: None,
            permanent_delegate: false,
        }
    }
}

/// An anonymous exact-in trade request.
pub fn exact_in(input: usize, output: usize, amount: u64) -> TradeRequest {
    TradeRequest {
        mode: TradeMode::ExactIn,
        input_index: input as u8,
        output_index: output as u8,
        amount,
        trader: None,
        extra: vec![],
    }
}

pub fn strategy_call<T: borsh::BorshSerialize>(
    discriminator: [u8; 8],
    argument: &T,
    accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut data = discriminator.to_vec();
    data.extend(borsh::to_vec(argument).unwrap());
    Instruction::new_with_bytes(strategy_id(), &data, accounts)
}

/// Fails unless `result` is the strategy refusing with `error`: Anchor's error number for it
/// in the transaction error, and its name in the logs.
pub fn assert_refused<T: std::fmt::Debug>(result: Result<T, String>, error: StrategyError) {
    let name = format!("{error:?}");
    let number = anchor_lang::error::ERROR_CODE_OFFSET + error as u32;
    match result {
        Ok(value) => {
            panic!("expected the strategy to refuse with {name}, but it passed: {value:?}")
        }
        Err(failure) => assert!(
            failure.contains(&format!("Custom({number})"))
                && failure.contains(&format!("Error Code: {name}.")),
            "expected the strategy to refuse with {name} ({number}), got:\n{failure}"
        ),
    }
}

/// The compute units each invocation of the strategy consumed, in order, from a
/// transaction's logs. A cost includes the strategy's own calls to other programs.
pub fn strategy_compute(logs: &[String]) -> Vec<u64> {
    let prefix = format!("Program {} consumed ", strategy_id());
    logs.iter()
        .filter_map(|line| line.strip_prefix(&prefix))
        .map(|rest| rest.split(' ').next().unwrap().parse().unwrap())
        .collect()
}

/// The `MarketCreated` events the strategy logged.
pub fn market_created_events(logs: &[String]) -> Vec<MarketCreated> {
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
        .filter_map(|bytes| {
            let body = bytes.strip_prefix(MarketCreated::DISCRIMINATOR)?;
            MarketCreated::try_from_slice(body).ok()
        })
        .collect()
}

/// System program `CreateAccount`.
fn create_account(
    from: &Pubkey,
    to: &Pubkey,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
) -> Instruction {
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction::new_with_bytes(
        client::SYSTEM_PROGRAM_ID,
        &data,
        vec![AccountMeta::new(*from, true), AccountMeta::new(*to, true)],
    )
}
