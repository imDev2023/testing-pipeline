//! Where the tax goes (docs/spec/tax-amm.md, "Where the tax goes" and "Payout"): each tax
//! is booked as owed to its slots, the suite share first, then the tax recipients' parts by
//! their shares and the burn, with the rounding remainder to the first recipient; nothing
//! is paid out in a swap. The expected parts below are worked out by hand.

mod common;

use common::model::Model;
use common::*;
use pipeline_client::Pubkey;

/// A buy of 10,010 units at a 10% buy tax pays a tax of ceil(1,001) = 1,001: a suite share
/// of floor(100.1) = 100 and a creator's part of 901, which no share divides evenly.
const INPUT: u64 = 10_010;
const TAX: u64 = 1_001;

/// Shares of the creator's part, the burn share, and the parts of the tax each slot is
/// owed (recipients 0 to 3, the burn, the suite share), worked out by hand from 901.
const CASES: [([u16; 4], u16, [u64; 6]); 6] = [
    // One recipient: all 901.
    ([10_000, 0, 0, 0], 0, [901, 0, 0, 0, 0, 100]),
    // One recipient and a 25% burn: 675.75 → 675 and 225.25 → 225, remainder 1.
    ([7_500, 0, 0, 0], 2_500, [676, 0, 0, 0, 225, 100]),
    // Two halves: 450.5 → 450 each, remainder 1.
    ([5_000, 5_000, 0, 0], 0, [451, 450, 0, 0, 0, 100]),
    // Two recipients and a 10% burn: 540.6 → 540, 270.3 → 270, 90.1 → 90, remainder 1.
    ([6_000, 3_000, 0, 0], 1_000, [541, 270, 0, 0, 90, 100]),
    // Four quarters: 225.25 → 225 each, remainder 1.
    (
        [2_500, 2_500, 2_500, 2_500],
        0,
        [226, 225, 225, 225, 0, 100],
    ),
    // Four recipients and a 10% burn: 360.4, 270.3, 135.15, 45.05 and 90.1, remainder 1.
    (
        [4_000, 3_000, 1_500, 500],
        1_000,
        [361, 270, 135, 45, 90, 100],
    ),
];

#[test]
fn each_tax_is_split_exactly_with_one_two_and_four_recipients_with_and_without_a_burn() {
    for (shares, burn_share_bps, expected) in CASES {
        let mut env = Env::new();
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN), TOKEN),
        ];
        let mut p = valid_params(&Pubkey::new_unique());
        p.tax_side = 0;
        p.buy_tax_max_bps = 1_000;
        p.buy_tax_bps = 1_000;
        for (slot, &share) in shares.iter().enumerate() {
            p.recipients[slot] = if share > 0 {
                ak(&Pubkey::new_unique())
            } else {
                anchor_lang::prelude::Pubkey::default()
            };
        }
        p.shares = shares;
        p.burn_share_bps = burn_share_bps;
        let market = env.seeded_market(mints, &p, [100_000_000_000, 200_000_000_000]);
        let trader = env.funded_wallet(&market, 1_000_000_000);

        env.swap(&market, &trader, (0, 1), INPUT).unwrap();
        let state = env.tax_market(&market.market_state);
        assert_eq!(state.tax_collected, TAX as u128);
        assert_eq!(
            state.owed, expected,
            "shares {shares:?}, burn {burn_share_bps}"
        );
        assert_eq!(state.owed.iter().sum::<u64>(), TAX);

        // A second swap adds its own split on top, and the books still add up to every tax
        // taken: nothing was paid out.
        let mut model = Model::of(&state);
        env.swap(&market, &trader, (0, 1), 123_456).unwrap();
        model.swap(0, 1, 123_456).unwrap();
        let state = env.tax_market(&market.market_state);
        model.assert_matches(&state);
        assert_eq!(
            state.owed.iter().map(|&o| o as u128).sum::<u128>(),
            state.tax_collected
        );
    }
}
