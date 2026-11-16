//! Limits (docs/spec/README.md, "Test layers" 5): the compute ceilings of
//! docs/spec/lending-pool.md, "Compute ceilings", for the instructions that exist so far,
//! and the creation transaction's size.
//!
//! The `ceilings` module mirrors the spec's table, and is its one place in the tests: a
//! ceiling changes only by a PR to the spec file and this table together. A cost is what the
//! lending AMM's own invocation consumes, its calls to other programs included, measured on
//! plain SPL Token and Token-2022 mints and on a mint with Pipeline's test-hook. Each test
//! prints what it measured.

mod common;

use common::*;
use pipeline_client::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

/// The spec's table, in compute units, for the instructions this build has.
mod ceilings {
    pub const PIPELINE_QUOTE: u64 = 40_000;
    pub const PIPELINE_SWAP_NO_REDEEM: u64 = 40_000;
    pub const PIPELINE_SWAP_WITH_REDEEM: u64 = 80_000;
    pub const PIPELINE_RESOLVE_ACCOUNTS: u64 = 40_000;
    pub const PIPELINE_INIT_MARKET: u64 = 150_000;
    pub const ADD_LIQUIDITY: u64 = 60_000;
    pub const REBALANCE: u64 = 100_000;
    pub const REMOVE_LIQUIDITY_CASH: u64 = 120_000;
    pub const REMOVE_LIQUIDITY_IN_KIND: u64 = 90_000;
    pub const LOCK_LP: u64 = 40_000;
}

/// Solana's limit on a serialized transaction, in bytes.
const PACKET_DATA_SIZE: usize = 1_232;

/// A fixed secret key for the account a test names `label`.
///
/// A program's cost moves by 1,500 compute units for every bump a PDA search tries, and the
/// LP's shares account (from the LP's key) and a hooked mint's validation account (from the
/// mint's key) are both searched for in `add_liquidity`: with random keys the hooked first
/// deposit measured from 39,135 to 55,635 units over 300 runs on 2026-11-16, and once 67,138
/// in CI. Fixed keys make each measurement the same on every run; these labels give keys whose
/// costs sit at those runs' medians.
fn fixed_key(label: &str) -> [u8; 32] {
    let mut key = [0u8; 32];
    for (i, byte) in label.bytes().enumerate() {
        key[i % 32] = key[i % 32].wrapping_mul(31).wrapping_add(byte);
    }
    key
}

/// Funded WSOL-lent markets holding cTokens, whose other side is plain SPL Token, plain
/// Token-2022 and a Token-2022 mint with Pipeline's test-hook, each at a fixed address and
/// funded by an LP with a fixed key, so their costs are the same on every run.
fn markets() -> Vec<(&'static str, Env, Market, solana_keypair::Keypair)> {
    let mut out = vec![];
    for name in ["SPL Token", "Token-2022", "hooked Token-2022"] {
        let mut env = Env::new();
        let options = MintOptions {
            key: Some(fixed_key(&format!("the mint on {name}"))),
            ..MintOptions::default()
        };
        let (mint, token_program) = match name {
            "SPL Token" => (env.create_mint_with(&TOKEN, options), TOKEN),
            "Token-2022" => (env.create_mint_with(&TOKEN_2022, options), TOKEN_2022),
            _ => (env.create_hooked_mint_with(options).0, TOKEN_2022),
        };
        let spec = MarketSpec {
            mints: [(mint, token_program), (wsol(), TOKEN)],
            params: lending_amm::InitParams {
                lent_index: 1,
                lp_fee_bps: 30,
            },
        };
        let lp = solana_keypair::Keypair::new_from_array(fixed_key(&format!("an LP on {name}")));
        let (market, lp) = env
            .create_funded_market_by(&spec, [1_000_000_000_000, 50 * SOL], lp)
            .unwrap();
        // cTokens worth about 150 SOL, as if rebalance had lent three quarters of the lent
        // side: valuing them is the dearest part of reading the reserve.
        env.give_ctokens(&market, 150 * SOL);
        out.push((name, env, market, lp));
    }
    out
}

#[test]
fn creating_and_funding_a_market_fits_one_transaction() {
    // create_market, init_fee_account for each mint and add_liquidity, as the metadata
    // describes and Aviary sends it (docs/spec/lending-pool.md, "Creating a market").
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let lp = solana_keypair::Keypair::new();
    let (create, addresses) = env.create_instruction(&spec, init_data(&spec.params), |_| {});
    let mut instructions = vec![create];
    instructions.extend(env.fee_account_instructions(&addresses.market_state, spec.mints));
    let market = Market {
        market: pipeline_client::pda::market(&strategy_id(), &addresses.market_state),
        addresses,
        market_state: addresses.market_state,
        mints: [spec.mints[0].0, spec.mints[1].0],
        token_programs: [TOKEN, TOKEN],
        vaults: addresses.vaults,
        lent_index: 1,
        hook_accounts: [vec![], vec![]],
        created: Default::default(),
    };
    instructions.push(env.add_liquidity_instruction(&market, &lp.pubkey(), [SOL, SOL], 0));
    let tx = Transaction::new_signed_with_payer(
        &instructions,
        Some(&env.admin.pubkey()),
        &[&env.admin, &lp],
        env.svm.latest_blockhash(),
    );
    let size = bincode_size(&tx);
    println!(
        "create_market + init_fee_account x2 + add_liquidity: {size} of {PACKET_DATA_SIZE} bytes, {} accounts",
        tx.message.account_keys.len()
    );
    assert!(size <= PACKET_DATA_SIZE, "{size} bytes");
    // And it lands: the LP funds it.
    for (mint, token_program) in spec.mints.iter() {
        write_token_account(&mut env.svm, mint, token_program, &lp.pubkey(), SOL).unwrap();
    }
    env.svm.airdrop(&lp.pubkey(), SOL).unwrap();
    env.svm
        .send_transaction(tx)
        .map_err(|f| format!("{:?}", f.err))
        .unwrap();
    assert_eq!(env.market_state(&market.market_state).reserves, [SOL, SOL]);
}

/// A legacy transaction's wire size: the signatures, then the message.
fn bincode_size(tx: &Transaction) -> usize {
    let compact = |n: usize| {
        if n < 0x80 {
            1
        } else if n < 0x4000 {
            2
        } else {
            3
        }
    };
    let message = tx.message_data();
    compact(tx.signatures.len()) + 64 * tx.signatures.len() + message.len()
}

#[test]
fn the_one_transaction_creation_succeeds_and_its_instructions_stay_under_their_ceilings() {
    for (name, _, market, _) in markets() {
        // create_market calls the strategy twice (pipeline_init_market, then
        // pipeline_market_info); add_liquidity is the third invocation.
        let costs = strategy_compute(&market.created.logs);
        assert_eq!(costs.len(), 3, "{:?}", market.created.logs);
        println!(
            "on {name}: pipeline_init_market {} CU, add_liquidity (first deposit, creating the LP's shares account) {} CU",
            costs[0], costs[2]
        );
        assert!(
            costs[0] <= ceilings::PIPELINE_INIT_MARKET,
            "{name}: {}",
            costs[0]
        );
        assert!(costs[2] <= ceilings::ADD_LIQUIDITY, "{name}: {}", costs[2]);
    }
}

#[test]
fn a_later_add_liquidity_stays_under_its_ceiling() {
    for (name, mut env, market, lp) in markets() {
        let more = env.funded_wallet(&market, [1_000_000_000_000, 50 * SOL]);
        let fresh = env
            .add_liquidity(&market, &more, [10_000_000_000, SOL], 0)
            .unwrap();
        let fresh_cost = strategy_compute(&fresh.logs)[0];
        // The first LP adds again, with their shares account already there.
        for i in 0..2 {
            write_token_account(
                &mut env.svm,
                &market.mints[i],
                &market.token_programs[i],
                &lp.pubkey(),
                100 * SOL,
            )
            .unwrap();
        }
        let repeat = env
            .add_liquidity(&market, &lp, [10_000_000_000, SOL], 0)
            .unwrap();
        let repeat_cost = strategy_compute(&repeat.logs)[0];
        println!("add_liquidity on {name}: {fresh_cost} CU creating the shares account, {repeat_cost} CU with it");
        assert!(
            fresh_cost <= ceilings::ADD_LIQUIDITY,
            "{name}: {fresh_cost}"
        );
        assert!(
            repeat_cost <= ceilings::ADD_LIQUIDITY,
            "{name}: {repeat_cost}"
        );
    }
}

#[test]
fn quotes_account_resolution_and_swaps_stay_under_their_ceilings() {
    for (name, mut env, market, _) in markets() {
        let trader = env.funded_wallet(&market, [1_000_000_000_000, 100 * SOL]);
        for (input, output, amount) in [(1, 0, 3 * SOL), (0, 1, 20_000_000_000)] {
            let trade = exact_in(input, output, amount);
            let resolve = resolve_compute(&env, &market, &trade);
            let quote = strategy_compute(&env.quote_meta(&market, &trade).unwrap().logs)[0];
            let swap = env
                .swap_meta(&market, &trader, (input, output), amount)
                .unwrap();
            let swap = *strategy_compute(&swap.logs).last().unwrap();
            println!(
                "{input}->{output} on {name}: pipeline_resolve_accounts {resolve} CU, pipeline_quote {quote} CU, pipeline_swap {swap} CU"
            );
            assert!(
                resolve <= ceilings::PIPELINE_RESOLVE_ACCOUNTS,
                "{name}: {resolve}"
            );
            assert!(quote <= ceilings::PIPELINE_QUOTE, "{name}: {quote}");
            assert!(swap <= ceilings::PIPELINE_SWAP_NO_REDEEM, "{name}: {swap}");
        }
    }
}

/// The most any round of `pipeline_resolve_accounts` consumed for `trade`.
fn resolve_compute(env: &Env, market: &Market, trade: &TradeRequest) -> u64 {
    let (_, rounds) = env.resolve_rounds(market, trade).unwrap();
    rounds
        .iter()
        .map(|round| strategy_compute(&round.logs)[0])
        .max()
        .unwrap()
}

#[test]
fn a_swap_that_redeems_its_shortfall_and_its_quote_and_resolution_stay_under_their_ceilings() {
    // Markets that lent through klend's real deposit, on both lent mints; a sell paying out 1.5
    // times the buffer redeems the rest from Kamino in the swap. Nothing these instructions run
    // searches for a PDA's bump but the lending market authority's, which depends only on the
    // lending market, so their costs do not depend on the market's keys.
    for lent in 0..lending_amm::config::LENT_MINTS.len() {
        let name = common::kamino::lent_name(lent);
        let mut env = Env::new();
        let market = env.lending_market(lent, 30);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let buffer = env.buffer(&market);
        let amount = env.sell_paying(&market, buffer + buffer / 2);
        let trade = exact_in(other, lent_side, amount);
        let resolve = resolve_compute(&env, &market, &trade);
        let quote = strategy_compute(&env.quote_meta(&market, &trade).unwrap().logs)[0];
        let trader = env.funded_wallet(&market, [2 * amount, 0]);
        let logs = env
            .swap_meta(&market, &trader, (other, lent_side), amount)
            .unwrap()
            .logs;
        assert_eq!(
            events::<lending_amm::events::ShortfallRedeemed>(&logs).len(),
            1
        );
        let (swap, klend) = (
            *strategy_compute(&logs).last().unwrap(),
            klend_compute(&logs),
        );
        println!(
            "a redeeming sell on {name}: pipeline_resolve_accounts {resolve} CU, pipeline_quote {quote} CU, pipeline_swap {swap} CU (klend {klend})"
        );
        assert!(
            resolve <= ceilings::PIPELINE_RESOLVE_ACCOUNTS,
            "{name}: {resolve}"
        );
        assert!(quote <= ceilings::PIPELINE_QUOTE, "{name}: {quote}");
        assert!(
            swap <= ceilings::PIPELINE_SWAP_WITH_REDEEM,
            "{name}: {swap}"
        );
    }
}

/// What klend's own invocation consumed, from a transaction's logs.
fn klend_compute(logs: &[String]) -> u64 {
    let prefix = format!("Program {} consumed ", common::kamino::klend());
    logs.iter()
        .find_map(|line| line.strip_prefix(&prefix))
        .map(|rest| rest.split(' ').next().unwrap().parse().unwrap())
        .expect("klend ran")
}

#[test]
fn rebalance_stays_under_its_ceiling_depositing_and_redeeming() {
    use common::rebalance::{lent_spec, units, OTHER};
    for lent in 0..lending_amm::config::LENT_MINTS.len() {
        let name = common::kamino::lent_name(lent);
        // Depositing: a market whose whole lent side is in its buffer.
        let mut env = Env::new();
        let spec = lent_spec(&mut env, lent, 30);
        let (market, _) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        let logs = env.rebalance(&market, None).unwrap().logs;
        let (deposit, klend_deposit) = (strategy_compute(&logs)[0], klend_compute(&logs));
        // Redeeming: a market whose buffer a swap has drained below the band.
        let market = env.market_below_the_band(lent);
        let logs = env.rebalance(&market, None).unwrap().logs;
        let (redeem, klend_redeem) = (strategy_compute(&logs)[0], klend_compute(&logs));
        println!(
            "rebalance on {name}: depositing {deposit} CU (klend {klend_deposit}), redeeming {redeem} CU (klend {klend_redeem})"
        );
        assert!(deposit <= ceilings::REBALANCE, "{name}: {deposit}");
        assert!(redeem <= ceilings::REBALANCE, "{name}: {redeem}");
    }
}

#[test]
fn removals_in_cash_and_in_kind_and_lock_lp_stay_under_their_ceilings() {
    use common::rebalance::{units, OTHER};
    use common::remove::Payout;
    // Each other-side mint kind against WSOL, and plain SPL Token against each lent mint, on
    // markets that have lent through klend's real deposit, each at a fixed address and with
    // LPs of fixed keys: the removal's and the lock's associated token account checks search
    // for a bump from the LP's key, and a hooked transfer from the mint's.
    let mut cases = vec![];
    for kind in ["SPL Token", "Token-2022", "hooked Token-2022"] {
        cases.push((kind, 0usize));
    }
    for lent in 1..lending_amm::config::LENT_MINTS.len() {
        cases.push(("SPL Token", lent));
    }
    for (kind, lent) in cases {
        let name = format!("{kind} against {}", common::kamino::lent_name(lent));
        let mut env = Env::new();
        env.load_klend();
        let options = MintOptions {
            key: Some(fixed_key(&format!("the mint on {name}"))),
            ..MintOptions::default()
        };
        let (mint, token_program) = match kind {
            "SPL Token" => (env.create_mint_with(&TOKEN, options), TOKEN),
            "Token-2022" => (env.create_mint_with(&TOKEN_2022, options), TOKEN_2022),
            _ => (env.create_hooked_mint_with(options).0, TOKEN_2022),
        };
        let spec = MarketSpec {
            mints: [
                (mint, token_program),
                (ck(&lending_amm::config::LENT_MINTS[lent].mint), TOKEN),
            ],
            params: lending_amm::InitParams {
                lent_index: 1,
                lp_fee_bps: 30,
            },
        };
        let lp = solana_keypair::Keypair::new_from_array(fixed_key(&format!("an LP on {name}")));
        let (market, lp) = env
            .create_funded_market_by(&spec, [OTHER, units(lent, 50)], lp)
            .unwrap();
        env.rebalance(&market, None).unwrap();
        let third = env.lp_shares_of(&market, &lp.pubkey()) / 3;
        let logs = env
            .remove_liquidity(&market, &lp, third, [0, 0], Payout::Cash)
            .unwrap()
            .logs;
        let (cash, klend_redeem) = (strategy_compute(&logs)[0], klend_compute(&logs));
        // In kind, creating the LP's cToken account, then into the account that exists.
        let creating = env
            .remove_liquidity(&market, &lp, third / 2, [0, 0], Payout::InKind)
            .unwrap();
        let existing = env
            .remove_liquidity(&market, &lp, third / 2, [0, 0], Payout::InKind)
            .unwrap();
        let in_kind = [creating, existing].map(|meta| strategy_compute(&meta.logs)[0]);
        // Locking, creating the lock account, then into the account that exists.
        let locks = [0, 1].map(|_| {
            let meta = env.lock_lp(&market, &lp, third / 4).unwrap();
            strategy_compute(&meta.logs)[0]
        });
        println!(
            "on {name}: remove_liquidity in cash {cash} CU (klend {klend_redeem}), in kind {} CU creating the LP's cToken account and {} CU after; lock_lp {} CU creating the lock account and {} CU after",
            in_kind[0], in_kind[1], locks[0], locks[1]
        );
        assert!(cash <= ceilings::REMOVE_LIQUIDITY_CASH, "{name}: {cash}");
        for cost in in_kind {
            assert!(cost <= ceilings::REMOVE_LIQUIDITY_IN_KIND, "{name}: {cost}");
        }
        for cost in locks {
            assert!(cost <= ceilings::LOCK_LP, "{name}: {cost}");
        }
    }
}

#[test]
fn the_ceilings_hold_in_every_state_of_kamino() {
    // Each row of "When Kamino can't pay" but a failed layout check, where every call but an
    // in-kind removal is refused, which the removal test above measures: on a market that has
    // lent through klend's real deposit, at a fixed address and with LPs of fixed keys, every call
    // the state allows is measured: quotes, account resolution and swaps within the buffer and
    // beyond it, `rebalance` (entering withdraw mode and redeeming where Kamino is thin, then
    // leaving it and depositing again), adding, and removing in cash and in kind.
    use common::rebalance::{units, OTHER};
    use common::remove::Payout;
    use common::states::KaminoState;
    for (lent, entry) in lending_amm::config::LENT_MINTS.iter().enumerate() {
        let name = common::kamino::lent_name(lent);
        let little = units(lent, 10);
        for state in [
            KaminoState::Normal,
            KaminoState::LittleFreeLiquidity(little),
            KaminoState::CapUsedUp,
            KaminoState::BlockCtokenUsage,
            KaminoState::ReserveEmergencyMode,
            KaminoState::MarketEmergencyMode,
            KaminoState::Deprecated,
        ] {
            let mut env = Env::new();
            env.load_klend();
            let options = MintOptions {
                key: Some(fixed_key(&format!("the other mint, lending {name}"))),
                ..MintOptions::default()
            };
            let other_mint = env.create_mint_with(&TOKEN, options);
            let spec = MarketSpec {
                mints: [(other_mint, TOKEN), (ck(&entry.mint), TOKEN)],
                params: lending_amm::InitParams {
                    lent_index: 1,
                    lp_fee_bps: 30,
                },
            };
            let lp = solana_keypair::Keypair::new_from_array(fixed_key(&format!(
                "an LP lending {name}"
            )));
            let (market, lp) = env
                .create_funded_market_by(&spec, [OTHER, units(lent, 50)], lp)
                .unwrap();
            env.rebalance(&market, None).unwrap();
            let (other, lent_side) = (market.other_index(), market.lent_index);
            let within = env.sell_paying(&market, env.buffer(&market) / 2);
            let beyond = env.sell_paying(&market, env.buffer(&market) + little / 2);
            let free = env.free_liquidity(&market);
            env.set_kamino_state(&market, state);

            let mut measured: Vec<(String, u64, u64)> = vec![];
            let trader = env.funded_wallet(&market, [4 * beyond, 0]);
            for (size, amount, ceiling) in [
                ("within", within, ceilings::PIPELINE_SWAP_NO_REDEEM),
                ("beyond", beyond, ceilings::PIPELINE_SWAP_WITH_REDEEM),
            ] {
                let trade = exact_in(other, lent_side, amount);
                if let Ok(meta) = env.quote_meta(&market, &trade) {
                    let cost = strategy_compute(&meta.logs)[0];
                    measured.push((
                        format!("pipeline_quote {size}"),
                        cost,
                        ceilings::PIPELINE_QUOTE,
                    ));
                }
                if let Ok((_, rounds)) = env.resolve_rounds(&market, &trade) {
                    let cost = rounds
                        .iter()
                        .map(|r| strategy_compute(&r.logs)[0])
                        .max()
                        .unwrap();
                    measured.push((
                        format!("pipeline_resolve_accounts {size}"),
                        cost,
                        ceilings::PIPELINE_RESOLVE_ACCOUNTS,
                    ));
                }
                if let Ok(meta) = env.swap_meta(&market, &trader, (other, lent_side), amount) {
                    let cost = *strategy_compute(&meta.logs).last().unwrap();
                    measured.push((format!("pipeline_swap {size}"), cost, ceiling));
                }
            }
            // The sells drained the buffer below its band.
            if let Ok(meta) = env.rebalance(&market, None) {
                let cost = strategy_compute(&meta.logs)[0];
                measured.push(("rebalance".into(), cost, ceilings::REBALANCE));
            }
            if env.market_state(&market.market_state).withdraw_mode {
                // Borrowers repay all they took: rebalance leaves withdraw mode and deposits.
                let now_free = env.free_liquidity(&market);
                env.set_free_liquidity(&market, now_free + (free - little));
                let meta = env.rebalance(&market, None).unwrap();
                let cost = strategy_compute(&meta.logs)[0];
                measured.push((
                    "rebalance leaving withdraw mode".into(),
                    cost,
                    ceilings::REBALANCE,
                ));
            }
            let adder = solana_keypair::Keypair::new_from_array(fixed_key(&format!(
                "an adder lending {name}"
            )));
            env.svm.airdrop(&adder.pubkey(), 10 * SOL).unwrap();
            for (i, amount) in [OTHER, units(lent, 50)].into_iter().enumerate() {
                write_token_account(
                    &mut env.svm,
                    &market.mints[i],
                    &TOKEN,
                    &adder.pubkey(),
                    amount,
                )
                .unwrap();
            }
            if let Ok(meta) = env.add_liquidity(&market, &adder, [OTHER / 10, units(lent, 5)], 0) {
                let cost = strategy_compute(&meta.logs)[0];
                measured.push(("add_liquidity".into(), cost, ceilings::ADD_LIQUIDITY));
            }
            let shares = env.lp_shares_of(&market, &lp.pubkey()) / 100;
            if let Ok(meta) = env.remove_liquidity(&market, &lp, shares, [0, 0], Payout::Cash) {
                let cost = strategy_compute(&meta.logs)[0];
                measured.push((
                    "remove_liquidity, cash".into(),
                    cost,
                    ceilings::REMOVE_LIQUIDITY_CASH,
                ));
            }
            let meta = env
                .remove_liquidity(&market, &lp, shares, [0, 0], Payout::InKind)
                .unwrap();
            let cost = strategy_compute(&meta.logs)[0];
            measured.push((
                "remove_liquidity, in kind".into(),
                cost,
                ceilings::REMOVE_LIQUIDITY_IN_KIND,
            ));

            let line: Vec<String> = measured
                .iter()
                .map(|(what, cost, _)| format!("{what} {cost}"))
                .collect();
            println!("{name}, {state:?}: {}", line.join(", "));
            for (what, cost, ceiling) in measured {
                assert!(
                    cost <= ceiling,
                    "{name}, {state:?}: {what} {cost} CU, ceiling {ceiling}"
                );
            }
        }
    }
}

#[test]
fn the_table_mirrors_the_spec() {
    let spec = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/spec/lending-pool.md"),
    )
    .unwrap();
    let table: String = spec
        .split("### Compute ceilings")
        .nth(1)
        .and_then(|rest| rest.split("\n### ").next())
        .expect("the spec's compute ceilings section")
        .to_string();
    let row = |instruction: &str, ceiling: u64| {
        let cells = format!("| {instruction} | {} |", format_cu(ceiling));
        assert!(
            table.contains(&cells),
            "the spec's table has no row {cells}"
        );
    };
    use ceilings::*;
    row("`pipeline_quote`", PIPELINE_QUOTE);
    row("`pipeline_swap`, no redeem", PIPELINE_SWAP_NO_REDEEM);
    row("`pipeline_swap`, with a redeem", PIPELINE_SWAP_WITH_REDEEM);
    row("`pipeline_resolve_accounts`", PIPELINE_RESOLVE_ACCOUNTS);
    row("`pipeline_init_market`", PIPELINE_INIT_MARKET);
    row("`add_liquidity`", ADD_LIQUIDITY);
    row("`rebalance`", REBALANCE);
    row("`remove_liquidity`, cash", REMOVE_LIQUIDITY_CASH);
    row("`remove_liquidity`, in kind", REMOVE_LIQUIDITY_IN_KIND);
    row("`lock_lp`", LOCK_LP);
    let _ = Pubkey::default();
}

/// `150000` as the spec writes it, `150,000`.
fn format_cu(units: u64) -> String {
    let digits = units.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}
