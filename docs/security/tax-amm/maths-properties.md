# Tax AMM: maths properties

The properties the tax AMM's pricing, tax and split arithmetic always satisfies, and how each one is established, as Pipeline's `docs/VERIFICATION.md` records them for the router.
Built in [Tax AMM: proofs of the pricing, tax and split maths](https://github.com/imDev2023/testing-pipeline/issues/64) on 2026-11-12, at the bar's "Test layers" 2 ([`docs/spec/README.md`](../../spec/README.md#test-layers)), for the formulas of [`docs/spec/tax-amm.md`](../../spec/tax-amm.md) "Pricing and the tax" and "Where the tax goes".
Re-checked against the final code, and extended, in [the tax AMM's hardening](https://github.com/imDev2023/testing-pipeline/issues/67) on 2026-11-20: see [Re-checked in #67](#re-checked-in-67).
This is an internal verification, never presented as an audit.

**Result: no counterexample is open.**
Every property of the arithmetic is proven for every input, by Kani or by Z3, and every property of the tax, a swap, the split and the curve is also checked on the compiled code by Proptest, on at least 10,000 cases that exercise it.
The claims about `mul_div`'s internals (M1 to M4) and the lemmas (L1 to L6) are proven by Z3 only; the curve's exact-floor Proptest checks their result on the compiled code.
Two properties are of rules rather than arithmetic, and are checked by Proptest only, against an independent statement of the rule: the split's creation rule (P3, with LiteSVM examples through the router) and the mint walk, against Token-2022's own state code (W1, W2).
Two counterexamples were found and fixed, both in maths no instruction could reach with a bad value: see [Counterexamples found](#counterexamples-found).

## How the properties were chosen

Book of Knowledge (`.claude/skills/book-of-knowledge`, installed by [ticket #58](https://github.com/imDev2023/testing-pipeline/issues/58)) chose them, from its patterns for the three kinds of maths the tax AMM has:

| Book of Knowledge pattern | What the tax AMM has | Properties |
| --- | --- | --- |
| VP-001, VP-003: conservation, the product never falls | a constant-product curve on effective reserves | S1 |
| VP-005, VP-012: the fee never exceeds the principal | the tax on the input or on the curve's output | T1 |
| VP-007: virtual reserves | a virtual reserve that prices but is never paid out | S2 |
| VP-011, VP-014: rounding direction, no zero fee on a positive amount | the tax rounds up | T1 |
| VP-013: zero fee at zero input | the tax at a zero amount or rate | T1 |
| VP-015: basis point overflow | `ceil_bps` on u64 amounts | T1, N1 |
| VP-016: fees monotone | the tax against the amount and the rate | T3, S3 |
| VP-009: route splitting | two trades against one | S4 |
| VP-078, VP-079: shares sum to the whole, dust under one unit a part | the suite share, the recipients and the burn | P1 |
| VP-079, VP-080: dust goes to a payable recipient (#67) | the remainder to slot 0, nothing to an unshared slot | P2 |
| VP-078: distribution sums to 100%, at the rules (#67) | `params::check_split` at creation and in `set_recipients` | P3 |
| VP-007, VP-036: virtual reserves, the first depositor (#67) | a side without a virtual reserve | S6 |
| VP-076: accumulation overflow (#67) | the u128 counters the containment hook reads | V1, V2 |
| VP-099, VP-101: pack and unpack consistency (#67) | the mint extension walk in `mint-rules` | W1, W2 |

The ticket's own list (the tax's formula, the cap, the swap's three properties, splitting, the round trip, the split and no panic) is covered whole; Book of Knowledge added the tax's monotonicity (T3), the virtual reserve (S2) and the remainder bound (P1), and in #67 P2, P3, S6, V1, V2, W1 and W2.

Out of scope here, because the router or another layer owns them:

- The trader's minimum output and Pipeline's fee are the router's (its own `settle`, not the tax AMM's `pricing::settle`, on which S2 is proven), proven in Pipeline's own `docs/VERIFICATION.md`, and so is the router's `credited_input`.
  What the tax AMM passes `credited_input` as recorded (its real reserve plus every amount owed on the tax-side vault, `instructions/swap.rs`) is its own arithmetic; no property here covers it, and the stateful fuzzer checks it after every step (`vaults_cover_the_market`).
- That a quote equals its swap holds because both call `pricing::fill`; `pipeline-check`'s `quote_matches_swap` verifies it on every test market (`tests/conformance.rs`).
- The invariants over a market's whole life (vault balances, `tax_collected`, the counters, ranges that never move) are the stateful fuzzing layer's, [`tax-amm.md`, Invariants](../../spec/tax-amm.md#invariants).

## How the properties are checked

| Tool | What it gives | Where |
| --- | --- | --- |
| **Kani** 0.67.0 | A proof, for every input, of the Rust itself; quotient properties for small inputs only (the bounded tier), with the full-domain versions behind `--cfg kani_full` | `programs/tax-amm/src/pricing.rs`, `split.rs`, `params.rs` (their `proofs` modules) |
| **Z3** 5.4.1 | A proof for every input of the arithmetic, modelled step by step from the Rust: Pipeline's `ceil_bps`, `mul_div`'s 256-bit product and long division, the curve, whole trades and the split | `programs/tax-amm/proofs/pricing_z3.py` |
| **Proptest** | At least 10,000 random cases a property against the real functions; 40,000 for properties of trades that must succeed to say anything, and those tests fail unless at least 10,000 cases did; the rules' properties fail unless every outcome came up | `programs/tax-amm/tests/maths.rs`, and `tests/mint_rules.rs` for the mint walk |

Kani's SAT back end turns a division into a fresh quotient tied to its operands by a multiplier, and cannot relate that quotient to its inputs over the full 64- and 128-bit range, so every claim about a quotient is proven for every input by Z3.
Z3 does not settle the composed claims about a whole trade (a ceiling inside a floor inside a product) in reasonable time either, so `pricing_z3.py` proves small lemmas for every non-negative input (L1 to L6, C1, S3), and each whole-trade claim adds the lemma instances it needs as assumptions, each guarded by that lemma's preconditions, and Z3 checks that the claim follows.
Kani's bounded tier and Proptest tie the Z3 model to the compiled Rust: they check the same statements on the code itself.
The constants the model needs (`MAX_TAX_BPS`, `SUITE_SHARE_BPS`) are read from `src/config.rs`, their one place.

Run them (`docs/toolchain.md` has the setup):

```sh
source scripts/toolchain-env.sh && cd programs
cargo kani -p tax-amm -j --output-format=terse                     # the default tiers
RUSTFLAGS="--cfg kani_full" cargo kani -p tax-amm --harness <name>  # a full-domain harness
cd .. && python programs/tax-amm/proofs/pricing_z3.py              # with z3-solver 5.4.1.0
cd programs && cargo test -p tax-amm --test maths --test mint_rules # Proptest
```

CI runs the Kani default tiers and the Z3 proofs on every pull request that changes on-chain code (the `kani` job), and Proptest in the `rust` job.

## The properties

IDs are stable; the Kani harnesses, the Z3 claims and the Proptest names carry them.

**The tax (`pricing::tax_of`, every amount and rate)**

| ID | Property | How |
| --- | --- | --- |
| T1 | The tax is exactly `ceil(amount × rate / 10,000)`, never more than the amount, and 0 exactly when the amount or the rate is 0 | Z3 (every u64 amount, every rate up to the cap); Kani (the zero case and the amount bound for every input, the formula for amounts below 2^8); Proptest |
| T2 | No rate above `MAX_TAX_BPS` can be applied: the tax and the pricing refuse it (`TaxAboveCap`) for every amount and market before anything else, and the rules creation and `set_taxes` apply (`params::check_rates`) accept only ranges inside `[0, MAX_TAX_BPS]` with each rate inside its range | Kani (every input: `tax_of`, the pricing and the rules); Proptest (the pricing's refusal, through `exact_in`) |
| T3 | The tax never falls as the amount or the rate rises, and what a buy tax leaves for the curve never falls as the amount rises | Z3; Proptest |
| T4 | Two taxes are never less than one on the sum | Z3; Proptest |

**A swap (`pricing::exact_in`, either direction, every reserve, virtual reserve, rate and amount)**

| ID | Property | How |
| --- | --- | --- |
| S1 | A swap never lowers the product of the effective reserves | Z3 (every input, both taxes: the curve prices `a − tax` or `a` and the reserves move by what it priced and paid); Kani (reserves and amounts below 8); Proptest (exact 256-bit products) |
| S2 | A swap never pays out more than the output side's real reserve, whatever the virtual reserves: what leaves the real reserve is what the trader gets plus a sell tax, the input reserve grows by the input less a buy tax, and the trader always gets at least 1 unit | Kani (every input and every curve output, on `settle`, the step `exact_in` ends with, so the curve's division stays out of the proof); Proptest |
| S3 | The output never rises when the tax rises or the input falls, for a buy tax and a sell tax | Z3 (from L1 to L3 and the curve's monotonicity); Kani (below 8); Proptest |
| S4 | Splitting a trade in two never returns more than the single trade; where the single trade is refused, it is only because its curve output passes the real reserve or its input reserve passes a u64 | Z3 (both taxes, from L3, L4, L6 and S3); Kani (below 8); Proptest. The refusal clause follows from the Z3 claim too: both legs give at least 1, so the single trade's output is at least 2 and never `ZeroOutput`, and its rate is theirs, so never `TaxAboveCap`; Kani and Proptest check it on the code |
| S5 | Buying and selling straight back never returns more than was put in, at any rates, 0 included, whichever side carries the tax and wherever the virtual reserve is | Z3 (both tax sides, from C1, L3, L5 and S3); Kani (below 8) and Proptest, both pricing each leg through `MarketView::terms`, the mapping `fill` uses |
| S6 | On a side without a virtual reserve, a swap never takes the real reserve to 0: traded into, the curve rounds down below its whole output side while the input side holds at least 1 unit, real or virtual, and `settle` caps it at the real reserve; traded from, the reserve only grows. The input side holding a unit is the seed rule's, kept by this property, and the stateful fuzzer checks it | Z3 (`exact_in` and `settle` as written, both taxes, every u64 reserve, virtual reserve and amount, 0.1 s); Proptest (`a_side_without_a_virtual_reserve_never_empties`, 40,000 cases, at least 10,000 fills) |

**Where the tax goes (`split::split_tax`)**

| ID | Property | How |
| --- | --- | --- |
| P1 | The suite share, the recipients' parts and the burn always add up to the tax and no part exceeds it; with whole shares each part is its share rounded down, the suite share first, and the remainder, under one unit a part, goes to the first recipient; shares that are not the whole are refused for every tax (`SharesNotWhole`), and the rules creation and `set_recipients` apply (`params::check_split`) accept only whole shares | Kani (shares that are not the whole refused before any arithmetic, for every tax; adds up for every tax behind `kani_full`); LiteSVM (`check_split`'s refusal at creation and in `set_recipients`, `tests/create_market.rs`, `tests/tax_authority.rs` and `tests/seed_liquidity.rs`, since a Kani harness of `check_split` did not finish in 30 minutes) and Proptest (`check_split` against the spec's rule, P3); Z3 (whole shares never refused, the parts' values, every tax); Proptest (the parts' exact values, and adds up for any shares); the parts' arithmetic has no default Kani harness, because its six 128-bit divisions by symbolic shares did not finish in 30 minutes even for taxes below 2^8 |
| P2 | With whole shares, a recipient slot after the first whose share is 0 is booked nothing, and the burn is booked nothing when its share is 0; only slot 0 takes the remainder, and `check_split` keeps slot 0 used and every unused slot's share 0, so tax is only ever owed to a slot with a wallet, the burn or the suite | Kani (`an_unshared_slot_is_booked_nothing`, every tax and every whole set of shares, default tier, 10 s: the parts it asserts are divisions of 0); Z3 (beside P1, every tax); Proptest (whole shares with their zeros in any slot) |
| P3 | `params::check_split`, the rule creation and `set_recipients` apply, accepts exactly the spec's splits ("Creation parameters": at least one recipient, used slots first, each used share above 0, each unused slot's share 0 and key the default, the shares and the burn share summing to 10,000, no burn share on a native SOL tax mint) and refuses every other one with the error of the first rule it breaks, in that order. Wallets named only after an empty slot 0 break the first two rules at once and are refused as `NoRecipient` | Proptest (`check_split_accepts_exactly_the_specs_splits`: 10,000 submitted splits against an independent statement of the rule, the native SOL mints written out apart from the program's list, failing unless acceptance and each of the six refusals came up at least 200 times; one run gave 2,509 accepted, 2,016 `NoRecipient`, 701 `RecipientsOutOfOrder`, 1,663 `ZeroShare`, 899 `ShareWithoutRecipient`, 901 `SharesNotWhole` and 1,311 `BurnOnNativeSol`); LiteSVM examples through the router (see P1) |

**No overflow and no panic**

| ID | Property | How |
| --- | --- | --- |
| N1 | No input makes the pricing, the tax or the split overflow or panic: every case that would returns an error (`Overflow`, `TaxAboveCap`, `SharesNotWhole`, `ZeroOutput` or `InsufficientLiquidity`, and `Underflow` on subtractions the proofs show never fail) | Kani (the pricing and the tax for every input, rates above the cap included; the split's refusal of shares that are not whole); Z3 (with whole shares every slot is between 0 and the tax and the booked parts never exceed the creator's part, so none of the split's subtractions fails and none of its narrowing casts truncates, every tax); Proptest (any input to both). N1 covers these three functions only: the swap handler's own checked additions are outside it, the counters' are V1, and the rest are the stateful fuzzer's |

**The counters (`instructions/swap.rs`, read by the containment hook)**

| ID | Property | How |
| --- | --- | --- |
| V1 | `tax_collected` and each `volume[i]` (u128) stay at most `swap_count × (2^64 - 1)`, since each swap adds at most a u64 to each and 1 to `swap_count` (u64); so their checked additions never fail, even at `swap_count == u64::MAX`, and only `swap_count` itself could ever overflow, after 2^64 - 1 swaps | Z3 (the bound as an induction step: it holds at 0 swaps and one more swap keeps it, every counter value, 0.0 s) |
| V2 | A swap's tax never exceeds what it adds to the tax side's volume: a buy tax is at most the input, which `volume[input]` counts, and a sell tax at most what the trader gets, which `volume[output]` counts, for every rate up to `MAX_TAX_BPS` (it rests on the cap: at 50%, a curve output of 3 gives a tax of 2 and the trader 1); so `tax_collected` never passes the tax side's volume | Z3 (Pipeline's `ceil_bps` as written, every u64 amount and every rate up to the cap read from `src/config.rs`, then the cumulative step, 0.0 s); Proptest on `exact_in` (`the_tax_never_exceeds_what_the_swap_adds_to_the_tax_sides_volume`, 40,000 cases, at least 10,000 fills); the stateful fuzzer checks the cumulative form after every step |

**The mint walk (`mint_rules::check_mint` and `find_extension`, shared by every product)**

| ID | Property | How |
| --- | --- | --- |
| W1 | `check_mint` and its extension walk never panic on any bytes under any owner, and agree with Token-2022's own reading (`StateWithExtensions::<Mint>::unpack` and `get_extension_types`, `spl-token-2022-interface` 3.1.2): a Token-2022 mint is accepted exactly when Token-2022 unpacks it and every type its walk finds is on the allowlist, and otherwise refused, with the first type off the list when there is one; an SPL Token mint exactly when it is the 82-byte base Token-2022 unpacks. A refused type after a type-0 entry is accepted by both, and Token-2022's lookup never finds it (hardening finding H012); the 166-byte and 167-byte mints are accepted by both and the 355-byte ones refused by both (H015). The one difference is pinned: `check_mint` does not read the base's two option tags, which Token-2022 refuses unless 0 or 1, and which only the token programs write, always 0 or 1 (H015, step 4) | Proptest (`sos_h012_sos_h015_the_mint_walk_reads_every_layout_as_token_2022_does`: 10,000 layouts of lengths 82, 165, 166, 167, 355 and any up to 400 bytes, with bad option tags, initialized bytes, padding and account types, 0 to 5 entries with type-0 gaps, refused and unknown types after them, overlong lengths and trailing bytes, failing unless each kind of reading came up at least 100 times; one run read 2,145 accepted bare, 362 accepted with extensions, 547 accepted with a refused type after a gap, 484 refused for an extension, 4,993 refused for the layout and 1,469 with option tags only the token programs write; and `sos_h015_the_mint_walk_never_panics_on_any_bytes`, 10,000 cases of any bytes); named examples (`sos_h015_a_166_byte_mint_is_read_alike`, `sos_h015_a_355_byte_mint_with_extensions_is_read_alike`, `sos_h012_a_refused_extension_after_a_type_0_entry_is_inert_for_token_2022_too`, `sos_h015_check_mint_does_not_read_the_option_tags_only_token_programs_write`); LiteSVM through the router (`sos_h015_a_166_byte_mint_creates_a_market`, `sos_h015_a_355_byte_mint_with_extensions_is_refused`) |
| W2 | On every mint `check_mint` accepts, `find_extension` returns the entry Token-2022's lookup (`get_extension_bytes`) does, for the transfer hook and the three pointers, and Token-2022's lookup finds neither a permanent delegate nor a transfer fee | Proptest (inside the differential above); named example (the hook after a type-0 entry) |

**The arithmetic underneath (`pricing::mul_div`, `pricing::curve_out`)**

| ID | Property | How |
| --- | --- | --- |
| M1 | `mul_div`'s 256-bit product is exact, and the checked additions into its high half never overflow | Z3 (every pair of u128s) |
| M2 | One step of its long division takes the divisor exactly when the doubled remainder plus the next bit reaches it, and keeps `floor(N / 2^k) = quotient × d + remainder` with the remainder below the divisor; with the base case (the high half, below the divisor) and the last step, the quotient is exactly `floor(a × b / d)` | Z3 (the step, every remainder, bit and divisor); Proptest (`curve_out` against an independent schoolbook product, with products past 2^128 so the long division runs); a Kani harness of `mul_div` did not finish in 7 minutes even for operands below 2^8 |
| M3 | The quotient fits in a u128 exactly when the high half is below the divisor | Z3 |
| M4 | `curve_out` never reaches `mul_div`'s saturating branch | Z3 |
| C1 | The curve pays out between nothing and its whole output side, never all of it while the input side holds anything, and nothing for no input | Z3 (every input); Kani (never panics for every input; the rest below 8); Proptest (the exact floor) |

**Lemmas** (Z3, every non-negative input; the whole-trade claims are built from them)

| ID | Lemma |
| --- | --- |
| L1 | What is left after the tax never falls as the amount rises |
| L2 | The tax never falls as the rate rises |
| L3 | The tax is between 0 and the amount |
| L4 | Two taxes are never less than one on the sum |
| L5 | Trading `c` and the curve's whole output straight back returns at most `c` |
| L6 | Two legs on the curve never pay out more than their sum at once |

## Counterexamples found

Both were in the maths layer only: no instruction could hand the maths a bad value, because the rules creation and the tax authority's changes apply refuse it first.
Each is fixed in the program with a regression test, and the spec says what the fix does.

1. **The pricing applied any rate up to 100%.**
   `exact_in` capped nothing itself, so a rate between `MAX_TAX_BPS` and 10,000 was priced; only the creation rules kept such a rate out of a market state.
   Fixed: `pricing::tax_of` and `exact_in` refuse a rate above the cap for every input (`TaxAboveCap`), before anything is priced.
   Regression: `no_rate_above_the_cap_is_ever_applied` (Proptest, and the Kani harness of the same name).
2. **The split booked shares that sum past the whole when the tax was small.**
   `split_tax` was documented to refuse shares summing to more than 10,000, but it refused them only when the rounded parts outgrew the creator's part: a tax of 9 with one share of 10,001 was booked.
   Fixed: `split_tax` refuses any shares that are not the whole, for every tax (`SharesNotWhole`).
   Regression: `shares_that_are_not_the_whole_are_refused_whatever_the_tax` (`src/split.rs`) and the Kani harness `the_split_adds_up_to_the_tax_or_is_refused`.

## Re-checked in #67

On 2026-11-20 Book of Knowledge re-checked every one of the 22 properties of #64 (T1 to T4, S1 to S5, P1, N1, M1 to M4, C1, L1 to L6) against the final code, in [the tax AMM's hardening](https://github.com/imDev2023/testing-pipeline/issues/67).
`src/pricing.rs`, `src/split.rs` and `src/params.rs` are unchanged since #64 merged (#149) except for one error name: a subtraction that cannot fail now refuses with `Underflow` rather than `Overflow` (hardening finding H049), which changes no statement, since no proof or test expects either error from those subtractions.
Every statement still says what the code does, and every Kani harness, Z3 claim and Proptest named here still exercises the function it names.
Four needed a wording fix, made above: T2 (which tool covers which part), S4 (why the single trade's refusal follows from the Z3 claim), P1 (`check_split`'s acceptance now rests on P3 as well as LiteSVM examples) and N1 (a narrowing cast truncates rather than fails, and N1 covers none of the swap handler's own additions); the "Out of scope" line now separates the router's `settle` from the program's `pricing::settle` and names what the tax AMM itself passes `credited_input`.

The re-check also chose seven properties, all now proven or checked and run in CI:

- P2, an unshared slot is booked nothing: Kani (default tier), Z3 and Proptest.
- P3, `check_split` is the spec's rule, error by error: Proptest.
- S6, a side without a virtual reserve never empties: Z3 and Proptest.
- V1, the u128 counters cannot overflow before `swap_count` does: Z3.
- V2, a swap's tax never exceeds what it adds to the tax side's volume: Z3 and Proptest.
- W1 and W2, the mint walk never panics and reads every layout as Token-2022 does (hardening findings H012 and H015): Proptest, differential against Token-2022's own state code, with named examples and two LiteSVM tests through the router.

The stateful forms of P2 (every owed slot names a wallet), V2 (cumulative) and S6 (after every step) are the invariant fuzzer's.

## Run times

Measured on the owner's Mac (Intel Xeon W-2150B, 10 cores) on 2026-11-12, and again on 2026-11-20 for #67.

- **Kani, default tier** (`cargo kani -p tax-amm -j --output-format=terse`): on 2026-11-20, 14 harnesses, all verified, 137 seconds wall with the harnesses in parallel, the build included; P2's `an_unshared_slot_is_booked_nothing` verifies in 10 s on its own.
  Verification times on 2026-11-12: the trade properties below 8, monotonicity 164 s, splitting 137 s, the round trip 60 s and the product 46 s; the pricing never panicking 55 s; the rate cap 27 s; the curve's no-panic and bounds 16 s and 18 s; the split's refusal 17 s; S2 on `settle` 12 s; the tax's formula below 2^8 7 s; the rules on rates 2 s; the zero tax 1 s.
- **Z3** (`proofs/pricing_z3.py`): on 2026-11-20, 37 of 37 claims proven in 6.6 seconds; no claim takes more than 5 seconds, and the seven #67 added (P2, V1, three V2, two S6) take 0.1 s or less each.
- **Proptest** (`cargo test -p tax-amm --test maths --test mint_rules`): on 2026-11-20, the 21 tests of `maths.rs` in 5.4 seconds and the 27 of `mint_rules.rs` (the walk's two properties, its four examples and the router tests) in 0.4 seconds, in a debug build whose dependencies are optimised.
- **Kani, full domain** (`RUSTFLAGS="--cfg kani_full" cargo kani -p tax-amm -j`), run once on 2026-11-12: none of the 8 harnesses finished in 60 minutes, all 8 in parallel on 10 cores: the tax's formula, the curve's bounds, the product, monotonicity, splitting and the round trip for every input, and the split adding up and its parts' values for every tax.
  None failed; each was stopped at 60 minutes. Every one of these statements is proven for every input by Z3 (T1, C1, S1, S3, S4, S5, P1), which is why they stay out of the default tier.
- **What did not finish**, and so was moved or bounded: a Kani harness of `mul_div`'s exactness (over 7 minutes for operands below 2^8); the split's parts with symbolic shares (over 30 minutes for taxes below 2^8, bounded or not); `check_split` with symbolic keys (over 30 minutes); the trade properties at a bound of 16 (up to 10 minutes each); the tax's formula for amounts below 2^16 (over 15 minutes) and 2^10 (135 s); and S2 through the whole of `exact_in` (454 s), before it was proven on `settle`.
- **Unsupported constructs**: Kani warns of `caller_location` and one foreign function, from the standard library's and Anchor's panic and runtime code; Kani turns any it reaches into a failed check, and every harness verifies, so no proven path reaches them.

Each harness was checked to fail when its property is broken: a cap check that lets one rate past `MAX_TAX_BPS` fails the pricing's and the rules' cap harnesses, and a split without its whole-shares check fails the split's refusal harness.
The Z3 claims were checked the same way: a curve that rounds up fails C1, S1, L5 and L6; a tax that rounds down fails T1, T4 and L4; shares allowed to sum to anything up to 20,000 fail both P1 claims.
The properties #67 added were checked the same way: a split that books the remainder to slot 1 fails P2's Kani harness and Proptest; P2's Z3 claim extended to slot 0 fails; the S6 claims fail without the input side's unit and with a curve that rounds up; V2's sell claim fails at a cap of 6,000; V1 fails without its bound; a `check_split` that lets a burn share of 1 through on native SOL fails P3; and a mint walk that skips the multisig length, or stops after the first entry, fails W1.
