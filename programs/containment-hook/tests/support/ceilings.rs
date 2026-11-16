//! The compute ceilings (docs/spec/containment-hook.md, "Compute ceilings"; docs/spec/
//! README.md, "Test layers" 5): the spec's table, and its one place in the tests. A ceiling
//! changes only by a PR to the spec file and this table together; `tests/compute.rs` checks
//! they agree.
//!
//! A cost is what the hook's own invocation consumes. `tests/compute.rs` measures each
//! instruction on a typical launch, and the invariant fuzzer (`tests/fuzz.rs`) measures every
//! invocation of the hook in every step it runs, against the same ceilings.

/// The spec's table, in compute units.
pub const EXECUTE: u64 = 10_000;
pub const BIND: u64 = 60_000;
pub const UNLOCK: u64 = 30_000;

/// What a PDA's bump search costs for each bump it tries after the first: one more
/// `create_program_address`, as the tax AMM measured (`tax-amm/tests/common/ceilings.rs`).
pub const BUMP_TRY: u64 = super::common::ceilings::BUMP_TRY;

/// The compute `bind` of `mint` to `market` spends searching for bumps beyond each address's
/// first, which its ceiling leaves out (docs/spec/containment-hook.md, "Compute ceilings"):
/// it searches once for each of its three PDAs (the config, the validation account and the
/// unlock PDA) and once for the fee account's associated token address, and how many bumps
/// each takes depends on the mint's address.
pub fn bind_bump_search(mint: &super::Pubkey, market: &super::Market) -> u64 {
    use super::{config_pda, fee_account, hook_id, unlock_pda, validation_pda, Pubkey};
    let extra = |address: Pubkey, seeds: &[&[u8]], program: &Pubkey| {
        let (found, bump) = Pubkey::find_program_address(seeds, program);
        assert_eq!(found, address);
        (255 - bump) as u64
    };
    let hook = hook_id();
    let fee_authority = pipeline_client::pda::fee_authority(&market.market);
    let tries = extra(config_pda(mint), &[b"config", mint.as_ref()], &hook)
        + extra(
            validation_pda(mint),
            &[b"extra-account-metas", mint.as_ref()],
            &hook,
        )
        + extra(unlock_pda(mint), &[b"unlock", mint.as_ref()], &hook)
        + extra(
            fee_account(market, mint),
            &[
                fee_authority.as_ref(),
                super::TOKEN_2022.as_ref(),
                mint.as_ref(),
            ],
            &pipeline_client::ASSOCIATED_TOKEN_PROGRAM_ID,
        );
    tries * BUMP_TRY
}
