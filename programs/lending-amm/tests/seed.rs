//! Seeding by a launchpad (docs/spec/lending-pool.md, "Seeding" and "Addresses"): the
//! stand-in launchpad calls `pipeline_seed_liquidity` by CPI with its seeder PDA signing,
//! which creates the market at `["seeded", seeder, other_mint, lent_mint, lp_fee_bps]` and makes
//! its first deposit from the launchpad's escrows, and the same transaction records it with
//! the router.

mod common;

use common::launchpad::*;
use common::rebalance::units;
use common::*;
use lending_amm::InitParams;
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// A WSOL-lent launch, the token first and WSOL second, as a launchpad graduating a token
/// against SOL orders them.
fn wsol_launch(env: &mut Env, escrowed: [u64; 2]) -> (Launch, InitParams) {
    let token = env.create_mint(&TOKEN);
    let launch = env.launch([(token, TOKEN), (wsol(), TOKEN)], escrowed);
    let params = InitParams {
        lent_index: 1,
        lp_fee_bps: 30,
    };
    (launch, params)
}

#[test]
fn a_launchpad_seeds_a_market_records_it_and_it_trades_through_the_router() {
    let mut env = Env::new();
    let seed = [2_000_000_000_000, 40 * SOL];
    let (launch, params) = wsol_launch(&mut env, seed);
    let recipient = Keypair::new().pubkey();
    let graduated = env
        .graduate(&launch, &params, seed, &recipient)
        .expect("graduation");
    let market = graduated.market;

    let trader = env.funded_wallet(&market, [10_000_000_000, 2 * SOL]);
    for (input, output) in [(1, 0), (0, 1)] {
        let quote = env
            .quote(&market, &exact_in(input, output, SOL / 10))
            .unwrap();
        let swapped = env
            .swap(&market, &trader, (input, output), SOL / 10)
            .unwrap();
        assert_eq!(swapped.received, quote.amount_out);
        assert!(swapped.received > 0);
    }
}

/// `isqrt(other x lent) - MINIMUM_LIQUIDITY`, computed here on its own.
fn first_shares(other: u64, lent: u64) -> u64 {
    let product = other as u128 * lent as u128;
    let mut root = (product as f64).sqrt() as u128;
    while root * root > product {
        root -= 1;
    }
    while (root + 1) * (root + 1) <= product {
        root += 1;
    }
    root as u64 - lending_amm::config::MINIMUM_LIQUIDITY
}

#[test]
fn seeding_takes_the_amounts_opens_at_their_price_and_mints_the_shares_to_the_recipient() {
    let mut env = Env::new();
    let seed = [3_000_000_000_000, 25 * SOL];
    // The escrows hold more than the seed; only the seed leaves them.
    let (launch, params) = wsol_launch(&mut env, [seed[0] + 7, seed[1] + 9]);
    let recipient = Keypair::new().pubkey();
    let graduated = env.graduate(&launch, &params, seed, &recipient).unwrap();
    let market = &graduated.market;
    let shares = first_shares(seed[0], seed[1]);

    // The strategy's SeedResult and what the launchpad measured at its escrows agree.
    assert_eq!(graduated.graduation.taken, seed.to_vec());
    assert_eq!(graduated.graduation.left_escrows, seed.to_vec());
    assert_eq!(graduated.graduation.lp_amount, shares);
    assert_eq!(env.balance(&launch.escrows[0]), 7);
    assert_eq!(env.balance(&launch.escrows[1]), 9);

    // The shares are in the recipient's associated token account for the LP mint, the
    // locked minimum kept back.
    let account = graduated.recipient_account;
    assert_eq!(
        account,
        lp_recipient_account(&recipient, &market.addresses.lp_mint)
    );
    assert_eq!(env.balance(&account), shares);
    let data = env.data(&account);
    assert_eq!(&data[32..64], recipient.as_ref(), "owned by the recipient");
    assert_eq!(env.mint_supply(&market.addresses.lp_mint), shares);
    assert_eq!(
        env.share_count(market),
        shares + lending_amm::config::MINIMUM_LIQUIDITY
    );

    // The market state: the seeder, the router's market signer, the reserves at the seed's
    // price, the mints in the launchpad's order.
    let state = env.market_state(&market.market_state);
    assert_eq!(ck(&state.seeder), launch.seeder);
    assert_eq!(ck(&state.market_signer), market.market);
    assert_eq!(state.reserves, seed);
    assert_eq!(state.mints.map(|m| ck(&m)), launch.mints);
    assert_eq!(state.lent_index, 1);
    assert_eq!(state.ctokens, 0);
    assert_eq!(env.balance(&market.vaults[0]), seed[0]);
    assert_eq!(env.balance(&market.vaults[1]), seed[1]);
    // The router recorded the market's mints and vaults from pipeline_market_info.
    let recorded = env.router_market(&market.market);
    assert_eq!(recorded.mints[..2], launch.mints);
    assert_eq!(recorded.vaults[..2], market.vaults);

    // Its events: the market created, then seeded.
    let created = events::<lending_amm::events::MarketCreated>(&market.created.logs);
    assert_eq!(created.len(), 1);
    let seeded = events::<lending_amm::events::MarketSeeded>(&market.created.logs);
    assert_eq!(seeded.len(), 1);
    let event = &seeded[0];
    assert_eq!(ck(&event.seeder), launch.seeder);
    assert_eq!(ck(&event.lp_recipient), recipient);
    assert_eq!(ck(&event.shares_account), account);
    assert_eq!(event.amounts, seed);
    assert_eq!(event.shares, shares);
    assert_eq!(
        event.share_count,
        shares + lending_amm::config::MINIMUM_LIQUIDITY
    );
}

#[test]
fn the_market_lives_at_the_seeders_address_whichever_order_the_mints_come_in() {
    let mut env = Env::new();
    let token = env.create_mint(&TOKEN);
    let seed = [SOL * 4, 1_000_000_000_000];
    // WSOL first this time, so it is lent at index 0.
    let launch = env.launch([(wsol(), TOKEN), (token, TOKEN)], seed);
    let params = InitParams {
        lent_index: 0,
        lp_fee_bps: 25,
    };
    let recipient = Keypair::new().pubkey();
    let graduated = env.graduate(&launch, &params, seed, &recipient).unwrap();
    let market = &graduated.market;

    // ["seeded", seeder, other_mint, lent_mint, lp_fee_bps LE]: the token, then WSOL.
    let expected = Pubkey::find_program_address(
        &[
            b"seeded",
            launch.seeder.as_ref(),
            token.as_ref(),
            wsol().as_ref(),
            &25u16.to_le_bytes(),
        ],
        &strategy_id(),
    )
    .0;
    assert_eq!(market.market_state, expected);
    let state = env.market_state(&expected);
    assert_eq!(state.mints.map(|m| ck(&m)), [wsol(), token]);
    assert_eq!(state.lent_index, 0);
    assert_eq!(state.reserves, seed);

    // A market created the ordinary way for the same mints and fee lives elsewhere, and
    // both exist side by side.
    let spec = MarketSpec {
        mints: [(token, TOKEN), (wsol(), TOKEN)],
        params: InitParams {
            lent_index: 1,
            lp_fee_bps: 25,
        },
    };
    let (ordinary, _) = env.create_funded_market(&spec, [seed[1], seed[0]]).unwrap();
    assert_ne!(ordinary.market_state, market.market_state);
    assert_eq!(
        env.market_state(&ordinary.market_state).seeder,
        Default::default()
    );

    // It trades both ways through the router.
    let trader = env.funded_wallet(market, [SOL, 10_000_000_000]);
    for (input, output) in [(0, 1), (1, 0)] {
        let quote = env
            .quote(market, &exact_in(input, output, 1_000_000))
            .unwrap();
        let swapped = env
            .swap(market, &trader, (input, output), 1_000_000)
            .unwrap();
        assert_eq!(swapped.received, quote.amount_out);
    }
}

#[test]
fn with_the_vault_authority_as_recipient_the_shares_land_in_the_lock_account_and_stay() {
    let mut env = Env::new();
    env.load_klend();
    let seed = [2_000_000_000_000, 40 * SOL];
    let (launch, params) = wsol_launch(&mut env, seed);
    let authority = launch.addresses(&params).authority;
    let graduated = env.graduate(&launch, &params, seed, &authority).unwrap();
    let market = graduated.market;
    let lock = env.lock_account(&market);
    assert_eq!(graduated.recipient_account, lock);
    let locked = first_shares(seed[0], seed[1]);
    assert_eq!(env.balance(&lock), locked);
    assert_eq!(graduated.graduation.lp_amount, locked);

    // Trading, lending, a second LP coming and going in cash and in kind, and locking more:
    // the lock account never gives a share up.
    let trader = env.funded_wallet(&market, [100_000_000_000, 5 * SOL]);
    env.swap(&market, &trader, (1, 0), SOL).unwrap();
    env.rebalance(&market, None).unwrap();
    assert!(
        env.market_state(&market.market_state).ctokens > 0,
        "lent to Kamino"
    );
    env.swap(&market, &trader, (0, 1), 50_000_000_000).unwrap();
    let lp = env.funded_wallet(&market, [100_000_000_000, 5 * SOL]);
    env.add_liquidity(&market, &lp, [100_000_000_000, 5 * SOL], 0)
        .unwrap();
    let held = env.lp_shares_of(&market, &lp.pubkey());
    env.lock_lp(&market, &lp, held / 10).unwrap();
    assert_eq!(env.balance(&lock), locked + held / 10);
    env.remove_liquidity(&market, &lp, held / 3, [0, 0], remove::Payout::Cash)
        .unwrap();
    env.remove_liquidity(&market, &lp, held / 3, [0, 0], remove::Payout::InKind)
        .unwrap();
    assert_eq!(env.balance(&lock), locked + held / 10);

    // Nobody can remove from it: an LP naming the lock account as their shares is refused,
    // since only the vault authority owns it, and only the program could sign for that.
    let mut steal =
        env.remove_liquidity_instruction(&market, &lp.pubkey(), 1, [0, 0], remove::Payout::InKind);
    steal.accounts[remove::position("lp_shares")].pubkey = lock;
    assert_refused(
        env.send_meta(&[steal], &[&lp]),
        lending_amm::StrategyError::WrongAccount,
    );
    assert_eq!(env.balance(&lock), locked + held / 10);
}

/// Graduates `launch` with raw `data` and `amounts`, the shares to a fresh wallet, with the
/// launchpad's accounts for `params` changed by `change`, and the router's records after.
fn try_graduate(
    env: &mut Env,
    launch: &Launch,
    params: &InitParams,
    data: Vec<u8>,
    amounts: [u64; 2],
    change: impl FnOnce(&mut Vec<pipeline_client::AccountMeta>),
) -> Result<litesvm::types::TransactionMetadata, String> {
    let recipient = Keypair::new().pubkey();
    let mut accounts = env.seed_liquidity_accounts(launch, params, &recipient);
    change(&mut accounts);
    let graduate = env.graduate_instruction(launch, amounts, data, accounts);
    let mut instructions = vec![graduate];
    instructions.extend(env.register_instructions(
        &launch.creator.pubkey(),
        &launch.market_state(params),
        launch.mints,
        launch.token_programs,
    ));
    env.send_as_creator(launch, &instructions)
}

/// The `seed_liquidity` account named `name`'s position among the launchpad's accounts
/// (after the seeder, the payer and the system program).
fn at(name: &str) -> usize {
    [
        "market_state",
        "lp_recipient",
        "mint_0",
        "escrow_0",
        "token_program_0",
        "mint_1",
        "escrow_1",
        "token_program_1",
        "authority",
        "vault_0",
        "vault_1",
        "collateral_mint",
        "ctoken_account",
        "lp_mint",
        "token_program",
        "recipient_shares",
        "associated_token_program",
        "reserve",
    ]
    .iter()
    .position(|n| *n == name)
    .unwrap()
}

use lending_amm::StrategyError;

#[test]
fn seeding_refuses_a_zero_amount_on_either_side_and_anything_but_two_amounts() {
    let seed = [1_000_000_000_000, 10 * SOL];
    for amounts in [[0, seed[1]], [seed[0], 0], [0, 0]] {
        let mut env = Env::new();
        let (launch, params) = wsol_launch(&mut env, seed);
        assert_refused(
            try_graduate(
                &mut env,
                &launch,
                &params,
                init_data(&params),
                amounts,
                |_| {},
            ),
            StrategyError::ZeroDeposit,
        );
    }
    // Too small for any share above the locked minimum.
    let mut env = Env::new();
    let (launch, params) = wsol_launch(&mut env, seed);
    assert_refused(
        try_graduate(
            &mut env,
            &launch,
            &params,
            init_data(&params),
            [1_000, 1_000],
            |_| {},
        ),
        StrategyError::FirstDepositTooSmall,
    );
    // The seed request must carry one amount per mint: called directly by a wallet seeder.
    for amounts in [vec![seed[0]], vec![seed[0], seed[1], 1], vec![]] {
        let mut env = Env::new();
        let token = env.create_mint(&TOKEN);
        let launch = env.wallet_launch([(token, TOKEN), (wsol(), TOKEN)], seed);
        let params = InitParams {
            lent_index: 1,
            lp_fee_bps: 30,
        };
        let accounts = env.seed_liquidity_accounts(&launch, &params, &launch.creator.pubkey());
        let request = pipeline_client::interface::SeedRequest {
            amounts,
            data: init_data(&params),
        };
        let seed_ix = env.seed_liquidity_instruction(&launch, true, &request, accounts);
        assert_refused(
            env.send_meta(&[seed_ix], &[&launch.creator]),
            StrategyError::BadSeedAmounts,
        );
    }
}

#[test]
fn seeding_refuses_every_market_creation_refuses() {
    let seed = [1_000_000_000_000, 10 * SOL];
    let fresh = |env: &mut Env, mints: [(Pubkey, Pubkey); 2]| env.launch(mints, seed);

    // Data that is not the creation parameters.
    for data in [vec![], vec![1], vec![1, 30, 0, 0]] {
        let mut env = Env::new();
        let (launch, params) = wsol_launch(&mut env, seed);
        assert_refused(
            try_graduate(&mut env, &launch, &params, data, seed, |_| {}),
            StrategyError::BadInitData,
        );
    }
    // A fee above the cap, and a lent index outside 0 and 1.
    let cases = [
        (
            InitParams {
                lent_index: 1,
                lp_fee_bps: lending_amm::config::MAX_LP_FEE_BPS + 1,
            },
            StrategyError::LpFeeAboveCap,
        ),
        (
            InitParams {
                lent_index: 2,
                lp_fee_bps: 30,
            },
            StrategyError::BadLentIndex,
        ),
        // Index 0 names the token, which is not a lent mint.
        (
            InitParams {
                lent_index: 0,
                lp_fee_bps: 30,
            },
            StrategyError::LentMintNotListed,
        ),
    ];
    for (params, error) in cases {
        let mut env = Env::new();
        let (launch, _) = wsol_launch(&mut env, seed);
        assert_refused(
            try_graduate(&mut env, &launch, &params, init_data(&params), seed, |_| {}),
            error,
        );
    }
    let params = InitParams {
        lent_index: 1,
        lp_fee_bps: 30,
    };
    // Two equal mints.
    let mut env = Env::new();
    let launch = fresh(&mut env, [(wsol(), TOKEN), (wsol(), TOKEN)]);
    assert_refused(
        try_graduate(&mut env, &launch, &params, init_data(&params), seed, |_| {}),
        StrategyError::EqualMints,
    );
    // The WSOL address as a Token-2022 mint.
    let mut env = Env::new();
    env.write_mint(&wsol(), &TOKEN_2022, 9, None);
    let token = env.create_mint(&TOKEN);
    let launch = fresh(&mut env, [(token, TOKEN), (wsol(), TOKEN_2022)]);
    assert_refused(
        try_graduate(&mut env, &launch, &params, init_data(&params), seed, |_| {}),
        StrategyError::LentMintNotSplToken,
    );
    // A token whose mint carries a refused extension (a transfer fee).
    let mut env = Env::new();
    let token = env.create_mint_with(
        &TOKEN_2022,
        MintOptions {
            transfer_fee_bps: Some(100),
            ..MintOptions::default()
        },
    );
    let launch = fresh(&mut env, [(token, TOKEN_2022), (wsol(), TOKEN)]);
    assert_refused(
        try_graduate(&mut env, &launch, &params, init_data(&params), seed, |_| {}),
        StrategyError::MintExtensionNotAllowed,
    );
    // Another reserve's collateral mint.
    let mut env = Env::new();
    let (launch, params) = wsol_launch(&mut env, seed);
    assert_refused(
        try_graduate(&mut env, &launch, &params, init_data(&params), seed, |a| {
            a[at("collateral_mint")].pubkey = lent(1).1
        }),
        StrategyError::WrongCollateralMint,
    );
    // A reserve that is not the lent mint's, and a deprecated reserve, as the first deposit
    // refuses them.
    let mut env = Env::new();
    let (launch, params) = wsol_launch(&mut env, seed);
    assert_refused(
        try_graduate(&mut env, &launch, &params, init_data(&params), seed, |a| {
            a[at("reserve")].pubkey = lent(1).2
        }),
        StrategyError::ReserveWrongAddress,
    );
    let mut env = Env::new();
    let (launch, params) = wsol_launch(&mut env, seed);
    env.patch(
        &lent(0).2,
        lending_amm::kamino::offsets::VERSION,
        &u64::MAX.to_le_bytes(),
    );
    assert_refused(
        try_graduate(&mut env, &launch, &params, init_data(&params), seed, |_| {}),
        StrategyError::ReserveDeprecated,
    );
    // Shares sent anywhere but the LP recipient's associated token account for the LP mint.
    let mut env = Env::new();
    let (launch, params) = wsol_launch(&mut env, seed);
    let elsewhere =
        lp_recipient_account(&Keypair::new().pubkey(), &launch.addresses(&params).lp_mint);
    assert_refused(
        try_graduate(&mut env, &launch, &params, init_data(&params), seed, |a| {
            a[at("recipient_shares")].pubkey = elsewhere
        }),
        StrategyError::WrongAccount,
    );
}

#[test]
fn nobody_but_the_seeders_program_can_create_or_fund_the_market_at_its_address() {
    let seed = [1_000_000_000_000, 10 * SOL];
    let mut env = Env::new();
    let (launch, params) = wsol_launch(&mut env, seed);
    let target = launch.market_state(&params);

    // Unsigned by the seeder: refused by Anchor's signer check (3010, AccountNotSigner).
    let accounts = env.seed_liquidity_accounts(&launch, &params, &Keypair::new().pubkey());
    let request = pipeline_client::interface::SeedRequest {
        amounts: seed.to_vec(),
        data: init_data(&params),
    };
    let unsigned = env.seed_liquidity_instruction(&launch, false, &request, accounts.clone());
    assert_anchor_error(env.send_meta(&[unsigned], &[]), 3010);

    // Another seeder, signing for itself with its own escrows, can't use the launch's address.
    let rival = env.wallet_launch([(launch.mints[0], TOKEN), (wsol(), TOKEN)], seed);
    let mut theirs = accounts.clone();
    theirs[at("escrow_0")].pubkey = rival.escrows[0];
    theirs[at("escrow_1")].pubkey = rival.escrows[1];
    let rival_seed = env.seed_liquidity_instruction(&rival, true, &request, theirs);
    assert_refused(
        env.send_meta(&[rival_seed], &[&rival.creator]),
        StrategyError::WrongMarketState,
    );

    // Nor can the router's create_market put a market there, at a bad price or any other.
    let addresses = launch.addresses(&params);
    let create = create_market_instruction(
        &env.admin.pubkey(),
        &target,
        init_data(&params),
        init_accounts(&addresses, launch.mints, [TOKEN, TOKEN], lent(0).1),
    );
    assert_refused(env.send(&[create], &[]), StrategyError::WrongMarketState);

    // Lamports sent to the address beforehand don't block the graduation.
    env.svm.airdrop(&target, 1_000_000).unwrap();
    let recipient = Keypair::new().pubkey();
    let graduated = env.graduate(&launch, &params, seed, &recipient).unwrap();
    assert_eq!(graduated.market.market_state, target);
    // And a launch seeds each pair, lent side and fee once.
    write_token_account(
        &mut env.svm,
        &launch.mints[0],
        &TOKEN,
        &launch.seeder,
        seed[0],
    )
    .unwrap();
    write_token_account(&mut env.svm, &wsol(), &TOKEN, &launch.seeder, seed[1]).unwrap();
    assert!(env.graduate(&launch, &params, seed, &recipient).is_err());
    // The same launch may seed the pair at another fee, a market of its own.
    let other_fee = InitParams {
        lp_fee_bps: 100,
        ..params
    };
    let another = env.graduate(&launch, &other_fee, seed, &recipient).unwrap();
    assert_ne!(another.market.market_state, target);
}

#[test]
fn register_existing_market_on_an_account_that_is_not_a_market_is_refused_by_market_info() {
    let mut env = Env::new();
    let (launch, params) = wsol_launch(&mut env, [SOL, SOL]);
    let payer = env.admin.pubkey();

    // An account of the program's that is not a market state: the right size, the wrong
    // discriminator, as anything else the program might come to own.
    let impostor = Pubkey::new_unique();
    let mut data = vec![0u8; lending_amm::LendingAmmMarket::SPACE];
    data[..8].copy_from_slice(&[7; 8]);
    env.svm
        .set_account(
            impostor,
            solana_account::Account {
                lamports: env.svm.minimum_balance_for_rent_exemption(data.len()),
                data,
                owner: strategy_id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let register =
        pipeline_client::register_existing_market(&payer, &strategy_id(), &impostor, vec![]);
    let refused = env.send_meta(&[register], &[]).unwrap_err();
    // Anchor's AccountDiscriminatorMismatch (3002), from pipeline_market_info.
    assert!(
        refused.contains("Instruction: PipelineMarketInfo"),
        "{refused}"
    );
    assert!(
        refused.contains("AccountDiscriminatorMismatch"),
        "{refused}"
    );

    // The seeded address before the seed: nothing of the program's is there yet.
    let empty = launch.market_state(&params);
    let register =
        pipeline_client::register_existing_market(&payer, &strategy_id(), &empty, vec![]);
    assert!(env.send_meta(&[register], &[]).is_err());
    assert!(env
        .svm
        .get_account(&pipeline_client::pda::market(&strategy_id(), &empty))
        .is_none());
}

/// What a market's life shows from outside: the market state's amounts and mode after each
/// step, what each swap and removal paid, and the share count.
#[derive(Debug, PartialEq, Eq)]
struct Life {
    states: Vec<([u64; 2], u64, u128, u128, bool, u64)>,
    received: Vec<u64>,
    removed: Vec<([u64; 2], u64)>,
}

/// Lends, sells beyond the buffer so the swap redeems from Kamino, and removes a third of the
/// LP's shares in cash and a third in kind, recording each step; the LP's shares are in
/// `shares_account`.
fn live(env: &mut Env, market: &Market, lp: &Keypair, shares_account: Pubkey, lent: usize) -> Life {
    let mut life = Life {
        states: vec![],
        received: vec![],
        removed: vec![],
    };
    let snapshot = |env: &Env, life: &mut Life| {
        let s = env.market_state(&market.market_state);
        life.states.push((
            s.reserves,
            s.ctokens,
            s.deposited,
            s.redeemed,
            s.withdraw_mode,
            env.share_count(market),
        ));
    };
    snapshot(env, &mut life);
    env.rebalance(market, None).unwrap();
    snapshot(env, &mut life);
    let (other, lent_side) = (market.other_index(), market.lent_index);
    let trader = env.funded_wallet(market, [rebalance::OTHER, units(lent, 50)]);
    let beyond = env.buffer(market) + units(lent, 2);
    let amount = env.sell_paying(market, beyond);
    let swapped = env
        .swap_meta(market, &trader, (other, lent_side), amount)
        .unwrap();
    assert_eq!(
        events::<lending_amm::events::ShortfallRedeemed>(&swapped.logs).len(),
        1,
        "the sale redeems its shortfall from Kamino"
    );
    life.received
        .push(env.balance(&env.wallet_token_account(market, &trader.pubkey(), lent_side)));
    snapshot(env, &mut life);
    env.swap(market, &trader, (lent_side, other), units(lent, 1))
        .unwrap();
    snapshot(env, &mut life);
    let held = env.balance(&shares_account);
    for payout in [remove::Payout::Cash, remove::Payout::InKind] {
        let mut remove =
            env.remove_liquidity_instruction(market, &lp.pubkey(), held / 3, [0, 0], payout);
        remove.accounts[remove::position("lp_shares")].pubkey = shares_account;
        env.load_klend();
        let meta = env.send_meta(&[remove], &[lp]).unwrap();
        let event = &events::<lending_amm::events::LiquidityRemoved>(&meta.logs)[0];
        life.removed.push((event.amounts, event.ctokens));
        snapshot(env, &mut life);
    }
    life
}

#[test]
fn a_seeded_market_lends_redeems_in_a_swap_and_pays_removals_exactly_as_a_created_one() {
    for lent in 0..lending_amm::config::LENT_MINTS.len() {
        let amounts = [rebalance::OTHER, units(lent, 50)];

        // Created through the router, the first deposit by `add_liquidity`.
        let mut env = Env::new();
        env.load_klend();
        let spec = rebalance::lent_spec(&mut env, lent, 30);
        let (created, lp) = env.create_funded_market(&spec, amounts).unwrap();
        let shares = lp_shares_account(&lp.pubkey(), &created.market_state);
        let created_life = live(&mut env, &created, &lp, shares, lent);

        // Seeded by the launchpad, the shares to the same kind of LP.
        let mut env = Env::new();
        env.load_klend();
        let spec = rebalance::lent_spec(&mut env, lent, 30);
        let launch = env.launch(spec.mints, amounts);
        let lp = Keypair::new();
        env.svm.airdrop(&lp.pubkey(), 10 * SOL).unwrap();
        for (mint, program) in &spec.mints {
            // The removals pay into the LP's associated token accounts, which an LP has.
            write_token_account(&mut env.svm, mint, program, &lp.pubkey(), 0).unwrap();
        }
        let graduated = env
            .graduate(&launch, &spec.params, amounts, &lp.pubkey())
            .unwrap();
        let seeded_life = live(
            &mut env,
            &graduated.market,
            &lp,
            graduated.recipient_account,
            lent,
        );

        assert_eq!(seeded_life, created_life, "lent mint {lent}");
        assert_eq!(seeded_life.removed.len(), 2);
    }
}
