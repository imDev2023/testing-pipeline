//! Graduating into the buy wall AMM from another program: the stand-in launchpad
//! (`programs/test-programs/stand-in-launchpad`, built into `fixtures/test-programs` by
//! `scripts/build-programs.sh`) calls `pipeline_seed_liquidity` with its seeder PDA
//! signing, and the same transaction records the market with the router's
//! `register_existing_market` and `init_fee_account` for each mint, as a launchpad does
//! (docs/spec/pool4-for-solana.md, "Creating a market").

use std::path::PathBuf;

use anchor_lang::{AnchorDeserialize, InstructionData};
use buy_wall_amm::InitParams;
use pipeline_client::interface::SeedRequest;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use stand_in_launchpad::Graduation;

use super::{strategy_call, strategy_id, write_token_account, Env, Market, SOL, TOKEN, WSOL};

/// The most SOL a graduation lends the strategy for rent.
pub const MAX_PAYER_LAMPORTS: u64 = SOL / 10;

/// The stand-in launchpad's program address.
pub fn launchpad_id() -> Pubkey {
    stand_in_launchpad::ID
}

/// The launchpad's compiled program, from where `scripts/build-programs.sh` writes it:
/// `$TEST_PROGRAMS_DIR`, else `$FIXTURES_DIR/test-programs`, else `fixtures/test-programs`.
pub fn launchpad_so() -> Vec<u8> {
    let dir = std::env::var("TEST_PROGRAMS_DIR")
        .map(PathBuf::from)
        .or_else(|_| {
            std::env::var("FIXTURES_DIR").map(|dir| PathBuf::from(dir).join("test-programs"))
        })
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/test-programs")
        });
    let path = dir.join("stand_in_launchpad.so");
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Build it first: scripts/build-programs.sh test-programs/stand-in-launchpad",
            path.display()
        )
    })
}

/// The buy wall AMM's PDA for a market of `token_mint` seeded by `seeder`:
/// `["seeded", seeder, token_mint, wsol_mint]` (docs/spec/pool4-for-solana.md, "Addresses").
pub fn seeded_market_state(seeder: &Pubkey, token_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"seeded",
            seeder.as_ref(),
            token_mint.as_ref(),
            WSOL.as_ref(),
        ],
        &strategy_id(),
    )
    .0
}

/// A creator's launch on the stand-in launchpad: its seeder and the seeder's escrows (its
/// associated token accounts) of the token and of wrapped SOL.
pub struct Launch {
    pub creator: Keypair,
    pub seeder: Pubkey,
    pub token_mint: Pubkey,
    pub token_program: Pubkey,
    pub token_escrow: Pubkey,
    pub sol_escrow: Pubkey,
}

impl Launch {
    /// The market state this launch's graduation creates.
    pub fn market_state(&self) -> Pubkey {
        seeded_market_state(&self.seeder, &self.token_mint)
    }

    /// The addresses of the market this launch's graduation creates.
    pub fn market(&self) -> Market {
        Market::addresses(self.market_state(), self.token_mint, self.token_program)
    }
}

/// A graduation that landed.
pub struct Graduated {
    pub market: Market,
    /// The launchpad's return data: the strategy's `SeedResult` and what left each escrow.
    pub graduation: Graduation,
    pub logs: Vec<String>,
}

impl Env {
    /// Loads the stand-in launchpad, once.
    pub fn add_launchpad(&mut self) {
        if self.svm.get_account(&launchpad_id()).is_none() {
            self.svm
                .add_program(launchpad_id(), &launchpad_so())
                .unwrap();
        }
    }

    /// A new launch of `token_mint` whose escrows hold `tokens` and `lamports` of wrapped
    /// SOL, by a creator with SOL. An escrow of 0 is an empty token account.
    pub fn launch(
        &mut self,
        token_mint: Pubkey,
        token_program: Pubkey,
        tokens: u64,
        lamports: u64,
    ) -> Launch {
        self.add_launchpad();
        let creator = Keypair::new();
        let seeder = stand_in_launchpad::seeder_address(&creator.pubkey());
        self.launch_with_seeder(creator, seeder, token_mint, token_program, tokens, lamports)
    }

    /// [`Env::launch`] with the creator's own wallet as its seeder, for calling
    /// `pipeline_seed_liquidity` directly, without the launchpad.
    pub fn wallet_launch(
        &mut self,
        token_mint: Pubkey,
        token_program: Pubkey,
        tokens: u64,
        lamports: u64,
    ) -> Launch {
        let creator = Keypair::new();
        let seeder = creator.pubkey();
        self.launch_with_seeder(creator, seeder, token_mint, token_program, tokens, lamports)
    }

    fn launch_with_seeder(
        &mut self,
        creator: Keypair,
        seeder: Pubkey,
        token_mint: Pubkey,
        token_program: Pubkey,
        tokens: u64,
        lamports: u64,
    ) -> Launch {
        self.svm.airdrop(&creator.pubkey(), 10 * SOL).unwrap();
        let token_escrow = pda::associated_token(&seeder, &token_mint, &token_program);
        if write_token_account(&mut self.svm, &token_mint, &token_program, &seeder, tokens).is_err()
        {
            // A mint the token program can't read (one a mint rule refuses) still gets an
            // escrow: a plain token account of the seeder's, written as bytes.
            assert_eq!(tokens, 0, "only an empty escrow of an unreadable mint");
            let mut data = vec![0u8; 165];
            data[..32].copy_from_slice(token_mint.as_ref());
            data[32..64].copy_from_slice(seeder.as_ref());
            data[108] = 1;
            let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
            self.svm
                .set_account(
                    token_escrow,
                    super::solana_account(lamports, data, token_program),
                )
                .unwrap();
        }
        write_token_account(&mut self.svm, &WSOL, &TOKEN, &seeder, lamports).unwrap();
        Launch {
            creator,
            seeder,
            token_mint,
            token_program,
            token_escrow,
            sol_escrow: pda::associated_token(&seeder, &WSOL, &TOKEN),
        }
    }

    /// `pipeline_seed_liquidity`'s accounts after the seeder, the payer and the system
    /// program, as the launchpad takes them: the market state, the LP recipient, mint, escrow
    /// and token program for the token and for wrapped SOL, the vault authority and both
    /// vaults, then the token's transfer-hook accounts.
    pub fn seed_liquidity_accounts(&self, launch: &Launch) -> Vec<AccountMeta> {
        let market = launch.market();
        let mut accounts = vec![
            AccountMeta::new(market.market_state, false),
            // A buy wall market issues no LP shares, so any account will do.
            AccountMeta::new_readonly(launch.creator.pubkey(), false),
            AccountMeta::new_readonly(launch.token_mint, false),
            AccountMeta::new(launch.token_escrow, false),
            AccountMeta::new_readonly(launch.token_program, false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new(launch.sol_escrow, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(market.vault_authority, false),
            AccountMeta::new(market.token_vault, false),
            AccountMeta::new(market.sol_vault, false),
        ];
        accounts.extend(self.hook_accounts(
            &launch.token_mint,
            launch.token_escrow,
            market.token_vault,
            launch.seeder,
        ));
        accounts
    }

    /// `pipeline_seed_liquidity` called directly, paid for by the admin, with the launch's
    /// seeder signing only if `seeder_signs`.
    pub fn seed_liquidity_ix(
        &self,
        launch: &Launch,
        seeder_signs: bool,
        request: &SeedRequest,
    ) -> Instruction {
        let rest = self.seed_liquidity_accounts(launch);
        let mut accounts = vec![
            AccountMeta::new_readonly(launch.seeder, seeder_signs),
            rest[0].clone(),
            AccountMeta::new(self.admin.pubkey(), true),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        ];
        accounts.extend(rest.into_iter().skip(1));
        strategy_call(
            client::interface::discriminator::SEED_LIQUIDITY,
            request,
            accounts,
        )
    }

    /// The launchpad's `graduate`: `pipeline_seed_liquidity` with `amounts` and `data`,
    /// through the given accounts.
    pub fn graduate_ix(
        &self,
        launch: &Launch,
        amounts: Vec<u64>,
        data: Vec<u8>,
        accounts: Vec<AccountMeta>,
    ) -> Instruction {
        let payer = stand_in_launchpad::payer_address(&launch.seeder);
        let mut metas = vec![
            AccountMeta::new(launch.creator.pubkey(), true),
            AccountMeta::new_readonly(launch.seeder, false),
            AccountMeta::new(payer, false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(strategy_id(), false),
        ];
        metas.extend(accounts);
        let data = stand_in_launchpad::instruction::Graduate {
            amounts,
            data,
            max_payer_lamports: MAX_PAYER_LAMPORTS,
        }
        .data();
        Instruction::new_with_bytes(launchpad_id(), &data, metas)
    }

    /// The router's `register_existing_market` (no info accounts after the market state),
    /// then `init_fee_account` for both mints, for a market state the strategy created
    /// itself.
    pub fn register_ixs(&self, payer: &Pubkey, market: &Market) -> Vec<Instruction> {
        std::iter::once(client::register_existing_market(
            payer,
            &strategy_id(),
            &market.market_state,
            vec![],
        ))
        .chain(
            market
                .mints()
                .iter()
                .zip(market.token_programs())
                .map(|(mint, program)| {
                    client::init_fee_account(payer, &market.market, mint, &program)
                }),
        )
        .collect()
    }

    /// The launchpad's `call_as_seeder`: `instruction` sent by the launchpad, with the
    /// launch's seeder signing wherever it appears among its accounts.
    pub fn call_as_seeder(
        &mut self,
        launch: &Launch,
        instruction: Instruction,
    ) -> Result<Vec<u8>, String> {
        let mut metas = vec![
            AccountMeta::new_readonly(launch.creator.pubkey(), true),
            AccountMeta::new_readonly(launch.seeder, false),
            AccountMeta::new_readonly(instruction.program_id, false),
        ];
        metas.extend(instruction.accounts.into_iter().map(|mut meta| {
            meta.is_signer = false;
            meta
        }));
        let data = stand_in_launchpad::instruction::CallAsSeeder {
            data: instruction.data,
        }
        .data();
        let call = Instruction::new_with_bytes(launchpad_id(), &data, metas);
        self.send(&[call], &[&launch.creator])
    }

    /// Graduates `launch` with `params`, taking `tokens` and `lamports`, and records the
    /// market with the router and both fee accounts, in one transaction signed by the
    /// launch's creator (the admin pays the fee).
    pub fn graduate(
        &mut self,
        launch: &Launch,
        params: &InitParams,
        tokens: u64,
        lamports: u64,
    ) -> Result<Graduated, String> {
        self.graduate_with(
            launch,
            vec![tokens, lamports],
            borsh::to_vec(params).unwrap(),
        )
    }

    /// [`Env::graduate`] with the seed request's `amounts` and `data` as given.
    pub fn graduate_with(
        &mut self,
        launch: &Launch,
        amounts: Vec<u64>,
        data: Vec<u8>,
    ) -> Result<Graduated, String> {
        let market = launch.market();
        let mut instructions =
            vec![self.graduate_ix(launch, amounts, data, self.seed_liquidity_accounts(launch))];
        instructions.extend(self.register_ixs(&launch.creator.pubkey(), &market));
        let creator = launch.creator.insecure_clone();
        let (_, logs) = self.send_logged(&instructions, &[&creator])?;
        let graduation = graduation_of(&logs);
        Ok(Graduated {
            market,
            graduation,
            logs,
        })
    }
}

/// The launchpad's `Graduation`, from its return data logged as "Program return: ...".
pub fn graduation_of(logs: &[String]) -> Graduation {
    use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};
    let prefix = format!("Program return: {} ", launchpad_id());
    let encoded = logs
        .iter()
        .find_map(|line| line.strip_prefix(&prefix))
        .expect("the launchpad's return data");
    Graduation::try_from_slice(&STANDARD.decode(encoded).unwrap()).unwrap()
}
