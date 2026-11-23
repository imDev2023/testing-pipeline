//! A small cluster in LiteSVM for Canary's tests: devnet's router, checked against the hash
//! pinned in `fixtures/pins.env` as `scripts/fetch-router.sh` checks it, Pipeline's
//! Apache-2.0 test strategies and transfer hook, and Canary's own fixture strategy, with
//! markets created through the router as anyone creates them on devnet. Canary then copies a market out of this cluster exactly as it copies one
//! from devnet, through an account source.
//!
//! Build the fixtures first, from the repo root:
//!
//! ```sh
//! source scripts/toolchain-env.sh
//! scripts/fetch-router.sh              # fixtures/router/pipeline.so
//! scripts/fetch-pipeline.sh programs   # fixtures/pipeline/programs/target/deploy/*.so
//! crates/canary/tests/fixtures/build.sh   # Canary's own fixture programs and the containment hook
//! ```

#![allow(dead_code)]

pub mod containment;
pub mod rows;
pub mod token2022;
#[allow(unused_imports)]
pub use token2022::*;

use std::path::PathBuf;

use litesvm::LiteSVM;
use pipeline_check::write_token_account;
use pipeline_client::{self as client, pda, pubkey, AccountMeta, Instruction, Pubkey};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const SOL: u64 = 1_000_000_000;
pub const TOKEN: Pubkey = client::TOKEN_PROGRAM_ID;
pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// `test-strategy-cp`'s address, which is also devnet's example constant-product strategy.
pub const CP: Pubkey = pubkey!("yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx");
/// `test-strategy-evil`'s address.
pub const EVIL: Pubkey = pubkey!("Dyn7Jwr9xtQxs4Nyiun58mTAh278SXyqWFX6331uvT72");
/// Where the tests deploy Canary's own fixture strategy (`tests/fixtures/strategy`).
pub const FIXTURE: Pubkey = pubkey!("CanaryFixtureStrategy1111111111111111111111");
/// Where the tests deploy Pipeline's Apache-2.0 `test-hook`, as Pipeline's own tests do.
pub const HOOK: Pubkey = pubkey!("BfAcC8daPZSS4iEYz1figEshePUr96gDFwtytn7DyNZ3");
pub const TOKEN_2022: Pubkey = client::TOKEN_2022_PROGRAM_ID;

/// The fixture strategy's modes (`tests/fixtures/strategy/src/lib.rs`).
pub mod mode {
    pub const FAIR: u8 = 0;
    pub const INSIDER_PAID_MORE: u8 = 1;
    pub const INSIDER_PAID_LESS: u8 = 2;
    pub const LAUNCH_TAX: u8 = 3;
    pub const CLOSES: u8 = 4;
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(path: PathBuf, hint: &str) -> Vec<u8> {
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}. {hint}", path.display()))
}

/// The router's bytes as devnet deploys them, refused unless their SHA-256 is the one
/// pinned in `fixtures/pins.env`.
pub fn router_so() -> Vec<u8> {
    let bytes = read(
        repo_root().join("fixtures/router/pipeline.so"),
        "Run scripts/fetch-router.sh first.",
    );
    let pins = String::from_utf8(read(repo_root().join("fixtures/pins.env"), "")).unwrap();
    let pinned = pins
        .lines()
        .find_map(|line| line.strip_prefix("ROUTER_SHA256="))
        .expect("fixtures/pins.env pins ROUTER_SHA256")
        .trim();
    let actual: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        actual, pinned,
        "fixtures/router/pipeline.so is not the pinned router; run scripts/fetch-router.sh"
    );
    bytes
}

/// One of Pipeline's test programs, built by `scripts/fetch-pipeline.sh programs`.
pub fn test_program(name: &str) -> Vec<u8> {
    read(
        repo_root().join(format!(
            "fixtures/pipeline/programs/target/deploy/{name}.so"
        )),
        "Run scripts/fetch-pipeline.sh programs first.",
    )
}

/// Canary's own fixture strategy, built by `tests/fixtures/build.sh`.
pub fn fixture_program() -> Vec<u8> {
    read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/strategy/target/deploy/canary_fixture_strategy.so"),
        "Run crates/canary/tests/fixtures/build.sh first.",
    )
}

pub fn set_upgrade_authority(svm: &mut LiteSVM, program: &Pubkey, authority: &Pubkey) {
    let address = pda::program_data(program);
    let mut account = svm.get_account(&address).expect("program data");
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(address, account).unwrap();
}

/// A market created through the router.
#[derive(Clone, Copy, Debug)]
pub struct Market {
    pub market: Pubkey,
    pub state: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
}

pub struct Cluster {
    pub svm: LiteSVM,
    pub admin: Keypair,
    listing_fee_recipient: Pubkey,
}

impl Default for Cluster {
    fn default() -> Self {
        Self::new()
    }
}

impl Cluster {
    /// The router with its config initialised as on devnet, at a devnet-like clock.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.warp_to_slot(520_000_000);
        let mut clock: solana_clock::Clock = svm.get_sysvar();
        clock.epoch = 1_200;
        clock.unix_timestamp = 1_794_000_000;
        svm.set_sysvar(&clock);
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000 * SOL).unwrap();
        svm.add_program(client::PROGRAM_ID, &router_so()).unwrap();
        set_upgrade_authority(&mut svm, &client::PROGRAM_ID, &admin.pubkey());
        let mut cluster = Cluster {
            svm,
            admin,
            listing_fee_recipient: Pubkey::new_unique(),
        };
        let ix = client::initialize_config(
            &cluster.admin.pubkey(),
            &client::ConfigArgs {
                listing_fee_lamports: 10_000_000,
                listing_fee_recipient: cluster.listing_fee_recipient,
                treasury_owner: Pubkey::new_unique(),
            },
        );
        cluster.send(&[ix], &[]);
        cluster
    }

    /// The admin's address: the router's admin, every test market's creator, and the mint
    /// authority and upgrade authority of what the tests create.
    pub fn admin_key(&self) -> Pubkey {
        self.admin.pubkey()
    }

    pub fn try_send(
        &mut self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<(), String> {
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
            .map(|_| ())
            .map_err(|failed| format!("{:?}\n{}", failed.err, failed.meta.logs.join("\n")))
    }

    pub fn send(&mut self, instructions: &[Instruction], signers: &[&Keypair]) {
        self.try_send(instructions, signers).unwrap();
    }

    /// Deploys and registers one of Pipeline's test strategies, unless it already is.
    pub fn register(&mut self, program: &Pubkey, so_name: &str) {
        if self.svm.get_account(&pda::strategy(program)).is_some() {
            return;
        }
        self.register_bytes(program, &test_program(so_name));
    }

    /// Deploys and registers a strategy program from its bytes.
    pub fn register_bytes(&mut self, program: &Pubkey, bytes: &[u8]) {
        if self.svm.get_account(&pda::strategy(program)).is_some() {
            return;
        }
        self.svm.add_program(*program, bytes).unwrap();
        let admin = self.admin.pubkey();
        set_upgrade_authority(&mut self.svm, program, &admin);
        let ix = client::register_strategy(
            &admin,
            &admin,
            program,
            &self.listing_fee_recipient,
            "https://example.com/strategy.json",
            u64::MAX,
        );
        self.send(&[ix], &[]);
    }

    /// A new SPL Token mint with the admin as its mint authority.
    pub fn create_mint(&mut self, decimals: u8) -> Pubkey {
        let mint = Keypair::new();
        let authority = self.admin.pubkey();
        let space = 82u64;
        let create = create_account(
            &authority,
            &mint.pubkey(),
            self.svm.minimum_balance_for_rent_exemption(space as usize),
            space,
            &TOKEN,
        );
        let init = spl_token_2022_interface::instruction::initialize_mint2(
            &TOKEN,
            &mint.pubkey(),
            &authority,
            None,
            decimals,
        )
        .unwrap();
        self.send(&[create, init], &[&mint]);
        mint.pubkey()
    }

    /// The wrapped SOL mint, written as the token program keeps it on every cluster.
    pub fn wrapped_sol(&mut self) -> Pubkey {
        if self.svm.get_account(&WSOL).is_none() {
            let mut data = vec![0u8; 82];
            data[36..44].copy_from_slice(&(500_000_000 * SOL).to_le_bytes());
            data[44] = 9;
            data[45] = 1;
            self.svm
                .set_account(
                    WSOL,
                    Account {
                        lamports: self.svm.minimum_balance_for_rent_exemption(82),
                        data,
                        owner: TOKEN,
                        executable: false,
                        rent_epoch: 0,
                    },
                )
                .unwrap();
        }
        WSOL
    }

    /// Sets a mint's supply, as minting outside the market would.
    pub fn set_supply(&mut self, mint: &Pubkey, supply: u64) {
        let mut account = self.svm.get_account(mint).unwrap();
        account.data[36..44].copy_from_slice(&supply.to_le_bytes());
        self.svm.set_account(*mint, account).unwrap();
    }

    pub fn give(&mut self, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
        write_token_account(&mut self.svm, mint, &TOKEN, owner, amount).unwrap()
    }

    pub fn token_balance(&self, account: &Pubkey) -> u64 {
        self.svm
            .get_account(account)
            .map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
            .unwrap_or(0)
    }

    /// A constant-product market on `test-strategy-cp` with `fee_bps` and the given reserves
    /// deposited, and both fee accounts created.
    pub fn cp_market(
        &mut self,
        mint_a: Pubkey,
        mint_b: Pubkey,
        fee_bps: u16,
        reserves: (u64, u64),
    ) -> Market {
        self.register(&CP, "test_strategy_cp");
        let pool = Pubkey::find_program_address(
            &[
                b"pool",
                mint_a.as_ref(),
                mint_b.as_ref(),
                &fee_bps.to_le_bytes(),
            ],
            &CP,
        )
        .0;
        let vault_a = pda::associated_token(&pool, &mint_a, &TOKEN);
        let vault_b = pda::associated_token(&pool, &mint_b, &TOKEN);
        let creator = self.admin.pubkey();
        let ix = client::create_market(&client::CreateMarket {
            creator,
            strategy_program: CP,
            market_state: pool,
            market_state_signs: false,
            init_data: borsh::to_vec(&fee_bps).unwrap(),
            max_creator_lamports: SOL,
            strategy_accounts: vec![
                AccountMeta::new_readonly(mint_a, false),
                AccountMeta::new_readonly(mint_b, false),
                AccountMeta::new(vault_a, false),
                AccountMeta::new(vault_b, false),
                AccountMeta::new_readonly(TOKEN, false),
                AccountMeta::new_readonly(TOKEN, false),
                AccountMeta::new_readonly(client::ASSOCIATED_TOKEN_PROGRAM_ID, false),
            ],
        });
        self.send(&[ix], &[]);
        let market = pda::market(&CP, &pool);
        self.send(
            &[
                client::init_fee_account(&creator, &market, &mint_a, &TOKEN),
                client::init_fee_account(&creator, &market, &mint_b, &TOKEN),
            ],
            &[],
        );
        if reserves == (0, 0) {
            return Market {
                market,
                state: pool,
                mint_a,
                mint_b,
            };
        }
        let lp = Keypair::new();
        self.svm.airdrop(&lp.pubkey(), SOL).unwrap();
        let lp_a = self.give(&mint_a, &lp.pubkey(), reserves.0);
        let lp_b = self.give(&mint_b, &lp.pubkey(), reserves.1);
        let mut data = client::instruction_discriminator("deposit").to_vec();
        data.extend_from_slice(&reserves.0.to_le_bytes());
        data.extend_from_slice(&reserves.1.to_le_bytes());
        let accounts = vec![
            AccountMeta::new_readonly(lp.pubkey(), true),
            AccountMeta::new(pool, false),
            AccountMeta::new(lp_a, false),
            AccountMeta::new(lp_b, false),
            AccountMeta::new(vault_a, false),
            AccountMeta::new(vault_b, false),
            AccountMeta::new_readonly(mint_a, false),
            AccountMeta::new_readonly(mint_b, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(TOKEN, false),
        ];
        self.send(&[Instruction::new_with_bytes(CP, &data, accounts)], &[&lp]);
        Market {
            market,
            state: pool,
            mint_a,
            mint_b,
        }
    }

    /// A deep wrapped SOL market on `test-strategy-cp`: 1,000 SOL against 1,000,000 tokens
    /// of a 6-decimal mint whose supply is 100 times the vault's.
    pub fn sol_cp_market(&mut self, fee_bps: u16) -> Market {
        let sol = self.wrapped_sol();
        let token = self.create_mint(6);
        let market = self.cp_market(sol, token, fee_bps, (1_000 * SOL, 1_000_000_000_000));
        self.set_supply(&token, 100_000_000_000_000);
        market
    }

    /// A market on `test-strategy-evil`, 1:1 with `reserve` of each mint in its vaults. Its
    /// behaviour is picked per trade by the first byte of `TradeRequest::extra`.
    pub fn evil_market(&mut self, reserve: u64) -> Market {
        self.register(&EVIL, "test_strategy_evil");
        let mint_a = self.wrapped_sol();
        let mint_b = self.create_mint(9);
        let state =
            Pubkey::find_program_address(&[b"evil", mint_a.as_ref(), mint_b.as_ref()], &EVIL).0;
        let vault_a = self.give(&mint_a, &state, reserve);
        let vault_b = self.give(&mint_b, &state, reserve);
        let creator = self.admin.pubkey();
        let ix = client::create_market(&client::CreateMarket {
            creator,
            strategy_program: EVIL,
            market_state: state,
            market_state_signs: false,
            init_data: vec![0],
            max_creator_lamports: SOL,
            strategy_accounts: vec![
                AccountMeta::new_readonly(mint_a, false),
                AccountMeta::new_readonly(mint_b, false),
                AccountMeta::new(vault_a, false),
                AccountMeta::new(vault_b, false),
            ],
        });
        self.send(&[ix], &[]);
        let market = pda::market(&EVIL, &state);
        self.send(
            &[
                client::init_fee_account(&creator, &market, &mint_a, &TOKEN),
                client::init_fee_account(&creator, &market, &mint_b, &TOKEN),
            ],
            &[],
        );
        Market {
            market,
            state,
            mint_a,
            mint_b,
        }
    }

    /// A market on Canary's fixture strategy in `mode`, 1,000 SOL against 1,000,000 tokens of
    /// a 6-decimal mint whose supply is 100 times the vault's, with `insider` as the one
    /// wallet the insider modes treat differently.
    pub fn fixture_market(&mut self, mode: u8, insider: Pubkey) -> Market {
        self.register_bytes(&FIXTURE, &fixture_program());
        let mint_a = self.wrapped_sol();
        let mint_b = self.create_mint(6);
        let state = Pubkey::find_program_address(
            &[b"state", mint_a.as_ref(), mint_b.as_ref(), &[mode]],
            &FIXTURE,
        )
        .0;
        let vault_a = self.give(&mint_a, &state, 1_000 * SOL);
        let vault_b = self.give(&mint_b, &state, 1_000_000_000_000);
        self.set_supply(&mint_b, 100_000_000_000_000);
        let mut init_data = vec![mode];
        init_data.extend_from_slice(insider.as_ref());
        let creator = self.admin.pubkey();
        let ix = client::create_market(&client::CreateMarket {
            creator,
            strategy_program: FIXTURE,
            market_state: state,
            market_state_signs: false,
            init_data,
            max_creator_lamports: SOL,
            strategy_accounts: vec![
                AccountMeta::new_readonly(mint_a, false),
                AccountMeta::new_readonly(mint_b, false),
                AccountMeta::new(vault_a, false),
                AccountMeta::new(vault_b, false),
            ],
        });
        self.send(&[ix], &[]);
        let market = pda::market(&FIXTURE, &state);
        self.send(
            &[
                client::init_fee_account(&creator, &market, &mint_a, &TOKEN),
                client::init_fee_account(&creator, &market, &mint_b, &TOKEN),
            ],
            &[],
        );
        Market {
            market,
            state,
            mint_a,
            mint_b,
        }
    }

    /// A wrapped SOL market on `test-strategy-cp` whose token is a Token-2022 mint with
    /// Pipeline's `test-hook` as its transfer hook, allowing only transfers into or out of the
    /// market's token vault and its fee account: wallet-to-wallet transfers are refused, as a
    /// contained token's are. 1,000 SOL against 1,000,000 tokens.
    pub fn hooked_market(&mut self) -> Market {
        self.register(&CP, "test_strategy_cp");
        if self.svm.get_account(&HOOK).is_none() {
            self.svm
                .add_program(HOOK, &test_program("test_hook"))
                .unwrap();
        }
        let sol = self.wrapped_sol();
        let token = self.create_hooked_mint(6);
        let fee_bps: u16 = 30;
        let pool = Pubkey::find_program_address(
            &[
                b"pool",
                sol.as_ref(),
                token.as_ref(),
                &fee_bps.to_le_bytes(),
            ],
            &CP,
        )
        .0;
        let market = pda::market(&CP, &pool);
        let vault_sol = pda::associated_token(&pool, &sol, &TOKEN);
        let vault_token = pda::associated_token(&pool, &token, &TOKEN_2022);
        let fee_token = pda::fee_account(&market, &token, &TOKEN_2022);
        let mut allowed = vault_token.to_bytes().to_vec();
        allowed.extend_from_slice(fee_token.as_ref());
        let whitelist = Pubkey::find_program_address(&[b"whitelist", token.as_ref()], &HOOK).0;
        let init_hook = Instruction::new_with_bytes(
            HOOK,
            &[b"tsthkini".as_slice(), &allowed].concat(),
            vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new(hook_validation(&token), false),
                AccountMeta::new(whitelist, false),
                AccountMeta::new_readonly(token, false),
                AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            ],
        );
        self.send(&[init_hook], &[]);
        let creator = self.admin.pubkey();
        let ix = client::create_market(&client::CreateMarket {
            creator,
            strategy_program: CP,
            market_state: pool,
            market_state_signs: false,
            init_data: borsh::to_vec(&fee_bps).unwrap(),
            max_creator_lamports: SOL,
            strategy_accounts: vec![
                AccountMeta::new_readonly(sol, false),
                AccountMeta::new_readonly(token, false),
                AccountMeta::new(vault_sol, false),
                AccountMeta::new(vault_token, false),
                AccountMeta::new_readonly(TOKEN, false),
                AccountMeta::new_readonly(TOKEN_2022, false),
                AccountMeta::new_readonly(client::ASSOCIATED_TOKEN_PROGRAM_ID, false),
            ],
        });
        self.send(&[ix], &[]);
        self.send(
            &[
                client::init_fee_account(&creator, &market, &sol, &TOKEN),
                client::init_fee_account(&creator, &market, &token, &TOKEN_2022),
            ],
            &[],
        );
        // The liquidity, through the strategy's `deposit`: the hook allows a transfer into
        // the vault.
        let (reserve_sol, reserve_token) = (1_000 * SOL, 1_000_000_000_000u64);
        let lp = Keypair::new();
        self.svm.airdrop(&lp.pubkey(), SOL).unwrap();
        let lp_sol =
            write_token_account(&mut self.svm, &sol, &TOKEN, &lp.pubkey(), reserve_sol).unwrap();
        let lp_token = write_token_account(
            &mut self.svm,
            &token,
            &TOKEN_2022,
            &lp.pubkey(),
            reserve_token,
        )
        .unwrap();
        let mut data = client::instruction_discriminator("deposit").to_vec();
        data.extend_from_slice(&reserve_sol.to_le_bytes());
        data.extend_from_slice(&reserve_token.to_le_bytes());
        let accounts = vec![
            AccountMeta::new_readonly(lp.pubkey(), true),
            AccountMeta::new(pool, false),
            AccountMeta::new(lp_sol, false),
            AccountMeta::new(lp_token, false),
            AccountMeta::new(vault_sol, false),
            AccountMeta::new(vault_token, false),
            AccountMeta::new_readonly(sol, false),
            AccountMeta::new_readonly(token, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
            AccountMeta::new_readonly(whitelist, false),
            AccountMeta::new_readonly(HOOK, false),
            AccountMeta::new_readonly(hook_validation(&token), false),
        ];
        self.send(&[Instruction::new_with_bytes(CP, &data, accounts)], &[&lp]);
        self.set_supply(&token, 100 * reserve_token);
        Market {
            market,
            state: pool,
            mint_a: sol,
            mint_b: token,
        }
    }

    /// A Token-2022 mint with `test-hook` as its transfer hook and the admin as its mint
    /// authority.
    pub fn create_hooked_mint(&mut self, decimals: u8) -> Pubkey {
        use spl_token_2022_interface::extension::ExtensionType;
        let mint = Keypair::new();
        let authority = self.admin.pubkey();
        let space =
            ExtensionType::try_calculate_account_len::<spl_token_2022_interface::state::Mint>(&[
                ExtensionType::TransferHook,
            ])
            .unwrap();
        let ixs = vec![
            create_account(
                &authority,
                &mint.pubkey(),
                self.svm.minimum_balance_for_rent_exemption(space),
                space as u64,
                &TOKEN_2022,
            ),
            spl_token_2022_interface::extension::transfer_hook::instruction::initialize(
                &TOKEN_2022,
                &mint.pubkey(),
                Some(authority),
                Some(HOOK),
            )
            .unwrap(),
            spl_token_2022_interface::instruction::initialize_mint2(
                &TOKEN_2022,
                &mint.pubkey(),
                &authority,
                None,
                decimals,
            )
            .unwrap(),
        ];
        self.send(&ixs, &[&mint]);
        mint.pubkey()
    }

    /// Gives a market a third mint in the router's record, with a vault holding `reserve`,
    /// as if the strategy had reported three mints when the market was created.
    pub fn add_third_mint(&mut self, market: &Market, reserve: u64) -> Pubkey {
        use borsh::BorshDeserialize;
        let mint = self.create_mint(9);
        let vault = self.give(&mint, &market.state, reserve);
        self.edit(&market.market, |data| {
            let mut record = client::Market::try_from_slice(&data[8..]).unwrap();
            record.mint_count = 3;
            record.mints[2] = mint;
            record.vaults[2] = vault;
            let mut bytes = client::account_discriminator("Market").to_vec();
            bytes.extend(borsh::to_vec(&record).unwrap());
            bytes.resize(data.len(), 0);
            *data = bytes;
        });
        mint
    }

    /// A market on `test-strategy-evil` between two tokens with a wrapped SOL third mint
    /// added to its record: buys from wrapped SOL pay out 1:1, and every sale back crashes,
    /// because the strategy indexes past its two vaults to find the output.
    pub fn evil_market_that_crashes_on_sale(&mut self, reserve: u64) -> Market {
        self.register(&EVIL, "test_strategy_evil");
        let mint_a = self.create_mint(9);
        let mint_b = self.create_mint(9);
        let state =
            Pubkey::find_program_address(&[b"evil", mint_a.as_ref(), mint_b.as_ref()], &EVIL).0;
        let vault_a = self.give(&mint_a, &state, reserve);
        let vault_b = self.give(&mint_b, &state, reserve);
        let creator = self.admin.pubkey();
        let ix = client::create_market(&client::CreateMarket {
            creator,
            strategy_program: EVIL,
            market_state: state,
            market_state_signs: false,
            init_data: vec![0],
            max_creator_lamports: SOL,
            strategy_accounts: vec![
                AccountMeta::new_readonly(mint_a, false),
                AccountMeta::new_readonly(mint_b, false),
                AccountMeta::new(vault_a, false),
                AccountMeta::new(vault_b, false),
            ],
        });
        self.send(&[ix], &[]);
        let market = Market {
            market: pda::market(&EVIL, &state),
            state,
            mint_a,
            mint_b,
        };
        let sol = self.wrapped_sol();
        let sol_vault = self.give(&sol, &state, reserve);
        self.edit(&market.market, |data| {
            use borsh::BorshDeserialize;
            let mut record = client::Market::try_from_slice(&data[8..]).unwrap();
            record.mint_count = 3;
            record.mints[2] = sol;
            record.vaults[2] = sol_vault;
            let mut bytes = client::account_discriminator("Market").to_vec();
            bytes.extend(borsh::to_vec(&record).unwrap());
            bytes.resize(data.len(), 0);
            *data = bytes;
        });
        market
    }

    /// Lets `seconds` pass on the cluster's clock, slot, epoch and Unix time together.
    pub fn pass_time(&mut self, seconds: u64) {
        let now: solana_clock::Clock = self.svm.get_sysvar();
        canary::clock::set(
            &mut self.svm,
            &canary::clock::after(&now, canary::config::Wait::Seconds(seconds)),
        );
    }

    /// Overwrites an account's data in place, keeping its owner and lamports.
    pub fn edit(&mut self, address: &Pubkey, edit: impl FnOnce(&mut Vec<u8>)) {
        let mut account = self.svm.get_account(address).expect("account exists");
        edit(&mut account.data);
        self.svm.set_account(*address, account).unwrap();
    }
}

/// The system program's create-account instruction, for tests that build their own accounts.
pub fn create_account_ix(
    from: &Pubkey,
    to: &Pubkey,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
) -> Instruction {
    create_account(from, to, lamports, space, owner)
}

/// The test hook's extra-account-meta list for `mint`.
pub fn hook_validation(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], &HOOK).0
}

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
