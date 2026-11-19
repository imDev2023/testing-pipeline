# Buy wall AMM: review round 1

Round 1 of the internal adversarial review of `programs/buy-wall-amm`, run with Stronghold of Security at the "deep" tier from 2026-11-16 to 2026-11-17, at commit `72636ae`.
It is not an audit and no external review has been done; [README.md](README.md) says what was reviewed and how.
Code locations are at `72636ae`, relative to `programs/buy-wall-amm/` unless they start with `docs/`.
What happened to each finding after round 1 is in [round-2.md](round-2.md); the dispositions below are final, as of 2026-11-19.

## Summary

The program's account, signer and CPI surface held up under 111 hypotheses.
No missing signer, owner, PDA or relationship check was found; every CPI target is pinned; the vault authority signs only transfers and burns out of the market's own vaults; `pipeline_swap` runs only for the router's market PDA; credited input is bounded by the measured surplus over every recorded ledger; and the 256-bit arithmetic rounds against the trader everywhere.
No Critical or High finding was confirmed, and no finding let a stranger take funds the spec does not already route somewhere.

The material risk was economic and sat in the spec, not in a missing check.
Seven Medium findings fell into four families:

- A token's transfer-hook authority stayed live after the seed, so the token's creator kept a switch that could turn a market into a honeypot (H001, H061).
- The reward share was paid on retirements the rewards recipient could generate itself inside one transaction (H002, H005).
- The floor followed prices that existed only inside a transaction, so an atomic sell and buy back moved the whole buy wall for days (H003).
- Anyone could veto every future upgrade through the release gate for the cost of rent (H020, H058).

| Result | Count |
| --- | --- |
| Hypotheses investigated | 111 |
| Confirmed | 20 |
| Potential | 17 |
| Not vulnerable | 74 |
| Needing manual review | 0 |

| Calibrated severity | Confirmed | Potential |
| --- | --- | --- |
| Critical | 0 | 0 |
| High | 0 | 0 |
| Medium | 7 (H001, H002, H003, H005, H020, H058, H061) | 0 |
| Low | 12 (H004, H007, H008, H013, H022, H040, H050, H056, H062, H065, H066, H096) | 16 (H021, H024, H025, H026, H031, H033, H034, H041, H048, H059, H068, H070, H097, H098, H110, H111) |
| Info | 1 (H063) | 1 (H069) |

| Root-cause class | Count | Findings |
| --- | --- | --- |
| Spec-level design | 23 | H001, H002, H003, H004, H005, H007, H008, H020, H022, H025, H026, H033, H034, H040, H041, H048, H050, H056, H058, H059, H061, H070, H110 |
| Code defect | 6 | H013, H063, H065, H069, H097, H098 |
| Test or proof gap | 4 | H031, H062, H066, H068 |
| Operational | 4 | H021, H024, H096, H111 |

Several design findings also carried a test gap: the spec's round-trip invariant and the fuzzer's `RoundTrip` counted only the trader's own SOL, so no test saw value returning to the same party as rewards, fee recapture or tips (H002, H004, H005, H007, H008, H050).

## Findings

Dispositions: "fixed" means fixed in #55 and confirmed in round 2; "signed off" means accepted as a Low with the owner's sign-off of 2026-11-19 ([sign-offs.md](sign-offs.md)).

| ID | Title | Status | Severity | Root-cause class | Disposition |
| --- | --- | --- | --- | --- | --- |
| H001 | A live transfer-hook authority turns a seeded market into a honeypot or freezes its exits | Confirmed | Medium | Spec-level design | Fixed ([`POOL4-48`](../../decisions.md#pool4-48-a-transfer-hook-at-the-seed)) |
| H002 | The rewards recipient's atomic wash trade harvests the decay credit | Confirmed | Medium | Spec-level design | Amplifiers fixed ([`POOL4-49`](../../decisions.md#pool4-49-which-retired-tokens-earn-the-reward-share)); residual re-rated Low by the owner and signed off |
| H003 | A floor dragged down inside one transaction relocates the whole wall | Confirmed | Medium | Spec-level design | Fixed ([`POOL4-50`](../../decisions.md#pool4-50-when-the-walls-floor-moves), amended 2026-11-19); residuals signed off |
| H004 | Floor crawl captured by buy, `place_wall`, sell | Confirmed | Low | Spec-level design | Fixed (`POOL4-50`) |
| H005 | An atomic deep-dip trim cuts curve liquidity beyond the decay allowance | Confirmed | Medium | Spec-level design | Fixed (`POOL4-49`, with R2-01) |
| H007 | Wall-wash rebate: sell into a near-price wall, `place_wall`, buy back | Confirmed | Low | Spec-level design | Fixed (`POOL4-49`, `POOL4-50`) |
| H008 | The fee recipient farms the keeper tip through fee recapture | Confirmed | Low | Spec-level design | Same-transaction form closed by `POOL4-50`; cross-slot residual signed off |
| H013 | Release gate vetoed by an unregistered `pipeline_seed_liquidity` market | Confirmed | Low | Code defect (gate) | Fixed ([`POOL4-47`](../../decisions.md#pool4-47-markets-the-router-has-not-recorded)) |
| H020 | Release gate blocked by a hooked, parked or never-seeded market | Confirmed | Medium | Spec-level design (gate) | Fixed ([`POOL4-46`](../../decisions.md#pool4-46-when-a-failed-step-counts-against-a-candidate)) |
| H021 | Fee slots 1 and 2 lockable (zero `DESIGNER_RECIPIENT` frozen in; treasury ATA owner reassigned) | Potential | Low | Operational | Signed off |
| H022 | A one-step handover to a dead address silently burns a role's income | Confirmed | Low | Spec-level design | Fixed ([`POOL4-52`](../../decisions.md#pool4-52-which-wallets-a-role-may-be-handed-to)) |
| H024 | The upgrade authority can drain every vault, close the program, or freeze before `DESIGNER_RECIPIENT` is set | Potential | Low | Operational | Signed off |
| H025 | A seeder lured into a look-alike market (the seed binds no expected parameters) | Potential | Low | Spec-level design | Signed off |
| H026 | The creator hands over a recipient between create and seed | Potential | Low | Spec-level design | Signed off |
| H031 | CPI depth makes some hooked tokens unroutable; the hook as a kill switch | Potential | Low | Test or proof gap | Fixed (`POOL4-48`) |
| H033 | The release gate judges keeper-job coverage by the candidate's own due rules | Potential | Low | Spec-level design (gate) | Fixed (with R2G-03); one narrow gap pending the owner |
| H034 | The release gate is blind to value-moving constants, added instructions and handovers | Potential | Low | Spec-level design (gate) | Awaiting the owner's sign-off |
| H040 | A third party thins the curve at the full decay rate | Confirmed | Low | Spec-level design | Signed off |
| H041 | The rewards recipient times `place_wall` to maximize retirement at dips | Potential | Low | Spec-level design | Motive fixed (`POOL4-49`) |
| H048 | A hook-blocked `pay_rewards` strands the reward ledger | Potential | Low | Spec-level design | Fixed (`POOL4-48`) |
| H050 | Keeper jobs interleaved inside a round trip change its result | Confirmed | Low | Spec-level design | Fixed (`POOL4-50`) |
| H056 | The rewards recipient recycles rewards into the wall | Confirmed | Low | Spec-level design | Fixed (`POOL4-49`) |
| H058 | A recipient's token-account configuration blocks payouts and vetoes the gate | Confirmed | Medium | Spec-level design (gate) | Fixed (`POOL4-46`) |
| H059 | Decay credit hoarded, then spent before a large sell | Potential | Low | Spec-level design | Signed off |
| H061 | A creator holding every role stages a rug (hook, wash, wall-wash) | Confirmed | Medium | Spec-level design (composite) | Fixed (`POOL4-48`, `POOL4-49`) |
| H062 | The fuzzer accepts any refusal for `settle`, `pay_rewards` and `sweep_fees` | Confirmed | Low | Test or proof gap | Fixed |
| H063 | `set_recipient` accepts a handover to the current recipient | Confirmed | Info | Code defect | Fixed (`POOL4-52`) |
| H065 | `Owed::sweep`'s wildcard arm is unreachable; two slot matches kept aligned by hand | Confirmed | Low | Code defect | Fixed |
| H066 | The 764 s default-tier Kani harness duplicates `proofs/payouts_z3.py` | Confirmed | Low | Test or proof gap | Fixed |
| H068 | The Kani step harnesses are `kani_full` only and CI never runs them | Potential | Low | Test or proof gap | Docstring fixed; no full tier in CI signed off |
| H069 | Misleading error codes (`Overflow` for a ledger underflow) | Potential | Info | Code defect | Not fixed; Info, not gated |
| H070 | CREATED markets live forever: decoys, locked rent, listing pollution | Potential | Low | Spec-level design | Signed off |
| H096 | A router pause blocks every exit | Confirmed | Low | Operational | Signed off |
| H097 | A vacuous gate pass on an empty cluster, and a deploy race | Potential | Low | Code defect (gate) | Vacuous pass fixed ([`POOL4-53`](../../decisions.md#pool4-53-every-gate-run-trades-a-market-of-its-own)); race signed off with R2G-06 |
| H098 | A `test-designer-recipient` build deployed at the real address | Potential | Low | Code defect (gate) | Fixed (`POOL4-53`) |
| H110 | The seeder chooses the opening price and trades first | Potential | Low | Spec-level design | Signed off |
| H111 | Keeper runner liveness | Potential | Low | Operational | Signed off |

## Medium findings

### H001: A live transfer-hook authority turns a seeded market into a honeypot

What: the seed refused a live mint or freeze authority, but never read the Token-2022 TransferHook extension, so the hook program and the hook authority stayed live after the seed (`src/instructions/seed.rs:162-172`).
The test harness itself seeded every hooked market with the hook authority still set.

Why it matters: a creator launches a token with a benign hook it controls, seeds a market and lets holders buy, then repoints or upgrades the hook so it refuses every transfer whose source is not the creator.
Holders cannot sell; the creator sells into the curve and down through the wall.
That is a selective honeypot, stronger than the freeze the mint rules were written to prevent, and it broke `POOL4-10` and the holder-exit property behind `POOL4-36`.
The model put the creator's take at 52% of the pool for a seed-sized bag (H061).
CVSS 7.3, calibrated to Medium because the lever is the token creator's own, visible on chain and flagged by Pipeline's trust flags and Canary before anyone buys.

Evidence: `check_authorities_removed` required only `mint_authority.is_none()` and `freeze_authority.is_none()`; `tests/common/mod.rs:376-380` and `:430-448` seeded with the hook authority set.

Fix: [`POOL4-48`](../../decisions.md#pool4-48-a-transfer-hook-at-the-seed).
Both seeding paths refuse with `TransferHookLive` a token whose TransferHook extension still names a hook program or a hook authority, so a hooked token is seeded only with all 64 bytes of the extension zero; once both are cleared Token-2022 can never set them again.
Regression tests: `sos_h001_a_seed_is_refused_while_the_tokens_transfer_hook_is_live` and `sos_h001_a_token_whose_transfer_hook_was_cleared_seeds_and_trades` (`tests/seed.rs`), `sos_h001_a_graduation_is_refused_while_the_tokens_transfer_hook_is_live` (`tests/seed_liquidity.rs`), and the gate's `sos_h001_a_market_waiting_for_its_seed_whose_token_has_a_live_hook_is_seeded_with_the_hook_cleared`.

### H002: The rewards recipient's atomic wash trade harvests the decay credit

What: in one transaction the rewards recipient buys, sells straight back, calls `settle`, then `pay_rewards`.
The buy spends the accrued decay credit through the ratchet, the sell back is trimmed down to the lowered cap, and `settle` credited `floor(retired x reward_share)` to the recipient (`src/cap.rs:171-200`, `src/payouts.rs:25-31`).

Why it matters: the wash decouples the creator's published reward budget from demand, so a quiet market pays it out in days, and holders bear it as lost exit liquidity.
At the defaults on a 10 SOL curve the recipient netted about +0.28 SOL on day 1 and +0.91 SOL (9.1% of curve SOL) over 4 days, and up to +2.85 SOL (28.5%) at the most extreme parameters a creator may choose.
CVSS 4.7.

Fix: [`POOL4-49`](../../decisions.md#pool4-49-which-retired-tokens-earn-the-reward-share) pays the reward share only on trimmed tokens the cap's own fall matched.
That removed the amplifiers (H005, H007, H056) and caps the lifetime take at the budget, but the wash itself retires tokens matched almost one for one by the cap's fall, so it stays reward-eligible.
Round 2 measured the residual at about 7.8% of curve SOL over 4 days at the defaults and up to 21.7% in one day at the extremes.
The owner re-rated H002 to Low on 2026-11-19 and signed off the residual, which the spec's explainer risks disclose.
Regression test: `sos_h002_the_rewards_recipients_wash_trade_earns_no_more_than_the_cap_fall_budget` (`tests/reward_share.rs`).

### H003: A floor dragged down inside one transaction relocates the whole wall

What: the floor dropped to every swap's post-trade price, including a price that existed only between two instructions of one transaction, while the reference deliberately ignored same-slot prices (`src/guard.rs:86-89`, `:111-113`).
`place_wall` then put all the wall's SOL at `min(price, floor)` (`src/wall.rs:263`), and the floor climbs back only about 4% a day.

Why it matters: in one transaction, sell to a chosen dip, buy back (the old wall sells back every token it bought), then `place_wall`.
For 0.0135 SOL a 1 SOL wall moved 10% down for about 1.6 days; for 0.0835 SOL it moved to half the price for about 16.5 days, repeatable at will.
No SOL left the market, but the buy wall, the product's central holder protection, was displaced for days to weeks, and combined with a tight cap the same dip paid the rewards recipient (H005).
CVSS 6.4.

Fix: [`POOL4-50`](../../decisions.md#pool4-50-when-the-walls-floor-moves).
The floor changes only at a slot's first update, crawling toward the reference and dropping to the previous slot's close; `place_wall` is refused with `SwapThisSlot` in a slot a swap ran in.
Round 2 found that this rule alone made a back-run of a fall across one slot boundary profitable (see [round-2.md](round-2.md), H003), so on 2026-11-19 the owner amended `POOL4-50` to a hybrid: every placement is also capped at the lowest close of the last slot that traded, a new field `last_slot_low`.
Residuals signed off: a dip bought back within one slot lets the next `place_wall` put the wall low once, until idle SOL refills; a dip held across a slot boundary still lowers the floor (R2-02).
Regression tests: `sos_h003_a_dip_bought_back_in_its_own_slot_never_moves_the_floor_or_the_wall` and `sos_r2v_backrun_of_a_fall_across_one_slot_never_pays` (`tests/wall.rs`).

### H005: An atomic deep-dip trim cuts curve liquidity beyond the decay allowance

What: the trim runs at the post-trade price, so from a tight cap one sell to `s_low` and a buy back to `s0` leaves price and cap unchanged and cuts the curve to `L x s_low / s0` (`src/cap.rs:142-143`, `src/instructions/swap.rs:169-180`).
A tight cap is routine: right after the seed, after every trimmed sell and after any full ratchet.

Why it matters: the rewards recipient sells its own tokens into a tight cap to about 0.72 to 0.78 of the price, buys most back on the thinned curve, then settles and pays itself in the same transaction: +2.1% of curve SOL per transaction at a 15% reward share and a 1% fee, +6.2% at 30%, positive at every allowed fee, with no decay credit needed.
The dip retires `1/r` tokens per unit of cap decay, so the daily harvest exceeded the reward share of the allowance.
CVSS 3.4, rated up to Medium because the role is one the creator usually holds and per transaction it took more than H002.

Fix: `POOL4-49`: a trim is reward-eligible only up to the cap's unmatched fall, so a dip from a tight cap with nothing unmatched burns whole.
Round 2's re-review found the unmatched fall had no ceiling (R2-01), so a backlog of days of others' buying could be harvested in one dip; it is now capped at one day's allowance.
Regression tests: `sos_h005_a_dip_trimmed_from_a_tight_cap_pays_no_reward_share` and `sos_r2_01_a_dip_trim_draws_on_at_most_one_days_unmatched_cap_fall` (`tests/reward_share.rs`).

### H020: The release gate blocked by a hooked, parked or never-seeded market

What: the gate refused a candidate if any step failed on any market, with no baseline (`gate/src/check.rs:56`, `:313-338`).
A market whose steps fail under every build, a byte-identical copy of the deployed build included, therefore vetoed every upgrade.

Why it matters: for about 0.02 SOL of rent, a Token-2022 mint whose hook points at a never-bound hook, with a buy wall market left CREATED, made every gate run refuse every candidate, permanently; a contained token's market waiting for its seed failed the same way with no malice.
That is the permanent loss of the project's only upgrade-safety control on devnet.
CVSS 4.7.

Fix: [`POOL4-46`](../../decisions.md#pool4-46-when-a-failed-step-counts-against-a-candidate): a failed step counts unless the deployed build failed the same step, matched by kind, on the same snapshot, starting in the same program; the layout checks always run and always count; both replays sign with keys derived from the market.
With `POOL4-47` (H013) and the deployed build's due jobs (H033).
Regression test: `sos_h020_a_step_that_fails_under_the_deployed_build_too_does_not_count_against_the_candidate` (`gate/tests/blocked_markets.rs`).

### H058: A recipient's token-account configuration blocks payouts and vetoes the gate

What: a legacy SPL Token ATA whose owner was reassigned, or a Token-2022 ATA with MemoTransfer required, makes every payout to that recipient fail, and only the recipient can undo it (`src/recipient.rs:55-58`).
On chain each refusal is clean and contained, but the gate ran each due keeper job with no baseline and the snapshot cloned the recipient's account, so one such market vetoed every upgrade (`gate/src/check.rs:330-338`).

Why it matters: the cheapest permanent gate veto: create a market naming yourself fee recipient, trade so slot 0 owes something, reassign your wrapped SOL ATA's owner.
CVSS 4.3; Medium for the gate veto, Low for the program's own payout refusal.

Fix: the relative rule of `POOL4-46`; no program change was needed.

### H061: A creator holding every role stages a rug

What: a creator who is seeder, fee recipient, rewards recipient and hook authority runs H002's wash to the cap floor (+9% to 16% of curve SOL and a free bag of 12% to 24% of supply), recycles the rewards (H056), collects fees, then flips the hook so only it can sell (H001) and dumps into the curve and the wall.

Why it matters: the flip is what takes holders' money (4.67 SOL, 52% of the pool, for a seed-sized bag in the model); the staging adds camouflage and a free bag, not a new capability.
Aviary's panel as specified listed neither the seeder, nor role overlap, nor the hook authority.
CVSS 6.5, composite.

Fix: `POOL4-48` removes the flip and `POOL4-49` the recycling; what is left of the chain is H002's signed-off residual, which takes no holder's exit.

## Low and Info findings

### Fixed

- **H004** (`src/guard.rs:104-110`, `src/wall.rs:263`): after a drop and a quiet day the first swap realized the whole crawl, so a buy to the crawled floor, `place_wall`, then a sell into the new wall returned more than it cost (about 0.006% to 0.018% of curve SOL at fees of 25 to 50 bps with a large wall), breaking the spec's round-trip invariant.
  Fixed by `POOL4-50`: the crawl happens at the slot's first update, capped at the price the slot opened at, and `place_wall` cannot follow the buy in its slot; `sos_h004_a_quiet_days_crawl_cannot_be_captured_by_a_buy_place_wall_and_sell`.
- **H007** (`src/wall.rs:252-256`, `src/payouts.rs:25-31`): the rewards recipient sold into a near-price wall, ran `place_wall`, `settle` and `pay_rewards`, bought back, and kept the reward share of what the wall bought from it, up to about 1.1% of the wall's SOL per occurrence.
  Fixed by `POOL4-49` (the tokens a closed wall bought burn whole) and `POOL4-50` (no `place_wall` in the sell's slot); `sos_h007_a_wall_closure_pays_no_reward_share`.
- **H013** (`gate/src/download.rs`, `gate/src/cli.rs:260-267`): a direct `pipeline_seed_liquidity` market with no router record aborted the whole gate run.
  Fixed by `POOL4-47`: the snapshot saves it as unregistered and the replay registers it; `sos_h013_a_market_the_router_never_recorded_is_registered_in_the_replay_and_checked_like_the_rest`.
- **H022** (`src/payouts.rs:172-185`, `src/instructions/set_recipient.rs:34-47`): a role holder could hand its role to the vault authority PDA, a vault, the market state or the program id, stranding the role's income while events looked normal.
  Fixed by `POOL4-52` (`NotAWallet`); `sos_h022_a_role_cannot_be_handed_to_one_of_the_markets_own_addresses`.
- **H031** (`src/token.rs`): a hooked buy ran the hook at stack height 4 (5 under an aggregator, where the hook can make no CPI), and a hook pointed at the router or Token-2022 was a kill switch.
  Closed by `POOL4-48`: no seeded market's token runs a hook; tests that a cleared-hook token seeds, trades and pays rewards with no hook invoked.
- **H033** (`gate/src/keeper.rs:8`): the gate's due rules came from the candidate's own tree, so a tree that narrowed a due rule dropped that job from the replay.
  Fixed: due jobs come from what the deployed build passed, and each replay asks the build it runs for a fee slot's wallet (R2G-03); the gate's own market still takes its due jobs from the candidate's tree, a narrow gap pending the owner; `sos_h033_a_keeper_job_the_deployed_build_ran_is_run_whatever_the_candidates_rules_say`.
- **H041** (`src/wall.rs:206-256`): closing the wall at a dip retired what it bought and gave the recipient the reward share of it.
  Motive removed by `POOL4-49`; the wall stays a buy-and-burn by design.
- **H048** (`src/instructions/pay_rewards.rs`): a refusing hook stranded the rewards recipient's ledger.
  Closed by `POOL4-48`.
- **H050** (`src/guard.rs:105-107`, `tests/fuzz.rs:538-563`): of the keeper jobs only `place_wall` changed a round trip's result, through H004, and the fuzzer's `RoundTrip` counted only the trader's SOL.
  Fixed by `POOL4-50` (with the 2026-11-19 amendment for the back-run class round 2 found); the fuzzer's round trips now count tips, swept fees and rewards; `sos_h050_keeper_jobs_between_a_round_trips_legs_change_nothing`.
- **H056** (`src/wall.rs:252-256`, `src/payouts.rs:25-31`): the recipient sold its reward tokens back into the wall or a binding cap and received the reward share of them again, 1.08 to 1.41 times a single sale.
  Fixed by `POOL4-49`.
- **H062** (`tests/fuzz.rs:706`, `:737`, `:772`): the fuzzer's `settle` arm accepted any error when the model refused, and `pay_rewards` and `sweep_fees` compared only success.
  Fixed: exact error codes against the model's refusal, in the program's order.
- **H063** (Info): a handover to the current recipient succeeded and emitted `RecipientChanged { old: X, new: X }`.
  Fixed by `POOL4-52` (`SameRecipient`); `sos_h063_a_role_cannot_be_handed_to_its_current_wallet`.
- **H065** (`src/payouts.rs:123-155`): two slot matches kept aligned by hand, one with an unreachable wildcard.
  Fixed: an exhaustive `FeeSlot` enum; `sos_h065_each_fee_slot_pays_its_own_ledger_to_its_own_wallet`.
- **H066** (`src/payouts.rs:200-222`): a 764 s harness in CI's default Kani tier stated a strict subset of what `proofs/payouts_z3.py` proves.
  Fixed: moved to the full tier, with an exhaustive remainder unit test in its place.
- **H098** (`src/lib.rs:52-60`, `scripts/deploy.sh:94-98`): the `test-designer-recipient` build declares another program id, so at the real address every instruction fails, and the gate caught it only when a market existed.
  Fixed by `POOL4-53`; `sos_h098_an_empty_cluster_refuses_a_build_declared_for_another_address`.

### Fixed in part, residual signed off

- **H008** (`src/wall.rs:186-189`, `:226`): the fee recipient recaptures `80% x (1 - wall_split)` of the fee it pays, so selling into the wall, `place_wall`, buying back and `sweep_fees(0)` netted up to about 0.0008 SOL at fees of about 1% or more and wall splits of about 20% or less, falsifying the spec's "faking work never pays".
  `POOL4-50` closed the same-transaction loop; a cross-slot loop that must win the next slot's first `place_wall` against our keeper is signed off.
- **H068** (`src/pricing.rs:343-442`, `proofs/pricing_z3.py:19-20`): the pricing step harnesses run only under `kani_full`, which CI never sets, while the Z3 docstring said Kani proves the steps.
  The docstring now states the assurance level; no full-tier Kani job in CI is signed off.
- **H097** (`gate/src/check.rs:56`, `scripts/deploy.sh:78-98`): with zero markets the gate never executed the candidate, so a wrong-id build passed; and a market created between `verify-record` and the deploy was unchecked.
  The vacuous pass is fixed by `POOL4-53`; the deploy window is signed off with R2G-06.

### Signed off

- **H021** (`src/config.rs:25-38`, `src/payouts.rs:159-170`): freezing the program while `DESIGNER_RECIPIENT` is the zero key locks the designer's 10% of every fee for good; the treasury key reassigning its own wrapped SOL ATA locks slot 2 until reversed.
- **H024** (deployment): the upgrade key can drain every vault, close the program or freeze too early; `POOL4-10`'s "nobody has power after the seed" holds only once the program is frozen.
- **H025** (`src/instructions/seed.rs:53-81`): `seed` takes only amounts, so a seeder who signs without reading the market can commit its capital to a decoy whose recipients are an attacker's.
- **H026** (`src/instructions/set_recipient.rs:25-48`): a recipient handed over between create and a separate seed transaction; a timing variant of H025.
- **H040** (`src/cap.rs:107-215`): anyone can spend a day's decay credit in one transaction with atomic round trips; at the extremes 99.9% of the curve goes for 1.2% to 13% of curve SOL; no profit for a third party.
- **H059** (`src/cap.rs:107-130`): a dust buy before a known large sell moves the trim one trade earlier; the targeted sell's fill is untouched.
- **H070** (`src/instructions/init_market.rs:172-182`): anyone can create unlimited CREATED markets naming any seeder; no funds at risk.
- **H096** (`src/instructions/swap.rs:57-67`): while the router's admin pause is on, no holder can sell; funds stay in the vaults.
- **H110** (`src/instructions/seed.rs:177-198`): the market opens in the seed, so the seeder can trade first at its own price.
- **H111** (keeper jobs): every job is permissionless, so a stalled runner causes delay, never loss.

### Awaiting sign-off

- **H034** (`gate/src/check.rs:221-366`, `gate/src/keeper.rs:80-107`): a candidate changing `SUITE_TREASURY`, the share constants or `KEEPER_TIP_CAP`, or adding a drain instruction, passes the gate; `sweep_fees` is reported "swept" without a balance check and handovers are never run.
  Round 1 recommended accepting it, since the gate guards stranding rather than intent (`POOL4-41`) and the upgrade key is trusted; round 2 confirmed it open.

### Not fixed, Info

- **H069**: subtractions provably unreachable under the coverage invariant report `Overflow` rather than a named error; diagnostics only, every path fails closed.

## Not vulnerable

The 74 hypotheses investigated and cleared, with what protects each.
Those marked with an asterisk were hardened in #55 anyway, as defence in depth; round 2 confirmed each ([round-2.md](round-2.md)).

| ID | Hypothesis | Why it holds |
| --- | --- | --- |
| H006 | A `None` after pricing on a reachable state blocks every sell | Every such `None` is excluded by the ledger-coverage invariant, which every path keeps |
| H009* | Clocks going backwards double count decay, crawl and reference time | Differences saturate at 0 and a backwards clock is unreachable; hardened by `POOL4-51` |
| H010 | A hook re-enters mid-swap and its ledger writes are clobbered | The runtime refuses the re-entry |
| H011 | The vault authority's or the seeder's signature leaks into a hook | Forwarded accounts are forced non-signer |
| H012 | `recorded()` omits or double counts a ledger | It lists exactly the eight ledgers, and every value lives in one |
| H014 | A coverage break leaves a market stuck with no recovery | The invariant holds by induction and in a 3.2 million operation exact model |
| H015 | Pricing rounding lets a trader receive more than owed | Every step and the wall's top round against the trader |
| H016 | A wall round trip buys back the wall's tokens cheaper | The wall is part of `L + W`, not a separate formula |
| H017 | Overlapping setters lose an update | Every setter order traced; none loses a write |
| H018 | The mint allowlist admits a balance-changing or freezing extension | A strict seven-type allowlist |
| H019 | The exit guarantee is broken by trims and a far wall | `POOL4-36`'s bound is `MIN_SQRT_PRICE`; sells always complete |
| H023* | `open()` accepts `cap_floor_bps` above 10,000 | Only creation writes it, always after `validate()`; hardened with a guard in `open` |
| H027 | A hostile router replays credit or lies in `amount_sent` | Credit is `min(balance - recorded, amount_sent)` |
| H028 | The strategy ignores `min_amount_out` | The router enforces it on the trader's measured output |
| H029 | Aliased accounts in a swap or keeper job | Index pairs and vault keys are checked |
| H030 | A hook inflates the measured seed | The hook cannot re-enter or credit the vault mid-transfer; deltas are measured around each leg |
| H032 | The mint changes between create and seed | No refused extension can be added after `InitializeMint`; authorities are re-checked at the seed (the hook was H001) |
| H035 | 256-bit shift and multiply guards | Correct; no Cetus-class guard error |
| H036 | The sell step's `need` equivalence (`POOL4-26`) | The two decision rules are equivalent |
| H037 | Pricing overflow at reachable extremes | Products stay far below 2^256 |
| H038 | Guard arithmetic returns `None` at extremes | Products are bounded |
| H039 | The cap ratchet or `after_swap` returns `None` on a reachable state | Only unreachable states do |
| H042 | A dumper inserts `place_wall` between its own sells | Each sell is priced before its trim; nothing extracted |
| H043 | A `place_wall` sandwich | The outcomes are harmless and available without the keeper |
| H044* | `sweep_fees` and `pay_rewards` check their recipients differently | Neither position reads stale data; both now share one payout helper |
| H045 | Opening maths at extreme amounts | The double floor keeps the token side binding |
| H046 | Wall placement maths | The rounded-up holdings are kept; nothing is lost |
| H047 | Leftovers of the two-step walk refuse legitimate sells | The second step runs to the bound |
| H049 | Validator timestamp drift stretches elapsed time | Elapsed time is capped and drift is bounded |
| H051 | Remaining-account injection on payouts and swaps | Signer flags are not forwarded and Token-2022 validates |
| H052 | Layout gate and rollback stranding | Owner, size, discriminator and deployed versions are checked |
| H053 | Account initialisation races and pre-funding | Pre-funding cannot block creation |
| H054 | Mid-swap state visible to hooks | A hook cannot write the program-owned state or re-enter |
| H055 | Slot 0 dust stranded when the fee recipient is unset | At a 10,000 bps wall split the recipient's share is exactly 0, and an unset recipient is refused at any other split |
| H057 | A third party runs `register_existing_market` | The record derives from the market's own bytes; the first registrant gains only `created_by` |
| H060 | An MEV sandwich spends the decay credit | Bounded by the router's `min_amount_out`; a budgeted externality |
| H064* | A hand-derived ATA | Canonical seed order; hardened to the pinned associated token program |
| H067* | A magic `side: u8` in `check_vault_accounts` | Three callers, each correct; hardened to a `VaultSide` enum |
| H071 | `open_market` does not re-check the status | Both callers guarantee CREATED |
| H072 | Status and reserve bytes are not validated on read | Only two statuses are ever written, and the layout version gate refuses other layouts |
| H073 | SOL vault pre-funding mints a wrapped SOL surplus | The surplus is a donation, never credited |
| H074 | `check_existing` accepts a vault with a balance | The same: a donation |
| H075 | Vault sizing for Token-2022 extensions | Uses the required-extension calculation |
| H076* | Raw balance and decimals reads | Offsets correct; hardened to refuse accounts that are not token accounts or mints |
| H077 | PDA seed collisions | Distinct prefix lengths |
| H078 | Vault authority bump canonicalization | Anchor's canonical bump |
| H079 | The wrong token program for a vault | Bound to the mint |
| H080 | Cross-market account substitution | Every key is compared with the market state |
| H081 | A trim with zero movement lowers `L` | A trim runs only when the curve holds more than the cap |
| H082 | Floor crawl truncation stalls recovery | The crawl is non-zero at every reachable floor |
| H083 | Decay rounding at tiny supplies | A `max(1, ...)` floor |
| H084 | Fee split dust | The parts add up to the fee |
| H085 | `settle` reward rounding grief | Under one token unit per call |
| H086 | Tip rounding and cap | Bounded |
| H087 | `converted()` above the old top | Only `place` writes the wall |
| H088 | Donations locked forever | Specified behaviour |
| H089 | A wall closure realizes losses at dips | Specified behaviour (see H041) |
| H090 | The reference dragged by slot-end closes | Each step is bounded and elapsed time capped |
| H091 | `floor <= min(reference, last_close)` | Holds by induction |
| H092 | A stored, uncrawled floor used by `place_wall` | Its real effect is H004 |
| H093 | External consumers use the price as an oracle | No price is returned; documented as not an oracle |
| H094 | Event and return-data spoofing | Nothing reads events back; an indexer requirement noted |
| H095 | Handover against payout ordering | An inherent ordering; the self-harm is H022 |
| H099* | Toolchain and dependency drift | Hygiene only; the unused `init-if-needed` feature and the stale Anchor version pin removed |
| H100 | Compute ceilings for hooked buys and payouts | Within budget |
| H101 | Callers trusting `taken` | Measured from escrow balances |
| H102 | A seed with donated vault balances | Delta measuring |
| H103 | Quote check ordering | Only the error name changes; quote and swap agree on refusal |
| H104 | Swap counters overflow | Checked additions, unreachable in practice |
| H105 | Pipeline's fee and the credited input | Pipeline's fee is charged on top and never enters the vault |
| H106 | One seeded market per seeder per pair | By design |
| H107 | Hook accounts on sells; the market state as a writable extra | Hook accounts are forwarded on buys only |
| H108 | Parameter errors before `NotPipeline` | `market_signer` is a `Signer`, and nothing is created before both checks pass |
| H109 | Cross-venue arbitrage to spend the credit | The same bound as any spend |

## Combination analysis

Each chain names the critical node whose fix breaks it.

1. **Role-holder extraction from holders' exit liquidity** (Medium): H002's wash, H005's dip harvest, H003's dip that re-places the trimmed SOL low, H007's wall-wash, H056's recycling, H008's fee recapture and H059's dust trigger, all inside one creator-chosen role; together 9% to 28% of curve SOL over days and a free bag (H061 measured it).
   Critical node: the reward basis (`POOL4-49`), with the slot rule (`POOL4-50`) for the same-transaction forms; what survives is H002's bounded residual.
2. **Honeypot behind a trimming, burning market** (Medium): stage the market as in chain 1, flip the hook so only the creator can sell, dump into curve and wall (H001, H061, H002, H056, H031, H048).
   Critical node: H001, closed by `POOL4-48`.
3. **Permanent veto of the release gate** (Medium): an orphan market (H013) that also carries a refusing hook or a reassigned ATA (H020, H058, H021, H001, H048, H096) cannot be cleared by registration.
   Critical node: the relative rule (`POOL4-46`), with orphan registration (`POOL4-47`).
4. **The gate passes a build it should refuse** (Low): on an empty cluster a wrong-id or payout-changing build passed (H097, H098, H033, H034, H024).
   Critical node: a market of the gate's own in every run (`POOL4-53`), the deployed build's due jobs, and the freeze before mainnet.
5. **Diverted market income at creation and seed** (Low): a decoy market seeded blind, a handover before the seed or to a dead address (H025, H026, H022, H070, H063).
   Critical nodes: the handover refusals (`POOL4-52`); a seed bound to expected parameters if the owner ever takes H025's fix.

No chain reached High: every chain that moves holders' funds needs either a role the creator chose and published or a hook flagged before purchase.

Findings that enable others: H001 enables H061, H048 and H020; H003 enables H005 and H007; H004 enables H007; H013, H021, H048, H070 and H096 each feed H020's veto; H097 enables H098; H002, H007, H008 and H056 are the pre-flip stages of H061.

## Attack trees

- **Goal A: move holders' protocol-owned SOL to a role holder.**
  Paths: the credit wash (H002), the deep-dip harvest (H003 then H005), the wall-wash (H007, optionally after H004), reward recycling (H056), tip farming by the fee recipient (H008).
  All five fitted in one transaction.
  The reward basis breaks the dip, wall-wash and recycling paths; the slot rule breaks the same-transaction forms of the dip, wall-wash and tip paths; the wash survives in its bounded form.
- **Goal B: trap holders so only the controller can sell.**
  Paths: the hook flip (H001), the staged rug (H061), a kill switch with no deployed hook program (H031), a router pause (H096, the trusted router's own power, delay not loss).
  H001 is the critical node for the first three.
- **Goal C: neutralize the buy wall as holder protection.**
  Paths: a synthetic dip relocating the wall (H003), eager closure at dips (H041), the curve thinned to the cap floor (H040), a trim moved before a large sell (H059), the wall lifted above the pre-buy price (H004, H050).
  The slot-boundary floor and the `place_wall` slot rule break H003 and H004; H041 loses its motive; H040 and H059 stay, bounded by the creator's parameters, and are signed off.
- **Goal D: defeat the release gate.**
  False refusal: an orphan market (H013), a market failing under every build (H020: a refusing hook, a reassigned or memo-required recipient account, the treasury's ATA, a router pause), or both together for a permanent veto.
  False pass: an empty cluster with a wrong-id build (H097, H098), a candidate narrowing its own due rules (H033), a payout or constant change (H034, H024).
  The relative rule breaks every false refusal; the gate's own market breaks the empty-cluster pass.
- **Goal E: divert a market's income.**
  Paths: a decoy market seeded blind (H025, H070), a handover between create and seed (H026), a handover to a dead address (H022), a freeze while `DESIGNER_RECIPIENT` is zero (H021, H024).
  The handover refusals break the dead-address path; the rest are signed off, the freeze being a mainnet launch precondition.

## Severity calibration

Within a family, severity follows the measured magnitude and the actor; where CVSS and the calibrated rating differ, the knowledge base's impact-times-likelihood matrix decides.

- H001: CVSS 7.3, calibrated Medium: the lever is the creator's own, visible and flagged before anyone buys.
- H005: CVSS 3.4, calibrated up to Medium: per transaction it took more than H002 and needed no credit.
- H040: CVSS 6.4, calibrated Low: no third-party profit, bounded by the creator's parameters; its profitable form is H002.
- H058: Medium for the gate veto, Low for the program side.
- H013: Low alone; its permanent form is H020's.
- H024: Low on devnet; it would be Critical on mainnet with a live key, which is recorded as a launch precondition rather than a current finding.
- H063 and H069: Info; hygiene and diagnostics only.

## Coverage

| Area | Hypotheses | Confirmed or potential |
| --- | --- | --- |
| Access control | 10 | 6 (H001, H022, H025, H026, H063, H096) |
| Arithmetic | 22 | 2 (H066, H068) |
| State machine | 9 | 2 (H050, H070) |
| CPI and external calls | 12 | 3 (H031, H048, H058) |
| Token and economic | 20 | 11 (H002, H005, H007, H008, H021, H040, H041, H056, H061, H110, H111) |
| Account validation | 10 | 0 |
| Oracle and data | 7 | 2 (H003, H004) |
| Upgrade and admin | 9 | 7 (H013, H020, H024, H033, H034, H097, H098) |
| Error handling | 5 | 3 (H062, H065, H069) |
| Timing and ordering | 7 | 1 (H059) |

- Instructions: 13 of 13, each reached by at least four findings; the read-only `pipeline_resolve_accounts` and `pipeline_market_info` by five each.
- Exploit patterns: 40 of 40 matched patterns addressed by at least one hypothesis.
- AMM playbook red flags: 19 of 19, 13 directly and 6 by analogy, since the program has no LP tokens, ticks, admin or oracle consumer.
- Observations, not gaps: no finding checked that `pipeline_resolve_accounts` returns exactly what `pipeline_swap` needs for hooked mints in both directions (a liveness question, moot once hooks are cleared at the seed); and quote-swap agreement rests on the fuzzer and proofs rather than a dedicated finding.

## Recommendations carried beyond #55

- Before any mainnet deployment: set `DESIGNER_RECIPIENT`, then freeze the program with a checked script (H021, H024); re-run this review; and keep an independent external security review on the launch checklist, which this internal review does not replace.
- Keeper runner: alert on parked jobs and on the age of retired tokens (H111, H058).
- Aviary: show who holds which role, the seeder included, and the risk lines the spec names (H061, H096, H110).
- Re-run Stronghold of Security whenever the spec's economics change.
