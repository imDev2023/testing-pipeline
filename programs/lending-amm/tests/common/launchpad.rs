//! Seeding a lending AMM market from another program: the stand-in launchpad
//! (`programs/test-programs/stand-in-launchpad`, built into `fixtures/test-programs` by
//! `scripts/build-programs.sh`) calls `pipeline_seed_liquidity` with its seeder PDA signing,
//! and the same transaction records the market with the router's `register_existing_market`
//! and `init_fee_account` for each mint, as a launchpad does (docs/spec/lending-pool.md,
//! "Seeding").

use std::path::PathBuf;

use anchor_lang::{AnchorDeserialize, InstructionData};
use lending_amm::config::LENT_MINTS;
use lending_amm::InitParams;
use litesvm::types::TransactionMetadata;
use pipeline_client::interface::SeedRequest;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use stand_in_launchpad::Graduation;

use super::{
    addresses_of, ak, ck, init_data, strategy_call, strategy_id, write_token_account, Addresses,
    Env, Market, SOL, TOKEN,
};

/// The most SOL a graduation lends the strategy for rent.
pub const MAX_PAYER_LAMPORTS: u64 = SOL / 10;

/// The associated token program.
pub fn associated_token_program() -> Pubkey {
    ck(&anchor_spl::associated_token::ID)
}

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

/// The lending AMM's PDA for a market seeded by `seeder`:
/// `["seeded", seeder, other_mint, lent_mint, lp_fee_bps LE]`, whichever order the mints come
/// in (docs/spec/lending-pool.md, "Addresses").
pub fn seeded_market_state(seeder: &Pubkey, mints: [Pubkey; 2], params: &InitParams) -> Pubkey {
    let lent = (params.lent_index & 1) as usize;
    Pubkey::find_program_address(
        &[
            b"seeded",
            seeder.as_ref(),
            mints[1 - lent].as_ref(),
            mints[lent].as_ref(),
            &params.lp_fee_bps.to_le_bytes(),
        ],
        &strategy_id(),
    )
    .0
}

/// The associated token account of `owner` for a market's LP mint, where seeding mints the
/// first deposit's shares.
pub fn lp_recipient_account(owner: &Pubkey, lp_mint: &Pubkey) -> Pubkey {
    pda::associated_token(owner, lp_mint, &TOKEN)
}

/// A creator's launch on the stand-in launchpad: its seeder PDA and the seeder's escrow (its
/// associated token account) for each mint, in the launchpad's order.
pub struct Launch {
    pub creator: Keypair,
    pub seeder: Pubkey,
    pub mints: [Pubkey; 2],
    pub token_programs: [Pubkey; 2],
    pub escrows: [Pubkey; 2],
}

/// A graduation that landed.
pub struct Graduated {
    pub market: Market,
    /// The launchpad's return data: the strategy's `SeedResult` and what left each escrow.
    pub graduation: Graduation,
    /// The LP recipient's associated token account for the LP mint.
    pub recipient_account: Pubkey,
}

impl Launch {
    /// The market state this launch's graduation creates with `params`.
    pub fn market_state(&self, params: &InitParams) -> Pubkey {
        seeded_market_state(&self.seeder, self.mints, params)
    }

    /// Every PDA of the market this launch's graduation creates with `params`.
    pub fn addresses(&self, params: &InitParams) -> Addresses {
        addresses_of(&self.market_state(params), self.mints)
    }
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

    /// A new launch on `mints`, in the launchpad's order, whose escrows hold `escrowed` of
    /// each, by a creator with SOL.
    pub fn launch(&mut self, mints: [(Pubkey, Pubkey); 2], escrowed: [u64; 2]) -> Launch {
        self.launch_by(Keypair::new(), mints, escrowed)
    }

    /// [`Env::launch`] by a given creator, whose address the launchpad's seeder PDA derives
    /// from, so a test can fix every address a graduation searches for.
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
            write_token_account(&mut self.svm, &mint, &token_program, &seeder, escrowed[i]).unwrap()
        });
        Launch {
            creator,
            seeder,
            mints: mints.map(|(mint, _)| mint),
            token_programs: mints.map(|(_, program)| program),
            escrows,
        }
    }

    /// The collateral mint and the reserve of the lent mint of a market made with `params`
    /// on `mints`; WSOL's when that mint is not listed, so a refusal test still has accounts.
    fn lent_accounts(mints: [Pubkey; 2], params: &InitParams) -> (Pubkey, Pubkey) {
        let lent = mints[(params.lent_index & 1) as usize];
        let entry = LENT_MINTS
            .iter()
            .find(|entry| ck(&entry.mint) == lent)
            .unwrap_or(&LENT_MINTS[0]);
        (ck(&entry.collateral_mint), ck(&entry.reserve))
    }

    /// `pipeline_seed_liquidity`'s accounts after the seeder, the payer and the system
    /// program, as the launchpad takes them: the market state, the LP recipient, mint, escrow
    /// and token program per mint, the lending AMM's own accounts, then the other mint's
    /// transfer-hook accounts.
    pub fn seed_liquidity_accounts(
        &self,
        launch: &Launch,
        params: &InitParams,
        lp_recipient: &Pubkey,
    ) -> Vec<AccountMeta> {
        let a = launch.addresses(params);
        let (collateral_mint, reserve) = Self::lent_accounts(launch.mints, params);
        let mut accounts = vec![
            AccountMeta::new(a.market_state, false),
            AccountMeta::new_readonly(*lp_recipient, false),
        ];
        for i in 0..2 {
            accounts.push(AccountMeta::new_readonly(launch.mints[i], false));
            accounts.push(AccountMeta::new(launch.escrows[i], false));
            accounts.push(AccountMeta::new_readonly(launch.token_programs[i], false));
        }
        accounts.extend([
            AccountMeta::new_readonly(a.authority, false),
            AccountMeta::new(a.vaults[0], false),
            AccountMeta::new(a.vaults[1], false),
            AccountMeta::new_readonly(collateral_mint, false),
            AccountMeta::new(a.ctoken_account, false),
            AccountMeta::new(a.lp_mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new(lp_recipient_account(lp_recipient, &a.lp_mint), false),
            AccountMeta::new_readonly(associated_token_program(), false),
            AccountMeta::new_readonly(reserve, false),
        ]);
        let other = 1 - (params.lent_index & 1) as usize;
        accounts.extend(self.hook_accounts_of(&launch.mints[other]));
        accounts
    }

    /// `pipeline_seed_liquidity` called directly, paid for by the admin, with the launch's
    /// seeder signing only if `seeder_signs`, through `accounts` (the launchpad's accounts,
    /// from [`Env::seed_liquidity_accounts`]).
    pub fn seed_liquidity_instruction(
        &self,
        launch: &Launch,
        seeder_signs: bool,
        request: &SeedRequest,
        accounts: Vec<AccountMeta>,
    ) -> Instruction {
        let mut metas = vec![
            AccountMeta::new_readonly(launch.seeder, seeder_signs),
            accounts[0].clone(),
            AccountMeta::new(self.admin.pubkey(), true),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        ];
        metas.extend(accounts.into_iter().skip(1));
        strategy_call(
            client::interface::discriminator::SEED_LIQUIDITY,
            request,
            metas,
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
    /// market state the lending AMM created itself.
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

    /// Sends `instructions`, signed by the launch's creator, who pays.
    pub fn send_as_creator(
        &mut self,
        launch: &Launch,
        instructions: &[Instruction],
    ) -> Result<TransactionMetadata, String> {
        self.send_meta(instructions, &[&launch.creator])
    }

    /// Graduates `launch` with `params` and `amounts`, the shares to `lp_recipient`, and
    /// records the market with the router and both fee accounts, in one transaction.
    pub fn graduate(
        &mut self,
        launch: &Launch,
        params: &InitParams,
        amounts: [u64; 2],
        lp_recipient: &Pubkey,
    ) -> Result<Graduated, String> {
        let accounts = self.seed_liquidity_accounts(launch, params, lp_recipient);
        let graduate = self.graduate_instruction(launch, amounts, init_data(params), accounts);
        let market_state = launch.market_state(params);
        let mut instructions = vec![graduate];
        instructions.extend(self.register_instructions(
            &launch.creator.pubkey(),
            &market_state,
            launch.mints,
            launch.token_programs,
        ));
        let created = self.send_as_creator(launch, &instructions)?;
        let graduation = graduation_of(&created);
        let market = self.seeded_market(launch, params, created);
        let recipient_account = lp_recipient_account(lp_recipient, &market.addresses.lp_mint);
        Ok(Graduated {
            market,
            graduation,
            recipient_account,
        })
    }

    /// The [`Market`] a launch's graduation with `params` made.
    pub fn seeded_market(
        &self,
        launch: &Launch,
        params: &InitParams,
        created: TransactionMetadata,
    ) -> Market {
        let addresses = launch.addresses(params);
        Market {
            market: pda::market(&strategy_id(), &addresses.market_state),
            addresses,
            market_state: addresses.market_state,
            mints: launch.mints,
            token_programs: launch.token_programs,
            vaults: addresses.vaults,
            lent_index: (params.lent_index & 1) as usize,
            hook_accounts: [
                self.hook_accounts_of(&launch.mints[0]),
                self.hook_accounts_of(&launch.mints[1]),
            ],
            created,
        }
    }
}

/// The lookup table program's id.
pub fn lookup_table_program() -> Pubkey {
    Pubkey::from_str_const("AddressLookupTab1e1111111111111111111111111")
}

impl Env {
    /// An active address lookup table holding `addresses`, written straight into the VM: the
    /// 56-byte `LookupTableMeta` (discriminator 1, never deactivated, no authority), then the
    /// addresses.
    pub fn lookup_table(
        &mut self,
        addresses: Vec<Pubkey>,
    ) -> solana_message::AddressLookupTableAccount {
        let key = Pubkey::new_unique();
        let mut data = vec![0u8; 56];
        data[..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
        for address in &addresses {
            data.extend_from_slice(address.as_ref());
        }
        self.svm
            .set_account(
                key,
                solana_account::Account {
                    lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
                    data,
                    owner: lookup_table_program(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        solana_message::AddressLookupTableAccount { key, addresses }
    }

    /// The lookup table a launchpad keeps for graduating into the lending AMM: the programs
    /// and accounts every graduation of a lent mint shares (the lent mint, its reserve and
    /// collateral mint, the token, associated token, system and hook programs; the router's
    /// config left graduations with Pipeline 0.2). Invoked programs stay in the message itself, as v0 messages require.
    pub fn graduation_lookup_table(
        &mut self,
        params: &InitParams,
        launch: &Launch,
    ) -> solana_message::AddressLookupTableAccount {
        let (collateral_mint, reserve) = Self::lent_accounts(launch.mints, params);
        self.lookup_table(vec![
            client::SYSTEM_PROGRAM_ID,
            TOKEN,
            client::TOKEN_2022_PROGRAM_ID,
            associated_token_program(),
            launch.mints[(params.lent_index & 1) as usize],
            reserve,
            collateral_mint,
            super::test_hook_id(),
        ])
    }

    /// The graduation transaction a launchpad's user signs alone, as the fee payer: `graduate`,
    /// then `register_existing_market` and `init_fee_account` for each mint, as a legacy
    /// transaction, or as a v0 one compressed by `table`.
    pub fn graduation_transaction(
        &self,
        launch: &Launch,
        params: &InitParams,
        amounts: [u64; 2],
        lp_recipient: &Pubkey,
        table: Option<&solana_message::AddressLookupTableAccount>,
    ) -> solana_transaction::versioned::VersionedTransaction {
        use solana_message::{v0, VersionedMessage};
        let accounts = self.seed_liquidity_accounts(launch, params, lp_recipient);
        let mut instructions =
            vec![self.graduate_instruction(launch, amounts, init_data(params), accounts)];
        instructions.extend(self.register_instructions(
            &launch.creator.pubkey(),
            &launch.market_state(params),
            launch.mints,
            launch.token_programs,
        ));
        let payer = launch.creator.pubkey();
        let blockhash = self.svm.latest_blockhash();
        let message = match table {
            None => VersionedMessage::Legacy(solana_message::Message::new_with_blockhash(
                &instructions,
                Some(&payer),
                &blockhash,
            )),
            Some(table) => VersionedMessage::V0(
                v0::Message::try_compile(
                    &payer,
                    &instructions,
                    std::slice::from_ref(table),
                    blockhash,
                )
                .unwrap(),
            ),
        };
        solana_transaction::versioned::VersionedTransaction::try_new(message, &[&launch.creator])
            .unwrap()
    }
}

/// A transaction's wire size: the signatures, then the message.
pub fn wire_size(tx: &solana_transaction::versioned::VersionedTransaction) -> usize {
    let signatures = tx.signatures.len();
    let compact = if signatures < 0x80 { 1 } else { 2 };
    compact + 64 * signatures + tx.message.serialize().len()
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
