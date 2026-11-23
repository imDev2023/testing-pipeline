//! A contained token's home market with our real containment hook
//! (`programs/containment-hook`), built by `scripts/build-programs.sh containment-hook` into
//! `programs/target/deploy` (`tests/fixtures/build.sh` runs it), deployed frozen at its
//! program id, with the mint's config and validation account written as the hook's `bind`
//! writes them. `bind` needs a home market on the tax AMM; the allow rule (`Execute`) reads
//! only the config, so the home market here is a constant-product market whose vault and
//! fee account the config names.

use canary::config::{CONTAINMENT_HOOK_PROGRAM, CONTAINMENT_HOOK_UNLOCK_SEED};
use pipeline_client::{pda, Pubkey};
use sha2::{Digest, Sha256};
use solana_account::Account;

use super::{freeze_program, read, repo_root, Cluster, Extensions, Market, TOKEN_2022};

/// The hook's bytes, as `scripts/build-programs.sh containment-hook` builds them.
pub fn containment_hook_so() -> Vec<u8> {
    read(
        repo_root().join("programs/target/deploy/containment_hook.so"),
        "Run crates/canary/tests/fixtures/build.sh (it builds programs/containment-hook) first.",
    )
}

/// `["config", mint]`, `["extra-account-metas", mint]` and `["unlock", mint]` with their
/// bumps.
fn hook_pda(seed: &[u8], mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seed, mint.as_ref()], &CONTAINMENT_HOOK_PROGRAM)
}

/// The validation account's data, as the hook's `state::VALIDATION_DATA` lays it out: one
/// entry for `Execute` listing one extra account, the config, a PDA of the hook from the
/// seeds `["config", <Execute's account 1, the mint>]`, read-only.
fn validation_data() -> Vec<u8> {
    const EXECUTE: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
    let mut config = [0u8; 32];
    config[0] = 1; // a literal seed
    config[1] = 6;
    config[2..8].copy_from_slice(b"config");
    config[8] = 3; // an account's key, by index
    config[9] = 1;
    let mut data = EXECUTE.to_vec();
    data.extend_from_slice(&(4u32 + 35).to_le_bytes());
    data.extend_from_slice(&1u32.to_le_bytes());
    data.push(1); // a PDA of the hook program
    data.extend_from_slice(&config);
    data.extend_from_slice(&[0, 0]); // not a signer, not writable
    data
}

impl Cluster {
    fn write_hook_account(&mut self, address: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                Account {
                    lamports,
                    data,
                    owner: CONTAINMENT_HOOK_PROGRAM,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    /// A wrapped SOL market on `test-strategy-cp` whose Token-2022 token is contained by our
    /// real containment hook: the hook deployed frozen, the mint's hook authority its unlock
    /// PDA, and the config binding the mint to this market's token vault and fee account.
    pub fn contained_home_market(&mut self) -> Market {
        if self.svm.get_account(&CONTAINMENT_HOOK_PROGRAM).is_none() {
            self.svm
                .add_program(CONTAINMENT_HOOK_PROGRAM, &containment_hook_so())
                .unwrap();
            freeze_program(&mut self.svm, &CONTAINMENT_HOOK_PROGRAM);
        }
        let admin = self.admin_key();
        let token = self.create_mint_2022(
            6,
            &Extensions {
                transfer_hook: Some((CONTAINMENT_HOOK_PROGRAM, Some(admin))),
                ..Extensions::default()
            },
        );
        let (unlock, unlock_bump) = hook_pda(CONTAINMENT_HOOK_UNLOCK_SEED, &token);
        let ix = spl_token_2022_interface::instruction::set_authority(
            &TOKEN_2022,
            &token,
            Some(&unlock),
            spl_token_2022_interface::instruction::AuthorityType::TransferHookProgramId,
            &admin,
            &[],
        )
        .unwrap();
        self.send(&[ix], &[]);

        let sol = self.wrapped_sol();
        let pool = Self::cp_pool(&sol, &token, 30);
        let [vault, fee_account] = self.sol_market_accounts(&token);
        let (config, config_bump) = hook_pda(b"config", &token);
        let (validation, validation_bump) = hook_pda(b"extra-account-metas", &token);
        let now: solana_clock::Clock = self.svm.get_sysvar();
        // The config as `bind` writes it: Anchor's discriminator, then the fields in order.
        let mut data = Sha256::digest(b"account:Config")[..8].to_vec();
        data.push(1); // CONFIG_VERSION
        for key in [
            token,
            pda::market(&super::CP, &pool),
            pool,
            vault,
            fee_account,
            sol,
        ] {
            data.extend_from_slice(key.as_ref());
        }
        data.extend_from_slice(&(10 * super::SOL).to_le_bytes()); // unlock goal
        data.extend_from_slice(&(now.unix_timestamp + 30 * 86_400).to_le_bytes()); // deadline
        data.extend_from_slice(&now.unix_timestamp.to_le_bytes()); // bound at
        data.extend_from_slice(&[config_bump, validation_bump, unlock_bump]);
        data.push(0); // not unlocked
        data.resize(8 + 229, 0); // Config::SPACE
        self.write_hook_account(config, data);
        self.write_hook_account(validation, validation_data());

        self.sol_market_of(token)
    }
}
