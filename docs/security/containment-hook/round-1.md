# Containment hook: review round 1

Round 1 of the internal adversarial review of the containment hook (`programs/containment-hook`), done in [Containment hook: hardening](https://github.com/imDev2023/testing-pipeline/issues/74), as the engineering and security bar requires ([`docs/spec/README.md`, Internal adversarial review](../../spec/README.md#internal-adversarial-review), [`BAR-18`](../../decisions.md#bar-18-hardening-ticket)).
Code locations are at `e4fdcd3`, relative to `programs/containment-hook/` unless they start with `docs/` or `programs/`.
The maths properties proven beside it are in [maths-properties.md](maths-properties.md).

**This is not an audit.**
It is an internal adversarial review, run by agents inside the project's own hardening ticket with two skills from MetalLegBob's MIT-licensed Solana Vibes Kit: Stronghold of Security, which looks for attacks, and Book of Knowledge, which chooses the maths properties to prove.
It is not independent, it guarantees nothing, and it must never be presented as an audit, in metadata or anywhere else ([`BAR-19`](../../decisions.md#bar-19-code-review-and-what-reviews-are-called)).
No external review of this program has been done.
An independent external review stays on the checklist for any mainnet deployment, which waits for Pipeline's router to reach mainnet anyway.

The investigators' working files stay out of the repo; this record summarises them.
Statuses are final as of 2026-11-23: they follow the owner's answers 1a to 8a of 2026-11-23, recorded on [#74](https://github.com/imDev2023/testing-pipeline/issues/74), and the fixes this ticket landed up to `1b05d82`; round 2 ([round-2.md](round-2.md)) verified each.
"Signed off" means accepted with the owner's written sign-off of 2026-11-23 ([sign-offs.md](sign-offs.md)).

## What was reviewed

- The program: `programs/containment-hook/src/` at commit `e4fdcd3` (13 files, about 1,330 lines with the proofs and tests inside them, about 1,000 of program code), the scope of every finding with an `H` number, and the shared crate it links, `programs/mint-rules/src/lib.rs` (167 lines).
- The deployed program `aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv` is a verified build of `77b6ddc`, whose hook logic equals `e4fdcd3`'s (H019).
- As context only, read and never under review: the tax AMM's source on main and on #67's branch (`imDev2023/build-67` at `b85b6ff`, about to land), Pipeline's router at `48a6b5f` (read from the project's fixture, never copied: it is BSL 1.1), Token-2022 6.0.0 and v11.1.0, and `spl-transfer-hook-interface` 0.9.0 and 2.1.0.
- Findings are judged against main's tax AMM and against #67's: the severity for the record is the one with #67, and the "main only" column says where main alone is worse.

When: from 2026-11-22 to 2026-11-23.
Book of Knowledge ran on 2026-11-22; Stronghold of Security ran from 2026-11-22 23:09 UTC to 2026-11-23 00:30 UTC; the session's fixes landed on this branch from 2026-11-22 23:35 UTC to 2026-11-23 00:54 UTC.
The owner answered the eight questions on 2026-11-23, and the fixes those answers chose, with round 2's, landed the same day, up to `1b05d82` at 15:31 UTC.

## How

**Stronghold of Security, at the "deep" tier** (forced by the ticket's brief; the code's size alone would have chosen "quick"):

1. Scan: an index of the 14 files (1,493 lines with `mint-rules`), a static pre-scan (109 pattern locations, 44 of them high risk) and the reviewer's 20 target hot spots (HS-01 to HS-20: 9 high, 9 medium, 2 low), with the knowledge-base patterns to load.
2. Analysis: nine context reviewers, one per focus area (access control, arithmetic, state machine, CPI and external calls, token economics, oracle and data, upgrade and admin, timing and ordering, the economic model), each quality-gated.
3. Strategy: one architecture document, then 100 attack hypotheses (H001 to H100; 11 in tier 1, 19 in tier 2, 70 in tier 3; 55 specific to this code), including the ticket's four named areas and its six notes T01 to T06.
4. Investigation: every hypothesis taken to a verdict by an investigator, in batches of five, with exact-integer models of the money paths and read-only devnet RPC reads and simulations; no build was run in this phase, so the LiteSVM results it quotes are this ticket's and Book of Knowledge's.
5. Coverage: 3 of 3 instructions, 4 of 4 named areas, 6 of 6 T-notes, 33 knowledge-base exploit patterns cited and the rest covered in substance, 12 of 12 applicable items of the AMM playbook's red-flag list and 15 of 15 of the Token-2022 checklist; one gap check (G001, not vulnerable).
6. Report: the calibrated table of all 100, severity calibration, combination analysis, attack trees, test gaps and the owner's questions.

**Book of Knowledge**, beside it ([maths-properties.md](maths-properties.md)): 14 regions of maths and byte reads indexed, 30 properties proposed, 12 confirmed and built as Kani harnesses, Proptest properties and a LiteSVM mutation run, and the exact cost model of washing a home market to its goal (T04).

**Fixes**: the session took the review's session defaults and landed them on this branch, each pinned by a regression test named `sos_<finding id>` where the finding called for one; the design choices waited on the owner's eight questions, answered 1a to 8a on 2026-11-23 ([The owner's answers](#the-owners-answers)).
Each `sos_` refusal test of the session's first fixes was run against the unfixed program and failed there, then passed with the fix; the complements that pin behaviour which already held (an associated token account still passes, a market with no tax binds) pass either way.

| Commit | What it does | Findings |
| --- | --- | --- |
| `96f625f` | `Execute`'s destination rule: a destination other than the vault and the fee account must carry `ImmutableOwner`; error `DestinationOwnerCanChange` appended | H001, H092 |
| `8482cc3` | `bind` refuses a market that has collected tax, a Token-2022 multisig mint authority and a market state of a newer version; `unlock` reads such a state as unreadable; the 355-byte look-alike refused | H008, H009, H015, H020, H025, H034, H057 |
| `dfd1845` | The release gate: a snapshot of every devnet config, a LiteSVM replay of each with the candidate build, `scripts/pre-deploy.sh`, the v1 `Config` bytes pinned, the tax AMM id pinned to devnet's | H011, H029, H072 |
| `ac0899e` | `Execute`'s two address checks kept behind one helper; spec text for the version gate, the zero counter, the call depth and the fee account's dependency | T01, T02 (H007, H031, H032), H009, H020, H027, H046, H070 |
| `360c40d` | Book of Knowledge's harnesses and tests | TLV-5 with H034 |
| `e013ef5` | A daily dependency advisory check of both lock files, and `url` 2.5.9 for RUSTSEC-2026-0592 | H075 |
| `cd3ff13` | Release 0.1.1: `security.txt` names its release, the IDL test pins every error in order, IDL and client regenerated | H074, H077 |
| `678a83f` | Decisions `HOOK-42` to `HOOK-46` and `BAR-46`; the spec for the multisig rule, `Execute`'s checks, the frozen layout and the release gate | H008, H011, H034 |
| `6e9b91f` | The hook's conformance test counts `pipeline-check`'s two checks on its own trader accounts as known failures, for exactly `DestinationOwnerCanChange` (answer 1a) | H001 |
| `9a43cea` | The owner's answers in the spec and the register (`HOOK-47` to `HOOK-51`; `HOOK-01`, `HOOK-11`, `HOOK-17`, `HOOK-18` changed) and the sign-offs | H001, H002, H003, H012, H013, H016 to H018, H023, H024, H045, H049, H061, H062, H066, H067, H088, H096, H100 |
| `a557942` | The freeze gate: every contained mint's hook fields against its config and both programs' upgrade authorities, and with `--freeze` (local only) both programs frozen in one transaction (answer 7a) | H016, H017, H018 |
| `9ce990b`, `dea4daf`, `dbe63ad` | Canary's traders' Token-2022 accounts carry `ImmutableOwner`, and its known failures on contained markets follow `HOOK-47`; Canary's CI job runs when the hook changes | H001 |
| `c4fe317` | Canary 0.3.1's `outside_supply` check (`CANARY-47`, answer 5a) | H067 |
| `e850458` | The spec on the never-bound mint, burning and minting, CPI Guard and memos, Token-2022 as a dependency; `HOOK-02` made exact | H045, H050, H069, H073, H090 |
| `73ffd29` | The release gate reports balances in accounts whose owner can change (with round 2's gate fixes) | H002 |
| `410f4b3` | Merge of the tax AMM's hardening (#67): the seed refuses a live mint authority and a non-listed quote with an authority, and the launch script revokes the mint authority between `bind` and the seed | H014, H022, H026, H030 |
| `0dc2f0d` | The shared harness writes Token-2022 accounts with `ImmutableOwner` as real ones carry it; another market's vault refused as a buy's destination | H001 |
| `83d1216`, `f01f15d` | `bind` checks the home market's quote mint: no live transfer hook, and no mint or freeze authority unless on the tax AMM's quote list (`HOOK-52`, answer 3a) | H014, H030, H051, H099 |
| `f7f5154` | The launch script seeds the whole supply, so none is held outside the pool (answer 5a) | H067 |
| `d4c1a8c` | The token account layout constants live once, in `mint-rules`, checked against Token-2022's own (TLV-6) | T03, H033 |
| `db0a270` | The fuzzer's invariants HA-1, the ownership invariant and ST-6, and EC-3's wash to the goal | H007, H023, H092 |
| `1b05d82` | H013's test: a market on Pipeline's hostile test strategy naming the home vault strands what it buys | H013 |

Round 2's own findings and their fixes are in [round-2.md](round-2.md).

## Outcome

No Critical finding.
One High (H001) and one Medium (H011), both fixed on this branch; the owner chose H001's design on 2026-11-23 (answer 1a, `HOOK-47`).
On main's tax AMM alone three more findings were Medium (H014, H022, H030); #67's creation and seed rules close all three for new markets, so they are Low with #67, and #67 is now merged into this branch (`410f4b3`); `bind`'s own quote mint check (answer 3a, `83d1216`) fixes H014 and H030 in the hook as well.
No Critical, High or Medium finding is open; every Low left open is accepted with the owner's sign-off of 2026-11-23.
The program-level code is clean: every account the hook reads is pinned by owner, discriminator, length and address; no arithmetic can wrap; only the three handlers are compiled; the unlock is once-only and final; and no substitution of a hook account reaches a passing `Execute` (H007, 26 cells).

| Verdict | Count |
| --- | --- |
| Hypotheses investigated | 100, plus one gap check (G001) |
| Confirmed | 21 |
| Potential | 28 |
| Not vulnerable | 51, of which 20 carry an Info note and one (H008) a new Low item |
| Needing manual review | 1 in part (H019's byte equality, moot after the next verified redeploy) |

Verdicts count the first word of each finding's status: H014 and H022 are confirmed on main and potential residues with #67.

| Severity | With #67 (record) | Main only | Fixed in code or tests | Fixed in the spec | Accepted or signed off | Not taken | No action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Critical | 0 | 0 | - | - | - | - | - |
| High | 1 (H001) | 1 | 1 (H001, design by answer 1a) | - | - | - | - |
| Medium | 1 (H011) | 4 (H011, H014, H022, H030) | 1 (H011) | - | - | - | - |
| Low | 29 | 26 | 11 (H008, H009, H014, H015, H020, H025, H029, H030, H051, H072, H075) | - | 18, signed off (H002, H003, H012, H013, H016, H017, H018, H022, H023, H024, H026, H049, H050, H065, H066, H067, H070, H096) | - | - |
| Info | 39 | 39 | 8 (H032, H033, H034, H057, H074, H077, H085, H092) | 10 (H027, H045, H046, H069, H073, H088, H090, H097, H099, H100) | 5 (H038, H039, H061, H062, H094) | 1 (H043) | 15 |
| None (cleared, no note) | 30 | 30 | 2 hardened anyway (H007, H031) | - | - | - | 28 |

On main's tax AMM alone H014 and H030 were Medium, fixed in the hook by answer 3a, and H022 was Medium, closed for new markets by #67's seed rule and signed off for the devnet markets seeded before it.
Most of the 18 signed-off Lows are disclosed in the spec or on Aviary's panel as well, and several carry tooling built in this ticket (the freeze gate for H016 to H018, the release gate's holder report for H002, H013's test, Canary's `outside_supply` for H067); [sign-offs.md](sign-offs.md) gives each reason.
The 15 Info notes with no action are H019 (moot once the hardened build is deployed and verified), H042, H044, H047, H052, H060, H063, H064, H068, H071, H078, H084, H086, H093 and H098.

## Findings

Every confirmed or potential finding, and the cleared ones the ticket hardened or acted on.
Severity "-" means cleared with no note.

| ID | Title | Verdict | Severity (with #67) | Main only | Status | Fix commit | Regression test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H001 | An owner change (`SetAuthority(AccountOwner)`) moves a contained balance with no hook call | Confirmed | High | High | fixed; design chosen by answer 1a (`HOOK-47`); `pipeline-check`'s two checks on its own trader accounts are known failures for exactly this refusal (`6e9b91f`; Canary `9ce990b`, `3d7d4fd`) | `96f625f` | `sos_h001_a_buy_into_an_account_whose_owner_can_change_is_refused`, `sos_h001_a_buy_into_an_account_with_an_immutable_owner_passes_and_its_owner_stays`, `sos_h001_a_buy_into_an_associated_token_account_still_passes`, `sos_h001_tokens_already_in_an_account_whose_owner_can_change_can_still_be_sold` (`tests/sos_h001_account_owner.rs`); fuzzer invariant `contained_balances_rest_only_where_the_owner_is_fixed` |
| H002 | Balances placed without a transfer (minted, or bought before H001's rule) stay re-ownable | Confirmed | Low | Low | accepted, signed off (sign-offs.md); disclosed ("What the hook cannot see", `HOOK-48`); the release gate reports such balances at every redeploy, and found none on devnet | `9a43cea`, `73ffd29` | `sos_h002_balances_whose_owner_can_change_are_classified`, `sos_h002_the_gate_reports_devnets_holders` (`tests/release_gate.rs`) |
| H003 | Control of an owner key (smart wallets, program receipts) changes hands with no transfer | Confirmed | Low | Low | accepted, signed off (sign-offs.md); disclosed by answer 2a ("What the hook cannot see", Aviary's panel, `HOOK-48`) | `9a43cea` | - |
| H007 | Area 1: every way to reach `Execute` without or with substituted accounts | Not vulnerable | - | - | Hardened: both address checks kept behind one helper (`HOOK-45`); the HA-1 fuzzer invariant built | `ac0899e`, `db0a270` | `every_substituted_hook_account_is_refused_case_by_case` (`tests/bok_ha2_substitutions.rs`), `tests/hook_accounts.rs`; fuzzer invariant `every_hook_owned_account_sits_at_its_pda` |
| H008 | Area 2: every account `bind` trusts; new item: a Token-2022 multisig mint authority bound by its creation keypair alone | Not vulnerable (new item confirmed) | Low | Low | fixed (new item, `HOOK-44`) | `8482cc3` | `sos_h008_a_multisig_mint_authority_signed_by_its_creation_key_is_refused` (`tests/sos_bind.rs`) |
| H009 | Area 3: the tax AMM market state's version byte is unread | Potential | Low | Low | fixed; spec in `ac0899e` (`HOOK-43`) | `8482cc3` | `sos_h009_the_version_byte_is_the_tax_amms_version_field`, `sos_h009_bind_refuses_a_market_state_of_a_newer_version` (`tests/sos_bind.rs`), `sos_h009_a_market_state_of_a_newer_version_leaves_only_the_deadline` (`tests/sos_unlock.rs`) |
| H011 | Redeploy incompatibility: no `Config` layout pin, no pre-deploy gate | Confirmed | Medium | Medium | fixed (`HOOK-46`); the gate hardened in round 2 (R2T-01 to R2T-06) | `dfd1845` | `sos_h011_the_build_serves_every_devnet_config`, `sos_h011_the_gate_refuses_a_config_the_build_cant_write_back`, `config_v1_bytes_are_pinned` (`tests/release_gate.rs`) |
| H012 | The fee account and `sweep_fees` are a one-way channel to the router admin's treasury owner | Potential | Low | Low | accepted, signed off (sign-offs.md); disclosed ("What the hook cannot see") | `9a43cea` | - |
| H013 | A foreign router market declares the home vault; sells into it strand the seller's tokens | Confirmed | Low | Low | accepted, signed off (sign-offs.md); disclosed ("What the hook cannot see") | `9a43cea`, `1b05d82` | `sos_h013_a_market_naming_the_home_vault_as_its_own_strands_what_it_buys` (`tests/second_market.rs`) |
| H014 | The quote mint is unchecked by `bind` | Confirmed (main), potential (#67) | Low | Medium | fixed by answer 3a: `bind` takes the quote mint and refuses a live transfer hook, or a mint or freeze authority off the tax AMM's quote list (`HOOK-52`); #67's own rules merged in `410f4b3` | `83d1216` | `sos_h014_a_quote_mint_with_a_freeze_or_mint_authority_is_refused`, `sos_h014_a_quote_mint_with_a_transfer_hook_is_refused_and_a_cleared_one_passes`, `sos_h014_a_quote_list_mint_may_keep_its_authorities`, `sos_h014_a_quote_mint_other_than_the_markets_is_refused` (`tests/sos_bind.rs`) |
| H015 | The market state's version byte is not read (with H009) | Potential | Low | Low | fixed | `8482cc3` | as H009 |
| H016 | One upgrade key for the hook and the tax AMM; the freeze order is unenforced | Potential | Low | Low | accepted until mainnet, signed off (sign-offs.md); the freeze gate built by answer 7a (`HOOK-51`) and hardened in round 2 (R2T-07 to R2T-09) | `a557942`, `43b0ae4` | `freeze.test.ts` (`judgePrograms`, the loader `SetAuthority`) |
| H017 | An upgraded hook as a selective honeypot; capture through the unlock PDA survives a later freeze | Potential | Low | Low | accepted until mainnet, signed off (sign-offs.md); the freeze gate checks every contained mint's hook fields and config, and every mint ever recorded (R2-B) | `a557942`, `43b0ae4` | `freeze.test.ts` (`judgeMint`, `judgeConfig`, recorded mints) |
| H018 | An upgraded tax AMM forges `tax_collected` or drains a vault | Potential | Low | Low | accepted until mainnet, signed off (sign-offs.md); the freeze gate freezes both programs together and only at the executable hashes the deploy record holds | `a557942`, `43b0ae4` | `freeze.test.ts` (`executableHash`, a market off the tax AMM refused) |
| H019 | The deployed bytes against main (a Pipeline revision bump) | Not vulnerable; byte equality needs manual review | Info | Info | none; moot once the hardened build is deployed and verified at the session's redeploy | - | - |
| H020 | `bind` accepts a market already trading, with no counter baseline | Confirmed | Low | Low | fixed; spec in `ac0899e` (`HOOK-42`) | `8482cc3` | `sos_h020_a_market_that_already_collected_tax_is_refused`, `sos_h020_a_market_that_collected_no_tax_binds` (`tests/sos_bind.rs`) |
| H022 | The mint authority is kept after `bind` (HOOK-12 on main) | Confirmed (main), potential (#67, markets opened before it) | Low | Medium | accepted, signed off (sign-offs.md); `HOOK-12` under #67: the seed refuses a live mint authority (merged in `410f4b3`); demo token 3's mint authority is revoked on devnet by the session at the redeploy (answer 8a) | `410f4b3` | `sos_h008_a_mint_with_a_mint_authority_is_refused_at_the_seed` (`programs/tax-amm/tests/mint_rules.rs`) |
| H023 | T04: a sole recipient fakes the unlock for 12.38% of the goal | Confirmed | Low | Low | accepted, signed off (sign-offs.md); disclosed by answer 4a with the closed form and the table ("Unlock goal", `HOOK-49`) | `9a43cea`, `db0a270` | `sos_h023_sole_recipient_washes_to_the_goal_and_unlocks` (`tests/sos_goal_cost.rs`, EC-3) |
| H024 | T04 atomic: the wash and the unlock fit one transaction, with no warning | Confirmed | Low | Low | accepted, signed off (sign-offs.md); disclosed by answer 4a ("Unlock goal", `HOOK-49`) | `9a43cea` | - |
| H025 | T05: what #67 changes; the residue for markets opened before it | Potential | Low | Low | fixed (with H020) | `8482cc3` | as H020 |
| H026 | The launch order under #67; the `--quote-mint new` merge hazard | Potential | Low | Low | accepted, signed off (sign-offs.md); the order (create, `bind`, revoke, seed) is in the spec ("Launch in v1") and in the launch script, which reads the mint authority back as none before the seed (merged with #67) | `410f4b3` | - (the launch script's own run) |
| H027 | T06: every Pipeline 0.3 path against the allow rule | Not vulnerable | Info | Info | spec fixed (the fee account's "Depends on", with H070) | `ac0899e` | - |
| H029 | The 8 spare bytes: an appended `Config` field breaks `unlock` only | Potential | Low | Low | fixed (with H011) | `dfd1845` | `sos_h011_the_gate_refuses_a_config_the_build_cant_write_back`, `config_v1_bytes_are_pinned` |
| H030 | A quote freeze or quote hook traps holders until the deadline | Potential | Low | Medium | fixed with H014 (answer 3a) | `83d1216` | as H014 |
| H031 | T01: keep the two `create_program_address` calls | Not vulnerable | - | - | kept, behind one helper (`HOOK-45`) | `ac0899e` | as H007 |
| H032 | T02: one helper for the repeated address check | Potential | Info | Info | fixed (`HOOK-45`) | `ac0899e` | as H007 |
| H033 | T03: duplicated layout constants | Confirmed | Info | Info | fixed: the constants live once, in `mint-rules` (TLV-6) | `d4c1a8c` | `the_account_layout_constants_are_token_2022s` (`programs/mint-rules/tests/account_layout.rs`) |
| H034 | A multisig look-alike (355 bytes) passes the `transferring` check | Confirmed | Info | Info | fixed | `8482cc3` | `sos_h034_a_multisig_length_account_is_not_read_as_mid_transfer` (`tests/sos_token_account.rs`); `tlv_5_the_transferring_flag_is_token_2022s` |
| H038 | A missing validation account; reused error codes | Confirmed | Info | Info | accepted, Info (errors are append-only) | - | `its_config_and_errors_are_the_programs` (`tests/idl.rs`) |
| H039 | An unchecked `Transfer` is refused before and after the unlock | Confirmed | Info | Info | accepted, Info (documented Token-2022 behaviour, "After the unlock") | - | - |
| H043 | The `tax_market` helpers do not check the owner | Potential | Info | Info | not taken: both callers (`bind` and `unlock`) check the market state's owner before the byte readers, and the readers stay pure functions of bytes so the layout tests can call them | - | `tests/layout.rs` (the readers on bytes) |
| H045 | An integrator fee account set to the vault or the fee account | Confirmed | Info | Info | spec fixed ("What this refuses"); `HOOK-02` made exact | `9a43cea`, `e850458` | - |
| H046 | The call depth is off by one (4 of 5 on a direct buy) | Confirmed | Info | Info | spec fixed | `ac0899e` | - |
| H049 | No minimum goal or deadline | Confirmed | Low | Low | accepted, signed off (sign-offs.md); Aviary's panel warns on weak terms ("In Aviary") | `9a43cea` | - |
| H050 | A hooked mint never bound is a dead end; a multisig mint authority cannot bind | Confirmed | Low | Low | accepted, signed off (sign-offs.md); spec fixed ("Lifecycle", `HOOK-44`) | `e850458` | - |
| H051 | A contained or hooked quote mint; two contained mints in one market | Potential | Low | Low | fixed by answer 3a: `bind` refuses a quote with a live transfer hook, a contained one included | `83d1216` | `sos_h014_a_quote_mint_with_a_transfer_hook_is_refused_and_a_cleared_one_passes` (`tests/sos_bind.rs`) |
| H057 | `unlock` with the market state closed or reallocated | Not vulnerable | Info | Info | hardened with H009 | `8482cc3` | `sos_h009_a_market_state_of_a_newer_version_leaves_only_the_deadline` |
| H061 | The unlock as a starting gun | Potential | Info | Info | accepted with H023 and H024 by answer 4a (sign-offs.md); disclosed ("Unlock goal") | `9a43cea` | - |
| H062 | Group extensions need a Meteora badge after the unlock | Confirmed | Info | Info | accepted by answer 6a (sign-offs.md): `HOOK-11` reworded, Aviary warns | `9a43cea` | - |
| H065 | A privileged sandwich of captive sells | Potential | Low | Low | accepted, signed off (sign-offs.md) | - | - |
| H066 | A captive sell tax with 300 slots' notice; `bind` checks no tax authority | Potential | Low | Low | accepted, signed off (sign-offs.md); Aviary's panel shows any pending rate change (`HOOK-49`) | `9a43cea` | - |
| H067 | Supply kept outside the pool drains the real quote under a virtual reserve | Potential | Low | Low | accepted by answer 5a, signed off (sign-offs.md): Canary's `outside_supply` warn (`CANARY-47`, `HOOK-50`), and the launch script seeds the whole supply | `c4fe317`, `f7f5154` | `a_launch_keeping_a_fifth_of_the_supply_outside_a_virtual_reserves_pool_warns`, `a_virtual_reserve_seeded_with_the_whole_supply_passes` (`crates/canary/tests/outside_supply.rs`) |
| H069 | CPI Guard and MemoTransfer on holder accounts | Potential | Info | Info | spec fixed ("Hook accounts callers must pass") | `e850458` | - |
| H070 | A router upgrade changes the fee account's seeds | Potential | Low | Low | spec fixed; accepted, signed off (sign-offs.md) | `ac0899e` | - |
| H072 | Cross-pinned program ids and re-addressing | Potential | Low | Low | fixed (in H011's gate) | `dfd1845` | `sos_h072_the_hooks_tax_amm_is_devnets` (`tests/release_gate.rs`) |
| H073 | Token-2022's upgrade authority as a trust root | Potential | Info | Info | spec fixed ("Depends on"); Token-2022's programdata hash is not yet in the daily pin check | `e850458` | - |
| H074 | `security.txt` fields (`source_release`) | Potential | Info | Info | fixed: `source_release` is the crate's release, 0.1.1 | `cd3ff13` | `the_built_program_embeds_its_security_txt` (`tests/security_txt.rs`) |
| H075 | No dependency advisory gate | Potential | Low | Low | fixed (`BAR-46`); widened in round 2 (R2T-14) | `e013ef5` | `.github/workflows/advisories.yml` |
| H077 | The error numbering is pinned only by the last name | Potential | Info | Info | fixed: the whole error table pinned in order | `cd3ff13` | `its_config_and_errors_are_the_programs` (`tests/idl.rs`) |
| H085 | `Execute`'s compute ceiling with the new checks | Not vulnerable | Info | Info | covered: the compute test runs real buys and sells through H001's rule under the 10,000 ceiling | `96f625f` | `execute_stays_under_its_ceiling_on_every_hooked_transfer` (`tests/compute.rs`) |
| H088 | Buys deliver into third parties' accounts ("a gift, not an escape") | Not vulnerable | Info | Info | spec fixed by answer 1a ("What this refuses": only into an account whose owner can never change) | `9a43cea` | - |
| H090 | Burn paths | Not vulnerable | Info | Info | spec fixed ("What the hook cannot see") | `e850458` | - |
| H092 | No test could build the tier 1 escapes (owner changes, minted balances) | Confirmed | Info | Info | fixed: H001's tests build a mutable-owner account, and the fuzzer gains `SetOwner` and `BuyIntoOwnAccount` steps and the ownership invariant | `96f625f`, `db0a270` | `sos_h001_*`; fuzzer invariant `contained_balances_rest_only_where_the_owner_is_fixed` |
| H094 | Upgrade authority key custody | Potential | Info | Info | accepted on devnet (`BAR-23`); mainnet under answer 7a (`HOOK-51`) | - | - |
| H096 | Aviary and Canary disclosure of the containment terms | Potential | Low | Low | accepted, signed off (sign-offs.md); the panel's text carries the caveats ("In Aviary") | `9a43cea` | - |
| H097 | The fee account's existence on markets not quoted in wrapped SOL | Potential | Info | Info | disclosed: "Checks on the home market" says the fee account need not exist at binding, anyone may create it, and the launch script creates both before `bind`; the release gate sweeps the fee account where the fee is in the token | - | `sos_r2t03_the_gate_runs_the_fee_account_and_the_refusals` |
| H098 | Mistaken donations are unrecoverable | Potential | Info | Info | none | - | - |
| H099 | `Config.quote_mint` is recorded and never read | Not vulnerable | Info | Info | spec fixed: "Checks on the home market" names the quote mint as the market's other mint, which `bind` now checks, and the freeze gate checks each config's against the chain | `83d1216`, `f01f15d`, `43b0ae4` | `sos_h014_a_quote_mint_other_than_the_markets_is_refused` |
| H100 | The spec's invariant 1 wording | Confirmed | Info | Info | spec fixed by answer 1a (invariant 1 names the owner rule and its residuals, `HOOK-18`) | `9a43cea` | `the_invariants_are_the_specs_then_the_hardenings` (`tests/fuzz.rs`) |

## High

### H001: An owner change moves a contained balance with no hook call

What: the allow rule compared only addresses: a transfer passed if its source or destination was the home vault or the fee account (`src/instructions/execute.rs:63-67`).
Token-2022 lets the owner of a token account without the `ImmutableOwner` extension reassign the whole account with `SetAuthority(AccountOwner)`, and hooks run only from the transfer paths.
Token-2022 requires only `TransferHookAccount` on accounts of a hooked mint, so a keypair account made with `InitializeAccount3` has a mutable owner, and the router and both versions of the tax AMM accept any token account of the mint as a buy's output.

Attack: create a keypair account without `ImmutableOwner`, buy into it through the home market (source the vault, allowed), then sell the account itself: `SetAuthority(AccountOwner)` to the buyer for an off-chain payment, or atomically through an escrow program.

Why it matters: a second market outside the home market, untaxed (recipients lose the tax), uncounted (the goal fills slower) and splitting the "one venue" price the launch promises.
No funds are stolen, but HOOK-01 and the spec's invariant 1 fail in substance, and the spec's "a gift, not an escape" is false.
The suite could not see it by construction: no test could build a mutable-owner account or send `SetAuthority` (H092).

Fix (`96f625f`, the review's option (a)): a destination other than the vault and the fee account must carry `ImmutableOwner`, refused otherwise with `DestinationOwnerCanChange`.
Every associated token account has the extension on both clusters, so ordinary buys, `route` hops and `sweep_fees` into the treasury's associated account still pass; sells (destination the vault) carry no owner check, so every holder can still exit.
The cost is one extension walk, estimated at 250 to 500 CU, with `Execute` near 6,100 of its 10,000 ceiling (H085); round 2 read a buy at 5,675 CU, since an associated token account's first extension is `ImmutableOwner`, and `tests/compute.rs` holds every hooked transfer under the ceiling.
What the rule cannot reach is disclosed: balances placed without a transfer (H002) and control of an owner key (H003).
The owner chose this design on 2026-11-23 (answer 1a, `HOOK-47`).
Pipeline's `pipeline-check` writes its traders' accounts without the extension, unlike the real associated token program, so its `quote_matches_swap` and `round_trip`, and `exact_out_refund` where it runs, fail on contained markets; the hook's conformance test, the launch script and Canary count them as known failures only when every failed swap is this refusal (`6e9b91f`, `9ce990b`, `f7f5154`, `db0a270`; Canary checks the refusal comes from the hook program itself, `3d7d4fd`), and each flips to a failure once Pipeline's checker writes the extension.

## Medium

### H011: Redeploy incompatibility

What: no test loaded a config written by the deployed build into the build under test; `CONFIG_VERSION` was written and never read; the hook had no `pre-deploy.sh`, and the deploy script skipped the check silently when the file was absent.
Three contained tokens live on devnet, not the one the record named.

Why it matters: a field appended to `Config` keeps `Execute` working on old configs (Borsh ignores the trailing bytes) and makes `unlock` impossible for all of them, since Anchor cannot write the larger struct back into the 237 bytes `bind` made (H029); any other layout, seed, discriminator or `Execute` account change refuses every transfer.
In both cases the deadline does not help, because the same code enforces it: a permanent honeypot, the outcome the deadline exists to rule out.
The likeliest trigger was this review's own fixes.
Rated Medium, not High, because the trigger is the trusted upgrade key by mistake and the hook is frozen before mainnet.

Fix (`dfd1845`): `scripts/gate_snapshot.py` copies every hook config on a cluster with its mint, validation account, router `Market`, market state, vaults and fee accounts; `tests/release_gate.rs` loads them into LiteSVM with the build under test, and for each contained token buys into a fresh associated account, sells back, has a wallet-to-wallet transfer refused, has an early `unlock` refused, and unlocks at its deadline with only `unlocked_at` changed.
It runs in every `cargo test` on the devnet fixture (six configs, three contained, copied 2026-11-23), and `scripts/pre-deploy.sh` runs it on a fresh copy before `deploy-devnet.sh` deploys.
The v1 `Config` bytes are pinned (offsets and 237 bytes) against the fixture's real configs, and on devnet the gate refuses a hook built for another tax AMM than `deployments/devnet.json` records (H072).

### H014 and H030, H022: Medium on main's tax AMM only

`bind` checks the contained mint hard and the quote mint not at all, and main's tax AMM accepts any quote, any hook on it and any authorities.
A launcher who keeps a freeze authority on the quote can freeze the quote vault after buyers enter, so every trade stops, and containment removes the holder's only alternative until the deadline (up to 90 days); a launcher-controlled quote hook does the same (H014, H030).
`MintTo` calls no hook, so a launcher who keeps the mint authority after the seed can mint and sell into the only venue its holders have (H022).
#67 refuses at creation a quote whose hook is not cleared and at the seed a non-listed quote with an authority, and a live mint authority at the seed, so with #67 these are Low.
The residues are devnet USDC's issuer freeze authority, a launcher-held quote with no authorities, a quote that is itself contained (H051), and the devnet markets seeded under main, whose launcher key still holds the mint authority of all six bound mints.
Outcome: #67 is merged into this branch (`410f4b3`); answer 3a made `bind` check the quote mint itself (`83d1216`, `HOOK-52`), which fixes H014, H030 and H051 in the hook whatever the tax AMM later does, leaving only USDC's issuer freeze authority, disclosed; H022's residue on the devnet markets seeded before #67 is signed off, and answer 8a has the session revoke demo token 3's mint authority on devnet at the redeploy.

## What the fixes on this branch do

- **H008**: `bind` checks one signer, so a mint authority that is a Token-2022 multisig would be bound by whoever kept the keypair its account was created at, without its other signers; `bind` now refuses a mint authority owned by Token-2022 (`MintAuthorityIsMultisig`).
- **H009, H015, H057**: a market state of a version other than 1 reads as unreadable, so `bind` refuses it and `unlock` leaves it to the deadline; a compile-time assert ties the hook's known version to the tax AMM's `STATE_VERSION`, so a tax AMM build that bumps it fails the hook's build until the hook is reviewed against it (`HOOK-43`).
- **H020, H025**: `bind` refuses a market whose `tax_collected` is not zero (`MarketAlreadyCollectedTax`), so the goal counts tax collected under containment from the binding on (`HOOK-42`); this also settles Book of Knowledge's TM-6.
- **H034**: the hook refuses a 355-byte source, so it agrees with Token-2022's own unpacking exactly (see TLV-5 in [maths-properties.md](maths-properties.md)).
- **H011, H029, H072**: the release gate above.
- **T01, T02 (H007, H031, H032)**: the investigators disagreed on whether to drop `Execute`'s two `create_program_address` checks; the mutation run showed no reachable case depends on them today, and the review kept them, behind one shared helper (`HOOK-45`), because after H001's rule `Execute` still fits its ceiling, they guard the property every identity check rests on (each hook-owned account sits at its PDA), a future migration instruction would put that property at risk, and the hook will be frozen.
- **H027, H046, H070**: the spec states the call depth (4 of 5 on a direct buy, 5 of 5 under one wrapper) and narrows the fee account's dependency on the router's fee derivation to markets whose fee is taken in the token, and to sweeps.
- **H075**: a daily advisory check of both lock files, and `url` 2.5.9 for RUSTSEC-2026-0592.
- **H074, H077**: release 0.1.1 names itself in `security.txt`, and the IDL test pins every error name in order, so an error can only ever be appended.

What the fixes after the owner's answers do:

- **H014, H030, H051** (answer 3a): `bind` takes the quote mint, which must be the market's other mint, and refuses one with a live transfer hook (any program's, this hook's included; a hook cleared for good passes) and one with a mint or freeze authority unless it is on the tax AMM's quote list, by the tax AMM's own rule (`QuoteMintHooked`, `QuoteMintHasAuthority`, `HOOK-52`).
- **H016, H017, H018** (answer 7a): `scripts/freeze-gate.ts` checks every contained mint's hook fields against its config and both programs' upgrade authorities, and with `--freeze` (local only, until mainnet) freezes the hook and the tax AMM in one transaction and checks again (`HOOK-51`); round 2 added the configs against the chain, the executable hashes and every recorded mint (R2T-07 to R2T-09, R2-B).
- **H002**: the release gate classifies each contained mint's Token-2022 accounts and reports, never refuses, balances in accounts whose owner can change; devnet's three contained mints have none.
- **H067** (answer 5a): Canary's `outside_supply` warn (`CANARY-47`), and the launch script seeds the whole supply.
- **H033** (T03): `ACCOUNT_LEN`, the account type, `MULTISIG_LEN`, `TRANSFER_HOOK_ACCOUNT` and `IMMUTABLE_OWNER` live once, in `mint-rules`, checked against Token-2022's interface.
- **H007, H092, H023**: the fuzzer's invariants `every_hook_owned_account_sits_at_its_pda` (HA-1) and `contained_balances_rest_only_where_the_owner_is_fixed` (with `SetOwner` and `BuyIntoOwnAccount` steps), and `tests/sos_goal_cost.rs`, the sole recipient's wash to the goal at 12.38% of it (EC-3).
- **H013**: `tests/second_market.rs` pins the residual: a market on Pipeline's hostile test strategy that names the home vault as its own strands what it buys.
- **Spec and register**: the owner's answers in `HOOK-47` to `HOOK-52` and the changed `HOOK-01`, `HOOK-02`, `HOOK-11`, `HOOK-17`, `HOOK-18` and `HOOK-34`; "What the hook cannot see" (H002, H003, H012, H013, H090), invariant 1 and "What this refuses" (H088, H100), the never-bound mint (H050), CPI Guard and memos (H069), and Token-2022 as a dependency (H073).

## The owner's answers

The owner answered on 2026-11-23, in the hardening session, recorded on [#74](https://github.com/imDev2023/testing-pipeline/issues/74): `1a 2a 3a 4a 5a 6a 7a 8a`, the review's recommendation in each case.
Each is a default MetalLegBob may change.

1. **How `Execute` refuses a destination whose owner can change** (H001, High; with H002, H088, H100): (a) `ImmutableOwner` only.
   Built in `96f625f` (`HOOK-47`); `pipeline-check`'s two checks on its own trader accounts are known failures on contained markets until Pipeline's checker writes the extension.
2. **Destinations owned by programs and smart wallets** (H003, Low): (a) disclose.
   In "What the hook cannot see", on Aviary's panel and in `HOOK-48`; signed off.
3. **The quote mint at `bind`** (H014, H030, H051; Low with #67, Medium on main): (a) mirror #67's rule in `bind`, with the tax AMM's quote list as the one list.
   Built in `83d1216` (`HOOK-52`), which fixes all three.
4. **What the goal promises** (H023, H024, with H061, H066; Low): (a) disclose the closed form and the table, with Aviary showing the recipients and the tax authority.
   In "Unlock goal" and `HOOK-49`; EC-3's test measures it; signed off.
5. **Supply kept outside the pool** (H067, H002; Low): (a) a Canary flag, Aviary disclosure and a lower outside share in the launch defaults.
   Canary's `outside_supply` (`CANARY-47`, `HOOK-50`), and the launch script now seeds the whole supply; signed off.
6. **Contained mints with group extensions** (H062, Info): (a) reword `HOOK-11` and have Aviary warn.
   Done in the spec and the register.
7. **The mainnet freeze gate** (H016, H017, H018, H094; Low, a mainnet blocker): (a) record the rule now and build the gate with the hook's pre-deploy gate.
   Built in `a557942` and hardened in `43b0ae4` (`HOOK-51`); the freeze itself waits for mainnet; signed off until then.
8. **Devnet housekeeping and the Lows for sign-off** (H022's devnet revoke; H049, H051, H065, H066, H070): (a) unlock the two contained mints the record omits once due, revoke demo token 3's mint authority and record them, and sign off the listed Lows.
   The devnet steps are the session's at the redeploy; the Lows are signed off, H051 is closed outright by 3a, and the session's own list of further Lows (H002, H012, H013, H022, H026, H050, H096) is signed off with them ([sign-offs.md](sign-offs.md)).

## The ticket's four named areas

| Area | Primary finding | Verdict |
| --- | --- | --- |
| 1. Every way to reach `Execute` without a hook account or with a substituted one: the validation account, the config, the source, the mint, the destination; Token-2022 with and without extra accounts; direct calls; CPI from another hook program; self-transfers | H007 (26 cells), with H005, H006, H031, H032, H034 to H038, H079, H080, H091 | Not vulnerable: no substitution passes. The one real escape is not through `Execute` but around it: an owner change moves no tokens, so no hook runs (H001) |
| 2. Every account `bind` trusts: mint, mint authority, payer, config, validation account, unlock PDA, market, market state | H008, with H014, H020, H021, H047, H050, H051, H078, H081, H089, H099 | Identity sound; the gaps were semantic: the quote mint (H014, fixed by answer 3a), the counter baseline (H020, fixed) and a multisig mint authority (H008's new item, fixed) |
| 3. The hook's reading of the tax AMM's market state: offsets, length, discriminator, owner, version, what an upgrade could change | H009, with H015, H018, H021, H042, H043, H044, H057, H072 | Offsets right on main and on #67; the version byte was unread (Low, fixed); the owner check stays in the two callers, before the byte readers (H043, not taken) |
| 4. The two Token-2022 calls `unlock` signs: `Update` with no program id, then `SetAuthority(TransferHookProgramId, None)` | H010, with H017, H040, H058, H080 | Not vulnerable: checked against Token-2022 6.0.0's source, LiteSVM's 11.0.0 and three real devnet unlocks; `Update(None)` clears only the program id and `SetAuthority` only the authority, in the only working order, atomically |

## Token-2022 on devnet and mainnet (H004)

Devnet and mainnet both run Token-2022 v11.1.0, and every handler the review's reachability arguments rest on is unchanged from 6.0.0, the source the hook builds against (H004 to H006).
LiteSVM bundles 11.0.0, and v12.0.0 is published but not deployed.
The 11.x source was read from a scratch clone, not the registry, and no reproducible build of its commit was made; OtterSec's verification of the deployed program already matches it.
The residual is process: put Token-2022's programdata hash (`5e888b29...13d9` today) in the daily pin check, and rerun H004 to H006 whenever Token-2022 changes.

## Severity calibration

Where investigators disagreed or the calibrated rating differs from theirs:

- T01 (H007 drop, H031 keep): keep, behind one helper; settled by the mutation run and the compute budget.
- H002 against H100: a source-side `ImmutableOwner` rule does not close H002, since the escape is the owner change, which moves no tokens; it would only strand holders whose balances are already in mutable-owner accounts.
  It is recorded as a rejected alternative.
- H011 against H029: Medium, not High: impact high, but the trigger is only the trusted key by mistake and mainnet is excluded by the freeze; it breaks the deadline promise, so above Low.
  H029 is its mechanism and stays Low alone.
- H023: Low, not Info, because HOOK-17 and the spec's panel present the goal as market demand.
- H002: Low; its Medium part on main is H022's harm, not counted twice.
- H016, H017, H018: Low; trusted key, and mainnet is forbidden until Pipeline's router is on mainnet; the freeze gate becomes a mainnet blocker.
- H020: Low; the launcher already chooses goal and deadline freely, so a pre-paid goal adds no power.
- H014, H030, H022: Low with #67, Medium on main.
- H008's new item: Low; harm is co-signers bypassed for at most 90 days of containment.
- H094: Info; reuse of the devnet key for mainnet is forbidden.

None of the High or Medium findings rests on a pattern in the knowledge base's list of common false positives.

## Combination analysis

Each chain names the node whose fix breaks it.

1. **An untaxed secondary market** (High; H001, H092, H100, residuals H002, H003): any buyer creates a mutable-owner account, buys, and sells the account; the tests could not see it and the spec said it could not happen.
   Break: H001's destination rule; H092's fuzzer invariant keeps the class visible; the corrected invariant 1 and the disclosure of H002 and H003 keep the promise honest.
2. **The fix that strands** (Medium; H001's fix, H011, H029): H001's upgrade is the next redeploy, and anything in it that touches `Config`, seeds or `Execute`'s accounts would strand every contained token past its deadline.
   Break: the layout pin and the release gate land first and run on the exact bytes of that upgrade.
3. **A launcher's honeypot on main** (Medium on main, Low with #67; H014, H030, H022, H067, H002): a freezable or hooked quote, a live mint authority or a large outside allocation traps buyers' quote while containment removes their one alternative.
   Break: #67's creation and seed rules (merged); `bind`'s own quote mint check for defence in depth (answer 3a, built); Canary's `outside_supply` and a whole-supply seed for outside supply (answer 5a).
4. **The launcher's unlock** (Low; H023, H024, H061, H066, H067): the tax authority makes itself sole recipient, washes to the goal for about 12.4% of it in one transaction, unlocks, and can open the first external pool in the next instruction.
   Break: none on chain; disclosed with the numbers (answer 4a, `HOOK-49`), Aviary showing recipients and authority, and signed off.
5. **Keys** (Low on devnet, a mainnet blocker; H016, H017, H018, H094, H073): one file key upgrades both programs; an upgraded hook can repoint every contained mint's hook fields so a later freeze does not undo it.
   Break: freezing both programs in one transaction behind a gate that checks every contained mint's hook fields (answer 7a, built as `scripts/freeze-gate.ts`, run at mainnet).
6. **Pre-paid or weak terms** (Low; H020, H025, H049, H008's late containment).
   Break: the zero counter at `bind` (fixed); Aviary warnings for weak terms.

Findings that enable others: H092 enabled H001 and H002 to go unseen; H011 enables every future fix to strand; H014 enables H030 and H051; H022 enables H002 on main; H046 (depth 5 allowed for one wrapper) enables H003's wrapper receipts; H016 enables H017 and H018.

## Attack trees

- **Goal A: a holding changes hands without a home-market trade.**
  Paths: an owner change of a mutable-owner account (H001, three transactions or one escrow transaction); a balance placed without a transfer (H002: minted into a mutable-owner account, or bought before the fix, none on devnet); control of the owner key changing (H003: a smart wallet or a wrapper issuing receipts at depth 5); through an allowed account (H012 into the fee account and swept to the treasury owner, H013 a foreign market naming the home vault); Token-2022 paths without the hook (H005, H006, not vulnerable).
  H001's destination rule breaks the first path fully and the second for every later balance; #67's seed rule bounds the minted case; the third is disclosure only; the fourth needs the router admin or burns the seller's tokens.
- **Goal B: trap every holder past the deadline.**
  Paths: an incompatible redeploy (H011, H029); a malicious hook upgrade capturing the hook fields through the unlock PDA, then freezing (H017, trusted key); a tax AMM change that makes the goal path go dark (H009, H015, H057), which is fail-safe, since the deadline still unlocks.
  The release gate breaks the first; the freeze gate's check (answer 7a) the second; the version gate keeps the third fail-safe.
- **Goal C: take or freeze buyers' quote while they cannot leave (main's tax AMM).**
  Paths: quote mint control (H014, H030: freeze the quote vault, a refusing quote hook, a free goal from minting the quote); the mint authority kept (H022); outside supply on a virtual reserve (H067); a captive tax and sandwich (H065, H066, bounded by the 10% cap and each seller's `min_amount_out`).
  #67's rules break the first two for new markets except issuer-held USDC, and `bind`'s quote check (answer 3a) breaks the first in the hook itself; answer 5a addresses outside supply; with #67 every path is Low.

## Coverage

| Instruction | Findings that matter |
| --- | --- |
| `Execute` | H001 (the allow rule saw no owner change), H034 (the multisig look-alike), H031 and H032 (T01, T02), H085 (compute headroom for H001's rule) |
| `bind` | H008 (a multisig mint authority), H014 and H030 (the quote mint), H020 and H025 (the counter baseline) |
| `unlock` | H010 (both CPIs sound), H011 and H029 (a `Config` change strands every contained token), H009 and H015 (the version byte) |
| Instructions not compiled (the transfer hook interface's init and update, IDL, event CPI, fallback) | H076, H086: not vulnerable |

| T-note | Result |
| --- | --- |
| T01: two `create_program_address` per transfer | Kept, behind one helper (`ac0899e`) |
| T02: one helper for the repeated check | Done (`ac0899e`) |
| T03: duplicated layout constants | Consolidated into `mint-rules` with `IMMUTABLE_OWNER = 7`, checked against Token-2022 (H033, TLV-6, `d4c1a8c`) |
| T04: the cost to fake the unlock | 12.38% of the goal at 10%/10% on wrapped SOL for a sole recipient, 11.43% on another quote; atomic (H023, H024); disclosed by answer 4a, and measured on the hook's harness by EC-3 (`sos_h023_sole_recipient_washes_to_the_goal_and_unlocks`) |
| T05: #67 changes the hook's world | #67 closes the hostile hook, mint authority and baseline issues for new markets; residues are markets opened before #67, devnet USDC's freeze authority and the `--quote-mint new` merge hazard |
| T06: Pipeline 0.3's router paths | Not vulnerable (H027); the fee account's "Depends on" narrowed (`ac0899e`) |

Two process gaps were flagged rather than made hypotheses: no test exercised a config written by the deployed build with a candidate build (Medium; now the release gate), and the Token-2022 binary devnet runs is not the one LiteSVM bundles (Low; H004's pin check).
G001 checked PDA seed namespaces, the rule's direction and simulation against execution (EP-004, EP-099, EP-111): not vulnerable.

## Not vulnerable

| ID | Why safe |
| --- | --- |
| H004 | Devnet and mainnet run Token-2022 v11.1.0; every cited handler unchanged from 6.0.0 |
| H005 | `Batch` dispatches through the same transfer path; refused on devnet in every form |
| H006 | Only the transfer family and the confidential transfer call a hook; the rest move nothing or need refused extensions; the owner change is H001 |
| H010 | Both Token-2022 calls in `unlock` clear exactly one field each, in the only working order |
| H021 | The router's and the tax AMM's mint arrays agree by construction |
| H028 | Only `swap` and `sweep_fees` sign outflows from the two allowed accounts |
| H035, H036 | A foreign hook cannot present a mid-transfer source of our mint; config and validation account are pinned to the mint |
| H037 | Self-transfers return before the hook; zero-amount transfers are judged by location |
| H040, H056 | After the unlock Token-2022 never calls the hook and nothing can re-set it; the freeze authority cannot be re-set, and the mint cannot be closed |
| H041 | The fee account's derivation equals the router's |
| H042, H044 | A shifted router layout fails closed except for liveness; layout drift is caught by tests on main and asserts on #67 |
| H047 | `CreateAccountAllowPrefund` is active on both clusters, so pre-funded PDAs bind |
| H048 | Launchpad graduation (`pipeline_seed_liquidity`) is documented as unsupported |
| H052, H053 | Goal units are explicit in the client; widening and checked arithmetic, proved by Kani |
| H054, H055 | The TLV walk fails closed on every difference from Token-2022; the allowlist numbers match Token-2022's enum |
| H058, H059, H060 | `unlock` has no signer and is once-only; write-lock griefing delays by slots at most; clock skew is seconds against 90 days |
| H063, H064 | `route` divides a wash's transaction count, not its cost; donations are never credited beyond `amount_sent` |
| H068 | A delegate can only sell or burn |
| H071 | The router admin has no pause or fee-rate power |
| H076, H086 | No IDL, event CPI or fallback instruction compiled; the interface's init and update instructions are refused |
| H078 | Before `bind` every transfer fails, and only the mint authority binds |
| H079, H080 | Lookup tables resolve before the program runs; `Execute` makes no CPI and `unlock` writes after its CPIs |
| H081, H095 | Every stored bump is canonical; bump-search tails are retries, never refusals |
| H082, H083 | The counter grows only by tax really paid; the contained token is never the fee mint |
| H084 | Version 1 router markets migrate permissionlessly |
| H087 | The validation data decodes under both resolver versions |
| H089 | One tax market state has exactly one router `Market` |
| H091 | Every account of a hooked mint gets `TransferHookAccount` |
| H093 | Output into the vault is refused; into the fee account it is self-harm |
| G001 | Seed namespaces do not collide, the rule's direction is right, and simulation and execution agree |

## Test gaps

Closed on this branch: H001 (four tests), H008 (the multisig authority), H009, H015 and H057 (three tests), H011 and H029 (the devnet configs, the write-back refusal and the v1 byte pin), H020 and H025 (two tests), H034 (one test and the TLV-5 property), H072 (the tax AMM id), and the substitution matrix behind H007 (`every_substituted_hook_account_is_refused_case_by_case`).

Closed later in this ticket:

- H001 and H092: the fuzzer's ownership invariant `contained_balances_rest_only_where_the_owner_is_fixed`, with `SetOwner` and `BuyIntoOwnAccount` steps whose refusals every default-size run must reach, and ST-6's invariant `a_sell_pays_pipelines_fee_on_the_side_the_router_records` over sales through `swap` and one-hop `route` with Pipeline's fee in the token and in wrapped SOL (`db0a270`); the release gate sweeps the fee account through the hook where the fee is in the token (`sos_r2t03_the_gate_runs_the_fee_account_and_the_refusals`).
- H002: the release gate's holder report (`sos_h002_balances_whose_owner_can_change_are_classified`, `sos_h002_the_gate_reports_devnets_holders`); a holder from before the rule can still sell (`sos_h001_tokens_already_in_an_account_whose_owner_can_change_can_still_be_sold`).
- H007: the HA-1 fuzzer invariant `every_hook_owned_account_sits_at_its_pda` (`db0a270`).
- H013: `sos_h013_a_market_naming_the_home_vault_as_its_own_strands_what_it_buys` (`1b05d82`).
- H014, H030, H051 (answer 3a): the four `sos_h014_*` tests in `tests/sos_bind.rs` (`83d1216`).
- H023 (answer 4a): EC-3, `sos_h023_sole_recipient_washes_to_the_goal_and_unlocks` (`db0a270`).
- H033: `the_account_layout_constants_are_token_2022s` (`d4c1a8c`).
- H074 and H077: `tests/security_txt.rs` keeps `source_release` equal to the crate version, and `its_config_and_errors_are_the_programs` pins the whole error table (`cd3ff13`).
- H085: `execute_stays_under_its_ceiling_on_every_hooked_transfer` runs every hooked transfer through H001's rule.
- H100: `the_invariants_are_the_specs_then_the_hardenings` ties the fuzzer's invariants to the spec's wording.
- H016 to H018: `freeze.test.ts` (`a557942`, `43b0ae4`).

Not added, none needed by a fix: a launcher-minted mutable-owner balance that changes owner (H002's residual, Token-2022's own behaviour, disclosed), a fuzzer `MintTo` step and a non-associated holder kind beyond the refused buy (H092), a validation copy away from its PDA in the tail (H007), a mint with a hook entry of the wrong length (H008, covered in part by TLV-4's Proptest), the helper's addresses against `find_program_address` (H032; HA-1 now checks every stored bump is canonical), and a foreign-owned 596-byte state (H043, not taken).
The off-curve owner test (H003) and the group extension refusal (H062) were for options the owner did not choose.

Pinning behaviour that holds: H005, H006, H010 (two), H012, H018, H026, H027, H037, H039, H045, H046, H047, H049, H050, H065, H068, H069, H091, H097, H099 were not added as tests in this ticket; the release gate exercises H010's unlock on every devnet config, and H013's and H051's are covered above.

Script checks: the freeze gate's checks are built (H016, H017, answer 7a); Token-2022's programdata hash in the daily pin check (H004, H073) is not added.

## Requires manual review

| ID | Uncertainty | Who |
| --- | --- | --- |
| H019 | Byte equality of main's verified build with the deployed program; the logic is shown identical | Moot once the session's redeploy of the hardened build is verified with `solana-verify` |
| H004 | Token-2022 v11.1.0's source was read from a scratch clone; no reproducible build of it was made | Optional, anyone with a Docker builder; OtterSec's verification already matches |
