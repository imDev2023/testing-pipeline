//! The committed Anchor IDL (`idl/lending_amm.json`, built by `scripts/build-idl.sh`)
//! against the program and its metadata, so neither drifts from the other: the metadata
//! links the IDL and the TypeScript client is generated from it (docs/agents/build-tickets.md,
//! "A change to a program's instructions, accounts or arguments changes its strategy
//! metadata, its generated client and its demo script in the same PR").

mod common;

use anchor_lang::Discriminator;
use common::*;
use lending_amm::events::{
    LiquidityAdded, LiquidityRemoved, MarketCreated, MarketSeeded, Rebalanced, SharesLocked,
    ShortfallRedeemed, WithdrawModeEntered, WithdrawModeLeft,
};
use lending_amm::state::layout;
use lending_amm::LendingAmmMarket;
use pipeline_client::interface::discriminator;
use serde_json::Value;

fn read_json(file: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn idl() -> Value {
    read_json("idl/lending_amm.json")
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

fn instruction<'a>(idl: &'a Value, name: &str) -> &'a Value {
    idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == name)
        .unwrap_or_else(|| panic!("the IDL has no instruction {name}"))
}

fn names(list: &Value, key: &str) -> Vec<String> {
    list[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap().to_string())
        .collect()
}

/// The Borsh size of an IDL type, for the fixed-size types a market state holds.
fn size_of(ty: &Value) -> usize {
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
            size_of(&array[0]) * array[1].as_u64().unwrap() as usize
        }
        other => panic!("unexpected type {other}"),
    }
}

#[test]
fn the_idl_is_this_programs() {
    assert_eq!(idl()["address"], strategy_id().to_string());
}

#[test]
fn its_instructions_are_pipelines_and_the_custom_actions() {
    let idl = idl();
    let expected = [
        ("pipeline_init_market", discriminator::INIT_MARKET),
        ("pipeline_market_info", discriminator::MARKET_INFO),
        ("pipeline_quote", discriminator::QUOTE),
        ("pipeline_resolve_accounts", discriminator::RESOLVE_ACCOUNTS),
        ("pipeline_swap", discriminator::SWAP),
        ("pipeline_seed_liquidity", discriminator::SEED_LIQUIDITY),
        ("add_liquidity", anchor_discriminator("add_liquidity")),
        ("rebalance", anchor_discriminator("rebalance")),
        ("remove_liquidity", anchor_discriminator("remove_liquidity")),
        ("lock_lp", anchor_discriminator("lock_lp")),
    ];
    assert_eq!(
        idl["instructions"].as_array().unwrap().len(),
        expected.len()
    );
    for (name, discriminator) in expected {
        assert_eq!(
            bytes(&instruction(&idl, name)["discriminator"]),
            discriminator,
            "{name}"
        );
    }
}

#[test]
fn its_init_accounts_and_arguments_are_the_metadatas() {
    let idl = idl();
    let metadata = read_json("metadata.json");
    let init = names(instruction(&idl, "pipeline_init_market"), "accounts");
    // The router's four fixed accounts, then the metadata's, in order.
    assert_eq!(
        init[..4],
        ["market_signer", "market_state", "payer", "system_program"]
    );
    assert_eq!(init[4..], names(&metadata["init"], "accounts")[..]);
    assert_eq!(
        names(&idl_type(&idl, "InitParams")["type"], "fields"),
        names(&metadata["init"], "args")
    );
}

#[test]
fn every_actions_accounts_and_arguments_are_the_metadatas() {
    let idl = idl();
    let metadata = read_json("metadata.json");
    for action in metadata["actions"].as_array().unwrap() {
        // An action with its own discriminator builds the instruction that has it: the in-kind
        // removal form builds `remove_liquidity`.
        let name = match action["discriminator"].as_str() {
            Some(hex) => idl["instructions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|ix| {
                    bytes(&ix["discriminator"])
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                        == hex
                })
                .and_then(|ix| ix["name"].as_str())
                .expect("an instruction with the action's discriminator"),
            None => action["name"].as_str().unwrap(),
        };
        let ix = instruction(&idl, name);
        assert_eq!(names(ix, "accounts"), names(action, "accounts"), "{name}");
        assert_eq!(names(ix, "args"), names(action, "args"), "{name}");
        for account in ix["accounts"].as_array().unwrap() {
            let listed = action["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["name"] == account["name"])
                .unwrap();
            // An optional account a form leaves out is the program's own id, Anchor's way.
            if account["optional"].as_bool().unwrap_or(false)
                && listed["source"] == "strategy_program"
            {
                assert!(!listed["writable"].as_bool().unwrap_or(false));
                continue;
            }
            for flag in ["writable", "signer"] {
                assert_eq!(
                    account[flag].as_bool().unwrap_or(false),
                    listed[flag].as_bool().unwrap_or(false),
                    "{name}.{} {flag}",
                    account["name"]
                );
            }
        }
    }
}

#[test]
fn its_market_state_has_the_programs_discriminator_and_layout() {
    let idl = idl();
    let account = &idl["accounts"][0];
    assert_eq!(account["name"], "LendingAmmMarket");
    assert_eq!(
        bytes(&account["discriminator"]),
        LendingAmmMarket::DISCRIMINATOR
    );
    let mut offset = LendingAmmMarket::DISCRIMINATOR.len();
    let mut offsets = std::collections::HashMap::new();
    for field in idl_type(&idl, "LendingAmmMarket")["type"]["fields"]
        .as_array()
        .unwrap()
    {
        offsets.insert(field["name"].as_str().unwrap().to_string(), offset);
        offset += size_of(&field["type"]);
    }
    assert_eq!(offsets["version"], layout::VERSION);
    assert_eq!(offsets["lent_index"], layout::LENT_INDEX);
    assert_eq!(offsets["lp_fee_bps"], layout::LP_FEE_BPS);
    assert_eq!(offsets["withdraw_mode"], layout::WITHDRAW_MODE);
    assert_eq!(offsets["mints"], layout::MINTS);
    assert_eq!(offsets["reserves"], layout::RESERVES);
    assert_eq!(offsets["ctokens"], layout::CTOKENS);
    assert_eq!(offsets["deposited"], layout::DEPOSITED);
    assert_eq!(offsets["redeemed"], layout::REDEEMED);
    assert_eq!(offsets["reserved"], layout::RESERVED);
    assert_eq!(offset, layout::LEN);
}

#[test]
fn its_events_and_errors_are_the_programs() {
    let idl = idl();
    let events: Vec<(String, Vec<u8>)> = idl["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["name"].as_str().unwrap().to_string(),
                bytes(&e["discriminator"]),
            )
        })
        .collect();
    assert!(events.contains(&(
        "MarketCreated".into(),
        MarketCreated::DISCRIMINATOR.to_vec()
    )));
    assert!(events.contains(&(
        "LiquidityAdded".into(),
        LiquidityAdded::DISCRIMINATOR.to_vec()
    )));
    assert!(events.contains(&("Rebalanced".into(), Rebalanced::DISCRIMINATOR.to_vec())));
    assert!(events.contains(&(
        "ShortfallRedeemed".into(),
        ShortfallRedeemed::DISCRIMINATOR.to_vec()
    )));
    assert!(events.contains(&(
        "LiquidityRemoved".into(),
        LiquidityRemoved::DISCRIMINATOR.to_vec()
    )));
    assert!(events.contains(&("SharesLocked".into(), SharesLocked::DISCRIMINATOR.to_vec())));
    assert!(events.contains(&(
        "WithdrawModeEntered".into(),
        WithdrawModeEntered::DISCRIMINATOR.to_vec()
    )));
    assert!(events.contains(&(
        "WithdrawModeLeft".into(),
        WithdrawModeLeft::DISCRIMINATOR.to_vec()
    )));
    assert!(events.contains(&("MarketSeeded".into(), MarketSeeded::DISCRIMINATOR.to_vec())));
    assert_eq!(events.len(), 9);

    // Errors are numbered from 6000 in the enum's order, new ones only ever appended.
    let errors = idl["errors"].as_array().unwrap();
    for (i, error) in errors.iter().enumerate() {
        assert_eq!(error["code"].as_u64().unwrap(), 6_000 + i as u64);
    }
    for (name, error) in [
        ("BadInitData", lending_amm::StrategyError::BadInitData),
        ("Overflow", lending_amm::StrategyError::Overflow),
        ("EmptySide", lending_amm::StrategyError::EmptySide),
        (
            "ReserveWrongAddress",
            lending_amm::StrategyError::ReserveWrongAddress,
        ),
        (
            "ReserveWrongCollateralMint",
            lending_amm::StrategyError::ReserveWrongCollateralMint,
        ),
        (
            "LendingMarketWrongAccount",
            lending_amm::StrategyError::LendingMarketWrongAccount,
        ),
        ("WithinBand", lending_amm::StrategyError::WithinBand),
        (
            "BelowMinRebalance",
            lending_amm::StrategyError::BelowMinRebalance,
        ),
        (
            "KaminoAccountWrong",
            lending_amm::StrategyError::KaminoAccountWrong,
        ),
        (
            "RedeemAccountsMissing",
            lending_amm::StrategyError::RedeemAccountsMissing,
        ),
        (
            "RedeemPaidShort",
            lending_amm::StrategyError::RedeemPaidShort,
        ),
        ("ZeroRemoval", lending_amm::StrategyError::ZeroRemoval),
        (
            "NotEnoughShares",
            lending_amm::StrategyError::NotEnoughShares,
        ),
        ("BelowMinOther", lending_amm::StrategyError::BelowMinOther),
        ("BelowMinLent", lending_amm::StrategyError::BelowMinLent),
        (
            "KaminoAccountsMissing",
            lending_amm::StrategyError::KaminoAccountsMissing,
        ),
        (
            "KaminoCannotPay",
            lending_amm::StrategyError::KaminoCannotPay,
        ),
        ("ZeroLock", lending_amm::StrategyError::ZeroLock),
        ("KaminoStopped", lending_amm::StrategyError::KaminoStopped),
        (
            "KaminoDepositsBlocked",
            lending_amm::StrategyError::KaminoDepositsBlocked,
        ),
        (
            "ReserveDeprecated",
            lending_amm::StrategyError::ReserveDeprecated,
        ),
        (
            "RebalanceNotAlone",
            lending_amm::StrategyError::RebalanceNotAlone,
        ),
        ("BadSeedAmounts", lending_amm::StrategyError::BadSeedAmounts),
    ] {
        let listed = errors.iter().find(|e| e["name"] == name).unwrap();
        assert_eq!(
            listed["code"].as_u64().unwrap() as u32,
            anchor_lang::error::ERROR_CODE_OFFSET + error as u32,
            "{name}"
        );
    }
    assert_eq!(errors.last().unwrap()["name"], "BadSeedAmounts");
}
