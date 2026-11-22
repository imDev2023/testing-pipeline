//! Measurements built exactly at the band and tolerance edges, for the judging functions'
//! tests (a round trip through a real pool cannot be made to land on 950,000 parts per
//! million). Every helper is `pub` for the test files that use it.

#![allow(dead_code)]

use canary::checks::exit_sizes::{Measured, Pair};
use canary::checks::readable::Trading;
use canary::config::{PPM, SOL_REFERENCE_SIZE, SOL_SIZES};
use canary::failure::{Failure, FailureClass, Stage};
use canary::market::MintFacts;
use canary::sizes::{Basis, Ladder};
use canary::swap::SwapReceipt;
use canary::trade::{ClockPosition, Leg, Quote, RoundTrip};
use pipeline_client::Pubkey;

pub const CLOCK: ClockPosition = ClockPosition {
    slot: 1,
    epoch: 1,
    unix_timestamp: 1,
};

pub fn receipt(spent: u64, received: u64) -> SwapReceipt {
    SwapReceipt {
        trader_spent: spent,
        trader_received: received,
        net_sent: spent,
        received,
        pipeline_fee: 0,
        fee_mint: 0,
        compute_units: 1,
        strategy_compute_units: None,
    }
}

pub fn quote_for(r: &SwapReceipt) -> Quote {
    Quote {
        amount_in: r.net_sent,
        net_sent: r.net_sent,
        pipeline_fee: r.pipeline_fee,
        fee_mint: r.fee_mint,
        total_spend: r.trader_spent,
        amount_out: r.received,
        strategy_amount_out: r.received,
        compute_units: 1,
    }
}

pub fn leg(amount_in: u64, swap: Result<SwapReceipt, Failure>) -> Leg {
    let quote = match &swap {
        Ok(r) => Ok(quote_for(r)),
        Err(f) => Err(f.clone()),
    };
    Leg {
        input: 0,
        output: 1,
        amount_in,
        clock: CLOCK,
        quote,
        swap,
    }
}

pub fn refused(stage: Stage) -> Failure {
    Failure::plain(
        stage,
        FailureClass::StrategyRefused,
        &Pubkey::new_unique(),
        "WrongStatus",
    )
}

/// A round trip of `amount` that put `amount` in and got back `return_ppm` of it.
pub fn sold(amount: u64, return_ppm: u64) -> RoundTrip {
    let back = (amount as u128 * return_ppm as u128 / PPM as u128) as u64;
    RoundTrip {
        amount,
        wallet: Pubkey::new_unique(),
        buy: leg(amount, Ok(receipt(amount, amount))),
        sell: Some(leg(amount, Ok(receipt(amount, back)))),
    }
}

/// A round trip whose buy worked and whose sale failed.
pub fn stuck(amount: u64) -> RoundTrip {
    RoundTrip {
        amount,
        wallet: Pubkey::new_unique(),
        buy: leg(amount, Ok(receipt(amount, amount))),
        sell: Some(leg(amount, Err(refused(Stage::Swap)))),
    }
}

/// A round trip whose buy failed.
pub fn unbought(amount: u64) -> RoundTrip {
    RoundTrip {
        amount,
        wallet: Pubkey::new_unique(),
        buy: leg(amount, Err(refused(Stage::Swap))),
        sell: None,
    }
}

pub fn mint() -> MintFacts {
    MintFacts {
        address: Pubkey::new_unique(),
        token_program: pipeline_client::TOKEN_PROGRAM_ID,
        decimals: 9,
        supply: 0,
        mint_authority: None,
        freeze_authority: None,
        transfer_fee: None,
        transfer_hook: None,
        permanent_delegate: None,
        pause_authority: None,
    }
}

/// The wrapped SOL ladder, with one row per size.
pub fn measured(rows: Vec<RoundTrip>) -> Measured {
    assert_eq!(rows.len(), SOL_SIZES.len());
    Measured {
        money: 0,
        ladder: Ladder {
            basis: Basis::Sol,
            sizes: SOL_SIZES.to_vec(),
            reference: SOL_REFERENCE_SIZE,
        },
        money_vault: 1_000 * SOL_SIZES[4],
        money_decimals: 9,
        mints: vec![mint(), mint()],
        pairs: vec![Pair { token: 1, rows }],
    }
}

/// Every size at `ppm`, except those `edit` changes.
pub fn ladder_at(ppm: u64, edit: impl Fn(u64) -> Option<RoundTrip>) -> Measured {
    measured(
        SOL_SIZES
            .iter()
            .map(|a| edit(*a).unwrap_or_else(|| sold(*a, ppm)))
            .collect(),
    )
}

pub const OPEN: Trading = Trading::Open;
