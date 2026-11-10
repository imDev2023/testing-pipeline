# testing-pipeline

A suite of products built on Pipeline (https://github.com/MetalLegBob/pipeline), MetalLegBob's permissionless router for experimental Solana markets: Pipescope (a terminal with Canary safety checks and an AI explainer), a containment hook, a tax AMM, Pool4 for Solana, a lending pool, and single-use AMMs built for clients (working names; see `GLOSSARY.md`).
Started 2026-11-09 from an evaluation of Pipeline; the folder and repo keep the internal name `testing-pipeline` for good (decided 2026-11-09), and product and suite names are settled on the wayfinder map.

## Where things stand

Planning: no code yet.
The wayfinder map is charted (2026-11-09): [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1), built from `docs/charting-brief.md`.
The owner wants it done as soon as possible in parallel sessions: one ticket per session (research tickets excepted), each claimed by assigning yourself before any work.
Auto mode refuses `gh repo create` and similar outward GitHub writes: write the commands to a script and hand the owner one `! bash <script>` line (`scripts/create-github-repo.sh` is the repo's).
Start every session by reading the map's `## Next` section (the map is the issue labelled `wayfinder:map`: `gh issue list --repo imDev2023/testing-pipeline --label wayfinder:map`).
Decisions land in `docs/adr/` and the spec in `docs/spec/`: a shared `README.md` plus one file per product; build tickets are labelled `build` and run one per session.

## Read first

- `research/README.md`: everything learned before the map, including how Pipeline works and its limits (`research/pipeline-router.md`), who MetalLegBob is and what he asked for (`research/metallegbob.md`), and full-text archives of his X posts (`research/x/`).
- `GLOSSARY.md`: the project's language; use its terms in issues, code and tests.
- `docs/toolchain.md`: the Solana toolchain this project builds and tests with, installed side by side by `scripts/install-toolchain.sh` and put on `PATH` per shell by `source scripts/toolchain-env.sh`; never change the machine's default Solana CLI, which the owner's other projects use.
- For anything about Jupiter or Meteora, the owner's canonical knowledge base at `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora`, not the web; for Pool4's Uniswap v4 background, `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/v4-hooks`; for Cloudflare, `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/cloudflare`.

## Rules for this project

- Pipeline's source is read from a clone in a scratchpad at commit `a8b1b1d` or newer (note which); never copy the router (BSL 1.1 until 2028-11-08) or the rest of Pipeline's repo into this repo.
  The exceptions are code generated from Pipeline's Apache-2.0 strategy template (`scripts/new-strategy.sh`), which our strategies start from, and its Apache-2.0 `test-hook` allowlist hook, which the containment hook starts from (owner, 2026-11-10).
- Every on-chain program meets the engineering and security bar in `docs/spec/README.md` before its build tickets count as done.
- Devnet only until Pipeline's router is on mainnet; never create mainnet deployments before then.
- Never hold users' private keys, in Pipescope or a Telegram bot.
- Ask the owner before every paid call, including LLM calls for the explainer and paid RPC tiers, and log approved ones in `~/.config/spend/ledger.csv`.
- MetalLegBob is a third party: agents draft messages to him in `~/.config/testing-pipeline/outreach.md`, the owner sends them, and his answers are recorded there with dates.
  The repo is public (2026-11-09), so his words and the messages never go into the repo, its issues or its PRs; those record only the decisions his answers settle.
- This project's devnet keys live outside the repo in `~/.config/testing-pipeline/devnet/`; it does not use Top-pad's (Heat's) devnet bank.
- To refresh the X archives, follow `research/README.md` (Claude in Chrome for ids, then `scripts/fetch_x_posts.py`).
- Code reused from the owner's other projects (Top-pad's indexer, candles, Workers and OpenNext setup, Codama clients, solana-verify flow, Playwright setup) is copied in and owned here; these products stay separate from those projects.

## Agent skills

### Issue tracker

Issues, the wayfinder map and the build tickets live in GitHub issues on `imDev2023/testing-pipeline`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

## Multica dashboard

This project is mirrored on the owner's Multica dashboard (workspace Pandora) as project `8eefe62d-d883-4e95-9ee0-d1ae91a2580a`.
The GitHub issues on `imDev2023/testing-pipeline` stay the source of truth; Multica only mirrors them.
The starting Multica tickets (PAND-764 create the repo, PAND-765 send the outreach, PAND-766 chart the map) were done by 2026-11-09; from then on Multica mirrors the map's tickets.
The Multica project was linked to the local folder because the repo did not exist yet.
At the end of every session, after the tracker is updated, run the `multica-sync` skill for this project: mirror ticket statuses, add any new tickets, and refresh the project's "Current step" section.
Every Multica write passes `--no-start` and no ticket is ever assigned to an agent, so the sync never starts an agent run.
If the `multica` CLI is not signed in, say so in the session summary and stop anyway; the sync never blocks the work.
The Multica server can time out; set `MULTICA_HTTP_TIMEOUT=90` and check `multica project list` before retrying a create.
