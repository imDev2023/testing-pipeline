//! Hostile market creation (docs/spec/README.md, "Test layers" 1): a wrong or missing
//! market signer, substituted and aliased accounts, and addresses funded by someone else
//! before the creation lands (docs/spec/tax-amm.md, "Addresses").

mod common;

use common::*;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::StrategyError;

/// Anchor's own errors, by number.
const ACCOUNT_NOT_SIGNER: u32 = 3010;
const CONSTRAINT_SEEDS: u32 = 2006;
const INVALID_PROGRAM_ID: u32 = 3008;

fn assert_anchor_error<T: std::fmt::Debug>(result: Result<T, String>, number: u32) {
    match result {
        Ok(value) => panic!("expected Anchor error {number}, but it passed: {value:?}"),
        Err(failure) => assert!(
            failure.contains(&format!("Custom({number})")),
            "expected Anchor error {number}, got:\n{failure}"
        ),
    }
}

struct Setup {
    env: Env,
    mints: [Pubkey; 2],
    params: tax_amm::InitParams,
}

fn setup() -> Setup {
    let mut env = Env::new();
    let mints = [env.create_mint(&TOKEN), env.create_mint(&TOKEN)];
    let params = valid_params(&Pubkey::new_unique());
    Setup { env, mints, params }
}

impl Setup {
    /// `create_market` through the router with the strategy accounts changed by `change`.
    fn create_with_accounts(
        &mut self,
        change: impl FnOnce(&Pubkey, &mut Vec<AccountMeta>),
    ) -> Result<Vec<u8>, String> {
        let state = Keypair::new();
        let mut accounts = init_accounts(&state.pubkey(), self.mints, [TOKEN, TOKEN]);
        change(&state.pubkey(), &mut accounts);
        let create = create_market_instruction(
            &self.env.admin.pubkey(),
            &state.pubkey(),
            true,
            init_data(&self.params),
            accounts,
        );
        self.env.send(&[create], &[&state])
    }

    /// `pipeline_init_market` called directly, not through the router, with `signer` in
    /// the market signer's place.
    fn call_directly(
        &mut self,
        signer: &Pubkey,
        signs: bool,
        extra: &[&Keypair],
    ) -> Result<Vec<u8>, String> {
        let state = Keypair::new();
        let mut data = client::interface::discriminator::INIT_MARKET.to_vec();
        data.extend(borsh::to_vec(&init_data(&self.params)).unwrap());
        let mut accounts = vec![
            AccountMeta::new_readonly(*signer, signs),
            AccountMeta::new(state.pubkey(), true),
            AccountMeta::new(self.env.admin.pubkey(), true),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        ];
        accounts.extend(init_accounts(&state.pubkey(), self.mints, [TOKEN, TOKEN]));
        let call = Instruction::new_with_bytes(strategy_id(), &data, accounts);
        let mut signers = vec![&state];
        signers.extend_from_slice(extra);
        self.env.send(&[call], &signers)
    }
}

#[test]
fn a_direct_call_with_any_other_market_signer_is_refused() {
    let mut s = setup();
    let impostor = Keypair::new();
    assert_refused(
        s.call_directly(&impostor.pubkey(), true, &[&impostor]),
        StrategyError::NotPipeline,
    );
    // The admin, who pays and could sign anything here, isn't the router's PDA either.
    let admin = s.env.admin.pubkey();
    assert_refused(
        s.call_directly(&admin, true, &[]),
        StrategyError::NotPipeline,
    );
}

#[test]
fn a_market_signer_that_does_not_sign_is_refused() {
    // The right address, but only the router can make it sign.
    let mut s = setup();
    let state = Keypair::new();
    let market = pda::market(&strategy_id(), &state.pubkey());
    assert_anchor_error(s.call_directly(&market, false, &[]), ACCOUNT_NOT_SIGNER);
}

#[test]
fn substituted_vaults_and_authority_are_refused() {
    let mut s = setup();
    // An associated token account of the authority in place of the vault PDA.
    let mints = s.mints;
    assert_anchor_error(
        s.create_with_accounts(|state, accounts| {
            let (authority, _) = tax_market_addresses(state, mints);
            accounts[3].pubkey = pda::associated_token(&authority, &mints[0], &TOKEN);
        }),
        CONSTRAINT_SEEDS,
    );
    // The two vaults swapped.
    assert_anchor_error(
        s.create_with_accounts(|_, accounts| {
            let vault_0 = accounts[3].pubkey;
            accounts[3].pubkey = accounts[4].pubkey;
            accounts[4].pubkey = vault_0;
        }),
        CONSTRAINT_SEEDS,
    );
    // Another market state's authority.
    assert_anchor_error(
        s.create_with_accounts(|_, accounts| {
            accounts[2].pubkey = tax_market_addresses(&Pubkey::new_unique(), mints).0;
        }),
        CONSTRAINT_SEEDS,
    );
}

#[test]
fn aliased_accounts_are_refused() {
    let mut s = setup();
    let mints = s.mints;
    // The market state itself as a vault.
    assert_anchor_error(
        s.create_with_accounts(|state, accounts| accounts[4].pubkey = *state),
        CONSTRAINT_SEEDS,
    );
    // Vault 0 as mint 1 (with mint 1's vault derived from it, so the seeds hold): no
    // account exists there yet, so it is no token program's.
    assert_refused(
        s.create_with_accounts(|state, accounts| {
            let vault_0 = tax_market_addresses(state, mints).1[0];
            accounts[1].pubkey = vault_0;
            accounts[4].pubkey = tax_market_addresses(state, [mints[0], vault_0]).1[1];
        }),
        StrategyError::WrongTokenProgram,
    );
    // A mint as its own token program.
    assert_anchor_error(
        s.create_with_accounts(|_, accounts| accounts[5].pubkey = mints[0]),
        INVALID_PROGRAM_ID,
    );
}

#[test]
fn a_substituted_token_program_is_refused() {
    let mut s = setup();
    assert_anchor_error(
        s.create_with_accounts(|_, accounts| accounts[6].pubkey = client::SYSTEM_PROGRAM_ID),
        INVALID_PROGRAM_ID,
    );
    assert_anchor_error(
        s.create_with_accounts(|_, accounts| accounts[5].pubkey = strategy_id()),
        INVALID_PROGRAM_ID,
    );
}

#[test]
fn a_pre_funded_market_state_fails_the_creation_and_another_keypair_succeeds() {
    // docs/spec/tax-amm.md, "Addresses": anyone can send lamports to the market state's
    // address once they see it; the router then drops its signature, so the strategy can't
    // create the account and the whole creation fails. The creator retries with another
    // keypair, which nobody could have known.
    let mut s = setup();
    let state = Keypair::new();
    s.env.svm.airdrop(&state.pubkey(), 1_000_000).unwrap();
    let mints = [(s.mints[0], TOKEN), (s.mints[1], TOKEN)];
    let failure = s
        .env
        .create_tax_market_with(&state, mints, init_data(&s.params))
        .unwrap_err();
    assert!(
        failure.contains("PrivilegeEscalation")
            && failure.contains(&format!("{}'s signer privilege escalated", state.pubkey())),
        "{failure}"
    );
    // Nothing was created: the address holds only the lamports someone sent.
    let account = s.env.svm.get_account(&state.pubkey()).unwrap();
    assert_eq!(account.owner, client::SYSTEM_PROGRAM_ID);
    assert!(account.data.is_empty());
    assert!(s
        .env
        .svm
        .get_account(&pda::market(&strategy_id(), &state.pubkey()))
        .is_none());

    let market = s
        .env
        .create_tax_market_with(&Keypair::new(), mints, init_data(&s.params))
        .unwrap();
    assert_eq!(s.env.tax_market(&market.market_state).params(), s.params);
}

#[test]
fn a_pre_funded_vault_does_not_block_the_creation() {
    // The vaults' addresses are known before creation too; lamports sent to one are kept
    // in the vault and creation goes ahead.
    let mut s = setup();
    let state = Keypair::new();
    let (_, vaults) = tax_market_addresses(&state.pubkey(), s.mints);
    s.env.svm.airdrop(&vaults[0], 10_000_000).unwrap();
    let least = s.env.svm.minimum_balance_for_rent_exemption(0);
    s.env.svm.airdrop(&vaults[1], least).unwrap();
    let mints = [(s.mints[0], TOKEN), (s.mints[1], TOKEN)];
    let market = s
        .env
        .create_tax_market_with(&state, mints, init_data(&s.params))
        .unwrap();
    for vault in market.vaults {
        let account = s.env.svm.get_account(&vault).unwrap();
        assert_eq!(account.owner, TOKEN);
        assert!(
            account.lamports
                >= s.env
                    .svm
                    .minimum_balance_for_rent_exemption(account.data.len())
        );
        assert_eq!(s.env.balance(&vault), 0);
    }
}

#[test]
fn a_pre_funded_native_sol_vault_opens_with_a_donation_the_market_never_counts() {
    // Lamports sent to a native SOL vault's address become wrapped SOL when the token program
    // initializes the vault. Like any token sent to a vault outside a swap or the seed, they
    // are a donation (docs/spec/tax-amm.md, "Locked for good"): the market records nothing.
    for (native, token_program) in [
        (tax_amm::params::NATIVE_MINTS[0], TOKEN),
        (tax_amm::params::NATIVE_MINTS[1], TOKEN_2022),
    ] {
        let mut env = Env::new();
        let sol = env.write_native_mint(&native, &token_program);
        let token = env.create_mint(&TOKEN);
        let mut params = valid_params(&Pubkey::new_unique());
        params.tax_side = 0;
        let state = Keypair::new();
        let (_, vaults) = tax_market_addresses(&state.pubkey(), [token, sol]);
        env.svm.airdrop(&vaults[1], 5 * SOL).unwrap();
        let market = env
            .create_tax_market_with(
                &state,
                [(token, TOKEN), (sol, token_program)],
                init_data(&params),
            )
            .unwrap();
        let vault = env.svm.get_account(&market.vaults[1]).unwrap();
        let rent = env.svm.minimum_balance_for_rent_exemption(vault.data.len());
        assert_eq!(vault.lamports, 5 * SOL);
        assert_eq!(env.balance(&market.vaults[1]), 5 * SOL - rent);
        assert_eq!(env.tax_market(&market.market_state).reserves, [0, 0]);
    }
}

/// `market` as a caller might describe it with other token programs.
fn with_token_programs(market: &Market, token_programs: [Pubkey; 2]) -> Market {
    Market {
        market: market.market,
        market_state: market.market_state,
        authority: market.authority,
        mints: market.mints,
        token_programs,
        vaults: market.vaults,
        created: Default::default(),
    }
}

/// Every token balance and the market state, to show a refused step moved nothing.
fn holdings(env: &Env, market: &Market, wallets: &[Pubkey]) -> (Vec<u64>, Vec<u8>) {
    let mut balances: Vec<u64> = market.vaults.iter().map(|v| env.balance(v)).collect();
    for wallet in wallets {
        for i in 0..2 {
            let account =
                pda::associated_token(wallet, &market.mints[i], &market.token_programs[i]);
            balances.push(env.balance_or_zero(&account));
        }
    }
    let state = env.svm.get_account(&market.market_state).unwrap().data;
    (balances, state)
}

/// Hardening finding H004 (#67): nothing tested a swap whose output names the other token
/// program than its mint's. The swap is refused and nothing moves.
#[test]
fn sos_h004_a_swap_naming_the_other_token_program_for_its_output_is_refused() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
    ];
    let params = valid_params(&Pubkey::new_unique());
    let market = env.seeded_market(mints, &params, [1_000_000_000, 1_000_000_000]);
    let trader = env.funded_wallet(&market, 1_000_000_000);
    let before = holdings(&env, &market, &[trader.pubkey()]);
    for input in 0..2 {
        let swapped = with_token_programs(&market, [TOKEN_2022, TOKEN]);
        let options = SwapOptions {
            strategy_accounts: Some(
                env.resolve_accounts(&market, &exact_in(input, 1 - input, 1_000_000))
                    .unwrap(),
            ),
            ..SwapOptions::default()
        };
        assert!(env
            .swap_with(&swapped, &trader, (input, 1 - input), 1_000_000, &options)
            .is_err());
    }
    assert_eq!(holdings(&env, &market, &[trader.pubkey()]), before);
}

/// Hardening finding H004 (#67): `distribute` naming another token program than the tax
/// mint's is refused, and the slot keeps what it is owed.
#[test]
fn sos_h004_distribute_naming_another_token_program_is_refused() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
    ];
    let mut params = valid_params(&Pubkey::new_unique());
    params.tax_side = 1;
    let market = env.seeded_market(mints, &params, [1_000_000_000, 1_000_000_000]);
    let trader = env.funded_wallet(&market, 1_000_000_000);
    env.swap(&market, &trader, (1, 0), 100_000_000).unwrap();
    let state = env.tax_market(&market.market_state);
    assert!(state.owed[0] > 0);
    let wallet = slot_wallet(&state, 0);
    let caller = Keypair::new();
    env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
    let before = holdings(&env, &market, &[wallet]);
    let swapped = with_token_programs(&market, [TOKEN, TOKEN]);
    let instruction = distribute_instruction(&swapped, 1, &caller.pubkey(), 0, &wallet, vec![]);
    assert!(env.send_meta(&[instruction], &[&caller]).is_err());
    assert_eq!(holdings(&env, &market, &[wallet]), before);
    env.distribute(&market, &caller, 0).unwrap();
}

/// Hardening finding H004 (#67): a seed naming another token program than a mint's is
/// refused, and the market stays waiting for its seed.
#[test]
fn sos_h004_a_seed_naming_another_token_program_is_refused() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
    ];
    let seeder = Keypair::new();
    let market = env
        .create_tax_market(mints, &valid_params(&seeder.pubkey()))
        .unwrap();
    env.fund(&seeder.pubkey(), &market, [1_000_000, 1_000_000]);
    let before = holdings(&env, &market, &[seeder.pubkey()]);
    for programs in [
        [TOKEN_2022, TOKEN_2022],
        [TOKEN, TOKEN],
        [TOKEN_2022, TOKEN],
    ] {
        let swapped = with_token_programs(&market, programs);
        let instruction =
            seed_instruction(&swapped, &seeder.pubkey(), [1_000_000, 1_000_000], vec![]);
        assert!(env.send_meta(&[instruction], &[&seeder]).is_err());
    }
    assert_eq!(holdings(&env, &market, &[seeder.pubkey()]), before);
    env.seed(&market, &seeder, [1_000_000, 1_000_000]).unwrap();
}

/// Hardening finding H001 (#67): the router id compiled into the program, which every
/// market's swap signer is derived under, is the router pinned for devnet. The tests load
/// the router at the same constant, so only this pin would notice a Pipeline upgrade that
/// moved it.
#[test]
fn sos_h001_the_compiled_router_id_is_the_pinned_devnet_router() {
    let pins = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/pins.env"),
    )
    .unwrap();
    let pinned = pins
        .lines()
        .find_map(|line| line.strip_prefix("ROUTER_PROGRAM="))
        .expect("fixtures/pins.env pins ROUTER_PROGRAM");
    assert_eq!(
        Pubkey::new_from_array(pipeline_strategy_interface::PIPELINE_PROGRAM_ID).to_string(),
        pinned
    );
}
