# Containment hook: review round 2

Round 2 of the internal adversarial review of the containment hook (`programs/containment-hook`), run on 2026-11-23 after the round 1 fixes and the owner's answers landed, in [Containment hook: hardening](https://github.com/imDev2023/testing-pipeline/issues/74).
It is not an audit and no external review has been done; [README.md](README.md) says what was reviewed and how, and [round-1.md](round-1.md) describes each original finding.
The agents worked read-only (no builds, no repo writes beyond their notes, free devnet reads only); the session then fixed what they found and ran each test.
Round 2 had four parts:

1. **Verification** of every confirmed or potential finding of round 1, and of the cleared ones whose disposition still asked for a fix or spec text, against the fixed code: H001 to H030 at `e850458`, H031 to H100 at `c4fe317`, each attack re-run by reading, with round 1's exact models rerun where money was involved and live devnet reads for the three contained mints.
2. **An adversarial re-review of the program diff**, `git diff e4fdcd3..c4fe317 -- programs/containment-hook/src programs/mint-rules/src`, read as whole files against Token-2022 6.0.0, the associated token program 6.0.0, Pipeline at `48a6b5f` and the tax AMM, looking for what the fixes broke or missed rather than re-checking round 1 (R2-01 to R2-05).
3. **An adversarial re-review of the tooling** the hardening added at `c4fe317`: the release gate (`scripts/gate_snapshot.py`, `scripts/pre-deploy.sh`, `tests/release_gate.rs` and its fixture), the freeze gate (`scripts/freeze-gate.ts`, `freeze.ts`), Canary's changes for contained markets, and the CI and advisory workflows (R2T-01 to R2T-14).
4. **A final re-review of what changed after the first re-review**, `git diff 961aa2e..d4c1a8c`: the merge of the tax AMM's hardening (#67), `bind`'s quote mint check (answer 3a), the launch script, the shared harnesses and the layout constants (R2-06 to R2-10).

The verification passes also raised three problems of their own (R2-A to R2-C).
Code locations are relative to `programs/containment-hook/` at the commit each part read.

## Summary

- Of round 1's 49 confirmed or potential findings, verification found 31 fixed (by code, a test, spec text or a sign-off), 9 partly fixed, 8 not yet fixed and 1 with no action wanted; H008's new item was fixed, and no fix weakened a check.
  Every one not fixed or partly fixed then was known open work (answer 3a, #67's merge, the fuzzer invariants, the layout constants, spec lines), and each is now fixed, signed off or recorded as not taken ([Verification of round 1](#verification-of-round-1)).
- One regression, in a test, not the program: H001's rule made `tests/second_market.rs` red, since another market's vault has no `ImmutableOwner` (R2-A), fixed.
- The program re-review found no Critical, High or Medium: one Low (R2-01, the release gate could not see a build that loses the goal path) and four Info.
- The tooling re-review found two Medium (R2T-01, the release gate passed vacuously on an empty census; R2T-07, the freeze gate never checked what the configs say), two Low-Medium, eight Low and two Info.
- The final re-review found no Critical, High or Medium in the program: two Low in the test and conformance tooling around `bind`'s new account (R2-06, R2-07) and three Info.
- What was done: every Medium, Low-Medium and Low of round 2 is fixed in this ticket, each pinned by a test, and every tooling test was seen failing without its fix; R2-02, R2-03, R2-04, R2-08, R2T-11 and R2T-14 (Info) are fixed; R2-05, R2-09 and R2-10 (Info) are not, for the reasons below.
  No Low from round 2 is left open, so round 2 adds no sign-off.

## Verification of round 1

Status is the verifier's verdict on the code it read; the disposition is final, as of `1b05d82`.
"Signed off" means accepted as a Low with the owner's sign-off of 2026-11-23 ([sign-offs.md](sign-offs.md)).

| ID | Round 1 severity | Verification status | Final disposition |
| --- | --- | --- | --- |
| H001 | High | FIXED; one test regression (R2-A) | Fixed (`96f625f`, answer 1a); R2-A fixed in `0dc2f0d` |
| H002 | Low | PARTIALLY_FIXED (disclosed; the gate's holder report not built) | Signed off; the release gate's holder report built (`73ffd29`) |
| H003 | Low | FIXED (disclosure, answer 2a) | Signed off |
| H008 | Low (new item) | FIXED | Fixed |
| H009 | Low | FIXED | Fixed |
| H011 | Medium | FIXED | Fixed; the gate hardened by R2T-01 to R2T-06 |
| H012 | Low | FIXED (disclosure) | Signed off |
| H013 | Low | PARTIALLY_FIXED (no test; `tests/second_market.rs` claimed the opposite) | Signed off; the file corrected (`0dc2f0d`) and the test written (`1b05d82`) |
| H014 | Low (Medium on main) | NOT_FIXED (answer 3a not yet built or registered) | Fixed by answer 3a (`83d1216`, `HOOK-52`) |
| H015 | Low | FIXED | Fixed |
| H016 | Low | FIXED (freeze gate) | Signed off until mainnet, the gate built |
| H017 | Low | PARTIALLY_FIXED (R2-B; no executable hash check) | Signed off until mainnet; R2-B and R2T-08 fixed (`43b0ae4`) |
| H018 | Low | PARTIALLY_FIXED (the frozen bytes never compared with the verified build) | Signed off until mainnet; R2T-08 fixed (`43b0ae4`) |
| H020 | Low | FIXED | Fixed |
| H022 | Low (Medium on main) | NOT_FIXED at the time (#67 and answer 8a pending; R2-C) | Signed off; #67 merged (`410f4b3`); the devnet revoke is the session's at the redeploy |
| H023 | Low | FIXED (disclosure, answer 4a; the table recomputed exactly) | Signed off; EC-3's test (`db0a270`) |
| H024 | Low | FIXED (disclosure, answer 4a) | Signed off |
| H025 | Low | FIXED | Fixed |
| H026 | Low | NOT_FIXED (the launch script at #67's merge) | Signed off; the launch order arrived with #67's merge (`410f4b3`) |
| H029 | Low | FIXED | Fixed |
| H030 | Low (Medium on main) | NOT_FIXED (answer 3a not yet built) | Fixed by answer 3a (`83d1216`) |
| H032 | Info | FIXED | Fixed |
| H033 | Info | NOT_FIXED (known open, TLV-6) | Fixed (`d4c1a8c`) |
| H034 | Info | FIXED | Fixed |
| H038 | Info | FIXED (accepted, errors append-only) | Accepted, Info |
| H039 | Info | FIXED (documented) | Accepted, Info |
| H043 | Info | NOT_FIXED | Not taken: both callers check the owner before the byte readers, which stay pure functions of bytes |
| H045 | Info | PARTIALLY_FIXED (`HOOK-02` still said no integrator fee account) | Fixed; `HOOK-02` made exact (`e850458`) |
| H046 | Info | FIXED (spec) | Fixed |
| H049 | Low | FIXED (sign-off) | Signed off |
| H050 | Low | PARTIALLY_FIXED (the never-bound mint not in the spec) | Signed off; spec "Lifecycle" (`e850458`) |
| H051 | Low | PARTIALLY_FIXED (the sign-off named answer 3a, not yet built) | Fixed by answer 3a (`83d1216`) |
| H061 | Info | FIXED (disclosure) | Accepted with H023 (4a) |
| H062 | Info | FIXED (disclosure, answer 6a) | Accepted (6a) |
| H065 | Low | FIXED (sign-off) | Signed off |
| H066 | Low | FIXED (sign-off) | Signed off |
| H067 | Low | FIXED (disclosed; the launch defaults not yet built) | Signed off; the launch script seeds the whole supply (`f7f5154`) |
| H069 | Info | NOT_FIXED | Fixed in the spec (`e850458`) |
| H070 | Low | FIXED (spec and sign-off) | Signed off |
| H072 | Low | FIXED | Fixed |
| H073 | Info | NOT_FIXED | Fixed in the spec (`e850458`); Token-2022's hash not yet in the daily pin check |
| H074 | Info | FIXED | Fixed |
| H075 | Low | FIXED | Fixed; widened by R2T-14 |
| H077 | Info | FIXED | Fixed |
| H092 | Info | PARTIALLY_FIXED (no fuzzer ownership invariant) | Fixed (`db0a270`) |
| H094 | Info | FIXED (disclosed) | Accepted on devnet (`BAR-23`); mainnet under answer 7a |
| H096 | Low | FIXED (spec) | Signed off |
| H097 | Info | PARTIALLY_FIXED (the order stated, not its reason) | Not taken, Info |
| H098 | Info | No action wanted | No action |
| H100 | Info | FIXED (spec) | Fixed |

Cleared in round 1 and acted on anyway:

| ID | Verification status | Final disposition |
| --- | --- | --- |
| H007 | NOT VULNERABLE, still, after the helper refactor | Hardened (`HOOK-45`); HA-1's fuzzer invariant built (`db0a270`) |
| H010 | NOT VULNERABLE, still (`unlock.rs` unchanged) | No action; the release gate unlocks every devnet config with the candidate |
| H027 | FIXED (spec) | Fixed |
| H031 | FIXED (kept, behind one helper) | Hardened |
| H042 | FIXED (the version gate makes the length check part of the reader) | No action needed |
| H085 | PARTIALLY_FIXED (the compute test covers the rule; the spec's figures predate it) | Covered by `execute_stays_under_its_ceiling_on_every_hooked_transfer`; the spec's "Measured" table still shows the earlier figures |
| H088 | FIXED (spec) | Fixed |
| H090 | NOT_FIXED | Fixed in the spec (`e850458`) |
| H099 | NOT_FIXED | Fixed in the spec ("Checks on the home market", `f01f15d`) |

### What the verifiers checked beyond the statuses

- H001: the round 1 attack fails at the buy, since the keypair account never receives the token; every path of round 1's table (buy, `route` hops, the fee on the output, sells, `sweep_fees` into the treasury's associated account, `seed`, `distribute`) behaves as predicted; a delegate approved for a whole balance can only sell into the vault and is revocable by the owner, so a delegation is a revocable claim, the H003 class, not a new channel.
- H008: a legacy SPL Token multisig as mint authority is treated by Token-2022 itself as a single signer, so refusing only Token-2022-owned authorities matches Token-2022's own rule.
- H020: the zero counter cannot be griefed by a front-run swap, since before `bind` every transfer of the mint is refused and the market cannot trade.
- H009: the hook's exact version 1 agrees with #67, which keeps `STATE_VERSION` at 1 and refuses newer versions.
- H023: every cell of the spec's table was recomputed exactly from its closed form and matches the simulated round trips; the 11.43% for a quote other than wrapped SOL holds for a 50 SOL pool and runs from about 11.3% to 11.9% with the pool's depth.

## New findings in the program (R2-01 to R2-10)

| ID | Title | Status | Severity | Disposition | Fix commit | Test |
| --- | --- | --- | --- | --- | --- | --- |
| R2-01 | The release gate approves a build that reads a live market state as unreadable, so every goal unlock silently falls to the deadline; an exact `KNOWN_VERSION` makes any future version bump do that to every live market | Confirmed (process) | Low | Fixed by the gate's goal unlock (with R2T-02); the exact version match stays (`HOOK-43`) | `73ffd29` | `sos_r2t02_the_gate_unlocks_by_the_goal`, `sos_r2t02_the_gate_refuses_a_counter_misread` (`tests/release_gate.rs`) |
| R2-02 | `owner_is_immutable_data` accepts an `ImmutableOwner` entry of any length, where Token-2022 counts only an empty one | Confirmed (unreachable) | Info | Fixed: only an empty entry counts | `961aa2e` | `sos_r2_02_only_an_empty_immutable_owner_entry_counts` (`tests/sos_token_account.rs`) |
| R2-03 | `MintAuthorityIsMultisig` refuses every Token-2022-owned signer, not only multisigs | Confirmed | Info | Spec fixed ("Binding": which signers the check refuses, and why none is a launcher's key); the wider rule kept | `961aa2e` | `sos_h008_a_multisig_mint_authority_signed_by_its_creation_key_is_refused` |
| R2-04 | The zero-counter rule is a counter baseline, not "never traded": a market that traded at 0% tax passes | Confirmed | Info | Spec fixed ("Checks on the home market") | `961aa2e` | - |
| R2-05 | `source_release: "0.1.1"` names no tag | Confirmed | Info | Not changed: the code comment already says the field is the crate's version, which `tests/security_txt.rs` keeps equal; no tag is made | - | `the_built_program_embeds_its_security_txt` |
| R2-06 | The tax AMM's shared harness builds `bind` with the old account list (no quote mint), so four tax AMM test sites and its fuzzer's contained world panic against the new hook | Confirmed | Low | Fixed: `Env::contain` passes the market's other mint before the system program | `db0a270` | the tax AMM's tests that bind through `contained_market` (`programs/tax-amm/tests/trade.rs`, `compute.rs`, `conformance.rs`, `fuzz.rs`) |
| R2-07 | The known-failure judges read only a check's message, which names only the first mismatch, so a sell mismatch could hide behind a buy refusal | Confirmed | Low | Fixed: a known check is accepted only when every failed swap or trip in its details is the hook's refusal, in the hook's and the tax AMM's conformance tests and the launch script | `db0a270` | `known_failure_is_the_hooks` (`programs/tax-amm/tests/common/mod.rs`) in both conformance tests; `conformance.test.ts` (a second swap failing for another reason is refused) |
| R2-08 | The tax AMM's quote list and authority rule are compiled into the hook, and nothing says so | Confirmed | Info | Spec fixed ("Checks on the home market"): a change to either changes the hook's bytes and goes through the hook's release gate; no pinning test of the list was added | `db0a270` | `sos_h014_a_quote_list_mint_may_keep_its_authorities` (reads the list from the crate) |
| R2-09 | `check_quote_mint` reads a transfer hook entry of the wrong length as no hook, where the tax AMM refuses it, and reports a quote with a refused extension as `NotAMint` | Confirmed (unreachable) | Info | Not fixed (below) | - | - |
| R2-10 | The launch script checks a given `--quote-mint` against nothing before sending, so a refused `bind` can leave a created market that can never be bound | Confirmed | Info | Not fixed (below) | - | - |

The program re-review found no account a contained token can now reach whose owner can change, and no legitimate flow that meets the new refusal: buys, sells, seeds, donations, `sweep_fees` into the treasury's associated account, `distribute`, `route` hops, the launch script and the live token's holders all pass, and every devnet holder of a contained token is an associated token account or the market's own vault, so the redeploy strands no one.
It cleared nested owners (`RecoverNested` needs both accounts under the same token program and is refused while contained), close and re-create (a non-native account closes only empty), the 355-byte refusal (Token-2022 never creates that length), the shared PDA helper, the compute of the destination walk (the passing case costs what the measured buy costs, 5,675 of 10,000) and the Kani modules (none changes program bytes).
The final re-review found that `bind`'s quote check does what answer 3a asked, refusing no legitimate quote (both native SOL mints, devnet USDC on the list, a fresh mint revoked before `bind`, a Token-2022 quote with metadata or a cleared hook), that the facts it checks hold for the life of the binding, and that the account order change fails closed between any old and new client and program.

### R2-01: the release gate could not see a lost goal path

The gate's "unlock refused before it is due" step computed the expected counter with the hook's own reader, compiled from the candidate's tree, so a candidate that misread the counter as unreadable or low agreed with itself, and the only unlock the gate required was the deadline's.
A future tax AMM version bump with `KNOWN_VERSION` raised to match would have made every live version 1 market unlock only at its deadline, up to 90 days later, with nothing visible failing.
Liveness only and bounded by the deadline, so Low.
Fixed with R2T-02: for each contained config, in fresh VMs, the gate writes the market state's `tax_collected` through the tax AMM's own `TaxMarket` layout, requires one unit below the goal to be refused and the goal to unlock before the deadline, so any build that loses the goal path fails the gate.
The reviewer's second suggestion, reading every version from 1 to `KNOWN_VERSION` in the hook, was not taken: the exact match stays, as `HOOK-43` records, and the gate now catches the case it would have prevented; after both programs are frozen together (`HOOK-51`) it cannot arise.

### R2-09 and R2-10: not fixed

R2-09: a transfer hook extension of the wrong length is one Token-2022 never writes and never honours (its own `get_extension` fails, so it calls no hook), so reading it as no hook agrees with Token-2022, and the tax AMM's creation and seed checks refuse such a mint anyway; the misleading `NotAMint` for a quote with a refused extension is reachable only for a market a looser tax AMM created.
R2-10: the launch script reads the quote mint's owner before sending, and the program refuses every other failing quote on chain in `bind`, so nothing unsafe can be bound; the cost of a refused `bind` sent after the market's creation is that launcher's listing fee and rent, on a quote the launcher chose.
Both are Info and need no sign-off.

## New findings in the tooling (R2T-01 to R2T-14)

Each test below was seen failing with its fix taken out (a stub of the fix, or the script at `c4fe317`), then passing.

| ID | Title | Severity | Disposition | Fix commit | Test |
| --- | --- | --- | --- | --- | --- |
| R2T-01 | The release gate passes vacuously when it sees no configs | Medium | Fixed: a census of every hook-owned account in `manifest.json`, checked against the files; the program id checked against the build's `declare_id!`; a deployed hook with no config, or on devnet a census missing a fixture config or a launch-record mint, refused unless an override names why | `73ffd29` | `sos_r2t01_the_gate_refuses_a_snapshot_missing_a_config`, `sos_r2t01_the_gate_refuses_another_program_id`, `sos_r2t01_a_deployed_hook_with_no_config_is_refused_unless_allowed` |
| R2T-02 | The release gate never unlocks by the goal | Low-Medium | Fixed: the goal unlock above, with the counter written through the tax AMM's `TaxMarket` | `73ffd29` | `sos_r2t02_the_gate_unlocks_by_the_goal`, `sos_r2t02_the_gate_refuses_a_counter_misread` |
| R2T-03 | The release gate skips `Execute`'s fee account, its refusals and `bind` | Low | Fixed: a buy into an account without `ImmutableOwner` and a direct `Execute` refused, the fee account paid and swept where the fee is in the token (devnet's token 3 runs that path), and a fresh mint bound and seeded once per run; contained readings go from 7 steps to 12 | `73ffd29` | `sos_r2t03_the_gate_runs_the_fee_account_and_the_refusals`, `sos_r2t03_a_build_that_cannot_bind_fails_the_gate` |
| R2T-04 | The gate knows devnet by its URL, while the deploy accepts any devnet RPC | Low | Fixed: devnet known by its genesis hash in the gate and `pre-deploy.sh` | `73ffd29` | `sos_r2t04_devnet_is_known_by_its_genesis_hash` |
| R2T-05 | `pre-deploy.sh` reads any `solana program show` failure as "not deployed" | Low | Fixed: deployment read with `getAccountInfo` in the snapshot script, an RPC error stops the copy, and configs require the deployed tax AMM | `73ffd29` | `sos_r2t05_the_snapshot_stops_on_an_rpc_error` |
| R2T-06 | A reused `HOOK_GATE_DIR` feeds stale files to the gate | Low | Fixed: the folder must be empty or new, the report goes beside the copy, and the gate loads only what the manifest lists | `73ffd29` | `sos_r2t06_a_stale_snapshot_folder_is_refused` |
| R2T-07 | The freeze gate never checks what the hook-owned accounts say | Medium | Fixed: `judgeConfig` checks each config's market, market state, vault, fee account, quote mint, goal, deadline, canonical bumps, version and unlock time against the chain, and each validation account against `VALIDATION_DATA` | `43b0ae4` | `freeze.test.ts` (a refusal per field, a real devnet config agreeing with the chain) |
| R2T-08 | The freeze gate does not pin which programs and bytes it freezes | Low-Medium | Fixed: every config's market must run on `--tax-amm`; each program's executable hash must equal the deploy record's (or the hash given locally, required with `--freeze`); both programs are read again right before signing | `43b0ae4` | `freeze.test.ts` (`executableHash` against a known SHA-256, a market on another strategy refused) |
| R2T-09 | The freeze gate's check passes a half-frozen pair and zero configs | Low | Fixed: `judgePrograms` refuses a half-frozen pair; a census missing recorded mints is refused through R2-B | `43b0ae4` | `freeze.test.ts` (all four frozen and upgradeable combinations) |
| R2T-10 | Canary's known-failure rule matches the error number from any program | Low | Fixed: Canary probes a buy into an account without `ImmutableOwner` itself and excuses the trader-account checks only when it fails with 6023 raised by the hook program, on the mint's home market | `3d7d4fd` | `a_6023_from_another_program_is_not_excused`, `the_known_failures_count_off_the_contained_mints_home_market` (`crates/canary/tests/contained_home_market.rs`) |
| R2T-11 | On contained markets `pipeline-check`'s buy-side checks pass on sells alone | Info | Fixed: the reason says which checks covered only the sell direction, listed in `numbers.canary_known_partial` | `3d7d4fd` | `conformance_counts_pipeline_checks_trades_refused_for_its_traders_accounts_as_known` |
| R2T-12 | `outside_supply` misses a strategy whose quote pays out more than its real reserve | Low | Fixed: such a quote counts as refused (`CANARY-47`) | `3d7d4fd` | `a_quote_paying_more_than_the_real_reserve_counts_as_refused` (`crates/canary/tests/outside_supply.rs`) |
| R2T-13 | `CANARY_PATHS` misses the hook's other build inputs | Low | Fixed: `mint-rules`, `tax-amm`, the workspace lock file and toolchain, and the build scripts added | `3d7d4fd` | `scripts/check-canary-paths.py`, run first in the canary job |
| R2T-14 | The advisory job leaves three lock files and the npm tree unaudited | Info | Fixed: every tracked `Cargo.lock` audited with `--deny unsound`, `pnpm audit --prod`, and a failed scheduled run opens or updates an issue; one advisory in `scripts/quote-devnet` updated and one ignored there with its reason | `3d7d4fd` | the workflow itself |

The spec's "Upgrade policy" and `HOOK-46` say what both gates now check (`60222bf`).
The tooling re-review cleared the snapshot's offsets against the pinned `Config` and the router `Market`, the fail-closed handling of a missing account, the unlocked-config path, the clock, each config running in a VM of its own, the freeze gate's program data parsing and loader `SetAuthority`, its one-transaction freeze and after-check, its refusal of mainnet and testnet, Canary's token account writer against the associated token program's layout, and the advisory job's cache.

After the fixes, `pre-deploy.sh --url devnet` with the current build passed every census, bind and config step (six configs, three contained, no warnings), `freeze-gate.ts --cluster devnet` passed, and `cargo test -p containment-hook --test release_gate` passed 16 tests.

## Problems raised by the verification (R2-A to R2-C)

| ID | Problem | Severity | Disposition | Fix commit | Test |
| --- | --- | --- | --- | --- | --- |
| R2-A | `tests/second_market.rs` bought into a second tax market's vault and expected success; that vault has no `ImmutableOwner`, so H001's rule refuses the buy, and the spec cited the test for the opposite | Info (a test regression that blocked CI) | Fixed: the test now expects the refusal with the vault's balance unchanged, and the file's header is corrected | `0dc2f0d` | `a_buy_delivered_into_a_second_markets_vault_is_refused_and_a_balance_there_is_never_traded` |
| R2-B | The freeze gate finds contained mints only through live configs, which the hostile upgrade it guards against could close | Low | Fixed: every contained mint ever recorded (the launch record, the release gate's fixture and reports, or `--mints` locally) must still have its config | `43b0ae4` | `freeze.test.ts` (recorded mints gathered and a missing one refused) |
| R2-C | The record was behind the code and ahead of it in places: `round-1.md` still carried its pending statuses, answer 3a was in no decision or spec line, the spec said a seeded home market's mint has no mint authority before #67 had merged, and two sign-off rows described work not yet done | Info | Fixed: 3a built and registered (`83d1216`, `f01f15d`, `HOOK-52`); the spec's line true since #67's merge (`410f4b3`); H026's launch order arrived with that merge; H022's row now says the devnet revoke is the session's at the redeploy; `round-1.md` carries final statuses | - | - |

## Notes the verifiers left

These have no security effect; they are recorded so they are not lost.

- The spec's "Measured" table and `HOOK-45`'s "near 5,700" predate H001's destination walk; `tests/compute.rs` holds every hooked transfer under the 10,000 ceiling either way (H085).
- `tests/compute.rs`'s `a_buy_calls_the_hook_at_the_deepest_level_devnet_allows` still frames level 4 as the deepest allowed, where the spec now says 4 of 5 on a direct buy (H046).
- The spec's 11.43% for a sole recipient on a quote other than wrapped SOL holds for a 50 SOL pool; it runs from about 11.3% to 11.9% with the pool's depth (H023).
- The spec's "What it is" still says third-party LPs cannot vamp the token; "What the hook cannot see" qualifies it (H003).
- The tooling re-review's one leftover, `cargo fmt --check` on `tests/sos_token_account.rs`, was fixed in `3388ade`.
- Open questions the tooling reviewer raised, not taken in this ticket: whether the hook's release gate should also run on a tax AMM redeploy (it can already take a candidate tax AMM through `HOOK_GATE_TAX_AMM`), and whether `pipeline-check`'s report carries transaction logs (R2T-10's fix does not depend on it).
