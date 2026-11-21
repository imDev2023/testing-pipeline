//! `rebalance` in the tests: the instruction as a keeper builds it from the metadata, with the
//! Kamino accounts of the market's lent mint (docs/spec/lending-pool.md, "The buffer and
//! `rebalance`").

use litesvm::types::TransactionMetadata;
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;

use lending_amm::config::LENT_MINTS;
use lending_amm::kamino::Reserve;
use lending_amm::InitParams;

use super::kamino::{instructions_sysvar, klend, lent_name};
use super::{
    anchor_discriminator, ck, strategy_id, Env, Market, MarketSpec, MintOptions, SOL, TOKEN,
};

/// Other-side reserve the rebalance tests' markets start with: a million tokens of 6 decimals.
pub const OTHER: u64 = 1_000_000_000_000;

/// A market lending `LENT_MINTS[lent]` against a new SPL Token mint, the other mint first and
/// the lent mint second.
pub fn lent_spec(env: &mut Env, lent: usize, lp_fee_bps: u16) -> MarketSpec {
    let other = env.create_mint(&TOKEN);
    spec_of(other, lent, lp_fee_bps)
}

/// [`lent_spec`], with the other mint at the fixed address of the secret key `key`. The market
/// state is seeded from both mints, so it, and the vault authority klend sees, are at fixed
/// addresses too, and klend's cost is the same on every run.
pub fn lent_spec_at(env: &mut Env, lent: usize, lp_fee_bps: u16, key: [u8; 32]) -> MarketSpec {
    let options = MintOptions {
        key: Some(key),
        ..MintOptions::default()
    };
    let other = env.create_mint_with(&TOKEN, options);
    spec_of(other, lent, lp_fee_bps)
}

fn spec_of(other: Pubkey, lent: usize, lp_fee_bps: u16) -> MarketSpec {
    MarketSpec {
        mints: [(other, TOKEN), (ck(&LENT_MINTS[lent].mint), TOKEN)],
        params: InitParams {
            lent_index: 1,
            lp_fee_bps,
        },
    }
}

/// One whole unit of `LENT_MINTS[lent]`, times `whole`.
pub fn units(lent: usize, whole: u64) -> u64 {
    whole * [SOL, 1_000_000][lent]
}

/// `rebalance`'s accounts, by name, in the order `metadata.json` lists them, so a test can
/// substitute any one of them.
pub const ACCOUNTS: [&str; 14] = [
    "caller",
    "market_state",
    "authority",
    "buffer_vault",
    "ctoken_account",
    "lent_mint",
    "reserve",
    "lending_market",
    "lending_market_authority",
    "reserve_liquidity_supply",
    "collateral_mint",
    "token_program",
    "klend_program",
    "instructions_sysvar",
];

/// The position of the account named `name` in [`ACCOUNTS`].
pub fn position(name: &str) -> usize {
    ACCOUNTS
        .iter()
        .position(|n| *n == name)
        .unwrap_or_else(|| panic!("no rebalance account {name}"))
}

impl Env {
    /// The program's view of the reserve a market lends to, read from the VM.
    pub fn program_reserve(&self, market: &Market) -> Reserve {
        let entry = &LENT_MINTS[self.lent_entry_of(market)];
        let data = self.data(&ck(&entry.reserve));
        lending_amm::kamino::read_reserve(
            &entry.reserve,
            &lending_amm::config::KLEND_PROGRAM,
            &data,
            entry,
        )
        .unwrap()
    }

    /// The lent side's total `L = B + V`, from the market state and the reserve as they are.
    pub fn lent_total(&self, market: &Market) -> u64 {
        let state = self.market_state(&market.market_state);
        state.reserves[market.lent_index]
            + self
                .program_reserve(market)
                .lent_value(state.ctokens)
                .unwrap()
    }

    /// A market lending `LENT_MINTS[lent]` with no LP fee, opened with `[OTHER, 50 units]` and
    /// rebalanced, so it holds real cTokens from klend's deposit and its buffer is at its target;
    /// then a trader's swap through the router pays out of the buffer until it is about 5% of the
    /// lent side, below the band.
    pub fn market_below_the_band(&mut self, lent: usize) -> Market {
        let spec = lent_spec(self, lent, 0);
        self.market_below_the_band_of(&spec, lent, Keypair::new())
    }

    /// [`Env::market_below_the_band`], for the market `spec` describes (lending
    /// `LENT_MINTS[lent]` with no LP fee), opened by `lp`; with [`lent_spec_at`] and an LP of a
    /// fixed key, every account `rebalance` touches is at the same address on every run.
    pub fn market_below_the_band_of(
        &mut self,
        spec: &MarketSpec,
        lent: usize,
        lp: Keypair,
    ) -> Market {
        let env = self;
        let (market, _) = env
            .create_funded_market_by(spec, [OTHER, units(lent, 50)], lp)
            .unwrap();
        env.rebalance(&market, None).unwrap();
        let state = env.market_state(&market.market_state);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let total = env.lent_total(&market) as u128;
        let buffer = state.reserves[lent_side] as u128;
        // Pay out all but 5% of the lent side: out = L x a / (R + a), so a = out x R / (L - out).
        let out = buffer - total / 20;
        let reserve = state.reserves[other] as u128;
        let amount = (out * reserve).div_ceil(total - out) as u64;
        // Funded for Pipeline's fee too, which the router charges on top.
        let trader = env.funded_wallet(&market, [2 * amount, 2 * amount]);
        env.swap(&market, &trader, (other, lent_side), amount)
            .unwrap();
        let state = env.market_state(&market.market_state);
        assert_eq!(
            lending_amm::buffer::band(state.reserves[lent_side], env.lent_total(&market)),
            lending_amm::buffer::Band::Below
        );
        market
    }

    /// The lending AMM's `rebalance` on `market`, called by `caller`.
    pub fn rebalance_instruction(&self, market: &Market, caller: &Pubkey) -> Instruction {
        let name = lent_name(self.lent_entry_of(market));
        let k = &self.kamino;
        let a = &market.addresses;
        let accounts = vec![
            AccountMeta::new_readonly(*caller, true),
            AccountMeta::new(market.market_state, false),
            AccountMeta::new_readonly(a.authority, false),
            AccountMeta::new(market.vaults[market.lent_index], false),
            AccountMeta::new(a.ctoken_account, false),
            AccountMeta::new_readonly(market.mints[market.lent_index], false),
            AccountMeta::new(k.address(&format!("reserve-{name}")), false),
            AccountMeta::new_readonly(k.address("lending-market"), false),
            AccountMeta::new_readonly(k.address("lending-market-authority"), false),
            AccountMeta::new(k.address(&format!("liquidity-supply-{name}")), false),
            AccountMeta::new(k.address(&format!("collateral-mint-{name}")), false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(klend(), false),
            AccountMeta::new_readonly(instructions_sysvar(), false),
        ];
        Instruction::new_with_bytes(strategy_id(), &anchor_discriminator("rebalance"), accounts)
    }

    /// `rebalance` on `market`, called and paid for by `caller`, a fresh wallet when `None`.
    pub fn rebalance(
        &mut self,
        market: &Market,
        caller: Option<&Keypair>,
    ) -> Result<TransactionMetadata, String> {
        self.load_klend();
        let fresh;
        let caller = match caller {
            Some(caller) => caller,
            None => {
                fresh = Keypair::new();
                self.svm.airdrop(&fresh.pubkey(), super::SOL).unwrap();
                &fresh
            }
        };
        let instruction = self.rebalance_instruction(market, &caller.pubkey());
        self.send_meta(&[instruction], &[caller])
    }
}
