//! Donations (docs/spec/tax-amm.md, "Credited input" and "Locked for good"): tokens sent
//! straight to a vault are never credited as input, never paid out, and change no reserve,
//! owed amount or counter. Each test trades two identical markets the same way, one of
//! them with tokens sent to both its vaults before every swap.

mod common;

use common::model::Model;
use common::*;
use pipeline_client::Pubkey;

#[test]
fn tokens_sent_to_either_vault_before_a_swap_change_nothing_but_the_vaults_balance() {
    for tax_side in [0u8, 1] {
        let mut env = Env::new();
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN_2022), TOKEN_2022),
        ];
        let mut p = valid_params(&Pubkey::new_unique());
        p.tax_side = tax_side;
        let seed = [100_000_000_000, 200_000_000_000];
        let plain = env.seeded_market(mints, &p, seed);
        let donated = env.seeded_market(mints, &p, seed);
        let trader = env.funded_wallet(&plain, 1_000_000_000_000);
        let donor = env.funded_wallet(&donated, 1_000_000_000_000);

        let mut donations = [0u64; 2];
        for (step, (i, o, amount)) in [
            (0, 1, 1_000_000_000u64),
            (1, 0, 3_000_000_000),
            (0, 1, 5_000_000_000),
            (1, 0, 7),
        ]
        .into_iter()
        .enumerate()
        {
            for (v, total) in donations.iter_mut().enumerate() {
                let gift = 1_000 * (step as u64 + 1) + v as u64;
                env.transfer(&donated, &donor, v, donated.vaults[v], gift)
                    .unwrap();
                *total += gift;
            }
            let without = env.swap(&plain, &trader, (i, o), amount).unwrap();
            let with = env.swap(&donated, &trader, (i, o), amount).unwrap();
            // Nothing extra credited or paid out.
            assert_eq!(with, without);
            // Reserves, owed amounts and counters exactly as without the gifts.
            Model::of(&env.tax_market(&plain.market_state))
                .assert_matches(&env.tax_market(&donated.market_state));
            // The gifts stay in the vaults, outside everything the market has recorded.
            for (v, total) in donations.iter().enumerate() {
                assert_eq!(
                    env.balance(&donated.vaults[v]),
                    env.balance(&plain.vaults[v]) + total
                );
            }
        }
    }
}
