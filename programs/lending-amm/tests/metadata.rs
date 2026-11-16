//! `metadata.json` against the program (docs/spec/lending-pool.md, "Custom actions and
//! metadata"; docs/spec/README.md, "Metadata, IDL and conformance report"): it passes
//! `pipeline-client`'s validator with zero warnings, its `init` form takes the other mint
//! and then the lent mint (so `lent_index` is 1), and `create_market`, `add_liquidity`,
//! `rebalance`, `remove_liquidity` in cash and in kind and `lock_lp` built from it, as a desk or
//! a keeper builds them, carry exactly the accounts and data the program expects, and work.

mod common;

use std::collections::HashMap;

use common::*;
use pipeline_client::metadata::{
    parse_account_source, parse_strategy_metadata, AccountSource, PdaSeed,
};
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use serde_json::Value;
use solana_signer::Signer;

fn metadata() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("metadata.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn the_metadata_passes_the_validator_with_zero_warnings() {
    let warnings = parse_strategy_metadata(&metadata()).expect("valid metadata");
    assert!(warnings.is_empty(), "warnings: {warnings:?}");
}

#[test]
fn the_metadata_describes_a_lending_amm() {
    let m = metadata();
    assert_eq!(m["name"], "Aviary Lending AMM");
    assert_eq!(m["category"], "amm");
    let tags = m["tags"].as_array().unwrap();
    assert!(tags.contains(&Value::from("lending")) && tags.contains(&Value::from("kamino")));
    assert!(m["links"]["source"]
        .as_str()
        .unwrap()
        .ends_with("/programs/lending-amm"));
    assert!(m["links"]["idl"]
        .as_str()
        .unwrap()
        .ends_with("/programs/lending-amm/idl/lending_amm.json"));
    assert_eq!(
        m["security"]["contact"],
        "https://github.com/imDev2023/testing-pipeline/security/advisories/new"
    );
    assert_eq!(m["init"]["idl_type"], "InitParams");
    // Every action that exists so far, with its kind and signer.
    let actions: Vec<(&str, &str)> = m["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| (a["name"].as_str().unwrap(), a["kind"].as_str().unwrap()))
        .collect();
    assert_eq!(
        actions,
        [
            ("add_liquidity", "add_liquidity"),
            ("rebalance", "other"),
            ("remove_liquidity", "remove_liquidity"),
            ("remove_liquidity_in_kind", "remove_liquidity"),
            ("lock_lp", "other")
        ]
    );
    // An LP signs removals and locks, as the writable wallet that pays for any account
    // created, and nothing else signs.
    for action in &m["actions"].as_array().unwrap()[2..] {
        let signers: Vec<&Value> = action["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["signer"].as_bool().unwrap_or(false))
            .collect();
        assert_eq!(signers.len(), 1, "{}", action["name"]);
        assert_eq!(signers[0]["source"], "wallet");
        assert_eq!(signers[0]["writable"], true);
    }
    // rebalance is signed by anyone: the wallet that calls it, read-only, and nothing else.
    let rebalance = &m["actions"][1];
    let signers: Vec<&Value> = rebalance["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["signer"].as_bool().unwrap_or(false))
        .collect();
    assert_eq!(signers.len(), 1);
    assert_eq!(signers[0]["source"], "wallet");
    assert!(!signers[0]["writable"].as_bool().unwrap_or(false));
}

#[test]
fn the_init_form_takes_the_other_mint_then_the_lent_mint_and_lent_index_is_its_first_arg() {
    let init = &metadata()["init"];
    assert_eq!(
        init["market_state"],
        "pda:strategy:str:market,key:input:other_mint,key:input:lent_mint,arg:lp_fee_bps"
    );
    let args: Vec<(&str, &str)> = init["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| (a["name"].as_str().unwrap(), a["type"].as_str().unwrap()))
        .collect();
    assert_eq!(args, [("lent_index", "u8"), ("lp_fee_bps", "u16")]);
    assert!(init["args"][0]["label"].as_str().unwrap().contains('1'));
    assert_eq!(init["accounts"][0]["source"], "input:other_mint");
    assert_eq!(init["accounts"][1]["source"], "input:lent_mint");
}

/// Everything a desk knows when it resolves a source.
struct Context {
    wallet: Pubkey,
    market_state: Pubkey,
    inputs: HashMap<String, (Pubkey, Pubkey)>,
    args: HashMap<String, Vec<u8>>,
    /// For an existing market: mints, vaults and token programs by index.
    market: Option<Market>,
}

/// Resolves a metadata account source as Pipeline's SDK does.
fn resolve(source: &AccountSource, cx: &Context) -> Pubkey {
    let market = || cx.market.as_ref().expect("a market");
    match source {
        AccountSource::Wallet => cx.wallet,
        AccountSource::MarketState => cx.market_state,
        AccountSource::SystemProgram => pipeline_client::SYSTEM_PROGRAM_ID,
        AccountSource::Fixed(key) => *key,
        AccountSource::Input(name) => cx.inputs[name.as_str()].0,
        AccountSource::Mint(i) => market().mints[*i as usize],
        AccountSource::Vault(i) => market().vaults[*i as usize],
        AccountSource::TokenProgram(i) => market().token_programs[*i as usize],
        AccountSource::WalletTokenAccount(i) => pipeline_client::pda::associated_token(
            &cx.wallet,
            &market().mints[*i as usize],
            &market().token_programs[*i as usize],
        ),
        AccountSource::StrategyProgram => strategy_id(),
        AccountSource::AssociatedTokenProgram => pipeline_client::ASSOCIATED_TOKEN_PROGRAM_ID,
        AccountSource::Ata { owner, mint } => pipeline_client::pda::associated_token(
            &resolve(owner, cx),
            &resolve(mint, cx),
            &match mint.as_ref() {
                AccountSource::Input(name) => cx.inputs[name.as_str()].1,
                other => panic!("unexpected mint source {other:?}"),
            },
        ),
        AccountSource::TokenProgramOf(mint) => match mint.as_ref() {
            AccountSource::Input(name) => cx.inputs[name.as_str()].1,
            other => panic!("unexpected mint source {other:?}"),
        },
        AccountSource::Pda { program, seeds } => {
            // The lending AMM's own PDAs, and klend's lending market authority.
            let program = program.unwrap_or_else(strategy_id);
            assert!(program == strategy_id() || program == common::kamino::klend());
            let bytes: Vec<Vec<u8>> = seeds
                .iter()
                .map(|seed| match seed {
                    PdaSeed::Str(text) => text.as_bytes().to_vec(),
                    PdaSeed::Key(source) => resolve(source, cx).to_bytes().to_vec(),
                    PdaSeed::Arg(name) => cx.args[name.as_str()].clone(),
                    PdaSeed::Hex(bytes) => bytes.clone(),
                })
                .collect();
            let refs: Vec<&[u8]> = bytes.iter().map(Vec::as_slice).collect();
            Pubkey::find_program_address(&refs, &program).0
        }
        other => panic!("unexpected source {other:?}"),
    }
}

fn metas(accounts: &Value, cx: &Context) -> Vec<AccountMeta> {
    accounts
        .as_array()
        .unwrap()
        .iter()
        .map(|account| {
            let source = parse_account_source(account["source"].as_str().unwrap()).unwrap();
            let address = resolve(&source, cx);
            let signer = account["signer"].as_bool().unwrap_or(false);
            if account["writable"].as_bool().unwrap_or(false) {
                AccountMeta::new(address, signer)
            } else {
                AccountMeta::new_readonly(address, signer)
            }
        })
        .collect()
}

/// Encodes `value` as the metadata's `type` says Borsh encodes it.
fn encode(kind: &str, value: u64) -> Vec<u8> {
    match kind {
        "bool" => vec![(value != 0) as u8],
        "u8" => vec![value as u8],
        "u16" => (value as u16).to_le_bytes().to_vec(),
        "u64" => value.to_le_bytes().to_vec(),
        other => panic!("no argument has type {other}"),
    }
}

fn encoded_args(spec: &Value, values: &HashMap<&str, u64>) -> HashMap<String, Vec<u8>> {
    spec.as_array()
        .unwrap()
        .iter()
        .map(|arg| {
            let name = arg["name"].as_str().unwrap();
            (
                name.to_string(),
                encode(arg["type"].as_str().unwrap(), values[name]),
            )
        })
        .collect()
}

#[test]
fn create_market_and_add_liquidity_built_from_the_metadata_are_what_the_program_expects() {
    let m = metadata();
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let (other, lent_mint) = (spec.mints[0].0, wsol());
    let init_values = HashMap::from([("lent_index", 1u64), ("lp_fee_bps", 30)]);
    let args = encoded_args(&m["init"]["args"], &init_values);
    let mut cx = Context {
        wallet: env.admin.pubkey(),
        market_state: Pubkey::default(),
        inputs: HashMap::from([
            ("other_mint".to_string(), (other, TOKEN)),
            ("lent_mint".to_string(), (lent_mint, TOKEN)),
            ("collateral_mint".to_string(), (lent(0).1, TOKEN)),
            ("reserve".to_string(), (lent(0).2, TOKEN)),
        ]),
        args: args.clone(),
        market: None,
    };
    let state_source = parse_account_source(m["init"]["market_state"].as_str().unwrap()).unwrap();
    cx.market_state = resolve(&state_source, &cx);
    assert_eq!(
        cx.market_state,
        market_state_address([other, lent_mint], 1, 30)
    );

    // init_data is the metadata's args in order, the program's Borsh creation parameters.
    let init_data: Vec<u8> = m["init"]["args"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|arg| args[arg["name"].as_str().unwrap()].clone())
        .collect();
    assert_eq!(init_data, common::init_data(&spec.params));
    let init_accounts = metas(&m["init"]["accounts"], &cx);
    let (expected_create, addresses) = env.create_instruction(&spec, init_data.clone(), |_| {});
    let strategy_accounts =
        &expected_create.accounts[expected_create.accounts.len() - init_accounts.len()..];
    assert_eq!(init_accounts, strategy_accounts);

    // add_liquidity, as the desk builds it once the market's mints and vaults are known.
    let market = Market {
        market: pipeline_client::pda::market(&strategy_id(), &cx.market_state),
        addresses,
        market_state: cx.market_state,
        mints: [other, lent_mint],
        token_programs: [TOKEN, TOKEN],
        vaults: addresses.vaults,
        lent_index: 1,
        hook_accounts: [vec![], vec![]],
        created: Default::default(),
    };
    let lp = solana_keypair::Keypair::new();
    cx.wallet = lp.pubkey();
    cx.market = Some(market.clone());
    let action = &m["actions"][0];
    let amounts = [4_000_000_000u64, 2 * SOL];
    let values = HashMap::from([("max_0", amounts[0]), ("max_1", amounts[1]), ("min_lp", 1)]);
    let action_args = encoded_args(&action["args"], &values);
    let mut data = anchor_discriminator(action["name"].as_str().unwrap()).to_vec();
    for arg in action["args"].as_array().unwrap() {
        data.extend(action_args[arg["name"].as_str().unwrap()].clone());
    }
    let add = Instruction::new_with_bytes(strategy_id(), &data, metas(&action["accounts"], &cx));
    assert_eq!(
        add,
        env.add_liquidity_instruction(&market, &lp.pubkey(), amounts, 1)
    );

    // And the metadata's own instructions create and fund the market in one transaction.
    let create = crate::common::create_market_instruction(
        &env.admin.pubkey(),
        &cx.market_state,
        init_data,
        init_accounts,
    );
    env.svm.airdrop(&lp.pubkey(), SOL).unwrap();
    for (i, mint) in market.mints.iter().enumerate() {
        write_token_account(&mut env.svm, mint, &TOKEN, &lp.pubkey(), amounts[i]).unwrap();
    }
    let mut instructions = vec![create];
    instructions.extend(env.fee_account_instructions(&cx.market_state, spec.mints));
    instructions.push(add);
    env.send(&instructions, &[&lp]).unwrap();
    assert_eq!(env.market_state(&cx.market_state).reserves, amounts);
}

#[test]
fn rebalance_built_from_the_metadata_is_the_programs_and_works() {
    let m = metadata();
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let (market, _) = env.create_funded_market(&spec, [SOL, 2 * SOL]).unwrap();
    let k = &env.kamino;
    let keeper = solana_keypair::Keypair::new();
    // The inputs a keeper, or Aviary's form, fills in for the market's lent mint.
    let cx = Context {
        wallet: keeper.pubkey(),
        market_state: market.market_state,
        inputs: HashMap::from([
            ("lent_mint".to_string(), (wsol(), TOKEN)),
            ("reserve".to_string(), (k.address("reserve-sol"), TOKEN)),
            (
                "lending_market".to_string(),
                (k.address("lending-market"), TOKEN),
            ),
            (
                "reserve_liquidity_supply".to_string(),
                (k.address("liquidity-supply-sol"), TOKEN),
            ),
            (
                "collateral_mint".to_string(),
                (k.address("collateral-mint-sol"), TOKEN),
            ),
        ]),
        args: HashMap::new(),
        market: Some(market.clone()),
    };
    let action = &m["actions"][1];
    assert_eq!(action["name"], "rebalance");
    assert!(action["args"].as_array().unwrap().is_empty());
    let rebalance = Instruction::new_with_bytes(
        strategy_id(),
        &anchor_discriminator("rebalance"),
        metas(&action["accounts"], &cx),
    );
    assert_eq!(
        rebalance,
        env.rebalance_instruction(&market, &keeper.pubkey())
    );
    // And it lends the surplus.
    env.load_klend();
    env.svm.airdrop(&keeper.pubkey(), SOL).unwrap();
    env.send(&[rebalance], &[&keeper]).unwrap();
    assert!(env.market_state(&market.market_state).ctokens > 0);
}

/// The action named `name`.
fn action<'a>(m: &'a Value, name: &str) -> &'a Value {
    m["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == name)
        .unwrap_or_else(|| panic!("no action {name}"))
}

/// An action's instruction data, as the SDK builds it: its discriminator, given or Anchor's from
/// its name, then its arguments in order.
fn action_data(action: &Value, values: &HashMap<&str, u64>) -> Vec<u8> {
    let mut data = match action["discriminator"].as_str() {
        Some(hex) => (0..8)
            .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
            .collect(),
        None => anchor_discriminator(action["name"].as_str().unwrap()).to_vec(),
    };
    let args = encoded_args(&action["args"], values);
    for arg in action["args"].as_array().unwrap() {
        data.extend(&args[arg["name"].as_str().unwrap()]);
    }
    data
}

#[test]
fn removals_and_lock_lp_built_from_the_metadata_are_the_programs_and_work() {
    use common::rebalance::{lent_spec, units, OTHER};
    use common::remove::Payout;
    let m = metadata();
    for lent in 0..lending_amm::config::LENT_MINTS.len() {
        let name = common::kamino::lent_name(lent);
        let mut env = Env::new();
        env.load_klend();
        let spec = lent_spec(&mut env, lent, 30);
        let (market, lp) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        env.rebalance(&market, None).unwrap();
        let k = &env.kamino;
        // The inputs Aviary's forms fill in for the market's lent mint.
        let cx = Context {
            wallet: lp.pubkey(),
            market_state: market.market_state,
            inputs: HashMap::from([
                (
                    "reserve".to_string(),
                    (k.address(&format!("reserve-{name}")), TOKEN),
                ),
                (
                    "lending_market".to_string(),
                    (k.address("lending-market"), TOKEN),
                ),
                (
                    "reserve_liquidity_supply".to_string(),
                    (k.address(&format!("liquidity-supply-{name}")), TOKEN),
                ),
                (
                    "collateral_mint".to_string(),
                    (k.address(&format!("collateral-mint-{name}")), TOKEN),
                ),
                (
                    "lock_account".to_string(),
                    (env.lock_account(&market), TOKEN),
                ),
            ]),
            args: HashMap::new(),
            market: Some(market.clone()),
        };
        let shares = env.lp_shares_of(&market, &lp.pubkey()) / 4;
        for (form, payout, in_kind) in [
            ("remove_liquidity", Payout::Cash, 0),
            ("remove_liquidity_in_kind", Payout::InKind, 1),
        ] {
            let action = action(&m, form);
            let values = HashMap::from([
                ("lp", shares),
                ("min_other", 1),
                ("min_lent", 2),
                ("in_kind", in_kind),
            ]);
            let built = Instruction::new_with_bytes(
                strategy_id(),
                &action_data(action, &values),
                metas(&action["accounts"], &cx),
            );
            let mut min = [0u64; 2];
            min[market.other_index()] = 1;
            min[market.lent_index] = 2;
            assert_eq!(
                built,
                env.remove_liquidity_instruction(&market, &lp.pubkey(), shares, min, payout),
                "{form} on {name}"
            );
            env.send(&[built], &[&lp]).unwrap();
        }
        assert!(env.balance(&env.lp_ctoken_account(&market, &lp.pubkey())) > 0);

        let action = action(&m, "lock_lp");
        let values = HashMap::from([("amount", shares)]);
        let built = Instruction::new_with_bytes(
            strategy_id(),
            &action_data(action, &values),
            metas(&action["accounts"], &cx),
        );
        assert_eq!(
            built,
            env.lock_lp_instruction(&market, &lp.pubkey(), shares)
        );
        env.send(&[built], &[&lp]).unwrap();
        assert_eq!(env.balance(&env.lock_account(&market)), shares);
    }
}
