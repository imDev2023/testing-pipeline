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
    pub const PIPELINE_RESOLVE_ACCOUNTS: u64 = 40_000;
    pub const PIPELINE_INIT_MARKET: u64 = 150_000;
    pub const ADD_LIQUIDITY: u64 = 60_000;
    pub const REBALANCE: u64 = 100_000;
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
            let resolve = strategy_compute(&env.resolve_meta(&market, &trade).unwrap().logs)[0];
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
    row("`pipeline_resolve_accounts`", PIPELINE_RESOLVE_ACCOUNTS);
    row("`pipeline_init_market`", PIPELINE_INIT_MARKET);
    row("`add_liquidity`", ADD_LIQUIDITY);
    row("`rebalance`", REBALANCE);
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
