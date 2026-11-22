//! The tax authority (docs/spec/tax-amm.md, "Tax authority"): it can change a market's
//! rates inside the ranges fixed at creation, change its tax recipients, and renounce;
//! nobody else can change anything about a market, and a market without a tax authority
//! never changes.

mod common;

use common::authority::*;
use common::model::Model;
use common::*;
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::InitParams;

/// A market on two SPL Token mints whose tax authority is `authority`.
fn market_with_authority(env: &mut Env, authority: &Keypair) -> Market {
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let params = InitParams {
        tax_authority: ak(&authority.pubkey()),
        ..valid_params(&Pubkey::new_unique())
    };
    env.seeded_market(mints, &params, [100_000_000_000, 200_000_000_000])
}

#[test]
fn set_taxes_changes_both_rates_and_the_swaps_after_its_delay_pay_them() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    let before = env.tax_market(&market.market_state);
    assert_eq!((before.buy_tax_bps, before.sell_tax_bps), (300, 500));

    env.send_signed(
        set_taxes_instruction(&market.market_state, &authority.pubkey(), 800, 0),
        &authority,
    )
    .unwrap();
    let pending = env.tax_market(&market.market_state);
    assert_eq!(
        (pending.pending_buy_tax_bps, pending.pending_sell_tax_bps),
        (800, 0)
    );

    // Once the change applies, the next swap each way is priced, and taxed, at the new rates.
    env.warp_slots(tax_amm::config::RATE_CHANGE_DELAY_SLOTS);
    let trader = env.funded_wallet(&market, 10_000_000_000_000);
    let mut model = Model::of(&pending).at(env.slot());
    assert_eq!((model.buy_tax_bps, model.sell_tax_bps), (800, 0));
    for (i, o) in [(1, 0), (0, 1)] {
        let trade = model.swap(i, o, 1_000_000_000).unwrap();
        let result = env.swap(&market, &trader, (i, o), 1_000_000_000).unwrap();
        assert_eq!(result.received, trade.out);
        model.assert_matches(&env.tax_market(&market.market_state));
    }
}

/// The program's upgrade authority, read from its ProgramData account.
fn upgrade_authority(env: &Env) -> Pubkey {
    let data = env
        .svm
        .get_account(&pipeline_client::pda::program_data(&strategy_id()))
        .expect("program data")
        .data;
    assert_eq!(data[12], 1, "the program is upgradeable");
    Pubkey::try_from(&data[13..45]).unwrap()
}

/// Everything about a market the tax authority's actions must never change: the real
/// reserves, the owed amounts, the counters, what was fixed at creation, and the vaults.
#[derive(Debug, PartialEq, Eq)]
struct Untouchable {
    reserves: [u64; 2],
    owed: [u64; 6],
    tax_collected: u128,
    volume: [u128; 2],
    swap_count: u64,
    status: tax_amm::state::MarketStatus,
    mints: [anchor_lang::prelude::Pubkey; 2],
    vaults: [anchor_lang::prelude::Pubkey; 2],
    market_signer: anchor_lang::prelude::Pubkey,
    tax_side: u8,
    ranges: [[u16; 2]; 2],
    seeder: anchor_lang::prelude::Pubkey,
    virtual_side: u8,
    virtual_reserve: u64,
    created: (u64, i64),
    vault_balances: [u64; 2],
}

fn untouchable(env: &Env, market: &Market) -> Untouchable {
    let s = env.tax_market(&market.market_state);
    Untouchable {
        reserves: s.reserves,
        owed: s.owed,
        tax_collected: s.tax_collected,
        volume: s.volume,
        swap_count: s.swap_count,
        status: s.status,
        mints: s.mints,
        vaults: s.vaults,
        market_signer: s.market_signer,
        tax_side: s.tax_side,
        ranges: s.tax_ranges(),
        seeder: s.seeder,
        virtual_side: s.virtual_side,
        virtual_reserve: s.virtual_reserve,
        created: (s.created_slot, s.created_at),
        vault_balances: [
            env.balance(&market.vaults[0]),
            env.balance(&market.vaults[1]),
        ],
    }
}

/// Trades both ways, so every owed amount and counter is above 0.
fn trade_both_ways(env: &mut Env, market: &Market) {
    let trader = env.funded_wallet(market, 10_000_000_000_000);
    env.swap(market, &trader, (1, 0), 1_000_000_000).unwrap();
    env.swap(market, &trader, (0, 1), 1_000_000_000).unwrap();
}

#[test]
fn each_action_is_accepted_from_the_tax_authority_and_refused_from_every_other_signer() {
    for action in 0..3 {
        let mut env = Env::new();
        let authority = Keypair::new();
        let seeder = Keypair::new();
        let recipient = Keypair::new();
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN), TOKEN),
        ];
        let mut params = InitParams {
            tax_authority: ak(&authority.pubkey()),
            seeder: ak(&seeder.pubkey()),
            ..valid_params(&Pubkey::new_unique())
        };
        params.recipients[0] = ak(&recipient.pubkey());
        let market = env.create_tax_market(mints, &params).unwrap();
        env.fund(&seeder.pubkey(), &market, [SOL, SOL]);
        env.seed(&market, &seeder, [SOL, SOL]).unwrap();

        // The admin created the market and is the program's upgrade authority.
        let admin = env.admin.insecure_clone();
        assert_eq!(upgrade_authority(&env), admin.pubkey());
        let others = [
            ("the creator and upgrade authority", admin),
            ("the seeder", seeder.insecure_clone()),
            ("a tax recipient", recipient.insecure_clone()),
            ("a stranger", Keypair::new()),
        ];
        for (who, signer) in &others {
            env.svm.airdrop(&signer.pubkey(), SOL).unwrap();
            let state = env.tax_market(&market.market_state);
            let (name, instruction) =
                each_action(&market.market_state, &signer.pubkey(), &state)[action].clone();
            assert_refused(
                env.send_signed(instruction, signer),
                tax_amm::StrategyError::NotTaxAuthority,
            );
            println!("{name} refused from {who}");
        }

        // The tax authority's key without its signature is refused too.
        let state = env.tax_market(&market.market_state);
        let (name, mut unsigned) =
            each_action(&market.market_state, &authority.pubkey(), &state)[action].clone();
        unsigned.accounts[0].is_signer = false;
        let refused = env.send_meta(&[unsigned], &[]).unwrap_err();
        assert!(refused.contains("AccountNotSigner"), "{name}: {refused}");

        // Nothing changed, then the tax authority's own call is accepted.
        assert_eq!(
            env.tax_market(&market.market_state).params(),
            state.params()
        );
        let (name, instruction) =
            each_action(&market.market_state, &authority.pubkey(), &state)[action].clone();
        env.send_signed(instruction, &authority)
            .unwrap_or_else(|e| panic!("{name} from the tax authority: {e}"));
        let after = env.tax_market(&market.market_state);
        assert_ne!(
            (
                after.params(),
                set_rates(&after),
                after.tax_authority_renounced
            ),
            (
                state.params(),
                set_rates(&state),
                state.tax_authority_renounced
            ),
            "{name} changed the market"
        );
    }
}

#[test]
fn set_taxes_refuses_a_rate_outside_its_range_on_either_side() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    // Buy tax range [100, 800], sell tax range [0, 1000].
    let state = env.tax_market(&market.market_state);
    assert_eq!(state.tax_ranges(), [[100, 800], [0, 1_000]]);
    for (buy, sell) in [
        (99, 500),
        (801, 500),
        (300, 1_001),
        (0, 0),
        (u16::MAX, 500),
        (300, u16::MAX),
    ] {
        assert_refused(
            env.send_signed(
                set_taxes_instruction(&market.market_state, &authority.pubkey(), buy, sell),
                &authority,
            ),
            tax_amm::StrategyError::RateOutsideRange,
        );
    }
    // Both ends of each range are inside it.
    for (buy, sell) in [(100, 0), (800, 1_000)] {
        env.send_signed(
            set_taxes_instruction(&market.market_state, &authority.pubkey(), buy, sell),
            &authority,
        )
        .unwrap();
        let s = env.tax_market(&market.market_state);
        assert_eq!(set_rates(&s), (buy, sell));
    }
}

#[test]
fn no_sequence_of_set_taxes_takes_a_rate_past_its_range_or_the_cap() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    let [[buy_min, buy_max], [sell_min, sell_max]] =
        env.tax_market(&market.market_state).tax_ranges();
    // A fixed pseudo-random walk over every interesting value, so a failure replays.
    let interesting = [
        0,
        1,
        99,
        100,
        101,
        500,
        799,
        800,
        801,
        999,
        1_000,
        1_001,
        u16::MAX - 1,
        u16::MAX,
    ];
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        interesting[(x % interesting.len() as u64) as usize]
    };
    let mut expected = (300, 500);
    for _ in 0..120 {
        let (buy, sell) = (next(), next());
        let result = env.send_signed(
            set_taxes_instruction(&market.market_state, &authority.pubkey(), buy, sell),
            &authority,
        );
        let inside = (buy_min..=buy_max).contains(&buy) && (sell_min..=sell_max).contains(&sell);
        assert_eq!(result.is_ok(), inside, "set_taxes({buy}, {sell})");
        if inside {
            expected = (buy, sell);
        }
        let s = env.tax_market(&market.market_state);
        assert_eq!(set_rates(&s), expected);
        // Whatever is in force and whatever is pending stays inside its range and the cap.
        for (buy, sell) in [(s.buy_tax_bps, s.sell_tax_bps), set_rates(&s)] {
            assert!((buy_min..=buy_max).contains(&buy));
            assert!((sell_min..=sell_max).contains(&sell));
            assert!(buy <= tax_amm::config::MAX_TAX_BPS);
            assert!(sell <= tax_amm::config::MAX_TAX_BPS);
        }
    }
}

#[test]
fn a_range_fixed_at_a_single_value_never_moves() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    // The buy tax fixed at 300, the sell tax free in [0, 1000].
    let params = InitParams {
        tax_authority: ak(&authority.pubkey()),
        buy_tax_bps: 300,
        buy_tax_min_bps: 300,
        buy_tax_max_bps: 300,
        sell_tax_min_bps: 0,
        sell_tax_max_bps: 1_000,
        ..valid_params(&Pubkey::new_unique())
    };
    let market = env.seeded_market(mints, &params, [SOL, SOL]);
    for buy in [0, 299, 301, 1_000, u16::MAX] {
        assert_refused(
            env.send_signed(
                set_taxes_instruction(&market.market_state, &authority.pubkey(), buy, 200),
                &authority,
            ),
            tax_amm::StrategyError::RateOutsideRange,
        );
    }
    // The sell tax still moves, the buy tax staying where it is fixed.
    env.send_signed(
        set_taxes_instruction(&market.market_state, &authority.pubkey(), 300, 200),
        &authority,
    )
    .unwrap();
    let s = env.tax_market(&market.market_state);
    assert_eq!(set_rates(&s), (300, 200));
    assert_eq!(s.tax_ranges()[0], [300, 300]);
}

#[test]
fn set_recipients_refuses_everything_creation_refuses() {
    use tax_amm::StrategyError::*;
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    let valid = Split::of_market(&env.tax_market(&market.market_state));
    // Two recipients at 6,000 and 3,000, and a burn of 1,000.
    assert_eq!(valid.shares, [6_000, 3_000, 0, 0]);
    let none = Pubkey::default();
    let cases: Vec<(&str, Split, tax_amm::StrategyError)> = vec![
        (
            "no recipient",
            Split {
                recipients: [none; 4],
                shares: [0; 4],
                burn_share_bps: 10_000,
            },
            NoRecipient,
        ),
        (
            "a zero share on a used slot",
            Split {
                shares: [9_000, 0, 0, 0],
                ..valid
            },
            ZeroShare,
        ),
        (
            "a share on an unused slot",
            Split {
                shares: [5_000, 3_000, 1_000, 0],
                ..valid
            },
            ShareWithoutRecipient,
        ),
        (
            "a used slot after an unused one",
            Split {
                recipients: [valid.recipients[0], none, valid.recipients[1], none],
                shares: [6_000, 0, 3_000, 0],
                ..valid
            },
            RecipientsOutOfOrder,
        ),
        (
            "a sum below 10,000",
            Split {
                shares: [6_000, 2_999, 0, 0],
                ..valid
            },
            SharesNotWhole,
        ),
        (
            "a sum above 10,000",
            Split {
                shares: [6_000, 3_001, 0, 0],
                ..valid
            },
            SharesNotWhole,
        ),
        (
            "shares that overflow a u16 sum",
            Split {
                recipients: [Pubkey::new_unique(); 4],
                shares: [u16::MAX; 4],
                burn_share_bps: u16::MAX,
            },
            SharesNotWhole,
        ),
    ];
    for (case, split, error) in cases {
        let result = env.send_signed(
            set_recipients_instruction(&market.market_state, &authority.pubkey(), &split),
            &authority,
        );
        assert_refused(result, error);
        assert_eq!(
            Split::of_market(&env.tax_market(&market.market_state)),
            valid,
            "{case}"
        );
    }

    // Four recipients, and a split with no burn at all, are accepted, as at creation.
    let four = Split {
        recipients: [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ],
        shares: [2_500, 2_500, 2_500, 2_499],
        burn_share_bps: 1,
    };
    let only_one = Split {
        recipients: [Pubkey::new_unique(), none, none, none],
        shares: [10_000, 0, 0, 0],
        burn_share_bps: 0,
    };
    for split in [four, only_one] {
        env.send_signed(
            set_recipients_instruction(&market.market_state, &authority.pubkey(), &split),
            &authority,
        )
        .unwrap();
        assert_eq!(
            Split::of_market(&env.tax_market(&market.market_state)),
            split
        );
    }
}

#[test]
fn set_recipients_refuses_a_burn_share_on_a_native_sol_tax_side() {
    use tax_amm::params::NATIVE_MINTS;
    for (native, token_program) in [(NATIVE_MINTS[0], TOKEN), (NATIVE_MINTS[1], TOKEN_2022)] {
        let mut env = Env::new();
        let authority = Keypair::new();
        let sol = env.write_native_mint(&native, &token_program);
        let token = env.create_mint(&TOKEN);
        // The tax on side 1, native SOL, with no burn, as creation requires.
        let mut params = InitParams {
            tax_authority: ak(&authority.pubkey()),
            ..valid_params(&Pubkey::new_unique())
        };
        params.shares[0] += params.burn_share_bps;
        params.burn_share_bps = 0;
        let market = env
            .create_tax_market([(token, TOKEN), (sol, token_program)], &params)
            .unwrap();
        let mut burning = Split::of(&params);
        burning.shares[0] -= 1;
        burning.burn_share_bps = 1;
        assert_refused(
            env.send_signed(
                set_recipients_instruction(&market.market_state, &authority.pubkey(), &burning),
                &authority,
            ),
            tax_amm::StrategyError::BurnOnNativeSol,
        );
        assert_eq!(
            Split::of_market(&env.tax_market(&market.market_state)),
            Split::of(&params)
        );
    }
}

#[test]
fn set_recipients_names_a_new_wallet_once_its_slot_is_paid_out_and_moves_shares_of_owed_slots() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    trade_both_ways(&mut env, &market);
    let before = env.tax_market(&market.market_state);
    // Recipients 0 and 1, the burn and the suite share are owed; slots 2 and 3 are unused.
    assert!(
        [0, 1, 4, 5].iter().all(|&slot| before.owed[slot] > 0),
        "{:?}",
        before.owed
    );

    // Recipient 1 is paid what it is owed, then hands over to a new wallet in the same
    // transaction (hardening finding H023, #67), and the shares move, slot 0's although it
    // is still owed.
    let new_wallet = Pubkey::new_unique();
    let mut split = Split::of_market(&before);
    split.recipients[1] = new_wallet;
    split.shares = [5_000, 4_000, 0, 0];
    let tax_side = before.tax_side as usize;
    let old_wallet = ck(&before.recipients[1]);
    env.svm.airdrop(&authority.pubkey(), SOL).unwrap();
    let payout = distribute_instruction(
        &market,
        tax_side,
        &authority.pubkey(),
        1,
        &old_wallet,
        vec![],
    );
    let handover = set_recipients_instruction(&market.market_state, &authority.pubkey(), &split);
    let meta = env.send_meta(&[payout, handover], &[&authority]).unwrap();

    let after = env.tax_market(&market.market_state);
    assert_eq!(ck(&after.recipients[1]), new_wallet);
    assert_eq!(after.shares, [5_000, 4_000, 0, 0]);
    let mut owed = before.owed;
    owed[1] = 0;
    assert_eq!(
        after.owed, owed,
        "what each other slot is owed stays with it"
    );
    let paid = pipeline_client::pda::associated_token(
        &old_wallet,
        &market.mints[tax_side],
        &market.token_programs[tax_side],
    );
    assert_eq!(
        env.balance(&paid),
        before.owed[1],
        "the old wallet was paid"
    );
    let events: Vec<tax_amm::events::RecipientsChanged> = strategy_events(&meta.logs);
    assert_eq!(
        events,
        [tax_amm::events::RecipientsChanged {
            market_state: ak(&market.market_state),
            tax_authority: ak(&authority.pubkey()),
            recipients: split.recipients.map(|r| ak(&r)),
            shares: split.shares,
            burn_share_bps: split.burn_share_bps,
        }]
    );

    // The next swap's tax is split by the new shares.
    let mut model = Model::of(&after);
    let trader = env.funded_wallet(&market, 10_000_000_000_000);
    model.swap(1, 0, 1_000_000_000).unwrap();
    env.swap(&market, &trader, (1, 0), 1_000_000_000).unwrap();
    model.assert_matches(&env.tax_market(&market.market_state));
}

#[test]
fn a_market_without_a_tax_authority_refuses_all_three_actions_for_good() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let params = InitParams {
        tax_authority: anchor_lang::prelude::Pubkey::default(),
        ..valid_params(&Pubkey::new_unique())
    };
    let market = env.seeded_market(mints, &params, [SOL, SOL]);
    let state = env.tax_market(&market.market_state);
    assert!(!state.tax_authority_renounced);
    // Whoever signs, the creator, a stranger, or the default key's account passed unsigned.
    for signer in [env.admin.insecure_clone(), Keypair::new()] {
        env.svm.airdrop(&signer.pubkey(), SOL).unwrap();
        for (name, instruction) in each_action(&market.market_state, &signer.pubkey(), &state) {
            let result = env.send_signed(instruction, &signer);
            assert_refused(result, tax_amm::StrategyError::NoTaxAuthority);
            println!("{name} refused on a market without a tax authority");
        }
    }
    let after = env.tax_market(&market.market_state);
    assert_eq!(after.params(), state.params());
    assert!(!after.tax_authority_renounced);
}

#[test]
fn a_renounced_market_refuses_all_three_actions_for_good() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    let before = untouchable(&env, &market);
    let meta = env
        .send_signed(
            renounce_instruction(&market.market_state, &authority.pubkey()),
            &authority,
        )
        .unwrap();
    let renounced = env.tax_market(&market.market_state);
    assert!(renounced.tax_authority_renounced);
    assert_eq!(
        renounced.tax_authority,
        anchor_lang::prelude::Pubkey::default()
    );
    assert_eq!(untouchable(&env, &market), before);
    let events: Vec<tax_amm::events::TaxAuthorityRenounced> = strategy_events(&meta.logs);
    assert_eq!(
        events,
        [tax_amm::events::TaxAuthorityRenounced {
            market_state: ak(&market.market_state),
            tax_authority: ak(&authority.pubkey()),
        }]
    );

    // The former tax authority, and anyone else, is refused every action, renouncing again
    // included, now and after more trading.
    for round in 0..2 {
        for signer in [
            authority.insecure_clone(),
            env.admin.insecure_clone(),
            Keypair::new(),
        ] {
            env.svm.airdrop(&signer.pubkey(), SOL).unwrap();
            for (name, instruction) in
                each_action(&market.market_state, &signer.pubkey(), &renounced)
            {
                let result = env.send_signed(instruction, &signer);
                assert_refused(result, tax_amm::StrategyError::AlreadyRenounced);
                println!("round {round}: {name} refused after renouncing");
            }
        }
        trade_both_ways(&mut env, &market);
    }
    let after = env.tax_market(&market.market_state);
    assert_eq!(after.params(), renounced.params());
    assert!(after.tax_authority_renounced);
}

#[test]
fn a_swap_quoted_before_a_rate_change_is_priced_at_the_rates_it_was_quoted_at() {
    // A change waits longer than any transaction's lifetime (docs/spec/tax-amm.md, "Rates"),
    // so a swap quoted and signed before it lands at the quoted rates, whichever way the
    // rates move; `tests/rate_changes.rs` has the rest.
    for rates in [(1_000u16, 1_000u16), (0, 0)] {
        let mut env = Env::new();
        let authority = Keypair::new();
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN), TOKEN),
        ];
        let params = InitParams {
            tax_authority: ak(&authority.pubkey()),
            buy_tax_min_bps: 0,
            buy_tax_max_bps: 1_000,
            ..valid_params(&Pubkey::new_unique())
        };
        let market = env.seeded_market(mints, &params, [100_000_000_000, 200_000_000_000]);
        let trader = env.funded_wallet(&market, 10_000_000_000_000);
        for (i, o) in [(1, 0), (0, 1)] {
            let quote = env.quote(&market, &exact_in(i, o, 1_000_000_000)).unwrap();
            env.send_signed(
                set_taxes_instruction(&market.market_state, &authority.pubkey(), rates.0, rates.1),
                &authority,
            )
            .unwrap();
            let options = SwapOptions {
                min_amount_out: quote.amount_out,
                ..SwapOptions::default()
            };
            let meta = env
                .swap_with(&market, &trader, (i, o), 1_000_000_000, &options)
                .unwrap();
            let swapped: pipeline_client::SwapResult =
                borsh::from_slice(&meta.return_data.data).unwrap();
            assert_eq!(swapped.received, quote.amount_out, "{rates:?} {i}->{o}");
            // Put the rates in force back, which cancels the pending change.
            let current = env.tax_market(&market.market_state);
            env.send_signed(
                set_taxes_instruction(
                    &market.market_state,
                    &authority.pubkey(),
                    current.buy_tax_bps,
                    current.sell_tax_bps,
                ),
                &authority,
            )
            .unwrap();
        }
    }
}

#[test]
fn none_of_the_three_actions_changes_a_reserve_an_owed_amount_or_a_counter() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    trade_both_ways(&mut env, &market);
    let before = untouchable(&env, &market);
    assert!([0, 1, 4, 5].iter().all(|&slot| before.owed[slot] > 0));
    assert!(before.swap_count == 2 && before.tax_collected > 0);

    let state = env.tax_market(&market.market_state);
    for (name, instruction) in each_action(&market.market_state, &authority.pubkey(), &state) {
        env.send_signed(instruction, &authority)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(untouchable(&env, &market), before, "{name}");
    }
}

#[test]
fn set_taxes_emits_the_new_rates_and_the_slot_they_apply_from() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    let slot = env.slot();
    let meta = env
        .send_signed(
            set_taxes_instruction(&market.market_state, &authority.pubkey(), 450, 650),
            &authority,
        )
        .unwrap();
    let events: Vec<tax_amm::events::TaxesChanged> = strategy_events(&meta.logs);
    assert_eq!(
        events,
        [tax_amm::events::TaxesChanged {
            market_state: ak(&market.market_state),
            tax_authority: ak(&authority.pubkey()),
            buy_tax_bps: 450,
            sell_tax_bps: 650,
            from_slot: slot + tax_amm::config::RATE_CHANGE_DELAY_SLOTS,
        }]
    );
}

#[test]
fn set_recipients_refuses_to_empty_a_slot_that_is_still_owed() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    let none = Pubkey::default();
    let state = env.tax_market(&market.market_state);
    let only_first = Split {
        recipients: [ck(&state.recipients[0]), none, none, none],
        shares: [10_000, 0, 0, 0],
        burn_share_bps: 0,
    };

    // Once recipient 1 is owed something, its slot can't be emptied: nobody could be paid.
    trade_both_ways(&mut env, &market);
    let owed = env.tax_market(&market.market_state).owed;
    assert!(owed[1] > 0 && owed[tax_amm::state::BURN_SLOT as usize] > 0);
    assert_refused(
        env.send_signed(
            set_recipients_instruction(&market.market_state, &authority.pubkey(), &only_first),
            &authority,
        ),
        tax_amm::StrategyError::OwedSlotLeftEmpty,
    );

    // Keeping the slot, its share cut to one basis point, is fine, and so is dropping the burn
    // share, since the burn slot needs no wallet to be paid out.
    let mut kept = only_first;
    kept.recipients[1] = ck(&state.recipients[1]);
    kept.shares = [9_999, 1, 0, 0];
    env.send_signed(
        set_recipients_instruction(&market.market_state, &authority.pubkey(), &kept),
        &authority,
    )
    .unwrap();
    assert_eq!(env.tax_market(&market.market_state).owed, owed);
}

#[test]
fn set_recipients_may_empty_a_slot_that_is_owed_nothing() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    let state = env.tax_market(&market.market_state);
    assert_eq!(state.owed, [0; 6]);
    let none = Pubkey::default();
    let only_first = Split {
        recipients: [ck(&state.recipients[0]), none, none, none],
        shares: [10_000, 0, 0, 0],
        burn_share_bps: 0,
    };
    env.send_signed(
        set_recipients_instruction(&market.market_state, &authority.pubkey(), &only_first),
        &authority,
    )
    .unwrap();
    assert_eq!(
        Split::of_market(&env.tax_market(&market.market_state)),
        only_first
    );
}

/// Hardening finding H024 (#67): `set_recipients` follows the rules of creation, so it too
/// refuses a recipient that is one of the market's own addresses.
#[test]
fn sos_h024_set_recipients_refuses_one_of_the_markets_own_addresses() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    let signer = ck(&tax_amm::instructions::pipeline_market_signer(&ak(
        &market.market_state
    )));
    let own = [
        market.market_state,
        market.authority,
        market.vaults[0],
        market.vaults[1],
        market.mints[0],
        market.mints[1],
        strategy_id(),
        signer,
        market.market,
        pipeline_client::PROGRAM_ID,
        TOKEN,
        TOKEN_2022,
        pipeline_client::ASSOCIATED_TOKEN_PROGRAM_ID,
        containment_hook_id(),
    ];
    let none = Pubkey::default();
    for address in own {
        let split = Split {
            recipients: [Pubkey::new_unique(), address, none, none],
            shares: [5_000, 5_000, 0, 0],
            burn_share_bps: 0,
        };
        assert_refused(
            env.send_signed(
                set_recipients_instruction(&market.market_state, &authority.pubkey(), &split),
                &authority,
            ),
            tax_amm::StrategyError::NotAWallet,
        );
    }
}

/// Hardening finding H023 (#67): the tax authority could send `[set_recipients(every slot to
/// itself), distribute, distribute]` and take every recipient's unpaid tax. A slot still owed
/// tax now keeps its wallet until it is paid out, whatever wallet the change names.
#[test]
fn sos_h023_set_recipients_refuses_to_hand_an_owed_slot_to_another_wallet() {
    let mut env = Env::new();
    let authority = Keypair::new();
    let market = market_with_authority(&mut env, &authority);
    trade_both_ways(&mut env, &market);
    let before = env.tax_market(&market.market_state);
    assert!(
        before.owed[0] > 0 && before.owed[1] > 0,
        "{:?}",
        before.owed
    );
    let tax_side = before.tax_side as usize;
    let own = Split::of_market(&before);
    let thief = authority.pubkey();
    // Enough SOL to create its own token account in the payouts.
    env.svm.airdrop(&thief, SOL).unwrap();
    let mut to_itself = own;
    to_itself.recipients[0] = thief;
    to_itself.recipients[1] = thief;
    let mut swapped = own;
    swapped.recipients.swap(0, 1);
    for (what, split) in [
        ("every slot to the authority", to_itself),
        ("two slots swapped", swapped),
    ] {
        let mut sent = vec![set_recipients_instruction(
            &market.market_state,
            &thief,
            &split,
        )];
        for slot in [0u8, 1] {
            let wallet = split.recipients[slot as usize];
            sent.push(distribute_instruction(
                &market,
                tax_side,
                &thief,
                slot,
                &wallet,
                vec![],
            ));
        }
        assert_refused(
            env.send_meta(&sent, &[&authority]),
            tax_amm::StrategyError::OwedSlotRedirected,
        );
        assert_eq!(
            env.tax_market(&market.market_state).owed,
            before.owed,
            "{what}"
        );
    }
    // A slot that is owed nothing may change hands.
    let mut third = own;
    third.recipients[2] = Pubkey::new_unique();
    third.shares = [own.shares[0], own.shares[1] - 1, 1, 0];
    env.send_signed(
        set_recipients_instruction(&market.market_state, &thief, &third),
        &authority,
    )
    .unwrap();
}
