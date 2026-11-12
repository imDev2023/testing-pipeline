//! Native SOL can't be burned, so a tax side of either native SOL mint has no burn share
//! (docs/spec/tax-amm.md, "Creation parameters").

mod common;

use anchor_lang::prelude::Pubkey as AnchorKey;
use common::*;
use pipeline_client::Pubkey;
use tax_amm::params::NATIVE_MINTS;
use tax_amm::StrategyError;

/// SPL Token's and Token-2022's native mints as they exist on every cluster, written into
/// the VM: initialized, no authorities, 9 decimals.
fn write_native_mint(env: &mut Env, mint: &AnchorKey, token_program: &Pubkey) -> Pubkey {
    let mut data = vec![0u8; 82];
    data[44] = 9;
    data[45] = 1;
    let mint = ck(mint);
    let account = solana_account::Account {
        lamports: env.svm.minimum_balance_for_rent_exemption(data.len()),
        data,
        owner: *token_program,
        executable: false,
        rent_epoch: 0,
    };
    env.svm.set_account(mint, account).unwrap();
    mint
}

#[test]
fn a_burn_share_on_a_native_sol_tax_side_is_refused() {
    for (native, token_program) in [(NATIVE_MINTS[0], TOKEN), (NATIVE_MINTS[1], TOKEN_2022)] {
        let mut env = Env::new();
        let sol = write_native_mint(&mut env, &native, &token_program);
        let token = env.create_mint(&TOKEN);
        let mints = [(token, TOKEN), (sol, token_program)];

        // The valid parameters burn 10% of the creator's part of a tax on side 1.
        let burning = valid_params(&Pubkey::new_unique());
        assert_eq!(burning.tax_side, 1);
        assert!(burning.burn_share_bps > 0);
        assert_refused(
            env.create_tax_market(mints, &burning),
            StrategyError::BurnOnNativeSol,
        );

        // The same market without a burn is created.
        let mut whole = burning;
        whole.shares[0] += whole.burn_share_bps;
        whole.burn_share_bps = 0;
        env.create_tax_market(mints, &whole).unwrap();

        // Burning the other side, a token that isn't SOL, is allowed.
        let mut other_side = burning;
        other_side.tax_side = 0;
        env.create_tax_market(mints, &other_side).unwrap();
    }
}
