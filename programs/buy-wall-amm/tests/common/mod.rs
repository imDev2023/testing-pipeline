//! Test setup: the real Pipeline router and the buy wall AMM in LiteSVM, a local Solana VM.
//!
//! Programs are loaded from files, so build first:
//!
//! - this strategy: `cargo build-sbf --manifest-path programs/buy-wall-amm/Cargo.toml`
//!   writes `programs/target/deploy/buy_wall_amm.so`, or `$CARGO_TARGET_DIR/deploy` when
//!   that is set (set `SBF_OUT_DIR` to read it from somewhere else);
//! - the router: `scripts/fetch-router.sh` copies the devnet build to
//!   `fixtures/router/pipeline.so`, checked against the hash pinned in
//!   `fixtures/pins.env` (set `PIPELINE_ROUTER_SO` to use another file).
//!
//! Every helper sends real transactions through the router, the same instructions a
//! creator, a front end or a desk would send on devnet.

// Each test binary uses its own part of this module.
#![allow(dead_code, unused_imports)]

pub mod exit;
pub mod launchpad;
pub mod payouts;

use std::path::PathBuf;

use buy_wall_amm::InitParams;
use litesvm::LiteSVM;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub use pipeline_check::write_token_account;
pub use pipeline_client::interface::{
    MarketInfo, QuoteResult, ResolveRequest, ResolveResult, SwapRequest, TradeRequest,
};

pub const SOL: u64 = 1_000_000_000;
pub const TOKEN: Pubkey = client::TOKEN_PROGRAM_ID;
pub const TOKEN_2022: Pubkey = client::TOKEN_2022_PROGRAM_ID;
pub const WSOL: Pubkey = client::wallet::NATIVE_MINT;
/// Pipeline's `test-hook` program, as its `declare_id!` names it. Creation only records a
/// mint's hook program, so the creation tests don't need it loaded.
pub const TEST_HOOK_PROGRAM: Pubkey =
    client::pubkey!("BfAcC8daPZSS4iEYz1figEshePUr96gDFwtytn7DyNZ3");

/// Size of an SPL Token mint account, and where Token-2022 puts the account type byte.
const SPL_MINT_LEN: usize = 82;
const ACCOUNT_TYPE_OFFSET: usize = 165;

/// The strategy's program address, from its `declare_id!`.
pub fn strategy_id() -> Pubkey {
    Pubkey::new_from_array(buy_wall_amm::ID.to_bytes())
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
        dir.join("buy_wall_amm.so"),
        "Build it first: cargo build-sbf --manifest-path programs/buy-wall-amm/Cargo.toml",
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

/// Adds the wrapped-SOL mint as it exists on every cluster: SPL Token, 9 decimals, no
/// authorities.
fn add_native_mint(svm: &mut LiteSVM) {
    let mut data = vec![0u8; SPL_MINT_LEN];
    data[44] = 9;
    data[45] = 1;
    svm.set_account(
        WSOL,
        solana_account(
            svm.minimum_balance_for_rent_exemption(SPL_MINT_LEN),
            data,
            TOKEN,
        ),
    )
    .unwrap();
}

pub fn solana_account(lamports: u64, data: Vec<u8>, owner: Pubkey) -> solana_account::Account {
    solana_account::Account {
        lamports,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

/// The addresses of a market, all computable before `create_market` is sent
/// (docs/spec/pool4-for-solana.md, "Addresses").
#[derive(Clone, Debug)]
pub struct Market {
    /// The router's Market account, the address integrators and `pipeline-check` use.
    pub market: Pubkey,
    /// The strategy's market state, a fresh keypair's address.
    pub market_state: Pubkey,
    pub token_mint: Pubkey,
    pub token_program: Pubkey,
    pub vault_authority: Pubkey,
    pub token_vault: Pubkey,
    pub sol_vault: Pubkey,
}

impl Market {
    pub fn addresses(market_state: Pubkey, token_mint: Pubkey, token_program: Pubkey) -> Self {
        let program = strategy_id();
        let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &program).0;
        Market {
            market: client::pda::market(&program, &market_state),
            market_state,
            token_mint,
            token_program,
            vault_authority: pda(&[b"authority", market_state.as_ref()]),
            token_vault: pda(&[b"vault", market_state.as_ref(), token_mint.as_ref()]),
            sol_vault: pda(&[b"vault", market_state.as_ref(), WSOL.as_ref()]),
        }
    }

    pub fn mints(&self) -> [Pubkey; 2] {
        [self.token_mint, WSOL]
    }

    pub fn vaults(&self) -> [Pubkey; 2] {
        [self.token_vault, self.sol_vault]
    }

    /// What `pipeline_resolve_accounts` lists for a trade paying out mint `output`: the
    /// output vault, then the vault authority.
    pub fn strategy_accounts(&self, output: usize) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.vaults()[output], false),
            AccountMeta::new_readonly(self.vault_authority, false),
        ]
    }

    pub fn token_programs(&self) -> [Pubkey; 2] {
        [self.token_program, TOKEN]
    }

    /// `pipeline_init_market`'s own accounts, after the router's four, in the order
    /// `metadata.json`'s `init` lists them.
    pub fn init_accounts(&self) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(self.token_mint, false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new_readonly(self.vault_authority, false),
            AccountMeta::new(self.token_vault, false),
            AccountMeta::new(self.sol_vault, false),
            AccountMeta::new_readonly(self.token_program, false),
            AccountMeta::new_readonly(TOKEN, false),
        ]
    }
}

/// Valid creation parameters: IMD's launch values, as Aviary's create form pre-fills them,
/// with `seeder` as the seeder.
pub fn launch_params(seeder: Pubkey) -> InitParams {
    InitParams {
        fee_bps: 100,
        wall_split_bps: 5_000,
        fee_recipient: Pubkey::new_unique(),
        reward_share_bps: 1_500,
        rewards_recipient: Pubkey::new_unique(),
        cap_floor_bps: 2_000,
        cap_decay_bps: 2_000,
        seeder,
    }
}

/// A new mint's keypair. A mint with a transfer hook gets one whose hook validation account
/// (`["extra-account-metas", mint]` of the hook program) has bump 255: Token-2022 finds that
/// account with `find_program_address` on every transfer of the mint, at 1,500 compute units
/// for each bump it tries, so a random mint would add a random multiple of 1,500 to every
/// hooked transfer the strategy makes, which the compute tests count as the strategy's own
/// (#152, seen as a CI failure at bump 247). That cost belongs to the mint, not the strategy.
fn mint_keypair(extensions: &[RealExtension]) -> Keypair {
    let hook = extensions.iter().find_map(|extension| match extension {
        RealExtension::TransferHook { program } => Some(*program),
        RealExtension::TransferFee { .. } => None,
    });
    loop {
        let mint = Keypair::new();
        let address = mint.pubkey();
        let first_bump = |program: &Pubkey| {
            let seeds: &[&[u8]] = &[b"extra-account-metas", address.as_ref()];
            Pubkey::find_program_address(seeds, program).1 == u8::MAX
        };
        if hook.as_ref().is_none_or(first_bump) {
            return mint;
        }
    }
}

/// A Token-2022 mint extension for `Env::create_mint`, set up with real instructions.
#[derive(Clone, Copy, Debug)]
pub enum RealExtension {
    TransferFee { bps: u16 },
    TransferHook { program: Pubkey },
}

/// A VM with the router configured and this strategy deployed and registered.
pub struct Env {
    pub svm: LiteSVM,
    /// Pays for everything, is the router's admin, the strategy's upgrade authority and,
    /// unless a test says otherwise, every mint's authority.
    pub admin: Keypair,
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000 * SOL).unwrap();
        svm.add_program(client::PROGRAM_ID, &router_so()).unwrap();
        set_upgrade_authority(&mut svm, &client::PROGRAM_ID, &admin.pubkey());
        svm.add_program(strategy_id(), &strategy_so()).unwrap();
        set_upgrade_authority(&mut svm, &strategy_id(), &admin.pubkey());
        add_native_mint(&mut svm);
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

    /// Sends a transaction paid for by the admin. Returns the return data, or the error
    /// and logs.
    pub fn send(
        &mut self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<Vec<u8>, String> {
        self.send_logged(instructions, signers)
            .map(|(data, _)| data)
    }

    /// `send`, also returning the transaction's logs.
    pub fn send_logged(
        &mut self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<(Vec<u8>, Vec<String>), String> {
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
            .map(|meta| (meta.return_data.data, meta.logs))
            .map_err(|failed| format!("{:?}\n{}", failed.err, failed.meta.logs.join("\n")))
    }

    /// Runs one instruction in simulation and returns its return data and logs.
    pub fn simulate_logged(
        &self,
        instruction: Instruction,
    ) -> Result<(Vec<u8>, Vec<String>), String> {
        let tx = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&self.admin.pubkey()),
            &[&self.admin],
            self.svm.latest_blockhash(),
        );
        self.svm
            .simulate_transaction(tx)
            .map(|info| (info.meta.return_data.data, info.meta.logs))
            .map_err(|failed| format!("{:?}\n{}", failed.err, failed.meta.logs.join("\n")))
    }

    pub fn simulate(&self, instruction: Instruction) -> Result<Vec<u8>, String> {
        self.simulate_logged(instruction).map(|(data, _)| data)
    }

    /// A new mint of `token_program` with real extensions, whose mint and freeze
    /// authorities are the admin (when asked for).
    pub fn create_mint_with(
        &mut self,
        token_program: &Pubkey,
        decimals: u8,
        extensions: &[RealExtension],
        freeze_authority: bool,
    ) -> Pubkey {
        use spl_token_2022_interface::extension::{transfer_fee, transfer_hook, ExtensionType};
        use spl_token_2022_interface::{instruction, state};

        let mint = mint_keypair(extensions);
        let authority = self.admin.pubkey();
        let types: Vec<ExtensionType> = extensions
            .iter()
            .map(|e| match e {
                RealExtension::TransferFee { .. } => ExtensionType::TransferFeeConfig,
                RealExtension::TransferHook { .. } => ExtensionType::TransferHook,
            })
            .collect();
        let space = if *token_program == TOKEN {
            SPL_MINT_LEN
        } else {
            ExtensionType::try_calculate_account_len::<state::Mint>(&types).unwrap()
        };
        let mut instructions = vec![create_account(
            &authority,
            &mint.pubkey(),
            self.svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            token_program,
        )];
        for extension in extensions {
            instructions.push(match *extension {
                RealExtension::TransferFee { bps } => {
                    transfer_fee::instruction::initialize_transfer_fee_config(
                        token_program,
                        &mint.pubkey(),
                        Some(&authority),
                        Some(&authority),
                        bps,
                        u64::MAX,
                    )
                    .unwrap()
                }
                RealExtension::TransferHook { program } => transfer_hook::instruction::initialize(
                    token_program,
                    &mint.pubkey(),
                    Some(authority),
                    Some(program),
                )
                .unwrap(),
            });
        }
        instructions.push(
            instruction::initialize_mint2(
                token_program,
                &mint.pubkey(),
                &authority,
                freeze_authority.then_some(&authority),
                decimals,
            )
            .unwrap(),
        );
        self.send(&instructions, &[&mint]).unwrap();
        mint.pubkey()
    }

    /// A plain mint of `token_program` with the admin as mint authority and no freeze
    /// authority.
    pub fn create_mint(&mut self, token_program: &Pubkey, decimals: u8) -> Pubkey {
        self.create_mint_with(token_program, decimals, &[], false)
    }

    /// A Token-2022 mint written straight into the VM, carrying one extension of type
    /// `extension_type` (its number, so unknown types can be written too) with
    /// `data_len` zeroed bytes. For extensions that are tedious or impossible to set up
    /// with instructions; the program reads only which extensions a mint has.
    pub fn plant_token_2022_mint(&mut self, extension_type: u16, data_len: u16) -> Pubkey {
        let mint = Pubkey::new_unique();
        let mut data = vec![0u8; ACCOUNT_TYPE_OFFSET + 1];
        // COption<Pubkey> mint authority: Some(admin).
        data[0..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..36].copy_from_slice(self.admin.pubkey().as_ref());
        data[44] = 6; // decimals
        data[45] = 1; // is_initialized
        data[ACCOUNT_TYPE_OFFSET] = 1; // AccountType::Mint
        data.extend_from_slice(&extension_type.to_le_bytes());
        data.extend_from_slice(&data_len.to_le_bytes());
        data.extend(std::iter::repeat_n(0u8, data_len as usize));
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(mint, solana_account(lamports, data, TOKEN_2022))
            .unwrap();
        mint
    }

    /// Removes the mint's mint and freeze authorities, whichever are still set, as a
    /// token must before its market is seeded.
    pub fn revoke_authorities(&mut self, mint: &Pubkey, token_program: &Pubkey) {
        use spl_token_2022_interface::instruction::{set_authority, AuthorityType};
        let admin = self.admin.pubkey();
        let data = self.svm.get_account(mint).unwrap().data;
        let mut instructions = vec![];
        // COption tags: the mint authority at byte 0, the freeze authority at byte 46.
        for (offset, kind) in [
            (0, AuthorityType::MintTokens),
            (46, AuthorityType::FreezeAccount),
        ] {
            if data[offset..offset + 4] == 1u32.to_le_bytes() {
                instructions
                    .push(set_authority(token_program, mint, None, kind, &admin, &[]).unwrap());
            }
        }
        if !instructions.is_empty() {
            self.send(&instructions, &[]).unwrap();
        }
    }

    /// The router's `create_market` for a fresh market state keypair, with `init_data` as
    /// given (normally the Borsh encoding of `InitParams`) and the accounts `init` lists.
    pub fn create_market_ix(
        &self,
        market_state: &Keypair,
        token_mint: Pubkey,
        token_program: Pubkey,
        init_data: Vec<u8>,
    ) -> (Market, Instruction) {
        let market = Market::addresses(market_state.pubkey(), token_mint, token_program);
        let create = client::create_market(&client::CreateMarket {
            creator: self.admin.pubkey(),
            strategy_program: strategy_id(),
            market_state: market_state.pubkey(),
            market_state_signs: true,
            init_data,
            max_creator_lamports: SOL,
            strategy_accounts: market.init_accounts(),
        });
        (market, create)
    }

    /// The router's `init_fee_account` for both of a market's mints.
    pub fn fee_account_ixs(&self, market: &Market) -> Vec<Instruction> {
        market
            .mints()
            .iter()
            .zip(market.token_programs())
            .map(|(mint, program)| {
                client::init_fee_account(&self.admin.pubkey(), &market.market, mint, &program)
            })
            .collect()
    }

    /// Creates a market through the router, with both fee accounts, in one transaction.
    pub fn create_market(
        &mut self,
        token_mint: Pubkey,
        token_program: Pubkey,
        params: &InitParams,
    ) -> Result<Market, String> {
        let market_state = Keypair::new();
        let (market, create) = self.create_market_ix(
            &market_state,
            token_mint,
            token_program,
            borsh::to_vec(params).unwrap(),
        );
        let mut instructions = vec![create];
        instructions.extend(self.fee_account_ixs(&market));
        self.send(&instructions, &[&market_state])?;
        Ok(market)
    }

    /// The strategy's `pipeline_market_info`, called directly on `market_state`.
    pub fn market_info(&self, market_state: &Pubkey) -> Result<MarketInfo, String> {
        let instruction = strategy_call(
            client::interface::discriminator::MARKET_INFO,
            &(),
            vec![AccountMeta::new_readonly(*market_state, false)],
        );
        let data = self.simulate(instruction)?;
        borsh::from_slice(&data).map_err(|e| e.to_string())
    }

    /// The market state's raw bytes.
    pub fn market_state(&self, market: &Market) -> Vec<u8> {
        self.svm
            .get_account(&market.market_state)
            .expect("market state")
            .data
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

/// An instruction to the strategy: an 8-byte discriminator and one Borsh argument.
pub fn strategy_call<T: borsh::BorshSerialize>(
    discriminator: [u8; 8],
    argument: &T,
    accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut data = discriminator.to_vec();
    data.extend(borsh::to_vec(argument).unwrap());
    Instruction::new_with_bytes(strategy_id(), &data, accounts)
}

/// System program `CreateAccount`.
pub fn create_account(
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

/// The compute units the strategy's `n`th invocation in `logs` consumed, from the runtime's
/// "Program <id> consumed <units> of <budget> compute units" lines.
pub fn strategy_units(logs: &[String], n: usize) -> u64 {
    let prefix = format!("Program {} consumed ", strategy_id());
    logs.iter()
        .filter_map(|line| line.strip_prefix(&prefix))
        .nth(n)
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|units| units.parse().ok())
        .unwrap_or_else(|| {
            panic!(
                "no compute line #{n} for the strategy in:\n{}",
                logs.join("\n")
            )
        })
}

/// Asserts that `result` failed with the strategy's `error` (Anchor's 6000 + its index),
/// whether the strategy was called directly or through the router.
#[track_caller]
pub fn assert_refused<T: std::fmt::Debug>(
    result: Result<T, String>,
    error: buy_wall_amm::errors::StrategyError,
) {
    let code: u32 = error.into();
    match result {
        Ok(value) => panic!("expected {error:?} ({code}), but it succeeded: {value:?}"),
        Err(message) => assert!(
            message.contains(&format!("Custom({code})")),
            "expected {error:?} (Custom({code})), got:\n{message}"
        ),
    }
}

/// Asserts that `result` failed, for any reason (for refusals Anchor or the runtime makes
/// before the strategy's own checks run).
#[track_caller]
pub fn assert_fails<T: std::fmt::Debug>(result: Result<T, String>) {
    if let Ok(value) = result {
        panic!("expected a failure, but it succeeded: {value:?}");
    }
}

/// The strategy's `seed` action, signed by `seeder`, from `seeder`'s associated token
/// accounts, in the account order `metadata.json` lists, with `hook_accounts` after.
pub fn seed_ix(
    market: &Market,
    seeder: &Pubkey,
    token_amount: u64,
    sol_amount: u64,
    hook_accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut data = client::instruction_discriminator("seed").to_vec();
    data.extend_from_slice(&token_amount.to_le_bytes());
    data.extend_from_slice(&sol_amount.to_le_bytes());
    let mut accounts = vec![
        AccountMeta::new_readonly(*seeder, true),
        AccountMeta::new(market.market_state, false),
        AccountMeta::new(
            pda::associated_token(seeder, &market.token_mint, &market.token_program),
            false,
        ),
        AccountMeta::new(pda::associated_token(seeder, &WSOL, &TOKEN), false),
        AccountMeta::new(market.token_vault, false),
        AccountMeta::new(market.sol_vault, false),
        AccountMeta::new_readonly(market.token_mint, false),
        AccountMeta::new_readonly(WSOL, false),
        AccountMeta::new_readonly(market.token_program, false),
        AccountMeta::new_readonly(TOKEN, false),
    ];
    accounts.extend(hook_accounts);
    Instruction::new_with_bytes(strategy_id(), &data, accounts)
}

impl Env {
    /// Gives `owner` `tokens` of `mint` and `lamports` of wrapped SOL in their associated
    /// token accounts (written straight into the VM, so the mint's authorities don't matter).
    pub fn fund(
        &mut self,
        owner: &Pubkey,
        mint: &Pubkey,
        token_program: &Pubkey,
        tokens: u64,
        lamports: u64,
    ) {
        write_token_account(&mut self.svm, mint, token_program, owner, tokens).unwrap();
        write_token_account(&mut self.svm, &WSOL, &TOKEN, owner, lamports).unwrap();
    }

    /// A token of `token_program` with its authorities removed, ready to be seeded.
    pub fn seedable_token(&mut self, token_program: &Pubkey) -> Pubkey {
        let token = self.create_mint(token_program, 6);
        self.revoke_authorities(&token, token_program);
        token
    }

    /// Creates a market with both fee accounts and seeds it with `tokens` and `lamports`
    /// from the admin, all in one transaction, as a creator would (the spec's "Creating a
    /// market"). Returns the market and the transaction's logs.
    pub fn create_and_seed(
        &mut self,
        token_mint: Pubkey,
        token_program: Pubkey,
        params: &InitParams,
        tokens: u64,
        lamports: u64,
    ) -> Result<(Market, Vec<String>), String> {
        let admin = self.admin.pubkey();
        self.fund(&admin, &token_mint, &token_program, tokens, lamports);
        let market_state = Keypair::new();
        let (market, create) = self.create_market_ix(
            &market_state,
            token_mint,
            token_program,
            borsh::to_vec(params).unwrap(),
        );
        let mut instructions = vec![create];
        instructions.extend(self.fee_account_ixs(&market));
        instructions.push(seed_ix(&market, &admin, tokens, lamports, vec![]));
        let (_, logs) = self.send_logged(&instructions, &[&market_state])?;
        Ok((market, logs))
    }

    /// The market state, decoded.
    pub fn state(&self, market: &Market) -> buy_wall_amm::state::MarketState {
        *bytemuck::from_bytes(&self.market_state(market)[8..])
    }

    /// Moves the clock to `unix_timestamp` and `slot`.
    pub fn set_clock(&mut self, slot: u64, unix_timestamp: i64) {
        self.svm.warp_to_slot(slot);
        let mut clock = self.svm.get_sysvar::<anchor_lang::prelude::Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    /// Moves the clock to the next slot, keeping its Unix time: a slot is shorter than a
    /// second, so consecutive slots often share one. `place_wall` is refused in a slot a swap
    /// already ran in (`POOL4-50`), so a test places the wall after a swap from the next slot.
    pub fn next_slot(&mut self) {
        let clock = self.svm.get_sysvar::<anchor_lang::prelude::Clock>();
        self.set_clock(clock.slot + 1, clock.unix_timestamp);
    }
}

/// The events of type `E` the program emitted in `logs` ("Program data:" lines).
pub fn events<E: anchor_lang::Event + anchor_lang::AnchorDeserialize>(logs: &[String]) -> Vec<E> {
    use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|data| STANDARD.decode(data).ok())
        .filter_map(|bytes| {
            let rest = bytes.strip_prefix(E::DISCRIMINATOR)?;
            E::try_from_slice(rest).ok()
        })
        .collect()
}

/// The size of `instructions` as one legacy transaction paid for by `payer` with
/// `signers` more signatures, in bytes on the wire.
pub fn transaction_size(instructions: &[Instruction], payer: &Pubkey, signers: usize) -> usize {
    let message = solana_message::Message::new(instructions, Some(payer));
    let signatures = 1 + signers;
    // A short-vec length (one byte below 128), the signatures, then the message.
    1 + 64 * signatures + message.serialize().len()
}

impl Env {
    /// The router's ten fixed trade accounts for a read-only call, with placeholders for
    /// the trader, as an integrator's quoter passes them.
    pub fn read_accounts(&self, market: &Market, trade: &TradeRequest) -> Vec<AccountMeta> {
        let input = trade.input_index as usize % 2;
        let output = trade.output_index as usize % 2;
        let placeholder = client::SYSTEM_PROGRAM_ID;
        vec![
            AccountMeta::new_readonly(market.market, false),
            AccountMeta::new_readonly(market.market_state, false),
            AccountMeta::new_readonly(placeholder, false),
            AccountMeta::new_readonly(placeholder, false),
            AccountMeta::new_readonly(placeholder, false),
            AccountMeta::new_readonly(market.vaults()[input], false),
            AccountMeta::new_readonly(market.mints()[input], false),
            AccountMeta::new_readonly(market.mints()[output], false),
            AccountMeta::new_readonly(market.token_programs()[input], false),
            AccountMeta::new_readonly(market.token_programs()[output], false),
        ]
    }

    /// The strategy's `pipeline_resolve_accounts`, one round, simulated.
    pub fn resolve(&self, market: &Market, trade: &TradeRequest) -> Result<ResolveResult, String> {
        let request = ResolveRequest {
            trade: trade.clone(),
            round: 0,
        };
        let instruction = strategy_call(
            client::interface::discriminator::RESOLVE_ACCOUNTS,
            &request,
            self.read_accounts(market, trade),
        );
        let data = self.simulate(instruction)?;
        borsh::from_slice(&data).map_err(|e| e.to_string())
    }

    /// The strategy's `pipeline_quote`, simulated, with the resolved accounts after the
    /// fixed ones, as an integrator's quoter passes them.
    pub fn quote(&self, market: &Market, trade: &TradeRequest) -> Result<QuoteResult, String> {
        self.quote_logged(market, trade).map(|(quote, _)| quote)
    }

    /// `quote`, also returning the logs.
    pub fn quote_logged(
        &self,
        market: &Market,
        trade: &TradeRequest,
    ) -> Result<(QuoteResult, Vec<String>), String> {
        let mut accounts = self.read_accounts(market, trade);
        accounts.extend(market.strategy_accounts(trade.output_index as usize % 2));
        let instruction = strategy_call(client::interface::discriminator::QUOTE, trade, accounts);
        let (data, logs) = self.simulate_logged(instruction)?;
        Ok((borsh::from_slice(&data).map_err(|e| e.to_string())?, logs))
    }

    /// The router's `swap` instruction for `trader` trading `amount` of mint `input`, from
    /// and to their associated token accounts, with the strategy accounts
    /// `pipeline_resolve_accounts` lists and the transfer-hook accounts of each side.
    pub fn swap_ix(
        &self,
        market: &Market,
        trader: &Pubkey,
        (input, output): (usize, usize),
        mode: TradeMode,
        amount: u64,
        min_amount_out: u64,
    ) -> Instruction {
        let trader_input = pda::associated_token(
            trader,
            &market.mints()[input],
            &market.token_programs()[input],
        );
        let trader_output = pda::associated_token(
            trader,
            &market.mints()[output],
            &market.token_programs()[output],
        );
        let mut strategy_accounts = market.strategy_accounts(output);
        strategy_accounts.extend(self.hook_accounts(
            &market.mints()[output],
            market.vaults()[output],
            trader_output,
            market.vault_authority,
        ));
        let input_hook_accounts = self.hook_accounts(
            &market.mints()[input],
            trader_input,
            market.vaults()[input],
            *trader,
        );
        let accounts = client::SwapAccounts {
            trader: *trader,
            strategy_program: strategy_id(),
            market_state: market.market_state,
            trader_input,
            trader_output,
            input_vault: market.vaults()[input],
            input_mint: market.mints()[input],
            output_mint: market.mints()[output],
            input_token_program: market.token_programs()[input],
            output_token_program: market.token_programs()[output],
            integrator_fee_account: None,
            strategy_accounts,
            input_hook_accounts,
        };
        let (amount_in, amount_out) = match mode {
            TradeMode::ExactIn => (amount, 0),
            TradeMode::ExactOut => (u64::MAX / 2, amount),
        };
        let args = client::SwapArgs {
            mode,
            amount_in,
            amount_out,
            min_amount_out,
            integrator_fee_bps: 0,
            input_hook_accounts: 0,
            extra: vec![],
        };
        client::swap(&accounts, &args)
    }

    /// A swap through the router of `amount` of mint `input` by `trader`, with no minimum.
    pub fn swap(
        &mut self,
        market: &Market,
        trader: &Keypair,
        direction: (usize, usize),
        mode: TradeMode,
        amount: u64,
    ) -> Result<client::SwapResult, String> {
        self.swap_logged(market, trader, direction, mode, amount, 0)
            .map(|(result, _)| result)
    }

    /// A swap with a minimum output, also returning the transaction's logs.
    pub fn swap_logged(
        &mut self,
        market: &Market,
        trader: &Keypair,
        direction: (usize, usize),
        mode: TradeMode,
        amount: u64,
        min_amount_out: u64,
    ) -> Result<(client::SwapResult, Vec<String>), String> {
        let ix = self.swap_ix(
            market,
            &trader.pubkey(),
            direction,
            mode,
            amount,
            min_amount_out,
        );
        let (data, logs) = self.send_logged(&[ix], &[trader])?;
        Ok((borsh::from_slice(&data).map_err(|e| e.to_string())?, logs))
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

    /// Loads Pipeline's `test-hook` (built by `scripts/fetch-pipeline.sh`) at its own
    /// address.
    pub fn add_test_hook(&mut self) {
        if self.svm.get_account(&TEST_HOOK_PROGRAM).is_none() {
            let path =
                crate_dir().join("../../fixtures/pipeline/programs/target/deploy/test_hook.so");
            let bytes = read_program(path, "Run `scripts/fetch-pipeline.sh` first.");
            self.svm.add_program(TEST_HOOK_PROGRAM, &bytes).unwrap();
        }
    }

    /// A seedable Token-2022 token whose transfer hook is Pipeline's `test-hook`,
    /// approving every transfer, with its mint and freeze authorities removed.
    pub fn seedable_hooked_token(&mut self) -> Pubkey {
        self.add_test_hook();
        let mint = self.create_mint_with(
            &TOKEN_2022,
            6,
            &[RealExtension::TransferHook {
                program: TEST_HOOK_PROGRAM,
            }],
            false,
        );
        let validation = pipeline_check::hooks::validation_address(&TEST_HOOK_PROGRAM, &mint);
        let whitelist =
            Pubkey::find_program_address(&[b"whitelist", mint.as_ref()], &TEST_HOOK_PROGRAM).0;
        let initialize = Instruction::new_with_bytes(
            TEST_HOOK_PROGRAM,
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
        self.revoke_authorities(&mint, &TOKEN_2022);
        mint
    }

    /// Creates and seeds a market of `token`, as `create_and_seed` does, with the token's
    /// transfer-hook accounts after the seed's own.
    pub fn create_and_seed_hooked(
        &mut self,
        token_mint: Pubkey,
        params: &InitParams,
        tokens: u64,
        lamports: u64,
    ) -> Result<Market, String> {
        let admin = self.admin.pubkey();
        self.fund(&admin, &token_mint, &TOKEN_2022, tokens, lamports);
        let market_state = Keypair::new();
        let (market, create) = self.create_market_ix(
            &market_state,
            token_mint,
            TOKEN_2022,
            borsh::to_vec(params).unwrap(),
        );
        let hooks = self.hook_accounts(
            &token_mint,
            pda::associated_token(&admin, &token_mint, &TOKEN_2022),
            market.token_vault,
            admin,
        );
        let mut instructions = vec![create];
        instructions.extend(self.fee_account_ixs(&market));
        instructions.push(seed_ix(&market, &admin, tokens, lamports, hooks));
        self.send(&instructions, &[&market_state])?;
        Ok(market)
    }

    /// A wallet holding `tokens` of the market's token and `lamports` of wrapped SOL.
    pub fn trader(&mut self, market: &Market, tokens: u64, lamports: u64) -> Keypair {
        let trader = Keypair::new();
        self.svm.airdrop(&trader.pubkey(), SOL).unwrap();
        self.fund(
            &trader.pubkey(),
            &market.token_mint,
            &market.token_program,
            tokens,
            lamports,
        );
        trader
    }
}

/// An anonymous trade request.
pub fn trade(mode: TradeMode, input: usize, output: usize, amount: u64) -> TradeRequest {
    TradeRequest {
        mode,
        input_index: input as u8,
        output_index: output as u8,
        amount,
        trader: None,
        extra: vec![],
    }
}

/// The strategy's `place_wall` keeper job, called by `caller`, tipping `tip_account`, in
/// the account order `metadata.json` lists.
pub fn place_wall_ix(market: &Market, caller: &Pubkey, tip_account: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        strategy_id(),
        &client::instruction_discriminator("place_wall"),
        vec![
            AccountMeta::new_readonly(*caller, true),
            AccountMeta::new(market.market_state, false),
            AccountMeta::new(market.sol_vault, false),
            AccountMeta::new(*tip_account, false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new_readonly(market.vault_authority, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
    )
}

impl Env {
    /// A keeper: a wallet with an empty wrapped SOL account for its tips.
    pub fn keeper(&mut self) -> Keypair {
        let keeper = Keypair::new();
        self.svm.airdrop(&keeper.pubkey(), SOL).unwrap();
        write_token_account(&mut self.svm, &WSOL, &TOKEN, &keeper.pubkey(), 0).unwrap();
        keeper
    }

    /// `place_wall` called by `keeper`, tipping its wrapped SOL account. Returns the tip it
    /// received and the transaction's logs.
    pub fn place_wall(
        &mut self,
        market: &Market,
        keeper: &Keypair,
    ) -> Result<(u64, Vec<String>), String> {
        let tips = pda::associated_token(&keeper.pubkey(), &WSOL, &TOKEN);
        let before = self.balance(&tips);
        let ix = place_wall_ix(market, &keeper.pubkey(), &tips);
        let (_, logs) = self.send_logged(&[ix], &[keeper])?;
        Ok((self.balance(&tips) - before, logs))
    }
}
