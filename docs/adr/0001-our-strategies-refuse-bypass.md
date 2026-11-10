# Our strategies refuse bypass

Pipeline allows bypass: a strategy that does not check the market signer can be called directly, without the Pipeline fee or a swap event.
Every strategy we write refuses it instead: `pipeline_swap` accepts only the router's market signer for that market (decided 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)).
A bypassed swap would be invisible to swap events, which the containment hook's unlock goal, the tax AMM's counters and Pipescope's charts all rely on, and it would let traders skip the Pipeline fee on our own markets.

## Consequences

- Once a program is frozen this cannot change, so a program that ever needs direct swaps must say so in its spec file before it is frozen.
- Custom actions still run directly on the strategy, without the router; none of them may move the price.
