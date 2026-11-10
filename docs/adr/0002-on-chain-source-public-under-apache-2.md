# Our on-chain source is public under Apache-2.0

Our on-chain programs are published from this public repo, and the on-chain workspace carries its own Apache-2.0 licence (decided 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)).
Published source is what makes verified builds, Pipescope's explainer and integrators' checks possible for our own strategies, and anyone can already copy a program's deployed bytecode and redeploy it, so a restrictive licence would protect little.
Apache-2.0 matches Pipeline's strategy template, which our strategies start from.

## Considered options

- Business Source License 1.1, as Pipeline's router uses: it deters a fork running in production, but not a copy of the deployed bytes, and it reads as less trustworthy to integrators.
- A public mirror of only the on-chain workspace, kept beside a private monorepo: dropped once the monorepo itself became public (2026-11-09), because a mirror adds a sync step and a second repo to verify against.

## Consequences

- An Apache-2.0 grant cannot be withdrawn for code already published.
- The rest of the repo's licence is not decided here.
