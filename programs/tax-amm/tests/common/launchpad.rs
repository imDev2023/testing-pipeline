//! Graduating into the tax AMM from another program: the stand-in launchpad
//! (`programs/test-programs/stand-in-launchpad`, built into `fixtures/test-programs` by
//! `scripts/build-programs.sh`) calls `pipeline_seed_liquidity` with its seeder PDA
//! signing, and the same transaction records the market with the router's
//! `register_existing_market` and `init_fee_account` for each mint, as a launchpad does
//! (docs/spec/tax-amm.md, "Creating a market").

use std::path::PathBuf;

use anchor_lang::{AnchorDeserialize, InstructionData};
use litesvm::types::TransactionMetadata;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use stand_in_launchpad::Graduation;
use tax_amm::InitParams;

use super::{
    ak, ck, init_data, strategy_id, tax_market_addresses, write_token_account, Env, Market, SOL,
};

/// The most SOL a graduation lends the strategy for rent.
pub const MAX_PAYER_LAMPORTS: u64 = SOL / 10;

/// The stand-in launchpad's program address.
pub fn launchpad_id() -> Pubkey {
    ck(&stand_in_launchpad::ID)
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

/// The tax AMM's PDA for a market seeded by `seeder` on `mints`, in their order:
/// `["seeded", seeder, mint_0, mint_1]` (docs/spec/tax-amm.md, "Addresses").
pub fn seeded_market_state(seeder: &Pubkey, mints: [Pubkey; 2]) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"seeded",
            seeder.as_ref(),
            mints[0].as_ref(),
            mints[1].as_ref(),
        ],
        &strategy_id(),
    )
    .0
}

/// A creator's launch on the stand-in launchpad: its seeder PDA and the seeder's escrow (its
/// associated token account) for each mint.
pub struct Launch {
    pub creator: Keypair,
    pub seeder: Pubkey,
    pub mints: [Pubkey; 2],
    pub token_programs: [Pubkey; 2],
    pub escrows: [Pubkey; 2],
}

impl Launch {
    /// The market state this launch's graduation creates.
    pub fn market_state(&self) -> Pubkey {
        seeded_market_state(&self.seeder, self.mints)
    }
}

/// A graduation that landed.
pub struct Graduated {
    pub market: Market,
    /// The launchpad's return data: the strategy's `SeedResult` and what left each escrow.
    pub graduation: Graduation,
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

    /// A new launch on `mints` whose escrows hold `escrowed` of each, by a creator with SOL.
    /// An escrow of 0 is an empty token account.
    pub fn launch(&mut self, mints: [(Pubkey, Pubkey); 2], escrowed: [u64; 2]) -> Launch {
        self.launch_by(Keypair::new(), mints, escrowed)
    }

    /// [`Env::launch`] by a given creator, whose address the launchpad's seeder PDA derives
    /// from.
    pub fn launch_by(
        &mut self,
        creator: Keypair,
        mints: [(Pubkey, Pubkey); 2],
        escrowed: [u64; 2],
    ) -> Launch {
        self.add_launchpad();
        let seeder = ck(&stand_in_launchpad::seeder_address(&ak(&creator.pubkey())));
        self.launch_with_seeder(creator, seeder, mints, escrowed)
    }

    /// [`Env::launch`] with the creator's own wallet as its seeder, for calling
    /// `pipeline_seed_liquidity` directly, without the launchpad.
    pub fn wallet_launch(&mut self, mints: [(Pubkey, Pubkey); 2], escrowed: [u64; 2]) -> Launch {
        let creator = Keypair::new();
        let seeder = creator.pubkey();
        self.launch_with_seeder(creator, seeder, mints, escrowed)
    }

    fn launch_with_seeder(
        &mut self,
        creator: Keypair,
        seeder: Pubkey,
        mints: [(Pubkey, Pubkey); 2],
        escrowed: [u64; 2],
    ) -> Launch {
        self.svm.airdrop(&creator.pubkey(), 10 * SOL).unwrap();
        let escrows = [0, 1].map(|i| {
            let (mint, token_program) = mints[i];
            let escrow = pda::associated_token(&seeder, &mint, &token_program);
            if escrowed[i] > 0 {
                write_token_account(&mut self.svm, &mint, &token_program, &seeder, escrowed[i])
                    .unwrap();
            } else {
                // An empty token account of the seeder's, written as bytes, so even a mint
                // the token program can't read (one a mint rule refuses) has an escrow.
                let mut data = vec![0u8; 165];
                data[..32].copy_from_slice(mint.as_ref());
                data[32..64].copy_from_slice(seeder.as_ref());
                data[108] = 1;
                let account = solana_account::Account {
                    lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
                    data,
                    owner: token_program,
                    executable: false,
                    rent_epoch: 0,
                };
                self.svm.set_account(escrow, account).unwrap();
            }
            escrow
        });
        Launch {
            creator,
            seeder,
            mints: mints.map(|(mint, _)| mint),
            token_programs: mints.map(|(_, program)| program),
            escrows,
        }
    }

    /// `pipeline_seed_liquidity`'s accounts after the seeder, the payer and the system
    /// program, as the launchpad takes them: the market state, the LP recipient, mint,
    /// escrow and token program per mint, the vault authority and the vaults, then the
    /// transfer-hook accounts both transfers need.
    pub fn seed_liquidity_accounts(&self, launch: &Launch) -> Vec<AccountMeta> {
        let market_state = launch.market_state();
        let (authority, vaults) = tax_market_addresses(&market_state, launch.mints);
        let mut accounts = vec![
            AccountMeta::new(market_state, false),
            // A tax market issues no LP shares, so any account will do.
            AccountMeta::new_readonly(launch.creator.pubkey(), false),
        ];
        for i in 0..2 {
            accounts.push(AccountMeta::new_readonly(launch.mints[i], false));
            accounts.push(AccountMeta::new(launch.escrows[i], false));
            accounts.push(AccountMeta::new_readonly(launch.token_programs[i], false));
        }
        accounts.push(AccountMeta::new_readonly(authority, false));
        accounts.push(AccountMeta::new(vaults[0], false));
        accounts.push(AccountMeta::new(vaults[1], false));
        for (i, vault) in vaults.into_iter().enumerate() {
            accounts.extend(self.hook_accounts(
                &launch.mints[i],
                launch.escrows[i],
                vault,
                launch.seeder,
            ));
        }
        accounts
    }

    /// `pipeline_seed_liquidity` called directly, paid for by the admin, with the launch's
    /// seeder signing only if `seeder_signs`.
    pub fn seed_liquidity_instruction(
        &self,
        launch: &Launch,
        seeder_signs: bool,
        request: &pipeline_client::interface::SeedRequest,
    ) -> Instruction {
        let rest = self.seed_liquidity_accounts(launch);
        let mut accounts = vec![
            AccountMeta::new_readonly(launch.seeder, seeder_signs),
            rest[0].clone(),
            AccountMeta::new(self.admin.pubkey(), true),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        ];
        accounts.extend(rest.into_iter().skip(1));
        super::strategy_call(
            client::interface::discriminator::SEED_LIQUIDITY,
            request,
            accounts,
        )
    }

    /// The launchpad's `graduate`: `pipeline_seed_liquidity` with `amounts` and `data`,
    /// through the given accounts.
    pub fn graduate_instruction(
        &self,
        launch: &Launch,
        amounts: [u64; 2],
        data: Vec<u8>,
        accounts: Vec<AccountMeta>,
    ) -> Instruction {
        let creator = launch.creator.pubkey();
        let payer = ck(&stand_in_launchpad::payer_address(&ak(&launch.seeder)));
        let mut metas = vec![
            AccountMeta::new(creator, true),
            AccountMeta::new_readonly(launch.seeder, false),
            AccountMeta::new(payer, false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(strategy_id(), false),
        ];
        metas.extend(accounts);
        let data = stand_in_launchpad::instruction::Graduate {
            amounts: amounts.to_vec(),
            data,
            max_payer_lamports: MAX_PAYER_LAMPORTS,
        }
        .data();
        Instruction::new_with_bytes(launchpad_id(), &data, metas)
    }

    /// The router's `register_existing_market`, then `init_fee_account` for each mint, for a
    /// market state the tax AMM created itself.
    pub fn register_instructions(
        &self,
        payer: &Pubkey,
        market_state: &Pubkey,
        mints: [Pubkey; 2],
        token_programs: [Pubkey; 2],
    ) -> Vec<Instruction> {
        let market = pda::market(&strategy_id(), market_state);
        std::iter::once(client::register_existing_market(
            payer,
            &strategy_id(),
            market_state,
            vec![],
        ))
        .chain(
            (0..2).map(|i| client::init_fee_account(payer, &market, &mints[i], &token_programs[i])),
        )
        .collect()
    }

    /// The launchpad's `call_as_seeder`: `instruction` sent by the launchpad, with the
    /// launch's seeder signing wherever it appears among its accounts.
    pub fn call_as_seeder(
        &mut self,
        launch: &Launch,
        instruction: Instruction,
    ) -> Result<TransactionMetadata, String> {
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
        self.send_as_creator(launch, &[call])
    }

    /// Sends `instructions`, signed by the launch's creator, who pays.
    pub fn send_as_creator(
        &mut self,
        launch: &Launch,
        instructions: &[Instruction],
    ) -> Result<TransactionMetadata, String> {
        self.send_meta(instructions, &[&launch.creator])
    }

    /// Graduates `launch` with `params` and `amounts`, and records the market with the router
    /// and both fee accounts, in one transaction.
    pub fn graduate(
        &mut self,
        launch: &Launch,
        params: &InitParams,
        amounts: [u64; 2],
    ) -> Result<Graduated, String> {
        let graduate = self.graduate_instruction(
            launch,
            amounts,
            init_data(params),
            self.seed_liquidity_accounts(launch),
        );
        let mut instructions = vec![graduate];
        let market_state = launch.market_state();
        instructions.extend(self.register_instructions(
            &launch.creator.pubkey(),
            &market_state,
            launch.mints,
            launch.token_programs,
        ));
        let created = self.send_as_creator(launch, &instructions)?;
        let graduation = graduation_of(&created);
        let (authority, vaults) = tax_market_addresses(&market_state, launch.mints);
        Ok(Graduated {
            market: Market {
                market: pda::market(&strategy_id(), &market_state),
                market_state,
                authority,
                mints: launch.mints,
                token_programs: launch.token_programs,
                vaults,
                created,
            },
            graduation,
        })
    }
}

/// The launchpad's `Graduation`, from its return data logged as "Program return: ...".
pub fn graduation_of(meta: &TransactionMetadata) -> Graduation {
    use base64::Engine;
    let prefix = format!("Program return: {} ", launchpad_id());
    let encoded = meta
        .logs
        .iter()
        .find_map(|line| line.strip_prefix(&prefix))
        .expect("the launchpad's return data");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    Graduation::try_from_slice(&bytes).unwrap()
}
