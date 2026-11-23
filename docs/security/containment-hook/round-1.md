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
Statuses written `PENDING(owner, question N)` wait on the owner's answer to question N below, `PENDING(session, spec)` on spec text this ticket has still to write, and `PENDING(session, fix)` on code or tests this ticket has still to land.

## What was reviewed

- The program: `programs/containment-hook/src/` at commit `e4fdcd3` (13 files, about 1,330 lines with the proofs and tests inside them, about 1,000 of program code), the scope of every finding with an `H` number, and the shared crate it links, `programs/mint-rules/src/lib.rs` (167 lines).
- The deployed program `aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv` is a verified build of `77b6ddc`, whose hook logic equals `e4fdcd3`'s (H019).
- As context only, read and never under review: the tax AMM's source on main and on #67's branch (`imDev2023/build-67` at `b85b6ff`, about to land), Pipeline's router at `48a6b5f` (read from the project's fixture, never copied: it is BSL 1.1), Token-2022 6.0.0 and v11.1.0, and `spl-transfer-hook-interface` 0.9.0 and 2.1.0.
- Findings are judged against main's tax AMM and against #67's: the severity for the record is the one with #67, and the "main only" column says where main alone is worse.

When: from 2026-11-22 to 2026-11-23.
Book of Knowledge ran on 2026-11-22; Stronghold of Security ran from 2026-11-22 23:09 UTC to 2026-11-23 00:30 UTC; the fixes landed on this branch from 2026-11-22 23:35 UTC to 2026-11-23 00:42 UTC.

## How

**Stronghold of Security, at the "deep" tier** (forced by the ticket's brief; the code's size alone would have chosen "quick"):

1. Scan: an index of the 14 files (1,493 lines with `mint-rules`), a static pre-scan (109 pattern locations, 44 of them high risk) and the reviewer's 20 target hot spots (HS-01 to HS-20: 9 high, 9 medium, 2 low), with the knowledge-base patterns to load.
2. Analysis: nine context reviewers, one per focus area (access control, arithmetic, state machine, CPI and external calls, token economics, oracle and data, upgrade and admin, timing and ordering, the economic model), each quality-gated.
3. Strategy: one architecture document, then 100 attack hypotheses (H001 to H100; 11 in tier 1, 19 in tier 2, 70 in tier 3; 55 specific to this code), including the ticket's four named areas and its six notes T01 to T06.
4. Investigation: every hypothesis taken to a verdict by an investigator, in batches of five, with exact-integer models of the money paths and read-only devnet RPC reads and simulations; no build was run in this phase, so the LiteSVM results it quotes are this ticket's and Book of Knowledge's.
5. Coverage: 3 of 3 instructions, 4 of 4 named areas, 6 of 6 T-notes, 33 knowledge-base exploit patterns cited and the rest covered in substance, 12 of 12 applicable items of the AMM playbook's red-flag list and 15 of 15 of the Token-2022 checklist; one gap check (G001, not vulnerable).
6. Report: the calibrated table of all 100, severity calibration, combination analysis, attack trees, test gaps and the owner's questions.

**Book of Knowledge**, beside it ([maths-properties.md](maths-properties.md)): 14 regions of maths and byte reads indexed, 30 properties proposed, 12 confirmed and built as Kani harnesses, Proptest properties and a LiteSVM mutation run, and the exact cost model of washing a home market to its goal (T04).

**Fixes**: the session took the review's session defaults and landed them on this branch, each pinned by a regression test named `sos_<finding id>`; the design choices wait on the owner's eight questions.

| Commit | What it does | Findings |
| --- | --- | --- |
| `96f625f` | `Execute`'s destination rule: a destination other than the vault and the fee account must carry `ImmutableOwner`; error `DestinationOwnerCanChange` appended | H001 |
| `8482cc3` | `bind` refuses a market that has collected tax, a Token-2022 multisig mint authority and a market state of a newer version; `unlock` reads such a state as unreadable; the 355-byte look-alike refused | H008, H009, H015, H020, H025, H034, H057 |
| `dfd1845` | The release gate: a snapshot of every devnet config, a LiteSVM replay of each with the candidate build, `scripts/pre-deploy.sh`, the v1 `Config` bytes pinned, the tax AMM id pinned to devnet's | H011, H029, H072 |
| `ac0899e` | `Execute`'s two address checks kept behind one helper; spec text for the version gate, the zero counter, the call depth and the fee account's dependency | T01, T02 (H007, H031, H032), H009, H020, H027, H046, H070 |
| `360c40d` | Book of Knowledge's harnesses and tests | TLV-5 with H034 |
| `e013ef5` | A daily dependency advisory check of both lock files, and `url` 2.5.9 for RUSTSEC-2026-0592 | H075 |

## Outcome

No Critical finding.
One High (H001) and one Medium (H011), both fixed on this branch; H001's design waits on owner question 1.
On main's tax AMM alone three more findings are Medium (H014, H022, H030); #67's creation and seed rules close all three for new markets, and they are Low with #67.
The program-level code is clean: every account the hook reads is pinned by owner, discriminator, length and address; no arithmetic can wrap; only the three handlers are compiled; the unlock is once-only and final; and no substitution of a hook account reaches a passing `Execute` (H007, 26 cells).

| Verdict | Count |
| --- | --- |
| Hypotheses investigated | 100, plus one gap check (G001) |
| Confirmed | 21 |
| Potential | 28 |
| Not vulnerable | 51, of which 20 carry an Info note and one (H008) a new Low item |
| Needing manual review | 1 in part (H019's byte equality, moot after the next verified redeploy) |

Verdicts count the first word of each finding's status: H014 and H022 are confirmed on main and potential residues with #67.

| Severity | With #67 (record) | Main only | Fixed on this branch | Waiting on the owner | Session work open | No action or accepted |
| --- | --- | --- | --- | --- | --- | --- |
| Critical | 0 | 0 | - | - | - | - |
| High | 1 (H001) | 1 | 1 (H001, design pending owner question 1) | - | - | - |
| Medium | 1 (H011) | 4 (H011, H014, H022, H030) | 1 (H011) | - | - | - |
| Low | 29 | 26 | 8 (H008, H009, H015, H020, H025, H029, H072, H075) | 16 (H002, H003, H014, H016, H017, H018, H022, H023, H024, H030, H049, H051, H065, H066, H067, H070) | 5 (H012, H013, H026, H050, H096), and H022's spec text | - |
| Info | 39 | 39 | 5 (H027, H032, H034, H046, H057) | 5 (H061, H062, H088, H094, H100) | 12 (H033, H043, H045, H069, H073, H074, H077, H085, H090, H092, H097, H099) | 17 |
| None (cleared, no note) | 30 | 30 | 2 hardened anyway (H007, H031) | - | - | 28 |

## Findings

Every confirmed or potential finding, and the cleared ones the ticket hardened or still owes work on.
Severity "-" means cleared with no note.

| ID | Title | Verdict | Severity (with #67) | Main only | Status | Fix commit | Regression test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H001 | An owner change (`SetAuthority(AccountOwner)`) moves a contained balance with no hook call | Confirmed | High | High | fixed, design pending owner question 1 | `96f625f` | `sos_h001_a_buy_into_an_account_whose_owner_can_change_is_refused`, `sos_h001_a_buy_into_an_account_with_an_immutable_owner_passes_and_its_owner_stays`, `sos_h001_a_buy_into_an_associated_token_account_still_passes`, `sos_h001_tokens_already_in_an_account_whose_owner_can_change_can_still_be_sold` (`tests/sos_h001_account_owner.rs`) |
| H002 | Balances placed without a transfer (minted, or bought before H001's rule) stay re-ownable | Confirmed | Low | Low | PENDING(owner, question 1); the gate's report of such balances PENDING(session, fix) | - | - |
| H003 | Control of an owner key (smart wallets, program receipts) changes hands with no transfer | Confirmed | Low | Low | PENDING(owner, question 2) | - | - |
| H007 | Area 1: every way to reach `Execute` without or with substituted accounts | Not vulnerable | - | - | Hardened: both address checks kept behind one helper (`HOOK-45`); the HA-1 fuzzer invariant PENDING(session, fix) | `ac0899e` | `every_substituted_hook_account_is_refused_case_by_case` (`tests/bok_ha2_substitutions.rs`), `tests/hook_accounts.rs` |
| H008 | Area 2: every account `bind` trusts; new item: a Token-2022 multisig mint authority bound by its creation keypair alone | Not vulnerable (new item confirmed) | Low | Low | fixed (new item) | `8482cc3` | `sos_h008_a_multisig_mint_authority_signed_by_its_creation_key_is_refused` (`tests/sos_bind.rs`) |
| H009 | Area 3: the tax AMM market state's version byte is unread | Potential | Low | Low | fixed; spec in `ac0899e` (`HOOK-43`) | `8482cc3` | `sos_h009_the_version_byte_is_the_tax_amms_version_field`, `sos_h009_bind_refuses_a_market_state_of_a_newer_version` (`tests/sos_bind.rs`), `sos_h009_a_market_state_of_a_newer_version_leaves_only_the_deadline` (`tests/sos_unlock.rs`) |
| H011 | Redeploy incompatibility: no `Config` layout pin, no pre-deploy gate | Confirmed | Medium | Medium | fixed | `dfd1845` | `sos_h011_the_build_serves_every_devnet_config`, `sos_h011_the_gate_refuses_a_config_the_build_cant_write_back`, `config_v1_bytes_are_pinned` (`tests/release_gate.rs`) |
| H012 | The fee account and `sweep_fees` are a one-way channel to the router admin's treasury owner | Potential | Low | Low | PENDING(session, spec) | - | - |
| H013 | A foreign router market declares the home vault; sells into it strand the seller's tokens | Confirmed | Low | Low | PENDING(session, spec) | - | - |
| H014 | The quote mint is unchecked by `bind` | Confirmed (main), potential (#67) | Low | Medium | PENDING(owner, question 3) | - | - |
| H015 | The market state's version byte is not read (with H009) | Potential | Low | Low | fixed | `8482cc3` | as H009 |
| H016 | One upgrade key for the hook and the tax AMM; the freeze order is unenforced | Potential | Low | Low | PENDING(owner, question 7) | - | - |
| H017 | An upgraded hook as a selective honeypot; capture through the unlock PDA survives a later freeze | Potential | Low | Low | PENDING(owner, question 7) | - | - |
| H018 | An upgraded tax AMM forges `tax_collected` or drains a vault | Potential | Low | Low | PENDING(owner, question 7) | - | - |
| H019 | The deployed bytes against main (a Pipeline revision bump) | Not vulnerable; byte equality needs manual review | Info | Info | none; moot once the hardened build is deployed and verified | - | - |
| H020 | `bind` accepts a market already trading, with no counter baseline | Confirmed | Low | Low | fixed; spec in `ac0899e` (`HOOK-42`) | `8482cc3` | `sos_h020_a_market_that_already_collected_tax_is_refused`, `sos_h020_a_market_that_collected_no_tax_binds` (`tests/sos_bind.rs`) |
| H022 | The mint authority is kept after `bind` (HOOK-12 on main) | Confirmed (main), potential (#67, markets opened before it) | Low | Medium | HOOK-12 under #67 PENDING(session, spec); the devnet revoke PENDING(owner, question 8) | - | - |
| H023 | T04: a sole recipient fakes the unlock for 12.38% of the goal | Confirmed | Low | Low | PENDING(owner, question 4) | - | - |
| H024 | T04 atomic: the wash and the unlock fit one transaction, with no warning | Confirmed | Low | Low | PENDING(owner, question 4) | - | - |
| H025 | T05: what #67 changes; the residue for markets opened before it | Potential | Low | Low | fixed (with H020) | `8482cc3` | as H020 |
| H026 | The launch order under #67; the `--quote-mint new` merge hazard | Potential | Low | Low | PENDING(session, spec), with the launch script at #67's merge | - | - |
| H027 | T06: every Pipeline 0.3 path against the allow rule | Not vulnerable | Info | Info | spec fixed (the fee account's "Depends on", with H070) | `ac0899e` | - |
| H029 | The 8 spare bytes: an appended `Config` field breaks `unlock` only | Potential | Low | Low | fixed (with H011) | `dfd1845` | `sos_h011_the_gate_refuses_a_config_the_build_cant_write_back`, `config_v1_bytes_are_pinned` |
| H030 | A quote freeze or quote hook traps holders until the deadline | Potential | Low | Medium | PENDING(owner, question 3) | - | - |
| H031 | T01: keep the two `create_program_address` calls | Not vulnerable | - | - | kept, behind one helper (`HOOK-45`) | `ac0899e` | as H007 |
| H032 | T02: one helper for the repeated address check | Potential | Info | Info | fixed (`HOOK-45`) | `ac0899e` | as H007 |
| H033 | T03: duplicated layout constants | Confirmed | Info | Info | PENDING(session, fix) | - | - |
| H034 | A multisig look-alike (355 bytes) passes the `transferring` check | Confirmed | Info | Info | fixed | `8482cc3` | `sos_h034_a_multisig_length_account_is_not_read_as_mid_transfer` (`tests/sos_token_account.rs`); `tlv_5_the_transferring_flag_is_token_2022s` |
| H038 | A missing validation account; reused error codes | Confirmed | Info | Info | accepted, Info (errors are append-only) | - | - |
| H039 | An unchecked `Transfer` is refused before and after the unlock | Confirmed | Info | Info | accepted, Info (documented Token-2022 behaviour) | - | - |
| H043 | The `tax_market` helpers do not check the owner | Potential | Info | Info | PENDING(session, fix) | - | - |
| H045 | An integrator fee account set to the vault or the fee account | Confirmed | Info | Info | PENDING(session, spec) | - | - |
| H046 | The call depth is off by one (4 of 5 on a direct buy) | Confirmed | Info | Info | spec fixed | `ac0899e` | - |
| H049 | No minimum goal or deadline | Confirmed | Low | Low | PENDING(owner, question 8) | - | - |
| H050 | A hooked mint never bound is a dead end; a multisig mint authority cannot bind | Confirmed | Low | Low | PENDING(session, spec) | - | - |
| H051 | A contained or hooked quote mint; two contained mints in one market | Potential | Low | Low | PENDING(owner, question 8), closed outright by question 3 (a) or (c) | - | - |
| H057 | `unlock` with the market state closed or reallocated | Not vulnerable | Info | Info | hardened with H009 | `8482cc3` | `sos_h009_a_market_state_of_a_newer_version_leaves_only_the_deadline` |
| H061 | The unlock as a starting gun | Potential | Info | Info | PENDING(owner, question 4) | - | - |
| H062 | Group extensions need a Meteora badge after the unlock | Confirmed | Info | Info | PENDING(owner, question 6) | - | - |
| H065 | A privileged sandwich of captive sells | Potential | Low | Low | PENDING(owner, question 8) | - | - |
| H066 | A captive sell tax with 300 slots' notice; `bind` checks no tax authority | Potential | Low | Low | PENDING(owner, question 8) | - | - |
| H067 | Supply kept outside the pool drains the real quote under a virtual reserve | Potential | Low | Low | PENDING(owner, question 5) | - | - |
| H069 | CPI Guard and MemoTransfer on holder accounts | Potential | Info | Info | PENDING(session, spec) | - | - |
| H070 | A router upgrade changes the fee account's seeds | Potential | Low | Low | spec fixed in `ac0899e`; sign-off PENDING(owner, question 8) | `ac0899e` | - |
| H072 | Cross-pinned program ids and re-addressing | Potential | Low | Low | fixed (in H011's gate) | `dfd1845` | `sos_h072_the_hooks_tax_amm_is_devnets` (`tests/release_gate.rs`) |
| H073 | Token-2022's upgrade authority as a trust root | Potential | Info | Info | PENDING(session, spec), with the Token-2022 hash in the pin check | - | - |
| H074 | `security.txt` fields (`source_release`) | Potential | Info | Info | PENDING(session, fix) | - | - |
| H075 | No dependency advisory gate | Potential | Low | Low | fixed | `e013ef5` | `.github/workflows/advisories.yml` |
| H077 | The error numbering is pinned only by the last name | Potential | Info | Info | PENDING(session, fix) | - | - |
| H085 | `Execute`'s compute ceiling with the new checks | Not vulnerable | Info | Info | compute test with H001's rule PENDING(session, fix) | - | - |
| H088 | Buys deliver into third parties' accounts ("a gift, not an escape") | Not vulnerable | Info | Info | PENDING(owner, question 1) | - | - |
| H090 | Burn paths | Not vulnerable | Info | Info | PENDING(session, spec) | - | - |
| H092 | No test could build the tier 1 escapes (owner changes, minted balances) | Confirmed | Info | Info | fuzzer ownership invariant PENDING(session, fix) | - | - |
| H094 | Upgrade authority key custody | Potential | Info | Info | accepted on devnet (`BAR-23`); mainnet PENDING(owner, question 7) | - | - |
| H096 | Aviary and Canary disclosure of the containment terms | Potential | Low | Low | PENDING(session, spec) | - | - |
| H097 | The fee account's existence on markets not quoted in wrapped SOL | Potential | Info | Info | PENDING(session, spec) | - | - |
| H098 | Mistaken donations are unrecoverable | Potential | Info | Info | none | - | - |
| H099 | `Config.quote_mint` is recorded and never read | Not vulnerable | Info | Info | PENDING(session, spec) | - | - |
| H100 | The spec's invariant 1 wording | Confirmed | Info | Info | PENDING(owner, question 1) | - | - |

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
The cost is one extension walk, estimated at 250 to 500 CU, with `Execute` near 6,100 of its 10,000 ceiling (H085).
What the rule cannot reach is disclosed: balances placed without a transfer (H002) and control of an owner key (H003).
The design waits on owner question 1, since Pipeline's `pipeline-check` writes its traders' accounts without the extension, unlike the real program, so two of its checks report a false failure on contained markets until it does.

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
Owner questions 3 and 8.

## What the fixes on this branch do

- **H008**: `bind` checks one signer, so a mint authority that is a Token-2022 multisig would be bound by whoever kept the keypair its account was created at, without its other signers; `bind` now refuses a mint authority owned by Token-2022 (`MintAuthorityIsMultisig`).
- **H009, H015, H057**: a market state of a version other than 1 reads as unreadable, so `bind` refuses it and `unlock` leaves it to the deadline; a compile-time assert ties the hook's known version to the tax AMM's `STATE_VERSION`, so a tax AMM build that bumps it fails the hook's build until the hook is reviewed against it (`HOOK-43`).
- **H020, H025**: `bind` refuses a market whose `tax_collected` is not zero (`MarketAlreadyCollectedTax`), so the goal counts tax collected under containment from the binding on (`HOOK-42`); this also settles Book of Knowledge's TM-6.
- **H034**: the hook refuses a 355-byte source, so it agrees with Token-2022's own unpacking exactly (see TLV-5 in [maths-properties.md](maths-properties.md)).
- **H011, H029, H072**: the release gate above.
- **T01, T02 (H007, H031, H032)**: the investigators disagreed on whether to drop `Execute`'s two `create_program_address` checks; the mutation run showed no reachable case depends on them today, and the review kept them, behind one shared helper (`HOOK-45`), because after H001's rule `Execute` still fits its ceiling, they guard the property every identity check rests on (each hook-owned account sits at its PDA), a future migration instruction would put that property at risk, and the hook will be frozen.
- **H027, H046, H070**: the spec states the call depth (4 of 5 on a direct buy, 5 of 5 under one wrapper) and narrows the fee account's dependency on the router's fee derivation to markets whose fee is taken in the token, and to sweeps.
- **H075**: a daily advisory check of both lock files, and `url` 2.5.9 for RUSTSEC-2026-0592.

## Waiting on the owner

The first option in each is the review's recommendation.
New decisions take the next free `HOOK` id at merge.

1. **How `Execute` refuses a destination whose owner can change** (H001, High; with H002, H088, H100): (a) `ImmutableOwner` only, already landed on this branch; (b) `ImmutableOwner` or the canonical associated token address, which accepts the same accounts on chain at a bump search's cost; (c) keep the location-only rule and disclose the escape.
   Under (a) Pipeline's `pipeline-check` reports two false failures on contained markets until it writes the extension.
   PENDING(owner, question 1)
2. **Destinations owned by programs and smart wallets** (H003, Low): (a) disclose; (b) refuse a destination whose owner is off the ed25519 curve, exempting `sweep_fees`. PENDING(owner, question 2)
3. **The quote mint at `bind`** (H014, H030, H051; Low with #67, Medium on main): (a) mirror #67's rule in `bind`, with the tax AMM's quote list as the one list; (b) refuse any quote with a freeze authority or hook, ruling out USDC; (c) refuse only a quote with a hook; (d) disclose only. PENDING(owner, question 3)
4. **What the goal promises** (H023, H024, with H061, H066; Low): (a) disclose the closed form and the table, with Aviary showing the recipients and the tax authority; (b) refuse a home market whose tax authority is live; (c) count only tax paid by non-recipients, unenforceable; (d) need the goal seen in an earlier slot, which adds `Config` state. PENDING(owner, question 4)
5. **Supply kept outside the pool** (H067, H002; Low): (a) a Canary flag, Aviary disclosure and a lower outside share in the launch defaults; (b) the tax AMM's seed requires the whole supply in the vault for a contained mint. PENDING(owner, question 5)
6. **Contained mints with group extensions** (H062, Info): (a) reword HOOK-11 and have Aviary warn; (b) `bind` refuses them. PENDING(owner, question 6)
7. **The mainnet freeze gate** (H016, H017, H018, H094; Low, a mainnet blocker): (a) record the rule now and build the gate with the hook's pre-deploy gate (both programs frozen in one transaction, every contained mint's hook fields checked before and after); (b) build it in the mainnet ticket. PENDING(owner, question 7)
8. **Devnet housekeeping and the Lows for sign-off** (H022's devnet revoke; H049, H051, H065, H066, H070): (a) unlock the two contained mints the record omits once due, revoke demo token 3's mint authority and record them; (b) record them only.
   The five Lows are recommended for sign-off: H049 (Aviary warns on weak terms instead of an on-chain floor), H051 (a launcher strands only its own market), H065 (bounded by each seller's `min_amount_out` and the 10% cap), H066 (rates capped at 10% and changes wait 300 slots on #67) and H070 (trusted router key, liveness only, caught by the daily router pin check). PENDING(owner, question 8)

## The ticket's four named areas

| Area | Primary finding | Verdict |
| --- | --- | --- |
| 1. Every way to reach `Execute` without a hook account or with a substituted one: the validation account, the config, the source, the mint, the destination; Token-2022 with and without extra accounts; direct calls; CPI from another hook program; self-transfers | H007 (26 cells), with H005, H006, H031, H032, H034 to H038, H079, H080, H091 | Not vulnerable: no substitution passes. The one real escape is not through `Execute` but around it: an owner change moves no tokens, so no hook runs (H001) |
| 2. Every account `bind` trusts: mint, mint authority, payer, config, validation account, unlock PDA, market, market state | H008, with H014, H020, H021, H047, H050, H051, H078, H081, H089, H099 | Identity sound; the gaps were semantic: the quote mint (H014, owner question 3), the counter baseline (H020, fixed) and a multisig mint authority (H008's new item, fixed) |
| 3. The hook's reading of the tax AMM's market state: offsets, length, discriminator, owner, version, what an upgrade could change | H009, with H015, H018, H021, H042, H043, H044, H057, H072 | Offsets right on main and on #67; the version byte was unread (Low, fixed); the owner check inside the helpers is still to fold in (H043) |
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
   Break: #67's creation and seed rules; owner question 3 for defence in depth in `bind`; question 5 for outside supply.
4. **The launcher's unlock** (Low; H023, H024, H061, H066, H067): the tax authority makes itself sole recipient, washes to the goal for about 12.4% of it in one transaction, unlocks, and can open the first external pool in the next instruction.
   Break: owner question 4 (disclose with the numbers), Aviary showing recipients and authority.
5. **Keys** (Low on devnet, a mainnet blocker; H016, H017, H018, H094, H073): one file key upgrades both programs; an upgraded hook can repoint every contained mint's hook fields so a later freeze does not undo it.
   Break: owner question 7, freezing both programs in one transaction behind a gate that checks every contained mint's hook fields.
6. **Pre-paid or weak terms** (Low; H020, H025, H049, H008's late containment).
   Break: the zero counter at `bind` (fixed); Aviary warnings for weak terms.

Findings that enable others: H092 enabled H001 and H002 to go unseen; H011 enables every future fix to strand; H014 enables H030 and H051; H022 enables H002 on main; H046 (depth 5 allowed for one wrapper) enables H003's wrapper receipts; H016 enables H017 and H018.

## Attack trees

- **Goal A: a holding changes hands without a home-market trade.**
  Paths: an owner change of a mutable-owner account (H001, three transactions or one escrow transaction); a balance placed without a transfer (H002: minted into a mutable-owner account, or bought before the fix, none on devnet); control of the owner key changing (H003: a smart wallet or a wrapper issuing receipts at depth 5); through an allowed account (H012 into the fee account and swept to the treasury owner, H013 a foreign market naming the home vault); Token-2022 paths without the hook (H005, H006, not vulnerable).
  H001's destination rule breaks the first path fully and the second for every later balance; #67's seed rule bounds the minted case; the third is disclosure only; the fourth needs the router admin or burns the seller's tokens.
- **Goal B: trap every holder past the deadline.**
  Paths: an incompatible redeploy (H011, H029); a malicious hook upgrade capturing the hook fields through the unlock PDA, then freezing (H017, trusted key); a tax AMM change that makes the goal path go dark (H009, H015, H057), which is fail-safe, since the deadline still unlocks.
  The release gate breaks the first; owner question 7's freeze check the second; the version gate keeps the third fail-safe.
- **Goal C: take or freeze buyers' quote while they cannot leave (main's tax AMM).**
  Paths: quote mint control (H014, H030: freeze the quote vault, a refusing quote hook, a free goal from minting the quote); the mint authority kept (H022); outside supply on a virtual reserve (H067); a captive tax and sandwich (H065, H066, bounded by the 10% cap and each seller's `min_amount_out`).
  #67's rules break the first two for new markets except issuer-held USDC; owner questions 3 and 5 address the rest; with #67 every path is Low.

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
| T03: duplicated layout constants | Consolidate into `mint-rules` with `IMMUTABLE_OWNER = 7` (H033, TLV-6): PENDING(session, fix) |
| T04: the cost to fake the unlock | 12.38% of the goal at 10%/10% on wrapped SOL for a sole recipient, 11.43% on another quote; atomic (H023, H024; owner question 4) |
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

Open, to land with the fixes in this ticket:

- H001: a sweep of fees into the treasury's associated account, a `route` buy into a mutable-owner account, and a buy with Pipeline's fee on the output.
- H002: a launcher-minted mutable-owner balance that changes owner and sells (pinning the residual), a holder from before the fix who can still sell, and a mutable-owner account that cannot gain `ImmutableOwner`.
- H092: the fuzzer's ownership invariant, with `SetOwner` and `MintTo` steps and a holder kind that is not an associated account.
- H007: the HA-1 fuzzer invariant, tail order and padding, and a validation copy away from its PDA in the tail.
- H008: a mint with a hook entry of the wrong length (covered in part by TLV-4's Proptest).
- H032, H033, H043, H074, H077, H085, H100: the helper's addresses against `find_program_address`, the layout constants against Token-2022, a foreign-owned 596-byte state not read, `source_release` against the crate version, the whole error table, compute with the destination walk, and the spec's invariant 1 naming the owner rule.

Open, depending on an owner decision: H014's freezable and hooked quote refusals and the quote-freeze trap on main (question 3), H003's off-curve owner (question 2), H023 and H024's wash to the goal and its atomic form (question 4, with EC-3), and H062's group extension refusal (question 6, only under (b)).

Open, pinning behaviour that holds: H005, H006, H010 (two), H012, H013, H018, H026, H027, H037, H039, H045, H046, H047, H049, H050, H051, H065, H068, H069, H091, H097, H099.

Script checks: Token-2022's programdata hash in the daily pin check (H004), and the freeze gate's checks (H016, H017, question 7).

## Requires manual review

| ID | Uncertainty | Who |
| --- | --- | --- |
| H019 | Byte equality of main's verified build with the deployed program; the logic is shown identical | The redeploy session's `solana-verify` run; moot once the hardened build deploys |
| H004 | Token-2022 v11.1.0's source was read from a scratch clone; no reproducible build of it was made | Optional, anyone with a Docker builder; OtterSec's verification already matches |
