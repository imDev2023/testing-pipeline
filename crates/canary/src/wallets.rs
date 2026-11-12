//! The run's wallets: new random keys on every run (`docs/spec/pipescope-canary.md`, "How a
//! run works"), derived from a seed chosen at random once per run, so every snapshot round of
//! one run trades from the same wallets and accounts derived from them can be supplied, while
//! no strategy can know Canary's wallets in advance and treat them differently.

use pipeline_client::Pubkey;
use sha2::{Digest, Sha256};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// A run's seed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Seed([u8; 32]);

impl Seed {
    /// A new seed from the system's random source (a fresh Ed25519 key's secret).
    pub fn random() -> Self {
        Seed(*Keypair::new().secret_bytes())
    }

    pub fn to_hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn from_hex(hex: &str) -> Result<Self, String> {
        let bad = || format!("the seed {hex:?} is not 64 hex digits");
        if hex.len() != 64 || !hex.is_ascii() {
            return Err(bad());
        }
        let mut bytes = [0u8; 32];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).map_err(|_| bad())?;
        }
        Ok(Seed(bytes))
    }

    /// The wallet for one role in the run, on the market.
    pub fn wallet(&self, market: &Pubkey, role: &str) -> Pubkey {
        let digest = Sha256::new()
            .chain_update(self.0)
            .chain_update(market.as_ref())
            .chain_update(role.as_bytes())
            .finalize();
        Keypair::new_from_array(digest.into()).pubkey()
    }
}
