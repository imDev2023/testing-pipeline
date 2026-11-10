# Pool4 for Solana: the integer model

A prototype made while resolving [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20), kept on this branch and never merged.
It is a Python model of the rules in [`docs/spec/pool4-for-solana.md`](https://github.com/imDev2023/testing-pipeline/blob/main/docs/spec/pool4-for-solana.md), in integers only, rounded exactly as the spec says the program rounds.
The spec's formulas were run here before they were written down, and its worked example is this model's output.

## Files

- `pool4_model.py`: the seed, the shared pricing function for quotes and swaps, everything a swap does after pricing (the reference, the books and the fee split, the floor, the decay credit, the ratchet and the trim), `place_wall`, `settle`, and a solvency check.
- `run_model.py`: random sequences of buys, sells, wall placements and settles with clock and slot jumps, checking the invariants after every step.
- `example.py`: prints the spec's worked example and its pump test.

## Running it

Python 3.9 or later, no dependencies.

```
python3 example.py
python3 run_model.py 3000
```

## What it checks

After every step of every run:

- each vault equals the sum of its ledgers, and the pool ledgers cover everything the curve and the buy wall could pay out;
- every quote equals its swap;
- a buy sold straight back never returns more than it cost;
- a trim never moves the price, and the curve never holds more than the inventory cap unless the minimum liquidity stopped the trim;
- the inventory cap never falls below the cap floor;
- the wall's floor is never above the price, and a placed wall's top is never above the floor.

On 2026-11-10, 3,000 runs of 400 steps passed: about 957,000 swaps, 65,000 trims and 33,000 wall placements.

## What it leaves out

- Accounts, token transfers, the router and Pipeline's fee: it models one market's numbers only.
- `pay_rewards`, `sweep_fees`, the recipient handovers and the counters, which only move ledgers.
- The seed's refusals for too little SOL and for a cap floor that would leave too little liquidity.
- 256-bit overflow: Python's integers never overflow, so the build must prove its own bounds.

It caught three slips while the spec was written: a trim that could book minus one lamport of recovered SOL, a seed formula whose liquidity could exceed the vault by one unit, and a solvency check that was one unit too strict while the price is inside the wall.
