//! The tax authority's three actions (docs/spec/tax-amm.md, "Tax authority"), built as
//! `metadata.json` lists them: the signer, then the market state, writable.

#![allow(dead_code)]

use anchor_lang::InstructionData;
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::config::MAX_RECIPIENTS;
use tax_amm::InitParams;

use super::*;

fn accounts(market_state: &Pubkey, signer: &Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(*signer, true),
        AccountMeta::new(*market_state, false),
    ]
}

/// `set_taxes { buy_tax_bps, sell_tax_bps }`, signed by `signer`.
pub fn set_taxes_instruction(
    market_state: &Pubkey,
    signer: &Pubkey,
    buy_tax_bps: u16,
    sell_tax_bps: u16,
) -> Instruction {
    let data = tax_amm::instruction::SetTaxes {
        buy_tax_bps,
        sell_tax_bps,
    }
    .data();
    Instruction::new_with_bytes(strategy_id(), &data, accounts(market_state, signer))
}

/// The tax recipients, their shares and the burn share, as `set_recipients` takes them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Split {
    pub recipients: [Pubkey; MAX_RECIPIENTS],
    pub shares: [u16; MAX_RECIPIENTS],
    pub burn_share_bps: u16,
}

impl Split {
    /// The split a set of creation parameters holds.
    pub fn of(params: &InitParams) -> Split {
        Split {
            recipients: params.recipients.map(|r| ck(&r)),
            shares: params.shares,
            burn_share_bps: params.burn_share_bps,
        }
    }

    /// The split a market state holds now.
    pub fn of_market(state: &tax_amm::TaxMarket) -> Split {
        Split::of(&state.params())
    }
}

/// `set_recipients { recipient_0..3, share_0..3, burn_share_bps }`, signed by `signer`.
pub fn set_recipients_instruction(
    market_state: &Pubkey,
    signer: &Pubkey,
    split: &Split,
) -> Instruction {
    let data = tax_amm::instruction::SetRecipients {
        recipients: split.recipients.map(|r| ak(&r)),
        shares: split.shares,
        burn_share_bps: split.burn_share_bps,
    }
    .data();
    Instruction::new_with_bytes(strategy_id(), &data, accounts(market_state, signer))
}

/// `renounce_tax_authority`, signed by `signer`.
pub fn renounce_instruction(market_state: &Pubkey, signer: &Pubkey) -> Instruction {
    let data = tax_amm::instruction::RenounceTaxAuthority {}.data();
    Instruction::new_with_bytes(strategy_id(), &data, accounts(market_state, signer))
}

/// One valid call of each action on a market whose state is `state`, signed by `signer`:
/// rates moved inside their ranges, a recipient replaced, and the renouncement.
pub fn each_action(
    market_state: &Pubkey,
    signer: &Pubkey,
    state: &tax_amm::TaxMarket,
) -> [(&'static str, Instruction); 3] {
    // A new recipient in the first unused slot, given one basis point of the first's share:
    // a slot owed nothing may change hands whatever the others are owed.
    let mut split = Split::of_market(state);
    let unused = tax_amm::params::used_slots(&state.recipients);
    assert!(
        unused < MAX_RECIPIENTS,
        "a market with an unused recipient slot"
    );
    split.recipients[unused] = Pubkey::new_unique();
    split.shares[0] -= 1;
    split.shares[unused] = 1;
    [
        (
            "set_taxes",
            set_taxes_instruction(
                market_state,
                signer,
                state.buy_tax_max_bps,
                state.sell_tax_min_bps,
            ),
        ),
        (
            "set_recipients",
            set_recipients_instruction(market_state, signer, &split),
        ),
        (
            "renounce_tax_authority",
            renounce_instruction(market_state, signer),
        ),
    ]
}

impl Env {
    /// Sends `instruction` signed by `signer`, paid for by the admin.
    pub fn send_signed(
        &mut self,
        instruction: Instruction,
        signer: &Keypair,
    ) -> Result<litesvm::types::TransactionMetadata, String> {
        if signer.pubkey() == self.admin.pubkey() {
            self.send_meta(&[instruction], &[])
        } else {
            self.send_meta(&[instruction], &[signer])
        }
    }
}
