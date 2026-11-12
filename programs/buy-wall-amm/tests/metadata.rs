//! `metadata.json` (docs/spec/pool4-for-solana.md, "Custom actions and metadata") passes
//! Pipeline's validator with zero warnings, and its `init`, `seed_liquidity` and `seed` forms
//! describe exactly the instructions the program takes: the same arguments in the same order and Borsh
//! encoding, and the same accounts, resolved here from each form's account sources.

mod common;

use buy_wall_amm::InitParams;
use common::*;
use pipeline_client::metadata::{
    parse_account_source, parse_strategy_metadata, AccountSource, PdaSeed,
};
use pipeline_client::{pda, AccountMeta, Pubkey};
use serde_json::Value;

const METADATA: &str = include_str!("../metadata.json");

fn metadata() -> Value {
    serde_json::from_str(METADATA).unwrap()
}

/// Resolves an account source for a market, as Aviary's generic forms would.
fn resolve(
    source: &AccountSource,
    market: &Market,
    wallet: &Pubkey,
    inputs: &[(&str, Pubkey)],
) -> Pubkey {
    match source {
        AccountSource::Wallet => *wallet,
        AccountSource::MarketState => market.market_state,
        AccountSource::Market => market.market,
        AccountSource::Fixed(key) => *key,
        AccountSource::Input(name) => inputs.iter().find(|(n, _)| n == name).unwrap().1,
        AccountSource::Mint(i) => market.mints()[*i as usize],
        AccountSource::Vault(i) => market.vaults()[*i as usize],
        AccountSource::TokenProgram(i) => market.token_programs()[*i as usize],
        AccountSource::WalletTokenAccount(i) => {
            let i = *i as usize;
            pda::associated_token(wallet, &market.mints()[i], &market.token_programs()[i])
        }
        AccountSource::TokenProgramOf(mint) => {
            let mint = resolve(mint, market, wallet, inputs);
            if mint == market.token_mint {
                market.token_program
            } else {
                TOKEN
            }
        }
        AccountSource::Pda {
            program: None,
            seeds,
        } => {
            let bytes: Vec<Vec<u8>> = seeds
                .iter()
                .map(|seed| match seed {
                    PdaSeed::Str(text) => text.as_bytes().to_vec(),
                    PdaSeed::Key(source) => {
                        resolve(source, market, wallet, inputs).to_bytes().to_vec()
                    }
                    other => panic!("unexpected seed {other:?}"),
                })
                .collect();
            let refs: Vec<&[u8]> = bytes.iter().map(Vec::as_slice).collect();
            Pubkey::find_program_address(&refs, &strategy_id()).0
        }
        other => panic!("unexpected source {other:?}"),
    }
}

fn resolve_accounts(
    form: &Value,
    market: &Market,
    wallet: &Pubkey,
    inputs: &[(&str, Pubkey)],
) -> Vec<AccountMeta> {
    form["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|account| {
            let source = parse_account_source(account["source"].as_str().unwrap()).unwrap();
            let key = resolve(&source, market, wallet, inputs);
            let signer = account["signer"].as_bool().unwrap_or(false);
            if account["writable"].as_bool().unwrap_or(false) {
                AccountMeta::new(key, signer)
            } else {
                AccountMeta::new_readonly(key, signer)
            }
        })
        .collect()
}

/// Borsh-encodes `values` (by argument name) in the order and types `form` lists.
fn encode_args(form: &Value, values: &[(&str, Value)]) -> Vec<u8> {
    let mut data = vec![];
    for arg in form["args"].as_array().unwrap() {
        let name = arg["name"].as_str().unwrap();
        let value = &values
            .iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("no value for {name}"))
            .1;
        match arg["type"].as_str().unwrap() {
            "u16" => data.extend_from_slice(&(value.as_u64().unwrap() as u16).to_le_bytes()),
            "u64" => data.extend_from_slice(&value.as_u64().unwrap().to_le_bytes()),
            "pubkey" => data.extend_from_slice(
                &value
                    .as_str()
                    .unwrap()
                    .parse::<Pubkey>()
                    .unwrap()
                    .to_bytes(),
            ),
            other => panic!("unexpected type {other}"),
        }
    }
    data
}

#[test]
fn the_metadata_is_valid_with_zero_warnings() {
    let warnings =
        parse_strategy_metadata(&metadata()).unwrap_or_else(|errors| panic!("invalid: {errors:?}"));
    assert!(warnings.is_empty(), "warnings: {warnings:?}");
    let metadata = metadata();
    // The public name lives here and in the embedded security.txt only (Names).
    assert_eq!(metadata["name"], "Aviary Buy Wall AMM");
    assert_eq!(metadata["category"], "amm");
    assert!(metadata["tags"]
        .as_array()
        .unwrap()
        .contains(&Value::from("pool4")));
    assert!(metadata["description"]
        .as_str()
        .unwrap()
        .contains("IMD's Pool4"));
    assert_eq!(metadata["init"]["market_state"], "new_keypair");
    assert!(metadata["security"]["contact"].is_string());
}

#[test]
fn the_init_form_builds_exactly_what_pipeline_init_market_takes() {
    let metadata = metadata();
    let init = &metadata["init"];
    let params = InitParams {
        fee_bps: 100,
        wall_split_bps: 5_000,
        fee_recipient: Pubkey::new_unique(),
        reward_share_bps: 1_500,
        rewards_recipient: Pubkey::new_unique(),
        cap_floor_bps: 2_000,
        cap_decay_bps: 2_000,
        seeder: Pubkey::new_unique(),
    };
    let values = [
        ("fee_bps", Value::from(params.fee_bps)),
        ("wall_split_bps", Value::from(params.wall_split_bps)),
        (
            "fee_recipient",
            Value::from(params.fee_recipient.to_string()),
        ),
        ("reward_share_bps", Value::from(params.reward_share_bps)),
        (
            "rewards_recipient",
            Value::from(params.rewards_recipient.to_string()),
        ),
        ("cap_floor_bps", Value::from(params.cap_floor_bps)),
        ("cap_decay_bps", Value::from(params.cap_decay_bps)),
        ("seeder", Value::from(params.seeder.to_string())),
    ];
    assert_eq!(encode_args(init, &values), borsh::to_vec(&params).unwrap());

    for token_program in [TOKEN, TOKEN_2022] {
        let token = Pubkey::new_unique();
        let market = Market::addresses(Pubkey::new_unique(), token, token_program);
        let accounts = resolve_accounts(
            init,
            &market,
            &Pubkey::new_unique(),
            &[("token_mint", token)],
        );
        assert_eq!(accounts, market.init_accounts());
    }
}

#[test]
fn the_seed_action_builds_exactly_what_seed_takes() {
    let metadata = metadata();
    let action = metadata["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "seed")
        .unwrap();
    assert_eq!(action["kind"], "add_liquidity");
    let wallet = Pubkey::new_unique();
    for token_program in [TOKEN, TOKEN_2022] {
        let market = Market::addresses(Pubkey::new_unique(), Pubkey::new_unique(), token_program);
        let expected = seed_ix(&market, &wallet, 5, 7, vec![]);
        let accounts = resolve_accounts(action, &market, &wallet, &[]);
        assert_eq!(accounts, expected.accounts);
        let mut data = pipeline_client::instruction_discriminator("seed").to_vec();
        data.extend(encode_args(
            action,
            &[
                ("token_amount", Value::from(5)),
                ("sol_amount", Value::from(7)),
            ],
        ));
        assert_eq!(data, expected.data);
    }
}

#[test]
fn the_seed_liquidity_form_describes_exactly_what_pipeline_seed_liquidity_takes() {
    // Pipeline's metadata standard has no field for pipeline_seed_liquidity, so the form is
    // shaped as `init` is (the validator allows unknown keys, as the zero-warning test
    // shows), which the SDK's `resolveInit` resolves for a launcher.
    let metadata = metadata();
    let form = &metadata["seed_liquidity"];
    assert_eq!(form["idl_type"], "InitParams");
    // `data` is the creation parameters: init's arguments, word for word and in order, but
    // for the seeder's description, which says it is ignored.
    let init_args = metadata["init"]["args"].as_array().unwrap();
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

    // The market state is the seeded PDA of the seeder and the token, and the accounts after
    // Pipeline's fixed ones and the three per mint are the program's own: the vault authority
    // and both vaults.
    for token_program in [TOKEN, TOKEN_2022] {
        let seeder = Pubkey::new_unique();
        let token = Pubkey::new_unique();
        let inputs = [("seeder", seeder), ("token_mint", token)];
        let expected = common::launchpad::seeded_market_state(&seeder, &token);
        let market = Market::addresses(expected, token, token_program);
        let source = parse_account_source(form["market_state"].as_str().unwrap()).unwrap();
        let unseeded = Market::addresses(Pubkey::default(), token, token_program);
        assert_eq!(resolve(&source, &unseeded, &seeder, &inputs), expected);
        let accounts = resolve_accounts(form, &market, &seeder, &inputs);
        assert_eq!(
            accounts,
            [
                AccountMeta::new_readonly(market.vault_authority, false),
                AccountMeta::new(market.token_vault, false),
                AccountMeta::new(market.sol_vault, false),
            ]
        );
    }
}
