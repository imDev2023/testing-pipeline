//! Test setup: the real Pipeline router and the lending AMM in LiteSVM, a local Solana VM.
//!
//! Programs are loaded from files, so build first:
//!
//! - this strategy: `cargo build-sbf --manifest-path programs/lending-amm/Cargo.toml`
//!   writes `programs/target/deploy/lending_amm.so`, or `$CARGO_TARGET_DIR/deploy` when that
//!   is set (set `SBF_OUT_DIR` to read it from somewhere else);
//! - the router: `scripts/fetch-router.sh` copies the devnet build to
//!   `fixtures/router/pipeline.so`, checked against the hash pinned in `fixtures/pins.env`
//!   (set `PIPELINE_ROUTER_SO` to use another file);
//! - Pipeline's `test-hook`, for hooked tokens: `scripts/fetch-pipeline.sh programs` builds
//!   it into `fixtures/pipeline/programs/target/deploy` (set `PIPELINE_TEST_HOOK_SO`).
//!
//! Every helper sends real transactions through the router or to the strategy, the same
//! instructions a front end, an LP or a desk would send on devnet.

#![allow(dead_code)]

pub mod kamino;

use std::path::PathBuf;

use anchor_lang::{AccountDeserialize, AnchorDeserialize, Discriminator};
use base64::Engine;
use lending_amm::config::{LentMint, LENT_MINTS};
use lending_amm::{InitParams, LendingAmmMarket, StrategyError};
use litesvm::types::TransactionMetadata;
use litesvm::LiteSVM;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey, TradeMode};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

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
    Pubkey::new_from_array(lending_amm::ID.to_bytes())
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
        dir.join("lending_amm.so"),
        "Build it first: cargo build-sbf --manifest-path programs/lending-amm/Cargo.toml",
    )
}

/// The Pipeline router's compiled program.
pub fn router_so() -> Vec<u8> {
    let path = std::env::var("PIPELINE_ROUTER_SO")
        .map(PathBuf::from)
        .unwrap_or_else(|_| crate_dir().join("../../fixtures/router/pipeline.so"));
    read_program(path, "Run `scripts/fetch-router.sh` first.")
}

/// Pipeline's `test-hook` transfer hook (Apache-2.0), built by `scripts/fetch-pipeline.sh`.
pub fn test_hook_so() -> Vec<u8> {
    let path = std::env::var("PIPELINE_TEST_HOOK_SO")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            crate_dir().join("../../fixtures/pipeline/programs/target/deploy/test_hook.so")
        });
    read_program(path, "Run `scripts/fetch-pipeline.sh programs` first.")
}

/// Where `test-hook` is loaded in the tests.
pub fn test_hook_id() -> Pubkey {
    Pubkey::new_from_array([0x7e; 32])
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

/// The cluster's lent mints, as the client's keys: (mint, collateral mint, reserve).
pub fn lent(i: usize) -> (Pubkey, Pubkey, Pubkey) {
    let entry: &LentMint = &LENT_MINTS[i];
    (
        ck(&entry.mint),
        ck(&entry.collateral_mint),
        ck(&entry.reserve),
    )
}

/// WSOL, the first lent mint.
pub fn wsol() -> Pubkey {
    lent(0).0
}

/// The lending AMM's addresses for a market (docs/spec/lending-pool.md, "Addresses").
#[derive(Clone, Copy, Debug)]
pub struct Addresses {
    pub market_state: Pubkey,
    pub authority: Pubkey,
    pub vaults: [Pubkey; 2],
    pub ctoken_account: Pubkey,
    pub lp_mint: Pubkey,
}

/// The market state PDA `["market", other_mint, lent_mint, lp_fee_bps LE]`.
pub fn market_state_address(mints: [Pubkey; 2], lent_index: u8, lp_fee_bps: u16) -> Pubkey {
    let lent = mints[(lent_index & 1) as usize];
    let other = mints[1 - (lent_index & 1) as usize];
    Pubkey::find_program_address(
        &[
            b"market",
            other.as_ref(),
            lent.as_ref(),
            &lp_fee_bps.to_le_bytes(),
        ],
        &strategy_id(),
    )
    .0
}

/// Every PDA of a market state.
pub fn addresses_of(market_state: &Pubkey, mints: [Pubkey; 2]) -> Addresses {
    let program = strategy_id();
    let find = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &program).0;
    Addresses {
        market_state: *market_state,
        authority: find(&[b"authority", market_state.as_ref()]),
        vaults: [
            find(&[b"vault", market_state.as_ref(), mints[0].as_ref()]),
            find(&[b"vault", market_state.as_ref(), mints[1].as_ref()]),
        ],
        ctoken_account: find(&[b"ctoken", market_state.as_ref()]),
        lp_mint: find(&[b"lp_mint", market_state.as_ref()]),
    }
}

/// `pipeline_init_market`'s own accounts, after the router's four, in the order
/// `metadata.json`'s `init.accounts` lists them.
pub fn init_accounts(
    addresses: &Addresses,
    mints: [Pubkey; 2],
    token_programs: [Pubkey; 2],
    collateral_mint: Pubkey,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(mints[0], false),
        AccountMeta::new_readonly(mints[1], false),
        AccountMeta::new_readonly(addresses.authority, false),
        AccountMeta::new(addresses.vaults[0], false),
        AccountMeta::new(addresses.vaults[1], false),
        AccountMeta::new_readonly(collateral_mint, false),
        AccountMeta::new(addresses.ctoken_account, false),
        AccountMeta::new(addresses.lp_mint, false),
        AccountMeta::new_readonly(token_programs[0], false),
        AccountMeta::new_readonly(token_programs[1], false),
        AccountMeta::new_readonly(TOKEN, false),
    ]
}

/// The creation parameters, Borsh-encoded as `create_market`'s `init_data`.
pub fn init_data(params: &InitParams) -> Vec<u8> {
    borsh::to_vec(params).unwrap()
}

/// A market recorded by the router.
#[derive(Clone, Debug)]
pub struct Market {
    /// The router's Market account, the address integrators and `pipeline-check` use.
    pub market: Pubkey,
    pub addresses: Addresses,
    pub market_state: Pubkey,
    pub mints: [Pubkey; 2],
    pub token_programs: [Pubkey; 2],
    pub vaults: [Pubkey; 2],
    pub lent_index: usize,
    /// Accounts every transfer of each mint needs for its transfer hook, if any.
    pub hook_accounts: [Vec<AccountMeta>; 2],
    /// The transaction that created it, for its logs and compute.
    pub created: TransactionMetadata,
}

impl Market {
    pub fn other_index(&self) -> usize {
        1 - self.lent_index
    }
}

/// What to create a market from: two mints with their token programs, in the creator's
/// order, and the creation parameters.
#[derive(Clone, Debug)]
pub struct MarketSpec {
    pub mints: [(Pubkey, Pubkey); 2],
    pub params: InitParams,
}

/// The router's `create_market` for the lending AMM.
pub fn create_market_instruction(
    creator: &Pubkey,
    market_state: &Pubkey,
    init_data: Vec<u8>,
    strategy_accounts: Vec<AccountMeta>,
) -> Instruction {
    client::create_market(&client::CreateMarket {
        creator: *creator,
        strategy_program: strategy_id(),
        market_state: *market_state,
        market_state_signs: false,
        init_data,
        max_creator_lamports: SOL,
        strategy_accounts,
    })
}

/// A VM with the router configured, this strategy deployed and registered, and the Kamino
/// accounts of the cluster this build lends on, dumped from that cluster, with the clock
/// just past the slot they were read at.
pub struct Env {
    pub svm: LiteSVM,
    /// Pays for everything, is the router's admin and the strategy's upgrade authority, and
    /// is the mint authority of the mints the tests create.
    pub admin: Keypair,
    /// The Kamino accounts in the VM, as dumped.
    pub kamino: kamino::Fixtures,
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
        let fixtures = kamino::Fixtures::of_build();
        // The lent mints, their reserves, lending market, collateral mints and token
        // accounts, as the cluster had them at one slot; the clock then starts one slot and
        // one second after it, so Kamino's own timestamps are never in the future.
        fixtures.install(&mut svm);
        let mut env = Env {
            svm,
            admin,
            kamino: fixtures,
        };
        env.set_clock(env.kamino.slot + 1, env.kamino.unix_timestamp + 1);

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

    /// Runs an instruction in simulation and returns its metadata.
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

    /// Runs an instruction in simulation and returns its return data.
    pub fn simulate(&self, instruction: Instruction) -> Result<Vec<u8>, String> {
        self.simulate_meta(instruction)
            .map(|meta| meta.return_data.data)
    }

    /// Writes an initialized mint straight into the VM, with no freeze authority.
    pub fn write_mint(
        &mut self,
        mint: &Pubkey,
        token_program: &Pubkey,
        decimals: u8,
        authority: Option<Pubkey>,
    ) {
        let mut data = vec![0u8; MINT_LEN];
        if let Some(authority) = authority {
            data[..4].copy_from_slice(&[1, 0, 0, 0]);
            data[4..36].copy_from_slice(authority.as_ref());
        }
        data[44] = decimals;
        data[45] = 1;
        let account = solana_account::Account {
            lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: *token_program,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(*mint, account).unwrap();
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

    /// A Token-2022 mint whose transfers run Pipeline's `test-hook`, which approves every
    /// transfer, with the hook's validation account set up. Returns the mint and the
    /// accounts every transfer of it needs.
    pub fn create_hooked_mint(&mut self) -> (Pubkey, Vec<AccountMeta>) {
        let hook = test_hook_id();
        if self.svm.get_account(&hook).is_none() {
            self.svm.add_program(hook, &test_hook_so()).unwrap();
        }
        let mint = self.create_mint_with(
            &TOKEN_2022,
            MintOptions {
                transfer_hook: Some(hook),
                ..MintOptions::default()
            },
        );
        let validation =
            Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], &hook).0;
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
        let accounts = vec![
            AccountMeta::new_readonly(validation, false),
            AccountMeta::new_readonly(hook, false),
        ];
        (mint, accounts)
    }

    /// A Token-2022 mint written straight into the VM, carrying one zeroed extension entry
    /// per `(type, value length)`: how the tests give a mint an extension Token-2022 would
    /// need its own setup for, or one it has not defined yet.
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

    /// A WSOL-lent market spec: a new SPL Token mint as the other side, at index 0, and
    /// WSOL lent at index 1, as the metadata's `init` form orders them.
    pub fn wsol_market_spec(&mut self, lp_fee_bps: u16) -> MarketSpec {
        let other = self.create_mint(&TOKEN);
        MarketSpec {
            mints: [(other, TOKEN), (wsol(), TOKEN)],
            params: InitParams {
                lent_index: 1,
                lp_fee_bps,
            },
        }
    }

    /// The `create_market` instruction for `spec`, with the strategy accounts changed by
    /// `change`, and the market state it should create.
    pub fn create_instruction(
        &self,
        spec: &MarketSpec,
        init_data: Vec<u8>,
        change: impl FnOnce(&mut Vec<AccountMeta>),
    ) -> (Instruction, Addresses) {
        let mints = [spec.mints[0].0, spec.mints[1].0];
        let token_programs = [spec.mints[0].1, spec.mints[1].1];
        let lent_index = (spec.params.lent_index & 1) as usize;
        let state = market_state_address(mints, spec.params.lent_index, spec.params.lp_fee_bps);
        let addresses = addresses_of(&state, mints);
        let collateral = LENT_MINTS
            .iter()
            .find(|entry| ck(&entry.mint) == mints[lent_index])
            .map(|entry| ck(&entry.collateral_mint))
            .unwrap_or_else(|| lent(0).1);
        let mut accounts = init_accounts(&addresses, mints, token_programs, collateral);
        change(&mut accounts);
        let create = create_market_instruction(&self.admin.pubkey(), &state, init_data, accounts);
        (create, addresses)
    }

    /// The router's `init_fee_account` for each of a market's mints.
    pub fn fee_account_instructions(
        &self,
        market_state: &Pubkey,
        mints: [(Pubkey, Pubkey); 2],
    ) -> Vec<Instruction> {
        let market = pda::market(&strategy_id(), market_state);
        mints
            .iter()
            .map(|(mint, token_program)| {
                client::init_fee_account(&self.admin.pubkey(), &market, mint, token_program)
            })
            .collect()
    }

    /// Creates a market through the router's `create_market` and makes both mints sellable
    /// with `init_fee_account`, in one transaction, with no deposit yet.
    pub fn create_market(&mut self, spec: &MarketSpec) -> Result<Market, String> {
        self.create_market_with(spec, init_data(&spec.params), |_| {}, vec![], &[])
    }

    /// [`Env::create_market`] with raw `init_data`, the strategy accounts changed by
    /// `change`, and `after` appended to the transaction (signed by `signers`).
    pub fn create_market_with(
        &mut self,
        spec: &MarketSpec,
        init_data: Vec<u8>,
        change: impl FnOnce(&mut Vec<AccountMeta>),
        after: Vec<Instruction>,
        signers: &[&Keypair],
    ) -> Result<Market, String> {
        let (create, addresses) = self.create_instruction(spec, init_data, change);
        let mut instructions = vec![create];
        instructions.extend(self.fee_account_instructions(&addresses.market_state, spec.mints));
        instructions.extend(after);
        let created = self.send_meta(&instructions, signers)?;
        Ok(self.market_of(spec, addresses, created))
    }

    fn market_of(
        &self,
        spec: &MarketSpec,
        addresses: Addresses,
        created: TransactionMetadata,
    ) -> Market {
        let mints = [spec.mints[0].0, spec.mints[1].0];
        Market {
            market: pda::market(&strategy_id(), &addresses.market_state),
            addresses,
            market_state: addresses.market_state,
            mints,
            token_programs: [spec.mints[0].1, spec.mints[1].1],
            vaults: addresses.vaults,
            lent_index: (spec.params.lent_index & 1) as usize,
            hook_accounts: [
                self.hook_accounts_of(&mints[0]),
                self.hook_accounts_of(&mints[1]),
            ],
            created,
        }
    }

    /// The accounts a transfer of `mint` needs for `test-hook`, if it is hooked by it.
    fn hook_accounts_of(&self, mint: &Pubkey) -> Vec<AccountMeta> {
        let hook = test_hook_id();
        let validation =
            Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], &hook).0;
        if self.svm.get_account(&validation).is_some() {
            vec![
                AccountMeta::new_readonly(validation, false),
                AccountMeta::new_readonly(hook, false),
            ]
        } else {
            vec![]
        }
    }

    /// Creates a market and makes its first deposit, in one transaction, as the metadata
    /// describes: `create_market`, `init_fee_account` for each mint, `add_liquidity`. The
    /// LP is a new wallet funded with `funds` of each mint; amounts are by mint index.
    pub fn create_funded_market(
        &mut self,
        spec: &MarketSpec,
        amounts: [u64; 2],
    ) -> Result<(Market, Keypair), String> {
        let lp = Keypair::new();
        self.svm.airdrop(&lp.pubkey(), 10 * SOL).unwrap();
        for (i, (mint, token_program)) in spec.mints.iter().enumerate() {
            write_token_account(&mut self.svm, mint, token_program, &lp.pubkey(), amounts[i])
                .unwrap();
        }
        let (_, addresses) = self.create_instruction(spec, init_data(&spec.params), |_| {});
        let mut market = self.market_of(spec, addresses, TransactionMetadata::default());
        let add = self.add_liquidity_instruction(&market, &lp.pubkey(), amounts, 0);
        market =
            self.create_market_with(spec, init_data(&spec.params), |_| {}, vec![add], &[&lp])?;
        Ok((market, lp))
    }

    /// The lending AMM's `add_liquidity`, by `lp` from their associated token accounts,
    /// with `max` of each mint by mint index, and the hook accounts of both mints after.
    pub fn add_liquidity_instruction(
        &self,
        market: &Market,
        lp: &Pubkey,
        max: [u64; 2],
        min_lp: u64,
    ) -> Instruction {
        let mut data = anchor_discriminator("add_liquidity").to_vec();
        data.extend(borsh::to_vec(&(max[0], max[1], min_lp)).unwrap());
        let a = &market.addresses;
        let mut accounts = vec![
            AccountMeta::new(*lp, true),
            AccountMeta::new(market.market_state, false),
            AccountMeta::new(self.wallet_token_account(market, lp, 0), false),
            AccountMeta::new(self.wallet_token_account(market, lp, 1), false),
            AccountMeta::new(a.vaults[0], false),
            AccountMeta::new(a.vaults[1], false),
            AccountMeta::new_readonly(market.mints[0], false),
            AccountMeta::new_readonly(market.mints[1], false),
            AccountMeta::new(a.lp_mint, false),
            AccountMeta::new(lp_shares_account(lp, &market.market_state), false),
            AccountMeta::new_readonly(a.authority, false),
            AccountMeta::new_readonly(market.token_programs[0], false),
            AccountMeta::new_readonly(market.token_programs[1], false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(self.reserve_of(market), false),
        ];
        for hooks in &market.hook_accounts {
            accounts.extend(hooks.iter().cloned());
        }
        Instruction::new_with_bytes(strategy_id(), &data, accounts)
    }

    /// `add_liquidity` sent by `lp`.
    pub fn add_liquidity(
        &mut self,
        market: &Market,
        lp: &Keypair,
        max: [u64; 2],
        min_lp: u64,
    ) -> Result<TransactionMetadata, String> {
        let add = self.add_liquidity_instruction(market, &lp.pubkey(), max, min_lp);
        self.send_meta(&[add], &[lp])
    }

    /// A wallet's associated token account for a market's mint `i`.
    pub fn wallet_token_account(&self, market: &Market, wallet: &Pubkey, i: usize) -> Pubkey {
        pda::associated_token(wallet, &market.mints[i], &market.token_programs[i])
    }

    /// The lending AMM's market state, decoded with its discriminator checked.
    pub fn market_state(&self, market_state: &Pubkey) -> LendingAmmMarket {
        let data = self
            .svm
            .get_account(market_state)
            .expect("market state")
            .data;
        LendingAmmMarket::try_deserialize(&mut data.as_slice()).expect("a lending AMM market")
    }

    /// The market's share count `N`: the LP mint's supply plus the locked minimum.
    pub fn share_count(&self, market: &Market) -> u64 {
        self.mint_supply(&market.addresses.lp_mint) + lending_amm::config::MINIMUM_LIQUIDITY
    }

    /// A mint's supply.
    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        let data = self.svm.get_account(mint).expect("mint").data;
        u64::from_le_bytes(data[36..44].try_into().unwrap())
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
            AccountMeta::new_readonly(market.vaults[input & 1], false),
            AccountMeta::new_readonly(market.mints[input & 1], false),
            AccountMeta::new_readonly(market.mints[output & 1], false),
            AccountMeta::new_readonly(market.token_programs[input & 1], false),
            AccountMeta::new_readonly(market.token_programs[output & 1], false),
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
        assert!(result.complete, "the lending AMM resolves in one round");
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

    /// The strategy's `pipeline_quote` metadata, in simulation.
    pub fn quote_meta(
        &self,
        market: &Market,
        trade: &TradeRequest,
    ) -> Result<TransactionMetadata, String> {
        let strategy_accounts = self.resolve_accounts(market, trade)?;
        let mut accounts = self.read_accounts(market, trade);
        accounts.extend(
            strategy_accounts
                .iter()
                .map(|a| AccountMeta::new_readonly(a.pubkey, false)),
        );
        let instruction = strategy_call(client::interface::discriminator::QUOTE, trade, accounts);
        self.simulate_meta(instruction)
    }

    /// The strategy's `pipeline_quote`, in vault amounts (before Pipeline's fee).
    pub fn quote(&self, market: &Market, trade: &TradeRequest) -> Result<QuoteResult, String> {
        let data = self.quote_meta(market, trade)?.return_data.data;
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

    /// A new wallet holding `amounts` of each of the market's mints, by mint index, plus
    /// some SOL.
    pub fn funded_wallet(&mut self, market: &Market, amounts: [u64; 2]) -> Keypair {
        let wallet = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), 10 * SOL).unwrap();
        for ((mint, token_program), amount) in
            market.mints.iter().zip(&market.token_programs).zip(amounts)
        {
            write_token_account(&mut self.svm, mint, token_program, &wallet.pubkey(), amount)
                .unwrap();
        }
        wallet
    }

    /// The router's `swap` instruction for an exact-in trade of `amount_in` of mint `input`
    /// for mint `output` by `trader`, with the strategy accounts resolved and every hook
    /// account forwarded.
    pub fn swap_instruction(
        &self,
        market: &Market,
        trader: &Pubkey,
        (input, output): (usize, usize),
        amount_in: u64,
        mode: TradeMode,
    ) -> Result<Instruction, String> {
        let trade = TradeRequest {
            mode,
            ..exact_in(input, output, amount_in)
        };
        let mut strategy_accounts = self.resolve_accounts(market, &trade)?;
        // The output mint's hook accounts follow the strategy's own, for its payout.
        strategy_accounts.extend(market.hook_accounts[output].iter().cloned());
        let accounts = client::SwapAccounts {
            trader: *trader,
            strategy_program: strategy_id(),
            market_state: market.market_state,
            trader_input: self.wallet_token_account(market, trader, input),
            trader_output: self.wallet_token_account(market, trader, output),
            input_vault: market.vaults[input],
            input_mint: market.mints[input],
            output_mint: market.mints[output],
            input_token_program: market.token_programs[input],
            output_token_program: market.token_programs[output],
            integrator_fee_account: None,
            strategy_accounts,
            input_hook_accounts: market.hook_accounts[input].clone(),
        };
        let args = client::SwapArgs {
            mode,
            amount_in: if mode == TradeMode::ExactIn {
                amount_in
            } else {
                u64::MAX
            },
            amount_out: if mode == TradeMode::ExactIn {
                0
            } else {
                amount_in
            },
            min_amount_out: 0,
            integrator_fee_bps: 0,
            input_hook_accounts: market.hook_accounts[input].len() as u8,
            extra: vec![],
        };
        Ok(client::swap(&accounts, &args))
    }

    /// An exact-in swap through the router of `amount_in` of mint `input` for mint
    /// `output`, by `trader` from their associated token accounts.
    pub fn swap(
        &mut self,
        market: &Market,
        trader: &Keypair,
        sides: (usize, usize),
        amount_in: u64,
    ) -> Result<client::SwapResult, String> {
        self.swap_meta(market, trader, sides, amount_in)
            .and_then(|meta| borsh::from_slice(&meta.return_data.data).map_err(|e| e.to_string()))
    }

    /// [`Env::swap`], returning the transaction's metadata.
    pub fn swap_meta(
        &mut self,
        market: &Market,
        trader: &Keypair,
        sides: (usize, usize),
        amount_in: u64,
    ) -> Result<TransactionMetadata, String> {
        let swap = self.swap_instruction(
            market,
            &trader.pubkey(),
            sides,
            amount_in,
            TradeMode::ExactIn,
        )?;
        self.send_meta(&[swap], &[trader])
    }

    /// A token account's balance.
    pub fn balance(&self, account: &Pubkey) -> u64 {
        let data = self.svm.get_account(account).expect("token account").data;
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }

    /// A token account's balance, or 0 when it does not exist.
    pub fn balance_or_zero(&self, account: &Pubkey) -> u64 {
        self.svm
            .get_account(account)
            .filter(|a| a.data.len() >= 72)
            .map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
            .unwrap_or(0)
    }

    /// Sends `amount` of a market's mint `i` straight into account `to` from a fresh
    /// wallet: a donation, outside any instruction of the market's.
    pub fn donate(&mut self, market: &Market, i: usize, to: &Pubkey, amount: u64) {
        let donor = self.funded_wallet(market, [amount, amount]);
        let from = self.wallet_token_account(market, &donor.pubkey(), i);
        let mut data = vec![12u8];
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(self.mint_decimals(&market.mints[i]));
        let mut accounts = vec![
            AccountMeta::new(from, false),
            AccountMeta::new_readonly(market.mints[i], false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(donor.pubkey(), true),
        ];
        accounts.extend(market.hook_accounts[i].iter().cloned());
        let transfer = Instruction::new_with_bytes(market.token_programs[i], &data, accounts);
        self.send(&[transfer], &[&donor]).unwrap();
    }

    /// A mint's decimals.
    pub fn mint_decimals(&self, mint: &Pubkey) -> u8 {
        self.svm.get_account(mint).expect("mint").data[44]
    }

    /// Sets the clock's slot and Unix time.
    pub fn set_clock(&mut self, slot: u64, unix_timestamp: i64) {
        self.svm.warp_to_slot(slot);
        let mut clock: solana_clock::Clock = self.svm.get_sysvar();
        clock.slot = slot;
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    /// The clock.
    pub fn clock(&self) -> solana_clock::Clock {
        self.svm.get_sysvar()
    }

    /// Moves the clock on by `slots` slots and `seconds` seconds.
    pub fn advance_clock(&mut self, slots: u64, seconds: i64) {
        let clock = self.clock();
        self.set_clock(clock.slot + slots, clock.unix_timestamp + seconds);
    }

    /// Deploys klend's program for this build's cluster, at its address.
    pub fn load_klend(&mut self) {
        if self
            .svm
            .get_account(&kamino::klend())
            .is_none_or(|a| !a.executable)
        {
            self.svm
                .add_program(kamino::klend(), &kamino::klend_so())
                .unwrap();
        }
    }

    /// The Kamino reserve a market's lent side lends to.
    pub fn reserve_of(&self, market: &Market) -> Pubkey {
        let lent_mint = market.mints[market.lent_index];
        LENT_MINTS
            .iter()
            .find(|entry| ck(&entry.mint) == lent_mint)
            .map(|entry| ck(&entry.reserve))
            .expect("a listed lent mint")
    }

    /// The index in `LENT_MINTS` of a market's lent mint.
    pub fn lent_entry_of(&self, market: &Market) -> usize {
        let lent_mint = market.mints[market.lent_index];
        LENT_MINTS
            .iter()
            .position(|entry| ck(&entry.mint) == lent_mint)
            .expect("a listed lent mint")
    }

    /// The raw bytes of an account.
    pub fn data(&self, address: &Pubkey) -> Vec<u8> {
        self.svm.get_account(address).expect("account").data
    }

    /// Overwrites part of an account's data, as the tests make Kamino states by editing
    /// cloned accounts.
    pub fn patch(&mut self, address: &Pubkey, offset: usize, bytes: &[u8]) {
        let mut account = self.svm.get_account(address).expect("account");
        account.data[offset..offset + bytes.len()].copy_from_slice(bytes);
        self.svm.set_account(*address, account).unwrap();
    }

    /// Gives a market `ctokens` cTokens the way a lending instruction would leave them: in its
    /// cToken account and recorded in its market state. No instruction lends yet
    /// ([Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80)),
    /// so the tests write both.
    pub fn give_ctokens(&mut self, market: &Market, ctokens: u64) {
        let account = market.addresses.ctoken_account;
        let held = self.balance(&account);
        self.patch(&account, 64, &(held + ctokens).to_le_bytes());
        let state = market.market_state;
        let recorded = self.market_state(&state).ctokens;
        self.patch(
            &state,
            lending_amm::state::layout::CTOKENS,
            &(recorded + ctokens).to_le_bytes(),
        );
    }

    /// A wallet's token account of `mint` (SPL Token) holding `amount`, for Kamino's mints.
    pub fn spl_account(&mut self, wallet: &Pubkey, mint: &Pubkey, amount: u64) -> Pubkey {
        write_token_account(&mut self.svm, mint, &TOKEN, wallet, amount).unwrap()
    }
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

/// The LP's shares account `["lp_shares", market_state, lp]`, where `add_liquidity` mints
/// their shares.
pub fn lp_shares_account(lp: &Pubkey, market_state: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"lp_shares", market_state.as_ref(), lp.as_ref()],
        &strategy_id(),
    )
    .0
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

/// Anchor's instruction discriminator, `sha256("global:<name>")[..8]`.
pub fn anchor_discriminator(name: &str) -> [u8; 8] {
    client::instruction_discriminator(name)
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

/// Fails unless `result` failed with Anchor's own error `number`.
pub fn assert_anchor_error<T: std::fmt::Debug>(result: Result<T, String>, number: u32) {
    match result {
        Ok(value) => panic!("expected Anchor error {number}, but it passed: {value:?}"),
        Err(failure) => assert!(
            failure.contains(&format!("Custom({number})")),
            "expected Anchor error {number}, got:\n{failure}"
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

/// The events of type `E` the strategy logged.
pub fn events<E: Discriminator + AnchorDeserialize>(logs: &[String]) -> Vec<E> {
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
