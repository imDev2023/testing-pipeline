//! `remove_liquidity` and `lock_lp` in the tests: the instructions as an LP builds them from the
//! metadata (docs/spec/lending-pool.md, "Removing" and "Locking"), in cash with the lent mint's
//! Kamino accounts, or in kind with none.

use litesvm::types::TransactionMetadata;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;

use super::kamino::{instructions_sysvar, klend, lent_name};
use super::{anchor_discriminator, lp_shares_account, strategy_id, Env, Market, TOKEN};

/// How a removal pays the cTokens' part.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Payout {
    /// Redeemed from Kamino and paid in the lent mint.
    Cash,
    /// Paid as cTokens, with no Kamino account in the instruction.
    InKind,
}

/// `remove_liquidity`'s accounts, by name, in the order `metadata.json` lists them, so a test
/// can substitute any one of them.
pub const ACCOUNTS: [&str; 26] = [
    "lp",
    "market_state",
    "lp_mint",
    "lp_shares",
    "lp_token_0",
    "lp_token_1",
    "vault_0",
    "vault_1",
    "mint_0",
    "mint_1",
    "authority",
    "ctoken_account",
    "collateral_mint",
    "lp_ctoken",
    "token_program_0",
    "token_program_1",
    "token_program",
    "associated_token_program",
    "system_program",
    "klend_program",
    "reserve",
    "lending_market",
    "lending_market_authority",
    "reserve_liquidity_supply",
    "instructions_sysvar",
    "reserve_collateral_mint",
];

/// The position of the `remove_liquidity` account named `name` in [`ACCOUNTS`].
pub fn position(name: &str) -> usize {
    ACCOUNTS
        .iter()
        .position(|n| *n == name)
        .unwrap_or_else(|| panic!("no remove_liquidity account {name}"))
}

/// `lock_lp`'s accounts, by name, in the order `metadata.json` lists them.
pub const LOCK_ACCOUNTS: [&str; 9] = [
    "lp",
    "market_state",
    "lp_mint",
    "lp_shares",
    "lock_account",
    "authority",
    "token_program",
    "associated_token_program",
    "system_program",
];

impl Env {
    /// The market's collateral (cToken) mint.
    pub fn collateral_mint_of(&self, market: &Market) -> Pubkey {
        ck_key(&self.market_state(&market.market_state).collateral_mint)
    }

    /// A wallet's associated token account for the market's collateral mint, where an in-kind
    /// removal pays the cTokens.
    pub fn lp_ctoken_account(&self, market: &Market, wallet: &Pubkey) -> Pubkey {
        pda::associated_token(wallet, &self.collateral_mint_of(market), &TOKEN)
    }

    /// The market's lock account: the vault authority's associated token account for the LP
    /// mint.
    pub fn lock_account(&self, market: &Market) -> Pubkey {
        pda::associated_token(
            &market.addresses.authority,
            &market.addresses.lp_mint,
            &TOKEN,
        )
    }

    /// `remove_liquidity` of `shares` by `lp` from their shares account, paid into their
    /// associated token accounts, with the other mint's hook accounts after.
    pub fn remove_liquidity_instruction(
        &self,
        market: &Market,
        lp: &Pubkey,
        shares: u64,
        min: [u64; 2],
        payout: Payout,
    ) -> Instruction {
        let mut data = anchor_discriminator("remove_liquidity").to_vec();
        data.extend(borsh::to_vec(&(shares, min[0], min[1], payout == Payout::InKind)).unwrap());
        let a = &market.addresses;
        let mut accounts = vec![
            AccountMeta::new(*lp, true),
            AccountMeta::new(market.market_state, false),
            AccountMeta::new(a.lp_mint, false),
            AccountMeta::new(lp_shares_account(lp, &market.market_state), false),
            AccountMeta::new(self.wallet_token_account(market, lp, 0), false),
            AccountMeta::new(self.wallet_token_account(market, lp, 1), false),
            AccountMeta::new(market.vaults[0], false),
            AccountMeta::new(market.vaults[1], false),
            AccountMeta::new_readonly(market.mints[0], false),
            AccountMeta::new_readonly(market.mints[1], false),
            AccountMeta::new_readonly(a.authority, false),
            AccountMeta::new(a.ctoken_account, false),
            AccountMeta::new_readonly(self.collateral_mint_of(market), false),
            AccountMeta::new(self.lp_ctoken_account(market, lp), false),
            AccountMeta::new_readonly(market.token_programs[0], false),
            AccountMeta::new_readonly(market.token_programs[1], false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(client::ASSOCIATED_TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        ];
        match payout {
            Payout::Cash => {
                let name = lent_name(self.lent_entry_of(market));
                let k = &self.kamino;
                accounts.extend([
                    AccountMeta::new_readonly(klend(), false),
                    AccountMeta::new(k.address(&format!("reserve-{name}")), false),
                    AccountMeta::new_readonly(k.address("lending-market"), false),
                    AccountMeta::new_readonly(k.address("lending-market-authority"), false),
                    AccountMeta::new(k.address(&format!("liquidity-supply-{name}")), false),
                    AccountMeta::new_readonly(instructions_sysvar(), false),
                    AccountMeta::new(self.collateral_mint_of(market), false),
                ]);
            }
            // Anchor's way to leave an optional account out: the program's own id in its place.
            Payout::InKind => {
                accounts.extend((0..7).map(|_| AccountMeta::new_readonly(strategy_id(), false)))
            }
        }
        accounts.extend(market.hook_accounts[market.other_index()].iter().cloned());
        Instruction::new_with_bytes(strategy_id(), &data, accounts)
    }

    /// `remove_lent_side { lp, min_lent }` by `lp`: `remove_liquidity`'s first nineteen accounts.
    pub fn remove_lent_side_instruction(
        &self,
        market: &Market,
        lp: &Pubkey,
        shares: u64,
        min_lent: u64,
    ) -> Instruction {
        let mut instruction =
            self.remove_liquidity_instruction(market, lp, shares, [0, 0], Payout::InKind);
        instruction.accounts.truncate(19);
        let mut data = anchor_discriminator("remove_lent_side").to_vec();
        data.extend(borsh::to_vec(&(shares, min_lent)).unwrap());
        instruction.data = data;
        instruction
    }

    /// `remove_lent_side` sent by `lp`.
    pub fn remove_lent_side(
        &mut self,
        market: &Market,
        lp: &Keypair,
        shares: u64,
        min_lent: u64,
    ) -> Result<TransactionMetadata, String> {
        use solana_signer::Signer;
        let remove = self.remove_lent_side_instruction(market, &lp.pubkey(), shares, min_lent);
        self.send_meta(&[remove], &[lp])
    }

    /// `remove_liquidity` sent by `lp`.
    pub fn remove_liquidity(
        &mut self,
        market: &Market,
        lp: &Keypair,
        shares: u64,
        min: [u64; 2],
        payout: Payout,
    ) -> Result<TransactionMetadata, String> {
        use solana_signer::Signer;
        self.load_klend();
        let remove = self.remove_liquidity_instruction(market, &lp.pubkey(), shares, min, payout);
        self.send_meta(&[remove], &[lp])
    }

    /// `lock_lp` of `amount` of `lp`'s shares, from their shares account.
    pub fn lock_lp_instruction(&self, market: &Market, lp: &Pubkey, amount: u64) -> Instruction {
        let mut data = anchor_discriminator("lock_lp").to_vec();
        data.extend(borsh::to_vec(&amount).unwrap());
        let a = &market.addresses;
        let accounts = vec![
            AccountMeta::new(*lp, true),
            AccountMeta::new_readonly(market.market_state, false),
            AccountMeta::new_readonly(a.lp_mint, false),
            AccountMeta::new(lp_shares_account(lp, &market.market_state), false),
            AccountMeta::new(self.lock_account(market), false),
            AccountMeta::new_readonly(a.authority, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(client::ASSOCIATED_TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        ];
        Instruction::new_with_bytes(strategy_id(), &data, accounts)
    }

    /// `lock_lp` sent by `lp`.
    pub fn lock_lp(
        &mut self,
        market: &Market,
        lp: &Keypair,
        amount: u64,
    ) -> Result<TransactionMetadata, String> {
        use solana_signer::Signer;
        let lock = self.lock_lp_instruction(market, &lp.pubkey(), amount);
        self.send_meta(&[lock], &[lp])
    }

    /// An SPL Token burn of `amount` of `lp`'s shares, from their shares account.
    pub fn burn_shares(
        &mut self,
        market: &Market,
        lp: &Keypair,
        amount: u64,
    ) -> Result<TransactionMetadata, String> {
        use solana_signer::Signer;
        // SPL Token's `Burn`: tag 8, then the amount.
        let mut data = vec![8u8];
        data.extend_from_slice(&amount.to_le_bytes());
        let burn = Instruction::new_with_bytes(
            TOKEN,
            &data,
            vec![
                AccountMeta::new(lp_shares_account(&lp.pubkey(), &market.market_state), false),
                AccountMeta::new(market.addresses.lp_mint, false),
                AccountMeta::new_readonly(lp.pubkey(), true),
            ],
        );
        self.send_meta(&[burn], &[lp])
    }

    /// Runs `instructions` in simulation, paid for by the admin and signed by `signers` too.
    pub fn simulate_signed(
        &self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, String> {
        use solana_signer::Signer;
        let mut all = vec![&self.admin];
        all.extend_from_slice(signers);
        let tx = solana_transaction::Transaction::new_signed_with_payer(
            instructions,
            Some(&self.admin.pubkey()),
            &all,
            self.svm.latest_blockhash(),
        );
        self.svm
            .simulate_transaction(tx)
            .map(|info| info.meta)
            .map_err(|failed| format!("{:?}\n{}", failed.err, failed.meta.logs.join("\n")))
    }

    /// The LP shares `wallet` holds in their shares account.
    pub fn lp_shares_of(&self, market: &Market, wallet: &Pubkey) -> u64 {
        self.balance_or_zero(&lp_shares_account(wallet, &market.market_state))
    }
}

fn ck_key(key: &anchor_lang::prelude::Pubkey) -> Pubkey {
    super::ck(key)
}
