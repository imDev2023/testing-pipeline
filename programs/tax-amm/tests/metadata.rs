//! `metadata.json` against the program (docs/spec/tax-amm.md, "Custom actions and
//! metadata"; docs/spec/README.md, "Metadata, IDL and conformance report"): it passes
//! `pipeline-client`'s validator with zero warnings, and its `init` form encodes exactly the
//! program's creation parameters and lists exactly the accounts the program takes.

mod common;

use std::collections::HashMap;

use common::*;
use pipeline_client::metadata::{
    parse_account_source, parse_strategy_metadata, AccountSource, PdaSeed,
};
use pipeline_client::Pubkey;
use serde_json::Value;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::config::MAX_RECIPIENTS;

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
fn the_metadata_describes_a_tax_amm() {
    let m = metadata();
    assert_eq!(m["name"], "Aviary Tax AMM");
    assert_eq!(m["category"], "amm");
    assert!(m["tags"].as_array().unwrap().contains(&Value::from("tax")));
    assert!(m["links"]["source"]
        .as_str()
        .unwrap()
        .ends_with("/programs/tax-amm"));
    assert!(m["links"]["idl"]
        .as_str()
        .unwrap()
        .ends_with("/programs/tax-amm/idl/tax_amm.json"));
    assert_eq!(
        m["security"]["contact"],
        "https://github.com/imDev2023/testing-pipeline/security/advisories/new"
    );
    // The template's deposit action is gone: a tax market's liquidity is seeded once.
    let actions: Vec<&str> = m["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(actions, ["seed"]);
    assert_eq!(m["init"]["market_state"], "new_keypair");
    assert_eq!(m["init"]["idl_type"], "InitParams");
}

/// Encodes `value` as metadata `type` says Borsh encodes it.
fn encode_arg(kind: &str, value: &Value) -> Vec<u8> {
    match kind {
        "u8" => vec![value.as_u64().unwrap() as u8],
        "u16" => (value.as_u64().unwrap() as u16).to_le_bytes().to_vec(),
        "u64" => value.as_u64().unwrap().to_le_bytes().to_vec(),
        "pubkey" => value
            .as_str()
            .unwrap()
            .parse::<Pubkey>()
            .unwrap()
            .to_bytes()
            .to_vec(),
        other => panic!("no argument has type {other}"),
    }
}

#[test]
fn the_init_args_encode_exactly_the_programs_creation_parameters() {
    // Every field different, so a swapped pair of arguments would show.
    let mut params = valid_params(&Pubkey::new_unique());
    params.recipients[2] = ak(&Pubkey::new_unique());
    params.recipients[3] = ak(&Pubkey::new_unique());
    params.shares = [4_000, 3_000, 1_500, 500];
    params.burn_share_bps = 1_000;
    params.virtual_reserve = 123_456_789;
    params.virtual_side = 1;
    let key = |k: &anchor_lang::prelude::Pubkey| Value::from(ck(k).to_string());
    let mut values: HashMap<String, Value> = HashMap::from([
        ("tax_side".into(), params.tax_side.into()),
        ("buy_tax_bps".into(), params.buy_tax_bps.into()),
        ("sell_tax_bps".into(), params.sell_tax_bps.into()),
        ("buy_tax_min_bps".into(), params.buy_tax_min_bps.into()),
        ("buy_tax_max_bps".into(), params.buy_tax_max_bps.into()),
        ("sell_tax_min_bps".into(), params.sell_tax_min_bps.into()),
        ("sell_tax_max_bps".into(), params.sell_tax_max_bps.into()),
        ("tax_authority".into(), key(&params.tax_authority)),
        ("seeder".into(), key(&params.seeder)),
        ("burn_share_bps".into(), params.burn_share_bps.into()),
        ("virtual_side".into(), params.virtual_side.into()),
        ("virtual_reserve".into(), params.virtual_reserve.into()),
    ]);
    for i in 0..MAX_RECIPIENTS {
        values.insert(format!("recipient_{i}"), key(&params.recipients[i]));
        values.insert(format!("share_{i}"), params.shares[i].into());
    }

    let args = metadata()["init"]["args"].as_array().unwrap().clone();
    assert_eq!(
        args.len(),
        values.len(),
        "one argument per creation parameter"
    );
    let encoded: Vec<u8> = args
        .iter()
        .flat_map(|arg| {
            let name = arg["name"].as_str().unwrap();
            let value = values
                .get(name)
                .unwrap_or_else(|| panic!("unknown argument {name}"));
            encode_arg(arg["type"].as_str().unwrap(), value)
        })
        .collect();
    assert_eq!(encoded, init_data(&params));
}

/// Resolves an `init` account source as the SDK does before the market exists.
fn resolve(
    source: &AccountSource,
    state: &Pubkey,
    inputs: &HashMap<&str, (Pubkey, Pubkey)>,
) -> Pubkey {
    match source {
        AccountSource::MarketState => *state,
        AccountSource::Input(name) => inputs[name.as_str()].0,
        AccountSource::TokenProgramOf(mint) => match mint.as_ref() {
            AccountSource::Input(name) => inputs[name.as_str()].1,
            other => panic!("unexpected mint source {other:?}"),
        },
        AccountSource::Pda { program, seeds } => {
            assert!(
                program.is_none(),
                "the tax AMM's PDAs are its own (`strategy`)"
            );
            let bytes: Vec<Vec<u8>> = seeds
                .iter()
                .map(|seed| match seed {
                    PdaSeed::Str(text) => text.as_bytes().to_vec(),
                    PdaSeed::Key(source) => resolve(source, state, inputs).to_bytes().to_vec(),
                    other => panic!("unexpected seed {other:?}"),
                })
                .collect();
            let refs: Vec<&[u8]> = bytes.iter().map(Vec::as_slice).collect();
            Pubkey::find_program_address(&refs, &strategy_id()).0
        }
        other => panic!("unexpected init source {other:?}"),
    }
}

#[test]
fn the_init_accounts_are_exactly_the_accounts_the_program_takes() {
    let state = Keypair::new().pubkey();
    let mints = [Pubkey::new_unique(), Pubkey::new_unique()];
    let token_programs = [TOKEN, TOKEN_2022];
    let inputs = HashMap::from([
        ("mint_0", (mints[0], token_programs[0])),
        ("mint_1", (mints[1], token_programs[1])),
    ]);
    let expected = init_accounts(&state, mints, token_programs);
    let accounts = metadata()["init"]["accounts"].as_array().unwrap().clone();
    assert_eq!(accounts.len(), expected.len());
    for (account, meta) in accounts.iter().zip(&expected) {
        let source = parse_account_source(account["source"].as_str().unwrap()).unwrap();
        let name = account["name"].as_str().unwrap();
        assert_eq!(resolve(&source, &state, &inputs), meta.pubkey, "{name}");
        assert_eq!(
            account["writable"].as_bool().unwrap_or(false),
            meta.is_writable,
            "{name}"
        );
        assert!(!account["signer"].as_bool().unwrap_or(false), "{name}");
    }
}

fn action(name: &str) -> Value {
    metadata()["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == name)
        .unwrap_or_else(|| panic!("no action {name}"))
        .clone()
}

/// Resolves an action's account source against a market, as the SDK does.
fn resolve_action(source: &AccountSource, market: &Market, wallet: &Pubkey) -> Pubkey {
    match source {
        AccountSource::Wallet => *wallet,
        AccountSource::MarketState => market.market_state,
        AccountSource::Mint(i) => market.mints[*i as usize],
        AccountSource::Vault(i) => market.vaults[*i as usize],
        AccountSource::TokenProgram(i) => market.token_programs[*i as usize],
        AccountSource::WalletTokenAccount(i) => {
            let i = *i as usize;
            pipeline_client::pda::associated_token(
                wallet,
                &market.mints[i],
                &market.token_programs[i],
            )
        }
        other => panic!("unexpected action source {other:?}"),
    }
}

#[test]
fn the_seed_action_is_exactly_the_programs_seed() {
    let seed = action("seed");
    assert_eq!(seed["kind"], "add_liquidity");
    // Anchor's default discriminator, so the metadata needs none of its own.
    assert!(seed.get("discriminator").is_none());

    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
    ];
    let seeder = Keypair::new().pubkey();
    let market = env
        .create_tax_market(mints, &valid_params(&seeder))
        .unwrap();
    let amounts = [123_456_789, 987_654_321];
    let expected = seed_instruction(&market, &seeder, amounts, vec![]);

    // The arguments encode, after the discriminator, exactly the instruction's data.
    let values = [Value::from(amounts[0]), Value::from(amounts[1])];
    let args = seed["args"].as_array().unwrap();
    assert_eq!(args.len(), values.len());
    let mut data = expected.data[..8].to_vec();
    for (arg, value) in args.iter().zip(&values) {
        data.extend(encode_arg(arg["type"].as_str().unwrap(), value));
    }
    assert_eq!(data, expected.data);
    assert_eq!(args[0]["decimals_of"], "mint:0");
    assert_eq!(args[1]["decimals_of"], "mint:1");

    // The accounts resolve to exactly the program's, signer and writable alike.
    let accounts = seed["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), expected.accounts.len());
    for (account, meta) in accounts.iter().zip(&expected.accounts) {
        let name = account["name"].as_str().unwrap();
        let source = parse_account_source(account["source"].as_str().unwrap()).unwrap();
        assert_eq!(
            resolve_action(&source, &market, &seeder),
            meta.pubkey,
            "{name}"
        );
        assert_eq!(
            account["signer"].as_bool().unwrap_or(false),
            meta.is_signer,
            "{name}"
        );
        assert_eq!(
            account["writable"].as_bool().unwrap_or(false),
            meta.is_writable,
            "{name}"
        );
    }
}
