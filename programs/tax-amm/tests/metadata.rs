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
    // The template's deposit action is gone: a tax market's liquidity is seeded once. The
    // tax authority's three actions follow.
    let actions: Vec<&str> = m["aviary_actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        actions,
        [
            "seed",
            "distribute",
            "burn",
            "set_taxes",
            "set_recipients",
            "renounce_tax_authority"
        ]
    );
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

#[test]
fn the_seed_liquidity_form_describes_exactly_what_the_program_takes() {
    // Pipeline's metadata standard has no field for pipeline_seed_liquidity, so the tax AMM
    // describes it in a `seed_liquidity` form shaped as `init` is (the validator allows
    // unknown keys), which the SDK's `resolveInit` resolves for a launcher.
    let m = metadata();
    let form = &m["seed_liquidity"];
    assert_eq!(form["idl_type"], "InitParams");
    // `data` is the creation parameters: init's arguments, word for word, in order, except
    // the seeder's description, which says it is ignored.
    let init_args = m["init"]["args"].as_array().unwrap();
    let form_args = form["args"].as_array().unwrap();
    assert_eq!(form_args.len(), init_args.len());
    for (ours, init) in form_args.iter().zip(init_args) {
        let (mut ours, mut init) = (ours.clone(), init.clone());
        if init["name"] == "seeder" {
            let description = ours["description"].as_str().unwrap();
            assert!(description.starts_with("Ignored"), "{description}");
            ours.as_object_mut().unwrap().remove("description");
            init.as_object_mut().unwrap().remove("description");
        }
        assert_eq!(ours, init);
    }

    // The market state is the seeded PDA of the seeder and the mints, and the accounts after
    // Pipeline's fixed ones and the three per mint are the program's own.
    let seeder = Pubkey::new_unique();
    let mints = [Pubkey::new_unique(), Pubkey::new_unique()];
    let token_programs = [TOKEN, TOKEN_2022];
    let inputs = HashMap::from([
        ("seeder", (seeder, Pubkey::default())),
        ("mint_0", (mints[0], token_programs[0])),
        ("mint_1", (mints[1], token_programs[1])),
    ]);
    let source = parse_account_source(form["market_state"].as_str().unwrap()).unwrap();
    let state = resolve(&source, &Pubkey::default(), &inputs);
    assert_eq!(
        state,
        common::launchpad::seeded_market_state(&seeder, mints)
    );
    let (authority, vaults) = tax_market_addresses(&state, mints);
    let expected = [(authority, false), (vaults[0], true), (vaults[1], true)];
    let accounts = form["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), expected.len());
    for (account, (key, writable)) in accounts.iter().zip(expected) {
        let name = account["name"].as_str().unwrap();
        let source = parse_account_source(account["source"].as_str().unwrap()).unwrap();
        assert_eq!(resolve(&source, &state, &inputs), key, "{name}");
        assert_eq!(
            account["writable"].as_bool().unwrap_or(false),
            writable,
            "{name}"
        );
        assert!(!account["signer"].as_bool().unwrap_or(false), "{name}");
    }
}

fn action(name: &str) -> Value {
    metadata()["aviary_actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == name)
        .unwrap_or_else(|| panic!("no action {name}"))
        .clone()
}

/// Resolves an action's account source against a market, as the SDK does.
fn resolve_action(source: &AccountSource, market: &Market, wallet: &Pubkey) -> Pubkey {
    resolve_action_with(source, market, wallet, &HashMap::new())
}

/// [`resolve_action`] with values for `input:` sources.
fn resolve_action_with(
    source: &AccountSource,
    market: &Market,
    wallet: &Pubkey,
    inputs: &HashMap<&str, Pubkey>,
) -> Pubkey {
    let token_program_of = |mint: &Pubkey| {
        let i = market
            .mints
            .iter()
            .position(|m| m == mint)
            .expect("a market mint");
        market.token_programs[i]
    };
    let nested = |source: &AccountSource| resolve_action_with(source, market, wallet, inputs);
    match source {
        AccountSource::Input(name) => inputs[name.as_str()],
        AccountSource::SystemProgram => pipeline_client::SYSTEM_PROGRAM_ID,
        AccountSource::AssociatedTokenProgram => pipeline_client::ASSOCIATED_TOKEN_PROGRAM_ID,
        AccountSource::TokenProgramOf(mint) => token_program_of(&nested(mint)),
        AccountSource::Ata { owner, mint } => {
            let mint = nested(mint);
            pipeline_client::pda::associated_token(&nested(owner), &mint, &token_program_of(&mint))
        }
        AccountSource::Pda { program, seeds } => {
            assert!(program.is_none(), "the tax AMM's PDAs are its own");
            let bytes: Vec<Vec<u8>> = seeds
                .iter()
                .map(|seed| match seed {
                    PdaSeed::Str(text) => text.as_bytes().to_vec(),
                    PdaSeed::Key(source) => nested(source).to_bytes().to_vec(),
                    other => panic!("unexpected seed {other:?}"),
                })
                .collect();
            let refs: Vec<&[u8]> = bytes.iter().map(Vec::as_slice).collect();
            Pubkey::find_program_address(&refs, &strategy_id()).0
        }
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

    let values = [Value::from(amounts[0]), Value::from(amounts[1])];
    assert_action_is(&seed, &values, &expected, &market, &seeder);
    let args = seed["args"].as_array().unwrap();
    assert_eq!(args[0]["decimals_of"], "mint:0");
    assert_eq!(args[1]["decimals_of"], "mint:1");
}

/// Checks a metadata action against the program's instruction `expected`, built for
/// `market` and `wallet`: `values` encode, in the action's argument order, exactly the
/// instruction's data after its discriminator, and the accounts resolve to exactly the
/// instruction's, signer and writable alike.
fn assert_action_is(
    action: &Value,
    values: &[Value],
    expected: &pipeline_client::Instruction,
    market: &Market,
    wallet: &Pubkey,
) {
    let name = action["name"].as_str().unwrap();
    // Anchor's default discriminator, so the metadata needs none of its own.
    assert!(action.get("discriminator").is_none(), "{name}");
    let args = action["args"].as_array().unwrap();
    assert_eq!(args.len(), values.len(), "{name}");
    let mut data = expected.data[..8].to_vec();
    for (arg, value) in args.iter().zip(values) {
        data.extend(encode_arg(arg["type"].as_str().unwrap(), value));
    }
    assert_eq!(data, expected.data, "{name}");
    let accounts = action["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), expected.accounts.len(), "{name}");
    for (account, meta) in accounts.iter().zip(&expected.accounts) {
        let account_name = account["name"].as_str().unwrap();
        let source = parse_account_source(account["source"].as_str().unwrap()).unwrap();
        assert_eq!(
            resolve_action(&source, market, wallet),
            meta.pubkey,
            "{name}.{account_name}"
        );
        assert_eq!(
            account["signer"].as_bool().unwrap_or(false),
            meta.is_signer,
            "{name}.{account_name}"
        );
        assert_eq!(
            account["writable"].as_bool().unwrap_or(false),
            meta.is_writable,
            "{name}.{account_name}"
        );
    }
}

#[test]
fn the_tax_authority_actions_are_exactly_the_programs() {
    use common::authority::*;
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
    ];
    let market = env
        .create_tax_market(mints, &valid_params(&Pubkey::new_unique()))
        .unwrap();
    let wallet = Pubkey::new_unique();
    for name in ["set_taxes", "set_recipients", "renounce_tax_authority"] {
        assert_eq!(action(name)["kind"], "other", "{name}");
    }

    let set_taxes = set_taxes_instruction(&market.market_state, &wallet, 123, 456);
    assert_action_is(
        &action("set_taxes"),
        &[Value::from(123), Value::from(456)],
        &set_taxes,
        &market,
        &wallet,
    );

    // Every field different, so a swapped pair of arguments would show.
    let split = Split {
        recipients: [(); MAX_RECIPIENTS].map(|_| Pubkey::new_unique()),
        shares: [4_000, 3_000, 1_500, 500],
        burn_share_bps: 1_000,
    };
    let set_recipients = set_recipients_instruction(&market.market_state, &wallet, &split);
    let mut values: Vec<Value> = split
        .recipients
        .iter()
        .map(|r| Value::from(r.to_string()))
        .collect();
    values.extend(split.shares.iter().map(|&s| Value::from(s)));
    values.push(Value::from(split.burn_share_bps));
    let recipients = action("set_recipients");
    let arg_names: Vec<&str> = recipients["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        arg_names,
        [
            "recipient_0",
            "recipient_1",
            "recipient_2",
            "recipient_3",
            "share_0",
            "share_1",
            "share_2",
            "share_3",
            "burn_share_bps"
        ]
    );
    assert_action_is(&recipients, &values, &set_recipients, &market, &wallet);

    let renounce = renounce_instruction(&market.market_state, &wallet);
    assert_action_is(
        &action("renounce_tax_authority"),
        &[],
        &renounce,
        &market,
        &wallet,
    );
}

#[test]
fn the_distribute_and_burn_actions_are_exactly_the_programs_distribute_for_every_slot() {
    use anchor_lang::Discriminator;
    use tax_amm::state::{BURN_SLOT, SUITE_SLOT};
    let distribute = action("distribute");
    let burn = action("burn");
    assert_eq!(distribute["kind"], "claim");
    assert_eq!(burn["kind"], "claim");
    // `distribute` uses Anchor's default discriminator; `burn` is the same instruction for
    // the burn slot, so it names that discriminator.
    assert!(distribute.get("discriminator").is_none());
    let hex: String = tax_amm::instruction::Distribute::DISCRIMINATOR
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(burn["discriminator"], hex);
    // The slot numbers the descriptions give are the program's.
    let slot_text = |a: &Value| a["args"][0]["description"].as_str().unwrap().to_string();
    assert!(slot_text(&distribute).contains(&format!("{SUITE_SLOT} the suite share")));
    assert!(slot_text(&burn).contains(&format!("Always {BURN_SLOT}, the burn slot")));

    // Taxed on side 1, a Token-2022 mint, so a wrong mint or token program would show.
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
    ];
    let market = env
        .create_tax_market(mints, &valid_params(&Keypair::new().pubkey()))
        .unwrap();
    let state = env.tax_market(&market.market_state);
    let caller = Keypair::new().pubkey();
    for slot in [0u8, 1, BURN_SLOT, SUITE_SLOT] {
        let action = if slot == BURN_SLOT {
            &burn
        } else {
            &distribute
        };
        let wallet = slot_wallet(&state, slot);
        let expected = distribute_instruction(&market, 1, &caller, slot, &wallet, vec![]);
        // What a terminal reads from the market state for the action's two inputs.
        let inputs = HashMap::from([("tax_mint", market.mints[1]), ("recipient", wallet)]);

        let args = action["args"].as_array().unwrap();
        assert_eq!(args.len(), 1);
        let mut data = expected.data[..8].to_vec();
        data.extend(encode_arg(
            args[0]["type"].as_str().unwrap(),
            &Value::from(slot),
        ));
        assert_eq!(data, expected.data, "slot {slot}");

        let accounts = action["accounts"].as_array().unwrap();
        assert_eq!(accounts.len(), expected.accounts.len());
        for (account, meta) in accounts.iter().zip(&expected.accounts) {
            let name = account["name"].as_str().unwrap();
            let source = parse_account_source(account["source"].as_str().unwrap()).unwrap();
            assert_eq!(
                resolve_action_with(&source, &market, &caller, &inputs),
                meta.pubkey,
                "slot {slot}, {name}"
            );
            assert_eq!(
                account["signer"].as_bool().unwrap_or(false),
                meta.is_signer,
                "slot {slot}, {name}"
            );
            assert_eq!(
                account["writable"].as_bool().unwrap_or(false),
                meta.is_writable,
                "slot {slot}, {name}"
            );
        }
    }
}
