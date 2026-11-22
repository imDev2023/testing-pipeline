//! The mint rules at market creation, through the real router (docs/spec/tax-amm.md, "Mint
//! rules"): SPL Token and Token-2022 mints make markets, a Token-2022 mint may carry only
//! the allowlisted extensions, and every other extension, unknown ones included, is refused
//! before any vault exists.

//!
//! Below the router tests, the walk itself: `mint_rules::check_mint` and `find_extension`
//! never panic on any bytes and read every mint layout as Token-2022's own state code does
//! (docs/security/tax-amm/maths-properties.md, W1 and W2; hardening findings H012 and H015).

mod common;

use common::*;
use mint_rules::{check_mint, find_extension, MintRefusal, ALLOWED_MINT_EXTENSIONS};
use mint_rules::{TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID};
use pipeline_client::Pubkey;
use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use solana_signer::Signer;
use spl_token_2022_interface::extension::group_member_pointer::GroupMemberPointer;
use spl_token_2022_interface::extension::group_pointer::GroupPointer;
use spl_token_2022_interface::extension::metadata_pointer::MetadataPointer;
use spl_token_2022_interface::extension::permanent_delegate::PermanentDelegate;
use spl_token_2022_interface::extension::transfer_fee::TransferFeeConfig;
use spl_token_2022_interface::extension::transfer_hook::TransferHook;
use spl_token_2022_interface::extension::{
    BaseStateWithExtensions, Extension, ExtensionType, StateWithExtensions,
};
use spl_token_2022_interface::state::Mint;
use tax_amm::StrategyError;

const ACCOUNT_LEN: usize = 165;

/// Tries to create a market of `mint` (index 0, Token-2022) against a plain SPL Token mint.
fn try_market(env: &mut Env, mint: Pubkey) -> Result<Market, String> {
    let other = env.create_mint(&TOKEN);
    let params = valid_params(&Pubkey::new_unique());
    env.create_tax_market([(mint, TOKEN_2022), (other, TOKEN)], &params)
}

/// Fails unless a market of a mint carrying `extension_type` is refused, by its number.
fn assert_extension_refused(extension_type: ExtensionType) {
    let mut env = Env::new();
    let len = ExtensionType::try_calculate_account_len::<Mint>(&[extension_type])
        .map(|len| len - (ACCOUNT_LEN + 1 + 4))
        .expect("a fixed-length mint extension");
    let mint = env.write_mint_with_extensions(&[(extension_type as u16, len)]);
    let result = try_market(&mut env, mint);
    let line = format!("carries refused extension {}", extension_type as u16);
    assert!(
        result.as_ref().is_err_and(|logs| logs.contains(&line)),
        "{extension_type:?}: {result:?}"
    );
    assert_refused(result, StrategyError::MintExtensionNotAllowed);
}

macro_rules! refused_extension_tests {
    ($($test:ident => $extension:ident,)*) => {$(
        #[test]
        fn $test() {
            assert_extension_refused(ExtensionType::$extension);
        }
    )*};
}

// Every mint extension Token-2022 defines outside the allowlist, one test each.
refused_extension_tests! {
    a_transfer_fee_mint_is_refused => TransferFeeConfig,
    a_mint_close_authority_mint_is_refused => MintCloseAuthority,
    a_confidential_transfer_mint_is_refused => ConfidentialTransferMint,
    a_default_account_state_mint_is_refused => DefaultAccountState,
    a_non_transferable_mint_is_refused => NonTransferable,
    an_interest_bearing_mint_is_refused => InterestBearingConfig,
    a_permanent_delegate_mint_is_refused => PermanentDelegate,
    a_confidential_transfer_fee_mint_is_refused => ConfidentialTransferFeeConfig,
    a_confidential_mint_burn_mint_is_refused => ConfidentialMintBurn,
    a_scaled_ui_amount_mint_is_refused => ScaledUiAmount,
    a_pausable_mint_is_refused => Pausable,
    a_permissioned_burn_mint_is_refused => PermissionedBurn,
}

#[test]
fn an_extension_the_program_does_not_recognise_is_refused() {
    // The next number Token-2022 may give a new extension.
    let unknown = ExtensionType::PermissionedBurn as u16 + 1;
    let mut env = Env::new();
    let mint = env.write_mint_with_extensions(&[(unknown, 32)]);
    let result = try_market(&mut env, mint);
    assert!(result
        .as_ref()
        .is_err_and(|logs| logs.contains(&format!("carries refused extension {unknown}"))));
    assert_refused(result, StrategyError::MintExtensionNotAllowed);
}

#[test]
fn mints_token_2022_set_up_itself_with_a_refused_extension_are_refused() {
    let mut env = Env::new();
    let fee = env.create_mint_with(
        &TOKEN_2022,
        MintOptions {
            transfer_fee_bps: Some(100),
            ..MintOptions::default()
        },
    );
    assert_refused(
        try_market(&mut env, fee),
        StrategyError::MintExtensionNotAllowed,
    );
    let delegate = env.create_mint_with(
        &TOKEN_2022,
        MintOptions {
            permanent_delegate: true,
            ..MintOptions::default()
        },
    );
    assert_refused(
        try_market(&mut env, delegate),
        StrategyError::MintExtensionNotAllowed,
    );
}

#[test]
fn a_token_2022_market_is_created() {
    let mut env = Env::new();
    let mint_0 = env.create_mint(&TOKEN_2022);
    let mint_1 = env.create_mint(&TOKEN_2022);
    let params = valid_params(&Pubkey::new_unique());
    let market = env
        .create_tax_market([(mint_0, TOKEN_2022), (mint_1, TOKEN_2022)], &params)
        .unwrap();
    assert_eq!(env.tax_market(&market.market_state).params(), params);
    for vault in market.vaults {
        assert_eq!(env.svm.get_account(&vault).unwrap().owner, TOKEN_2022);
    }
}

/// A Token-2022 mint whose transfer hook extension names `program` and `authority`, the
/// default key standing for none, as Token-2022 itself sets it up.
fn hooked_mint(
    env: &mut Env,
    program: Pubkey,
    authority: impl FnOnce(&Pubkey) -> Pubkey,
) -> Pubkey {
    env.create_hooked_mint(&program, authority, MintOptions::default())
}

/// A contained mint, the one kind of live hook a market accepts: the containment hook, with
/// the mint's unlock PDA as its hook authority (docs/spec/tax-amm.md, "Mint rules").
#[test]
fn a_contained_mint_is_accepted() {
    let mut env = Env::new();
    let contained = hooked_mint(&mut env, containment_hook_id(), unlock_pda);
    let market = try_market(&mut env, contained).unwrap();
    // Token-2022 sized the hooked mint's vault for its transfer-hook account extension.
    let vault = env.svm.get_account(&market.vaults[0]).unwrap();
    assert_eq!(vault.owner, TOKEN_2022);
    assert!(vault.data.len() > ACCOUNT_LEN);
    assert_eq!(&vault.data[32..64], market.authority.as_ref());
}

/// A transfer hook extension with no program and no authority, as a contained mint's is
/// after its unlock, runs no hook and never can again.
#[test]
fn a_mint_whose_transfer_hook_is_cleared_is_accepted() {
    let mut env = Env::new();
    let cleared = env.create_mint_with_cleared_hook();
    let data = env.svm.get_account(&cleared).unwrap().data;
    let hook = find_extension(&data, ExtensionType::TransferHook as u16).unwrap();
    assert_eq!(hook, &[0u8; 64][..], "all 64 bytes zero");
    try_market(&mut env, cleared).unwrap();
}

/// How a test derives a hook authority from the mint's address.
type HookAuthority = Box<dyn Fn(&Pubkey) -> Pubkey>;

/// Hardening finding H007 (#67): a live transfer hook of any other program, or one whose
/// authority could repoint it, could refuse every sell while buys still land, so creation
/// refuses it, through the router and through a launchpad alike.
#[test]
fn sos_h007_a_mint_whose_transfer_hook_could_refuse_sells_is_refused() {
    let foreign = Pubkey::new_unique();
    let wallet = Pubkey::new_unique();
    let cases: [(&str, Pubkey, HookAuthority); 7] = [
        (
            "another program, a wallet its authority",
            foreign,
            Box::new(move |_| wallet),
        ),
        (
            "another program, the unlock PDA its authority",
            foreign,
            Box::new(unlock_pda),
        ),
        (
            "the containment hook, a wallet its authority",
            containment_hook_id(),
            Box::new(move |_| wallet),
        ),
        (
            "the containment hook, another mint's unlock PDA its authority",
            containment_hook_id(),
            Box::new(|_| unlock_pda(&Pubkey::new_unique())),
        ),
        (
            "no program, but an authority that could set one",
            Pubkey::default(),
            Box::new(move |_| wallet),
        ),
        // A hook with no authority can never be repointed, but its program's own code (or an
        // upgrade of it) can still refuse sells: only the containment hook may run.
        (
            "another program, no authority",
            foreign,
            Box::new(|_| Pubkey::default()),
        ),
        // The containment hook with no authority could never be cleared, so its token could
        // never unlock; a contained mint's authority is its unlock PDA.
        (
            "the containment hook, no authority",
            containment_hook_id(),
            Box::new(|_| Pubkey::default()),
        ),
    ];
    for (what, program, authority) in cases {
        println!("{what}");
        let mut env = Env::new();
        let mint = hooked_mint(&mut env, program, &authority);
        assert_refused(
            try_market(&mut env, mint),
            StrategyError::TransferHookNotAllowed,
        );

        let mut env = Env::new();
        let mint = hooked_mint(&mut env, program, &authority);
        let other = env.create_mint(&TOKEN);
        let launch = env.launch([(mint, TOKEN_2022), (other, TOKEN)], [1_000, 1_000]);
        let graduate = env.graduate_instruction(
            &launch,
            [1_000, 1_000],
            init_data(&valid_params(&Pubkey::new_unique())),
            launchpad::seed_liquidity_own_accounts(&launch),
        );
        assert_refused(
            env.send_as_creator(&launch, &[graduate]),
            StrategyError::TransferHookNotAllowed,
        );
    }
}

#[test]
fn a_mint_with_a_mint_and_a_freeze_authority_is_accepted_at_creation() {
    for token_program in [TOKEN, TOKEN_2022] {
        let mut env = Env::new();
        let mint = env.create_mint_with(
            &token_program,
            MintOptions {
                mint_authority: true,
                freeze_authority: true,
                ..MintOptions::default()
            },
        );
        let data = env.svm.get_account(&mint).unwrap().data;
        assert_eq!(&data[..4], &[1, 0, 0, 0], "a mint authority");
        assert_eq!(&data[46..50], &[1, 0, 0, 0], "a freeze authority");
        let other = env.create_mint(&TOKEN);
        let params = valid_params(&Pubkey::new_unique());
        env.create_tax_market([(mint, token_program), (other, TOKEN)], &params)
            .unwrap();
    }
}

#[test]
fn a_mint_passed_with_the_other_token_program_is_refused() {
    let mut env = Env::new();
    let mint = env.create_mint(&TOKEN_2022);
    let other = env.create_mint(&TOKEN);
    let params = valid_params(&Pubkey::new_unique());
    assert_refused(
        env.create_tax_market([(mint, TOKEN), (other, TOKEN)], &params),
        StrategyError::WrongTokenProgram,
    );
}

#[test]
fn an_account_that_is_not_a_mint_is_refused() {
    let mut env = Env::new();
    let mint = env.create_mint(&TOKEN);
    let other = env.create_mint(&TOKEN);
    let params = valid_params(&Pubkey::new_unique());

    // A token account, owned by SPL Token but not a mint.
    let token_account =
        write_token_account(&mut env.svm, &mint, &TOKEN, &Pubkey::new_unique(), 5).unwrap();
    assert_refused(
        env.create_tax_market([(token_account, TOKEN), (other, TOKEN)], &params),
        StrategyError::NotAMint,
    );

    // A wallet, owned by the system program, is not any token program's.
    let wallet = Pubkey::new_unique();
    env.svm.airdrop(&wallet, SOL).unwrap();
    assert_refused(
        env.create_tax_market([(wallet, TOKEN), (other, TOKEN)], &params),
        StrategyError::WrongTokenProgram,
    );
}

// At the seed, through both seed paths: a mint outside the quote list may keep neither a
// mint authority nor a freeze authority (hardening findings H008 and H016, #67).

const SEEDED: [u64; 2] = [1_000_000_000, 2_000_000_000];

/// Seeds a new market of `mints` through the `seed` action, then through a launchpad's
/// `pipeline_seed_liquidity`, each in a fresh VM whose mints `mints_of` makes.
fn seed_both_ways(mints_of: &dyn Fn(&mut Env) -> [(Pubkey, Pubkey); 2]) -> [Result<(), String>; 2] {
    let mut env = Env::new();
    let mints = mints_of(&mut env);
    let seeder = solana_keypair::Keypair::new();
    let params = valid_params(&seeder.pubkey());
    let market = env.create_tax_market(mints, &params).unwrap();
    env.fund(&seeder.pubkey(), &market, SEEDED);
    let by_action = env.seed(&market, &seeder, SEEDED).map(|_| ());

    let mut env = Env::new();
    let mints = mints_of(&mut env);
    let launch = env.launch(mints, SEEDED);
    let by_launchpad = env
        .graduate(&launch, &valid_params(&Pubkey::new_unique()), SEEDED)
        .map(|_| ());
    [by_action, by_launchpad]
}

/// A mint of `token_program` with `options`, against a plain SPL Token mint on the other
/// side, at index `side`.
fn pair_with(
    side: usize,
    token_program: Pubkey,
    options: MintOptions,
) -> impl Fn(&mut Env) -> [(Pubkey, Pubkey); 2] {
    move |env| {
        let mut mints = [(env.create_mint(&TOKEN), TOKEN); 2];
        mints[1 - side] = (env.create_mint(&TOKEN), TOKEN);
        mints[side] = (env.create_mint_with(&token_program, options), token_program);
        mints
    }
}

/// Hardening finding H008 (#67): whoever keeps a mint authority could mint and sell into
/// the curve, taking the real reserve the seed locked for good, so the seed refuses it.
#[test]
fn sos_h008_a_mint_with_a_mint_authority_is_refused_at_the_seed() {
    for token_program in [TOKEN, TOKEN_2022] {
        for side in [0, 1] {
            let options = MintOptions {
                mint_authority: true,
                ..MintOptions::default()
            };
            for result in seed_both_ways(&pair_with(side, token_program, options)) {
                assert_refused(result, StrategyError::MintAuthoritySet);
            }
        }
    }
}

/// Hardening finding H016 (#67): a freeze authority could freeze a vault, stopping every
/// trade, or any holder, so the seed refuses it.
#[test]
fn sos_h016_a_mint_with_a_freeze_authority_is_refused_at_the_seed() {
    for token_program in [TOKEN, TOKEN_2022] {
        for side in [0, 1] {
            let options = MintOptions {
                freeze_authority: true,
                ..MintOptions::default()
            };
            for result in seed_both_ways(&pair_with(side, token_program, options)) {
                assert_refused(result, StrategyError::FreezeAuthoritySet);
            }
        }
    }
}

/// The quote mints may keep their authorities: the cluster's USDC has both, and the native
/// SOL mints have none to begin with.
#[test]
fn a_market_against_a_quote_mint_is_seeded_whatever_its_authorities() {
    let usdc = |env: &mut Env| {
        [
            (env.create_mint(&TOKEN), TOKEN),
            (env.write_usdc_mint(), TOKEN),
        ]
    };
    for result in seed_both_ways(&usdc) {
        result.unwrap();
    }
    for (native, token_program) in [(0, TOKEN), (1, TOKEN_2022)] {
        let sol = move |env: &mut Env| {
            let sol = env.write_native_mint(&tax_amm::params::NATIVE_MINTS[native], &token_program);
            [(sol, token_program), (env.create_mint(&TOKEN), TOKEN)]
        };
        for result in seed_both_ways(&sol) {
            result.unwrap();
        }
    }
}

/// A Token-2022 mint with an account type and no extension entries is 166 bytes long, and
/// Token-2022 creates such mints; the router creates a market of one.
#[test]
fn sos_h015_a_166_byte_mint_creates_a_market() {
    let mut env = Env::new();
    let mint = env.write_mint_with_extensions(&[]);
    assert_eq!(
        env.svm.get_account(&mint).unwrap().data.len(),
        ACCOUNT_LEN + 1
    );
    try_market(&mut env, mint).unwrap();
}

/// Token-2022 never reads an account of a multisig's length as a mint, whatever it holds;
/// creation refuses it too, though every extension on it is allowed.
#[test]
fn sos_h015_a_355_byte_mint_with_extensions_is_refused() {
    let mut env = Env::new();
    // 166 bytes, a 68-byte transfer hook entry and a 121-byte metadata pointer entry: 355.
    let mint = env.write_mint_with_extensions(&[
        (ExtensionType::TransferHook as u16, 64),
        (ExtensionType::MetadataPointer as u16, 117),
    ]);
    assert_eq!(env.svm.get_account(&mint).unwrap().data.len(), MULTISIG_LEN);
    assert_refused(try_market(&mut env, mint), StrategyError::NotAMint);
}

// The walk against Token-2022's own reading of a mint (W1 and W2): `check_mint` accepts a
// Token-2022 mint exactly when Token-2022 unpacks it and every extension type its walk finds
// is on the allowlist, refuses it with the first type off the list when there is one, and
// `find_extension` returns the entry Token-2022's lookup does.

const BASE_LEN: usize = 82;
const MULTISIG_LEN: usize = 355;
const IS_INITIALIZED: usize = 45;
/// Where the mint authority's and the freeze authority's option tags start.
const OPTION_TAGS: [usize; 2] = [0, 46];
const CASES: u32 = 10_000;
/// The mint extensions Token-2022 defines outside the allowlist, by number.
const REFUSED_KNOWN: [u16; 14] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15];
const REFUSED_LATER: [u16; 7] = [16, 17, 24, 25, 26, 27, 28];
/// The first number Token-2022 3.1.2 has not given an extension.
const FIRST_UNKNOWN: u16 = 29;

/// What Token-2022 makes of `data` as a mint: `None` when its unpack or its walk of the
/// extension types refuses it, else the types its walk finds, in order.
fn token_2022_reading(data: &[u8]) -> Option<Vec<u16>> {
    let state = StateWithExtensions::<Mint>::unpack(data).ok()?;
    let types = state.get_extension_types().ok()?;
    Some(types.into_iter().map(u16::from).collect())
}

/// `data` with each option tag of its base that Token-2022 refuses (anything but 0 or 1, which
/// is all SPL Token and Token-2022 ever write) set to 0, and how many it set.
fn with_readable_option_tags(data: &[u8]) -> (Vec<u8>, usize) {
    let mut data = data.to_vec();
    let mut fixed = 0;
    if data.len() >= BASE_LEN {
        for at in OPTION_TAGS {
            if data[at..at + 4] != [0, 0, 0, 0] && data[at..at + 4] != [1, 0, 0, 0] {
                data[at..at + 4].copy_from_slice(&[0; 4]);
                fixed += 1;
            }
        }
    }
    (data, fixed)
}

/// Whether `find_extension` returns the entry of `V` that Token-2022's lookup does.
fn found_alike<V: Extension>(state: &StateWithExtensions<Mint>, data: &[u8]) -> bool {
    find_extension(data, u16::from(V::TYPE)) == state.get_extension_bytes::<V>().ok()
}

/// How a layout was read, for the counts that show every kind came up.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Reading {
    AcceptedBare,
    AcceptedWithExtensions,
    AcceptedWithARefusedTypeAfterAGap,
    RefusedExtension,
    RefusedLayout,
    OptionTagsOnlyTokenProgramsWrite,
}

/// Fails unless `check_mint` and `find_extension` read `data` as Token-2022 does, under each
/// owner, and returns how it was read. `hides_refused` says the layout has a type-0 entry
/// with a refused type after it.
fn assert_read_as_token_2022_reads(
    data: &[u8],
    hides_refused: bool,
) -> Result<Reading, TestCaseError> {
    for t in [0, 14, 12, u16::MAX] {
        let _ = find_extension(data, t);
    }
    prop_assert_eq!(
        check_mint(&[7; 32], data),
        Err(MintRefusal::NotATokenProgram)
    );
    // H015, step 4: `check_mint` reads only the initialized byte of a mint's base, while
    // Token-2022 also refuses option tags other than 0 and 1, which neither token program
    // ever writes (only they write their mints' bytes, and the vault creation calls unpack
    // the mint again). Pinned here: the outcome never depends on the tags.
    let (readable, fixed) = with_readable_option_tags(data);
    for owner in [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] {
        prop_assert_eq!(check_mint(&owner, data), check_mint(&owner, &readable));
    }
    if fixed > 0 {
        prop_assert!(token_2022_reading(data).is_none());
    }
    let reading = token_2022_reading(&readable);
    // SPL Token: a mint is exactly its 82-byte base.
    prop_assert_eq!(
        check_mint(&TOKEN_PROGRAM_ID, &readable).is_ok(),
        readable.len() == BASE_LEN && reading.is_some()
    );
    let ours = check_mint(&TOKEN_2022_PROGRAM_ID, &readable);
    let outcome = match reading {
        None => {
            prop_assert!(ours.is_err(), "accepted a layout Token-2022 refuses");
            Reading::RefusedLayout
        }
        Some(types) => match types.iter().find(|t| !ALLOWED_MINT_EXTENSIONS.contains(t)) {
            Some(&refused) => {
                prop_assert_eq!(ours, Err(MintRefusal::ExtensionNotAllowed(refused)));
                Reading::RefusedExtension
            }
            None => {
                prop_assert_eq!(
                    ours,
                    Ok(()),
                    "Token-2022 reads only allowed types {:?}",
                    types
                );
                let state = StateWithExtensions::<Mint>::unpack(&readable).unwrap();
                prop_assert!(found_alike::<TransferHook>(&state, &readable));
                prop_assert!(found_alike::<MetadataPointer>(&state, &readable));
                prop_assert!(found_alike::<GroupPointer>(&state, &readable));
                prop_assert!(found_alike::<GroupMemberPointer>(&state, &readable));
                // H012: on a mint the rules accept, Token-2022 finds no refused extension.
                prop_assert!(state.get_extension_bytes::<PermanentDelegate>().is_err());
                prop_assert!(state.get_extension_bytes::<TransferFeeConfig>().is_err());
                if hides_refused {
                    Reading::AcceptedWithARefusedTypeAfterAGap
                } else if types.is_empty() {
                    Reading::AcceptedBare
                } else {
                    Reading::AcceptedWithExtensions
                }
            }
        },
    };
    Ok(if fixed > 0 {
        Reading::OptionTagsOnlyTokenProgramsWrite
    } else {
        outcome
    })
}

/// One type-length-value entry: its type, the length its header claims, and the first byte
/// of its value (the rest count up from it); a value longer than 96 bytes is cut short, so
/// its length runs past the account unless later bytes cover it.
fn entry() -> impl Strategy<Value = (u16, u16, u8)> {
    let extension_type = prop_oneof![
        5 => proptest::sample::select(ALLOWED_MINT_EXTENSIONS.to_vec()),
        2 => proptest::sample::select(REFUSED_KNOWN.to_vec()),
        1 => proptest::sample::select(REFUSED_LATER.to_vec()),
        2 => Just(0u16),
        1 => FIRST_UNKNOWN..=u16::MAX,
    ];
    let len = prop_oneof![
        2 => Just(0u16),
        3 => proptest::sample::select(vec![32u16, 64, 1, 8, 72]),
        3 => 0u16..96,
        1 => 96u16..=u16::MAX,
    ];
    (extension_type, len, any::<u8>())
}

/// A mint's bytes as Token-2022 lays them out, with every field it checks sometimes wrong:
/// the option tags and the initialized byte of the base, the padding to 165 bytes, the
/// account type, then 0 to 5 entries (type-0 gaps and refused types among them) and up to 3
/// trailing bytes, and the whole cut or zero-filled to 82, 165, 166, 167, 355 or any length up
/// to 400 bytes, or left as built. Also says whether a refused type follows a type-0 entry.
fn mint_layout() -> impl Strategy<Value = (Vec<u8>, bool)> {
    let tag = prop_oneof![8 => Just(1u32), 4 => Just(0u32), 1 => any::<u32>()];
    let base = (
        tag.clone(),
        any::<[u8; 32]>(),
        any::<u64>(),
        any::<u8>(),
        prop_oneof![12 => Just(1u8), 1 => Just(0u8), 1 => any::<u8>()],
        tag,
        any::<[u8; 32]>(),
    );
    let layout = (
        proptest::option::weighted(0.05, (BASE_LEN..ACCOUNT_LEN, 1u8..=255)),
        prop_oneof![12 => Just(1u8), 1 => Just(0u8), 1 => Just(2u8), 1 => any::<u8>()],
        proptest::collection::vec(entry(), 0..=5),
        prop_oneof![4 => Just(vec![]), 1 => proptest::collection::vec(any::<u8>(), 1..=3)],
        prop_oneof![
            6 => Just(None),
            1 => Just(Some(BASE_LEN)),
            1 => Just(Some(ACCOUNT_LEN)),
            2 => Just(Some(ACCOUNT_LEN + 1)),
            2 => Just(Some(ACCOUNT_LEN + 2)),
            2 => Just(Some(MULTISIG_LEN)),
            2 => (0usize..=400).prop_map(Some),
        ],
    );
    (base, layout).prop_map(
        |(
            (authority_tag, authority, supply, decimals, initialized, freeze_tag, freeze),
            (dirt, account_type, entries, trailing, length),
        )| {
            let mut data = Vec::with_capacity(400);
            data.extend_from_slice(&authority_tag.to_le_bytes());
            data.extend_from_slice(&authority);
            data.extend_from_slice(&supply.to_le_bytes());
            data.push(decimals);
            data.push(initialized);
            data.extend_from_slice(&freeze_tag.to_le_bytes());
            data.extend_from_slice(&freeze);
            assert_eq!(data.len(), BASE_LEN);
            data.resize(ACCOUNT_LEN, 0);
            if let Some((at, byte)) = dirt {
                data[at] = byte;
            }
            data.push(account_type);
            for &(extension_type, len, first) in &entries {
                data.extend_from_slice(&extension_type.to_le_bytes());
                data.extend_from_slice(&len.to_le_bytes());
                data.extend((0..len.min(96)).map(|i| first.wrapping_add(i as u8)));
            }
            data.extend_from_slice(&trailing);
            if let Some(length) = length {
                data.resize(length, 0);
            }
            let hides_refused = entries.iter().position(|e| e.0 == 0).is_some_and(|gap| {
                entries[gap + 1..]
                    .iter()
                    .any(|e| e.0 != 0 && !ALLOWED_MINT_EXTENSIONS.contains(&e.0))
            });
            (data, hides_refused)
        },
    )
}

/// W1 and W2 (H012, H015): over mint layouts of every length the rules and Token-2022 treat
/// differently, `check_mint` and `find_extension` never panic and read each as Token-2022
/// does; the run fails unless every kind of reading came up at least 100 times.
#[test]
fn sos_h012_sos_h015_the_mint_walk_reads_every_layout_as_token_2022_does() {
    let readings = std::sync::Mutex::new(std::collections::BTreeMap::<Reading, u32>::new());
    let mut runner = TestRunner::new(Config::with_cases(CASES));
    runner
        .run(&mint_layout(), |(data, hides_refused)| {
            let reading = assert_read_as_token_2022_reads(&data, hides_refused)?;
            *readings.lock().unwrap().entry(reading).or_default() += 1;
            Ok(())
        })
        .unwrap();
    let readings = readings.into_inner().unwrap();
    for reading in [
        Reading::AcceptedBare,
        Reading::AcceptedWithExtensions,
        Reading::AcceptedWithARefusedTypeAfterAGap,
        Reading::RefusedExtension,
        Reading::RefusedLayout,
        Reading::OptionTagsOnlyTokenProgramsWrite,
    ] {
        let seen = readings.get(&reading).copied().unwrap_or(0);
        assert!(
            seen >= 100,
            "{reading:?} came up only {seen} times: {readings:?}"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    /// W1: any bytes at all, under any owner, are accepted or refused without a panic, and
    /// read as Token-2022 reads them.
    #[test]
    fn sos_h015_the_mint_walk_never_panics_on_any_bytes(
        data in proptest::collection::vec(any::<u8>(), 0..=400),
        initialized in any::<bool>(),
    ) {
        let mut data = data;
        // Half the time past the initialized byte, so the walk itself runs.
        if initialized && data.len() > IS_INITIALIZED {
            data[IS_INITIALIZED] = 1;
        }
        assert_read_as_token_2022_reads(&data, false)?;
    }
}

/// A Token-2022 mint's bytes: an initialized base with a mint authority, zero padding to 165
/// bytes, the mint account type, then `tlv` as it is.
fn token_2022_mint(tlv: &[u8]) -> Vec<u8> {
    let mut data = vec![0u8; ACCOUNT_LEN];
    data[..4].copy_from_slice(&[1, 0, 0, 0]);
    data[4..36].copy_from_slice(&[5; 32]);
    data[44] = 6;
    data[IS_INITIALIZED] = 1;
    data.push(1);
    data.extend_from_slice(tlv);
    data
}

fn tlv_entry(extension_type: ExtensionType, value: &[u8]) -> Vec<u8> {
    let mut entry = u16::from(extension_type).to_le_bytes().to_vec();
    entry.extend_from_slice(&(value.len() as u16).to_le_bytes());
    entry.extend_from_slice(value);
    entry
}

#[test]
fn sos_h015_a_166_byte_mint_is_read_alike() {
    let data = token_2022_mint(&[]);
    assert_eq!(data.len(), ACCOUNT_LEN + 1);
    assert_eq!(token_2022_reading(&data), Some(vec![]));
    assert_eq!(check_mint(&TOKEN_2022_PROGRAM_ID, &data), Ok(()));
    assert_eq!(
        find_extension(&data, mint_rules::extension::TRANSFER_HOOK),
        None
    );
    // One trailing byte is too short for a type: both end the list there.
    let data = token_2022_mint(&[7]);
    assert_eq!(token_2022_reading(&data), Some(vec![]));
    assert_eq!(check_mint(&TOKEN_2022_PROGRAM_ID, &data), Ok(()));
}

#[test]
fn sos_h015_a_355_byte_mint_with_extensions_is_read_alike() {
    // A transfer hook and a metadata pointer, zero-filled to a multisig's length: refused by
    // both; one byte longer, accepted by both.
    let entries = [
        tlv_entry(ExtensionType::TransferHook, &[3; 64]),
        tlv_entry(ExtensionType::MetadataPointer, &[4; 64]),
    ]
    .concat();
    let mut data = token_2022_mint(&entries);
    data.resize(MULTISIG_LEN, 0);
    assert_eq!(token_2022_reading(&data), None);
    assert_eq!(
        check_mint(&TOKEN_2022_PROGRAM_ID, &data),
        Err(MintRefusal::NotAMint)
    );
    data.push(0);
    assert_eq!(token_2022_reading(&data), Some(vec![14, 18]));
    assert_eq!(check_mint(&TOKEN_2022_PROGRAM_ID, &data), Ok(()));
}

#[test]
fn sos_h012_a_refused_extension_after_a_type_0_entry_is_inert_for_token_2022_too() {
    for (refused, value_len) in [
        (ExtensionType::PermanentDelegate, 32),
        (ExtensionType::TransferFeeConfig, 108),
    ] {
        let entries = [
            tlv_entry(ExtensionType::TransferHook, &[3; 64]),
            tlv_entry(ExtensionType::Uninitialized, &[0; 4]),
            tlv_entry(refused, &vec![9; value_len]),
        ]
        .concat();
        let data = token_2022_mint(&entries);
        // The rules accept the mint, and Token-2022 sees only the hook: its walk stops at the
        // type-0 entry, and its lookup of the refused extension does not find it.
        assert_eq!(check_mint(&TOKEN_2022_PROGRAM_ID, &data), Ok(()));
        let state = StateWithExtensions::<Mint>::unpack(&data).unwrap();
        assert_eq!(
            state.get_extension_types().unwrap(),
            [ExtensionType::TransferHook]
        );
        assert!(state.get_extension_bytes::<PermanentDelegate>().is_err());
        assert!(state.get_extension_bytes::<TransferFeeConfig>().is_err());
        assert!(found_alike::<TransferHook>(&state, &data));
        // Without the type-0 entry, both see the refused extension and the rules refuse it.
        let entries = [
            tlv_entry(ExtensionType::TransferHook, &[3; 64]),
            tlv_entry(refused, &vec![9; value_len]),
        ]
        .concat();
        let data = token_2022_mint(&entries);
        assert_eq!(
            check_mint(&TOKEN_2022_PROGRAM_ID, &data),
            Err(MintRefusal::ExtensionNotAllowed(u16::from(refused)))
        );
        assert_eq!(
            token_2022_reading(&data),
            Some(vec![14, u16::from(refused)])
        );
    }
}

/// H015, step 4, pinned: Token-2022 refuses a mint base whose option tag is neither 0 nor 1,
/// and `check_mint`, which reads only the initialized byte, accepts it. No such mint can
/// exist (only SPL Token and Token-2022 write their mints' bytes, and they write 0 or 1), and
/// creating a market's vaults has Token-2022 unpack the mint again.
#[test]
fn sos_h015_check_mint_does_not_read_the_option_tags_only_token_programs_write() {
    let mut data = token_2022_mint(&[]);
    data[..4].copy_from_slice(&[2, 0, 0, 0]);
    assert_eq!(token_2022_reading(&data), None);
    assert_eq!(check_mint(&TOKEN_2022_PROGRAM_ID, &data), Ok(()));
}

/// The side a single-sided seed leaves empty, priced by its virtual reserve, is checked like
/// the other: a mint authority on it is refused, though nothing of it moves.
#[test]
fn sos_h008_the_empty_side_of_a_single_sided_seed_is_checked_too() {
    let mut env = Env::new();
    let seeder = solana_keypair::Keypair::new();
    let kept = MintOptions {
        mint_authority: true,
        ..MintOptions::default()
    };
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint_with(&TOKEN, kept), TOKEN),
    ];
    let params = tax_amm::InitParams {
        virtual_side: 1,
        virtual_reserve: 50_000_000_000,
        ..valid_params(&seeder.pubkey())
    };
    let market = env.create_tax_market(mints, &params).unwrap();
    env.fund(&seeder.pubkey(), &market, [SEEDED[0], 0]);
    assert_refused(
        env.seed(&market, &seeder, [SEEDED[0], 0]),
        StrategyError::MintAuthoritySet,
    );
}

/// A contained mint can't graduate from a launchpad (`HOOK-14`): `pipeline_seed_liquidity`
/// creates and seeds in one call, so the mint can't be bound to the market first, and no
/// transfer of a contained mint not yet bound can go through.
#[test]
fn a_contained_mint_cannot_graduate_from_a_launchpad() {
    let mut env = Env::new();
    let contained = env.create_contained_mint();
    let launch_mints = [(contained, TOKEN_2022), (env.create_mint(&TOKEN), TOKEN)];
    // The mint authority, which `bind` would need, is revoked as a launch does before any
    // seed, so only the hook can refuse.
    let admin = env.admin.pubkey();
    let revoke = spl_token_2022_interface::instruction::set_authority(
        &TOKEN_2022,
        &contained,
        None,
        spl_token_2022_interface::instruction::AuthorityType::MintTokens,
        &admin,
        &[],
    )
    .unwrap();
    env.send(&[revoke], &[]).unwrap();
    let launch = env.launch(launch_mints, SEEDED);
    // The hook's accounts as any caller passes them: the hook program, its validation
    // account and the mint's config, neither of which exists before `bind`.
    let hook = containment_hook_id();
    let pda = |seed: &[u8]| Pubkey::find_program_address(&[seed, contained.as_ref()], &hook).0;
    let mut accounts = launchpad::seed_liquidity_own_accounts(&launch);
    accounts.extend([
        pipeline_client::AccountMeta::new_readonly(hook, false),
        pipeline_client::AccountMeta::new_readonly(pda(b"extra-account-metas"), false),
        pipeline_client::AccountMeta::new_readonly(pda(b"config"), false),
    ]);
    let graduate = env.graduate_instruction(
        &launch,
        SEEDED,
        init_data(&valid_params(&Pubkey::new_unique())),
        accounts,
    );
    let refused = env.send_as_creator(&launch, &[graduate]).unwrap_err();
    // Token-2022 finds no validation account for a mint not yet bound, so it refuses the
    // escrow's transfer before the hook could run.
    assert!(
        refused.contains("Instruction: TransferChecked")
            && refused.contains(&format!(
                "Program {TOKEN_2022} failed: invalid account data"
            )),
        "{refused}"
    );
    assert!(env.svm.get_account(&launch.market_state()).is_none());
}

/// Hardening round 2, R01 (#67): a market an earlier build created, still unseeded when this
/// build replaced it, may hold a mint whose transfer hook this build would refuse at creation.
/// The seed checks the hook again, so such a market never opens. The earlier build is stood in
/// for by writing a foreign hook into the mint after the market's creation, which Token-2022
/// itself never allows.
#[test]
fn sos_r01_a_market_created_before_the_hook_rule_never_opens_with_a_foreign_hook() {
    let mut env = Env::new();
    let seeder = solana_keypair::Keypair::new();
    let hooked = env.create_mint_with_cleared_hook();
    let other = env.create_mint(&TOKEN);
    let params = valid_params(&seeder.pubkey());
    let market = env
        .create_tax_market([(hooked, TOKEN_2022), (other, TOKEN)], &params)
        .unwrap();
    // The extension's value: the hook authority, then the hook program.
    let mut mint = env.svm.get_account(&hooked).unwrap();
    let value = mint.data.len() - 64;
    mint.data[value..value + 32].copy_from_slice(Pubkey::new_unique().as_ref());
    mint.data[value + 32..].copy_from_slice(Pubkey::new_unique().as_ref());
    env.svm.set_account(hooked, mint).unwrap();
    let data = env.svm.get_account(&hooked).unwrap().data;
    assert_ne!(
        find_extension(&data, ExtensionType::TransferHook as u16).unwrap(),
        &[0u8; 64][..]
    );
    env.fund(&seeder.pubkey(), &market, SEEDED);
    let terms = terms_of(&env.tax_market(&market.market_state));
    let seed = seed_instruction(&market, &seeder.pubkey(), SEEDED, terms, vec![]);
    assert_refused(
        env.send(&[seed], &[&seeder]),
        StrategyError::TransferHookNotAllowed,
    );
}
