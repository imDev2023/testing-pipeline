# Build tickets

How a session works an issue labelled `build`.
These rules are shared by every build ticket, so a ticket carries only what is its own.
`CLAUDE.md` and the engineering and security bar in `docs/spec/README.md` still apply in full.

## Start

- Claim the ticket by assigning yourself before any work, and do one ticket per session.
- Read `CLAUDE.md`, `GLOSSARY.md`, the spec sections the ticket names and the bar sections its acceptance criteria cite.
- For on-chain work, `source scripts/toolchain-env.sh` in every shell (`docs/toolchain.md`), and build each program by its own manifest.
- Read Pipeline from a scratchpad clone at the commit the repo pins, and name that commit in the PR.

## Build

- Test first: write the failing test, make it pass, then tidy.
- On-chain behaviour is tested in LiteSVM through the real router, never against a stand-in for it.
- A change to a program's instructions, accounts or arguments changes its strategy metadata, its generated client and its demo script in the same PR, so none of them ever disagrees with the program.
- Policy values (fees, caps, splits, defaults, limits) live in one named place per product, a config module or creation parameters, never scattered; a value fixed on-chain for trust is a build-time constant in that place (owner, 2026-11-10; the map's Notes).
- Sessions on neighbouring tickets share the strategy metadata and the demo script.
  Keep each instruction in its own module so parallel PRs rarely touch the same lines, and rebase on `origin/main` before the final run.

## Verify

Every acceptance criterion is checked by running it, and the PR description records how: the command, and the output, signature or address that shows it.

- **LiteSVM tests** run through the router's bytes dumped from devnet and checked against the hash pinned in the repo.
- **Local demo run**: the product's demo script run against a local validator that runs devnet's router, building its transactions with Pipeline's TypeScript SDK from the strategy metadata, as a terminal would.
  Start the validator with the Bash tool's `run_in_background` and stop it with TaskStop.
- **Devnet demo**: the same script against devnet, only in the tickets that say so.
  Before a program's devnet ticket, nothing of it is deployed or registered on devnet.
  Devnet SOL comes from `devnet-airdrop`, never from a web faucet.

## Land

- Run `/code-review` at high effort on the PR and fix what it confirms (bar, "Internal adversarial review").
- CI is green; a red or flaky check is fixed, not retried until it passes.
- The PR lists the decisions it rests on by their IDs in the decision register, `docs/decisions.md`, and a decision the ticket settles is added there; every one is a default MetalLegBob may change.
- Rebase on `origin/main`, squash-merge the PR yourself once every criterion is verified, and close the ticket with a comment saying what was built and what was measured.
- A ticket that deploys to devnet records the deploy in `deployments/devnet.json` (bar, "Verified builds").
- Note the ticket done in the map's `## Next`, following "Edit the map body" in `docs/agents/issue-tracker.md`.
- If a criterion cannot be met, or the spec turns out to be wrong, say so on the ticket and leave it open.
  A spec change is a PR to the spec file, never a silent difference in the code.
- End with the `multica-sync` skill, as `CLAUDE.md` says.
