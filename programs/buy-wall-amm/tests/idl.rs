//! The committed Anchor IDL (`idl/buy_wall_amm.json`, built by `scripts/build-idl.sh`)
//! against the program, its metadata and the spec's byte offset table, so none drifts from
//! the others: the metadata links the IDL and the TypeScript client is generated from it
//! (docs/agents/build-tickets.md, "A change to a program's instructions, accounts or
//! arguments changes its strategy metadata, its generated client and its demo script in the
//! same PR").

mod common;

use anchor_lang::Discriminator;
use buy_wall_amm::events::{MarketCreated, MarketSeeded};
use buy_wall_amm::state::MarketState;
use common::*;
use pipeline_client::interface::discriminator;
use serde_json::Value;

const SPEC: &str = include_str!("../../../docs/spec/pool4-for-solana.md");

fn read_json(file: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn idl() -> Value {
    read_json("idl/buy_wall_amm.json")
}

fn bytes(value: &Value) -> Vec<u8> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

fn named<'a>(list: &'a Value, name: &str) -> &'a Value {
    list.as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == name)
        .unwrap_or_else(|| panic!("the IDL has no {name}"))
}

fn names(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap().to_string())
        .collect()
}

/// The size of a field type of the zero-copy market state.
fn size_of(ty: &Value) -> usize {
    match ty {
        Value::String(name) => match name.as_str() {
            "u8" => 1,
            "pubkey" => 32,
            other => panic!("unexpected type {other}: every integer is a byte array"),
        },
        Value::Object(map) if map.contains_key("array") => {
            let array = map["array"].as_array().unwrap();
            size_of(&array[0]) * array[1].as_u64().unwrap() as usize
        }
        other => panic!("unexpected type {other}"),
    }
}

/// The spec's byte offset table: (field, offset).
fn spec_offsets() -> Vec<(String, usize)> {
    let section = SPEC.split("### Byte offsets").nth(1).unwrap();
    let section = section.split("\n#").next().unwrap();
    section
        .lines()
        .filter(|line| line.starts_with("| `"))
        .map(|line| {
            let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
            (
                cells[0].trim_matches('`').to_string(),
                cells[1].parse().unwrap(),
            )
        })
        .collect()
}

#[test]
fn the_idl_is_this_programs() {
    assert_eq!(idl()["address"], strategy_id().to_string());
}

#[test]
fn its_instructions_are_pipelines_and_the_seed_with_their_discriminators() {
    let idl = idl();
    let expected = [
        ("pipeline_init_market", discriminator::INIT_MARKET),
        ("pipeline_market_info", discriminator::MARKET_INFO),
        ("pipeline_quote", discriminator::QUOTE),
        ("pipeline_resolve_accounts", discriminator::RESOLVE_ACCOUNTS),
        ("pipeline_swap", discriminator::SWAP),
        ("seed", pipeline_client::instruction_discriminator("seed")),
    ];
    assert_eq!(
        idl["instructions"].as_array().unwrap().len(),
        expected.len()
    );
    for (name, discriminator) in expected {
        let instruction = named(&idl["instructions"], name);
        assert_eq!(
            bytes(&instruction["discriminator"]),
            discriminator,
            "{name}"
        );
    }
}

#[test]
fn its_init_and_seed_accounts_and_arguments_are_the_metadatas() {
    let idl = idl();
    let metadata = read_json("metadata.json");

    // `pipeline_init_market`: the router's four fixed accounts, then the metadata's.
    let init = named(&idl["instructions"], "pipeline_init_market");
    let accounts = names(&init["accounts"]);
    assert_eq!(
        accounts[..4],
        ["market_signer", "market_state", "payer", "system_program"]
    );
    assert_eq!(accounts[4..], names(&metadata["init"]["accounts"])[..]);
    // Its `data` is the Borsh encoding of `InitParams`, whose fields are the metadata's
    // `init.args`, in order.
    let params = named(&idl["types"], "InitParams");
    assert_eq!(
        names(&params["type"]["fields"]),
        names(&metadata["init"]["args"])
    );

    // `seed`: the metadata's accounts and arguments, in order.
    let seed = named(&idl["instructions"], "seed");
    let action = named(&metadata["actions"], "seed");
    assert_eq!(names(&seed["accounts"]), names(&action["accounts"]));
    assert_eq!(names(&seed["args"]), names(&action["args"]));
}

#[test]
fn its_market_state_has_the_fixed_discriminator_and_the_specs_offsets() {
    let idl = idl();
    let account = named(&idl["accounts"], "MarketState");
    assert_eq!(bytes(&account["discriminator"]), MarketState::DISCRIMINATOR);
    assert_eq!(bytes(&account["discriminator"]), b"BWMARKET");
    let ty = named(&idl["types"], "MarketState");
    assert_eq!(ty["serialization"], "bytemuck");

    // Walk the IDL's fields from after the discriminator, naming them as the spec does.
    let mut offset = MarketState::DISCRIMINATOR.len();
    let mut idl_offsets = vec![("discriminator".to_string(), 0)];
    for field in ty["type"]["fields"].as_array().unwrap() {
        let name = field["name"].as_str().unwrap();
        let size = size_of(&field["type"]);
        match name {
            "volume" => {
                idl_offsets.push(("volume[0]".into(), offset));
                idl_offsets.push(("volume[1]".into(), offset + size / 2));
            }
            "reference" => idl_offsets.push(("ref".into(), offset)),
            _ => idl_offsets.push((name.to_string(), offset)),
        }
        offset += size;
    }
    assert_eq!(offset, buy_wall_amm::config::MARKET_STATE_SIZE);
    assert_eq!(idl_offsets, spec_offsets());
}

#[test]
fn its_events_and_errors_are_the_programs() {
    let idl = idl();
    let created = named(&idl["events"], "MarketCreated");
    assert_eq!(
        bytes(&created["discriminator"]),
        MarketCreated::DISCRIMINATOR
    );
    let seeded = named(&idl["events"], "MarketSeeded");
    assert_eq!(bytes(&seeded["discriminator"]), MarketSeeded::DISCRIMINATOR);

    // Errors are numbered from 6000 in the enum's order, the last being `Overflow`.
    let errors = idl["errors"].as_array().unwrap();
    for (i, error) in errors.iter().enumerate() {
        assert_eq!(error["code"].as_u64().unwrap(), 6_000 + i as u64);
    }
    let last = errors.last().unwrap();
    assert_eq!(last["name"], "Overflow");
    let overflow: u32 = buy_wall_amm::errors::StrategyError::Overflow.into();
    assert_eq!(last["code"].as_u64().unwrap() as u32, overflow);
}
