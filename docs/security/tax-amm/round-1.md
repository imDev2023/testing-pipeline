# Tax AMM: review round 1

Round 1 of the internal adversarial review of `programs/tax-amm`, run with Stronghold of Security at the "deep" tier on 2026-11-20, inside [Tax AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/67), at commit `77b6ddc`, the build deployed on devnet as `J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t`.
It is not an audit: it was run by agents inside the project's own hardening ticket, it is not independent and it guarantees nothing ([`BAR-19`](../../decisions.md#bar-19-code-review-and-what-reviews-are-called)).
No external review of this program has been done.
The investigators read the code at `61923c7`, whose `programs/tax-amm/src` is byte for byte the same as at `77b6ddc`.
Code locations are at `77b6ddc`: those starting with `src/` or `tests/` are relative to `programs/tax-amm/`, every other path is from the repository root.
"Buy wall Hnnn" means finding Hnnn of the sister program's round 1 ([`docs/security/buy-wall-amm/round-1.md`](../buy-wall-amm/round-1.md)).
The owner answered the questions posted on #67 on 2026-11-20 with 1a, 2a, 3a, 4a and 5a on 2026-11-22, and each disposition below says what came of it; round 2, which verified every fix, is [round-2.md](round-2.md).

## Summary

The program's account, signer and CPI surface held up under 100 hypotheses.
No missing signer, owner, PDA or relationship check was found: `pipeline_swap` runs only for the router's market PDA stored at creation (H001), every vault, mint, token program and payout account is pinned to the market state (H003, H004, H006), the vault authority's signature never reaches a hook program (H002, H031, H045), credited input is bounded by the measured surplus over every recorded ledger (H005, H029, H033), and the proven arithmetic rounds against the trader everywhere (H043, H050 to H054, H084, H085).
Invariant 1 (each vault covers its reserve and everything owed from it) held exactly in an exact-integer model of 771,749 swaps.
No Critical or High finding was confirmed, and no finding lets a stranger take funds from a market whose mints and roles are held in good faith.

The material risk is economic and sits in the spec, not in a missing check.
Seven Medium findings fall into five families, each a power the spec leaves live on purpose:

- Live token authorities ([`TAX-16`](../../decisions.md#tax-16-mint-rules)): a token's creator may keep a live transfer hook, mint authority and freeze authority, checked once at creation, so it can flip the hook to refuse every sell but its own (H007), mint and sell into the curve for about 99% of the real quote (H008), or stage all of it with the tax roles for 98.7% of buyers' spend (H009).
  This is the buy wall's H001 and H061 class, which that program closed with `POOL4-48`; the tax AMM left it open so that a contained token, whose hook must stay live until it unlocks, can have a home market.
- The tax authority's instant rate changes ([`TAX-05`](../../decisions.md#tax-05-tax-authority)): `set_taxes` takes effect inside the same bundle, so the authority can turn a victim's whole slippage allowance, up to the range maximum, into tax it routes where it likes, with no capital (H010).
- Late-bound recipient wallets ([`TAX-10`](../../decisions.md#tax-10-payout), [`TAX-39`](../../decisions.md#tax-39-emptying-a-recipient-slot-that-is-still-owed)): the authority can rename every third-party slot and pay their unpaid tax to itself in one transaction (H023).
- A seed that binds nothing, with an unbounded virtual reserve: anyone can create a market naming a victim as its seeder, and if the victim seeds it, one unit of input can take the whole seeded side (H019).
- The exit guarantee is a promise of a quote, not of value ([`TAX-52`](../../decisions.md#tax-52-what-every-holder-can-exit-means-on-a-tax-market)): on a virtual-reserve launch, a holder of tokens from outside the market can take buyers' whole real quote and leave them able to sell only dust (H036).

| Result | Count |
| --- | --- |
| Hypotheses investigated | 100 |
| Confirmed | 15 |
| Potential | 22 |
| Not vulnerable | 63 |
| Needing manual review | 0 |

| Calibrated severity | Confirmed | Potential |
| --- | --- | --- |
| Critical | 0 | 0 |
| High | 0 | 0 |
| Medium | 6 (H007, H008, H009, H010, H019, H023) | 1 (H036) |
| Low | 6 (H024, H034, H035, H037, H038, H039) | 18 (H013, H016, H025, H026, H028, H030, H041, H044, H055, H056, H061, H062, H069, H071, H086, H092, H096, H100) |
| Info | 3 (H047, H049, H050) | 3 (H076, H080, H082) |

| Root-cause class | Count | Findings |
| --- | --- | --- |
| Spec-level design | 27 | H007, H008, H009, H010, H016, H019, H023, H024, H025, H026, H028, H030, H034, H035, H036, H044, H050, H055, H056, H062, H076, H080, H082, H086, H092, H096, H100 |
| Operational | 5 | H037, H038, H039, H061, H071 |
| Test or proof gap | 3 | H041, H047, H069 |
| Code defect | 2 | H013, H049 |

Several design findings also carried a test gap: the fuzzer's `every_holder_can_exit` skips a dust-valued "largest covered sale" (H036), and no test exercised a hook that calls the tax AMM (H028), a memo-required recipient account (H025) or a refusing hook (H026).
Most cleared hypotheses left a test gap too; the ones closed in #67 are under [Test gaps](#test-gaps).

The ten notes the ticket carried from an earlier code review of the fuzz harness (T01 to T10) were fixed on the branch before the investigation and are not counted among the findings ([Ticket notes](#ticket-notes-t01-to-t10)).

## Findings

Dispositions as of 2026-11-22: "fixed" means fixed in #67 with the regression test named below, which fails without the fix; round 2 ([round-2.md](round-2.md)) verified each.
The owner answered the questions posted on #67 on 2026-11-20 with 1a, 2a, 3a, 4a and 5a on 2026-11-22: 1a to 4a chose the fixes below, and 5a signed off every Low left open, recorded with its reason in [sign-offs.md](sign-offs.md).
Each answer is a default the program's designer may change.

| ID | Title | Status | Severity | Root-cause class | Disposition |
| --- | --- | --- | --- | --- | --- |
| H007 | A live transfer hook turns an Open market into a honeypot | Confirmed | Medium | Spec-level design | Fixed (1a, `TransferHookNotAllowed`) |
| H008 | A live mint authority drains the real reserve | Confirmed | Medium | Spec-level design | Fixed (1a, `MintAuthoritySet`) |
| H009 | A creator holding every role stages a rug | Confirmed | Medium | Spec-level design (composite) | Fixed (1a and 2a); remainder is H036, signed off |
| H010 | The tax authority's capital-free rate flip around a victim swap | Confirmed | Medium | Spec-level design | Fixed (2a, `RATE_CHANGE_DELAY_SLOTS`) |
| H019 | A seeder lured into a look-alike market (the seed binds no terms) | Confirmed | Medium | Spec-level design | Fixed (4a, `TermsChanged`) |
| H023 | The tax authority redirects or front-runs recipients' owed tax | Confirmed | Medium | Spec-level design | Fixed (3a, `OwedSlotRedirected`) |
| H036 | The exit guarantee broken by tokens held outside the market | Potential | Medium | Spec-level design | Signed off (5a) |
| H024 | A recipient named as an unpayable or market-owned address | Confirmed | Low | Spec-level design | Fixed (`NotAWallet`) |
| H034 | The router is every market's only exit | Confirmed | Low | Spec-level design | Signed off (5a) |
| H035 | A recipient's sandwich is cheaper than an outsider's | Confirmed | Low | Spec-level design | Signed off (5a) |
| H037 | Lowering `MAX_TAX_BPS` in an upgrade blocks markets above it | Confirmed | Low | Operational | Signed off (5a) |
| H038 | No pre-deploy release gate for tax AMM upgrades | Confirmed | Low | Operational | Fixed (release gate) |
| H039 | A single shared upgrade key | Confirmed | Low | Operational | Signed off (5a; mainnet checklist) |
| H013 | `pipeline_seed_liquidity` measures `taken` across both transfers | Potential | Low | Code defect | Closed by 1a |
| H016 | A freeze authority freezes vaults, recipients or holders | Potential | Low | Spec-level design | Fixed (1a, `FreezeAuthoritySet`) |
| H025 | A recipient's token-account configuration blocks its payouts | Potential | Low | Spec-level design | Signed off (5a) |
| H026 | A hook strands owed tax or the suite share | Potential | Low | Spec-level design | Closed for foreign hooks by 1a; remainder signed off |
| H028 | A hook acts as tax authority between the router's steps | Potential | Low | Spec-level design | Closed for foreign hooks by 1a and 2a; remainder signed off |
| H030 | A hook behaves differently in simulation than in execution | Potential | Low | Spec-level design | Signed off (5a) |
| H041 | The layout the containment hook reads is not tied at compile time | Potential | Low | Test or proof gap | Fixed (compile-time asserts) |
| H044 | A compromised tax authority cannot be rotated; renounce freezes whatever is set | Potential | Low | Spec-level design | Signed off (5a) |
| H055 | The seeder sets the opening price and trades first | Potential | Low | Spec-level design | Signed off (5a) |
| H056 | A market's age is its creation, not its opening | Potential | Low | Spec-level design | Signed off (5a) |
| H061 | A recipient makes `distribute` callers pay its account rent again | Potential | Low | Operational | Signed off (5a) |
| H062 | Created markets naming any seeder live forever | Potential | Low | Spec-level design | Signed off (5a) |
| H069 | The version byte is never read | Potential | Low | Test or proof gap | Fixed (`NewerStateVersion`) |
| H071 | The devnet suite treasury is compiled in | Potential | Low | Operational | Signed off (5a; mainnet checklist) |
| H086 | Supply kept outside the seed sells into buyers' quote | Potential | Low | Spec-level design | Signed off (5a) |
| H092 | Look-alike markets for traders | Potential | Low | Spec-level design | Signed off (5a) |
| H096 | Rates raised inside their range before an exit | Potential | Low | Spec-level design | Signed off (5a) |
| H100 | Published wording overstates the honeypot guarantee | Potential | Low | Spec-level design | Fixed (wording) |
| H047 | The build-time constants' safe ranges are not asserted at compile time | Confirmed | Info | Test or proof gap | Fixed (compile-time asserts) |
| H049 | Underflows reported as `Overflow` | Confirmed | Info | Code defect | Fixed (`Underflow`) |
| H050 | Dust trades pay above the 10% cap by under one unit | Confirmed | Info | Spec-level design | Info: documented |
| H076 | A ground recipient wallet pushes its own payout past the default compute limit | Potential | Info | Spec-level design | Signed off (5a) |
| H080 | A creator's hook refuses its own seed | Potential | Info | Spec-level design | Signed off (5a) |
| H082 | Buy and sell tax names flip when the tax side is the token | Potential | Info | Spec-level design | Info: interfaces label by direction |

## Medium findings

Each Medium is spec-level design: the program does what the spec and the decision register say, and the finding is that what they permit does harm.
Each fix changed a decision, so each waited on the owner, who chose 1a, 2a, 3a and 4a on 2026-11-22; every decision is a default the program's designer may change.

### H007: A live transfer hook turns an Open market into a honeypot

What: `mint_rules::check_mint` admits a TransferHook naming any program with a live hook authority (`programs/mint-rules/src/lib.rs:42-52`), `NewMarket::create` checks each mint once (`src/instructions/init_market.rs:107-113`), and no instruction reads the hook again.

Why it matters: the creator launches with a benign hook, lets buyers in, then repoints the hook, upgrades the hook program or edits an account it reads, so every transfer into the token vault is refused unless its source is the creator.
Sells are the router's input transfer into the vault, so they all fail before the tax AMM runs; buys are the tax AMM's own transfer out of the vault, which the new hook allows, so buys keep landing and paying tax.
Liquidity has no withdraw path ([`TAX-11`](../../decisions.md#tax-11-locked-liquidity)), so the quote stays in the vault for good while the creator sells a retained bag through its allowlist.
In the exact-integer model, a creator who kept 5%, 10% or 20% of supply takes 17.1%, 32.3% or 58.2% of buyers' payments on a single-sided launch, and 72.9%, 57.7% or 31.8% of what buyers paid is locked for good.
CVSS 7.3, calibrated to Medium because the lever is the creator's own, visible on chain and flagged by Pipeline's `transfer-hook-authority` trust flag before anyone buys, as the buy wall's H001 was.

Evidence: `ALLOWED_MINT_EXTENSIONS` admits `TRANSFER_HOOK` with no condition on its program or authority; `check_mint` runs only inside `NewMarket::create`.

Fix: the options of question 1 on #67.
1a admits a hook at creation only if all 64 bytes of the extension are zero or it is the containment hook with the mint's unlock PDA as its authority, so no foreign hook code ever runs inside the tax AMM's transfers, and adds H008's seed-time rule.
1b is that hook rule alone.
1c keeps `TAX-16` as it is, disclosed only, with a written downgrade to Low.
Proposed regression tests: `sos_h007_a_market_is_refused_while_a_mints_transfer_hook_is_live`, `sos_h007_a_token_whose_hook_was_cleared_creates_and_trades`, `sos_h007_the_containment_hook_with_any_other_authority_is_refused`, `sos_h007_a_contained_token_creates_binds_seeds_trades_and_unlocks` and `sos_h007_a_flipped_hook_refuses_every_sell_but_the_creators`.

Disposition: Fixed by the owner's answer 1a of 2026-11-22 in `ed84acb`: creation refuses a transfer hook unless it is cleared or is the containment hook with the mint's unlock PDA as its authority (`TransferHookNotAllowed`, `src/mint_levers.rs`); regression test `sos_h007_a_mint_whose_transfer_hook_could_refuse_sells_is_refused` (`tests/mint_rules.rs`), through the router and through a launchpad.

### H008: A live mint authority drains the real reserve

What: nothing reads a mint's mint authority, at creation, at the seed or after; `programs/mint-rules/src/lib.rs:7-8` allows it "since USDC has both".

Why it matters: a creator who keeps the token's mint authority mints and sells into the curve after buyers arrive.
The model took 98.83% of the real quote with a 100x mint on a two-sided 5%/5% market, 99.50% with a `u64::MAX` mint, and 99.0% to 100% on single-sided launches, where the real-reserve cap only sets how much must be minted.
The spec's "nobody, the creator and us included, can pull liquidity" ([`docs/spec/tax-amm.md`](../../spec/tax-amm.md), "Locked for good") is false in economic terms while a mint authority is live.
CVSS 6.8, calibrated Medium: Pipeline's `mint-authority` trust flag and Canary's `token_authorities` disclose it before purchase, but the decision's stated reason is the quote mint, the market does not record which side is the launched token, and Canary gives no figure for an authority held by a program address.

Evidence: `check_mint` (`programs/mint-rules/src/lib.rs`) reads only the owner and the extensions; `take_seed` (`src/instructions/seed.rs:110`) reads no mint field.

Fix: the options of question 1 on #67.
1a refuses at the seed, on both seed paths, a live mint authority or freeze authority on every mint not on a build-time quote list (both native SOL mints and the cluster's USDC); the refusal sits at the seed, not at creation, because a contained token's `bind` needs the mint authority after the market exists, so a contained launch revokes it between `bind` and the seed, which changes [`HOOK-12`](../../decisions.md#hook-12-mint-rules-at-binding).
1b and 1c leave mint authorities allowed and disclosed, with H008 downgraded to Low in writing.
Under 1a what is left is supply held outside the seed (H036, H086), bounded and readable from the mint before anyone buys.
Proposed regression tests: `sos_h008_a_seed_is_refused_while_a_non_quote_mint_keeps_its_mint_authority`, `sos_h008_a_graduation_is_refused_while_a_non_quote_mint_keeps_its_mint_authority`, `sos_h008_a_listed_quote_with_a_mint_authority_seeds_and_trades`, `sos_h008_a_tax_on_the_token_side_does_not_sidestep_the_rule` and `sos_h008_a_contained_token_seeds_after_bind_and_revoke`.

Disposition: Fixed by answer 1a in `ed84acb`: both seed paths refuse a mint outside the quote list (`TAX-58`) that keeps a mint authority (`MintAuthoritySet`); regression test `sos_h008_a_mint_with_a_mint_authority_is_refused_at_the_seed` (`tests/mint_rules.rs`).

### H009: A creator holding every role stages a rug

What: nothing stops one key from being the seeder, the tax authority, the sole recipient and the token's mint, freeze and hook authority; there are no key-inequality checks in `src/params.rs`, `src/instructions/init_market.rs` or `src/instructions/set_recipients.rs`, and `authorize_tax_authority` (`src/state.rs:138-152`) has no status gate.

Why it matters: the creator snipes in the seed transaction (its own tax returns to it, H055), raises the buy tax on organic buyers inside the range (H010), then freezes holders (H016), flips the hook (H007) or mints and sells (H008), and sweeps its owed tax with `distribute`.
In the model (single-sided, a 30 SOL virtual reserve, 40 organic buys of 1 SOL) it took 39.587 SOL of buyers' 40.100 SOL (98.7%), everything but Pipeline's fee and the suite share; the mint-and-sell step alone took 36.100 SOL (90.0%), so the composite adds the tax, not a new capability.
Washing `tax_collected` buys a rugger nothing, since only a contained token has an unlock goal and it has no flippable hook or freeze; but `HOOK-12` lets a contained token keep its mint authority, so the mint-and-sell step survives containment.
CVSS 6.5, calibrated Medium as the buy wall's H061 was: every extracting lever is a token authority visible and flagged before purchase.

Evidence: the levers of H007, H008, H010 and H016, all reachable from one key; `set_recipients` accepts duplicate recipients (`src/params.rs:115-144`).

Fix: the options of question 1 on #67.
1a breaks the decisive steps with one seed-time rule on the launched token (no mint authority, no freeze authority, no live hook other than the containment hook); the rate step is question 2's (H010).
1b removes only the hook step; 1c keeps every lever, disclosed only, with a written downgrade to Low.
Proposed regression tests: `sos_h009_a_seed_is_refused_while_the_untaxed_mint_keeps_a_mint_authority`, the same for a freeze authority and a live hook other than containment, `sos_h009_a_contained_token_seeds_only_after_its_mint_authority_is_revoked` and `sos_h009_every_role_creator_takes_no_more_than_its_tax_share_and_its_own_bag`.

Disposition: Fixed by answers 1a (`ed84acb`) and 2a (`4d025f0`): the hook flip, the mint-and-dump, the freeze and the rate flip are each refused, with the regression tests of H007, H008, H016 and H010; what the composite keeps, supply held outside the seed selling first, is H036 and H086, signed off by the owner (answer 5a, 2026-11-22; [sign-offs.md](sign-offs.md)).

### H010: The tax authority's capital-free rate flip around a victim swap

What: `set_taxes` writes the new rates straight into the market state after the range check (`src/instructions/set_taxes.rs:12-32`), and `pipeline_swap` prices with the rates as they stand ([`TAX-05`](../../decisions.md#tax-05-tax-authority), "each taking effect at once").

Why it matters: the authority sends `[set_taxes(high), victim's swap, set_taxes(posted)]` in one bundle, with no capital and no price risk, and the posted rates are unchanged afterwards; only the victim's `min_amount_out` bounds it.
A 10 SOL buy into a 100 SOL pool at a posted 1% tax with a range of 0 to 10% pays 0.108 SOL more tax at Aviary's default 1% slippage, 0.541 SOL at 5%, and 0.900 SOL (9% of the trade, 0.81 SOL of it to recipients) at 10% or more.
CVSS 2.6, calibrated up to Medium: a repeatable, capital-free transfer from every reachable trader to parties the authority names, through a protocol instruction, as the buy wall's H005 was calibrated up.

Evidence: `change_taxes` stores `buy_tax_bps` and `sell_tax_bps` with no slot, delay or step limit; `TaxesChanged` carries no previous rates, so spotting a bracketing pair needs a stateful indexer.

Fix: the options of question 2 on #67.
2a makes a rate change take effect only after a delay longer than any transaction's lifetime (a build-time constant of 300 slots, about two minutes), storing the pending rates and their slot in the market state's reserved bytes, so no offset the containment hook reads moves; decreases wait too.
2b accepts it, the router's minimum output being the trader's protection, with Aviary showing each rate's headroom and a written downgrade to Low.
2c caps how far one change may move a rate, one change per slot, which shrinks the take (0.05 SOL per 10 SOL at a 50 bp step) but never removes it.
A delayed change also closes H028 and the authority's part of H035, and turns H096 into a change traders can see ahead of time.
Proposed regression tests: `sos_h010_a_rate_change_applies_only_from_its_activation_slot` and `sos_h010_a_rate_flip_bundled_around_a_swap_takes_at_most_the_victims_slippage`, or for a step cap `sos_h010_a_rate_change_beyond_the_step_is_refused` and `sos_h010_a_second_rate_change_in_one_slot_is_refused`.

Disposition: Fixed by answer 2a in `4d025f0`: a change of rates waits `RATE_CHANGE_DELAY_SLOTS` (300 slots) as pending rates, so it can never reach a swap already signed; regression test `sos_h010_a_rate_change_never_reaches_a_swap_in_the_same_transaction` (`tests/rate_changes.rs`), and the fuzzer's invariant 4 checks that the rates in force never change within a slot.

### H019: A seeder lured into a look-alike market (the seed binds no terms)

What: `seed(amount_0, amount_1)` binds nothing about the market it seeds (`src/instructions/seed.rs:18-59`): not the virtual reserve, the ranges, the authority, the recipients or the tax side.
Anyone can create a market naming any seeder (`src/params.rs:65-67` refuses only the default key), and the virtual reserve has no bound.

Why it matters: an attacker creates a decoy naming the victim as seeder, with a virtual reserve of 10^12 on one side, and gets the victim to sign `seed` on it, through a frontend or script that hands over the address.
The first swap then takes the victim's whole real reserve on the other side for dust: in the model, 1 unit in took 1,000,000 units out of a 1,000,000 seed.
The rest of the victim's capital is locked for good under the attacker's terms, and the attacker, as authority and recipient, taxes every later trade.
About CVSS 5.3; Medium rather than the buy wall's Low for the same lure (its H025), because there the attacker could only capture tax and here a lever independent of the tax takes the seed itself; not High, because the victim must sign a seed on a market it did not vet.

Evidence: the `Seed` accounts check only `has_one = seeder` (`src/instructions/seed.rs:21`); `InitParams::validate` puts no upper bound on `virtual_reserve`.

Fix: the options of question 4 on #67.
4a makes `seed` take the 32-byte hash of the market's terms as stored (sides, mints, ranges, rates, authority, recipients, shares, burn share, virtual reserve) and refuse a mismatch (`TermsChanged`), which also closes the cleared H020; the metadata's `seed` action, the client, the demo and Aviary's form compute it.
4b accepts it, since Aviary builds the creation and the seed in one transaction for one signer, with a written downgrade to Low.
A bound on the virtual reserve at creation, as a `src/config.rs` constant or a ratio to the seed, was considered as a secondary measure.
Proposed regression test: `sos_h019_a_seed_on_a_decoy_with_a_hostile_virtual_reserve_is_refused_by_the_expected_terms`.

Disposition: Fixed by answer 4a in `deae3ee`: `seed` takes the hash of the market's terms and refuses a mismatch before anything moves (`TermsChanged`, `TAX-59`); regression test `sos_h019_a_seed_whose_terms_are_not_the_markets_is_refused` (`tests/seed.rs`).

### H023: The tax authority redirects or front-runs recipients' owed tax

What: `set_recipients` renames any used slot and refuses only emptying a slot that is still owed (`src/instructions/set_recipients.rs:28-38`); duplicate recipients are allowed (`src/params.rs:115-144`); and a slot's wallet is read at payout time (`src/state.rs:173-183`).

Why it matters: in one transaction the authority sends `set_recipients` naming itself in every slot, shares unchanged, then `distribute` for each slot, and takes every third-party recipient's unpaid tax; the suite share and the burn cannot be redirected, being constants.
Variants front-run a recipient's own `distribute`, which needs ordering power, or swap two recipients' wallets.
With shares of 60/30/10 and 100 SOL of tax a day, the third parties' exposure is their unpaid accrual: 3.375 SOL after 1 hour, 20.25 SOL after 6 and 81.0 SOL after 24; a daily keeper pass caps it at about a day of flow, never at zero.
Medium because third-party funds are taken atomically, with no signature or warning, and the spec's remedy ("the recipient calls `distribute`") cannot act inside the same transaction; capped at Medium because the authority is a role the creator picks and the spec states the rename power.
The investigator rated it Medium if third-party recipients are a product promise, and Low if the owner accepts it with Aviary's wording.

Evidence: [`TAX-10`](../../decisions.md#tax-10-payout) books owed amounts to slots, not wallets, and [`TAX-39`](../../decisions.md#tax-39-emptying-a-recipient-slot-that-is-still-owed) allows renaming an owed slot.

Fix: the options of question 3 on #67.
3a makes `set_recipients` refuse to change the wallet of a slot that is still owed tax (a new error), so the authority must pay it out first, in the same transaction if it likes; a slot whose wallet cannot receive (a frozen or memo-required account, H016, H025) then cannot be handed to another wallet until it can, though its share can still be cut to 1 bp.
3b accepts it as the spec documents, with Aviary's panel warning that a live authority decides where unpaid tax goes, and a written downgrade to Low.
H024's refusal of the market's own addresses, which turned this rename into a silent burn, is fixed either way.
Proposed regression tests: `sos_h023_set_recipients_refuses_to_change_the_wallet_of_a_slot_that_is_still_owed`, `sos_h023_swapping_two_owed_slots_wallets_is_refused` and `sos_h023_owed_follows_the_slot_to_its_new_wallet`.

Disposition: Fixed by answer 3a in `c8fe315`: `set_recipients` refuses to hand a slot still owed tax to another wallet (`OwedSlotRedirected`, `TAX-39`); regression test `sos_h023_set_recipients_refuses_to_hand_an_owed_slot_to_another_wallet` (`tests/tax_authority.rs`).

### H036: The exit guarantee broken by tokens held outside the market

What: on a single-sided launch, tokens held outside the market (kept back at launch, airdropped) are claims on the real reserve at the unbacked virtual price; `settle` refuses a payout above the real reserve (`src/pricing.rs:203-229`) but accepts the largest sale the real reserve covers.

Why it matters: after a 1 SOL buy into a launch with a 30 SOL virtual reserve and 5%/5% taxes, a retained 5% bag sells first and takes the whole real quote (0.95 SOL at a 0% sell tax, 0.9025 SOL at 5%).
The buyer's sale of all its 29.2e12 units is then refused (`InsufficientLiquidity`), and the largest sale the reserve covers, 31,666 units, is dust.
`TAX-52` is satisfied as written, since the refusal reason is an allowed one and "the largest covered sale must quote" is vacuous on dust, and the fuzzer's `every_holder_can_exit` skips the case, because it asserts only when `spec_price(covered).is_ok()`.
Smaller edges: a real reserve of zero before the first buy (allowed; it waits for a buy), and a real reserve of 0 or 1 unit under a 10% sell tax, where even the covered sale is `ZeroOutput`.
Medium because no authority is needed and the product sells single-sided virtual-reserve launches and calls the exit guarantee a safety property; the buy wall's equivalent (its H019) was refuted, because sells always complete there.
Its dust edges alone would be Low.

Evidence: `settle` caps at `sides.reserve_out` (`src/pricing.rs:211-213`); the guard in `every_holder_can_exit` (`tests/common/fuzz/tax.rs`).

Fix: the spec now says what locked liquidity means: no instruction removes it, and tokens held outside the market, kept back or minted later, sell into the curve and on a virtual-reserve market can take everything buyers paid in (`docs/spec/tax-amm.md`, "Locked for good", added in #67).
The rest is in question 5 on #67, which lists H036 with the Lows that stay open: 5a signs it off with its reason, 5b names it to be fixed first.
Measures considered: restating `TAX-52` as "a quote is refused only as dust or by the real reserve"; counting a dust-valued covered sale as a tally in `every_holder_can_exit` instead of skipping it; a Canary check on retained supply beside a virtual reserve; or a per-transaction cap on the share of the real reserve one sale may take.
Under 1a of question 1, the unbounded form (a live mint authority, H008) is gone and what remains is supply anyone can count before buying.
Proposed regression test: `sos_h036_a_buyer_cannot_sell_after_an_outside_bag_takes_the_real_quote`.

Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).

## Low and Info findings

### Fixed

- **H024** (`src/params.rs:115-144`, `src/instructions/set_recipients.rs:28-38`, `src/instructions/distribute.rs:132-155`): a creator or tax authority could name as a recipient an address no key can sign for (the vault authority PDA, a vault, the market state, a mint, the program, the router's market signer), so `distribute` paid the slot into an associated token account nothing could ever move while `Distributed` read as paid; with H023's rename it destroyed a third party's owed tax.
  Fixed: creation and `set_recipients` refuse with `NotAWallet` a recipient that is the market state, its vault authority, a vault, a mint, the tax AMM, the router, the market's signer under the router, SPL Token, Token-2022 or the associated token program, the buy wall's `POOL4-52` rule; the spec states it under "Creation parameters".
  Regression tests: `sos_h024_a_market_whose_tax_recipient_is_one_of_its_own_addresses_is_refused` (`tests/create_market.rs`) and `sos_h024_set_recipients_refuses_one_of_the_markets_own_addresses` (`tests/tax_authority.rs`).
- **H038** (`scripts/deploy-devnet.sh:177-184`): `deploy-devnet.sh` runs a program's `scripts/pre-deploy.sh` when one exists, and the tax AMM had none, so an upgrade could strand every live market unchecked; it is the step that would have caught H037, H041 and H069.
  Fixed: `programs/tax-amm/scripts/pre-deploy.sh` copies every tax market on the cluster and the deployed program, and lets the deploy go ahead only if the new bytes read every market and quote it each way at the spec's price exactly as the deployed build does (`tests/release_gate.rs`); every `cargo test` runs the same gate on devnet's markets as copied on 2026-11-20; the spec states it under "Upgrades and freezing".
  Regression test: `sos_h038_the_build_reads_and_quotes_every_devnet_market_at_the_specs_price` (`tests/release_gate.rs`).
- **H041** (`src/state.rs:29-51`): the offsets the containment hook reads (`TAX_SIDE` 10, `TAX_COLLECTED` 460, `LEN` 596) were hand-typed literals tied to the struct only by tests, and the discriminator's pin was self-referential.
  Fixed: compile-time asserts tie `LEN`, `TAX_SIDE` and `TAX_COLLECTED` to the account's real layout, and `tests/layout.rs` pins the discriminator's eight bytes as a literal.
  Regression test: `sos_h041_the_market_states_discriminator_is_the_one_live_markets_carry` (`tests/layout.rs`).
- **H047** (Info; `src/config.rs:16`, `:21`, `:31`, `src/split.rs:34`): `MAX_TAX_BPS`, `SUITE_SHARE_BPS` and `MAX_RECIPIENTS` had no compile-time domain checks; a suite share above 10,000 would panic every taxed swap, and a cap of 10,000 or more would leave every buy nothing; fail-closed at the shipped values.
  Fixed: `const` asserts in `src/config.rs` (`MAX_TAX_BPS < 10_000`, `SUITE_SHARE_BPS <= 10_000`, `MAX_RECIPIENTS + 2` fits a `u8`), with H041's commit.
- **H049** (Info; `src/instructions/seed_liquidity.rs:137-139`, `src/instructions/seed.rs:140-142`, `src/pricing.rs:219-224`): subtractions that can only fail by going below zero reported `Overflow`; the one reachable on chain is H013's escrow underflow under a hostile hook.
  Fixed: they refuse as `Underflow`, appended at the end of the error enum so no existing code number moves; `tests/idl.rs` pins the appended errors in order.
- **H069** (`src/state.rs:16-17`, `src/instructions/init_market.rs:145`): `STATE_VERSION` was written at creation and never read, so a build rolled back under markets a newer build wrote would read them with the older layout's meaning.
  Fixed: every instruction refuses a market state whose version byte is newer than the running program's (`NewerStateVersion`); the spec states it beside the market state's layout.
  Regression test: `sos_h069_a_market_state_written_by_a_newer_version_is_refused_by_every_instruction` (`tests/layout.rs`).

### Decided by the owner (question 1)

- **H016** (`programs/mint-rules/src/lib.rs:7-8`, `src/instructions/swap.rs:104-114`, `src/instructions/distribute.rs:113-155`): a live freeze authority, allowed by `TAX-16`, can freeze a vault (stopping every swap and payout of that side until thawed), a recipient's account (stopping its slot) or chosen holders (a trap of the H007 class).
  Low for the program; it rode on question 1, whose answer 1a refuses a freeze authority at the seed on every mint off the quote list.
  Disposition: Fixed by answer 1a in `ed84acb`: both seed paths refuse a mint outside the quote list that keeps a freeze authority (`FreezeAuthoritySet`); regression test `sos_h016_a_mint_with_a_freeze_authority_is_refused_at_the_seed` (`tests/mint_rules.rs`). A quote mint's issuer (Circle, for USDC) can still freeze, which `TAX-58` accepts.

### Signed off by the owner (question 5)

Question 5 listed these with H036 as the findings that stay open, each with no loss beyond what is stated or a precondition outside the program; the owner's 5a signed them all off, each with its reason in [sign-offs.md](sign-offs.md).

- **H025** (`src/instructions/distribute.rs:81-95`, `:132-155`): a recipient whose own token account requires memos, or is frozen, cannot be paid; only its own slot is blocked, and `set_recipients` can move it while the authority exists.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H026** (`src/instructions/distribute.rs:132-155`, `src/token.rs:41-78`): a hook on the tax side can refuse payouts to chosen wallets, stranding the suite share or a partner's slot; no reserve or other slot is touched; gone under 1a.
  Disposition: Closed for foreign hooks by answer 1a (`ed84acb`): a tax side can carry a live hook only if it is a contained mint, which `bind` never makes its own home market's tax side, so in any other market its transfers are refused from the start and the market can't trade; the remainder is signed off by the owner (answer 5a, 2026-11-22; [sign-offs.md](sign-offs.md)).
- **H028** (`src/instructions/set_taxes.rs:12-32`, `src/instructions/tax_authority.rs:15-41`): a tax authority that is a PDA of a mint's hook program can change the rate inside the router's own transaction, between its input transfer and its fee transfer, needing no ordering power; bounded by the range, the 10% cap and `min_amount_out`; gone under 1a and 2a.
  Disposition: Closed by answers 1a (`ed84acb`), since no hook but the containment hook, which never acts as a tax authority, runs inside a market's transfers, and 2a (`4d025f0`), since a change of rates now waits 300 slots whoever sends it; the remainder is signed off by the owner (answer 5a, 2026-11-22; [sign-offs.md](sign-offs.md)).
- **H030** (`src/instructions/swap.rs:104-114`): a hook can behave differently in simulation than in execution; the program has no simulation-dependent branch, so this is Canary's side.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H034** (`src/instructions/init_market.rs:57-72`, `:178-190`, `src/instructions/swap.rs:29-33`): every market stores the router's market signer at creation, so the router is its only exit; a router that stopped signing, or a frozen build compiled with another router's address, would lock its reserves for good, though `distribute` and the authority's actions never need the router.
  The spec now states it under "Upgrades and freezing", and `sos_h001_the_compiled_router_id_is_the_pinned_devnet_router` checks the compiled router id.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H035** (`src/pricing.rs:127-150`, `:171-197`, `src/instructions/set_taxes.rs:12-32`): a tax recipient sandwiches a victim more cheaply than an outsider, since most of its own tax comes back to it; up to about 0.79 SOL of a 5 SOL trade at 20% slippage, inside the same slippage budget as H010, which it does not stack beyond.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H037** (`src/config.rs:13-16`, `src/params.rs:77-110`, `src/pricing.rs:158-168`): an upgrade lowering `MAX_TAX_BPS` would block swaps and `set_taxes` on every market whose rates sit above the new cap; booked tax still pays out; only the trusted upgrade key can do it.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H044** (`src/state.rs:138-152`, `src/instructions/renounce_tax_authority.rs:17-18`): a compromised tax authority cannot be rotated (`TAX-05`), and `renounce_tax_authority` freezes whatever rates and recipients are set at that moment.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H055** (`src/instructions/seed.rs:85-88`, `src/instructions/seed_liquidity.rs:143-145`): the market opens in the seed, so the seeder chooses the opening price and can trade first.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H056** (`src/state.rs:105-107`, `src/instructions/seed.rs:85-91`): a market's recorded slot and time are its creation, not its opening, so an age shown from them overstates how long it has traded.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H061** (`src/instructions/distribute.rs:132-144`): a recipient that closes its token account after each payout makes the next `distribute` caller pay about 0.002 SOL of rent again; the keeper caps what it spends.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H062** (`src/instructions/init_market.rs:54-83`, `src/params.rs:65-67`): anyone can create Created markets naming any seeder, and they stay forever with no funds in them; recalibrated from Info to Low because it is the decoy step of H019.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H076** (Info; `src/instructions/distribute.rs:82-90`): a recipient wallet ground for many associated token account bumps can push its own creating payout past 200,000 compute units; any caller raising the limit pays it.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H080** (Info; `src/instructions/seed.rs:110-147`): a creator's hook can refuse its own seed; the seed reverts atomically and the market stays Created, with no funds at risk.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H086** (`src/pricing.rs:203-213`): supply kept back or pre-mined sells into the curve and takes quote in proportion, as in any constant-product pool; with a virtual reserve it is H036; recalibrated from Info to Low for consistency with H036 and the buy wall's H040.
  The spec's "Locked for good" now says so.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H092** (`src/instructions/init_market.rs:54-83`): look-alike markets for the same pair can route traders into a live authority and a wide range; Aviary's side.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).
- **H096** (`src/instructions/set_taxes.rs:12-32`): a live authority can attract buyers at a low rate and raise the sell rate inside its public range before an exit wave; two minutes' notice under 2a.
  Disposition: Signed off by the owner (answer 5a, 2026-11-22), with its reason in [sign-offs.md](sign-offs.md).

### Not decided by the owner's questions

- **H013** (`src/instructions/seed_liquidity.rs:118-141`): `pipeline_seed_liquidity` reads both escrows before `take_seed` and derives `taken` from their balances afterwards, so a hook on one mint, running inside that side's transfer, can change the other escrow's balance between the two readings; `taken` then under-reports what left, or the subtraction fails and the graduation is refused (H049's reachable underflow).
  Reserves and vaults are unaffected, since `arrived` is measured per side inside `take_seed`.
  Question 5 named H013 among the Lows fixed regardless of the answers; the addendum of 2026-11-20 said 1a would close it instead, which it did.
  Disposition: Closed by answer 1a (`ed84acb`) with no change of its own: the only live hook a mint may carry is the containment hook, which refuses every transfer of a mint not yet bound, and a mint can't be bound to a market that `pipeline_seed_liquidity` has not created yet, so no hook runs inside a graduation's transfers and `taken` is exactly what each escrow sent.
- **H039** (`scripts/deploy-devnet.sh:104-128`, `docs/spec/tax-amm.md`, "Upgrades and freezing"): one upgrade key, shared with the suite's other devnet programs, can replace the program; no value is at risk on devnet, and on mainnet everything rests on the freeze ([`TAX-21`](../../decisions.md#tax-21-mainnet-upgrade-policy)); recalibrated from Info to Low, matching the buy wall's H024.
  Disposition: Signed off by the owner (answer 5a and its addendum, 2026-11-22; [sign-offs.md](sign-offs.md)): freezing the program before mainnet stays a mainnet checklist item.
- **H071** (`src/config.rs:27-28`, `:40-49`): the devnet `SUITE_TREASURY` is compiled in with no cluster feature or build-time check, and `security.txt` carries no `source_revision`; `scripts/deploy-devnet.sh` refuses mainnet, so no scripted path ships the wrong key today; recalibrated from Info to Low, matching the buy wall's H021.
  Disposition: Signed off by the owner (answer 5a and its addendum, 2026-11-22; [sign-offs.md](sign-offs.md)): a mainnet build must name mainnet's treasury, and mainnet's USDC in `QUOTE_MINTS`, before it is frozen.
- **H100** (`src/config.rs:13-14`): the honeypot claim is true as scoped ("no tax market can be a honeypot through its tax"), but published wording that drops the scope overstates it while H007, H008 and H016 stay open.
  Disposition: Fixed in the wording in `5eccfd4`: `MAX_TAX_BPS` and the spec now say the cap guarantees the tax alone, and the mint rules govern what a mint's authorities and hook can do.
- **H050** (Info; `src/pricing.rs:158-168`): the tax is the rate rounded up to the next unit, so a dust trade pays above 10% by under one unit; documentation only.
  Disposition: Info, documented in the spec's "Pricing and the tax" (the tax is the rate rounded up to the next unit); no sign-off needed.
- **H082** (Info; `src/pricing.rs:100-123`): buy and sell tax are named by the tax side, so on a market whose tax side is the token they are flipped from a trader's view; interfaces must label rates by direction.
  Disposition: Info: interfaces label the rates by direction from the tax side, as the spec's "In Aviary" says; no sign-off needed.

## Ticket notes T01 to T10

The ticket carried ten notes on the fuzz harness from an earlier code review; none was a fault in the program.
They were fixed on the branch in `8558a43`, `73d298f` and `61923c7`, before the investigation, and are not counted among the findings.

| Note | What was weak | Regression test |
| --- | --- | --- |
| T01 | The fuzzer's `refusal()` took the first error name in the logs without checking which program raised it | `sos_t01_a_refusal_raised_by_another_program_is_never_taken_for_the_strategys` |
| T02 | Compute was unchecked on hooked markets, even for instructions that never call the hook | `sos_t02_instructions_that_never_call_the_hook_are_measured_on_hooked_markets` |
| T03 | The payout bump search was pinned only on SPL Token, and the fuzzer clamped the count with `saturating_sub` | `sos_t03_each_further_bump_costs_a_token_2022_payout_the_same` |
| T04 | Fuzz tallies were printed but never asserted | `sos_t04_a_path_the_fuzzer_stopped_reaching_fails_the_run` |
| T05 | An account holding only lamports was counted as existing, which the program treats as missing | `sos_t05_a_token_account_address_holding_only_lamports_is_created_and_counted_so` |
| T06 | The invariants test compared a list with itself | `sos_t06_each_of_the_ten_invariants_is_the_one_the_spec_states` |
| T07 | The fuzz harness was compiled into every test binary | None: a refactor with no behaviour to regress |
| T08 | `every_holder_can_exit` repeated identical quotes | `sos_t08_wallets_holding_the_same_amounts_share_one_quote_in_the_exit_check` |
| T09 | `wide_mul` and a `CreateIdempotent` builder were duplicated | `sos_t09_the_one_reference_product_is_exact` |
| T10 | The hooked-mint options were defined twice | None: a refactor with no behaviour to regress |

All the T tests are in `tests/fuzz.rs` except T09's, in `tests/maths.rs`.

## Not vulnerable

The 63 hypotheses investigated and cleared, with what protects each.
Those marked with an asterisk gained a regression test in #67 that pins the protection ([Test gaps](#test-gaps)).

| ID | Hypothesis | Why it holds |
| --- | --- | --- |
| H001* | Someone other than the market's router PDA settles a swap | `market_signer` is a `Signer` compared with the key stored at creation, derived as `["market", tax AMM id, market_state]` under the pinned router id; Anchor checks the state's owner and discriminator |
| H002 | The vault authority's or the seeder's signature reaches a hook | The authority signs only the token-program instruction; hook accounts are forwarded never as signers; Token-2022 de-escalates |
| H003 | Remaining-account substitution | The output vault and authority from the remaining accounts are compared with the market state and its PDA |
| H004* | Token program substitution | The token program is bound to each mint's owner; a substitute is refused or cannot sign |
| H005 | Invariant 1 broken | Every path moves booking and balance by the same amount; donations add only surplus; `SyncNative` is never credited |
| H006 | `distribute` pays more, twice or to the wrong place | Exactly `owed[slot]` from the pinned vault to the pinned account or burned, zeroed in the same instruction; re-entry refused |
| H011 | `tax_collected` pumped for the containment unlock | Real, but it costs a sole recipient about 12.5% of the goal and harvests nothing owed to others; accepted design, with a note for the containment spec (#74) |
| H012 | The allowlist admits a balance-changing extension | The seven allowed numbers are exactly the hook, metadata and group types; extensions cannot be added after initialisation |
| H014 | Owed booked to an unpayable slot (INV-04) | The split books only slots with a wallet; the burn is refused on native mints |
| H015 | Edges of the mint-rules parser (INV-11) | `check_mint` and `find_extension` share one iterator; a malformed walk is refused, never read as "no hook" |
| H017 | A plain wallet seeds through `pipeline_seed_liquidity` | By design: priced like a router market, tradable only once registered |
| H018 | An Open but unregistered launchpad market | Unswappable until anyone registers it; registration is permissionless |
| H020 | The authority acts between creation and a separate seed | The authority is the creator's chosen role; H019's expected terms would close it |
| H021 | A second seed or re-initialisation | Status gate before any CPI; `init` refuses an existing account; a pre-funded address still creates once |
| H022 | A fixed field written after creation | Only `set_inner` at creation writes the fixed fields |
| H027 | CPI depth makes hooked markets unroutable | The hook runs at height 4 (5 behind a caller), within the limit |
| H029 | `distribute` driven by a hook in the middle of a router swap | `recorded` includes owed, so the credit stays exact |
| H031 | Hook account injection | Appended never as signers; cannot write accounts the tax AMM owns |
| H032 | Raw byte readers without owner checks | Every site is backstopped by an address pin or a token-program operation |
| H033 | A donation surplus credited to a trader | Credit is `min(surplus, amount_sent)`; no fee-on-transfer mints |
| H040 | The interface crate pin | The revision is pinned in `Cargo.toml` and `Cargo.lock`; the router id equals the deployed router |
| H042 | Burn path edges | The burn is refused on native mints; only a freeze strands it (H016) |
| H043 | A split rounding harvest | Floors per part, a remainder under 5 units to slot 0; bounded |
| H045 | Hook accounts as multisig signers | Forced non-signer metas and a PDA authority |
| H046 | Zero-byte or stale state visible to hooks | The containment readers refuse zero bytes and read committed state |
| H048 | `credited_input` saturation | Fail-closed; diagnostics only |
| H051 | `mul_div` shifts and casts | Inputs within the proven bounds (M1 to M4) |
| H052 | Counters and ledgers at extremes | Bounded by vault balances or `u128`; checked additions |
| H053 | Zero denominators, single-sided states | `curve_out` returns 0 before dividing; a zero output is refused |
| H054 | Round-trip profit under rate changes | Rates divert only into owed, outside the reserves; the product never falls |
| H057 | No deadline; `min_amount_out` enforced only by the router | The router's settlement enforces the minimum, and the router is the only caller |
| H058 | Quote and swap diverge | One shared `fill`; they differ only by the credited amount |
| H059 | Third-party swaps block `set_recipients` | `distribute` and `set_recipients` fit one transaction; documented |
| H060 | `distribute` spam and lock contention | Ordinary write-lock contention; a zero-owed call moves nothing |
| H063 | The pair order is not canonical | By design ("in that order"); wording only |
| H064* | Pre-funded vault and market addresses | Creation tops up a pre-funded address |
| H065 | PDA seed collisions and bumps | Distinct prefix lengths; canonical bumps |
| H066 | Account type cosplay | `Account<TaxMarket>` checks owner and discriminator |
| H067 | Duplicate or aliased accounts | Refused, or harmless under token-program authority and credited input |
| H068 | `trader_output` unchecked | Documented: the account is paid exactly the quote, and only the output vault is refused |
| H070 | Suite constants changed under renounced markets | Real, but only by the upgrade key, and accepted; wording at renounce |
| H072 | Dependency issues | Exact pins; no known advisory |
| H073 | `INTERFACE_VERSION` unchecked; trailing bytes | Credit bounded by the surplus |
| H074 | Return data and events | Set last with no CPI after; nothing reads events back |
| H075 | Off-chain depth misreads; stranded donations | No consumer exists |
| H077 | A self-referential hook | Fails closed; the seed fails |
| H078 | Extensions added after creation | Token-2022 cannot add them to an initialised mint |
| H079 | A reassigned SPL Token account owner still paid | Documented in the code; refusing would strand the slot |
| H081 | The burn destroys quote value | Documented; owed is burned after the share is 0 |
| H083 | No authority versus renounced | Distinguishable; both refuse every authority action |
| H084 | `check_split` and `split_tax` disagree (INV-13) | One shared function |
| H085 | `tax_collected` diverges (INV-03) | One writer per ledger; the identity holds |
| H087 | A second market for a contained token | The hook's allowlist; a gift is stranded, never credited |
| H088 | The pool price as an oracle | No consumer in the suite; the rule is recorded for future products |
| H089 | Incomplete creation rules | Every malformed combination is refused; accepted ones price and pay |
| H090 | Keeper and `distribute` liveness | Payouts are permissionless; operational |
| H091 | `metadata.json` and IDL drift | Tests compare the metas with the program's |
| H093 | Hook side effects across mints | `arrived` is measured per transfer; reserves come from the fill |
| H094 | A test-feature build at the real address | No behavioural feature exists |
| H095 | The deployed bytes versus the reviewed source | The hash is recorded with the commit and image digest |
| H097 | The containment binding trusts the tax side | `bind` checks the router market, strategy, mint and owner |
| H098 | `pipeline_resolve_accounts` omits hook accounts | By design; Token-2022 resolves hook metas by key |
| H099 | Two hooked mints in one market | One account list serves both transfers; needs a lookup table |

Info residuals noted while clearing, with no finding of their own: the containment hook spec's "forcing an early unlock always costs a third party the whole goal" holds only for parties with no recipient share (H011, for #74); `volume` and `swap_count` can be washed (H011); `TaxesChanged` carries no previous rates (H010); and the raw byte readers in `src/token.rs` have no owner or type check of their own, backstopped at every site (H032).

## Test gaps

The investigators proposed a regression test for most cleared hypotheses: each pins a protection the code has but no test exercised.
Closed in #67:

- **H001**: `sos_h001_the_compiled_router_id_is_the_pinned_devnet_router` (`tests/hostile.rs`) checks the compiled router id against the pinned devnet router independently, since the other tests take the router address from the same constant the program compiles.
- **H004**: `sos_h004_a_swap_naming_the_other_token_program_for_its_output_is_refused`, `sos_h004_distribute_naming_another_token_program_is_refused` and `sos_h004_a_seed_naming_another_token_program_is_refused` (`tests/hostile.rs`).
- **H064**: `sos_h064_a_pre_funded_seeded_market_address_and_vaults_still_graduate` (`tests/seed_liquidity.rs`).
- Book of Knowledge invariants, which ran beside this round and proposed 13 invariants (INV-01 to INV-13), each reached by at least one hypothesis: three became fuzzer invariants in `tests/common/fuzz/tax.rs`, checked after every step: INV-04 (`every_owed_recipient_slot_names_a_wallet`), INV-05 (`tax_collected_never_passes_the_tax_sides_volume`) and INV-06 (`a_side_without_a_virtual_reserve_never_empties`).
  The property list they extend is [maths-properties.md](maths-properties.md).

Still open, by what they would catch: a hostile-hook set (H002, H003, H006, H029, H031: a hook asking for the vault authority as signer, re-entering or donating), which tests the one external assumption the vaults' safety rests on, Token-2022's de-escalation of signer flags, and needs a purpose-built hook in `programs/test-programs/`, since Pipeline's `test-hook` only allows; H012's refused-extension and H015's differential mint-walk tests; and H021's pre-funded market address.

## Combination analysis

Every pair among the 37 confirmed and potential findings was checked for whether one enables, amplifies, shares a code path with or shares state with the other.
Each chain names the critical node whose fix breaks it.

1. **The creator's staged rug** (Medium): a snipe in the seed transaction (H055), a raised buy tax on organic buyers (H010), then a hook flip (H007), a freeze of holders (H016) or a mint-and-sell (H008), optionally a hook refusing payouts to the suite or partners (H026), and `distribute` of the creator's owed tax (H009): 98.7% of buyers' spend in the model.
   Critical node: one seed-time rule on the launched token (option 1a of question 1), which removes the H007, H008 and H016 steps; a delayed rate change (2a) removes the rate step.
2. **The rate family** (Medium): a look-alike market with a 0 to 10% range and the attacker as authority and recipient (H092) collects pair-routed flow, and each victim's slippage is harvested by bundle (H010) or by the token's own hook with no bundle (H028), with a recipient's sandwich (H035) and a slow bait-and-switch (H096) beside them; no rotation keeps all of it with a leaked key (H044).
   Every form stays inside the victim's `min_amount_out` and the 10% cap.
   Critical node: a delayed rate change (2a), which closes H010 and H028 and the authority's part of H035, and makes H096 visible ahead of time; H092 needs Aviary's display either way.
3. **The owed-tax family** (Medium): a hostile or compromised authority renames every third-party slot to itself and pays out (H023), or, until #67, to the vault authority PDA to destroy it silently (H024, now fixed); recipients cannot react inside the transaction or rotate the authority (H044).
   Critical node: no wallet change while a slot is owed (3a); it conflicts with H016 and H025, since a slot that cannot receive could no longer be handed on, so they are one decision.
4. **Supply outside the seed** (Medium): any token supply outside the pool is a claim on the real reserve; with a live mint authority the claim is unbounded and unreadable (H008), and with a fixed retained bag it is bounded but can still take buyers' whole real quote first on a virtual-reserve launch (H036, H086); H019 shares the unbounded virtual reserve.
   Critical node: no live mint authority at the seed off a quote list (1a), which turns the unbounded lever into a fact anyone can read before buying; H036's question covers what remains.
5. **The seeder lure** (Medium): decoys naming a victim seeder are free to create and never expire (H062), and one signed `seed` on a decoy with a huge virtual reserve loses the seeded side to a one-unit swap (H019); the cleared H020 is the same window used by an authority.
   Critical node: the expected-terms seed (4a).
6. **Release process** (Low): one upgrade by the shared key (H039) could strand every live market through a lowered cap (H037), a layout or version change (H041, H069) or constants out of their domain (H047), or freeze the wrong treasury for good (H071); the router stays the only exit (H034).
   Critical node: the release gate (H038), now built, with the compile-time asserts (H041, H047) and the version check (H069); a checked freeze and a mainnet treasury check would break H039 and H071.
7. **Seed measurement** (Low): `taken` measured across both transfers (H013) and its underflow, which was reported as `Overflow` (H049, now `Underflow`).
   Critical node: H013's fix, `taken` set per transferred side.

No chain reached High: every chain that moves holders' funds needs a token authority flagged before purchase or a role the creator chose and published, and the two that reach a third party's funds without one (H019, H036) need the victim to sign a seed on a market it did not vet, or rest on supply anyone can count once mint authorities are gone.

Findings that enable others: H007 enables H009, H026 and H080; H008 enables H009 and H036's unbounded form; H016 enables H009; H010 enables H009, H035 and H096; H055 enables H009; H062 enables H019; H092 enables H010 and H096; H023 enables H024's grief form; H024 amplified H061; H038's absence enabled H037, H041 and H069; H039 is the single actor of H037, H038 and H071; H013 enables H049.

## Attack trees

- **Goal A: take buyers' quote out of a market.**
  Paths: a mint-and-sell (H008), a hook-flip honeypot (H007), a freeze trap with a retained bag (H016, H086), the staged composite (H009, through H055 and H010), outside supply selling first on a virtual-reserve launch (H036, H086), and a seeder lure taking the seeder's own capital (H062, then H019).
  The seed-time rule on the launched token (1a) breaks four of the six paths, the mint-and-sell, the hook flip, the freeze trap and the composite's decisive step; the outside-supply path rests on question 5 and the lure on question 4.
  The mint-and-sell and the lure's swap fit one transaction; the others play out over the market's life.
- **Goal B: divert tax owed to third parties.**
  Paths: an atomic rename and payout (H023), a rename to an unpayable address (H024), a hook refusing payouts to chosen wallets (H026), a compromised authority with no rotation (H044), and a frozen recipient account (H016).
  No wallet change while owed (3a) breaks the rename and the owed part of a compromised authority; `NotAWallet`, now built, breaks the unpayable-address path; 1a's hook rule breaks the hook path.
  The rename paths are single-transaction.
- **Goal C: take a trader's slippage as tax.**
  Paths: a bundled flip (H010), a hook-driven flip inside the router's own transaction (H028), a recipient's sandwich (H035), a slow bait-and-switch (H096), and look-alike markets bringing traders within reach of all four (H092).
  A delayed rate change (2a) breaks the bundle, the hook-driven flip and the authority's part of the sandwich, and makes the slow form visible ahead of time.
  The bundle needs one bundle; the hook-driven flip needs none, running in the victim's own transaction; the sandwich needs ordering power.
- **Goal D: break existing markets through an upgrade.**
  Paths: a lowered `MAX_TAX_BPS` (H037), a layout or version change (H041, H069), constants out of their domain (H047), the devnet treasury frozen in (H071), the shared upgrade key abused or leaked (H039), and the router no longer signing (H034).
  The release gate (H038), the compile-time asserts and the version check, all now built, break the layout, version and constant paths and would refuse a build that cannot quote a live market; a checked freeze script and a mainnet treasury check would break H071 and H039; the router path is the trusted router's own power.
- **Goal E: make a market's liquidity unreachable.**
  Paths: a hook flip refusing every sell (H007), a vault freeze stopping every swap and payout (H016), the router never signing again (H034), and a hook refusing the seed (H080, no funds at risk).
  The seed-time rule on the launched token (1a) breaks the first two.

## Severity calibration

Method: the knowledge base's impact-times-likelihood matrix, then consistency within each family and with the buy wall's calibrations.
Where a lever is the token creator's own, visible on chain and flagged by Pipeline's trust flags before anyone buys, a High raw score was calibrated to Medium, as the buy wall's H001 was.

- H007: CVSS 7.3, calibrated Medium for that reason.
- H010: CVSS 2.6, calibrated up to Medium: repeatable, capital-free and reaching every trader, as the buy wall's H005 was calibrated up.
- H019: Medium against the buy wall's Low for its H025: the unbounded virtual reserve takes the seed itself, not only tax.
- H023: Medium (the investigator offered Medium or Low): third-party funds, atomic, no victim signature.
- H036: Medium for the outside-bag drain; its dust edges alone would be Low.
- H016: Low for the program, although a selective freeze of holders is H007's class; it is decided with H009 under question 1 rather than standing as an eighth Medium.
- H035: Low; its Medium is H010's, and the sandwich beats the plain flip only above about 10% slippage.
- H037 and H038: Low (each was offered as Medium in theory): the single privileged actor, devnet-only value and the freeze before mainnet; H038 would be Medium if a live market held real value or the program were deployed beyond devnet.
- H030: Low for the program; Medium for the suite only if a hooked market were ever shown as safe because Canary showed no warning.

Recalibrated from the investigators' proposals:

| Finding | Proposed | Calibrated | Reason |
| --- | --- | --- | --- |
| H039 | Info on devnet | Low | The buy wall's same-class H024 was Low; the counters the containment hook trusts make it weigh more, not less |
| H062 | Info | Low | It is the decoy step of H019 (Medium); the buy wall's same-class H070 was Low |
| H071 | Info | Low | The buy wall's same-class H021 was Low; a wrong treasury becomes permanent at the freeze, and no check exists yet |
| H086 | Info | Low | The same mechanism as H036 (Medium) and H008's fixed form; consistent with the buy wall's H040 |
| H076 | Low | Info | Self-inflicted by the slot wallet's own key choice, bypassed by any caller raising the compute limit, no value at risk; the hook half is H007's |

## Coverage

| Area | Hypotheses | Confirmed or potential |
| --- | --- | --- |
| Access control and account validation | 17 | 5 (H019, H024, H044, H062, H092) |
| Arithmetic | 13 | 3 (H013, H047, H050) |
| State machine and error handling | 9 | 3 (H049, H069, H080) |
| CPI and external calls | 16 | 4 (H026, H028, H030, H076) |
| Token and economic | 22 | 13 (H007, H008, H009, H016, H023, H025, H035, H036, H061, H082, H086, H096, H100) |
| Oracle and external data | 7 | 1 (H034) |
| Upgrade and admin | 9 | 5 (H037, H038, H039, H041, H071) |
| Timing and ordering | 7 | 3 (H010, H055, H056) |

- Scope: `programs/tax-amm/src` and `programs/mint-rules/src/lib.rs`, 25 files and about 3,248 lines, of which about 2,700 are deployed; the tests, proofs, spec, decision register and deploy scripts were read as context.
  Pipeline's router is closed source under BSL 1.1; the review read its interface crate and treated it as a trusted caller.
- Method: a scan (an index and a static pre-scan of 350 hot spots), nine context analyses (access control, arithmetic, state machine, CPI, token economics, oracle and data, upgrade and admin, timing and ordering, the economic model), 100 hypotheses (12 in tier 1, 34 in tier 2, 54 in tier 3; 26 specific to this code), each taken to a verdict with exact-integer models where money was involved and a devil's-advocate challenge of each conclusion.
  No build or test was run during the investigation; the regression tests above were written and run afterwards, in the fixes.
- Instructions: 11 of 11, each reached by at least six findings and by at least two confirmed or potential findings.
- Exploit patterns: 56 of 56 matched patterns addressed, 55 by citation and one (token authority confusion) by analogy through H032, H045, H067 and H079.
- AMM playbook red flags: 19 of 19, 12 directly and 7 by analogy, since the program has no LP shares, ticks, withdrawal, admin or oracle consumer.
- Book of Knowledge invariants: 13 of 13 reached.
- Lower-confidence verdicts (confidence 6 or 5), resting on reading rather than a model or a test: H056, H072, H075, H080, H082, H092, H099 and H100.
- One question the review could not settle without a build: whether devnet's Token-2022 strips the signer flag from an extra-account meta naming the transfer authority even when the instruction lists it twice (H002 relies on it; the hostile-hook tests under [Test gaps](#test-gaps) would answer it).

## Recommendations carried beyond round 1

- Round 2: verify every fix above and T01 to T10 against the fixed code, and re-review the code the fixes changed.
- Before any mainnet deployment: a checked freeze script and a check that no mainnet record keeps an upgrade authority (H039); a mainnet treasury check at build time and `source_revision` in `security.txt` (H071); the router frozen and equal to the compiled id before the tax AMM is frozen (H034); and an independent external security review, which this internal review does not replace.
- Aviary and Canary: show who holds which role and token authority (the seeder included), each rate's headroom under a live authority, and the frozen values beside "renounced"; give Canary a hook-flip check and a retained-supply check (H007, H016, H036, H044, H055, H086, H092, H096, H100).
- Keeper runner: skip missing-account payouts whose owed value is below the rent (H061), pay as often as its caps allow (H023), and log failing slots (H016, H025, H026).
- Monitoring: index `TaxesChanged` with the previous rates and alert on a bracketing pair around one swap (H010).
- Never value collateral from a tax market's reserves within a transaction (H088).
- Re-run Stronghold of Security whenever the spec's economics change.
