//! The committed Anchor IDL (`idl/containment_hook.json`, built by `scripts/build-idl.sh`)
//! against the program, so neither drifts from the other: the TypeScript client is generated
//! from it (docs/agents/build-tickets.md). It also shows the program has no instruction that
//! changes a config (docs/spec/containment-hook.md, "Binding").

mod support;

use anchor_lang::{Discriminator, InstructionData};
use containment_hook::state::EXECUTE_DISCRIMINATOR;
use containment_hook::{Config, HookError};
use serde_json::Value;
use support::*;

fn idl() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("idl/containment_hook.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn bytes(value: &Value) -> Vec<u8> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

fn instruction<'a>(idl: &'a Value, name: &str) -> &'a Value {
    idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == name)
        .unwrap_or_else(|| panic!("the IDL has no instruction {name}"))
}

#[test]
fn the_idl_is_this_programs() {
    assert_eq!(idl()["address"], hook_id().to_string());
}

#[test]
fn its_instructions_are_bind_the_interfaces_execute_and_unlock() {
    let idl = idl();
    let names: Vec<&str> = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["bind", "execute", "unlock"]);
    let bind_data = containment_hook::instruction::Bind {
        unlock_goal: 0,
        unlock_deadline: 0,
    }
    .data();
    assert_eq!(
        bytes(&instruction(&idl, "bind")["discriminator"]),
        bind_data[..8]
    );
    assert_eq!(
        bytes(&instruction(&idl, "execute")["discriminator"]),
        EXECUTE_DISCRIMINATOR
    );
    let args: Vec<&str> = instruction(&idl, "bind")["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(args, ["unlock_goal", "unlock_deadline"]);

    let unlock = instruction(&idl, "unlock");
    assert_eq!(
        bytes(&unlock["discriminator"]),
        containment_hook::instruction::Unlock {}.data()[..8]
    );
    assert_eq!(unlock["args"].as_array().unwrap().len(), 0);
}

#[test]
fn unlock_is_permissionless() {
    // It takes no signer of its own: whoever sends it pays the transaction fee, nothing else.
    let idl = idl();
    let accounts: Vec<(&str, bool, bool)> = instruction(&idl, "unlock")["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                a["name"].as_str().unwrap(),
                a["writable"].as_bool().unwrap_or(false),
                a["signer"].as_bool().unwrap_or(false),
            )
        })
        .collect();
    assert_eq!(
        accounts,
        [
            ("mint", true, false),
            ("config", true, false),
            ("unlock", false, false),
            ("market_state", false, false),
            ("token_program", false, false),
        ]
    );
}

#[test]
fn only_bind_and_unlock_take_the_config_writable() {
    // `bind` creates the config, and fails if it exists; `execute` only reads it; `unlock`
    // only records its time in it, as `tests/unlock.rs` shows. Any other instruction that
    // took the config as writable would show here first.
    let idl = idl();
    for instruction in idl["instructions"].as_array().unwrap() {
        for account in instruction["accounts"].as_array().unwrap() {
            if account["name"] == "config" {
                let writable = account["writable"].as_bool().unwrap_or(false);
                let name = instruction["name"].as_str().unwrap();
                assert_eq!(
                    writable,
                    name == "bind" || name == "unlock",
                    "{name} takes the config {}",
                    if writable { "writable" } else { "read-only" }
                );
            }
        }
    }
    for name in ["bind", "unlock"] {
        let config = instruction(&idl, name)["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == "config")
            .unwrap();
        assert!(config["pda"].is_object(), "{name}'s config is its PDA");
    }
}

#[test]
fn it_publishes_the_longest_deadline_as_the_program_defines_it() {
    let idl = idl();
    let constants = idl["constants"].as_array().unwrap();
    assert_eq!(constants.len(), 1);
    assert_eq!(constants[0]["name"], "MAX_UNLOCK_DEADLINE_SECS");
    assert_eq!(constants[0]["type"], "i64");
    assert_eq!(
        constants[0]["value"],
        containment_hook::config::MAX_UNLOCK_DEADLINE_SECS.to_string()
    );
}

#[test]
fn its_config_and_errors_are_the_programs() {
    let idl = idl();
    let account = &idl["accounts"][0];
    assert_eq!(account["name"], "Config");
    assert_eq!(bytes(&account["discriminator"]), Config::DISCRIMINATOR);

    // Errors are numbered from 6000 in the enum's order, every one pinned by name, since
    // Aviary and integrators show them by number and new ones only ever go at the end
    // (hardening finding H077 of #74).
    let errors = idl["errors"].as_array().unwrap();
    let names: Vec<&str> = errors
        .iter()
        .map(|error| error["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "TransferRefused",
            "MintNotToken2022",
            "NotAMint",
            "MintExtensionNotAllowed",
            "FreezeAuthoritySet",
            "NotMintAuthority",
            "WrongHookProgram",
            "WrongHookAuthority",
            "ZeroGoal",
            "DeadlineNotInFuture",
            "DeadlineTooFar",
            "NotARouterMarket",
            "MarketNotAtItsAddress",
            "NotATaxMarket",
            "MarketDoesNotHoldMint",
            "WrongMarketState",
            "NotATaxMarketState",
            "TaxSideNotQuote",
            "NotTransferring",
            "WrongConfig",
            "WrongValidationAccount",
            "UnlockNotDue",
            "AlreadyUnlocked",
            "DestinationOwnerCanChange",
            "MarketAlreadyCollectedTax",
            "MintAuthorityIsMultisig",
            "QuoteMintNotTheMarkets",
            "QuoteMintHooked",
            "QuoteMintHasAuthority",
        ]
    );
    for (i, error) in errors.iter().enumerate() {
        assert_eq!(error["code"].as_u64().unwrap(), 6_000 + i as u64);
    }
    let last = errors.last().unwrap();
    assert_eq!(
        last["code"].as_u64().unwrap() as u32,
        anchor_lang::error::ERROR_CODE_OFFSET + HookError::QuoteMintHasAuthority as u32
    );
}
