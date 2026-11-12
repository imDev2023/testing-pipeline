//! The committed Anchor IDL (`idl/tax_amm.json`, built by `scripts/build-idl.sh`) against
//! the program and its metadata, so neither drifts from the other: the metadata links the
//! IDL and the TypeScript client is generated from it (docs/agents/build-tickets.md, "A
//! change to a program's instructions, accounts or arguments changes its strategy metadata,
//! its generated client and its demo script in the same PR").

mod common;

use anchor_lang::Discriminator;
use common::*;
use pipeline_client::interface::discriminator;
use serde_json::Value;
use tax_amm::events::{MarketCreated, Seeded};
use tax_amm::state::layout;
use tax_amm::TaxMarket;

fn read_json(file: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn idl() -> Value {
    read_json("idl/tax_amm.json")
}

fn bytes(value: &Value) -> Vec<u8> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

fn idl_type<'a>(idl: &'a Value, name: &str) -> &'a Value {
    idl["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .unwrap_or_else(|| panic!("the IDL has no type {name}"))
}

/// The Borsh size of an IDL type, for the fixed-size types a market state holds.
fn size_of(idl: &Value, ty: &Value) -> usize {
    match ty {
        Value::String(name) => match name.as_str() {
            "u8" | "bool" => 1,
            "u16" => 2,
            "u64" | "i64" => 8,
            "u128" => 16,
            "pubkey" => 32,
            other => panic!("unexpected type {other}"),
        },
        Value::Object(map) if map.contains_key("array") => {
            let array = map["array"].as_array().unwrap();
            size_of(idl, &array[0]) * array[1].as_u64().unwrap() as usize
        }
        Value::Object(map) if map.contains_key("defined") => {
            let defined = idl_type(idl, map["defined"]["name"].as_str().unwrap());
            assert_eq!(defined["type"]["kind"], "enum");
            let variants = defined["type"]["variants"].as_array().unwrap();
            assert!(
                variants.iter().all(|v| v.get("fields").is_none()),
                "a scalar enum"
            );
            1
        }
        other => panic!("unexpected type {other}"),
    }
}

#[test]
fn the_idl_is_this_programs() {
    assert_eq!(idl()["address"], strategy_id().to_string());
}

#[test]
fn its_instructions_are_pipelines_with_pipelines_discriminators_and_its_actions() {
    let idl = idl();
    let expected = [
        (
            "seed",
            tax_amm::instruction::Seed::DISCRIMINATOR
                .try_into()
                .unwrap(),
        ),
        ("pipeline_init_market", discriminator::INIT_MARKET),
        ("pipeline_market_info", discriminator::MARKET_INFO),
        ("pipeline_quote", discriminator::QUOTE),
        ("pipeline_resolve_accounts", discriminator::RESOLVE_ACCOUNTS),
        ("pipeline_swap", discriminator::SWAP),
    ];
    let instructions = idl["instructions"].as_array().unwrap();
    assert_eq!(instructions.len(), expected.len());
    for (name, discriminator) in expected {
        let instruction = instructions.iter().find(|i| i["name"] == name).unwrap();
        assert_eq!(
            bytes(&instruction["discriminator"]),
            discriminator,
            "{name}"
        );
    }
}

#[test]
fn its_init_accounts_are_the_metadatas() {
    let idl = idl();
    let init = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == "pipeline_init_market")
        .unwrap();
    let names: Vec<&str> = init["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    // The router's four fixed accounts, then the metadata's, in order.
    assert_eq!(
        names[..4],
        ["market_signer", "market_state", "payer", "system_program"]
    );
    let metadata = read_json("metadata.json");
    let listed: Vec<&str> = metadata["init"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(names[4..], listed[..]);
}

#[test]
fn its_creation_parameters_are_the_metadatas_init_args() {
    let idl = idl();
    let metadata = read_json("metadata.json");
    let args: Vec<String> = metadata["init"]["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap().to_string())
        .collect();
    // The IDL's arrays are the metadata's numbered arguments, flattened.
    let mut flattened = vec![];
    for field in idl_type(&idl, "InitParams")["type"]["fields"]
        .as_array()
        .unwrap()
    {
        let name = field["name"].as_str().unwrap();
        match field["type"].get("array") {
            Some(array) => {
                let singular = name.strip_suffix('s').unwrap();
                for i in 0..array[1].as_u64().unwrap() {
                    flattened.push(format!("{singular}_{i}"));
                }
            }
            None => flattened.push(name.to_string()),
        }
    }
    assert_eq!(flattened, args);
}

#[test]
fn its_market_state_has_the_programs_discriminator_and_layout() {
    let idl = idl();
    let account = &idl["accounts"][0];
    assert_eq!(account["name"], "TaxMarket");
    assert_eq!(bytes(&account["discriminator"]), TaxMarket::DISCRIMINATOR);

    let mut offset = TaxMarket::DISCRIMINATOR.len();
    let mut offsets = std::collections::HashMap::new();
    for field in idl_type(&idl, "TaxMarket")["type"]["fields"]
        .as_array()
        .unwrap()
    {
        offsets.insert(field["name"].as_str().unwrap().to_string(), offset);
        offset += size_of(&idl, &field["type"]);
    }
    assert_eq!(offsets["tax_side"], layout::TAX_SIDE);
    assert_eq!(offsets["tax_collected"], layout::TAX_COLLECTED);
    assert_eq!(offset, layout::LEN);
}

#[test]
fn it_publishes_the_tax_cap_and_the_suite_share_from_the_config_module() {
    let idl = idl();
    let constants: Vec<(&str, &str, String)> = idl["constants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["name"].as_str().unwrap(),
                c["type"].as_str().unwrap(),
                c["value"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        constants,
        [
            (
                "MAX_TAX_BPS",
                "u16",
                tax_amm::config::MAX_TAX_BPS.to_string()
            ),
            (
                "SUITE_SHARE_BPS",
                "u16",
                tax_amm::config::SUITE_SHARE_BPS.to_string()
            ),
        ]
    );
}

#[test]
fn its_events_and_errors_are_the_programs() {
    let idl = idl();
    let events: Vec<(&str, Vec<u8>)> = idl["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["name"].as_str().unwrap(), bytes(&e["discriminator"])))
        .collect();
    assert_eq!(
        events,
        [
            ("MarketCreated", MarketCreated::DISCRIMINATOR.to_vec()),
            ("Seeded", Seeded::DISCRIMINATOR.to_vec()),
        ]
    );

    // Errors are numbered from 6000 in the enum's order, the last being
    // `InsufficientLiquidity`.
    let errors = idl["errors"].as_array().unwrap();
    for (i, error) in errors.iter().enumerate() {
        assert_eq!(error["code"].as_u64().unwrap(), 6_000 + i as u64);
    }
    let last = errors.last().unwrap();
    assert_eq!(last["name"], "InsufficientLiquidity");
    assert_eq!(
        last["code"].as_u64().unwrap() as u32,
        anchor_lang::error::ERROR_CODE_OFFSET
            + tax_amm::StrategyError::InsufficientLiquidity as u32
    );
}
