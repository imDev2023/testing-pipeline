# Containment hook: maths properties

The properties the containment hook's unlock terms, byte readers and Token-2022 walks always satisfy, and the price of washing a home market to its unlock goal, with how each one is established, in the format of the [tax AMM's list](../tax-amm/maths-properties.md) and the [buy wall AMM's](../buy-wall-amm/maths-properties.md).
Book of Knowledge chose the properties in [Containment hook: hardening](https://github.com/imDev2023/testing-pipeline/issues/74) on 2026-11-22, beside round 1 of the review ([round-1.md](round-1.md)), at the bar's "Test layers" 2 and 3 ([`docs/spec/README.md`](../../spec/README.md#test-layers)), for the rules of [`docs/spec/containment-hook.md`](../../spec/containment-hook.md).
This is an internal verification, never presented as an audit.

**Result: no counterexample is open.**
Every new Kani harness in the default tier is proven (five, each in under a minute); every Proptest property passes its cases (13 tests, 10,000 or 40,000 cases each); and the mutation run of `Execute`'s account checks shows which check refuses each substitution.
One counterexample was found, on a byte layout Token-2022 never creates (a token account of a multisig's length, 355 bytes), and the hook now refuses that length too (TLV-5, review finding H034).
No defect in the hook's maths or readers was found.

## How the properties were chosen

The hook has little arithmetic: comparisons of times and a counter, fixed-offset reads of other programs' accounts, and a TLV walk over Token-2022 extensions.
Book of Knowledge scanned the 14 files of `programs/containment-hook/src/` and `programs/mint-rules/src/lib.rs` at `e4fdcd3` and found 14 regions: the unlock rule (`terms.rs`, `unlock.rs`, the terms `bind` checks), the TLV walk and mint reads (`mint-rules`, `mint.rs`), the transferring flag (`token_account.rs`), the router `Market` read and the addresses derived from it (`router.rs`), the tax AMM market state read (`tax_market.rs`), the validation data (`state.rs`) and the contained and quote sides in `bind`.
Its one economic question, the cost to fake the unlock (the review's T04), lives in the tax AMM's pricing and split and in Pipeline's fees, so it modelled those exactly as well.

It proposed 30 properties in six families, 17 new and 13 already in the repo:

| Family | What it covers | Properties |
| --- | --- | --- |
| TM | The unlock terms (`src/terms.rs`) | TM-1 to TM-6 |
| TLV | Token-2022's TLV layout: the walk, the mint reads, the transferring flag, the constants | TLV-1 to TLV-6 |
| BR | Reading the router's `Market` and the tax AMM's market state | BR-1 to BR-6 |
| HA | The hook's own accounts and `Execute`'s account checks | HA-1 to HA-3 |
| ST | The spec's invariants over a contained token's life (the stateful fuzzer) | ST-1 to ST-6 |
| EC | The price of washing a home market to its goal | EC-1 to EC-3 |

The confirm gate was decided by the session running #74 on 2026-11-22, not by the owner: 12 confirmed and built (TM-4, TM-5, TLV-1 to TLV-5, BR-1, BR-2, HA-2, EC-1, EC-2), 5 deferred with reasons ([Deferred](#deferred)), and the 13 existing ones checked against the code and left as they are.

Out of scope here, because the router or another program owns them:

- The tax AMM's pricing, tax and split maths are proven in [its own list](../tax-amm/maths-properties.md); EC-1 and EC-2 call those functions from the tax AMM crate rather than restating them.
- Pipeline's fees and settlement are proven in Pipeline's own `docs/VERIFICATION.md`; EC-1 and EC-2 call its fee functions from its interface crate.
- Token-2022 is the reference, not a subject: the TLV properties compare our readers with Token-2022's own unpacking (`spl-token-2022-interface` 3.1.2, the version `programs/Cargo.lock` pins).

## How the properties are checked

| Tool | What it gives | Where |
| --- | --- | --- |
| **Kani** 0.67.0 | A proof, for every input within the stated bound, of the Rust itself | `programs/containment-hook/src/terms.rs` and `src/router.rs` (their `proofs` modules), `programs/mint-rules/src/lib.rs` (`cfg(kani)` module) |
| **Proptest** | Random cases of a property against the real functions, compared with Token-2022's unpacking, `pipeline-client`'s codec, or the tax AMM's and Pipeline's own maths; properties that need a case to say anything (Token-2022 must unpack it, both legs must price) run 40,000 cases and fail unless at least 10,000 did | `programs/mint-rules/tests/bok_tlv.rs` (with generators in `tests/bok_bytes/mod.rs`), `programs/containment-hook/tests/bok_readers.rs`, `tests/bok_wash.rs` |
| **LiteSVM** | The compiled program, case by case, and builds with checks removed (the mutation run) | `programs/containment-hook/tests/bok_ha2_substitutions.rs`, `tests/hook_accounts.rs` |
| **Fuzzer** | The spec's invariants after every step of random action sequences | `programs/containment-hook/tests/fuzz.rs` with `tests/support/fuzz.rs` |
| **Exact model** | The wash's cost in integers, against the tax AMM's and Pipeline's rules | a Python model kept with the working files; its figures are below |

Run them (`docs/toolchain.md` has the setup):

```sh
source scripts/toolchain-env.sh && cd programs
cargo kani -p containment-hook -j --output-format=terse        # the default tier
cargo kani -p mint-rules -j --output-format=terse
RUSTFLAGS="--cfg kani_full" cargo kani -p mint-rules \
  --harness proofs::check_mint_never_panics_and_accepts_only_allowed_entries
cargo test -p mint-rules --test bok_tlv
cargo test -p containment-hook --test bok_readers --test bok_wash --test bok_ha2_substitutions
```

CI runs the Kani default tier of the whole workspace in the `kani` job, so the five new harnesses run there (about 90 seconds together), and the Proptest and LiteSVM tests in the `rust` job.

## The properties

IDs are stable; the Kani harnesses and Proptest names carry them.
"Exists" means the property was already established before #74, by the tests named.

### The unlock terms (`src/terms.rs`)

| ID | Property | How | Result |
| --- | --- | --- | --- |
| TM-1 | `check_deadline(now, deadline)` accepts exactly when `0 < deadline - now <= MAX_UNLOCK_DEADLINE_SECS` (90 days), computed in i128 so it never overflows, and names `DeadlineNotInFuture` or `DeadlineTooFar` correctly | Exists: Kani `the_deadline_rule_is_exact_for_every_time`; Proptest `the_deadline_rule_is_exactly_later_than_now_and_at_most_the_longest_deadline`, `the_deadline_rule_near_the_binding`; unit `the_edges_of_the_deadline_rule` | Proven |
| TM-2 | `unlock_due(tax, goal, now, deadline)` is due by the goal exactly when a readable counter is at least the goal (compared in u128), else by the deadline exactly when `now >= deadline`, else not due; an unreadable counter never reaches the goal | Exists: Kani `the_unlock_is_due_exactly_by_the_goal_or_the_deadline` (rerun in 0.18 s); Proptest of the same name and `the_unlock_near_its_edges`; unit `the_edges_of_the_unlock`; LiteSVM `tests/unlock.rs` `the_deadline_unlocks_at_its_exact_second`, `the_goal_unlocks_at_its_exact_unit` | Proven |
| TM-3 | `check_terms` refuses exactly a zero goal (first) or a refused deadline | Exists: Kani `the_terms_refuse_exactly_a_zero_goal_or_a_refused_deadline`; Proptest `the_terms_are_the_goal_rule_then_the_deadline_rule`; LiteSVM `tests/bind_market.rs` | Proven |
| TM-4 | A due unlock stays due: more tax or a later clock never takes it back, and one due by the deadline stays due whatever the counter becomes, readable or not | New: Kani `terms::proofs::a_due_unlock_stays_due_for_every_input`, every input, 0.66 s; the existing Proptest `a_due_unlock_stays_due` | Proven |
| TM-5 | Containment is bounded by the longest deadline: for every binding `check_terms` accepts, `unlock_due` is due for every counter (readable or not) at every time from the binding plus 90 days on, and not due at the binding's own second with a zero counter | New: Kani `terms::proofs::every_bound_token_is_unlockable_by_the_longest_deadline`, every input, 0.26 s | Proven |
| TM-6 | No unlock is due at the moment of binding: the deadline is in the future and the home market's lifetime `tax_collected` is below the goal | Settled by review finding H020's fix (`8482cc3`, `HOOK-42`): `bind` refuses a market whose `tax_collected` is not zero, so the counter is 0 at binding, below any goal TM-3 accepts; LiteSVM `sos_h020_a_market_that_already_collected_tax_is_refused`, `sos_h020_a_market_that_collected_no_tax_binds` (`tests/sos_bind.rs`) | Holds since `8482cc3`; before it, a market traded under another hook could be bound with its goal already met |

TM-4 matters because `unlock` is permissionless and may land slots after its condition first held: a rule that was not monotone would let a market state that became unreadable re-lock a token whose deadline had passed.
TM-5 is the spec's promise to holders stated end to end across both functions; it fails if someone later loosens the deadline check or makes the unreadable branch refuse past the deadline.

### Token-2022's layout (`programs/mint-rules/src/lib.rs`, `src/mint.rs`, `src/token_account.rs`)

| ID | Property | How | Result |
| --- | --- | --- | --- |
| TLV-1 | The walk never panics and terminates; a value it finds lies inside the account right after its own header; `check_extensions` accepting means no refused extension type is reachable; `check_mint` never panics | Kani `proofs::find_extension_never_panics_and_finds_values_after_their_header` (unwind 6, every tail of up to 12 bytes after the account type, every account type and wanted type), 10.6 s; Kani `proofs::check_extensions_accepts_only_allowed_entries` (unwind 9, same bound), 48.9 s; Proptest `tlv_1_the_walk_never_panics_on_any_bytes` and `tlv_1_the_walk_never_panics_on_structured_bytes` (`bok_tlv.rs`), 10,000 cases each; `check_mint` whole in Kani's full tier only (below) | Proven within the bound; passed |
| TLV-2 | `find_extension` returns exactly what Token-2022's `get_extension_bytes` returns, byte for byte, on every mint (types 14, 18, 20) and every account (type 15) Token-2022 unpacks | Proptest `tlv_2_find_extension_reads_what_token_2022_reads_on_mints` and `..._on_accounts`, 40,000 cases each, at least 10,000 unpacked by Token-2022, at least 2,500 with a transfer hook entry | Passed |
| TLV-3 | `check_mint` accepts exactly the Token-2022 mints whose listed extensions are all on the allowlist | Proptest `tlv_3_check_mint_accepts_exactly_token_2022_mints_with_allowed_extensions`, 40,000 cases, at least 2,500 accepted and 2,500 refused | Passed, both directions |
| TLV-4 | `read_mint` reads the mint authority, the freeze authority and the transfer hook's authority and program exactly as Token-2022 does; `bind`'s gate (`check_mint`, then `read_mint`) accepts only bytes Token-2022 unpacks | Proptest `tlv_4_read_mint_reads_what_token_2022_reads` and `tlv_4_binds_gate_accepts_only_mints_token_2022_unpacks` (`bok_readers.rs`), 40,000 cases each | Passed (one Info note below) |
| TLV-5 | The hook reads a source as mid-transfer only where Token-2022 unpacks a token account of the mint with its `transferring` flag set, and wherever Token-2022 wrote the flag as 1; a mint is never read as mid-transfer | Proptest `tlv_5_the_transferring_flag_is_token_2022s` and `tlv_5_a_mint_is_never_mid_transfer`, 40,000 cases each; LiteSVM `sos_h034_a_multisig_length_account_is_not_read_as_mid_transfer` (`tests/sos_token_account.rs`) | Passed after the H034 fix (below) |
| TLV-6 | The layout constants are Token-2022's and defined once: an account's length (165), the transfer hook account extension (15), a mint's length (82), a multisig's length (355) and, with H001's rule, the immutable owner extension (7), in `mint-rules`, checked against `spl_token_2022`'s own values | Deferred to a refactor in this ticket (review note T03, finding H033) | PENDING(session, fix) |

**The TLV-5 change.**
TLV-5's first runs passed; a later run found a counterexample: a 355-byte token account (a multisig's length) with account type 2 and a transfer hook account entry `[1]`, which the hook read as mid-transfer while Token-2022's `StateWithExtensions::<Account>::unpack` refuses every account of `Multisig::LEN`.
It is unreachable: Token-2022 never gives an account with extensions that length (`adjust_len_for_multisig` adds two bytes), and the hook reads only accounts Token-2022 owns.
Book of Knowledge first skipped that length in the property; the review then made the hook agree with Token-2022 exactly (finding H034, `8482cc3`): `is_mid_transfer_data`, and `owner_is_immutable_data` for H001's rule, refuse data of length 355, and the property now asserts that the hook reads no flag at that length instead of skipping it.

**Info notes from these runs.**

- `check_mint` does not read the option tags of the mint's authorities, so on its own it passed 3,565 of 40,000 loose bases Token-2022 refuses; `bind` also runs `read_mint`, which refused every one, so `bind`'s gate holds.
  The tax AMM and the lending AMM call `check_mint` without `read_mint`; that is safe while the mint's owner is Token-2022 or SPL Token, which write only valid tags.
- The hook reads the transferring flag only as byte 1, where Token-2022's `Bool` reads any non-zero byte as set (692 such accounts appeared in one run); stricter, so it fails closed, and Token-2022 writes only 0 or 1.
- A mint whose own first 32 bytes are its key and whose account type byte were rewritten to 2 would read as mid-transfer; Token-2022 never writes such bytes (a mint's type byte is 1), so it is not reachable (found by reading the code, not by a test).

### Reading other programs' accounts (`src/router.rs`, `src/tax_market.rs`, `src/state.rs`, `bind`)

| ID | Property | How | Result |
| --- | --- | --- | --- |
| BR-1 | `read_market` decodes exactly what `pipeline-client` encodes: every field of any `Market` (any keys, 0 to 4 mints, any bumps, any fee mint index) round-trips; trailing bytes change nothing; a mint count above 4, a wrong discriminator or fewer than 372 bytes is refused | Proptest `br_1_read_market_decodes_what_pipeline_client_encodes` and `br_1_read_market_refuses_short_or_foreign_accounts` (`bok_readers.rs`), 10,000 cases each, against `pipeline-client` at `48a6b5f`; examples exist in `tests/layout.rs` | Passed |
| BR-2 | `read_market` never panics and refuses exactly short, foreign or over-full data; `mints()` has exactly `mint_count` entries | Kani `router::proofs::read_market_never_panics_and_bounds_the_mint_count` (unwind 34, every byte string up to 373 bytes), 26.5 s | Proven within the bound |
| BR-3 | The hook reads only whole tax AMM market states, at the published offsets; since `8482cc3` only at the market state version it knows (1) | Exists: `tests/layout.rs` `the_hook_reads_the_tax_side_the_tax_amm_wrote`, `the_hook_reads_only_whole_tax_amm_market_states`, `the_hook_reads_the_tax_collected_the_tax_amm_wrote` and two more; `programs/tax-amm/tests/layout.rs` pins the offsets; the version gate by `sos_h009_*` (`tests/sos_bind.rs`, `tests/sos_unlock.rs`) and a compile-time assert against the tax AMM's `STATE_VERSION` | Holds |
| BR-4 | The contained and quote sides are complementary: the tax side is `1 - contained`, so the goal is counted in the quote mint | Exists: `tests/bind_market.rs` `a_tax_side_on_the_contained_token_is_refused`, `a_market_that_does_not_hold_the_mint_is_refused` | Holds |
| BR-5 | The vault and the fee account are the router's, never the caller's | Exists: `tests/bind.rs` `a_caller_cannot_steer_the_vault_or_the_fee_account`, `a_market_state_naming_another_vault_cannot_steer_it_either`; `tests/bind_market.rs` `a_market_that_is_not_at_its_pda_is_refused`; `tests/trading.rs` | Holds |
| BR-6 | The validation account's data is the transfer hook interface's list of the config | Exists: `tests/validation_account.rs` `the_validation_data_is_the_interfaces_list_of_the_config`, `a_bound_mints_validation_account_resolves_to_its_config` | Holds |

### The hook's own accounts (`src/instructions/execute.rs`)

| ID | Property | How | Result |
| --- | --- | --- | --- |
| HA-1 | Every hook-owned account sits at its PDA: at every fuzzer step, each account the hook owns is a `Config` at `["config", mint]` with its canonical bump or a validation account at `["extra-account-metas", mint]` holding exactly the validation data, for a mint that has a config | Deferred: it touches the shared fuzz harness (`tests/support/fuzz.rs`), which another session is changing; also review finding H007's recommendation | PENDING(session, fix) |
| HA-2 | Which of `Execute`'s checks refuses each substituted hook account | LiteSVM mutation run (below); the case table is committed as `every_substituted_hook_account_is_refused_case_by_case` (`tests/bok_ha2_substitutions.rs`), which passes on the real program | Every case through Token-2022 refused by every build |
| HA-3 | The allow rule: `Execute` passes exactly when the config and validation account are the mint's, the source is a Token-2022 account of the mint mid-transfer, and the source or the destination is the recorded vault or fee account (and, since H001's fix, any other destination's owner can never change) | Exists: fuzzer invariants `contained_tokens_move_only_through_the_home_market`, `a_transfer_missing_a_hook_account_is_refused`; `tests/transfers.rs`; `tests/second_market.rs`; H001's rule by `sos_h001_*` (`tests/sos_h001_account_owner.rs`) | Holds |

### The whole program (the stateful fuzzer)

| ID | Property | How | Result |
| --- | --- | --- | --- |
| ST-1 | Contained tokens move only through the home market | Exists: fuzzer `contained_tokens_move_only_through_the_home_market` | Holds |
| ST-2 | A transfer missing or substituting a hook account is refused | Exists: fuzzer `a_transfer_missing_a_hook_account_is_refused`; `tests/hook_accounts.rs`; `regression_a_transfer_to_the_same_account_moves_nothing_and_skips_the_hook` | Holds |
| ST-3 | The config never changes after binding, except the unlock time, set once | Exists: fuzzer `the_config_never_changes_but_the_unlock_time`; `tests/unlock.rs`, `tests/bind.rs` | Holds |
| ST-4 | `unlock` succeeds exactly when due and clears both hook fields for good | Exists: fuzzer `unlock_passes_exactly_when_due_and_clears_the_hook`; `tests/unlock.rs`; `tests/after_unlock.rs` | Holds |
| ST-5 | Every holder can still sell into the home market | Exists: fuzzer `every_holder_can_sell_into_the_home_market` | Holds |
| ST-6 | ST-1, ST-2 and ST-5 hold under Pipeline 0.3's paths: `route` through the home market and a second tax market, both fee mint kinds, `sweep_fees` and `init_fee_account` | Deferred: it adds fuzzer actions to the shared fuzz harness; the review covered the paths by reading (finding H027, not vulnerable) | PENDING(session, fix) |

### The price of the unlock goal (`tax_amm::pricing::exact_in`, `tax_amm::split::split_tax`, Pipeline's fees)

| ID | Property | How | Result |
| --- | --- | --- | --- |
| EC-1 | An outsider never books tax for less than it costs: a buy of `x` and a sell of everything bought, through the router with Pipeline 0.3's fees on either fee side, leaves the trader at least the tax booked plus Pipeline's quote fees poorer, for every pool, virtual reserve, tax side and rate up to the cap | Proptest `ec_1_an_outsider_never_books_tax_for_less_than_it_costs` (`bok_wash.rs`), 40,000 cases, at least 10,000 priced both legs | Passed |
| EC-2 | A recipient holding slot 0 with share `s` pays at least `(1 - 0.9 s)` of the tax plus Pipeline's fees, less 10 units of split rounding; a sole recipient pays exactly the suite share plus the fees plus the curve's rounding | Proptest `ec_2_a_recipient_pays_at_least_the_suite_share_plus_the_fees`, 40,000 cases, at least 1,000 sole-recipient cases | Passed |
| EC-3 | On the hook's harness, a sole recipient at 10%/10% (and at the v1 range tops 8%/9%) washes to a goal, distributes and unlocks, at the model's cost to within a few lamports a leg; an outsider's same trades cost at least the goal | To be built on the merged shared harness, as review findings H023 and H024's test (`sos_h023_sole_recipient_washes_to_the_goal_and_unlocks`) once owner question 4 is answered | PENDING(session, fix) |

## The T04 cost model

`tax_collected` counts every unit of tax booked, including tax that `distribute` later pays back to the trader who paid it.
So a tax authority that makes itself the sole recipient reaches the goal far more cheaply than a third party.
An exact integer model of the tax AMM's pricing and split and Pipeline 0.3's fees measured the price; EC-1 and EC-2 check its bounds on the compiled functions.

The closed form, with buy rate `b` and sell rate `r` as fractions, Pipeline's fee `f = 0.0025`, the suite share 0.1, and `s` the washer's share of the creator's part of the tax (slot 0, burn share 0):

- One round trip of `x` quote books tax `x * tau`, where `tau = 1 - (1 - b)(1 - r)`.
- On a wrapped SOL quote Pipeline takes `f * x` on the buy and `f * x * (1 - tau)` on the sell (from the SOL output), so the fees are `x * f * (2 - tau)`.
- `distribute` pays the washer back `0.9 * s` of the tax.
- To book a goal `G` it trades `x = G / tau` in all, in one trip or many, and loses

```
cost / G = (1 - 0.9 s) + f (2 - tau) / tau                         (wrapped SOL quote, exact to rounding)

(1 - 0.9 s) + f / tau  <=  cost / G  <=  (1 - 0.9 s) + f (2 - tau) / tau    (any other quote mint)
```

On a quote other than wrapped SOL the sell's fee is paid in the token, worth less on a trip that moves the price, hence the range.
The fee term falls as `tau` rises, so the cheapest wash sets both rates to the cap (`MAX_TAX_BPS`, 10%): 10% + 2.38% = 12.38% of the goal on wrapped SOL, and 11.32% in the limit on another quote mint.
The 10% suite share is the floor for anyone.
Capital is no barrier: the cost is the same in one borrowed trip of `G / tau` or in many trips of any size, and dust legs cost more, since each leg's fee and tax round up.

Measured on a home market of 50 SOL and 10^9 tokens, goal 100 SOL, burn share 0, wrapped SOL quote, every row landing its last trip exactly on the goal:

| Washer, rates | Legs | Net cost | Cost / goal | Closed form |
| --- | --- | --- | --- | --- |
| Sole recipient, 10%/10% | 1 trip of 526.3 SOL, or 53 of 10 SOL | 12.382 SOL | 12.38% | 12.38% |
| Sole recipient, v1 range tops 8%/9% | 1 trip of 614.3 SOL | 12.821 SOL | 12.82% | 12.82% |
| Sole recipient, 5%/5% | 1 trip of 1,025.6 SOL, or 103 of 10 SOL | 14.878 SOL | 14.88% | 14.88% |
| Sole recipient, v1 launch rates 3%/5% | 1 trip of 1,273.9 SOL | 16.119 SOL | 16.12% | 16.12% |
| Sole recipient, 1%/1% | 1 trip of 5,025.1 SOL, or 101 of 50 SOL | 34.876 SOL | 34.88% | 34.88% |
| Recipient with `s` = 75%, 10%/10% | 10 SOL legs | 34.882 SOL | 34.88% | 34.88% |
| Recipient with `s` = 50%, 10%/10% | 10 SOL legs | 57.382 SOL | 57.38% | 57.38% |
| Recipient with `s` = 25%, 10%/10% | 10 SOL legs | 79.882 SOL | 79.88% | 79.88% |
| Recipient with `s` = 10%, 10%/10% | 10 SOL legs | 93.382 SOL | 93.38% | 93.38% |
| Outsider, 10%/10% | 10 SOL legs | 102.382 SOL | 102.38% | 102.38% |
| Outsider, 5%/5% | 10 SOL legs | 104.878 SOL | 104.88% | 104.88% |
| Outsider, 3%/5% | 10 SOL legs | 106.119 SOL | 106.12% | 106.12% |
| Outsider, 1%/1% | 10 SOL legs | 124.876 SOL | 124.88% | 124.88% |

On the same pool quoted in a mint other than wrapped SOL, a sole recipient pays 11.43% at 10%/10% in one trip (12.32% in 10 SOL legs), 12.68% at 5%/5%, and 29.01% at 1%/1% in 50 SOL legs (33.11% in 10 SOL legs).
On wrapped SOL the pool's depth and a virtual reserve change nothing: 5 SOL, 500 SOL and a 30 SOL virtual reserve with no real quote all give 12.38%, since the curve has no LP fee and a buy then a sell of what it bought returns the curve's input to within a few units.

What the figures mean for the product is the review's: findings H023 and H024, and owner question 4 in [round-1.md](round-1.md).

## The mutation run (HA-2)

Review note T01 asked whether `Execute`'s two `create_program_address` checks (the config's and the validation account's addresses, about half of `Execute`'s compute) are needed, given that Token-2022 already derives the validation account and resolves the config before it calls the hook.
Three builds of the hook from `e4fdcd3` were made with checks removed, each built into its own target and output directory, and run against the whole test suite (129 tests in 21 test binaries, and the fuzzer at its default size) and the case table of `tests/bok_ha2_substitutions.rs`:

- **Mutant A**: both `create_program_address` checks removed; the owner, discriminator and `config.mint` checks kept (what T01 proposed).
- **Mutant B**: both owner checks removed; the address checks kept.
- **Mutant C**: both kinds removed.

| Build | Existing tests that catch it | Fuzzer | Substitutions that pass (of 16 cases) |
| --- | --- | --- | --- |
| A | `tests/hook_accounts.rs` `the_hooks_own_checks_refuse_each_substitution_inside_a_transfer` (its case of a hook-owned copy of the config at a new address) | Does not catch it | D2, D6, D7: a hook-owned account away from its PDA, which no transaction can create, and another mint's validation account in a direct call, whose data is the same for every mint and is never read |
| B | `tests/hook_accounts.rs` `a_look_alike_config_owned_by_another_program_is_refused` and `a_look_alike_validation_account_owned_by_another_program_is_refused` | Does not catch it | T5, T6: another program's account at the hook's PDA, which no transaction can create |
| C | The three above | Does not catch it | Nine, including D4: a forged config owned by another program, which anyone can create, in a direct call |

Every case through Token-2022 (T1 to T6, the only way the hook runs on chain) is refused by every build except T5 and T6 under B and C, which need an account no transaction can create.
The direct-call cases (D) need a source already mid-transfer, which only code running inside the token's own transfer could arrange; the hook makes no CPI, so even mutant C opens no known path, but it removes the last check on a forged config.
The fuzzer caught none of the three mutants: its steps never build a hook-owned or look-alike account at the wrong place, which only the hand-built LiteSVM cases do.

The review weighed this against the compute budget and kept both kinds of check, with the two address checks behind one shared helper so they cannot drift apart (`ac0899e`, `HOOK-45`; findings H007, H031 and H032 in [round-1.md](round-1.md)).
HA-1, the property that would make dropping the address checks safe, is deferred with the fuzz harness.

## Deferred

- **TLV-6** (the layout constants defined once in `mint-rules` and checked against Token-2022): a refactor of `src`, done later in this ticket with review note T03 and finding H033. PENDING(session, fix)
- **HA-1** and **ST-6**: both add to the shared fuzz harness, `tests/support/fuzz.rs`, which another session was changing; they land on the merged harness, HA-1 with finding H007 and ST-6 with the fuzzer ownership invariant of finding H092. PENDING(session, fix)
- **EC-3**: built later on the merged harness, as the T04 test of findings H023 and H024. PENDING(session, fix)
- **TM-6**: sent to the review as a hypothesis; it became finding H020, and `bind` now refuses a market that has collected tax (`8482cc3`), which settles it.

## Harnesses in the full tier only

| Harness | File | Why it is in the full tier |
| --- | --- | --- |
| `proofs::check_mint_never_panics_and_accepts_only_allowed_entries` | `programs/mint-rules/src/lib.rs`, `cfg(kani_full)` | The 83-byte padding loop forces an unwind of 84 on every loop; it did not finish in 10 minutes. TLV-1's two default harnesses and its Proptests cover the walk and `check_mint` |

## Run times

Measured on the owner's Mac on 2026-11-22, one harness at a time with a 10-minute limit each.

- **Kani, default tier**: TM-4 0.66 s, TM-5 0.26 s, TLV-1's walk 10.6 s, TLV-1's allowlist 48.9 s, BR-2 26.5 s, and the existing TM-2 harness rerun beside them in 0.18 s.
  Two first runs failed their unwinding assertions because the bounds were set too low (the allowlist's seven-entry loop at unwind 6, the 32-byte key copies at unwind 5); Kani reports that rather than hiding it, and the reruns at unwinds 9 and 34 verified.
- **Kani, full tier**: `check_mint` whole did not finish in 10 minutes.
- **Proptest**: all 13 tests passed; after the TLV-5 change `bok_readers` passed five more runs and `bok_tlv` and `bok_wash` three more each, all with fresh seeds.
- **LiteSVM**: the baseline suite took 41 s; the mutation builds each ran the whole suite once.
