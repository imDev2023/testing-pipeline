# Lending AMM: maths properties

The properties the lending AMM's pricing, valuation, share and rebalancing maths always satisfies, and how each one is established.
Chosen by Book of Knowledge in [Lending AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/86) on 2026-11-17, at the bar's "Test layers" 2 ([`docs/spec/README.md`](../../spec/README.md#test-layers)), for the formulas of [`docs/spec/lending-pool.md`](../../spec/lending-pool.md).
This is an internal verification, part of the internal adversarial review, never presented as an audit.

**Result: no counterexample is open.**
Book of Knowledge proposed 30 properties; the feature tickets had already established 20, the hardening added the other 10, and one of those, SH-6, turned out to be a real transfer of value, found and fixed as finding H001 of the [internal adversarial review](adversarial-review.md).

## How the properties were chosen

Book of Knowledge (`.claude/skills/book-of-knowledge`) scanned `programs/lending-amm/src/`, found 41 regions of maths in 25 files and matched them against its patterns: constant-product pricing and fee rounding (VP-001, VP-003, VP-011 to VP-015), LP shares and first-deposit inflation (the `lp-share` patterns), interest and exchange-rate valuation (the `interest-yield` patterns) and rounding direction at every call site.
Its scan and analysis are in `programs/lending-amm/.bok/` while a session works; that folder is never committed.
It weighted value moving between parties through rounding or through the reserve's stored rate above all, which is how SH-6 surfaced.

## How the properties are checked

- **Proptest**, at least 10,000 cases a property, on the compiled Rust in each module's `#[cfg(test)]` block (`cargo test -p lending-amm --lib`).
- **Kani**: a default-tier harness for every property, which CI runs, bounded where it needs a quotient, and a full-domain harness behind `--cfg kani_full` (`cargo kani -p lending-amm -j --output-format=terse`).
  On 2026-11-17 all 48 default-tier harnesses verified in 4 minutes 37 seconds on the owner's Mac.
- **Z3**, for every input, where Kani cannot relate a quotient to its operands: 43 claims in six files under `programs/lending-amm/proofs/`, each shown able to fail by a deliberate mutation.
- **The stateful fuzzer** (`tests/common/fuzz.rs`) and **LiteSVM tests** on klend's deployed bytes for the properties that span accounts or Kamino.

## The properties

| ID | Property | Established by |
| --- | --- | --- |
| PR-1 | The LP fee never rounds in the trader's favour | Kani `the_fee_never_rounds_in_the_traders_favour_bounded`, Proptest, Z3 `lending_amm_z3.py` claim 1 |
| PR-2 | A swap never lowers the product of the effective reserves and never empties a side | Kani `a_swap_never_lowers_the_product_of_the_reserves_bounded`, Proptest, Z3 `lending_amm_z3.py` claim 2 |
| PR-3 | A round trip at fixed reserves returns no more than went in | Kani `a_round_trip_never_returns_more_than_went_in_bounded` (new), Proptest, Z3 `lending_amm_z3.py` (new claim, every fee to 10,000) |
| PR-4 | Each quote equals its swap; the shortfall is `out - B`, at most what Kamino can pay | Kani `the_shortfall_is_...`, the fuzzer's quote and swap invariants |
| PR-5 | The lent side's total is the recorded buffer plus the recorded cTokens' value, or refused | Kani `the_lent_total_is_...` |
| KA-1 | `V` is the exact floor and equals klend's payout at the same rate | Z3 `kamino_z3.py` claims 1 and 3 to 5, Kani, Proptest |
| KA-2 | A higher rate never values the same cTokens lower | Z3 `kamino_z3.py` claim 2, Kani |
| KA-3 | Valuation is additive to within one unit: `V(a) + V(b) <= V(a + b) <= V(a) + V(b) + 1` | Kani `the_valuation_is_additive_within_one_unit_bounded` (new), Proptest, Z3 `kamino_z3.py` claim 6 (new) |
| KA-4 | A swap's burn is the fewest cTokens worth at least the shortfall | Z3 covering claim, Kani `the_ctokens_covering_..._bounded`, the fuzzer |
| KA-5 | A shortfall within the cTokens' value can always be burned | Kani `a_shortfall_within_the_ctokens_value_is_always_burned_bounded` (new), Proptest, Z3 `kamino_z3.py` claim 7 (new) |
| KA-6 | `rebalance`'s redeem burns at most what the market holds and never passes the target | Kani `a_redeem_burns_at_most_..._bounded`, Z3 |
| KA-7 | What Kamino can pay is at most every term, nothing while stopped, with the headroom rounded up | Kani `kamino_never_pays_more_than_any_term`, `a_planned_redeem_..._bounded`, Z3 headroom claim |
| KA-8 | The total supply and the withdrawal cap are klend's own counts | Kani `the_total_supply_is_klends`, `the_withdrawal_cap_remaining_is_klends_count` |
| SH-1 | The first deposit's shares plus the locked minimum never exceed what its amounts back | Kani, Proptest, Z3 `lending_amm_z3.py` claim 3 |
| SH-2 | A later deposit never mints more than its share of either side, nor takes more than offered | Kani, Proptest, Z3 `lending_amm_z3.py` claim 4 |
| SH-3 | A later depositor overpays by less than one unit of each side | Kani `a_later_deposit_overpays_by_less_than_one_unit_of_each_side_bounded` (new), Proptest, Z3 `lending_amm_z3.py` (new claim) |
| SH-4 | A removal pays each part rounded down and leaves the locked minimum's part | Kani, Proptest, Z3 `removal_z3.py` claim 1 |
| SH-5 | Adding then removing at once, at one rate, never returns more than went in | Kani, Proptest, Z3 `removal_z3.py` claims 2 and 3 |
| SH-6 | Adding at the stored rate, then removing after a refresh, takes no interest from the LPs already in | Was false (finding H001); now adding needs a reserve refreshed in the same slot, LiteSVM `sos_h001_...` on klend's bytes, and the fuzzer requires `ReserveStale` on a stale reserve |
| SH-7 | cTokens paid in kind take their part of the net amount lent, towards zero, keeping its sign | Kani, Z3 `shares_z3.py` claim 2 |
| SH-8 | An in-kind removal never fails on arithmetic | Was false for totals beyond 2^128 (finding H005); now computed without the product, unit test `sos_h005_in_kind_totals_never_overflow`, Z3 `shares_z3.py` (new claim, shown able to fail by two mutations) |
| SH-9 | The share count always fits a u64 after a later deposit | Kani `the_share_count_fits_a_u64_after_a_later_deposit` (new, every input), Proptest, Z3 `shares_z3.py` claim 4 (new) |
| SH-10 | Once open, a market never returns to the first-deposit path | The fuzzer, after every step (new): the other side's reserve never falls to 0 |
| BU-1 | A rebalance lands the buffer on its target and never passes it | Z3 `buffer_z3.py` claims 1 to 6, Kani, the fuzzer |
| BU-2 | A rebalance lowers `L` by at most one unit | The fuzzer, on klend's deposit and redeem |
| WM-1 | Withdraw mode's thresholds never overlap; it enters below the entry threshold and holds between | Kani, Z3 `withdraw_mode_z3.py` claims 1 to 5, the fuzzer |
| WM-2 | In withdraw mode `rebalance` only redeems, at most `min(V, can_pay)` | Z3 `withdraw_mode_z3.py` claim 6, Kani |
| WM-3 | A market leaves withdraw mode only after the exit wait, and never deposits while waiting | Kani `a_market_leaves_withdraw_mode_only_after_the_exit_delay_bounded` (new), Proptest, the fuzzer, LiteSVM `sos_h004_...` |
| XV-1 | What the market records never exceeds what it holds | The fuzzer's recorded and conserved invariants |
| XV-2 | A swap round trip across a refresh does not pay beyond the fees | LiteSVM `sos_h002_...`: quotes and swaps refuse a reserve more than an hour stale, and from the bound's edge a round trip at an LP fee of 0 lost |
| XV-4 | A cash removal pays exactly klend's payout for the LP's part | The fuzzer's value and conserved invariants |

## Counterexamples found

- **SH-6** (finding H001): the existing round-trip proofs used one rate for both legs, so none could see a deposit priced at the stored rate and a removal at the refreshed one.
  On our devnet WSOL reserve left 800,000 slots without a refresh, ten times a 50 SOL market added and removed at once took 2,844,438,901 lamports of the LPs' interest.
- **SH-8** (finding H005): `totals_after_in_kind` refused with `Overflow` when the net amount lent times the cTokens paid passed 2^128, which would have blocked an LP's last-resort exit over a figure that only tracks yield.
- **WM-3**: Kani's first run of the exit wait's harness found that a first sighting at slot 0 would have been recorded as none; a sighting is now recorded as slot 1 at the earliest.
