//! `distribute` (docs/spec/tax-amm.md, "Payout"): anyone pays out one tax slot at a time,
//! a tax recipient or the suite share to the associated token account of its wallet for
//! the tax-side mint, created at the caller's expense when missing, and the burn by burning
//! from the vault.

mod common;

use common::*;
use pipeline_client::{pda, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::state::{BURN_SLOT, SUITE_SLOT};
use tax_amm::StrategyError;

const SEED: [u64; 2] = [100_000_000_000, 200_000_000_000];

/// A seeded market on `mints` with [`valid_params`] (taxed on side 1, two tax recipients
/// and a burn), traded both ways so every used slot is owed something.
fn traded_market(env: &mut Env, mints: [(Pubkey, Pubkey); 2]) -> Market {
    let market = env.seeded_market(mints, &valid_params(&Pubkey::new_unique()), SEED);
    let trader = env.funded_wallet(&market, 1_000_000_000_000);
    env.swap(&market, &trader, (1, 0), 10_000_000_000).unwrap();
    env.swap(&market, &trader, (0, 1), 5_000_000_000).unwrap();
    market
}

/// A wallet that is no tax recipient, holding SOL to pay for token accounts.
fn caller(env: &mut Env) -> Keypair {
    let caller = Keypair::new();
    env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
    caller
}

/// The associated token account of a slot's wallet for the market's tax-side mint.
fn slot_account(env: &Env, market: &Market, slot: u8) -> Pubkey {
    let state = env.tax_market(&market.market_state);
    let side = state.tax_side as usize;
    pda::associated_token(
        &slot_wallet(&state, slot),
        &market.mints[side],
        &market.token_programs[side],
    )
}

#[test]
fn a_tax_recipient_is_paid_its_whole_owed_amount_into_a_token_account_created_for_it() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let market = traded_market(&mut env, mints);
    let owed = env.tax_market(&market.market_state).owed[0];
    assert!(owed > 0);
    let account = slot_account(&env, &market, 0);
    assert!(env.svm.get_account(&account).is_none(), "no account yet");

    let caller = caller(&mut env);
    env.distribute(&market, &caller, 0).unwrap();

    assert_eq!(env.balance(&account), owed);
    assert_eq!(env.tax_market(&market.market_state).owed[0], 0);
}

#[test]
fn the_suite_share_is_paid_to_the_suite_treasury() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let market = traded_market(&mut env, mints);
    let owed = env.tax_market(&market.market_state).owed[SUITE_SLOT as usize];
    assert!(owed > 0);

    let caller = caller(&mut env);
    env.distribute(&market, &caller, SUITE_SLOT).unwrap();

    let treasury = pda::associated_token(
        &ck(&tax_amm::config::SUITE_TREASURY),
        &market.mints[1],
        &TOKEN,
    );
    assert_eq!(env.balance(&treasury), owed);
    assert_eq!(
        env.tax_market(&market.market_state).owed[SUITE_SLOT as usize],
        0
    );
}

#[test]
fn the_burn_slot_burns_its_owed_amount_from_the_vault() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let market = traded_market(&mut env, mints);
    let owed = env.tax_market(&market.market_state).owed[BURN_SLOT as usize];
    assert!(owed > 0);
    let supply = 10 * SEED[1];
    env.set_supply(&market.mints[1], supply);
    let vault = env.balance(&market.vaults[1]);

    let caller = caller(&mut env);
    env.distribute(&market, &caller, BURN_SLOT).unwrap();

    assert_eq!(env.supply(&market.mints[1]), supply - owed);
    assert_eq!(env.balance(&market.vaults[1]), vault - owed);
    assert_eq!(
        env.tax_market(&market.market_state).owed[BURN_SLOT as usize],
        0
    );
}

#[test]
fn a_slot_with_nothing_owed_moves_nothing_and_creates_no_account() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let market = env.seeded_market(mints, &valid_params(&Pubkey::new_unique()), SEED);
    env.set_supply(&market.mints[1], 10 * SEED[1]);
    let caller = caller(&mut env);
    for slot in [0, 1, BURN_SLOT, SUITE_SLOT] {
        let before = env.tax_market(&market.market_state);
        let vault = env.balance(&market.vaults[1]);
        let supply = env.supply(&market.mints[1]);
        env.distribute(&market, &caller, slot).unwrap();
        let after = env.tax_market(&market.market_state);
        assert_eq!(format!("{before:?}"), format!("{after:?}"), "slot {slot}");
        assert_eq!(env.balance(&market.vaults[1]), vault, "slot {slot}");
        assert_eq!(env.supply(&market.mints[1]), supply, "slot {slot}");
        if slot != BURN_SLOT {
            let account = slot_account(&env, &market, slot);
            assert!(env.svm.get_account(&account).is_none(), "slot {slot}");
        }
    }
}

#[test]
fn an_unused_slot_and_a_slot_out_of_range_are_refused() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    // valid_params uses recipient slots 0 and 1, so 2 and 3 are unused.
    let market = traded_market(&mut env, mints);
    let caller = caller(&mut env);
    for unused in [2, 3] {
        assert_refused(
            env.distribute(&market, &caller, unused),
            StrategyError::UnusedSlot,
        );
    }
    for out_of_range in [6, 7, u8::MAX] {
        assert_refused(
            env.distribute(&market, &caller, out_of_range),
            StrategyError::NoSuchSlot,
        );
    }
}

/// Sends `distribute` for `slot` with its accounts changed by `edit`. The accounts are in
/// `metadata.json`'s order: 0 the caller, 1 the market state, 2 the vault authority, 3 the
/// tax-side vault, 4 the tax-side mint, 5 the slot's wallet, 6 its token account, 7 the token
/// program, 8 the associated token program, 9 the system program.
fn distribute_with(
    env: &mut Env,
    market: &Market,
    caller: &Keypair,
    slot: u8,
    edit: impl FnOnce(&mut Vec<pipeline_client::AccountMeta>),
) -> Result<litesvm::types::TransactionMetadata, String> {
    let state = env.tax_market(&market.market_state);
    let wallet = slot_wallet(&state, slot);
    let mut instruction = distribute_instruction(
        market,
        state.tax_side as usize,
        &caller.pubkey(),
        slot,
        &wallet,
        vec![],
    );
    edit(&mut instruction.accounts);
    env.send_meta(&[instruction], &[caller])
}

#[test]
fn substituted_accounts_are_refused() {
    use pipeline_client::AccountMeta;
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
    ];
    let market = traded_market(&mut env, mints);
    let caller = caller(&mut env);
    let state = env.tax_market(&market.market_state);
    let recipient = ck(&state.recipients[0]);
    let before = format!("{state:?}");

    // The caller's own wallet and token account in place of the slot's.
    let own = pda::associated_token(&caller.pubkey(), &market.mints[1], &TOKEN_2022);
    assert_refused(
        distribute_with(&mut env, &market, &caller, 0, |a| {
            a[5] = AccountMeta::new_readonly(caller.pubkey(), false);
            a[6] = AccountMeta::new(own, false);
        }),
        StrategyError::NotSlotWallet,
    );
    // The caller's token account for the slot's wallet.
    assert_refused(
        distribute_with(&mut env, &market, &caller, 0, |a| {
            a[6] = AccountMeta::new(own, false)
        }),
        StrategyError::NotSlotTokenAccount,
    );
    // A token account the recipient owns that is not its associated token account.
    let other = Pubkey::new_unique();
    let written = env.write_token_account(&market.mints[1], &TOKEN_2022, &recipient, 0);
    let data = env.svm.get_account(&written).unwrap();
    env.svm.set_account(other, data).unwrap();
    env.svm
        .set_account(written, solana_account::Account::default())
        .unwrap();
    assert_refused(
        distribute_with(&mut env, &market, &caller, 0, |a| {
            a[6] = AccountMeta::new(other, false)
        }),
        StrategyError::NotSlotTokenAccount,
    );
    // The recipient's associated token account of the other mint.
    let other_mint = pda::associated_token(&recipient, &market.mints[0], &TOKEN);
    assert_refused(
        distribute_with(&mut env, &market, &caller, 0, |a| {
            a[6] = AccountMeta::new(other_mint, false)
        }),
        StrategyError::NotSlotTokenAccount,
    );
    let ata = pda::associated_token(&recipient, &market.mints[1], &TOKEN_2022);
    // The other vault, a substituted vault authority, and the other mint (with its own
    // token program and the recipient's account of it) as the tax-side mint.
    assert_refused(
        distribute_with(&mut env, &market, &caller, 0, |a| {
            a[3] = AccountMeta::new(market.vaults[0], false)
        }),
        StrategyError::WrongAccount,
    );
    assert_refused(
        distribute_with(&mut env, &market, &caller, 0, |a| {
            a[2] = AccountMeta::new_readonly(caller.pubkey(), false)
        }),
        StrategyError::WrongAccount,
    );
    assert_refused(
        distribute_with(&mut env, &market, &caller, 0, |a| {
            a[4] = AccountMeta::new(market.mints[0], false);
            a[6] = AccountMeta::new(other_mint, false);
            a[7] = AccountMeta::new_readonly(TOKEN, false);
        }),
        StrategyError::WrongAccount,
    );
    // The burn slot names no wallet: anyone's in its place is refused too.
    assert_refused(
        distribute_with(&mut env, &market, &caller, BURN_SLOT, |a| {
            a[5] = AccountMeta::new_readonly(caller.pubkey(), false);
            a[6] = AccountMeta::new(own, false);
        }),
        StrategyError::NotSlotWallet,
    );

    // Nothing moved, and the right accounts still pay out.
    assert_eq!(
        format!("{:?}", env.tax_market(&market.market_state)),
        before
    );
    env.distribute(&market, &caller, 0).unwrap();
    assert_eq!(env.balance(&ata), state.owed[0]);
}

#[test]
fn a_frozen_recipient_account_blocks_only_its_own_slot_until_it_is_thawed() {
    use spl_token_2022_interface::instruction::{freeze_account, thaw_account};
    // Only a quote mint may keep a freeze authority once its market is seeded
    // (docs/spec/tax-amm.md, "Mint rules"): the cluster's USDC, an SPL Token mint.
    let token_program = TOKEN;
    let mut env = Env::new();
    let taxed = env.write_usdc_mint();
    let mints = [(env.create_mint(&TOKEN), TOKEN), (taxed, token_program)];
    let market = traded_market(&mut env, mints);
    env.set_supply(&taxed, 10 * SEED[1]);
    let caller = caller(&mut env);
    let recipient = ck(&env.tax_market(&market.market_state).recipients[0]);
    let account = env.write_token_account(&taxed, &token_program, &recipient, 0);
    let admin = env.admin.pubkey();
    let freeze = freeze_account(&token_program, &account, &taxed, &admin, &[]).unwrap();
    env.send(&[freeze], &[]).unwrap();

    // Only slot 0's payout fails; the other slots pay out.
    let owed = env.tax_market(&market.market_state).owed;
    let refused = env.distribute(&market, &caller, 0);
    assert!(
        refused
            .as_ref()
            .is_err_and(|logs| logs.contains("Account is frozen")),
        "{token_program}: {refused:?}"
    );
    for slot in [1, BURN_SLOT, SUITE_SLOT] {
        env.distribute(&market, &caller, slot).unwrap();
    }
    let state = env.tax_market(&market.market_state);
    assert_eq!(state.owed, [owed[0], 0, 0, 0, 0, 0], "{token_program}");

    // Swaps keep working, and keep booking tax to slot 0.
    let trader = env.funded_wallet(&market, 1_000_000_000_000);
    env.swap(&market, &trader, (1, 0), 1_000_000_000).unwrap();
    env.swap(&market, &trader, (0, 1), 1_000_000_000).unwrap();
    let owed_now = env.tax_market(&market.market_state).owed[0];
    assert!(owed_now > owed[0], "{token_program}");

    // Thawed, the slot pays out everything it is owed.
    let thaw = thaw_account(&token_program, &account, &taxed, &admin, &[]).unwrap();
    env.send(&[thaw], &[]).unwrap();
    env.distribute(&market, &caller, 0).unwrap();
    assert_eq!(env.balance(&account), owed_now, "{token_program}");
    assert_eq!(
        env.tax_market(&market.market_state).owed[0],
        0,
        "{token_program}"
    );
}

/// The tax-side mints `distribute` must pay out in: a plain SPL Token mint, a plain
/// Token-2022 mint, and each token program's native SOL mint, whose payouts are wrapped SOL.
fn tax_sides(env: &mut Env) -> Vec<(&'static str, Pubkey, Pubkey)> {
    use tax_amm::params::NATIVE_MINTS;
    vec![
        ("SPL Token", env.create_mint(&TOKEN), TOKEN),
        ("Token-2022", env.create_mint(&TOKEN_2022), TOKEN_2022),
        (
            "wrapped SOL",
            env.write_native_mint(&NATIVE_MINTS[0], &TOKEN),
            TOKEN,
        ),
        (
            "Token-2022 wrapped SOL",
            env.write_native_mint(&NATIVE_MINTS[1], &TOKEN_2022),
            TOKEN_2022,
        ),
    ]
}

#[test]
fn every_kind_of_slot_pays_out_in_each_kind_of_tax_side_mint_to_any_caller() {
    let mut env = Env::new();
    for (name, taxed, token_program) in tax_sides(&mut env) {
        let native = tax_amm::params::NATIVE_MINTS.contains(&ak(&taxed));
        let mut params = valid_params(&Pubkey::new_unique());
        if native {
            // SOL can't be burned, so a SOL tax side has no burn share.
            params.shares[0] += params.burn_share_bps;
            params.burn_share_bps = 0;
        }
        let mints = [(env.create_mint(&TOKEN), TOKEN), (taxed, token_program)];
        let market = env.seeded_market(mints, &params, SEED);
        if !native {
            env.set_supply(&taxed, 10 * SEED[1]);
        }
        let trader = env.funded_wallet(&market, 1_000_000_000_000);
        env.swap(&market, &trader, (1, 0), 10_000_000_000).unwrap();
        env.swap(&market, &trader, (0, 1), 5_000_000_000).unwrap();

        let caller = caller(&mut env);
        let start = env.tax_market(&market.market_state);
        let mut owed = start.owed;
        for slot in [0u8, 1, BURN_SLOT, SUITE_SLOT] {
            let paid = owed[slot as usize];
            assert!(
                paid > 0 || (native && slot == BURN_SLOT),
                "{name} slot {slot}"
            );
            let account = slot_account(&env, &market, slot);
            let (balance, supply) = (env.balance_or_zero(&account), env.supply(&taxed));
            let lamports = env.svm.get_account(&account).map_or(0, |a| a.lamports);

            env.distribute(&market, &caller, slot).unwrap();

            owed[slot as usize] = 0;
            let state = env.tax_market(&market.market_state);
            // Only this slot's owed amount changed: reserves, counters and the other
            // slots are as they were, and the vault holds the real reserve plus what is
            // still owed.
            assert_eq!(state.owed, owed, "{name} slot {slot}");
            assert_eq!(state.reserves, start.reserves, "{name} slot {slot}");
            assert_eq!(state.tax_collected, start.tax_collected);
            assert_eq!(state.volume, start.volume);
            assert_eq!(state.swap_count, start.swap_count);
            assert_eq!(
                env.balance(&market.vaults[1]),
                state.reserves[1] + owed.iter().sum::<u64>(),
                "{name} slot {slot}"
            );
            if slot == BURN_SLOT {
                assert_eq!(env.supply(&taxed), supply - paid, "{name}");
            } else {
                assert_eq!(env.balance(&account), balance + paid, "{name} slot {slot}");
                if native {
                    // Wrapped SOL: the account's lamports carry what it holds.
                    let rent = env.svm.minimum_balance_for_rent_exemption(
                        env.svm.get_account(&account).unwrap().data.len(),
                    );
                    let now = env.svm.get_account(&account).unwrap().lamports;
                    assert_eq!(now, lamports.max(rent) + paid, "{name} slot {slot}");
                }
            }
        }
        assert_eq!(owed, [0; 6], "{name}");
    }
}

#[test]
fn a_tax_side_mint_whose_transfer_hook_is_cleared_pays_out_with_no_hook_accounts() {
    // A tax side can carry a transfer hook extension only cleared (docs/spec/tax-amm.md,
    // "Mint rules"; a contained mint is never its home market's tax side), so no hook runs in
    // a payout and `distribute` needs no accounts after its own.
    let mut env = Env::new();
    let hooked = env.create_mint_with_cleared_hook();
    let mints = [(env.create_mint(&TOKEN), TOKEN), (hooked, TOKEN_2022)];
    let market = traded_market(&mut env, mints);
    env.set_supply(&hooked, 10 * SEED[1]);
    let caller = caller(&mut env);
    let owed = env.tax_market(&market.market_state).owed;
    for slot in [0u8, 1, BURN_SLOT, SUITE_SLOT] {
        let account = slot_account(&env, &market, slot);
        distribute_with(&mut env, &market, &caller, slot, |_| {}).unwrap();
        if slot != BURN_SLOT {
            assert_eq!(env.balance(&account), owed[slot as usize], "slot {slot}");
        }
    }
    assert_eq!(env.tax_market(&market.market_state).owed, [0; 6]);
}

#[test]
fn each_payout_emits_a_distributed_event_and_a_slot_with_nothing_owed_emits_none() {
    use tax_amm::events::Distributed;
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let market = traded_market(&mut env, mints);
    env.set_supply(&market.mints[1], 10 * SEED[1]);
    let caller = caller(&mut env);
    let state = env.tax_market(&market.market_state);
    for slot in [0u8, BURN_SLOT, SUITE_SLOT] {
        let meta = env.distribute(&market, &caller, slot).unwrap();
        let events: Vec<Distributed> = strategy_events(&meta.logs);
        assert_eq!(
            events,
            [Distributed {
                market_state: ak(&market.market_state),
                slot,
                recipient: ak(&slot_wallet(&state, slot)),
                amount: state.owed[slot as usize],
            }]
        );
        // Paid out, the slot is owed nothing, so a second call emits nothing.
        let again = env.distribute(&market, &caller, slot).unwrap();
        assert!(strategy_events::<Distributed>(&again.logs).is_empty());
    }
}

#[test]
fn after_any_sequence_of_swaps_payouts_and_donations_the_vault_holds_the_reserve_plus_what_is_owed()
{
    // A fixed pseudo-random sequence per run seed, so a failure reproduces.
    for run in 1..=3u64 {
        let mut env = Env::new();
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN_2022), TOKEN_2022),
        ];
        let market = env.seeded_market(mints, &valid_params(&Pubkey::new_unique()), SEED);
        env.set_supply(&market.mints[1], u64::MAX / 2);
        let trader = env.funded_wallet(&market, 1_000_000_000_000);
        let caller = caller(&mut env);
        let mut donated = 0u64;
        let mut rng = run.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        let mut next = |bound: u64| {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng % bound
        };
        for step in 0..40 {
            let before = env.tax_market(&market.market_state);
            match next(4) {
                0 | 1 => {
                    let direction = if next(2) == 0 { (0, 1) } else { (1, 0) };
                    let amount = 1_000_000 + next(20_000_000_000);
                    env.swap(&market, &trader, direction, amount).unwrap();
                }
                2 => {
                    let slot = [0u8, 1, BURN_SLOT, SUITE_SLOT][next(4) as usize];
                    let vault = env.balance(&market.vaults[1]);
                    env.distribute(&market, &caller, slot).unwrap();
                    let after = env.tax_market(&market.market_state);
                    // It moved exactly what the slot was owed, and changed nothing else.
                    let paid = before.owed[slot as usize];
                    assert_eq!(
                        env.balance(&market.vaults[1]),
                        vault - paid,
                        "run {run} step {step}"
                    );
                    let mut owed = before.owed;
                    owed[slot as usize] = 0;
                    assert_eq!(after.owed, owed, "run {run} step {step}");
                    assert_eq!(after.reserves, before.reserves);
                    assert_eq!(after.tax_collected, before.tax_collected);
                    assert_eq!(after.volume, before.volume);
                    assert_eq!(after.swap_count, before.swap_count);
                }
                _ => {
                    let amount = 1 + next(1_000_000);
                    env.transfer(&market, &trader, 1, market.vaults[1], amount)
                        .unwrap();
                    donated += amount;
                }
            }
            let state = env.tax_market(&market.market_state);
            assert_eq!(
                env.balance(&market.vaults[1]),
                state.reserves[1] + state.owed.iter().sum::<u64>() + donated,
                "run {run} step {step}"
            );
        }
    }
}

#[test]
fn a_recipient_account_its_owner_handed_to_another_wallet_is_still_paid() {
    // SPL Token lets an account's owner hand it to another wallet (Token-2022's associated
    // token accounts can't be). The payout still goes to the account at the slot wallet's
    // associated token address, as its owner chose; refusing it would strand the slot's tax,
    // for good once the tax authority renounces.
    use spl_token_2022_interface::instruction::{set_authority, AuthorityType};
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let recipient = Keypair::new();
    let mut params = valid_params(&Pubkey::new_unique());
    params.recipients[0] = ak(&recipient.pubkey());
    let market = env.seeded_market(mints, &params, SEED);
    let trader = env.funded_wallet(&market, 1_000_000_000_000);
    env.swap(&market, &trader, (1, 0), 10_000_000_000).unwrap();
    let owed = env.tax_market(&market.market_state).owed[0];
    let account = env.write_token_account(&market.mints[1], &TOKEN, &recipient.pubkey(), 0);
    let other = Pubkey::new_unique();
    let hand_over = set_authority(
        &TOKEN,
        &account,
        Some(&other),
        AuthorityType::AccountOwner,
        &recipient.pubkey(),
        &[],
    )
    .unwrap();
    env.send(&[hand_over], &[&recipient]).unwrap();

    let caller = caller(&mut env);
    env.distribute(&market, &caller, 0).unwrap();

    assert_eq!(env.balance(&account), owed);
    assert_eq!(env.tax_market(&market.market_state).owed[0], 0);
}

#[test]
fn payouts_leave_the_tax_side_mint_read_only_and_only_the_burn_needs_it_writable() {
    // Recipients and the suite share are paid with the mint read-only, so payouts never
    // write-lock it (for wrapped SOL, the one native mint every SOL transfer reads); the
    // burn changes its supply, so it needs the mint writable.
    use pipeline_client::AccountMeta;
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let market = traded_market(&mut env, mints);
    env.set_supply(&market.mints[1], 10 * SEED[1]);
    let caller = caller(&mut env);
    let read_only = |a: &mut Vec<AccountMeta>| a[4] = AccountMeta::new_readonly(a[4].pubkey, false);
    for slot in [0u8, 1, SUITE_SLOT] {
        distribute_with(&mut env, &market, &caller, slot, read_only).unwrap();
    }
    assert_refused(
        distribute_with(&mut env, &market, &caller, BURN_SLOT, read_only),
        StrategyError::BurnNeedsWritableMint,
    );
    env.distribute(&market, &caller, BURN_SLOT).unwrap();
    assert_eq!(env.tax_market(&market.market_state).owed, [0; 6]);
}
