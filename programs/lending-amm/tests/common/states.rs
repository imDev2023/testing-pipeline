//! Kamino's states in the tests, each made by editing the cloned accounts klend's deployed bytes
//! then run on (docs/spec/lending-pool.md, "When Kamino can't pay"), and withdraw mode's measure
//! of a market against them.

use lending_amm::kamino::{lending_market_offsets, offsets};

use super::{Env, Market};

/// A state of Kamino the market must react to, one per row of "When Kamino can't pay".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KaminoState {
    Normal,
    /// Borrowers have taken all but this much of the reserve's liquidity.
    LittleFreeLiquidity(u64),
    /// The reserve's withdrawal cap has nothing left in the current interval.
    CapUsedUp,
    BlockCtokenUsage,
    ReserveEmergencyMode,
    MarketEmergencyMode,
    /// A write-off reached the reserve's whole supply, so klend set its version to `u64::MAX`.
    Deprecated,
    /// The reserve no longer carries a reserve's discriminator, as after a layout change.
    FailsLayoutCheck,
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

fn u128_at(data: &[u8], at: usize) -> u128 {
    u128::from_le_bytes(data[at..at + 16].try_into().unwrap())
}

impl Env {
    /// Puts the reserve a market lends to into `state`.
    pub fn set_kamino_state(&mut self, market: &Market, state: KaminoState) {
        let reserve = self.reserve_of(market);
        match state {
            KaminoState::Normal => {}
            KaminoState::LittleFreeLiquidity(free) => self.set_free_liquidity(market, free),
            KaminoState::CapUsedUp => {
                // A day-long interval that started now, with its whole capacity withdrawn.
                let now = self.clock().unix_timestamp as u64;
                let mut fields = Vec::new();
                fields.extend_from_slice(&1_000_000i64.to_le_bytes());
                fields.extend_from_slice(&1_000_000i64.to_le_bytes());
                fields.extend_from_slice(&now.to_le_bytes());
                fields.extend_from_slice(&86_400u64.to_le_bytes());
                self.patch(&reserve, offsets::WITHDRAWAL_CAP, &fields);
            }
            KaminoState::BlockCtokenUsage => {
                self.patch(&reserve, offsets::BLOCK_CTOKEN_USAGE, &[1])
            }
            KaminoState::ReserveEmergencyMode => {
                self.patch(&reserve, offsets::EMERGENCY_MODE, &[1])
            }
            KaminoState::MarketEmergencyMode => {
                let lending_market = self.kamino.address("lending-market");
                self.patch(
                    &lending_market,
                    lending_market_offsets::EMERGENCY_MODE,
                    &[1],
                );
            }
            KaminoState::Deprecated => {
                self.patch(&reserve, offsets::VERSION, &u64::MAX.to_le_bytes())
            }
            KaminoState::FailsLayoutCheck => self.patch(&reserve, 0, &[0u8; 8]),
        }
    }

    /// Sets the freely available liquidity of the reserve a market lends to, as borrowers
    /// borrowing it or repaying it would: what leaves `total_available_amount` joins
    /// `borrowed_amount_sf` and back, so the reserve's total supply, and with it the rate, stays
    /// as it was, and the tokens leave the reserve's liquidity supply or come back to it.
    pub fn set_free_liquidity(&mut self, market: &Market, free: u64) {
        let reserve = self.reserve_of(market);
        let data = self.data(&reserve);
        let available = u64_at(&data, offsets::TOTAL_AVAILABLE_AMOUNT);
        let borrowed = u128_at(&data, offsets::BORROWED_AMOUNT_SF);
        // Queued withdrawal tickets would hold some of it back; the dumps have none.
        assert_eq!(u64_at(&data, offsets::QUEUED_COLLATERAL_AMOUNT), 0);
        let borrowed = if free <= available {
            borrowed + (((available - free) as u128) << 60)
        } else {
            borrowed
                .checked_sub(((free - available) as u128) << 60)
                .expect("borrowers can repay only what they owe")
        };
        self.patch(
            &reserve,
            offsets::TOTAL_AVAILABLE_AMOUNT,
            &free.to_le_bytes(),
        );
        self.patch(
            &reserve,
            offsets::BORROWED_AMOUNT_SF,
            &borrowed.to_le_bytes(),
        );
        // The liquidity itself leaves the reserve's liquidity supply for the borrowers, or comes
        // back, as klend's borrow and repay move it, lamports and all for WSOL.
        let lent = self.lent_entry_of(market);
        let vault_address = self.kamino.address(&format!(
            "liquidity-supply-{}",
            super::kamino::lent_name(lent)
        ));
        let mut vault = self.svm.get_account(&vault_address).unwrap();
        let held = (u64_at(&vault.data, 64) + free)
            .checked_sub(available)
            .expect("the supply holds what is available");
        vault.data[64..72].copy_from_slice(&held.to_le_bytes());
        if lending_amm::config::LENT_MINTS[lent].mint == lending_amm::config::WSOL {
            vault.lamports = (vault.lamports + free) - available;
        }
        self.svm.set_account(vault_address, vault).unwrap();
        assert_eq!(self.free_liquidity(market), free);
    }

    /// The freely available liquidity of the reserve a market lends to, as the program reads it.
    pub fn free_liquidity(&self, market: &Market) -> u64 {
        self.program_reserve(market).freely_available()
    }

    /// Withdraw mode's measure of a market, `X = max(V, T)`: the larger of its lent value `V` and
    /// its target lent value `T`, what it would lend with the buffer at its target, from the
    /// market state and the reserve as they are.
    pub fn exposure(&self, market: &Market) -> u64 {
        let state = self.market_state(&market.market_state);
        let value = self
            .program_reserve(market)
            .lent_value(state.ctokens)
            .unwrap();
        let total = state.reserves[market.lent_index] + value;
        value.max(total - lending_amm::buffer::target(total))
    }
}

/// How much of a reserve's supply a write-off forgives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loss {
    /// This much, in base units of the lent mint.
    Part(u64),
    /// All of it: after borrowers have taken all the free liquidity, a debt of exactly the
    /// reserve's total supply, so the write-off reaches its whole supply and klend deprecates the
    /// reserve.
    Everything,
}

impl Env {
    /// Kamino's lending market owner writes off `loss` of the reserve a market lends to, with
    /// klend's real `socialize_loss`, as after a liquidation that left bad debt: a borrower owes
    /// that much with no collateral, the debt taken from the reserve's free liquidity where its
    /// borrowed amount is short of it (which leaves the rate as it was), in an obligation written
    /// for it; then one transaction runs klend's `refresh_reserve`, `refresh_obligation` and
    /// `socialize_loss`, signed by the owner, which lowers the reserve's total supply by the debt
    /// forgiven.
    ///
    /// The edits beyond the obligation only let the transaction run in a VM without oracles: the
    /// lending market's owner becomes a test key, the reserve's saved price is marked as just
    /// updated with every price check passed and the lending market reads an oracle only for a
    /// price as old as its maximum age, so klend needs no oracle account to refresh it, and any
    /// debt farm is cleared, so klend needs no farm accounts around the write-off.
    pub fn write_off(
        &mut self,
        market: &Market,
        loss: Loss,
    ) -> litesvm::types::TransactionMetadata {
        use super::kamino::{
            klend_layout as k, refresh_obligation, refresh_reserve, socialize_loss,
        };
        use solana_signer::Signer;
        self.load_klend();
        let lent = self.lent_entry_of(market);
        let reserve = self.reserve_of(market);
        let lending_market = self.kamino.address("lending-market");
        let free = self.free_liquidity(market);
        let (debt_sf, amount) = match loss {
            Loss::Part(loss) => {
                let borrowed =
                    (u128_at(&self.data(&reserve), offsets::BORROWED_AMOUNT_SF) >> 60) as u64;
                let needed = loss.saturating_sub(borrowed);
                self.set_free_liquidity(
                    market,
                    free.checked_sub(needed).expect("less than is free"),
                );
                ((loss as u128) << 60, loss)
            }
            Loss::Everything => {
                // Exactly the whole supply, as of a refresh this slot, which accrues nothing:
                // klend deprecates a reserve once a write-off reaches its whole supply, and
                // panics on one beyond it where protocol fees make the supply smaller than what
                // is borrowed.
                self.set_free_liquidity(market, 0);
                let clock = self.clock();
                self.patch(
                    &reserve,
                    k::RESERVE_LAST_UPDATE_SLOT,
                    &clock.slot.to_le_bytes(),
                );
                self.patch(
                    &reserve,
                    k::RESERVE_LAST_UPDATE_TIMESTAMP,
                    &(clock.unix_timestamp as u32).to_le_bytes(),
                );
                (
                    self.program_reserve(market).total_supply_sf().unwrap(),
                    u64::MAX,
                )
            }
        };

        let owner = solana_keypair::Keypair::new();
        self.svm.airdrop(&owner.pubkey(), super::SOL).unwrap();
        self.patch(&lending_market, k::MARKET_OWNER, owner.pubkey().as_ref());
        self.patch(&lending_market, k::MARKET_PRICE_REFRESH_TRIGGER_PCT, &[100]);
        let now = self.clock().unix_timestamp as u64;
        self.patch(&reserve, k::RESERVE_PRICE_STATUS, &[k::ALL_PRICE_CHECKS]);
        self.patch(&reserve, k::RESERVE_PRICE_UPDATED_AT, &now.to_le_bytes());
        self.patch(&reserve, k::RESERVE_FARM_DEBT, &[0u8; 32]);

        let rate = self.data(&reserve)[k::RESERVE_CUMULATIVE_BORROW_RATE..][..48].to_vec();
        let mut data = vec![0u8; k::OBLIGATION_LEN];
        data[..8].copy_from_slice(&k::OBLIGATION_DISCRIMINATOR);
        data[k::OBLIGATION_LENDING_MARKET..][..32].copy_from_slice(lending_market.as_ref());
        data[k::OBLIGATION_OWNER..][..32].copy_from_slice(owner.pubkey().as_ref());
        data[k::OBLIGATION_BORROW_RESERVE..][..32].copy_from_slice(reserve.as_ref());
        data[k::OBLIGATION_BORROW_RATE..][..48].copy_from_slice(&rate);
        data[k::OBLIGATION_BORROWED_AT..][..8].copy_from_slice(&now.to_le_bytes());
        data[k::OBLIGATION_BORROWED_SF..][..16].copy_from_slice(&debt_sf.to_le_bytes());
        data[k::OBLIGATION_HAS_DEBT] = 1;
        let obligation = pipeline_client::Pubkey::new_unique();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                obligation,
                solana_account::Account {
                    lamports,
                    data,
                    owner: super::kamino::klend(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();

        let instructions = [
            refresh_reserve(&self.kamino, lent),
            refresh_obligation(&self.kamino, lent, &obligation),
            socialize_loss(&self.kamino, lent, &owner.pubkey(), &obligation, amount),
        ];
        self.send_meta(&instructions, &[&owner])
            .unwrap_or_else(|e| panic!("klend's socialize_loss: {e}"))
    }
}

impl Env {
    /// klend's `refresh_reserve` for the reserve a market lends to, as a keeper puts it before
    /// `rebalance` in the same transaction when the reserve's stored rate is stale, so the
    /// redeem is planned at a rate refreshed this slot (docs/spec/lending-pool.md, "The rule").
    /// A keeper passes the reserve's oracle accounts; the VM has none, so the reserve's saved
    /// price is marked as just updated and the lending market made to read an oracle only for a
    /// price as old as its maximum age, which lets klend refresh without one.
    pub fn refresh_reserve_instruction(&mut self, market: &Market) -> pipeline_client::Instruction {
        use super::kamino::klend_layout as k;
        let reserve = self.reserve_of(market);
        let lending_market = self.kamino.address("lending-market");
        let now = self.clock().unix_timestamp as u64;
        self.patch(&lending_market, k::MARKET_PRICE_REFRESH_TRIGGER_PCT, &[100]);
        self.patch(&reserve, k::RESERVE_PRICE_STATUS, &[k::ALL_PRICE_CHECKS]);
        self.patch(&reserve, k::RESERVE_PRICE_UPDATED_AT, &now.to_le_bytes());
        super::kamino::refresh_reserve(&self.kamino, self.lent_entry_of(market))
    }
}
