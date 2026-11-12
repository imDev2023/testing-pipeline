//! Token-2022 mints with the extensions Canary acts on or must trade through (transfer
//! hooks, transfer fees, freeze, permanent delegate and pause authorities), Pipeline's
//! Apache-2.0 test hooks deployed at addresses of our choosing, and constant-product
//! markets on such mints, created through the router as on devnet.

use litesvm::LiteSVM;
use pipeline_check::{hooks, write_token_account};
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_token_2022_interface::extension::ExtensionType;

use super::{create_account, set_upgrade_authority, test_program, Cluster, Market, CP, SOL, TOKEN};

pub const TOKEN_2022: Pubkey = client::TOKEN_2022_PROGRAM_ID;
/// Where the tests deploy Pipeline's `test-hook`, which approves transfers whose source or
/// destination is on its whitelist (or every transfer, with no whitelist).
pub const TEST_HOOK: Pubkey = Pubkey::new_from_array([0x7e; 32]);
/// Where the tests deploy Pipeline's `test-hook-refill`, which empties a stash into a
/// target account on every transfer.
pub const TEST_HOOK_REFILL: Pubkey = Pubkey::new_from_array([0x7f; 32]);

/// The extensions of a Token-2022 mint the tests create; every authority is the admin.
#[derive(Clone, Debug, Default)]
pub struct Extensions {
    /// `(basis points, maximum)`.
    pub transfer_fee: Option<(u16, u64)>,
    /// The hook program and the hook authority.
    pub transfer_hook: Option<(Pubkey, Option<Pubkey>)>,
    /// A transfer hook extension with both its program and its authority unset, as a
    /// contained token's is after its unlock.
    pub emptied_transfer_hook: bool,
    pub freeze_authority: bool,
    pub permanent_delegate: bool,
    pub pausable: bool,
}

/// A program's executable bytes and its upgrade authority, deployed at `address`.
pub fn deploy(svm: &mut LiteSVM, address: Pubkey, so_name: &str, authority: Option<Pubkey>) {
    svm.add_program(address, &test_program(so_name)).unwrap();
    match authority {
        Some(authority) => set_upgrade_authority(svm, &address, &authority),
        None => freeze_program(svm, &address),
    }
}

/// Removes a program's upgrade authority, so it can never change again.
pub fn freeze_program(svm: &mut LiteSVM, program: &Pubkey) {
    let address = pda::program_data(program);
    let mut account = svm.get_account(&address).expect("program data");
    account.data[12] = 0;
    account.data[13..45].fill(0);
    svm.set_account(address, account).unwrap();
}

impl Cluster {
    /// A new Token-2022 mint with `extensions`, the admin its mint authority and every
    /// authority its extensions have.
    pub fn create_mint_2022(&mut self, decimals: u8, extensions: &Extensions) -> Pubkey {
        use spl_token_2022_interface::extension::{pausable, transfer_fee, transfer_hook};
        use spl_token_2022_interface::instruction as token;
        let mint = Keypair::new();
        let authority = self.admin.pubkey();
        let mut types = vec![];
        if extensions.transfer_fee.is_some() {
            types.push(ExtensionType::TransferFeeConfig);
        }
        if extensions.transfer_hook.is_some() || extensions.emptied_transfer_hook {
            types.push(ExtensionType::TransferHook);
        }
        if extensions.permanent_delegate {
            types.push(ExtensionType::PermanentDelegate);
        }
        if extensions.pausable {
            types.push(ExtensionType::Pausable);
        }
        let space =
            ExtensionType::try_calculate_account_len::<spl_token_2022_interface::state::Mint>(
                &types,
            )
            .unwrap();
        let mut ixs = vec![create_account(
            &authority,
            &mint.pubkey(),
            self.svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &TOKEN_2022,
        )];
        if let Some((bps, max)) = extensions.transfer_fee {
            ixs.push(
                transfer_fee::instruction::initialize_transfer_fee_config(
                    &TOKEN_2022,
                    &mint.pubkey(),
                    Some(&authority),
                    Some(&authority),
                    bps,
                    max,
                )
                .unwrap(),
            );
        }
        if let Some((program, hook_authority)) = extensions.transfer_hook {
            ixs.push(
                transfer_hook::instruction::initialize(
                    &TOKEN_2022,
                    &mint.pubkey(),
                    hook_authority,
                    Some(program),
                )
                .unwrap(),
            );
        }
        if extensions.emptied_transfer_hook {
            // Token-2022 refuses an empty extension at creation; the unlock empties it later,
            // and so does this, below.
            ixs.push(
                transfer_hook::instruction::initialize(
                    &TOKEN_2022,
                    &mint.pubkey(),
                    Some(authority),
                    None,
                )
                .unwrap(),
            );
        }
        if extensions.permanent_delegate {
            ixs.push(
                token::initialize_permanent_delegate(&TOKEN_2022, &mint.pubkey(), &authority)
                    .unwrap(),
            );
        }
        if extensions.pausable {
            ixs.push(
                pausable::instruction::initialize(&TOKEN_2022, &mint.pubkey(), &authority).unwrap(),
            );
        }
        ixs.push(
            token::initialize_mint2(
                &TOKEN_2022,
                &mint.pubkey(),
                &authority,
                extensions.freeze_authority.then_some(&authority),
                decimals,
            )
            .unwrap(),
        );
        if extensions.emptied_transfer_hook {
            ixs.push(
                token::set_authority(
                    &TOKEN_2022,
                    &mint.pubkey(),
                    None,
                    token::AuthorityType::TransferHookProgramId,
                    &authority,
                    &[],
                )
                .unwrap(),
            );
        }
        self.send(&ixs, &[&mint]);
        mint.pubkey()
    }

    /// Writes `owner`'s associated token account of `mint` holding `amount`.
    pub fn give_on(
        &mut self,
        mint: &Pubkey,
        token_program: &Pubkey,
        owner: &Pubkey,
        amount: u64,
    ) -> Pubkey {
        write_token_account(&mut self.svm, mint, token_program, owner, amount).unwrap()
    }

    /// Creates `mint`'s extra-account-meta list for Pipeline's `test-hook` deployed at
    /// `hook`, with `whitelist` as the token accounts transfers must come from or go to
    /// (every transfer is approved when it is empty).
    pub fn init_test_hook(&mut self, hook: &Pubkey, mint: &Pubkey, whitelist: &[Pubkey]) {
        let mut data = b"tsthkini".to_vec();
        for key in whitelist {
            data.extend_from_slice(key.as_ref());
        }
        let ix = Instruction::new_with_bytes(
            *hook,
            &data,
            vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new(hooks::validation_address(hook, mint), false),
                AccountMeta::new(
                    Pubkey::find_program_address(&[b"whitelist", mint.as_ref()], hook).0,
                    false,
                ),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            ],
        );
        self.send(&[ix], &[]);
    }

    /// Creates `mint`'s extra-account-meta list for Pipeline's `test-hook-refill` at
    /// [`TEST_HOOK_REFILL`]: on every transfer it empties a stash of a separate SPL Token
    /// mint into a target account. Returns the stash and the target.
    pub fn init_refill_hook(&mut self, mint: &Pubkey, stash_amount: u64) -> (Pubkey, Pubkey) {
        let stash_mint = self.create_mint(6);
        let authority = Pubkey::find_program_address(&[b"stash"], &TEST_HOOK_REFILL).0;
        let stash = self.give(&stash_mint, &authority, stash_amount);
        let target = self.give(&stash_mint, &Pubkey::new_unique(), 0);
        let mut data = b"refilini".to_vec();
        for (key, writable) in [(stash, 1u8), (authority, 0), (target, 1), (TOKEN, 0)] {
            data.extend_from_slice(key.as_ref());
            data.push(writable);
        }
        let ix = Instruction::new_with_bytes(
            TEST_HOOK_REFILL,
            &data,
            vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new(hooks::validation_address(&TEST_HOOK_REFILL, mint), false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            ],
        );
        self.send(&[ix], &[]);
        (stash, target)
    }

    /// The accounts a transfer of `mint` from `source` to `destination` needs for its hook,
    /// resolved as `pipeline-check` resolves them; none when the mint has no hook.
    pub fn hook_accounts_for(
        &self,
        mint: &Pubkey,
        source: Pubkey,
        destination: Pubkey,
        authority: Pubkey,
        amount: u64,
    ) -> Vec<AccountMeta> {
        use spl_token_2022_interface::extension::transfer_hook::TransferHook;
        use spl_token_2022_interface::extension::{BaseStateWithExtensions, StateWithExtensions};
        let account = self.svm.get_account(mint).unwrap();
        if account.owner != TOKEN_2022 {
            return vec![];
        }
        let state =
            StateWithExtensions::<spl_token_2022_interface::state::Mint>::unpack(&account.data)
                .unwrap();
        let Some(program) = state
            .get_extension::<TransferHook>()
            .ok()
            .and_then(|hook| Option::<Pubkey>::from(hook.program_id))
        else {
            return vec![];
        };
        let svm = &self.svm;
        hooks::resolve(
            &program,
            &hooks::Transfer {
                source,
                mint: *mint,
                destination,
                authority,
                amount,
            },
            |key| svm.get_account(key).map(|a| a.data),
        )
        .unwrap()
    }

    /// The pool `test-strategy-cp` keeps for `mint_a`, `mint_b` and `fee_bps`.
    pub fn cp_pool(mint_a: &Pubkey, mint_b: &Pubkey, fee_bps: u16) -> Pubkey {
        Pubkey::find_program_address(
            &[
                b"pool",
                mint_a.as_ref(),
                mint_b.as_ref(),
                &fee_bps.to_le_bytes(),
            ],
            &CP,
        )
        .0
    }

    /// A constant-product market on `test-strategy-cp` between mints of either token
    /// program, with both fee accounts and `reserves` deposited (transfer-hook accounts
    /// passed for each mint that has a hook).
    pub fn cp_market_on(
        &mut self,
        (mint_a, tp_a): (Pubkey, Pubkey),
        (mint_b, tp_b): (Pubkey, Pubkey),
        fee_bps: u16,
        reserves: (u64, u64),
    ) -> Market {
        self.register(&CP, "test_strategy_cp");
        let pool = Self::cp_pool(&mint_a, &mint_b, fee_bps);
        let vault_a = pda::associated_token(&pool, &mint_a, &tp_a);
        let vault_b = pda::associated_token(&pool, &mint_b, &tp_b);
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
                AccountMeta::new_readonly(tp_a, false),
                AccountMeta::new_readonly(tp_b, false),
                AccountMeta::new_readonly(client::ASSOCIATED_TOKEN_PROGRAM_ID, false),
            ],
        });
        self.send(&[ix], &[]);
        let market = pda::market(&CP, &pool);
        self.send(
            &[
                client::init_fee_account(&creator, &market, &mint_a, &tp_a),
                client::init_fee_account(&creator, &market, &mint_b, &tp_b),
            ],
            &[],
        );
        let lp = Keypair::new();
        self.svm.airdrop(&lp.pubkey(), SOL).unwrap();
        let lp_a = self.give_on(&mint_a, &tp_a, &lp.pubkey(), reserves.0);
        let lp_b = self.give_on(&mint_b, &tp_b, &lp.pubkey(), reserves.1);
        let mut data = client::instruction_discriminator("deposit").to_vec();
        data.extend_from_slice(&reserves.0.to_le_bytes());
        data.extend_from_slice(&reserves.1.to_le_bytes());
        let mut accounts = vec![
            AccountMeta::new_readonly(lp.pubkey(), true),
            AccountMeta::new(pool, false),
            AccountMeta::new(lp_a, false),
            AccountMeta::new(lp_b, false),
            AccountMeta::new(vault_a, false),
            AccountMeta::new(vault_b, false),
            AccountMeta::new_readonly(mint_a, false),
            AccountMeta::new_readonly(mint_b, false),
            AccountMeta::new_readonly(tp_a, false),
            AccountMeta::new_readonly(tp_b, false),
        ];
        accounts.extend(self.hook_accounts_for(&mint_a, lp_a, vault_a, lp.pubkey(), reserves.0));
        accounts.extend(self.hook_accounts_for(&mint_b, lp_b, vault_b, lp.pubkey(), reserves.1));
        self.send(&[Instruction::new_with_bytes(CP, &data, accounts)], &[&lp]);
        Market {
            market,
            state: pool,
            mint_a,
            mint_b,
        }
    }

    /// A deep wrapped SOL market on `test-strategy-cp`, as [`Cluster::sol_cp_market`]
    /// makes, whose token is the Token-2022 `token` (6 decimals), with its supply set to
    /// 100 times the vault's.
    pub fn sol_market_of(&mut self, token: Pubkey) -> Market {
        let sol = self.wrapped_sol();
        let market = self.cp_market_on(
            (sol, TOKEN),
            (token, TOKEN_2022),
            30,
            (1_000 * SOL, 1_000_000_000_000),
        );
        self.set_supply(&token, 100_000_000_000_000);
        market
    }

    /// The token vault and the fee account a constant-product market between wrapped SOL
    /// and the Token-2022 `token` will have, before it is created.
    pub fn sol_market_accounts(&mut self, token: &Pubkey) -> [Pubkey; 2] {
        let sol = self.wrapped_sol();
        let pool = Self::cp_pool(&sol, token, 30);
        let market = pda::market(&CP, &pool);
        [
            pda::associated_token(&pool, token, &TOKEN_2022),
            pda::fee_account(&market, token, &TOKEN_2022),
        ]
    }
}

/// A wrapped SOL market whose token has Pipeline's `test-hook`, approving only transfers
/// into or out of the market's own vault and fee account, as a whitelist-gated token's hook
/// does; every transfer then needs the whitelist account the hook lists.
pub fn whitelist_hooked_market(cluster: &mut Cluster) -> Market {
    let admin = cluster.admin_key();
    deploy(&mut cluster.svm, TEST_HOOK, "test_hook", Some(admin));
    let token = cluster.create_mint_2022(
        6,
        &Extensions {
            transfer_hook: Some((TEST_HOOK, Some(admin))),
            ..Extensions::default()
        },
    );
    let whitelist = cluster.sol_market_accounts(&token);
    cluster.init_test_hook(&TEST_HOOK, &token, &whitelist);
    cluster.sol_market_of(token)
}

impl Cluster {
    /// Removes a mint's mint authority, as a launcher who renounces it does.
    pub fn renounce_mint_authority(&mut self, mint: &Pubkey, token_program: &Pubkey) {
        let ix = spl_token_2022_interface::instruction::set_authority(
            token_program,
            mint,
            None,
            spl_token_2022_interface::instruction::AuthorityType::MintTokens,
            &self.admin.pubkey(),
            &[],
        )
        .unwrap();
        self.send(&[ix], &[]);
    }
}

impl Cluster {
    /// A new SPL Token mint with the admin as both its mint and its freeze authority.
    pub fn create_mint_with_freeze_authority(&mut self, decimals: u8) -> Pubkey {
        let mint = Keypair::new();
        let admin = self.admin.pubkey();
        let create = create_account(
            &admin,
            &mint.pubkey(),
            self.svm.minimum_balance_for_rent_exemption(82),
            82,
            &TOKEN,
        );
        let init = spl_token_2022_interface::instruction::initialize_mint2(
            &TOKEN,
            &mint.pubkey(),
            &admin,
            Some(&admin),
            decimals,
        )
        .unwrap();
        self.send(&[create, init], &[&mint]);
        mint.pubkey()
    }

    /// A market on `test-strategy-evil` between wrapped SOL and the SPL Token `token`, 1:1
    /// with `reserve` of each in its vaults, as [`Cluster::evil_market`] makes with a token
    /// of its own.
    pub fn evil_market_of(&mut self, token: Pubkey, reserve: u64) -> Market {
        self.register(&super::EVIL, "test_strategy_evil");
        let sol = self.wrapped_sol();
        let state =
            Pubkey::find_program_address(&[b"evil", sol.as_ref(), token.as_ref()], &super::EVIL).0;
        let vault_a = self.give(&sol, &state, reserve);
        let vault_b = self.give(&token, &state, reserve);
        let creator = self.admin.pubkey();
        let ix = client::create_market(&client::CreateMarket {
            creator,
            strategy_program: super::EVIL,
            market_state: state,
            market_state_signs: false,
            init_data: vec![0],
            max_creator_lamports: SOL,
            strategy_accounts: vec![
                AccountMeta::new_readonly(sol, false),
                AccountMeta::new_readonly(token, false),
                AccountMeta::new(vault_a, false),
                AccountMeta::new(vault_b, false),
            ],
        });
        self.send(&[ix], &[]);
        let market = pda::market(&super::EVIL, &state);
        self.send(
            &[
                client::init_fee_account(&creator, &market, &sol, &TOKEN),
                client::init_fee_account(&creator, &market, &token, &TOKEN),
            ],
            &[],
        );
        Market {
            market,
            state,
            mint_a: sol,
            mint_b: token,
        }
    }
}
