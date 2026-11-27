# testing-pipeline

Aviary, a suite of products built on Pipeline (https://github.com/MetalLegBob/pipeline), MetalLegBob's permissionless router for experimental Solana markets: a terminal of the same name with Canary safety checks and an AI explainer, a containment hook, a tax AMM, a buy wall AMM (a port of IMD's Pool4 design), a lending AMM, and single-use AMMs built for clients (see `GLOSSARY.md`).
Started 2026-11-09 from an evaluation of Pipeline; the folder and repo keep the internal name `testing-pipeline` for good (decided 2026-11-09).
The public names were settled on 2026-11-10 (`docs/spec/README.md`, Names) and are defaults MetalLegBob may change; the working names Pipescope, Pool4 for Solana and lending pool survive only in file names, ticket titles and dated research notes.

## Where things stand

All four programs are built, hardened and on devnet, each registered with Pipeline's router except the hook (not a strategy), with addresses and releases in `deployments/devnet.json` and the demo markets and tokens in `deployments/devnet-demo-*.json`: the tax AMM `J4sA9oSJ...` (#66, hardened in #67), the buy wall AMM `BmXEmoN2...` (#56), the containment hook `aueUqJKZ...` (#73, #74) and the lending AMM `Ewbh5n8p...` (#87) lending WSOL to our Kamino market.
The on-chain workspace is `programs/` and CI is `.github/workflows/ci.yml`; `docs/toolchain.md` says how to build, test, run the local demo and redeploy (all three steps of "Deploy to devnet", with each program's release gate run first by `scripts/deploy-devnet.sh`).
Pipeline is pinned at 0.4 (#227, `fixtures/pins.env` and `rev` in `programs/Cargo.toml`); a daily job opens an issue when devnet's router drifts from the pin, every on-chain CI job then fails, and the re-pin goes in a PR of its own before anything else merges.
Aviary runs locally (`wrangler dev` against the Docker Postgres and devnet) until its hosted deploy, #192, which waits for the Neon half of #110.
Its `RPC_URL` in the project's `.env` is built from Aviary's own Helius key `HELIUS_API_KEY_PIPELINE`; the shared `HELIUS_API_KEY` ran out of credits on 2026-11-24 (429 `max usage reached`, which no wait cures), so never record fixtures or run devnet checks with it.
LuLu, the owner's firewall, holds outbound calls from every new binary path: run every `wrangler dev` with `MINIFLARE_WORKERD_PATH=/Users/fisd/.local/share/testing-pipeline/bin/workerd-1.20261119.1`, the one copy the owner allowed, and tell the coordinator if the pinned workerd version moves.
Auto mode refuses `gh repo create` and similar outward GitHub writes: write the commands to a script and hand the owner one `! bash <script>` line (`scripts/create-github-repo.sh` is the repo's).
Start every session by reading the map's `## Next` section: [the map](https://github.com/imDev2023/testing-pipeline/issues/1), the issue labelled `wayfinder:map`, charted 2026-11-09 from `docs/charting-brief.md`.
Decisions land in `docs/adr/` and the spec in `docs/spec/`: a shared `README.md` plus one file per product; build tickets are labelled `build` and run one per session.
Every decision settled so far is one block in `docs/decisions.md`, the decision register, with a stable ID.

## Read first

- `research/README.md`: everything learned before the map, including how Pipeline works and its limits (`research/pipeline-router.md`).
  MetalLegBob's profile and the full-text archives of his X posts are kept out of the repo, in `~/.config/testing-pipeline/research/` (`metallegbob.md`, `x/`).
- `GLOSSARY.md`: the project's language; use its terms in issues, code and tests.
- `docs/decisions.md`: the decision register, every decision with its ID, the one place its value lives and how it would change; its top says how to add or change an entry.
- `docs/toolchain.md`: the Solana toolchain this project builds and tests with, installed side by side by `scripts/install-toolchain.sh` and put on `PATH` per shell by `source scripts/toolchain-env.sh`; never change the machine's default Solana CLI, which the owner's other projects use.
- For anything about Jupiter or Meteora, the owner's canonical knowledge base at `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora`, not the web; for Pool4's Uniswap v4 background, `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/v4-hooks`; for Cloudflare, `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/cloudflare`.

## Rules for this project

- Pipeline's source is read from a clone in a scratchpad at commit `a8b1b1d` or newer (note which); never copy the router (BSL 1.1 until 2028-11-08) or the rest of Pipeline's repo into this repo.
  The exceptions are code generated from Pipeline's Apache-2.0 strategy template (`scripts/new-strategy.sh`), which our strategies start from, and its Apache-2.0 `test-hook` allowlist hook, which the containment hook starts from (owner, 2026-11-10).
- The suite is built for MetalLegBob (owner, 2026-11-10): every decision the owner makes is a default that he may change.
  Each session records the decisions it settles in the decision register, `docs/decisions.md`, in its block format, and runs `node scripts/decisions.mjs --check`.
- Specs and code keep each decision cheap to change: policy values (fees, caps, splits, defaults, limits) live in one named place per product, a config module or creation parameters, never scattered.
  A value that must be fixed on-chain for trust stays a build-time constant in that place, so it can change before deployment.
- Anything shown or sent to MetalLegBob (a PR, a demo, the progress site, a message) lists the decisions it rests on, by ID, and invites him to change any of them.
  The register never quotes him: a change he asks for is recorded only as a changed decision with its date.
- Every on-chain program meets the engineering and security bar in `docs/spec/README.md` before its build tickets count as done.
- Devnet only until Pipeline's router is on mainnet; never create mainnet deployments before then.
- Never hold users' private keys, in Aviary or a Telegram bot.
- Ask the owner before every paid call, including LLM calls for the explainer and paid RPC tiers, and log approved ones in `~/.config/spend/ledger.csv`.
- MetalLegBob is a third party: agents draft messages to him in `~/.config/testing-pipeline/outreach.md`, the owner sends them, and his answers are recorded there with dates.
  The repo is public (since 2026-11-20, the owner's decision of 2026-11-09), so his words and the messages never go into the repo, its issues or its PRs; those record only the decisions his answers settle.
- This project's devnet keys live outside the repo in `~/.config/testing-pipeline/devnet/`; it does not use Top-pad's (Heat's) devnet bank.
- MetalLegBob's profile and the archive of his X posts live only in `~/.config/testing-pipeline/research/` and never go into the repo, its issues or its PRs (owner, 2026-11-10).
  `.gitignore` lists their old paths, and hooks on the owner's Mac refuse commits that add them and pushes of the old history.
- To refresh the X archives, follow `research/README.md` (Claude in Chrome for ids, then `scripts/fetch_x_posts.py`), writing into `~/.config/testing-pipeline/research/x/`.
- Code reused from the owner's other projects (Top-pad's indexer, candles, Workers and OpenNext setup, Codama clients, solana-verify flow, Playwright setup) is copied in and owned here; these products stay separate from those projects.

## The repository

Since 2026-11-19 (#167), `imDev2023/testing-pipeline` is a new repository with every issue number of the old one, whose history was purged of MetalLegBob's profile and X archive; the old repository is `imDev2023/testing-pipeline-archive`, private for good: read it, never write to it.
Numbers that were pull requests are closed placeholder issues naming the archived pull request; `docs/toolchain.md`, "The repository and its archive", says the rest.
The new repository is public since 2026-11-20 (`scripts/make-repo-public.sh`), and CI runs on GitHub's runners again.

## Progress site

https://testing-pipeline.vercel.app is the public site that shows what this project has done so far.
It lives in `site/`, and all its content is one generated file, `site/content.json`.
`site/README.md` has the commands (`npm run refresh`, `npm run deploy`) and the privacy rules that guard it; read it before touching the site.
A deploy goes to production: the owner approved the first on 2026-11-10, so ask before another unless they have said otherwise.

## Agent skills

### Issue tracker

Issues, the wayfinder map and the build tickets live in GitHub issues on `imDev2023/testing-pipeline`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

## Multica dashboard

This project is mirrored on the owner's Multica dashboard (workspace Pandora) as project `8eefe62d-d883-4e95-9ee0-d1ae91a2580a`.
The GitHub issues on `imDev2023/testing-pipeline` stay the source of truth; Multica only mirrors them.
At the end of every session, after the tracker is updated, run the `multica-sync` skill for this project: mirror ticket statuses, add any new tickets, and refresh the project's "Current step" section.
Every Multica write passes `--no-start` and no ticket is ever assigned to an agent, so the sync never starts an agent run.
If the `multica` CLI is not signed in, say so in the session summary and stop anyway; the sync never blocks the work.
The Multica server can time out; set `MULTICA_HTTP_TIMEOUT=90` and check `multica project list` before retrying a create.
