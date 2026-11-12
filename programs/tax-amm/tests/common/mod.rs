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

pub mod authority;
pub mod ceilings;
pub mod fuzz;
pub mod launchpad;
pub mod model;

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

/// [`valid_params`] for a market whose tax is taken in its quote mint, the mint at
/// `quote_index`: how a containment hook home market is created
/// (docs/spec/containment-hook.md, "Checks on the home market").
pub fn quote_taxed_params(seeder: &Pubkey, quote_index: u8) -> InitParams {
    InitParams {
        tax_side: quote_index,
        ..valid_params(seeder)
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
        self.create_mint_at(&Keypair::new(), token_program, options)
    }

    /// [`Env::create_mint_with`] at a given mint keypair's address.
    pub fn create_mint_at(
        &mut self,
        mint: &Keypair,
        token_program: &Pubkey,
        options: MintOptions,
    ) -> Pubkey {
        use spl_token_2022_interface::extension::{transfer_fee, transfer_hook, ExtensionType};
        use spl_token_2022_interface::{instruction, state};

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
                    Some(options.transfer_hook_authority.unwrap_or(authority)),
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
        self.send(&instructions, &[mint]).unwrap();
        mint.pubkey()
    }

    /// A Token-2022 mint whose transfer hook is `hook_program`, with the hook authority
    /// `hook_authority` derives from the mint's address, 6 decimals, no freeze authority and
    /// the admin as mint authority: a containment hook's contained mint when the authority
    /// is the mint's unlock PDA (docs/spec/containment-hook.md, "Lifecycle").
    pub fn create_hooked_mint(
        &mut self,
        hook_program: &Pubkey,
        hook_authority: impl FnOnce(&Pubkey) -> Pubkey,
        options: MintOptions,
    ) -> Pubkey {
        let mint = Keypair::new();
        let authority = hook_authority(&mint.pubkey());
        let options = MintOptions {
            transfer_hook: Some(*hook_program),
            transfer_hook_authority: Some(authority),
            ..options
        };
        self.create_mint_at(&mint, &TOKEN_2022, options)
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
        self.fund(&wallet.pubkey(), market, [amount, amount]);
        wallet
    }

    /// Gives `wallet` some SOL and an associated token account for each of the market's
    /// mints holding `amounts` (replacing any it had).
    pub fn fund(&mut self, wallet: &Pubkey, market: &Market, amounts: [u64; 2]) {
        self.svm.airdrop(wallet, SOL).unwrap();
        for ((mint, token_program), amount) in
            market.mints.iter().zip(&market.token_programs).zip(amounts)
        {
            self.write_token_account(mint, token_program, wallet, amount);
        }
    }

    /// `pipeline_check::write_token_account`, which writes the associated token account of
    /// `owner` for `mint` holding `amount`, made right for Token-2022's native SOL mint too:
    /// Pipeline's helper wraps only SPL Token's, so it would write a Token-2022 wrapped SOL
    /// balance with no lamports behind it and not marked native.
    pub fn write_token_account(
        &mut self,
        mint: &Pubkey,
        token_program: &Pubkey,
        owner: &Pubkey,
        amount: u64,
    ) -> Pubkey {
        let address =
            write_token_account(&mut self.svm, mint, token_program, owner, amount).unwrap();
        let native_2022 = ck(&tax_amm::params::NATIVE_MINTS[1]);
        if *mint == native_2022 && *token_program == TOKEN_2022 {
            let mut account = self.svm.get_account(&address).unwrap();
            let rent = self
                .svm
                .minimum_balance_for_rent_exemption(account.data.len());
            // is_native: a COption<u64> holding the rent-exempt reserve.
            account.data[109..113].copy_from_slice(&1u32.to_le_bytes());
            account.data[113..121].copy_from_slice(&rent.to_le_bytes());
            account.lamports = rent + amount;
            self.svm.set_account(address, account).unwrap();
        }
        address
    }

    /// Sends the tax AMM's `seed` action, signed by `seeder` from their associated token
    /// accounts, with `hook_accounts` after its own.
    pub fn seed_with(
        &mut self,
        market: &Market,
        seeder: &Keypair,
        amounts: [u64; 2],
        hook_accounts: Vec<AccountMeta>,
    ) -> Result<TransactionMetadata, String> {
        let instruction = seed_instruction(market, &seeder.pubkey(), amounts, hook_accounts);
        self.send_meta(&[instruction], &[seeder])
    }

    /// [`Env::seed_with`] with the transfer-hook accounts both transfers need.
    pub fn seed(
        &mut self,
        market: &Market,
        seeder: &Keypair,
        amounts: [u64; 2],
    ) -> Result<TransactionMetadata, String> {
        let owner = seeder.pubkey();
        let hooks: Vec<AccountMeta> = (0..2)
            .flat_map(|i| {
                let source =
                    pda::associated_token(&owner, &market.mints[i], &market.token_programs[i]);
                self.hook_accounts(&market.mints[i], source, market.vaults[i], owner)
            })
            .collect();
        self.seed_with(market, seeder, amounts, hooks)
    }

    /// A market on `mints` with `params` (whose seeder is replaced by a fresh wallet),
    /// created and seeded with `amounts` by that wallet.
    pub fn seeded_market(
        &mut self,
        mints: [(Pubkey, Pubkey); 2],
        params: &InitParams,
        amounts: [u64; 2],
    ) -> Market {
        let seeder = Keypair::new();
        let params = InitParams {
            seeder: ak(&seeder.pubkey()),
            ..*params
        };
        let market = self.create_tax_market(mints, &params).unwrap();
        self.fund(&seeder.pubkey(), &market, amounts);
        self.seed(&market, &seeder, amounts).unwrap();
        market
    }

    /// An exact-in swap through the router of `amount_in` of mint `input` for mint
    /// `output`, by `trader` from their associated token accounts, as a terminal sends it:
    /// the strategy accounts resolved, then the transfer-hook accounts of the output mint,
    /// and the input mint's hook accounts for the router. Returns the router's result.
    pub fn swap(
        &mut self,
        market: &Market,
        trader: &Keypair,
        direction: (usize, usize),
        amount_in: u64,
    ) -> Result<client::SwapResult, String> {
        let meta = self.swap_with(
            market,
            trader,
            direction,
            amount_in,
            &SwapOptions::default(),
        )?;
        borsh::from_slice(&meta.return_data.data).map_err(|e| e.to_string())
    }

    /// [`Env::swap`] with `options`, returning the transaction's metadata.
    pub fn swap_with(
        &mut self,
        market: &Market,
        trader: &Keypair,
        (input, output): (usize, usize),
        amount_in: u64,
        options: &SwapOptions,
    ) -> Result<TransactionMetadata, String> {
        let instruction = self.swap_instruction(
            market,
            &trader.pubkey(),
            (input, output),
            amount_in,
            options,
        )?;
        self.send_meta(&[instruction], &[trader])
    }

    /// The router's `swap` for [`Env::swap_with`].
    pub fn swap_instruction(
        &self,
        market: &Market,
        owner: &Pubkey,
        (input, output): (usize, usize),
        amount_in: u64,
        options: &SwapOptions,
    ) -> Result<Instruction, String> {
        let mode = options.mode.unwrap_or(TradeMode::ExactIn);
        let mut trade = exact_in(input, output, amount_in);
        trade.mode = mode;
        let trader_input =
            pda::associated_token(owner, &market.mints[input], &market.token_programs[input]);
        let trader_output =
            pda::associated_token(owner, &market.mints[output], &market.token_programs[output]);
        let mut strategy_accounts = match &options.strategy_accounts {
            Some(accounts) => accounts.clone(),
            None => self.resolve_accounts(market, &exact_in(input, output, amount_in))?,
        };
        strategy_accounts.extend(self.hook_accounts(
            &market.mints[output],
            market.vaults[output],
            trader_output,
            market.authority,
        ));
        let input_hook_accounts = self.hook_accounts(
            &market.mints[input],
            trader_input,
            market.vaults[input],
            *owner,
        );
        let accounts = client::SwapAccounts {
            trader: *owner,
            strategy_program: strategy_id(),
            market_state: market.market_state,
            trader_input,
            trader_output,
            input_vault: market.vaults[input],
            input_mint: market.mints[input],
            output_mint: market.mints[output],
            input_token_program: market.token_programs[input],
            output_token_program: market.token_programs[output],
            integrator_fee_account: None,
            strategy_accounts,
            input_hook_accounts: input_hook_accounts.clone(),
        };
        let (amount_in, amount_out) = match mode {
            TradeMode::ExactIn => (amount_in, 0),
            TradeMode::ExactOut => (u64::MAX / 2, amount_in),
        };
        let args = client::SwapArgs {
            mode,
            amount_in,
            amount_out,
            min_amount_out: options.min_amount_out,
            integrator_fee_bps: 0,
            input_hook_accounts: input_hook_accounts.len() as u8,
            extra: vec![],
        };
        Ok(client::swap(&accounts, &args))
    }

    /// The transfer-hook accounts a transfer of `mint` needs, or none when it has no hook.
    pub fn hook_accounts(
        &self,
        mint: &Pubkey,
        source: Pubkey,
        destination: Pubkey,
        authority: Pubkey,
    ) -> Vec<AccountMeta> {
        let Some(hook_program) = self.hook_program(mint) else {
            return vec![];
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
        .expect("the hook's accounts")
    }

    /// The transfer-hook program of a Token-2022 mint, if it has one.
    pub fn hook_program(&self, mint: &Pubkey) -> Option<Pubkey> {
        use spl_token_2022_interface::extension::{transfer_hook, StateWithExtensions};
        let account = self.svm.get_account(mint)?;
        if account.owner != TOKEN_2022 {
            return None;
        }
        let state =
            StateWithExtensions::<spl_token_2022_interface::state::Mint>::unpack(&account.data)
                .ok()?;
        transfer_hook::get_program_id(&state).map(|id| Pubkey::new_from_array(id.to_bytes()))
    }

    /// Loads Pipeline's `test-hook` (built by `scripts/fetch-pipeline.sh`), a transfer hook
    /// that approves every transfer once a mint's list is initialized with nobody on it.
    pub fn add_test_hook(&mut self) -> Pubkey {
        let program = test_hook_id();
        if self.svm.get_account(&program).is_none() {
            let path =
                crate_dir().join("../../fixtures/pipeline/programs/target/deploy/test_hook.so");
            let bytes = read_program(path, "Run `scripts/fetch-pipeline.sh` first.");
            self.svm.add_program(program, &bytes).unwrap();
        }
        program
    }

    /// A Token-2022 mint whose transfer hook is Pipeline's `test-hook`, approving every
    /// transfer, with the admin as its hook authority.
    pub fn create_mint_with_test_hook(&mut self) -> Pubkey {
        self.create_mint_with_test_hook_at(&Keypair::new())
    }

    /// [`Env::create_mint_with_test_hook`] at a given mint keypair's address.
    pub fn create_mint_with_test_hook_at(&mut self, mint: &Keypair) -> Pubkey {
        let hook = self.add_test_hook();
        let options = MintOptions {
            transfer_hook: Some(hook),
            transfer_hook_authority: Some(self.admin.pubkey()),
            ..MintOptions::default()
        };
        let mint = self.create_mint_at(mint, &TOKEN_2022, options);
        let validation = pipeline_check::hooks::validation_address(&hook, &mint);
        let whitelist = Pubkey::find_program_address(&[b"whitelist", mint.as_ref()], &hook).0;
        let initialize = Instruction::new_with_bytes(
            hook,
            b"tsthkini",
            vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new(validation, false),
                AccountMeta::new(whitelist, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            ],
        );
        self.send(&[initialize], &[]).unwrap();
        mint
    }

    /// The router's swap events in a transaction.
    pub fn swap_events(meta: &TransactionMetadata) -> Vec<pipeline_events::SwapEvent> {
        meta.inner_instructions
            .iter()
            .flatten()
            .filter_map(
                |inner| match pipeline_events::decode(&inner.instruction.data) {
                    Some(pipeline_events::PipelineEvent::Swap(event)) => Some(event),
                    _ => None,
                },
            )
            .collect()
    }

    /// Sends `amount` of the market's mint `i` from `owner`'s associated token account to
    /// `to` with a plain token transfer, as anyone can send tokens to a vault.
    pub fn transfer(
        &mut self,
        market: &Market,
        owner: &Keypair,
        i: usize,
        to: Pubkey,
        amount: u64,
    ) -> Result<TransactionMetadata, String> {
        let from =
            pda::associated_token(&owner.pubkey(), &market.mints[i], &market.token_programs[i]);
        let decimals = self.svm.get_account(&market.mints[i]).unwrap().data[44];
        let mut data = vec![12u8];
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(decimals);
        let mut accounts = vec![
            AccountMeta::new(from, false),
            AccountMeta::new_readonly(market.mints[i], false),
            AccountMeta::new(to, false),
            AccountMeta::new_readonly(owner.pubkey(), true),
        ];
        accounts.extend(self.hook_accounts(&market.mints[i], from, to, owner.pubkey()));
        let instruction = Instruction::new_with_bytes(market.token_programs[i], &data, accounts);
        self.send_meta(&[instruction], &[owner])
    }

    /// Sends the tax AMM's `distribute` action for `slot`, signed and paid for by `caller`,
    /// with the slot's wallet read from the market state and the transfer-hook accounts the
    /// payout needs after its own.
    pub fn distribute(
        &mut self,
        market: &Market,
        caller: &Keypair,
        slot: u8,
    ) -> Result<TransactionMetadata, String> {
        let state = self.tax_market(&market.market_state);
        let tax_side = state.tax_side as usize;
        let wallet = slot_wallet(&state, slot);
        let token_account = pda::associated_token(
            &wallet,
            &market.mints[tax_side],
            &market.token_programs[tax_side],
        );
        let hooks = self.hook_accounts(
            &market.mints[tax_side],
            market.vaults[tax_side],
            token_account,
            market.authority,
        );
        let instruction =
            distribute_instruction(market, tax_side, &caller.pubkey(), slot, &wallet, hooks);
        self.send_meta(&[instruction], &[caller])
    }

    /// A token account's balance, or 0 when it does not exist.
    pub fn balance_or_zero(&self, account: &Pubkey) -> u64 {
        match self.svm.get_account(account) {
            Some(found) if found.data.len() >= 72 => {
                u64::from_le_bytes(found.data[64..72].try_into().unwrap())
            }
            _ => 0,
        }
    }

    /// Writes a mint's supply. [`Env::fund`] writes balances without minting them, so a test
    /// that measures a burn by the supply first gives the mint one that covers them.
    pub fn set_supply(&mut self, mint: &Pubkey, supply: u64) {
        let mut account = self.svm.get_account(mint).expect("mint");
        account.data[36..44].copy_from_slice(&supply.to_le_bytes());
        self.svm.set_account(*mint, account).unwrap();
    }

    /// A mint's supply.
    pub fn supply(&self, mint: &Pubkey) -> u64 {
        let data = self.svm.get_account(mint).expect("mint").data;
        u64::from_le_bytes(data[36..44].try_into().unwrap())
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

/// How [`Env::swap_with`] departs from a plain exact-in swap with no minimum.
#[derive(Clone, Debug, Default)]
pub struct SwapOptions {
    pub min_amount_out: u64,
    /// Exact-out sends `amount` as the output wanted.
    pub mode: Option<TradeMode>,
    /// The strategy accounts to pass instead of resolving them.
    pub strategy_accounts: Option<Vec<AccountMeta>>,
}

/// Where tests load Pipeline's `test-hook`.
pub fn test_hook_id() -> Pubkey {
    pipeline_client::pubkey!("TestHook11111111111111111111111111111111111")
}

/// What [`Env::create_mint_with`] sets up besides a plain mint.
#[derive(Clone, Copy, Debug)]
pub struct MintOptions {
    pub decimals: u8,
    pub freeze_authority: bool,
    pub transfer_hook: Option<Pubkey>,
    /// The transfer hook's authority; the admin when `None`.
    pub transfer_hook_authority: Option<Pubkey>,
    pub transfer_fee_bps: Option<u16>,
    pub permanent_delegate: bool,
}

impl Default for MintOptions {
    fn default() -> Self {
        MintOptions {
            decimals: 6,
            freeze_authority: false,
            transfer_hook: None,
            transfer_hook_authority: None,
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

/// The tax AMM's `seed` action, in the account order `metadata.json` lists: the seeder,
/// the market state, the seeder's associated token account for each mint, the vaults, the
/// mints and their token programs, then `hook_accounts`.
pub fn seed_instruction(
    market: &Market,
    seeder: &Pubkey,
    amounts: [u64; 2],
    hook_accounts: Vec<AccountMeta>,
) -> Instruction {
    use anchor_lang::InstructionData;
    let data = tax_amm::instruction::Seed {
        amount_0: amounts[0],
        amount_1: amounts[1],
    }
    .data();
    let source =
        |i: usize| pda::associated_token(seeder, &market.mints[i], &market.token_programs[i]);
    let mut accounts = vec![
        AccountMeta::new_readonly(*seeder, true),
        AccountMeta::new(market.market_state, false),
        AccountMeta::new(source(0), false),
        AccountMeta::new(source(1), false),
        AccountMeta::new(market.vaults[0], false),
        AccountMeta::new(market.vaults[1], false),
        AccountMeta::new_readonly(market.mints[0], false),
        AccountMeta::new_readonly(market.mints[1], false),
        AccountMeta::new_readonly(market.token_programs[0], false),
        AccountMeta::new_readonly(market.token_programs[1], false),
    ];
    accounts.extend(hook_accounts);
    Instruction::new_with_bytes(strategy_id(), &data, accounts)
}

/// The wallet a tax slot is paid to, as the program's `TaxMarket::slot_wallet` says
/// (docs/spec/tax-amm.md, "Payout"), as the client's key type; the default key for the burn,
/// an unused slot and a slot number out of range.
pub fn slot_wallet(state: &TaxMarket, slot: u8) -> Pubkey {
    state
        .slot_wallet(slot as usize)
        .map(|wallet| ck(&wallet))
        .unwrap_or_default()
}

/// The tax AMM's `distribute` action, in the account order `metadata.json` lists: the
/// caller, who pays for a missing token account, the market state, the vault authority,
/// the tax-side vault and mint, the slot's wallet and its associated token account for the
/// tax-side mint, the tax-side token program, the associated token program and the system
/// program, then `hook_accounts`.
pub fn distribute_instruction(
    market: &Market,
    tax_side: usize,
    caller: &Pubkey,
    slot: u8,
    wallet: &Pubkey,
    hook_accounts: Vec<AccountMeta>,
) -> Instruction {
    use anchor_lang::InstructionData;
    let data = tax_amm::instruction::Distribute { slot }.data();
    let (mint, token_program) = (market.mints[tax_side], market.token_programs[tax_side]);
    let mut accounts = vec![
        AccountMeta::new(*caller, true),
        AccountMeta::new(market.market_state, false),
        AccountMeta::new_readonly(market.authority, false),
        AccountMeta::new(market.vaults[tax_side], false),
        // Writable only for the burn, which changes the supply.
        if slot == tax_amm::state::BURN_SLOT {
            AccountMeta::new(mint, false)
        } else {
            AccountMeta::new_readonly(mint, false)
        },
        AccountMeta::new_readonly(*wallet, false),
        AccountMeta::new(pda::associated_token(wallet, &mint, &token_program), false),
        AccountMeta::new_readonly(token_program, false),
        AccountMeta::new_readonly(client::ASSOCIATED_TOKEN_PROGRAM_ID, false),
        AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
    ];
    accounts.extend(hook_accounts);
    Instruction::new_with_bytes(strategy_id(), &data, accounts)
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
    strategy_events(logs)
}

/// The strategy's events of type `E` in a transaction's logs.
pub fn strategy_events<E: Discriminator + AnchorDeserialize>(logs: &[String]) -> Vec<E> {
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
        .filter_map(|bytes| {
            let body = bytes.strip_prefix(E::DISCRIMINATOR)?;
            E::try_from_slice(body).ok()
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
