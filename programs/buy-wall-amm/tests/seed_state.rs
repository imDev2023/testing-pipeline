//! The seed writes the whole market state and nothing else (`INV-OS-6`;
//! docs/spec/pool4-for-solana.md, "The seed", "Market state", "Byte offsets").
//!
//! After creation and after a seed by either route (`seed`, and a launchpad's
//! `pipeline_seed_liquidity`), the market state's 1,024 bytes equal a state built here from
//! the spec alone: every field the spec's "The seed" names written at the offset its table
//! gives, the identity and the creation parameters as created, and every other byte, the
//! reserve included, zero. Compared field by field, so a field the seed forgets (a clock
//! field left at 0 would give the first swap a whole window's decay credit, reference step
//! or floor crawl), writes twice or writes wrong is named. The opening price and liquidity
//! are checked against the spec's formulas in exact wide arithmetic here, not the program's.

mod common;

use buy_wall_amm::config::{MARKET_STATE_SIZE, MIN_SEED_LAMPORTS};
use buy_wall_amm::InitParams;
use common::*;
use pipeline_client::Pubkey;
use proptest::prelude::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const SPEC: &str = include_str!("../../../docs/spec/pool4-for-solana.md");

/// The spec's byte offset table: each field's name, offset and size, in order.
fn rows() -> Vec<(String, usize, usize)> {
    let section = SPEC
        .split("### Byte offsets")
        .nth(1)
        .expect("the spec has a Byte offsets section");
    let rows: Vec<(String, usize, usize)> = section
        .split("\n#")
        .next()
        .unwrap()
        .lines()
        .filter(|line| line.starts_with("| `"))
        .map(|line| {
            let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
            (
                cells[0].trim_matches('`').to_string(),
                cells[1].parse().unwrap(),
                cells[2].parse().unwrap(),
            )
        })
        .collect();
    // The table covers the whole account, field after field, with nothing left over.
    let mut end = 0;
    for (field, offset, size) in &rows {
        assert_eq!(
            *offset, end,
            "{field} starts where the field before it ends"
        );
        end += size;
    }
    assert_eq!(end, MARKET_STATE_SIZE, "the table covers the whole account");
    rows
}

/// A market state built from the spec: every byte zero until a field is set.
struct Expected {
    rows: Vec<(String, usize, usize)>,
    bytes: Vec<u8>,
}

impl Expected {
    fn zeroed() -> Self {
        Expected {
            rows: rows(),
            bytes: vec![0; MARKET_STATE_SIZE],
        }
    }

    /// Writes `value`, the field's little-endian bytes, at the offset the table gives.
    fn set(&mut self, field: &str, value: &[u8]) {
        let (_, offset, size) = self
            .rows
            .iter()
            .find(|(name, _, _)| name == field)
            .unwrap_or_else(|| panic!("the spec's table has no field {field}"));
        assert_eq!(value.len(), *size, "{field} is {size} bytes");
        self.bytes[*offset..offset + size].copy_from_slice(value);
    }

    /// Asserts that `actual` equals this state, naming every field that differs.
    #[track_caller]
    fn assert_eq(&self, actual: &[u8], when: &str) {
        assert_eq!(
            actual.len(),
            MARKET_STATE_SIZE,
            "{when}: the account's size"
        );
        let wrong: Vec<String> = self
            .rows
            .iter()
            .filter(|(_, offset, size)| {
                actual[*offset..offset + size] != self.bytes[*offset..offset + size]
            })
            .map(|(field, offset, size)| {
                format!(
                    "{field}: {:?}, the spec gives {:?}",
                    &actual[*offset..offset + size],
                    &self.bytes[*offset..offset + size]
                )
            })
            .collect();
        assert!(
            wrong.is_empty(),
            "{when}, fields differ from the spec:\n{}",
            wrong.join("\n")
        );
    }
}

/// A market as created, from the spec's "Market state": its identity, its creation
/// parameters, and every other field zero, `seed_time` included.
fn created(
    market: &Market,
    seeder: &Pubkey,
    params: &InitParams,
    slot: u64,
    time: i64,
) -> Expected {
    let program = strategy_id();
    let bump = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &program).1;
    let state = market.market_state;
    let mut e = Expected::zeroed();
    e.set("discriminator", b"BWMARKET");
    e.set("layout_version", &[1]);
    e.set("status", &[1]);
    e.set("authority_bump", &[bump(&[b"authority", state.as_ref()])]);
    e.set(
        "token_vault_bump",
        &[bump(&[
            b"vault",
            state.as_ref(),
            market.token_mint.as_ref(),
        ])],
    );
    e.set(
        "sol_vault_bump",
        &[bump(&[b"vault", state.as_ref(), WSOL.as_ref()])],
    );
    e.set("market_signer", market.market.as_ref());
    e.set("token_mint", market.token_mint.as_ref());
    e.set("wsol_mint", WSOL.as_ref());
    e.set("token_vault", market.token_vault.as_ref());
    e.set("sol_vault", market.sol_vault.as_ref());
    e.set("seeder", seeder.as_ref());
    e.set("creation_slot", &slot.to_le_bytes());
    e.set("creation_time", &time.to_le_bytes());
    e.set("fee_bps", &params.fee_bps.to_le_bytes());
    e.set("wall_split_bps", &params.wall_split_bps.to_le_bytes());
    e.set("reward_share_bps", &params.reward_share_bps.to_le_bytes());
    e.set("fee_recipient", &params.fee_recipient.to_bytes());
    e.set("rewards_recipient", &params.rewards_recipient.to_bytes());
    e.set("cap_floor_bps", &params.cap_floor_bps.to_le_bytes());
    e.set("cap_decay_bps", &params.cap_decay_bps.to_le_bytes());
    e
}

/// What a seed of `x` token units and `y` lamports at `slot` and `time` writes, from the
/// spec's "The seed", into a state as created; `s` is the opening square-root price, which
/// the caller has checked is the spec's.
fn seeded(e: &mut Expected, params: &InitParams, x: u64, y: u64, s: u128, slot: u64, time: i64) {
    let liquidity = {
        // `min(floor(x × s / 2^64), floor(y × 2^64 / s))`.
        let product = mul(&[x], &limbs(s));
        let token_side = product[1] as u128 | (product[2] as u128) << 64;
        token_side.min(((y as u128) << 64) / s)
    };
    let share = |bps: u16| (x as u128 * bps as u128 / 10_000) as u64;
    e.set("status", &[2]);
    e.set("seed_time", &time.to_le_bytes());
    e.set("seeded_tokens", &x.to_le_bytes());
    e.set(
        "cap_floor",
        &share(params.cap_floor_bps).max(1).to_le_bytes(),
    );
    e.set(
        "cap_decay_per_day",
        &share(params.cap_decay_bps).to_le_bytes(),
    );
    e.set("sqrt_price", &s.to_le_bytes());
    e.set("liquidity", &liquidity.to_le_bytes());
    e.set("pool_tokens", &x.to_le_bytes());
    e.set("pool_sol", &y.to_le_bytes());
    e.set("cap", &x.to_le_bytes());
    e.set("decay_time", &time.to_le_bytes());
    e.set("ref", &s.to_le_bytes());
    e.set("ref_time", &time.to_le_bytes());
    e.set("floor", &s.to_le_bytes());
    e.set("floor_time", &time.to_le_bytes());
    e.set("last_slot", &slot.to_le_bytes());
    e.set("last_close", &s.to_le_bytes());
    // The seed counts as the last placement, so the lowest close since it is the opening
    // price (POOL4-50).
    e.set("low_since_placement", &s.to_le_bytes());
    // The reward share's ledgers (POOL4-49) start empty: the cap has not fallen and nothing
    // is retired. Set here so a seed that wrote them would be named.
    e.set("cap_fall_unmatched", &0u64.to_le_bytes());
    e.set("retired_rewardable", &0u64.to_le_bytes());
}

/// A u128 as 64-bit limbs, least significant first.
fn limbs(value: u128) -> [u64; 2] {
    [value as u64, (value >> 64) as u64]
}

/// `a × b` exactly, in limbs, least significant first.
fn mul(a: &[u64], b: &[u64]) -> Vec<u64> {
    let mut out = vec![0u64; a.len() + b.len()];
    for (i, &ai) in a.iter().enumerate() {
        let mut carry = 0u128;
        for (j, &bj) in b.iter().enumerate() {
            let t = ai as u128 * bj as u128 + out[i + j] as u128 + carry;
            out[i + j] = t as u64;
            carry = t >> 64;
        }
        out[i + b.len()] = carry as u64;
    }
    out
}

/// `a <= b`, for limbs of any lengths.
fn le(a: &[u64], b: &[u64]) -> bool {
    let n = a.len().max(b.len());
    let at = |v: &[u64], i: usize| v.get(i).copied().unwrap_or(0);
    for i in (0..n).rev() {
        if at(a, i) != at(b, i) {
            return at(a, i) < at(b, i);
        }
    }
    true
}

/// Asserts `s = floor(sqrt(y × 2^128 / x))`, without the program's maths: exactly when
/// `s² × x <= y × 2^128 < (s + 1)² × x`.
#[track_caller]
fn assert_opening_price(s: u128, x: u64, y: u64) {
    let target = [0, 0, y];
    let square_times_x = |s: u128| mul(&mul(&limbs(s), &limbs(s)), &[x]);
    assert!(
        le(&square_times_x(s), &target) && !le(&square_times_x(s + 1), &target),
        "sqrt_price {s} is not floor(sqrt({y} × 2^128 / {x}))"
    );
}

/// One seed: the token program, the amounts, the parameters, and the clock at creation and
/// at the seed.
#[derive(Clone, Debug)]
struct Case {
    token_2022: bool,
    tokens: u64,
    lamports: u64,
    /// The fee, the wall split, the reward share, the cap floor and the cap decay.
    bps: [u16; 5],
    slot: u64,
    time: i64,
    /// How much later than creation `seed` lands.
    later: (u64, i64),
}

impl Case {
    fn program(&self) -> Pubkey {
        if self.token_2022 {
            TOKEN_2022
        } else {
            TOKEN
        }
    }

    /// Valid creation parameters with these values: no fee recipient when the whole market
    /// share goes to the wall, and a rewards recipient exactly when the reward share is above
    /// 0.
    fn params(&self, seeder: Pubkey) -> InitParams {
        let [fee_bps, wall_split_bps, reward_share_bps, cap_floor_bps, cap_decay_bps] = self.bps;
        let params = InitParams {
            fee_bps,
            wall_split_bps,
            fee_recipient: if wall_split_bps == 10_000 {
                Pubkey::default()
            } else {
                Pubkey::new_unique()
            },
            reward_share_bps,
            rewards_recipient: if reward_share_bps == 0 {
                Pubkey::default()
            } else {
                Pubkey::new_unique()
            },
            cap_floor_bps,
            cap_decay_bps,
            seeder,
        };
        params.validate().expect("valid parameters");
        params
    }

    /// Whether the spec's seed rules accept these amounts and parameters.
    fn opens(&self) -> bool {
        let [_, _, _, cap_floor_bps, cap_decay_bps] = self.bps;
        buy_wall_amm::opening::open(self.tokens, self.lamports, cap_floor_bps, cap_decay_bps)
            .is_ok()
    }
}

/// `seed` after `create_market`: the state as created, then as seeded, or unchanged by a
/// refused seed.
fn seed_route(case: &Case) {
    let mut env = Env::new();
    let program = case.program();
    let token = env.seedable_token(&program);
    env.set_clock(case.slot, case.time);
    let seeder = Keypair::new();
    env.svm.airdrop(&seeder.pubkey(), SOL).unwrap();
    let params = case.params(seeder.pubkey());
    let market = env.create_market(token, program, &params).unwrap();
    let mut expected = created(&market, &seeder.pubkey(), &params, case.slot, case.time);
    expected.assert_eq(&env.market_state(&market), "after creation");

    let (slot, time) = (case.slot + case.later.0, case.time + case.later.1);
    env.set_clock(slot, time);
    let (x, y) = (case.tokens, case.lamports);
    env.fund(&seeder.pubkey(), &token, &program, x, y);
    let seed = seed_ix(&market, &seeder.pubkey(), x, y, vec![]);
    let result = env.send(&[seed], &[&seeder]);
    let after = env.market_state(&market);
    if case.opens() {
        result.unwrap();
        let s = env.state(&market).sqrt_price();
        assert_opening_price(s, x, y);
        seeded(&mut expected, &params, x, y, s, slot, time);
        expected.assert_eq(&after, "after the seed");
    } else {
        assert!(result.is_err(), "a seed the rules refuse: {case:?}");
        expected.assert_eq(&after, "after a refused seed");
    }
}

/// A launchpad's graduation through `pipeline_seed_liquidity`: the market created and seeded
/// in one call, at one clock, with the launchpad's PDA as its seeder whatever the parameters
/// name; or no market at all when the seed rules refuse it.
fn graduate_route(case: &Case) {
    let mut env = Env::new();
    let program = case.program();
    let token = env.seedable_token(&program);
    let (x, y) = (case.tokens, case.lamports);
    let launch = env.launch(token, program, x, y);
    env.set_clock(case.slot, case.time);
    let params = case.params(Pubkey::new_unique());
    let result = env.graduate(&launch, &params, x, y);
    if !case.opens() {
        assert!(result.is_err(), "a graduation the rules refuse: {case:?}");
        assert!(env.svm.get_account(&launch.market_state()).is_none());
        return;
    }
    let market = result.map_err(|e| format!("{case:?}: {e}")).unwrap().market;
    let s = env.state(&market).sqrt_price();
    assert_opening_price(s, x, y);
    let mut expected = created(&market, &launch.seeder, &params, case.slot, case.time);
    seeded(&mut expected, &params, x, y, s, case.slot, case.time);
    expected.assert_eq(&env.market_state(&market), "after the graduation");
}

/// The worked example (docs/spec/pool4-for-solana.md, "Worked example"): 1,000,000 tokens of
/// 6 decimals and 10 SOL, at IMD's launch values.
fn worked_example() -> Case {
    Case {
        token_2022: false,
        tokens: 1_000_000_000_000,
        lamports: 10 * SOL,
        bps: [100, 5_000, 1_500, 2_000, 2_000],
        slot: 5_000,
        time: 1_800_000_000,
        later: (150, 60),
    }
}

#[test]
fn seed_writes_the_worked_example_and_nothing_else() {
    seed_route(&worked_example());
}

#[test]
fn a_graduation_writes_the_worked_example_and_nothing_else() {
    graduate_route(&worked_example());
}

fn case() -> impl Strategy<Value = Case> {
    (
        any::<bool>(),
        // Most seeds open; tiny ones and those below `MIN_SEED_LAMPORTS` are refused.
        prop_oneof![
            1 => 0..100u64,
            2 => 100..1_000_000_000u64,
            3 => 1_000_000_000..1_000_000_000_000u64,
            2 => 1_000_000_000_000..u64::MAX / 4,
        ],
        prop_oneof![1 => 0..MIN_SEED_LAMPORTS, 4 => MIN_SEED_LAMPORTS..1_000 * SOL],
        (
            25..=300u16,
            prop_oneof![0..=10_000u16, Just(10_000)],
            prop_oneof![0..=3_000u16, Just(0)],
            10..=10_000u16,
            0..=10_000u16,
        ),
        1..1_000_000_000u64,
        1_600_000_000..2_000_000_000i64,
        (1..10_000u64, 0..1_000_000i64),
    )
        .prop_map(
            |(
                token_2022,
                tokens,
                lamports,
                (fee, wall, reward, floor, decay),
                slot,
                time,
                later,
            )| Case {
                token_2022,
                tokens,
                lamports,
                bps: [fee, wall, reward, floor, decay],
                slot,
                time,
                later,
            },
        )
}

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(32)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), ..ProptestConfig::default() })]

    #[test]
    fn every_seed_writes_the_spec_state_and_nothing_else(case in case()) {
        seed_route(&case);
    }

    #[test]
    fn every_graduation_writes_the_spec_state_and_nothing_else(case in case()) {
        graduate_route(&case);
    }
}
