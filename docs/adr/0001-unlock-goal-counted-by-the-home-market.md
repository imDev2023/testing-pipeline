# The unlock goal is counted by the home market's strategy, not by the hook

The containment hook's permissionless `unlock` needs a trustworthy count of what a contained token's home market has done, and no program can read the router's swap events or find volume or tax in the router's state.
We decided that the tax AMM counts the tax its market collects from router swaps (bypass is refused) in its market state, and that `unlock` reads that counter; so in v1 every home market is a tax AMM market with its tax side on the quote mint, and the hook trusts the tax AMM's code, which therefore has to be frozen too.
Decided in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18) from the options in [How the containment hook works with the router and unlocks](https://github.com/imDev2023/testing-pipeline/issues/10) and the counters the tax AMM offers in `docs/spec/tax-amm.md`.

## Considered options

- A counter in the hook, updated on every transfer into or out of the home vault: it also counts liquidity moves and donations, so the goal could be faked for free, and every transfer would write-lock one account.
- Counting transfers into the Pipeline fee account: donations into it count too, so faking a volume costs only 0.25% of it, and buys are invisible.
- A wrapper program that calls the router and reads its return data: it misses every swap made straight through the router and uses the last spare call level.
- The tax AMM's volume counter instead of its tax counter: a tax authority can lower the tax to 0 within its fixed range, and the tax AMM has no LP fee, so volume could then be faked for Pipeline's 0.25% fee alone.

## Consequences

- The two programs are coupled: the counter's place in the tax AMM's market state is part of the hook's contract, and changing either needs both.
- Home markets on other strategies would need each strategy to keep a counter the hook can trust; that is not planned.
