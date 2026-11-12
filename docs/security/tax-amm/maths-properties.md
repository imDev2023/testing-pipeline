# Tax AMM: maths properties

The properties the tax AMM's pricing, tax and split arithmetic always satisfies, and how each one is established, as Pipeline's `docs/VERIFICATION.md` records them for the router.
Built in [Tax AMM: proofs of the pricing, tax and split maths](https://github.com/imDev2023/testing-pipeline/issues/64) on 2026-11-12, at the bar's "Test layers" 2 ([`docs/spec/README.md`](../../spec/README.md#test-layers)), for the formulas of [`docs/spec/tax-amm.md`](../../spec/tax-amm.md) "Pricing and the tax" and "Where the tax goes".
This is an internal verification, never presented as an audit.

**Result: no counterexample is open.**
Every property is proven for every input, by Kani or by Z3, and every one is also checked by Proptest on at least 10,000 cases.
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

The ticket's own list (the tax's formula, the cap, the swap's three properties, splitting, the round trip, the split and no panic) is covered whole; Book of Knowledge added the tax's monotonicity (T3), the virtual reserve (S2) and the remainder bound (P1).

Out of scope here, because the router or another layer owns them:

- The trader's minimum output, Pipeline's fee and the credited input are the router's (`settle` and `credited_input`), proven in Pipeline's own `docs/VERIFICATION.md`.
- That a quote equals its swap holds because both call `pricing::fill`; `pipeline-check`'s `quote_matches_swap` verifies it on every test market (`tests/conformance.rs`).
- The invariants over a market's whole life (vault balances, `tax_collected`, the counters, ranges that never move) are the stateful fuzzing layer's, [`tax-amm.md`, Invariants](../../spec/tax-amm.md#invariants).

## How the properties are checked

| Tool | What it gives | Where |
| --- | --- | --- |
| **Kani** 0.67.0 | A proof, for every input, of the Rust itself; quotient properties for small inputs only (the bounded tier), with the full-domain versions behind `--cfg kani_full` | `programs/tax-amm/src/pricing.rs`, `split.rs`, `params.rs` (their `proofs` modules) |
| **Z3** 5.4.1 | A proof for every input of the arithmetic, modelled step by step from the Rust: Pipeline's `ceil_bps`, `mul_div`'s 256-bit product and long division, the curve, whole trades and the split | `programs/tax-amm/proofs/pricing_z3.py` |
| **Proptest** | At least 10,000 random cases a property against the real functions; 40,000 for properties of two trades that must both succeed, so that at least 10,000 do | `programs/tax-amm/tests/maths.rs` |

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
cd programs && cargo test -p tax-amm --test maths                   # Proptest
```

CI runs the Kani default tiers and the Z3 proofs on every pull request that changes on-chain code (the `kani` job), and Proptest in the `rust` job.

## The properties

IDs are stable; the Kani harnesses, the Z3 claims and the Proptest names carry them.

**The tax (`pricing::tax_of`, every amount and rate)**

| ID | Property | How |
| --- | --- | --- |
| T1 | The tax is exactly `ceil(amount × rate / 10,000)`, never more than the amount, and 0 exactly when the amount or the rate is 0 | Z3 (every u64 amount, every rate up to the cap); Kani (the zero case and the amount bound for every input, the formula for amounts below 2^10); Proptest |
| T2 | No rate above `MAX_TAX_BPS` can be applied: the tax and the pricing refuse it (`TaxAboveCap`) for every amount and market before anything else, and the rules creation and `set_taxes` apply (`params::check_rates`) accept only ranges inside `[0, MAX_TAX_BPS]` with each rate inside its range | Kani (every input, the pricing and the rules); Proptest |
| T3 | The tax never falls as the amount or the rate rises, and what a buy tax leaves for the curve never falls as the amount rises | Z3; Proptest |
| T4 | Two taxes are never less than one on the sum | Z3 |

**A swap (`pricing::exact_in`, either direction, every reserve, virtual reserve, rate and amount)**

| ID | Property | How |
| --- | --- | --- |
| S1 | A swap never lowers the product of the effective reserves | Z3 (every input, both taxes: the curve prices `a − tax` or `a` and the reserves move by what it priced and paid); Kani (reserves and amounts below 16); Proptest (exact 256-bit products) |
| S2 | A swap never pays out more than the output side's real reserve, whatever the virtual reserves: what leaves the real reserve is what the trader gets plus a sell tax, the input reserve grows by the input less a buy tax, and the trader always gets at least 1 unit | Kani (every input); Proptest |
| S3 | The output never rises when the tax rises or the input falls, for a buy tax and a sell tax | Z3 (from L1 to L3 and the curve's monotonicity); Kani (below 16); Proptest |
| S4 | Splitting a trade in two never returns more than the single trade; where the single trade is refused, it is only because its curve output passes the real reserve or its input reserve passes a u64 | Z3 (both taxes, from L3, L4, L6 and S3); Kani (below 16); Proptest |
| S5 | Buying and selling straight back never returns more than was put in, at any rates, 0 included, whichever side carries the tax and wherever the virtual reserve is | Z3 (both tax sides, from C1, L3, L5 and S3); Kani (below 16); Proptest |

**Where the tax goes (`split::split_tax`)**

| ID | Property | How |
| --- | --- | --- |
| P1 | The suite share, the recipients' parts and the burn always add up to the tax and no part exceeds it; with whole shares each part is its share rounded down, the suite share first, and the remainder, under one unit a part, goes to the first recipient; shares that are not the whole are refused for every tax (`SharesNotWhole`), and the rules creation and `set_recipients` apply (`params::check_split`) accept only whole shares | Kani (adds up or refused, for every tax and any shares; the parts' values for taxes below 2^10; the rules for every input); Z3 (whole shares never refused and the parts' values, every tax); Proptest |

**No overflow and no panic**

| ID | Property | How |
| --- | --- | --- |
| N1 | No input makes the pricing, the tax or the split overflow or panic: every case that would returns an error (`Overflow`, `TaxAboveCap`, `SharesNotWhole`, `ZeroOutput` or `InsufficientLiquidity`) | Kani (every input, including rates above the cap and any shares); Proptest |

**The arithmetic underneath (`pricing::mul_div`, `pricing::curve_out`)**

| ID | Property | How |
| --- | --- | --- |
| M1 | `mul_div`'s 256-bit product is exact, and the checked additions into its high half never overflow | Z3 (every pair of u128s) |
| M2 | One step of its long division takes the divisor exactly when the doubled remainder plus the next bit reaches it, and keeps `floor(N / 2^k) = quotient × d + remainder` with the remainder below the divisor; with the base case (the high half, below the divisor) and the last step, the quotient is exactly `floor(a × b / d)` | Z3 (the step, every remainder, bit and divisor); Kani (exact for operands below 2^8); Proptest (through S1, against an independent schoolbook product) |
| M3 | The quotient fits in a u128 exactly when the high half is below the divisor | Z3 |
| M4 | `curve_out` never reaches `mul_div`'s saturating branch | Z3 |
| C1 | The curve pays out between nothing and its whole output side, never all of it while the input side holds anything, and nothing for no input | Z3 (every input); Kani (never panics for every input; the rest below 16) |

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

## Run times

Measured on the owner's Mac (Intel Xeon W-2150B, 10 cores) on 2026-11-12.

RUN_TIMES_PENDING
