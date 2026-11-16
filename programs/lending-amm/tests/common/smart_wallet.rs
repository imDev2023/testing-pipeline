//! The stand-in smart wallet in the tests (`programs/test-programs/stand-in-smart-wallet`,
//! built into `fixtures/test-programs` by `scripts/build-programs.sh`): it forwards a trader's
//! signed instruction by CPI, one call level above it.

use std::path::PathBuf;

use pipeline_client::{AccountMeta, Instruction, Pubkey};

use super::{anchor_discriminator, Env};

/// The stand-in smart wallet's program id.
pub fn smart_wallet_id() -> Pubkey {
    "StandinSmartWa11et1111111111111111111111111"
        .parse()
        .unwrap()
}

/// The stand-in smart wallet's bytes, from `$TEST_PROGRAMS_DIR`, else
/// `$FIXTURES_DIR/test-programs`, else `fixtures/test-programs`.
pub fn smart_wallet_so() -> Vec<u8> {
    let dir = std::env::var("TEST_PROGRAMS_DIR")
        .map(PathBuf::from)
        .or_else(|_| {
            std::env::var("FIXTURES_DIR")
                .map(|fixtures| PathBuf::from(fixtures).join("test-programs"))
        })
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/test-programs")
        });
    let path = dir.join("stand_in_smart_wallet.so");
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Build it first: scripts/build-programs.sh test-programs/stand-in-smart-wallet",
            path.display()
        )
    })
}

/// `instruction` sent through the stand-in smart wallet's `forward`, which calls it by CPI with
/// the same accounts and flags.
pub fn through_smart_wallet(instruction: Instruction) -> Instruction {
    let mut data = anchor_discriminator("forward").to_vec();
    data.extend((instruction.data.len() as u32).to_le_bytes());
    data.extend(&instruction.data);
    let mut accounts = vec![AccountMeta::new_readonly(instruction.program_id, false)];
    accounts.extend(instruction.accounts);
    Instruction::new_with_bytes(smart_wallet_id(), &data, accounts)
}

impl Env {
    /// Deploys the stand-in smart wallet at its address.
    pub fn load_smart_wallet(&mut self) {
        self.svm
            .add_program(smart_wallet_id(), &smart_wallet_so())
            .unwrap();
    }
}
