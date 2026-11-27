# Decision register

Every decision settled so far for the suite, one block each, so that MetalLegBob can review and change any of them.
The suite is built for him: each answer below is a default, the owner's unless [Follow-ups](#follow-ups) says a session set it, and none is a final word (owner, 2026-11-10).
To change one, name its ID in an issue, in a comment on a PR, or in a message to the owner.

The spec stays the source of truth for what a decision means.
This file is the index: what was decided, what else was weighed, the one place where its value lives, and how it would change.
It was first written on 2026-11-10 from the resolution comments of the closed tickets on [the map](https://github.com/imDev2023/testing-pipeline/issues/1), from `docs/spec/`, from `docs/adr/` and from the answers the owner gave to every session.
Each session that settles a decision afterwards adds its own block.

## How to read an entry

Every decision is one block in exactly this shape:

```markdown
### TAX-03: Highest tax

- Question: What is the highest buy or sell tax a tax market may ever charge?
- Answer: 10%, the constant `MAX_TAX_BPS` (1000), so no tax market can be a honeypot through its tax.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Constants](spec/tax-amm.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)
```

- **The ID** is a product prefix and a number of at least two digits.
  The prefixes are `SUITE`, `BAR` (the engineering and security bar), `PIPESCOPE` (Aviary, the terminal), `CANARY`, `EXPLAINER`, `TAX`, `HOOK`, `POOL4` (the buy wall AMM) and `LENDING` (the lending AMM).
  They are identifiers, taken from the spec file names, and like those file names they stay as they are when a public name changes.
  An ID is never renumbered or reused, and a block is never deleted.
- **Question** is what was asked, and **Answer** is the current answer.
- **Alternatives** are what was weighed and not chosen, or "None recorded." when the record names none.
- **Specified in** names the single place where the decision's value lives: a file and one of its sections, the map for the few decisions that live only in its body, or a ticket when the decision lives only there, because its spec has not landed yet or because it only shapes how that ticket is built.
- **Changes by** says what changing it takes, and is exactly one of:
  - `spec only`: a design or process choice; change the section named, and whatever is built from it.
  - `build-time constant`: one named value compiled into a program, a binary or an app; change it there and deploy again, which for an on-chain program is possible only while it is upgradeable.
  - `market-creation parameter`: chosen by whoever creates each market or binds each token; markets that already exist keep theirs.
  - `runtime setting`: a configuration value that changes with no change to the code.
  - `fixed on-chain once deployed`: a rule, an address or an account layout of an on-chain program; free to change until the program is first deployed, afterwards only by an upgrade that existing markets must survive, and never once the program is frozen.
- **Status** is `default` (the owner's answer, or a session's own choice the owner has not been asked about; either way open to change), `confirmed` with the date MetalLegBob confirmed it, or `changed` with the date it changed.
- **Decided** is the date and the ticket that settled it.

Each field is one line, and each value is one sentence of inline Markdown.

## How to add or change an entry

- Add a block for every decision you settle, at the end of its product's section, with the next free number.
  If another session took that number first, the block that merges second takes the next one before it merges; an ID on `main` never changes.
- When a decision changes, put the new answer in **Answer**, move the earlier answer to the front of **Alternatives** as "the earlier default", set **Status** to `changed` with the date, and change the section that **Specified in** names in the same PR.
- When MetalLegBob confirms a decision, set **Status** to `confirmed` with the date.
- Never quote MetalLegBob here, and never draw on the private outreach file: a change he asks for is recorded only as a changed decision with its date.
- If a value turns out to live in more than one place, fix the spec you own, or list it under [Follow-ups](#follow-ups) when the spec is another session's.
- Run `node scripts/decisions.mjs --check` before you push; it checks the shape of every block and that every **Specified in** target exists.
  `node scripts/decisions.mjs --json` prints the register for the progress site.
- List the IDs your PR rests on in its description; `.github/pull_request_template.md` has the section.

## Suite (SUITE)

### SUITE-01: Whose decisions these are

- Question: Who has the last word on the suite's decisions?
- Answer: MetalLegBob, for whom the suite is built: every decision the owner makes is a default he may change, and each session records the decisions it settles in this register.
- Alternatives: Treating the owner's answers as final.
- Specified in: [`CLAUDE.md`, Rules for this project](../CLAUDE.md#rules-for-this-project)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Decision register open to MetalLegBob's review](https://github.com/imDev2023/testing-pipeline/issues/43)

### SUITE-02: Policy values live in one named place

- Question: How do the specs and the code keep a decision cheap to change?
- Answer: Each product keeps its policy values (fees, caps, splits, defaults, limits) in one named place, a config module or its creation parameters, never scattered; a value that must be fixed on-chain for trust stays a build-time constant in that place, so it can change before deployment.
- Alternatives: Values written wherever they are used.
- Specified in: [`CLAUDE.md`, Rules for this project](../CLAUDE.md#rules-for-this-project)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Decision register open to MetalLegBob's review](https://github.com/imDev2023/testing-pipeline/issues/43)

### SUITE-03: What is shown to MetalLegBob names its decisions

- Question: What does a PR, a demo, the progress site or a message carry when it is shown or sent to MetalLegBob?
- Answer: The IDs of the decisions it rests on, with an invitation to change any of them.
- Alternatives: None recorded.
- Specified in: [`CLAUDE.md`, Rules for this project](../CLAUDE.md#rules-for-this-project)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Decision register open to MetalLegBob's review](https://github.com/imDev2023/testing-pipeline/issues/43)

### SUITE-04: Destination, reached in stages

- Question: What is this effort working toward, and when does building start?
- Answer: A build-ready spec for the five products on devnet with build tickets for each, released in stages: a product's build tickets are cut by its own hand-off ticket as soon as its decisions close, so building starts before the whole map is done.
- Alternatives: Closing the whole map before any product is built.
- Specified in: [the map, Destination](https://github.com/imDev2023/testing-pipeline/issues/1)
- Changes by: spec only
- Status: default
- Decided: 2026-11-09 in [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1)

### SUITE-05: Products in the suite

- Question: Which products does the suite build?
- Answer: The terminal (Aviary), the containment hook, the tax AMM, the buy wall AMM and the lending AMM, all on devnet; single-use AMMs wait for a first client.
- Alternatives: Leaving out a product that someone else is already building, the rule set while charting; nobody is building any of the five.
- Specified in: [the map, Destination](https://github.com/imDev2023/testing-pipeline/issues/1)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Record MetalLegBob's answers to the follow-up DM](https://github.com/imDev2023/testing-pipeline/issues/27)

### SUITE-06: Build order

- Question: In which order are the products built?
- Answer: The tax AMM first, deployed on devnet and registered with Pipeline, then the other products as their build tickets are cut.
- Alternatives: The terminal first, then the containment hook and the tax AMM, then the buy wall AMM, then the lending AMM, the order set while charting.
- Specified in: [`docs/spec/tax-amm.md`, Tax AMM](spec/tax-amm.md#tax-amm)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### SUITE-07: One repository

- Question: Does each product get its own repository?
- Answer: No: one monorepo holds the on-chain programs in one Rust workspace, the terminal's app and indexer beside them, and shared clients and a shared test harness, under one CI.
- Alternatives: A repository per product.
- Specified in: [the map, Notes](https://github.com/imDev2023/testing-pipeline/issues/1)
- Changes by: spec only
- Status: default
- Decided: 2026-11-09 in [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1)

### SUITE-08: Shape of the spec

- Question: Is the spec one file or several?
- Answer: A shared `README.md` for what every product shares, plus one file per product, so a session loads only the product it works on.
- Alternatives: One `docs/spec.md` for all five products.
- Specified in: [`docs/spec/README.md`, Product files](spec/README.md#product-files)
- Changes by: spec only
- Status: default
- Decided: 2026-11-09 in [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1)

### SUITE-09: Internal name

- Question: What are the repo and its folder called?
- Answer: `testing-pipeline`, for good, whatever the public names become.
- Alternatives: Renaming the repo once the suite has a name.
- Specified in: [`docs/spec/README.md`, Names](spec/README.md#names)
- Changes by: spec only
- Status: default
- Decided: 2026-11-09 in [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1)

### SUITE-10: Devnet only

- Question: When may anything be deployed on mainnet?
- Answer: Not before Pipeline's router is on mainnet: until then everything is devnet only, and no mainnet date is known.
- Alternatives: None recorded.
- Specified in: [`CLAUDE.md`, Rules for this project](../CLAUDE.md#rules-for-this-project)
- Changes by: spec only
- Status: default
- Decided: 2026-11-09 in [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1)

### SUITE-11: Users' keys

- Question: Does any product ever hold a user's private keys?
- Answer: No: every transaction is signed in the user's own wallet, in Aviary and in any Telegram bot.
- Alternatives: A custodial Telegram bot that holds users' keys, ruled out of scope.
- Specified in: [`CLAUDE.md`, Rules for this project](../CLAUDE.md#rules-for-this-project)
- Changes by: spec only
- Status: default
- Decided: 2026-11-09 in [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1)

### SUITE-12: A token for the suite

- Question: Does the suite have a token of its own?
- Answer: No.
- Alternatives: A suite token, ruled out of scope.
- Specified in: [the map, Out of scope](https://github.com/imDev2023/testing-pipeline/issues/1)
- Changes by: spec only
- Status: default
- Decided: 2026-11-09 in [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1)

### SUITE-13: The mainnet launch

- Question: Is the mainnet launch (external audits and their budget, liquidity seeding, mainnet deployment) part of this effort?
- Answer: No: it is a later effort, planned once Pipeline's mainnet date is known.
- Alternatives: Planning the audits and the launch now.
- Specified in: [the map, Out of scope](https://github.com/imDev2023/testing-pipeline/issues/1)
- Changes by: spec only
- Status: default
- Decided: 2026-11-09 in [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1)

### SUITE-14: Legal and platform posture

- Question: Who settles the legal and platform posture of a terminal that charges a fee?
- Answer: MetalLegBob: the owner leaves it to him.
- Alternatives: A research ticket on it within this effort.
- Specified in: [the map, Out of scope](https://github.com/imDev2023/testing-pipeline/issues/1)
- Changes by: spec only
- Status: default
- Decided: 2026-11-09 in [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1)

### SUITE-15: Our products live inside Aviary

- Question: Where do users reach the tax AMM, the containment hook, the buy wall AMM and the lending AMM?
- Answer: Inside Aviary: none gets a website of its own, their actions run through Aviary's custom-action forms from each strategy's own metadata, and each product adds its own panel and forms when it is built.
- Alternatives: A website per product.
- Specified in: [`docs/spec/README.md`, Our products live inside Aviary](spec/README.md#our-products-live-inside-aviary)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### SUITE-16: Building against Pipeline before its mainnet

- Question: Do we build against Pipeline's SDK and quoter now, while they can still change?
- Answer: Yes: against a noted, pinned commit (`5ad130d` on 2026-11-10), moved deliberately when Pipeline moves.
- Alternatives: Waiting for a stable release.
- Specified in: [`docs/spec/README.md`, Starting point](spec/README.md#starting-point)
- Changes by: build-time constant
- Status: confirmed 2026-11-09
- Decided: 2026-11-09 in [Record MetalLegBob's answers to the outreach](https://github.com/imDev2023/testing-pipeline/issues/5)

### SUITE-17: Code from the owner's other projects

- Question: How is code from the owner's other projects reused?
- Answer: It is copied in and owned here (Top-pad's indexer, candles, Workers and OpenNext setup, Codama clients, solana-verify flow and Playwright setup), and these products stay separate from those projects.
- Alternatives: Building the products as features of those projects.
- Specified in: [`CLAUDE.md`, Rules for this project](../CLAUDE.md#rules-for-this-project)
- Changes by: spec only
- Status: default
- Decided: 2026-11-09 in [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1)

### SUITE-18: One public name

- Question: Does the suite have one public name, or one for the suite and another for its terminal?
- Answer: One: the suite and its terminal share it, since our other products live inside the terminal and have no sites of their own.
- Alternatives: A separate suite brand above the terminal; keeping the working name Pipescope, dropped because it borrows Pipeline's name.
- Specified in: [`docs/spec/README.md`, Names](spec/README.md#names)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17)

### SUITE-19: The name

- Question: What are the suite and its terminal called?
- Answer: Aviary, which in code lives in one config module of the web app, `apps/terminal-web/src/brand.ts`; Canary checks keep their name as a feature of Aviary.
- Alternatives: Quirk, the runner-up; Telltale; Leftfield; Offshoot; Canary itself.
- Specified in: [`docs/spec/README.md`, Names](spec/README.md#names)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17)

### SUITE-20: Names of the on-chain products

- Question: How are the on-chain products named?
- Answer: With plain descriptive names that carry the suite's name in front in public (Aviary Tax AMM, Aviary Containment Hook, Aviary Buy Wall AMM, Aviary Lending AMM), each living only in its program's strategy metadata and its `security.txt`.
- Alternatives: A brand name per product; descriptive names with no prefix.
- Specified in: [`docs/spec/README.md`, Names](spec/README.md#names)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17)

### SUITE-21: The Pool4 port's name

- Question: Does our port of IMD's Pool4 design carry the name Pool4?
- Answer: No: it is the buy wall AMM, and it credits IMD's Pool4 design wherever it is described.
- Alternatives: Pool4 for Solana, the working name, which reads as IMD's own release; burn AMM; capped burn AMM.
- Specified in: [`docs/spec/README.md`, Names](spec/README.md#names)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17)

### SUITE-22: Lending pool or lending AMM

- Question: Is the lending product called a pool or an AMM?
- Answer: The lending AMM, because a lending pool reads as a pool to lend to or borrow from, and the three strategies then read as one family.
- Alternatives: Lending pool, the working name.
- Specified in: [`docs/spec/README.md`, Names](spec/README.md#names)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17)

### SUITE-23: Address and handle

- Question: Which web address and X handle does Aviary use?
- Answer: The `.trade` domain of the suite's name and the matching handle on X, a pair with no defensive domains; the owner registers both, and nothing links to either until it exists.
- Alternatives: Other endings for the same name; the bare handle, if X will give it.
- Specified in: [`docs/spec/README.md`, Names](spec/README.md#names)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17)

### SUITE-24: Names in code

- Question: Do code identifiers carry the public name?
- Answer: No: apps, packages, Workers, databases, crates and programs are named for what they are (`terminal-web`, `tax-amm`), so a rename never touches them.
- Alternatives: `aviary-*` identifiers; keeping the `pipescope-*` identifiers.
- Specified in: [`docs/spec/README.md`, Names](spec/README.md#names)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17)

### SUITE-25: Names of files and tickets

- Question: Do spec files and tickets take the new names?
- Answer: Not now: they keep the names they were written under, so existing links still work.
- Alternatives: Renaming the files and fixing every link in the map and the closed tickets.
- Specified in: [`docs/spec/README.md`, Product files](spec/README.md#product-files)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17)

### SUITE-26: Keeper runner: wallet and spending caps

- Question: Which wallet pays for our keeper jobs, and how is its spending bounded?
- Answer: A new key made only for the runner, with tight caps kept as named settings in one module: at most 0.003 SOL a transaction, 0.01 SOL a market a day and 0.1 SOL a day in all.
- Alternatives: The same key with loose caps; reusing the project's deploy wallet.
- Specified in: [`docs/spec/keeper-runner.md`, Spending caps](spec/keeper-runner.md#spending-caps)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)

### SUITE-27: Keeper runner: failures and due jobs

- Question: What happens when a keeper job fails or the wallet runs dry, and how are due jobs shown?
- Answer: A failed job is retried after 30 seconds, 2 minutes and 10 minutes and then parked until the market's state changes; below its minimum balance or at a cap the runner sends nothing; and Aviary shows every due, held or parked job.
- Alternatives: The same with a Telegram alert; logs only.
- Specified in: [`docs/spec/keeper-runner.md`, Failures](spec/keeper-runner.md#failures)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)

### SUITE-28: Keeper runner: tips and coverage

- Question: Does the runner keep the tips it earns, and which markets does it serve?
- Answer: It keeps the tips, unwrapping them into its float, and it serves every market of our strategies on devnet, including markets other people create, within the spending caps.
- Alternatives: Sending the tips to the suite treasury; serving only markets we create.
- Specified in: [`docs/spec/keeper-runner.md`, Keeper tips](spec/keeper-runner.md#keeper-tips)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)

### SUITE-29: Progress site: design

- Question: What does the public progress site look like?
- Answer: One column of content beside a rail of section names, the map's ticket states shown as marks, light and dark following the system, and no script on any page.
- Alternatives: A notes-style sidebar; a plainer page still.
- Specified in: [`site/README.md`, Design](../site/README.md#design)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-30: Progress site: address

- Question: At which address is the progress site published?
- Answer: Under the Vercel project name `testing-pipeline`, a neutral name chosen before the public names were settled.
- Alternatives: `devnet-suite-progress`; `pipeline-suite-progress`.
- Specified in: [`site/README.md`, Vercel](../site/README.md#vercel)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-31: Progress site: the research on the existing Pool4 port

- Question: How much of our research on the Pool4 port already on devnet does the public site show?
- Answer: Both the ticket's resolution and its research findings, which were worked out from public chain data.
- Alternatives: The resolution only; leaving that ticket off the site.
- Specified in: [`site/README.md`, Privacy](../site/README.md#privacy)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-32: Keeper runner: where it runs

- Question: Where does the keeper runner run on devnet?
- Answer: On the owner's Mac as a launchd agent, as one Node program in this repo, `apps/keeper`; nothing of it runs on the owner's Cloudflare account, and a Docker image lets anyone run it on their own machine with their own key.
- Alternatives: A Worker of its own on Cloudflare; inside the terminal's API Worker.
- Specified in: [`docs/spec/keeper-runner.md`, What it is](spec/keeper-runner.md#what-it-is)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)

### SUITE-33: Keeper runner: the jobs

- Question: Which keeper jobs does the runner call?
- Answer: Every keeper job of our strategies: the buy wall AMM's four, the lending AMM's `rebalance` and the tax AMM's `distribute`; the containment hook's `unlock` has no job in v1.
- Alternatives: None recorded.
- Specified in: [`docs/spec/keeper-runner.md`, The jobs](spec/keeper-runner.md#the-jobs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)

### SUITE-34: Keeper runner: when jobs run

- Question: How does the runner learn that a job is due?
- Answer: From its own socket on our strategy programs after each transaction, a sweep of every market every 10 minutes, an hourly pass for `settle` and a daily pass for payouts, with one full pass whenever it starts; it reads only the chain.
- Alternatives: Acting when Aviary's indexer sees a market need a job.
- Specified in: [`docs/spec/keeper-runner.md`, Triggers](spec/keeper-runner.md#triggers)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)

### SUITE-35: Keeper runner: one definition of due

- Question: Where is the rule for when a job is due written?
- Answer: Once, as a pure function of the market state in the shared package `packages/keeper-jobs`, which both the runner and Aviary's panels use, so a button shows in Aviary exactly when the runner would act.
- Alternatives: None recorded.
- Specified in: [`docs/spec/keeper-runner.md`, One definition of due](spec/keeper-runner.md#one-definition-of-due)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)

### SUITE-36: Keeper runner: RPC

- Question: Which RPC does the runner use?
- Answer: Alchemy's free devnet endpoint, which keeps its load off Aviary's own Helius key and the owner's shared one; there is no paid tier, and the runner slows its sweeps if the free tier runs out.
- Alternatives: None recorded.
- Specified in: [`docs/spec/keeper-runner.md`, RPC](spec/keeper-runner.md#rpc)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)

### SUITE-37: Keeper runner: what it records

- Question: Where does the runner record what it did?
- Answer: In two tables of Aviary's Postgres, `keeper_runs` (a row per pass) and `keeper_run_jobs` (a row per job it sent, held or parked), written directly from the runner, or in its log when it has no database; a public keeper page in Aviary shows the wallet, today's spend against each cap and every held or parked job.
- Alternatives: The earlier default, one table `keeper_runs` holding both, which a row per pass and a row per job would have had to share.
- Specified in: [`docs/spec/keeper-runner.md`, What it records](spec/keeper-runner.md#what-it-records)
- Changes by: spec only
- Status: changed 2026-11-22
- Decided: 2026-11-10 in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)

### SUITE-38: Progress site: where its content comes from

- Question: Where does the public site get what it shows?
- Answer: From one generated file, `site/content.json`, which one command rebuilds from the map and its tickets, `README.md` and `docs/` on `main`, and the findings on the research branches; the pages are static, with no server, no script, and no call to GitHub from a visitor's browser.
- Alternatives: Fetching from GitHub when a page loads; letting Vercel build from the repo, which needs a token and a connected repo.
- Specified in: [`site/README.md`, How it fits together](../site/README.md#how-it-fits-together)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-39: Progress site: what may be shown

- Question: How does the site keep private material out of public pages?
- Answer: It reads only the owner's own resolution comments, skips the tickets about private correspondence, drops every block that touches that correspondence, drops every block that names a third party unless that exact block was approved in `site/approved.txt`, and must pass the owner's private-lines check before the content is written and again before every deploy.
- Alternatives: The private-lines check alone; approving by pattern instead of by exact block.
- Specified in: [`site/README.md`, Privacy](../site/README.md#privacy)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-40: Progress site: its name

- Question: What is the public site called?
- Answer: Aviary, taken with its headline from the first line of `README.md`, at the address it already had.
- Alternatives: Keeping the internal name `testing-pipeline` in the header; a new address under the public name.
- Specified in: [`site/README.md`, What is shown](../site/README.md#what-is-shown)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-41: Progress site: working names in dated records

- Question: Do the tickets and resolutions the site shows take the public names?
- Answer: No: they are dated records and are shown as written, while the site's own name, its headline and the map's Destination use the public names.
- Alternatives: Rewriting the working names on display from one table of names.
- Specified in: [`site/README.md`, What is shown](../site/README.md#what-is-shown)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-42: Progress site: the address before it is registered

- Question: Does the site show the address and the handle chosen for the suite before the owner has registered them?
- Answer: No: every block that names either, or says which names are free, stays off the site until both are registered.
- Alternatives: Showing them without links.
- Specified in: [`site/README.md`, Privacy](../site/README.md#privacy)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-43: Progress site: the decision register

- Question: How does the site show this register?
- Answer: As one page with a section per product and every decision reachable by its ID (`/decisions/#tax-03`), linked from the front page under the standing rule; a decision with a line that may not be shown is left out whole.
- Alternatives: Showing such a decision with the line missing; filters by status and by how a decision changes, which need generated views or script.
- Specified in: [`site/README.md`, What is shown](../site/README.md#what-is-shown)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-44: Progress site: readers that are programs

- Question: What does the site give an agent that reads it?
- Answer: A Markdown twin of every page, an index of them at `/llms.txt`, and everything in one file at `/content.json`.
- Alternatives: HTML pages only.
- Specified in: [`site/README.md`, For agents reading the site](../site/README.md#for-agents-reading-the-site)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-45: Progress site: how it is deployed

- Question: How does a new version of the site reach the public address?
- Answer: By one command on the owner's machine that builds the pages, runs the private-lines check on the built files and uploads exactly those files; the Vercel project is never connected to the repo, and every deploy needs the owner's word.
- Alternatives: Vercel building from a connected repo on every push.
- Specified in: [`site/README.md`, Vercel](../site/README.md#vercel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30)

### SUITE-46: Reaching a public repository

- Question: How does the project become public when GitHub's read-only pull request refs of the old repository still hold the purged research files?
- Answer: It moves to a new repository of the same name with every issue number kept and the purged history, the old one becomes `imDev2023/testing-pipeline-archive`, private for good, and the new one goes public only after a scan proves it clean and the owner says yes.
- Alternatives: Asking GitHub Support to delete the two pull request refs and collect the old commits; a public mirror of the code beside the private repository.
- Specified in: [`docs/toolchain.md`, The repository and its archive](toolchain.md#the-repository-and-its-archive)
- Changes by: spec only
- Status: default
- Decided: 2026-11-19 in [Move the project to a new repository without the old pull request refs, then make it public](https://github.com/imDev2023/testing-pipeline/issues/167)

### SUITE-47: What the move carries

- Question: What does the new repository keep of the old one's record?
- Answer: Every issue with its comments and their original dates, labels, sub-issues and blocked-by links on its own number, a closed placeholder naming the archived pull request and its squash commit on each number that was a pull request, the open pull requests recreated under new numbers, and the few lines that quoted MetalLegBob reworded in every commit and issue.
- Alternatives: Transferring the issues, which would carry their edit history and empty the archive; copying them without their dates; leaving the numbers that were pull requests unused, which GitHub cannot do.
- Specified in: [`scripts/move-repo/README.md`, What it does](../scripts/move-repo/README.md#what-it-does)
- Changes by: spec only
- Status: default
- Decided: 2026-11-19 in [Move the project to a new repository without the old pull request refs, then make it public](https://github.com/imDev2023/testing-pipeline/issues/167)

### SUITE-48: Progress site: links into the repository

- Question: Where do the site's links into the repository point now that the repository is public?
- Answer: Straight at it on GitHub, a file written relative to another at the branch it was read from, and a refresh stops on a link to a file, a folder, a section, a commit or a ticket the repository does not hold, so no link the site shows is broken.
- Alternatives: The site's own page where it has one and GitHub otherwise; the site's own pages and plain text for the rest, as while the repository was private.
- Specified in: [`site/README.md`, What is shown](../site/README.md#what-is-shown)
- Changes by: spec only
- Status: default
- Decided: 2026-11-20 in [Progress site: link straight to the public repository](https://github.com/imDev2023/testing-pipeline/issues/186)

### SUITE-49: Keeper runner: the socket and discovery off Alchemy

- Question: Alchemy's free devnet endpoint serves neither `logsSubscribe` on its socket nor `getProgramAccounts`, so where do the runner's socket and market discovery go?
- Answer: To Aviary's own Helius key once the project's `.env` has it as `RPC_URL`, and until then to Solana's public devnet endpoint, which serves both free and without a key, each its own setting (`WS_URL`, `DISCOVERY_RPC_URL`); reads, simulations and sends stay on Alchemy.
- Alternatives: The owner's shared Helius key, already rate-limited when several sessions run; everything on the public endpoint; a paid Alchemy tier, which the spec rules out.
- Specified in: [`docs/spec/keeper-runner.md`, RPC](spec/keeper-runner.md#rpc)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-20 in [Keeper runner: the runner, its wallet and the tax AMM's `distribute`](https://github.com/imDev2023/testing-pipeline/issues/94)

### SUITE-50: Keeper runner: nothing to do when a program does not refuse

- Question: The tax AMM's `distribute` on a slot owed nothing succeeds without effect rather than refusing, so how does the runner tell that a payout had nothing to do, as when another keeper paid it first?
- Answer: The tax AMM's entry in `packages/keeper-jobs` has no "nothing to do" refusal code and counts a simulation that emits no `Distributed` event as nothing to do, which costs the runner only that simulation.
- Alternatives: A `NothingOwed` refusal in the program, which would need an upgrade of the deployed program; reading the slot's owed amount again just before simulating, which still races another keeper.
- Specified in: [`docs/spec/keeper-runner.md`, One definition of due](spec/keeper-runner.md#one-definition-of-due)
- Changes by: spec only
- Status: default
- Decided: 2026-11-20 in [Keeper runner: the runner, its wallet and the tax AMM's `distribute`](https://github.com/imDev2023/testing-pipeline/issues/94)

### SUITE-51: Keeper runner: what a job costs

- Question: How does the runner estimate a job's cost before sending it, and count what it spent?
- Answer: The estimate is what the simulation takes from the keeper wallet (its fee and any rent it pays); once landed, a transaction counts what left the wallet and never less than its fee, put to the first known market among its accounts, the same way whether just sent or rebuilt after a restart.
- Alternatives: The fee plus the rent of the token accounts the runner expects a job to create, which every product would have to predict.
- Specified in: [`docs/spec/keeper-runner.md`, Sending a job](spec/keeper-runner.md#sending-a-job)
- Changes by: spec only
- Status: default
- Decided: 2026-11-20 in [Keeper runner: the runner, its wallet and the tax AMM's `distribute`](https://github.com/imDev2023/testing-pipeline/issues/94)

### SUITE-52: Keeper runner: when the RPC fails

- Question: Does a job count as failed, and so move towards parking, when the RPC cannot be asked?
- Answer: No: only the job's own failure counts (a refusal, a transaction that landed failed, an instruction that cannot be built); after a transport error, a timeout or a send that never lands the job is due again in the next pass.
- Alternatives: Counting every error as a failure, so an RPC outage of a few minutes would park jobs that would succeed.
- Specified in: [`docs/spec/keeper-runner.md`, Failures](spec/keeper-runner.md#failures)
- Changes by: spec only
- Status: default
- Decided: 2026-11-20 in [Keeper runner: the runner, its wallet and the tax AMM's `distribute`](https://github.com/imDev2023/testing-pipeline/issues/94)

### SUITE-53: Keeper runner: a misspelt setting

- Question: What does the runner do with a `KEEPER_` variable that names no setting?
- Answer: It refuses to start and names the variable and the settings there are, so a misspelt override never leaves a default in force.
- Alternatives: Ignoring it with a warning in the log.
- Specified in: [`docs/spec/keeper-runner.md`, Spending caps](spec/keeper-runner.md#spending-caps)
- Changes by: spec only
- Status: default
- Decided: 2026-11-20 in [Keeper runner: the runner, its wallet and the tax AMM's `distribute`](https://github.com/imDev2023/testing-pipeline/issues/94)

### SUITE-54: Keeper runner: a payout into an account it would create

- Question: When does the runner send a payout whose recipient's token account does not exist yet, so that the payout would create it at the keeper wallet's expense?
- Answer: Only once what it pays is worth at least that account's rent (2,039,280 lamports for a plain token account, 2,074,080 for a Token-2022 one and 2,108,880 when its mint has a transfer hook, cleared or not), a buy wall market's rewards valued in SOL at the market's current price and its fees being SOL already; until then the job is skipped at no cost and checked again in its next pass, and a payout into an account that exists is sent whatever it pays.
- Alternatives: Always paying, so a recipient that closes its account after each payout gets the runner's rent back each time; valuing rewards at the wall's price rather than the market's.
- Specified in: [`docs/spec/keeper-runner.md`, Sending a job](spec/keeper-runner.md#sending-a-job)
- Changes by: spec only
- Status: default
- Decided: 2026-11-21 in [Keeper runner: the buy wall AMM's four jobs](https://github.com/imDev2023/testing-pipeline/issues/95)

### SUITE-55: Keeper runner: unwrapping tips under the caps

- Question: Do the spending caps and `MIN_BALANCE` hold the transaction that unwraps the keeper wallet's tips?
- Answer: No: it brings the tips and the account's rent back into the float, far more than its fee, so it is sent whenever the wrapped-SOL account holds more than `TIP_UNWRAP_AT`, even below `MIN_BALANCE` or past a cap; its fee still counts in today's spend, which caps every later job.
- Alternatives: Holding it like a job, so a wallet below `MIN_BALANCE` could not recover the tips that would lift it back above.
- Specified in: [`docs/spec/keeper-runner.md`, Keeper tips](spec/keeper-runner.md#keeper-tips)
- Changes by: spec only
- Status: default
- Decided: 2026-11-21 in [Keeper runner: the buy wall AMM's four jobs](https://github.com/imDev2023/testing-pipeline/issues/95)

### SUITE-56: Keeper runner: `settle` at most hourly across a restart

- Question: How does the runner keep a job of the hourly pass, such as the buy wall AMM's `settle`, to once every `SETTLE_INTERVAL` on a market when it restarts, since its start runs a full pass?
- Answer: It learns when each hourly job last ran on each market from the keeper wallet's own successful transactions of the last `SETTLE_INTERVAL`, read whenever it rebuilds today's spend, each job recognised by its instruction's discriminator from `packages/keeper-jobs`; a job that ran less than `SETTLE_INTERVAL` ago on a market waits, in every pass the start's included.
- Alternatives: Remembering only what this run sent, so a restart within the hour settles again; a state file, which the runner otherwise does without.
- Specified in: [`docs/spec/keeper-runner.md`, Triggers](spec/keeper-runner.md#triggers)
- Changes by: spec only
- Status: default
- Decided: 2026-11-21 in [Keeper runner: the buy wall AMM's four jobs](https://github.com/imDev2023/testing-pipeline/issues/95)

### SUITE-57: Keeper runner: how Aviary knows it is running

- Question: How does the keeper page tell a quiet runner from a stopped one, when the runner records in Postgres only the passes that did something so the database can sleep?
- Answer: After every pass the runner posts a heartbeat (the pass, its time, when its run started, its `SWEEP_INTERVAL`, its caps and warnings) to `terminal-api`'s `POST /keeper/heartbeat`, signed with the keeper wallet's key; `terminal-api` keeps only heartbeats `KEEPER_WALLET` signed, within two minutes of its clock, at most one of each kind of pass every 30 seconds, in its KV namespace, which never wakes the database; the runner's setting `HEARTBEAT_URL` names where they go, and unset sends none.
- Alternatives: Judging the runner by due work alone, which cannot flag a stopped runner on a quiet devnet; a heartbeat row in Postgres at most once an hour, with an hour's threshold and about 15 of Neon's 100 free compute-hours a month; the spec as first written, whose page would say the runner looks stopped whenever devnet is quiet; a heartbeat row every sweep, which would keep Neon awake about 90 compute-hours a month.
- Specified in: [`docs/spec/keeper-runner.md`, How Aviary shows it](spec/keeper-runner.md#how-aviary-shows-it)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Aviary: the keeper page and the keeper runner's records](https://github.com/imDev2023/testing-pipeline/issues/129)

### SUITE-58: Keeper runner: which passes and jobs are recorded

- Question: Which jobs make a pass worth recording, and where does the runner find Aviary's database?
- Answer: A job whose transaction landed, whatever it did, with its signature and cost; a job held by a cap, once a UTC day for each cap that holds it and again after it was anything but held; a parked job; whatever ends a recorded hold or park (unparked, any other outcome, or no longer due at all); and the keeper wallet unwrapping its tips; retries run as passes of their own, `retry`; a spend that could not be rebuilt is recorded as unknown, and errors and warnings with their URLs cut to the host. The database is the project's `DATABASE_URL` unless `KEEPER_DATABASE_URL` names another; records are written behind the passes, and a database that cannot be reached logs the pass as the log would hold it, never stopping the runner.
- Alternatives: Recording only sent jobs, which would leave the fees of refused transactions off the page; recording every hold in every pass, which would keep Neon awake every sweep while a cap is reached; `DATABASE_URL` unset unless `KEEPER_DATABASE_URL` is set, which would leave the owner's runner unrecorded until someone remembered to set it.
- Specified in: [`docs/spec/keeper-runner.md`, What it records](spec/keeper-runner.md#what-it-records)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Aviary: the keeper page and the keeper runner's records](https://github.com/imDev2023/testing-pipeline/issues/129)

### SUITE-59: Keeper runner: accounts a due rule reads beyond the market

- Question: How does a due rule that depends on more than its market's state, as the lending AMM's withdraw mode depends on Kamino's reserve, read what it needs while staying a pure function in `packages/keeper-jobs`?
- Answer: The product's entry names those accounts (`watches`), the runner reads them with the market in the same `getMultipleAccounts` (requests of at most 100 accounts never split a market from its watched ones), every pass and again just before a job is sent, and hands them to the entry's `decode`, so a due rule sees one moment of the chain; the lending AMM's entry watches the market's reserve, its lending market and the clock sysvar, and a market whose watched accounts are missing has nothing due.
- Alternatives: Always due in withdraw mode with the simulation deciding, which would show Aviary's button on every market in withdraw mode; each entry reading the chain itself in its due rule, which would make the rule no longer pure and read the chain once per job.
- Specified in: [`docs/spec/keeper-runner.md`, One definition of due](spec/keeper-runner.md#one-definition-of-due)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Keeper runner: the lending AMM's `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/96)

### SUITE-60: Keeper runner: when the lending AMM's `rebalance` is due

- Question: Exactly when is the lending AMM's `rebalance` due, so the runner sends it and Aviary shows its button?
- Answer: Whenever the program would act: the rule is the program's own (`decide_with_exit_delay` with the band, `MIN_REBALANCE`, what Kamino can pay with its rate headroom, withdraw mode's thresholds and its exit delay) written again in TypeScript on the market and the reserve at their stored state, with `WithinBand`, `BelowMinRebalance`, `KaminoStopped` and `KaminoDepositsBlocked` taken as nothing to do when a simulation still refuses; `MIN_REBALANCE` per reserve and `KAMINO_RATE_HEADROOM_BPS`, which the program does not export, are repeated in the entry and checked against `config.rs` by its tests; what the program does not model either, such as klend's deposit limit (finding H035, signed off), is left to the simulation, where klend's refusal is a failure, retried and then parked until the market changes.
- Alternatives: Due whenever the buffer is outside its band or the market is in withdraw mode, leaving the rest to the simulation, which would keep a button up on markets with nothing the program would do; exporting the per-reserve values in the program's IDL, which waits for the lending AMM's next release.
- Specified in: [`docs/spec/keeper-runner.md`, The jobs](spec/keeper-runner.md#the-jobs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Keeper runner: the lending AMM's `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/96)

### SUITE-61: Keeper runner: refreshing the lending AMM's reserves

- Question: How does the runner keep a reserve fresh enough for quotes (`LENDING-95`), and whose cap pays for it?
- Answer: As a keeper job of its own on each lending AMM market, klend's `refresh_reserve` alone, due after each transaction and in every sweep when the market holds cTokens and its reserve's last refresh is more than half of `TRADE_MAX_RESERVE_AGE_SLOTS` (4,500 slots) old, unless the lending market's emergency mode is on; once one market's refresh lands, the next market on the same reserve finds it no longer due; its transaction names no market, so its fee counts in today's total and against `DAILY_CAP` but against no market's cap.
- Alternatives: A pass of its own over the reserves, which the runner would have to know about; a refresh in front of every rebalance only, which leaves a quiet market's reserve unquotable after an hour.
- Specified in: [`docs/spec/keeper-runner.md`, The jobs](spec/keeper-runner.md#the-jobs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Keeper runner: the lending AMM's `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/96)

### SUITE-62: Keeper runner: whose refusal codes count

- Question: When a job's transaction holds another program's instruction too, as the lending AMM's `rebalance` holds klend's `refresh_reserve`, which refusal codes may mean "nothing to do" or "try again in a later slot"?
- Answer: Only those the product's own program raised, told by the first "failed: custom program error" line of the logs (the innermost failing program), or without logs by the instruction the transaction error names; the same number from klend inside the product's own call to it, or from any other program (klend's errors share the 6,000 range with ours) is a failure, retried and parked like any other.
- Alternatives: Reading the code whichever program raised it, or by the failing instruction alone, which takes klend's code inside the product's own call for the product's, so a klend error that shared a number with `WithinBand` would be skipped silently instead of retried and parked.
- Specified in: [`docs/spec/keeper-runner.md`, One definition of due](spec/keeper-runner.md#one-definition-of-due)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Keeper runner: the lending AMM's `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/96)

## Engineering and security bar (BAR)

### BAR-01: Framework

- Question: Which framework are our on-chain programs written in?
- Answer: Anchor `=1.2.2`, with native code or Pinocchio only when a build ticket measures that a program cannot fit its compute budget in Anchor.
- Alternatives: Native code or Pinocchio throughout; Anchor 2.0, which waits for a stable release and for Pipeline to move.
- Specified in: [`docs/spec/README.md`, Framework and toolchain](spec/README.md#framework-and-toolchain)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-02: Toolchain pins

- Question: Which toolchain versions do we build with?
- Answer: Pipeline's own pins (Rust 1.97.1, cargo-build-sbf 4.6.0, platform tools v1.58, sBPF v3, LiteSVM 0.18.2, Kani 0.67.0), moved to match in a PR of its own whenever Pipeline moves one.
- Alternatives: Pins of our own, ahead of Pipeline's.
- Specified in: [`docs/spec/README.md`, Framework and toolchain](spec/README.md#framework-and-toolchain)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-03: Build profile and arithmetic

- Question: Which build and coding rules does every program follow?
- Answer: Overflow checks on, fat LTO and one codegen unit; checked arithmetic that returns errors, with no `unwrap`, `expect`, `panic!` or unchecked indexing; and each program built by its own manifest, never as a whole workspace.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Framework and toolchain](spec/README.md#framework-and-toolchain)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-04: Starting point

- Question: What code does each program start from?
- Answer: Each strategy starts from Pipeline's Apache-2.0 strategy template and the containment hook from its Apache-2.0 `test-hook`, with Pipeline's crates as git dependencies pinned by `rev`; the router's source, BSL 1.1 until 2028-11-08, is never copied in.
- Alternatives: Copying nothing at all from Pipeline's repo, the project's first rule; starting the hook from the Factory's fail-closed hook, which is read as a pattern instead.
- Specified in: [`docs/spec/README.md`, Starting point](spec/README.md#starting-point)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-05: Bypass

- Question: Can our strategies be called directly, without the router?
- Answer: No: `pipeline_swap` accepts only the router's market signer for that market, so every swap pays the Pipeline fee and emits a swap event.
- Alternatives: Allowing bypass, as Pipeline itself does.
- Specified in: [`docs/adr/0001-our-strategies-refuse-bypass.md`, Our strategies refuse bypass](adr/0001-our-strategies-refuse-bypass.md#our-strategies-refuse-bypass)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-06: One pricing function

- Question: How do we keep a quote equal to its swap?
- Answer: `pipeline_quote` and `pipeline_swap` call one shared pricing function.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Strategy rules](spec/README.md#strategy-rules)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-07: Tests run against the real router

- Question: Which router do the tests run against?
- Answer: The router deployed on devnet, copied by a fixture script into a gitignored folder and checked against a hash pinned in the repo, and re-pinned deliberately after an upgrade.
- Alternatives: Copying the router's source into the repo, which its licence rules out.
- Specified in: [`docs/spec/README.md`, Test layers](spec/README.md#test-layers)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-08: Integration tests

- Question: What do the integration tests cover?
- Answer: Every instruction in LiteSVM, through the router wherever it is involved, with hostile cases: a wrong or missing market signer, bypass attempts, aliased and substituted accounts, and Token-2022 mints with a transfer fee and with a transfer hook.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Test layers](spec/README.md#test-layers)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-09: Maths proofs

- Question: How is each program's maths verified?
- Answer: The maths lives in pure functions that take no accounts; Proptest runs at least 10,000 cases per property, Kani proves them (bounded by default, full-domain behind a flag), and Z3 proves division and rounding where Kani cannot.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Test layers](spec/README.md#test-layers)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-10: Invariant fuzzing

- Question: Which fuzzer checks invariants over sequences of actions?
- Answer: Proptest, generating sequences of swaps, custom actions and clock jumps against LiteSVM and checking after every step that value is conserved, that every holder can still exit and that each quote equals its swap.
- Alternatives: Trident, whose stable release cannot load Anchor 1.2 and Solana 3 and 4 crates; revisited if it moves to current crates.
- Specified in: [`docs/spec/README.md`, Test layers](spec/README.md#test-layers)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-11: Conformance

- Question: What must `pipeline-check` report for our strategies?
- Answer: Zero Fail and zero Warn, in the tests and on every devnet demo market; a Warn is accepted only with a written reason in the program's spec file.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Test layers](spec/README.md#test-layers)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-12: Compute and call-depth limits

- Question: How are compute and call depth kept in bounds?
- Answer: A compute ceiling is asserted per instruction, with headroom, and a call-depth test with hooked mints runs wherever a program calls another program inside a swap.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Test layers](spec/README.md#test-layers)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-13: Tests with outside protocols

- Question: How is a program that calls an outside protocol tested?
- Answer: In LiteSVM loaded with that protocol's programs and accounts dumped from mainnet by a fixture script pinned to a slot, and against the protocol's devnet deployment if it has one.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Test layers](spec/README.md#test-layers)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-14: Devnet demo

- Question: What must each program show on devnet?
- Answer: A script that deploys it, registers it, creates a market and swaps through the router with the TypeScript SDK, with every demo market passing `pipeline-check --fail-on-warn`.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Test layers](spec/README.md#test-layers)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-15: Our strategies pass Canary checks

- Question: What does passing Canary checks mean for our own strategies?
- Answer: No fail on any market of the version, with every warn named and explained in that product's spec; it is a gate for us and never something shown to traders.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, Outcomes](spec/pipescope-canary.md#outcomes)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### BAR-16: CI

- Question: What must pass before on-chain code merges?
- Answer: One GitHub Actions workflow: a no-keypairs check, `cargo fmt`, `clippy` with warnings denied, each program's SBF build, test layers 1 to 5 (6 once its fixtures exist) and the Kani and Z3 proofs; the tax AMM's first build ticket adds it.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, CI](spec/README.md#ci)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-17: Review tools

- Question: Which tools run the internal adversarial review?
- Answer: Stronghold of Security and Book of Knowledge from the MIT-licensed Solana Vibes Kit, the process Pipeline's router went through twice, installed in this repo at a pinned commit.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Internal adversarial review](spec/README.md#internal-adversarial-review)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-18: Hardening ticket

- Question: When is a program's internal review done?
- Answer: Each program has a hardening ticket run in a fresh session: a full audit and maths pass, a fix and a regression test for every confirmed finding, then a verify round; it is done when no Critical, High or Medium finding is open, and a Low is accepted only with the owner's written sign-off.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Internal adversarial review](spec/README.md#internal-adversarial-review)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-19: Code review, and what reviews are called

- Question: How is each build PR reviewed, and how are internal reviews described?
- Answer: Every build PR gets `/code-review` at high effort before it merges, and internal reviews are never presented as audits, in metadata or anywhere else.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Internal adversarial review](spec/README.md#internal-adversarial-review)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-20: Verified builds of our programs

- Question: How are our programs built and deployed?
- Answer: Every devnet deploy is a `solana-verify` Docker build with Pipeline's pins, recorded in `deployments/devnet.json` and checked by comparing the on-chain hash with the build's, and every program embeds a `security.txt`.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Verified builds](spec/README.md#verified-builds)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-21: Published source and licence

- Question: Is our on-chain source public, and under which licence?
- Answer: Yes: published from this repo, with the on-chain workspace under Apache-2.0; a program may be deployed on devnet while the repo is still private, and the criteria that need its public links (the metadata URI and every link in it resolving, Pipeline's hosted API reading them) are met once the repo is public.
- Alternatives: The earlier default, the repo public before the first devnet deploy; Business Source License 1.1, as Pipeline's router uses; a public mirror of only the on-chain workspace beside a private monorepo.
- Specified in: [`docs/adr/0002-on-chain-source-public-under-apache-2.md`, Our on-chain source is public under Apache-2.0](adr/0002-on-chain-source-public-under-apache-2.md#our-on-chain-source-is-public-under-apache-20)
- Changes by: spec only
- Status: changed 2026-11-19
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4); changed by the owner on 2026-11-19, relayed to [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66)

### BAR-22: Strategy metadata

- Question: What metadata does each of our strategies publish?
- Answer: Complete `pipeline-strategy-metadata/1` metadata that passes the validator with zero warnings, naming the source, the IDL and the `pipeline-check` report, committed beside the program and linked at the commit hash; `security.audits` stays empty.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Metadata, IDL and conformance report](spec/README.md#metadata-idl-and-conformance-report)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-23: Upgrade authority on devnet

- Question: Who can upgrade our programs on devnet?
- Answer: One project upgrade-authority key, kept outside the repo and separate from the wallet that pays for deploys; every program stays upgradeable and nothing is frozen on devnet while Pipeline's interfaces can still change.
- Alternatives: None recorded.
- Specified in: [`docs/spec/README.md`, Upgrade authority](spec/README.md#upgrade-authority)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-24: No exemption for our own programs

- Question: Does Aviary treat our programs differently from anyone else's?
- Answer: No: no exemption and no trusted badge; Canary checks and trust facts show them as upgradeable by a single key, exactly as they would anyone else's.
- Alternatives: A trusted badge for our own programs.
- Specified in: [`docs/spec/README.md`, Upgrade authority](spec/README.md#upgrade-authority)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-25: Default mainnet upgrade policy

- Question: What is a program's intended upgrade policy on mainnet?
- Answer: A multisig with a timelock, then frozen once stable, unless the product's spec says otherwise; carrying it out belongs to the mainnet launch effort.
- Alternatives: Frozen before any mainnet deployment, which the tax AMM, the containment hook, the buy wall AMM and the lending AMM each choose for themselves.
- Specified in: [`docs/spec/README.md`, Upgrade authority](spec/README.md#upgrade-authority)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-26: External audits

- Question: Do our programs get an external audit before their build tickets count as done?
- Answer: No: external audits belong to the mainnet launch effort, which is out of scope.
- Alternatives: An external audit per product within this effort.
- Specified in: [`docs/spec/README.md`, Engineering and security bar for on-chain programs](spec/README.md#engineering-and-security-bar-for-on-chain-programs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

### BAR-27: Hardening and the first deploy

- Question: For the tax AMM and the containment hook, which comes first, the devnet deploy or the hardening ticket?
- Answer: The deploy and registration on devnet, then the hardening ticket, which redeploys and republishes if it changes the program.
- Alternatives: Hardening first, so that the first registered bytes are already reviewed.
- Specified in: [`docs/spec/tax-amm.md`, Order of the build](spec/tax-amm.md#order-of-the-build)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### BAR-28: Where build tickets are verified

- Question: Where is each build ticket's work verified before a product's deploy ticket?
- Answer: Locally, in LiteSVM through the real router copied from devnet and by the demo script on a local validator that runs devnet's router; devnet itself comes last, in the product's devnet ticket.
- Alternatives: Deploying and registering from the first ticket and upgrading devnet at every ticket, which shows half-built versions in Pipeline's registry and can strand early demo markets.
- Specified in: [`docs/agents/build-tickets.md`, Verify](agents/build-tickets.md#verify)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### BAR-29: Pipeline's TypeScript SDK

- Question: How does our TypeScript use Pipeline's SDK, which is not on npm?
- Answer: A script clones Pipeline at the pinned commit into a gitignored folder and builds the SDK there; it is never copied into the repo.
- Alternatives: A git dependency, which cannot build it.
- Specified in: [the ticket, Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### BAR-30: The on-chain workspace's layout

- Question: Where do our programs, their fixtures and their scripts live in the repo?
- Answer: One Cargo workspace at `programs/`, laid out as Pipeline lays out its own, with each program in `programs/<crate>` beside its metadata and demo script, fetched fixtures in a gitignored `fixtures/` at the root, and all TypeScript in one pnpm workspace at the root.
- Alternatives: A Cargo workspace at the repo root; demo scripts in a TypeScript folder away from their programs.
- Specified in: [`docs/toolchain.md`, Layout](toolchain.md#layout)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58)

### BAR-31: Where Pipeline's commit is pinned

- Question: Where is the Pipeline commit our code builds against pinned?
- Answer: Once, as the `rev` of Pipeline's crates in `programs/Cargo.toml`, which the script that clones Pipeline for its SDK and test programs reads.
- Alternatives: A second pin in that script.
- Specified in: [`docs/toolchain.md`, Layout](toolchain.md#layout)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58)

### BAR-32: When the devnet router changes

- Question: What happens to the tests and to CI when the devnet router is upgraded?
- Answer: The fixture script refuses any dump whose SHA-256 differs from `ROUTER_SHA256` in `fixtures/pins.env` and keeps the pinned copy, and CI dumps the router on every run, so an upgrade fails the on-chain jobs until a PR of its own re-pins it after the tests pass against the new bytes.
- Alternatives: CI caching the fixture, which would leave an upgrade unnoticed; the hash written in the script itself.
- Specified in: [`docs/toolchain.md`, Fixtures](toolchain.md#fixtures)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58)

### BAR-33: The local validator

- Question: What does the local validator for demo runs hold?
- Answer: Devnet's router from the pinned fixture bytes, with its config account as devnet has it and nobody able to upgrade it, and every program of the workspace at its `declare_id!` address, upgradeable by the project upgrade authority, from an empty ledger each time and with SIMD-0268 off as on devnet.
- Alternatives: Cloning the router from devnet at start-up, whose bytes the pin would not check; building the router in a scratchpad clone and initialising a config of our own.
- Specified in: [`docs/toolchain.md`, Local demo run](toolchain.md#local-demo-run)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58)

### BAR-34: CI's required check

- Question: How can CI be a required check when most pull requests touch no on-chain code?
- Answer: One `gate` job is the only required check: it always runs, and passes only if the no-keypair check passed and, when on-chain code changed, the Rust, TypeScript and Kani jobs passed, which are skipped otherwise.
- Alternatives: Every job required, which a pull request without on-chain changes could never satisfy; a `paths` filter on the whole workflow, which would give such a pull request no result at all.
- Specified in: [`docs/toolchain.md`, CI](toolchain.md#ci)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58)

### BAR-35: Who may bypass the required check

- Question: Can anyone merge or push to `main` without the gate passing?
- Answer: Only repository admins, through the ruleset's bypass, so that a history rewrite can still be force-pushed; sessions never use it to merge a pull request whose CI is red.
- Alternatives: No bypass, with the ruleset switched off for a rewrite; classic branch protection, which blocks force-pushes for admins too.
- Specified in: [`docs/toolchain.md`, CI](toolchain.md#ci)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58)

### BAR-36: How the review skills are installed

- Question: How are Stronghold of Security and Book of Knowledge installed and kept at their pin?
- Answer: Copied into `.claude/` at commit `969c43d` by `scripts/install-review-skills.sh`, exactly as the kit's own installers copy them but without running the kit's code or keeping the file that has the skills offer updates; the pin moves only through that script, in a PR of its own.
- Alternatives: Running the kit's install scripts, which leave a file pointing at a temporary clone and have the skills offer updates.
- Specified in: [`docs/toolchain.md`, Review skills](toolchain.md#review-skills)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58)

### BAR-37: The security policy page

- Question: What do our programs' `security.txt` and metadata name as their security policy?
- Answer: `SECURITY.md` at the repo root, which GitHub shows as the repository's security policy: reports go through private vulnerability reporting, and it says that no program has had an external audit.
- Alternatives: No policy page, which `security.txt` does not allow.
- Specified in: [`SECURITY.md`, Security policy](../SECURITY.md#security-policy)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58)

### BAR-38: Test programs in the workspace

- Question: Where do test-only programs, such as the stand-in launchpad the seeding tickets share, live, and how are they kept off devnet?
- Answer: In `programs/test-programs/`, as workspace members marked `test-program` in their manifests, which `scripts/workspace-programs.py` leaves out of the deployable programs, `scripts/build-programs.sh` builds into the gitignored `fixtures/test-programs`, and `scripts/local-validator.sh` loads frozen; no deploy script names one.
- Alternatives: A separate Cargo workspace, which would repeat the pins; building them into `programs/target/deploy` beside the programs that are deployed.
- Specified in: [`docs/toolchain.md`, Layout](toolchain.md#layout)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: seeding from another program](https://github.com/imDev2023/testing-pipeline/issues/63)

### BAR-39: Where CI runs

- Question: Where do CI's jobs run while GitHub's included Actions minutes for a private repository are used up?
- Answer: On two runner containers on the owner's iMac (`scripts/ci-runner/`), chosen by the repository variable `CI_RUNS_ON`; with the variable unset, both workflows run on GitHub's runners again.
- Alternatives: A paid Actions budget; making the repository public, where GitHub's runners cost nothing, after the privacy purge; a runner on macOS itself, which would see the Mac's files and keys and differ from GitHub's Ubuntu image.
- Specified in: [`docs/toolchain.md`, CI on the owner's iMac](toolchain.md#ci-on-the-owners-imac)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-13 in [Buy wall AMM: seeding by another program](https://github.com/imDev2023/testing-pipeline/issues/53)

### BAR-40: Test builds optimize their dependencies

- Question: How do the stateful invariant fuzzers send enough transactions for their runs in CI and on a laptop?
- Answer: Host test builds optimize every dependency, LiteSVM and the SBF VM among them, and none of our own crates (`[profile.dev.package."*"] opt-level = 3`), which makes a fuzzed sequence about fifty times faster; CI's cargo cache is keyed on the workspace manifest too, so the profile is built once.
- Alternatives: Running the fuzzers in a release build, which fat LTO makes slow to compile; a separate CI job with its own profile flags, which a plain `cargo test` would not match; fewer sequences than the tickets ask.
- Specified in: [`docs/toolchain.md`, Build and test](toolchain.md#build-and-test)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: invariant fuzzing across every instruction](https://github.com/imDev2023/testing-pipeline/issues/65)

### BAR-41: Where our custom actions are described

- Question: Where does a strategy's metadata describe its custom actions, now that Pipeline 0.2.0 dropped them from its metadata standard and SDK?
- Answer: Under a top-level key of our own, `aviary_actions`, in the shape Pipeline's `actions` section had, which Pipeline's validator allows with no warning; the `strategy-actions` package, written for this repo on the public functions Pipeline's SDK still exports, validates it and builds each action into an instruction, for every demo script and for Aviary's action forms.
- Alternatives: Dropping action descriptions from the metadata and building each product's instructions from its IDL client, which Pipeline's direction suggests but which replaces Aviary's generic forms; keeping `actions` and accepting the validator's warning, against `BAR-22`.
- Specified in: [`docs/spec/README.md`, Metadata, IDL and conformance report](spec/README.md#metadata-idl-and-conformance-report)
- Changes by: spec only
- Status: default
- Decided: 2026-11-19 in [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66)

### BAR-42: How a program is deployed to devnet

- Question: How does a program of ours get from a commit to devnet, so that the deploy can be checked and repeated?
- Answer: One script for every program, `scripts/deploy-devnet.sh <program>`: it refuses any cluster but devnet or a local validator, and on devnet any commit not on `origin/main` or a worktree with changes; it builds that commit, exported with `git archive`, with solana-verify in the Docker image pinned in `fixtures/pins.env` and `--arch v3`; it deploys paid by `wallet.json` with `upgrade-authority.json` as the upgrade authority, on devnet sending its writes to the validators over TPU, resending dropped ones and paying a priority fee, the transport, the resends and the fee each named at the top of the script; it stops unless the cluster's program hash equals the build's and the upgrade authority is that key; and it records the program id, the hash, the commit, the image, the authority, the payer and the slot under the program's name in `deployments/devnet.json`, keeping the program's earlier deploys in its `history`.
- Alternatives: The earlier default, sending the writes through the RPC with `--use-rpc`, which public devnet dropped (2026-11-19 and 2026-11-20); Each program's devnet ticket writing its own deploy steps; building in the worktree, where an uncommitted file could reach the bytes; letting solana-verify choose the image without recording which.
- Specified in: [`docs/toolchain.md`, Deploy to devnet](toolchain.md#deploy-to-devnet)
- Changes by: spec only
- Status: changed 2026-11-20
- Decided: 2026-11-16 in [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66)

### BAR-43: The daily router pin check

- Question: How is an upgrade of Pipeline's devnet router noticed when no PR happens to run the on-chain jobs?
- Answer: A scheduled workflow, `.github/workflows/router-pin.yml`, runs `scripts/fetch-router.sh` once a day at 06:17 UTC (and on demand); when devnet's router no longer matches `ROUTER_SHA256` the script exits 3, the run fails and it opens an issue titled "Devnet's Pipeline router no longer matches the pin", or comments on the one already open; a failed download fails the run but opens no issue.
- Alternatives: Waiting for the next PR's on-chain jobs, which let 0.3.0 go unnoticed until a PR failed; a failed scheduled run alone, whose e-mail reaches only whoever last edited the schedule; checking more often, which a router upgraded without notice a few times a month does not need.
- Specified in: [`docs/toolchain.md`, Fixtures](toolchain.md#fixtures)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Pipeline 0.3: re-pin the router, SDK and pipeline-check, adapt every program and Canary, and check the pin daily](https://github.com/imDev2023/testing-pipeline/issues/194)

### BAR-44: Which mint our strategies take Pipeline's fee in

- Question: Since Pipeline 0.3 lets a strategy declare its market's fee mint in `pipeline_market_info`, which do ours declare?
- Answer: None: the tax AMM, the buy wall AMM and the lending AMM return a bare `MarketInfo`, so the router's own rule applies, wrapped SOL on every market that trades it (a sell pays Pipeline's 0.25% out of the SOL it brings back) and the input on any other market; each market keeps the fee mint recorded when the router recorded it, and our two devnet demo markets were migrated with wrapped SOL as their fee mint.
- Alternatives: Declaring the quote mint, so a tax AMM market quoted in USDC also takes the fee in USDC and a contained token never moves into its fee account; declaring the token, which would pay Pipeline in tokens that are hard to sell.
- Specified in: [`docs/spec/README.md`, Strategy rules](spec/README.md#strategy-rules)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-22 in [Pipeline 0.3: re-pin the router, SDK and pipeline-check, adapt every program and Canary, and check the pin daily](https://github.com/imDev2023/testing-pipeline/issues/194)

### BAR-45: One publishing tool for every program

- Question: How do the programs pin and verify the metadata they publish for a devnet deploy, now that a third program needs the same steps?
- Answer: With one shared tool, `packages/strategy-publish` for pinning and verifying and `programs/published-check` for the checks each program's `tests/published.rs` runs, each program naming only its folder, its name and its IDL; the tax AMM's and the buy wall AMM's copies moved onto it unchanged in behaviour.
- Alternatives: A third copy of `publish.ts` and `tests/published.rs` with only the names changed, as the buy wall AMM made of the tax AMM's.
- Specified in: [`docs/toolchain.md`, Deploy to devnet](toolchain.md#deploy-to-devnet)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87)

### BAR-46: Dependency advisories

- Question: How do we hear of a known vulnerability in a Rust crate our programs, tests or Canary depend on?
- Answer: A workflow of its own runs `cargo audit` on every tracked `Cargo.lock` and `pnpm audit --prod` on `pnpm-lock.yaml` when a lock file changes, every day and on demand, failing on any vulnerability or unsound advisory, only reporting unmaintained crates, which come through Solana's and LiteSVM's own dependencies, and opening an issue when a daily run fails.
- Alternatives: A step in `ci.yml`, which would check only when on-chain code changed and never on a quiet day; `cargo deny` with a licence and source policy as well, more than this finding asked for; failing on unmaintained crates, which would fail every run on crates we do not choose.
- Specified in: [`docs/toolchain.md`, CI](toolchain.md#ci)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

## Aviary, the terminal (PIPESCOPE)

### PIPESCOPE-01: What the first version is

- Question: What does Aviary's first version do?
- Answer: It is a web terminal on devnet with a live feed and charts of every strategy and market, trading through the router, the strategies' custom-action forms, and Canary results and an explanation for each strategy version.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope.md`, What the first version is](spec/pipescope.md#what-the-first-version-is)
- Changes by: spec only
- Status: confirmed 2026-11-09
- Decided: 2026-11-09 in [Record MetalLegBob's answers to the outreach](https://github.com/imDev2023/testing-pipeline/issues/5)

### PIPESCOPE-02: Pages

- Question: Which pages does the first version have?
- Answer: Six (feed, market, strategy, wallet, create market and search) and two short static pages, Fees and Devnet help.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope.md`, Pages](spec/pipescope.md#pages)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-03: Left out of the first version

- Question: What is left out of the first version?
- Answer: A token page across markets, watchlists, alerts, leaderboards, launching a new token, registering a strategy, routing across markets, multi-hop and exact-out swaps, USD prices, a faucet and a native app.
- Alternatives: Including any of them in the first version.
- Specified in: [`docs/spec/pipescope.md`, Pages](spec/pipescope.md#pages)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-04: Listing

- Question: Which strategies and markets does Aviary list?
- Answer: Every registered strategy and every market: nothing is curated or hidden, because hiding a market is a judgement.
- Alternatives: A curated list; hiding markets.
- Specified in: [`docs/spec/pipescope.md`, Listing](spec/pipescope.md#listing)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-05: Feed order and filters

- Question: How is the feed ordered and filtered?
- Answer: Newest first, with filters for liquidity, volume, age and Pipeline's trust flags that all start off, so the default feed lists everything.
- Alternatives: Filters that start on.
- Specified in: [`docs/spec/pipescope.md`, Listing](spec/pipescope.md#listing)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-06: Broken metadata and stranded markets

- Question: What happens to a strategy with broken metadata, or a market its strategy can no longer read?
- Answer: Both stay listed: the strategy under its program address with "Metadata unavailable" and no forms, and the market with the fact that the current version cannot read it.
- Alternatives: Hiding them.
- Specified in: [`docs/spec/pipescope.md`, Listing](spec/pipescope.md#listing)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-07: What a trade can be

- Question: Which swaps can a trader make?
- Answer: One market, one hop, exact-in only, between any two of the market's mints, with SOL wrapped and unwrapped for the trader.
- Alternatives: Routing across markets; multi-hop swaps; exact-out swaps.
- Specified in: [`docs/spec/pipescope.md`, Trading](spec/pipescope.md#trading)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-08: Default slippage

- Question: What is the default slippage?
- Answer: 1%, which the trader can change.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-screens.md`, One place for every value](spec/pipescope-screens.md#one-place-for-every-value)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-09: Simulation before every signature

- Question: Is a transaction checked before the wallet is asked to sign?
- Answer: Yes: every swap, custom action and market creation is simulated first, and a failed simulation shows the error and keeps the sign button off.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope.md`, Simulate before every signature](spec/pipescope.md#simulate-before-every-signature)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-10: Integrator fee rate

- Question: What integrator fee does Aviary charge?
- Answer: 0.5% (50 basis points), one rate for every market, which with Pipeline's 0.25% makes 0.75% in all.
- Alternatives: No fee while we build trust; 1%, the rate usual among terminals.
- Specified in: [`docs/spec/pipescope.md`, The integrator fee](spec/pipescope.md#the-integrator-fee)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-11: Fee mints

- Question: On which swaps is the integrator fee charged?
- Answer: Only when the trader pays in a fee mint, SOL or USDC; a swap paying with any other mint carries no integrator fee, so Aviary earns mostly on buys.
- Alternatives: A fee in every mint, which costs rent for each fee account, piles up tokens that are hard to sell and can make sells of hooked tokens fail.
- Specified in: [`docs/spec/pipescope.md`, The integrator fee](spec/pipescope.md#the-integrator-fee)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-12: Fee wallet

- Question: Where do the integrator fees go?
- Answer: Into a dedicated fee wallet that Aviary knows only by address, separate from the suite treasury that receives the suite share; its key is never on a server.
- Alternatives: One treasury for the whole suite.
- Specified in: [`docs/spec/pipescope.md`, The integrator fee](spec/pipescope.md#the-integrator-fee)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-13: How the fee settings change

- Question: How are the fee rate, the fee mints and the fee wallet changed?
- Answer: They are vars of the `terminal-api` Worker per environment in its `wrangler.jsonc`, so they change by a configuration deploy with no code change, and the API returns the rate it built each swap with.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, The integrator fee's configuration](spec/pipescope-architecture.md#the-integrator-fees-configuration)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-14: How the fee is shown

- Question: How does a trader see the fees before signing?
- Answer: The trade box always shows the breakdown, never collapsed, in token amounts and percentages (Pipeline's fee, Aviary's fee, the strategy's own fees as included in the quote, the expected and minimum output); the swap is built from exactly the rate on screen, and a public Fees page states the rate.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope.md`, How the fee is shown before signing](spec/pipescope.md#how-the-fee-is-shown-before-signing)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-15: Wallets and devices

- Question: Which wallets and devices are supported?
- Answer: Any Solana Wallet Standard wallet through `@solana/kit`, desktop first and working down to phone width, in wallets' in-app browsers and through Mobile Wallet Adapter on Android.
- Alternatives: A native app.
- Specified in: [`docs/spec/pipescope.md`, Wallets and devices](spec/pipescope.md#wallets-and-devices)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-16: Facts panel

- Question: How does Aviary describe a strategy's and a market's facts?
- Answer: As neutral facts with no verdicts, using Pipeline's trust flags and their fixed descriptions, beside liquidity, market age and volume.
- Alternatives: Verdicts.
- Specified in: [`docs/spec/pipescope.md`, Facts and Canary results](spec/pipescope.md#facts-and-canary-results)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-17: How Canary results are shown

- Question: How does a trader see Canary results?
- Answer: Each result states what was tested and what happened, in numbers, with the strategy version and the date; there is no overall score, no safe or unsafe badge and no green or red, and the results a trader most needs come first, plainly worded.
- Alternatives: Verdict badges, which read like a promise of safety these checks cannot give.
- Specified in: [`docs/spec/pipescope.md`, Facts and Canary results](spec/pipescope.md#facts-and-canary-results)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-18: A failed exit test in the trade box

- Question: What does the trade box do when Canary saw that a buyer could not sell back?
- Answer: It repeats that fact above the swap button and the trader ticks one box to say they have read it; the trade is never blocked.
- Alternatives: Blocking the trade.
- Specified in: [`docs/spec/pipescope.md`, A failed exit test in the trade box](spec/pipescope.md#a-failed-exit-test-in-the-trade-box)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-19: After a strategy is upgraded

- Question: What do pages show after a strategy is upgraded?
- Answer: Results for the newest strategy version only, with a notice that tests and explanation for this version are pending until they exist; older versions' results stay in the version history, labelled as such.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope.md`, When a strategy is upgraded](spec/pipescope.md#when-a-strategy-is-upgraded)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-20: Which forms are rendered

- Question: Which custom-action and create-market forms does Aviary render?
- Answer: Every `actions` form and the `init` form from any strategy's metadata, through the SDK's generic builders, not limited to strategies we have reviewed.
- Alternatives: Forms only for strategies we have reviewed; no forms in the first version.
- Specified in: [`docs/spec/pipescope.md`, Custom-action and create-market forms](spec/pipescope.md#custom-action-and-create-market-forms)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-21: Strategy metadata is untrusted

- Question: How does Aviary treat what a strategy's metadata says?
- Answer: As untrusted user content: validated with Pipeline's parser, labels shown as plain text, links with their full domain, each form showing the program, the instruction and every account it touches, and the simulation showing how the wallet's balances would change.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope.md`, Custom-action and create-market forms](spec/pipescope.md#custom-action-and-create-market-forms)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-22: Token names

- Question: How are tokens named?
- Answer: By each mint's on-chain token metadata, always with the mint's short address beside it; Aviary names only SOL and USDC itself and gives no other token a verified mark.
- Alternatives: A verified mark for tokens we recognise.
- Specified in: [`docs/spec/pipescope.md`, Tokens and prices](spec/pipescope.md#tokens-and-prices)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-23: Prices

- Question: In what are prices and charts shown?
- Answer: In the market's own mints, for example a token priced in SOL; there are no USD prices on devnet.
- Alternatives: USD prices, which arrive with mainnet.
- Specified in: [`docs/spec/pipescope.md`, Tokens and prices](spec/pipescope.md#tokens-and-prices)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### PIPESCOPE-24: Platform

- Question: Where does Aviary run?
- Answer: On the owner's existing Cloudflare account, as two Workers: `terminal-api` (the API, the indexer, live rooms, Canary's Container and the crons) and `terminal-web` (the web app); nothing was bought, since Workers Paid was already active.
- Alternatives: A second platform such as Vercel or Fly.io, which means a second bill and a second place to keep secrets.
- Specified in: [`docs/spec/pipescope-architecture.md`, Where each part runs](spec/pipescope-architecture.md#where-each-part-runs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-25: System of record

- Question: Where does Aviary keep its data?
- Answer: In its own Postgres on a new Neon free project, reached through Hyperdrive with its query cache off, as the only system of record; D1 and R2 are not used.
- Alternatives: D1, which a mainnet terminal that keeps trades forever would outgrow.
- Specified in: [`docs/adr/0004-postgres-on-neon-is-pipescopes-record.md`, Postgres on Neon is Aviary's only system of record](adr/0004-postgres-on-neon-is-pipescopes-record.md#postgres-on-neon-is-aviarys-only-system-of-record)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-26: Where the data comes from

- Question: Does Aviary index Pipeline itself or read Pipeline's hosted API?
- Answer: It runs its own indexer on the router and every registered strategy program, with reconciliation, registry snapshots, a ProgramData watch and a full backfill; Pipeline's hosted devnet API is only a parity check in the tests.
- Alternatives: Reading trades and candles from Pipeline's hosted API, which misses strategy upgrades, custom actions and bypass swaps; Helius webhooks; LaserStream, the paid upgrade for mainnet.
- Specified in: [`docs/adr/0003-pipescope-indexes-pipeline-itself.md`, Aviary indexes Pipeline itself](adr/0003-pipescope-indexes-pipeline-itself.md#aviary-indexes-pipeline-itself)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-27: Live socket only while someone watches

- Question: When does the indexer hold its live socket open?
- Answer: Only while at least one browser is connected to a live room, closing a few minutes after the last one leaves; otherwise a cron each minute keeps it up to date.
- Alternatives: An always-open socket, which would push the Cloudflare account shared with Top-pad past its Durable Object allowance.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-28: Indexer timings

- Question: How often does the indexer reconcile and check?
- Answer: Reconciliation every minute for the router and every five minutes for strategy programs, a registry snapshot every 10 minutes, a ProgramData watch every minute, and a 15 second alarm that reopens a dropped socket.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-29: RPC provider

- Question: Which RPC does Aviary use?
- Answer: Its own free Helius key, kept as the secret `RPC_URL`, separate from the owner's shared key; paid plans such as LaserStream belong to the mainnet effort.
- Alternatives: The owner's shared Helius key, which is already rate-limited when several sessions run.
- Specified in: [`docs/spec/pipescope-architecture.md`, Platform and plans](spec/pipescope-architecture.md#platform-and-plans)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-30: Candles

- Question: Which candles are kept, and for how long?
- Answer: Lengths of 1 s, 15 s, 1 m, 5 m, 15 m, 1 h, 4 h and 1 d per market and mint pair; 1 s candles are kept 7 days, 15 s candles 30 days, and coarser candles and all trades forever.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, Candles](spec/pipescope-architecture.md#candles)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-31: Live updates

- Question: How do pages update live?
- Answer: Through one live room per market and one for the feed, holding hibernating browser WebSockets and batching every 100 ms.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, Live rooms](spec/pipescope-architecture.md#live-rooms)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-32: Public API

- Question: Who can use Aviary's API?
- Answer: Anyone: the read and prepare endpoints are open with no key and any origin, behind a per-IP rate limit, and labelled unstable until v1 ships.
- Alternatives: Locking the API to our web app's origin.
- Specified in: [`docs/spec/pipescope-architecture.md`, API](spec/pipescope-architecture.md#api)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-33: Trading path

- Question: Who builds and checks the transaction a trader signs?
- Answer: The API prepares the unsigned transaction with Pipeline's SDK, resolving transfer-hook accounts with our own code, simulates that exact transaction and returns it with the outcome; the wallet signs and sends it, and the page reports the signature so the trade shows at once.
- Alternatives: Pipeline's hosted API to build swaps, which refuses input mints with a transfer hook.
- Specified in: [`docs/spec/pipescope-architecture.md`, Trading path](spec/pipescope-architecture.md#trading-path)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-34: Quotes while typing

- Question: Where do trade-box quotes come from?
- Answer: From an RPC simulation of the strategy's `pipeline_quote` through the SDK, asked through the API; the Container quoter is never on the trading path.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, Trading path](spec/pipescope-architecture.md#trading-path)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-35: Verified builds of other people's strategies

- Question: How does Aviary decide a strategy's source is verified?
- Answer: It runs `solana-verify` itself in a GitHub Actions workflow with an untrusted build job and a trusted compare job, and counts the source as evidence only when the hashes match; a match is evidence, never proof.
- Alternatives: Leaving verified builds out of the first version; OtterSec's hosted check, which does not cover devnet.
- Specified in: [`docs/spec/pipescope-architecture.md`, Verified builds](spec/pipescope-architecture.md#verified-builds)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-36: Fetching metadata

- Question: When and how is strategy metadata fetched?
- Answer: On `StrategyRegistered`, on `MetadataUpdated`, when the registry snapshot finds a strategy, and every hour, over `https:` only, at most 64 KB, of the type `application/json`, any `+json` type or `text/plain` (as GitHub serves raw files and gists), with a 5 second timeout and at most 3 redirects, each to `https:`, never fetching a URL found inside the document.
- Alternatives: The earlier default, any JSON content type, which refused `text/plain` and so the documents GitHub serves, most of devnet's and all three of ours; no content-type check, as Pipeline's SDK has none.
- Specified in: [`docs/spec/pipescope-architecture.md`, Metadata fetcher](spec/pipescope-architecture.md#metadata-fetcher)
- Changes by: build-time constant
- Status: changed 2026-11-23
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13); changed 2026-11-23 in [Aviary: strategy metadata, trust facts and the facts panel, with the feed's filters](https://github.com/imDev2023/testing-pipeline/issues/119)

### PIPESCOPE-37: Keys and paid calls on the server

- Question: What secrets and paid services does the deployed terminal hold?
- Answer: No private keys at all and no LLM key: its only secrets are the RPC URL and a GitHub token limited to this repo's Actions, and nothing paid runs from Cloudflare.
- Alternatives: An LLM key in Cloudflare's Secrets Store, bound to the API Worker.
- Specified in: [`docs/spec/pipescope-architecture.md`, Where each part runs](spec/pipescope-architecture.md#where-each-part-runs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-38: Web and API stack

- Question: What are the web app and the API built with?
- Answer: Next.js 16 on Workers through OpenNext as a pure client of the API, Hono with a zod contract for the API, Drizzle on Postgres, and TradingView Lightweight Charts v5.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, The two Workers](spec/pipescope-architecture.md#the-two-workers)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-39: Code copied from Top-pad

- Question: Which parts start from Top-pad's code?
- Answer: The indexer core and its Durable Object, candles, live rooms, the database package, the API and web scaffolds, the Container pattern, the Playwright setup and the restart test, copied at commit `b833a7b` with a header naming their source and owned here; its Codama clients and keeper Workflows are not copied.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, Copied from Top-pad](spec/pipescope-architecture.md#copied-from-top-pad)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-40: Environments

- Question: Where is Aviary deployed?
- Answer: Locally with `wrangler dev` against devnet, and on devnet as two Workers on `workers.dev`; the custom domain is attached once the owner has registered it.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, Environments](spec/pipescope-architecture.md#environments)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-41: Repo layout

- Question: Where does the terminal's code live in the repo?
- Answer: In `apps/terminal-api` and `apps/terminal-web`, `packages/terminal-db` and `packages/terminal-indexer`, `crates/canary` in the root Rust workspace, and `tests/terminal-e2e` and `tests/devnet`.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, Repo layout](spec/pipescope-architecture.md#repo-layout)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### PIPESCOPE-42: Telegram bot: how a trade is signed

- Question: How does a trader sign a trade that starts in the Telegram bot, given the bot never holds keys?
- Answer: Through a link that opens Aviary's trade box with the swap filled in, where the trader's own wallet signs.
- Alternatives: A Mini App inside Telegram, which needs a second way to connect wallets; a link that opens the wallet with the transaction ready, where Aviary's fee breakdown and exit-test notice could not be guaranteed to appear.
- Specified in: [`docs/adr/0007-telegram-trades-are-signed-in-aviarys-trade-box.md`, A trade that starts in Telegram is signed in Aviary's own trade box](adr/0007-telegram-trades-are-signed-in-aviarys-trade-box.md#a-trade-that-starts-in-telegram-is-signed-in-aviarys-own-trade-box)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-43: Telegram bot: what the first version does

- Question: What does the Telegram bot do in its first version?
- Answer: Lookups of markets and strategies, trade links and alerts.
- Alternatives: Lookups and trade links only; alerts only.
- Specified in: [`docs/spec/pipescope-telegram.md`, First version](spec/pipescope-telegram.md#first-version)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-44: Telegram bot: alerts

- Question: Which events does the bot alert on?
- Answer: New listings, and changes to the markets and strategies a chat is watching.
- Alternatives: New listings only; watched changes only.
- Specified in: [`docs/spec/pipescope-telegram.md`, What is sent](spec/pipescope-telegram.md#what-is-sent)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-45: Telegram bot: where it works

- Question: In which kinds of chat does the bot work?
- Answer: Private chats and groups; in a group anyone can look things up, and only its admins can change its alerts and its watch list.
- Alternatives: Private chats only; private chats, groups and inline mode.
- Specified in: [`docs/spec/pipescope-telegram.md`, Private chats and groups](spec/pipescope-telegram.md#private-chats-and-groups)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-46: Telegram bot: choosing the amount

- Question: Where does a trader choose the amount after tapping Buy or Sell in the bot?
- Answer: On Aviary's page.
- Alternatives: Preset amount buttons in Telegram; commands only.
- Specified in: [`docs/spec/pipescope-telegram.md`, Buy, Sell and Trade](spec/pipescope-telegram.md#buy-sell-and-trade)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-47: Telegram bot: fee and before-signing rules

- Question: Do Aviary's fee and before-signing rules change for trades that start in the bot?
- Answer: No: they apply unchanged, and the exit-test notice is repeated in the bot's market card.
- Alternatives: The same rules with a shorter card that leaves the notice out; a different fee for bot trades.
- Specified in: [`docs/spec/pipescope-telegram.md`, Trading from Telegram](spec/pipescope-telegram.md#trading-from-telegram)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-48: Telegram bot: when a new market is announced

- Question: When does the bot send its alert for a new market?
- Answer: After the market's first Canary run, so the alert carries its results, or after 5 minutes if that run has not finished, then saying tests are pending.
- Alternatives: At once, then edited; at once, with the results as a reply.
- Specified in: [`docs/spec/pipescope-telegram.md`, What is sent](spec/pipescope-telegram.md#what-is-sent)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-49: Telegram bot: wallets

- Question: Does the bot's first version know anything about a trader's wallet?
- Answer: No: it has no wallet features.
- Alternatives: Lookups by a pasted address; linking an address for alerts.
- Specified in: [`docs/spec/pipescope-telegram.md`, First version](spec/pipescope-telegram.md#first-version)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-50: Telegram bot: explanations

- Question: Does the bot show the explainer's account of a strategy version?
- Answer: Yes: the summary, with its AI label.
- Alternatives: A link only; the full explanation in the chat.
- Specified in: [`docs/spec/pipescope-telegram.md`, The explanation](spec/pipescope-telegram.md#the-explanation)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-51: Telegram bot: public channel

- Question: Does Aviary also run a public Telegram channel?
- Answer: Yes: an unfiltered channel that posts every new strategy and market.
- Alternatives: No channel; deciding at mainnet.
- Specified in: [`docs/spec/pipescope-telegram.md`, The channel](spec/pipescope-telegram.md#the-channel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-52: Telegram bot: its handle on devnet

- Question: Which bot does the build use on devnet before the public handle exists?
- Answer: A private working bot and a private working channel under throwaway handles, neither announced; moving to the public ones changes two vars and a secret.
- Alternatives: Picking the public handle at once.
- Specified in: [`docs/spec/pipescope-telegram.md`, Name and handles](spec/pipescope-telegram.md#name-and-handles)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-53: Telegram bot: when it is built

- Question: When is the bot built, relative to the web terminal?
- Answer: Alongside the web pages.
- Alternatives: After the terminal ships; only before mainnet.
- Specified in: [`docs/spec/pipescope-telegram.md`, When it is built](spec/pipescope-telegram.md#when-it-is-built)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-54: Telegram bot: the trade link

- Question: What does a trade link from the bot carry?
- Answer: The market page's address with the input mint, the output mint and, optionally, an amount, and nothing else: no Telegram account, no chat and no tracking id.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-telegram.md`, The trade link](spec/pipescope-telegram.md#the-trade-link)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-55: Telegram bot: on a phone

- Question: How does a trader reach a wallet from Telegram's in-app browser, which has none?
- Answer: Aviary's market page, when it finds no wallet on a phone, offers to reopen the same address inside Phantom, Solflare or Backpack through each wallet's browse link, for every phone visitor.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-telegram.md`, On a phone](spec/pipescope-telegram.md#on-a-phone)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-56: Telegram bot: upgrade alerts

- Question: When is a strategy upgrade announced?
- Answer: At once, saying tests and the explanation for the new version are pending, with the Canary results following as a reply when the run ends.
- Alternatives: Waiting for the new version's Canary run, as a new market's alert does.
- Specified in: [`docs/spec/pipescope-telegram.md`, What is sent](spec/pipescope-telegram.md#what-is-sent)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-57: Telegram bot: a chat's own alerts

- Question: Which alerts does a chat get without asking?
- Answer: None: new-strategy and new-market alerts are off until the chat turns them on, its filters (a minimum liquidity, Pipeline's trust flags) all start off, and a watch list of strategies and markets sends their upgrades and changed Canary outcomes.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-telegram.md`, A chat's own alerts](spec/pipescope-telegram.md#a-chats-own-alerts)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-58: Telegram bot: commands

- Question: Which commands does the bot have?
- Answer: `/start`, `/help`, `/market`, `/strategy`, `/search`, `/new`, `/buy`, `/sell`, `/watch`, `/unwatch`, `/watching`, `/alerts`, `/fees` and `/stop`; in a private chat a message that is not a command is treated as a search.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-telegram.md`, Commands](spec/pipescope-telegram.md#commands)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-59: Telegram bot: how results are worded

- Question: How does the bot word Canary results?
- Answer: With the outcome words only, each with its number and its reason, the strategy version and the date; no score, no badge, and no coloured or tick-and-cross emoji standing in for an outcome.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-telegram.md`, How results are worded](spec/pipescope-telegram.md#how-results-are-worded)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-60: Telegram bot: untrusted text

- Question: How does the bot keep a strategy's or a token's name from becoming a link or a command in a message?
- Answer: One function builds every message as text with explicit entities and no parse mode; author text is normalised and always sits inside a `code` entity with the address beside it, message text never contains a link, and link previews are off.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-telegram.md`, Untrusted text in messages](spec/pipescope-telegram.md#untrusted-text-in-messages)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-61: Telegram bot: against impersonation

- Question: How does the bot set itself apart from copies that ask for a seed phrase?
- Answer: It never asks for a private key, a seed phrase or a wallet address and has no command or button that accepts one, it never messages first, every link it sends goes to Aviary's own origin, and Aviary's site names the official bot and channel.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-telegram.md`, Safety against impersonation](spec/pipescope-telegram.md#safety-against-impersonation)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-62: Telegram bot: where it runs

- Question: Where does the bot run?
- Answer: Inside `terminal-api`, with no service of its own: a webhook route that Telegram calls, a Cloudflare Queue for alerts, and `packages/terminal-telegram` for the pure message building; nothing is bought.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-telegram.md`, Where it runs](spec/pipescope-telegram.md#where-it-runs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-63: Telegram bot: what it stores

- Question: What does the bot store about a chat?
- Answer: Only Telegram's chat id, whether it is a private chat or a group, its alert settings and its watch list; no user id, name or message text and no wallet address, and `/stop` deletes it at once.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-telegram.md`, What the bot stores](spec/pipescope-telegram.md#what-the-bot-stores)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-64: Telegram bot: limits

- Question: Which limits does the bot keep?
- Answer: A watch list of 100 a chat, 20 lookups a minute a chat, lists of 10 entries and a 5-minute wait for a new market's first Canary run, each in the config module of `packages/terminal-telegram`.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-telegram.md`, One place for every value](spec/pipescope-telegram.md#one-place-for-every-value)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32)

### PIPESCOPE-65: Screens: who is speaking

- Question: How does a reader tell a chain fact from an AI's sentence from an author's claim?
- Answer: By how the text is set: plainly for what Aviary read or measured, in a serif for AI-written text, and in purple italic for an author's words (a strategy's name and description, form labels, a token's symbol and name), a name always with its short address beside it.
- Alternatives: One style for everything with small source labels; an icon for each source.
- Specified in: [`docs/spec/pipescope-screens.md`, Who is speaking](spec/pipescope-screens.md#who-is-speaking)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-66: Screens: Canary outcomes without colour

- Question: How is a Canary outcome shown when there is no score, no badge and no green or red?
- Answer: As its word (pass, warn, fail, not run or noted) beside one of five ink shapes that get heavier the more a trader needs to look, never coloured and never added up into a count for a market.
- Alternatives: Coloured dots; the words alone.
- Specified in: [`docs/spec/pipescope-screens.md`, Canary outcomes](spec/pipescope-screens.md#canary-outcomes)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-67: Screens: where colour is used

- Question: Where do the pages use colour?
- Answer: Ink on a pale paper with one accent, canary yellow, only on Canary's mark and on the trade-box notice, and purple only on an author's words; the values are tokens in the theme stylesheet.
- Alternatives: Colour by meaning, such as green and red for good and bad or for buys and sells.
- Specified in: [`docs/spec/pipescope-screens.md`, Colour and theme](spec/pipescope-screens.md#colour-and-theme)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-68: Screens: light and dark themes

- Question: Is Aviary light, dark or both?
- Answer: Both: the page follows the device's setting, a control in the footer overrides it, and the light theme is the one the design was drawn in.
- Alternatives: Dark only, as most terminals are.
- Specified in: [`docs/spec/pipescope-screens.md`, Colour and theme](spec/pipescope-screens.md#colour-and-theme)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-69: Screens: candles

- Question: How are up and down candles drawn?
- Answer: An up candle is hollow and a down candle is solid, both in ink, so the page keeps one rule about colour.
- Alternatives: Green and red, the convention on other terminals, which the prototype drew behind a switch.
- Specified in: [`docs/spec/pipescope-screens.md`, Chart](spec/pipescope-screens.md#chart)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-70: Screens: the feed's layout

- Question: Is the feed a table of markets, markets grouped by strategy, or a log of events?
- Answer: One table of markets, newest first, with strategies on a second tab.
- Alternatives: Markets grouped under their strategy with that version's Canary results above them; one time-ordered log of registrations, new markets, upgrades and swaps.
- Specified in: [`docs/spec/pipescope-screens.md`, Feed](spec/pipescope-screens.md#feed)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-71: Screens: what a row says about Canary

- Question: What does a list show of Canary for each market?
- Answer: The round-trip return of Canary's ordinary trade as a number and at most one result, the one a trader most needs, as an outcome and a short phrase.
- Alternatives: A count of passes and warns, which reads as a score; nothing about Canary in lists.
- Specified in: [`docs/spec/pipescope-screens.md`, What a row says about Canary](spec/pipescope-screens.md#what-a-row-says-about-canary)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-72: Screens: the feed's filter steps

- Question: Which steps do the feed's filters offer, and in what are liquidity and volume measured?
- Answer: Liquidity of at least 0.1, 1 or 10 SOL, volume in 24 hours of at least 0.01, 0.1 or 1 SOL and creation within the last hour, 24 hours or 7 days, with liquidity and volume measured on a market's SOL side, so a market with no SOL side is left out while either is on.
- Alternatives: Steps for each quote mint; a minimum the reader types.
- Specified in: [`docs/spec/pipescope-screens.md`, Filters](spec/pipescope-screens.md#filters)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-73: Screens: the market page's layout

- Question: What comes first on a market page?
- Answer: The chart with the trades beneath it and the trade box beside them, then the explanation and the strategy's forms beside the facts panel.
- Alternatives: Canary's results and the explanation first, with the chart and the trade box in a side column.
- Specified in: [`docs/spec/pipescope-screens.md`, Market page](spec/pipescope-screens.md#market-page)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-74: Screens: price direction

- Question: Which mint is a price quoted in?
- Answer: Wrapped SOL if the pair has it, else USDC, else the later mint of the pair, worked out by `terminal-api` and returned as `quote_mint` so the pages and the Telegram bot agree, with a Flip control to turn a chart round.
- Alternatives: Always the market's first mint, as Pipeline's hosted API does.
- Specified in: [`docs/spec/pipescope-screens.md`, Price direction](spec/pipescope-screens.md#price-direction)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-75: Screens: candle lengths on the chart

- Question: Which candle lengths does the chart offer, and which opens first?
- Answer: 1 m, 5 m, 15 m, 1 h, 4 h and 1 d, opening at 15 m; the 1 s and 15 s candles the indexer keeps are not on the chart in the first version.
- Alternatives: Opening at 1 m or at 1 h; offering every length the indexer keeps.
- Specified in: [`docs/spec/pipescope-screens.md`, Chart](spec/pipescope-screens.md#chart)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-76: Screens: the amount typed in the trade box

- Question: Is the amount in the trade box what goes into the market, or everything that leaves the wallet?
- Answer: Everything that leaves the wallet, fees included: the amount sent into the market is worked back from it, and the breakdown shows both.
- Alternatives: The amount sent into the market with the fees added on top, which is Pipeline's own exact-in meaning.
- Specified in: [`docs/spec/pipescope-screens.md`, The amount typed](spec/pipescope-screens.md#the-amount-typed)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-77: Screens: slippage choices

- Question: Which slippage values are one tap away?
- Answer: 0.5%, 1% (the default) and 3%, with a box for another value up to 50%, all in the screens' config module.
- Alternatives: Other presets; a slider.
- Specified in: [`docs/spec/pipescope-screens.md`, One place for every value](spec/pipescope-screens.md#one-place-for-every-value)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-78: Screens: review before signing

- Question: What does a trader see between asking to swap and their wallet opening?
- Answer: A review step that builds and simulates the swap, shows what signing would change in the wallet, and only then turns on "Sign in wallet"; a failed simulation shows the decoded error and keeps the button off.
- Alternatives: One button that simulates and opens the wallet in a single step.
- Specified in: [`docs/spec/pipescope-screens.md`, Review and sign](spec/pipescope-screens.md#review-and-sign)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-79: Screens: markets that cannot trade

- Question: What does the page of a market that cannot trade show?
- Answer: A stranded market has a plain statement in place of the trade box, with what its vaults still hold; a market that refuses every trade by its own rules keeps its trade box, where a quote returns the strategy's own error, decoded.
- Alternatives: Hiding such markets, which the listing rule forbids; no trade box on either.
- Specified in: [`docs/spec/pipescope-screens.md`, Markets that cannot trade](spec/pipescope-screens.md#markets-that-cannot-trade)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-80: Screens: Canary on the strategy page

- Question: How are a strategy version's Canary results across its markets shown?
- Answer: One line for each check with how many of the version's markets got each outcome, opening to the markets that warn or fail.
- Alternatives: A grid of markets against checks, which needs a pointer to read and does not fit a phone.
- Specified in: [`docs/spec/pipescope-screens.md`, Strategy page](spec/pipescope-screens.md#strategy-page)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-81: Screens: how search matches

- Question: How does search match what is typed?
- Answer: Names match anywhere and in any case, and addresses match exactly as typed from their start or their end; results are grouped as strategies, markets and mints.
- Alternatives: Matching addresses anywhere and in any case, which returns look-alikes for a case-sensitive address.
- Specified in: [`docs/spec/pipescope-screens.md`, Search](spec/pipescope-screens.md#search)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-82: Screens: token images

- Question: Are tokens' images shown?
- Answer: Yes, 20 px square beside the symbol and the short address, served only from `terminal-api`'s own copy (PNG, JPEG or WebP, at most 1 MB), so a reader's browser never asks an author's server for anything.
- Alternatives: Leaving images out; linking to the author's file, which tells the author who looked and lets them change the picture for each viewer.
- Specified in: [`docs/spec/pipescope-screens.md`, Token names and images](spec/pipescope-screens.md#token-names-and-images)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-83: Screens: phones

- Question: How do the pages fold on a phone?
- Answer: Nothing scrolls sideways down to 360 px: each table row becomes a small labelled block, and the market page stacks as chart, trade box, trades, explanation, actions and facts.
- Alternatives: Tables that scroll sideways; a Trade bar fixed to the bottom of the screen.
- Specified in: [`docs/spec/pipescope-screens.md`, Phones and narrow windows](spec/pipescope-screens.md#phones-and-narrow-windows)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-84: Screens: Telegram on the pages

- Question: Where do the pages carry what the Telegram bot needs of them?
- Answer: A trade link fills the trade box from the page's address, a phone with no wallet gets links that reopen the page in Phantom, Solflare or Backpack in place of "Connect wallet", "Get alerts in Telegram" sits in the head of market and strategy pages, and the footer names the official bot and channel once the API returns their handles.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-screens.md`, Arriving from Telegram](spec/pipescope-screens.md#arriving-from-telegram)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-85: Screens: where the screens' values live

- Question: Where do the numbers, lists, colours and typefaces of the pages live?
- Answer: Numbers and lists in the screens' config module `apps/terminal-web/src/config.ts`, colours and typefaces as tokens in `apps/terminal-web/src/theme.css`, and nothing in a component.
- Alternatives: Values written in the components that use them.
- Specified in: [`docs/spec/pipescope-screens.md`, One place for every value](spec/pipescope-screens.md#one-place-for-every-value)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16)

### PIPESCOPE-86: The terminal's spec files

- Question: Should the terminal's six spec files be merged into one `aviary.md` before its build tickets are cut?
- Answer: No: they stay one file per topic, reconciled so that each value is stated in one place, because this register and every product's build tickets link into their sections.
- Alternatives: One merged `aviary.md`, which the names ticket allowed.
- Specified in: [`docs/spec/pipescope-architecture.md`, Build tickets](spec/pipescope-architecture.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-87: Pipeline's packages

- Question: How does the terminal get Pipeline's TypeScript SDK and Rust crates, now that both are published?
- Answer: `@pipeline-sol/sdk` from npm at one exact version in the pnpm catalog, and Pipeline's crates from crates.io at exact versions in `crates/Cargo.toml`, a Cargo workspace apart from `programs/`; nothing of the terminal links to a clone of Pipeline's repo, and a release move is a PR of its own.
- Alternatives: A clone of Pipeline built locally at a pinned commit, as the programs' demo scripts did before the release; git dependencies pinned by `rev`.
- Specified in: [`docs/spec/pipescope-architecture.md`, Pipeline's packages](spec/pipescope-architecture.md#pipelines-packages)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-88: Where token images are kept

- Question: Where does `terminal-api` keep its own copies of token images?
- Answer: In the KV namespace the architecture already has, keyed by the SHA-256 of the bytes, with the record of each image (URI, hash, type, size, fetch outcome) in Postgres, so serving an image never wakes the database and nothing new is added to the account.
- Alternatives: An R2 bucket, a new service on the owner's account; the bytes in Postgres, which wakes Neon on every image view and fills its free storage.
- Specified in: [`docs/spec/pipescope-architecture.md`, Data](spec/pipescope-architecture.md#data)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-89: The API's config module

- Question: Where do the indexer's timings, candle retention, live-room batching, the metadata fetcher's limits, the quote mint order, the image limits and Canary's schedule live?
- Answer: As named constants in `apps/terminal-api/src/config.ts`, with one every-minute cron that runs whatever those intervals make due and the live socket closing 3 minutes after the last viewer leaves; per-environment values stay vars of `wrangler.jsonc`.
- Alternatives: Intervals written as separate cron expressions in `wrangler.jsonc`; values written where each is used.
- Specified in: [`docs/spec/pipescope-architecture.md`, One place for every value](spec/pipescope-architecture.md#one-place-for-every-value)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-90: Public API rate limits

- Question: How many requests may one IP make to the public API?
- Answer: 300 reads a minute, 60 a minute for quotes, prepares and trade signatures together, and 10 "This is wrong" reports a minute, set in the rate-limiting bindings of `terminal-api`'s `wrangler.jsonc`.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, API](spec/pipescope-architecture.md#api)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-91: Pipeline's fee on the pages

- Question: Where do the pages, the bot and Canary's cost split get Pipeline's own fee?
- Answer: From `terminal-api`, which returns it with every quote and on the fees endpoint, taking it from Pipeline's SDK at the version pinned with the router, since Pipeline 0.3's router keeps it as a constant of its program and not in its config account; so no page, message or check writes it as a number.
- Alternatives: The earlier default, the router's config account read by `terminal-api`, which since Pipeline 0.3 holds no fee; the 0.25% written into the trade box and the Fees page.
- Specified in: [`docs/spec/pipescope-architecture.md`, The integrator fee's configuration](spec/pipescope-architecture.md#the-integrator-fees-configuration)
- Changes by: spec only
- Status: changed 2026-11-23
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-92: One list of a strategy's instructions

- Question: Which code works out the instructions compiled into a strategy version?
- Answer: `terminal-api`, once per strategy version when the indexer records it, stored with the version and read by the facts panel, the forms' instruction check, the explainer's F items and Canary's snapshot.
- Alternatives: Canary's binary working it out and the web app working it out again for the forms.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-93: Pipeline's hosted API in the tests

- Question: How far does the terminal lean on Pipeline's hosted devnet API?
- Answer: As a test oracle only: the devnet tests compare our trades, candles, trust flags, quotes and unhooked swap transactions with its answers, and our Canary `conformance` result with its hosted checks; its `checks-*` flags are not shown, since Canary's own result says the same thing, nor its `conformance-report` and `conformance-stale`, which need the report a strategy's metadata links fetched, a URL found inside a document (`PIPESCOPE-36`).
- Alternatives: The earlier default, leaving out only `checks-*`; fetching the linked conformance report as an exception to `PIPESCOPE-36`; serving the feed, charts or wallet page from it, which ADR 0003 ruled out; showing its `checks-*` flags beside Canary's result.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: spec only
- Status: changed 2026-11-23
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22); changed 2026-11-23 in [Aviary: strategy metadata, trust facts and the facts panel, with the feed's filters](https://github.com/imDev2023/testing-pipeline/issues/119)

### PIPESCOPE-94: How signing is tested

- Question: How do the terminal's tests sign transactions without Aviary ever holding a user's key?
- Answer: Playwright registers a Wallet Standard test wallet, only in test builds, that signs with a devnet test key from `~/.config/testing-pipeline/devnet/`; each ticket that adds a signing flow also runs it once in a real wallet extension set to devnet, driven in the owner's Chrome, with screenshots in its PR.
- Alternatives: Only real wallets, by hand; a mocked signer that never reaches devnet.
- Specified in: [`docs/spec/pipescope-architecture.md`, Build tickets](spec/pipescope-architecture.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-95: Order of the terminal's build tickets

- Question: In what order are the terminal's build tickets run, and what can run side by side?
- Answer: Owner setup, then the scaffold, the indexer, candles and the market page, facts, trading, forms, Canary on the pages, the explainer, and the bot; Canary's binary starts at once beside them, and each product's Aviary panel waits for the terminal tickets it builds on.
- Alternatives: Building the layers one at a time (all of the API, then all of the pages), as the architecture's suggested slices did.
- Specified in: [`docs/spec/pipescope-architecture.md`, Build tickets](spec/pipescope-architecture.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-96: How a terminal ticket is verified

- Question: What does a terminal build ticket have to show before it counts as done?
- Answer: Its criteria run on Aviary's local run against devnet data (both Workers in `wrangler dev` on the Docker Postgres, `PIPESCOPE-98`) until the hosted deploy of [#192](https://github.com/imDev2023/testing-pipeline/issues/192) lands and on Aviary's devnet deployment after it, every page it touches is checked at 1440, 390 and 360 px wide in the light and the dark theme with Playwright screenshots in the PR, and CI runs the same tests on recorded devnet fixtures with no network.
- Alternatives: The earlier default, its criteria run on Aviary's devnet deployment from the first ticket; local runs only, for good; CI against live devnet, which would spend Aviary's RPC credits and fail when devnet does.
- Specified in: [`docs/spec/pipescope-architecture.md`, Build tickets](spec/pipescope-architecture.md#build-tickets)
- Changes by: spec only
- Status: changed 2026-11-22
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-97: Where the keeper page lives

- Question: Where in Aviary is the keeper runner's public page?
- Answer: At `/keeper`, read-only, linked from every page's footer beside Fees and Devnet help, and from each product panel's due keeper jobs.
- Alternatives: A page reached only from the product panels.
- Specified in: [`docs/spec/pipescope-architecture.md`, Build tickets](spec/pipescope-architecture.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-98: Where Aviary runs for now

- Question: Where does Aviary run and get verified before its hosted deploy?
- Answer: Locally: `wrangler dev` runs both Workers against the Docker Postgres and devnet from the project's `.env`, with `RPC_URL` on the owner's shared Helius devnet key until Aviary has its own, and the hosted deploy (both Workers on `workers.dev`, Neon through Hyperdrive, Aviary's own Helius key, the secrets check and the root deploy script) moves to [#192](https://github.com/imDev2023/testing-pipeline/issues/192), after the owner's setup in [#110](https://github.com/imDev2023/testing-pipeline/issues/110).
- Alternatives: Deploying both Workers to `workers.dev` from the scaffold on; Convex as the data layer, not taken because the spec's data layer is Postgres throughout.
- Specified in: [`docs/spec/pipescope-architecture.md`, Environments](spec/pipescope-architecture.md#environments)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Aviary: scaffold both Workers, the database, the page shell with its themes, and the devnet deploy](https://github.com/imDev2023/testing-pipeline/issues/113)

### PIPESCOPE-99: How the cron decides what is due

- Question: How does the every-minute cron's dispatcher know which jobs are due?
- Answer: From the minute alone: a job runs on each minute whose count since the Unix epoch its interval in whole minutes divides, so deciding what to run never wakes the database, and a job that fails is logged without stopping the others.
- Alternatives: Recording each job's last run in Postgres, as Top-pad's `job_runs` does, which would wake the database every minute.
- Specified in: [`docs/spec/pipescope-architecture.md`, `terminal-api`](spec/pipescope-architecture.md#terminal-api)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Aviary: scaffold both Workers, the database, the page shell with its themes, and the devnet deploy](https://github.com/imDev2023/testing-pipeline/issues/113)

### PIPESCOPE-100: What a refused read is told

- Question: What counts against the read limit, and what does a reader over it get back?
- Answer: Every `GET` counts as a read against the `READS` binding, `/health` and unknown paths included, keyed by the reader's IP, and a refused one gets a 429 with `Retry-After` and the sentence "Too many requests from your address. Try again in 60 seconds.", whose wait is `RATE_LIMIT_PERIOD_SECONDS` in `apps/terminal-api/src/config.ts`, which a test keeps equal to every binding's period.
- Alternatives: Naming the exact time left in the window, which the rate-limiting binding does not report.
- Specified in: [`docs/spec/pipescope-architecture.md`, API](spec/pipescope-architecture.md#api)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-22 in [Aviary: scaffold both Workers, the database, the page shell with its themes, and the devnet deploy](https://github.com/imDev2023/testing-pipeline/issues/113)

### PIPESCOPE-101: Page addresses

- Question: At which addresses do Aviary's pages live?
- Answer: The feed at `/`, Devnet help at `/devnet`, a market at `/markets/<address>` and a strategy at `/strategies/<address>`, written once in `apps/terminal-web/src/routes.ts`, and an address that is neither gets the "nothing there" page with a 404.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, `terminal-web`](spec/pipescope-architecture.md#terminal-web)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-22 in [Aviary: scaffold both Workers, the database, the page shell with its themes, and the devnet deploy](https://github.com/imDev2023/testing-pipeline/issues/113)

### PIPESCOPE-102: How CI's tests read devnet

- Question: Where do the terminal's CI tests get devnet's answers, with no network and no RPC key?
- Answer: The local API reads recorded devnet RPC answers from `tests/terminal-e2e/fixtures/devnet-rpc.json` through a fixture server the Playwright run starts, recorded by `pnpm --filter terminal-e2e record` against live devnet, and a request with no recording fails its test.
- Alternatives: Playwright intercepting the browser's calls to the API, which would leave the API itself untested.
- Specified in: [`docs/spec/pipescope-architecture.md`, Build tickets](spec/pipescope-architecture.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Aviary: scaffold both Workers, the database, the page shell with its themes, and the devnet deploy](https://github.com/imDev2023/testing-pipeline/issues/113)

### PIPESCOPE-103: Where the typefaces come from

- Question: Which font files does Aviary serve from its own origin?
- Answer: Archivo, upright and italic with its width and weight axes, and Literata, cut from Google Fonts' repository to Latin, general punctuation and the subscript digits that prices count their zeros with, as WOFF2 files in `apps/terminal-web/src/fonts` declared only in `theme.css`.
- Alternatives: Fontsource's Latin subsets, which leave out the subscript digits; `next/font`, which writes the typeface's name in a component.
- Specified in: [`docs/spec/pipescope-architecture.md`, `terminal-web`](spec/pipescope-architecture.md#terminal-web)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-22 in [Aviary: scaffold both Workers, the database, the page shell with its themes, and the devnet deploy](https://github.com/imDev2023/testing-pipeline/issues/113)

### PIPESCOPE-104: What the keeper page shows

- Question: What does the keeper page show, and when does it say the runner looks stopped?
- Answer: Whether the runner is running, the keeper wallet (`KEEPER_WALLET`, a var of `terminal-api`) with its balance through RPC, today's spend against `DAILY_CAP`, `MAX_TX_COST` and each market's `MARKET_DAILY_CAP`, the last time each kind of pass ran and the last time it did something, the held and parked jobs, the latest 20 jobs with their transactions, and the latest warnings; the runner looks stopped once its last heartbeat is older than its own `SWEEP_INTERVAL` plus 5 minutes (`KEEPER_STOPPED_GRACE_MS`); a database or RPC that does not answer leaves the rest of the page standing.
- Alternatives: A fixed threshold, which would go wrong as soon as someone set a different `SWEEP_INTERVAL`; a page per product, beside each panel's due jobs.
- Specified in: [`docs/spec/keeper-runner.md`, How Aviary shows it](spec/keeper-runner.md#how-aviary-shows-it)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-22 in [Aviary: the keeper page and the keeper runner's records](https://github.com/imDev2023/testing-pipeline/issues/129)

### PIPESCOPE-105: How the API pages its lists

- Question: How do the markets list and the trade lists page, and how much may one page hold?
- Answer: Newest first, each page ending with a `next` cursor the following page passes as `before`, with at most 200 markets or 1,000 trades a page and the pages asking for the screens' 50 feed rows and 40 trades, as `PAGE_LIMITS` in `terminal-api`'s config module.
- Alternatives: Offset paging, which repeats or skips a row whenever a new market or trade arrives between two pages; the hosted API's `before_slot`, which splits the trades of one slot across two pages.
- Specified in: [`docs/spec/pipescope-architecture.md`, API](spec/pipescope-architecture.md#api)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-22 in [Aviary: index the router's history into Postgres, with the feed's two tables](https://github.com/imDev2023/testing-pipeline/issues/116)

### PIPESCOPE-106: A market's 24 hours on the feed

- Question: What do a market's trade count and volume in the last 24 hours count on a market of three or four mints?
- Answer: The count takes every trade in the last 24 hours by the event's own clock, and the volume adds the quote mint's side of each trade that has the quote mint on one side, since no other trade carries an amount of it.
- Alternatives: Counting only the trades of the default pair, which would hide the other pairs' trades from the count.
- Specified in: [`docs/spec/pipescope-screens.md`, Feed](spec/pipescope-screens.md#feed)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Aviary: index the router's history into Postgres, with the feed's two tables](https://github.com/imDev2023/testing-pipeline/issues/116)

### PIPESCOPE-107: How candles keep and serve prices

- Question: How are candle prices kept, written out and served?
- Answer: Exactly, each open, high, low and close as the reduced fraction of the amounts of the swap that set it, per market and mint pair; the API writes them for the base and quote asked for to 36 significant digits (`PRICE_SIGNIFICANT_DIGITS`) and serves a length's newest 1,000 candles, or up to 5,000 when asked (`PAGE_LIMITS`).
- Alternatives: Prices kept as decimals of a fixed scale, which a flipped chart or a parity check against Pipeline's hosted API would read with rounding error; candles kept twice, once each way round.
- Specified in: [`docs/spec/pipescope-architecture.md`, Candles](spec/pipescope-architecture.md#candles)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: candles, live rooms and the market page's chart and trades](https://github.com/imDev2023/testing-pipeline/issues/118)

### PIPESCOPE-108: Which time places a swap in its candle

- Question: Which time decides the candle a swap is folded into?
- Answer: Its block's time, which is where Pipeline's hosted API places it and which can be a second after the event's own clock (105 of devnet's 387 swaps on 2026-11-23); the event's clock only for a block whose time is unknown.
- Alternatives: The event's own clock, which Top-pad's candles use and which put swaps in a different minute from the hosted API's candles.
- Specified in: [`docs/spec/pipescope-architecture.md`, Candles](spec/pipescope-architecture.md#candles)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: candles, live rooms and the market page's chart and trades](https://github.com/imDev2023/testing-pipeline/issues/118)

### PIPESCOPE-109: When candles past their retention are dropped

- Question: How often does the indexer drop 1 s and 15 s candles past their retention?
- Answer: Once a day, at midnight UTC on the every-minute cron's schedule (`JOB_INTERVAL_MINUTES.pruneCandles`), so the database wakes for it rarely.
- Alternatives: Every hour, or with each reconciliation that opens the database.
- Specified in: [`docs/spec/pipescope-architecture.md`, Candles](spec/pipescope-architecture.md#candles)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: candles, live rooms and the market page's chart and trades](https://github.com/imDev2023/testing-pipeline/issues/118)

### PIPESCOPE-110: What live rooms send, and how a page resyncs

- Question: What does a live room send a page, and how does a page catch up on what it missed?
- Answer: A market's room is sent each new swap as the API's trade, or told to resync past 100 at once (`LIVE_ROOM_TRADES_MAX`), and the feed's room each market new or changed as the API's market, only while the room has a viewer; a page resyncs each time it joins, the first time included, through `trades?after=` from the newest trade it shows; a room tells the indexer of each viewer that joins, so one it missed is counted at the next; and the indexer's alarm asks each room how many viewers it holds, so a room whose browsers left unseen never keeps the socket open.
- Alternatives: Events that only name what changed, each sending every page back to the API for it; resyncing only after a reconnection, which misses what lands between a page's first read and its room.
- Specified in: [`docs/spec/pipescope-architecture.md`, Live rooms](spec/pipescope-architecture.md#live-rooms)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: candles, live rooms and the market page's chart and trades](https://github.com/imDev2023/testing-pipeline/issues/118)

### PIPESCOPE-111: How live rows arrive on a page

- Question: How do new rows and candles arrive on the feed and on a market page without moving what a reader is looking at?
- Answer: While the pointer or the keyboard focus is on the table, new rows wait behind a "Show 2 new trades" button beside its heading and join the top when it leaves; a row already shown updates in place; a new row is washed for a moment only for a reader who allows motion; the forming candle is read again at most once a second (`LIVE_CANDLE_REFRESH_MS`); a dropped room is joined again after a wait doubling from a second to 15 s (`LIVE_RECONNECT_MAX_MS`).
- Alternatives: Inserting new rows at once and moving the page's scroll to keep the row under the pointer in place; no wash at all.
- Specified in: [`docs/spec/pipescope-screens.md`, What the prototype did not show](spec/pipescope-screens.md#what-the-prototype-did-not-show)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: candles, live rooms and the market page's chart and trades](https://github.com/imDev2023/testing-pipeline/issues/118)

### PIPESCOPE-112: How wide a candle is drawn

- Question: How much room does the chart give each candle?
- Answer: 16 px whatever the chart's width (`CHART_CANDLE_SPACING_PX`), the newest at the right, so a lone candle is drawn at a readable size on a phone and on a desktop alike, and a reader scrolls back for older ones.
- Alternatives: The prototype's fixed count of candles across the width, 44, which drew phone candles as hairlines; fitting every candle into the width.
- Specified in: [`docs/spec/pipescope-screens.md`, Chart](spec/pipescope-screens.md#chart)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: candles, live rooms and the market page's chart and trades](https://github.com/imDev2023/testing-pipeline/issues/118)

### PIPESCOPE-113: What makes a new strategy version

- Question: Which changes of a program's ProgramData account make a new strategy version?
- Answer: A deploy or an upgrade, keyed by its transaction's slot; an extension, which moves the ProgramData slot and keeps the code, makes none, and a version recorded before its transaction is served is looked for again on at most 30 watches, `VERSION_TRANSACTION_LOOKS`.
- Alternatives: Every change of the ProgramData slot, which listed the extension before each upgrade as a version of its own with the same code (the buy wall AMM's on 2026-11-20).
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: index strategy programs and their versions, with the strategy page's version history](https://github.com/imDev2023/testing-pipeline/issues/117)

### PIPESCOPE-114: Who called a strategy's instruction

- Question: Who is stored as having called an instruction on a strategy program?
- Answer: The transaction's signers among the instruction's accounts, with the program that invoked it kept beside them, from successful transactions only; the API lists at most 100 signers an instruction, most calls first, `INSTRUCTION_SIGNERS_SHOWN`, and counts them all.
- Alternatives: The transaction's fee payer, which names whoever paid rather than whoever the instruction needed; counting failed transactions too, which changed nothing.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: index strategy programs and their versions, with the strategy page's version history](https://github.com/imDev2023/testing-pipeline/issues/117)

### PIPESCOPE-115: How an instruction's name is cut from the bytes

- Question: Where does a name compiled in as "Instruction: Name" end, when the next string runs on into it?
- Answer: At the longest prefix whose discriminator is in the code, trying every prefix, with a discriminator split over two instruction slots counting as well as one side by side.
- Alternatives: Cutting only at capital letters, which missed the outside builder's `SetMetadata` on devnet, where the next string begins in lower case.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: index strategy programs and their versions, with the strategy page's version history](https://github.com/imDev2023/testing-pipeline/issues/117)

### PIPESCOPE-116: The outbox for what follows the indexer

- Question: How do Canary's runs and the Telegram bot's queue learn of a new strategy, market, strategy version or router upgrade?
- Answer: From one outbox table in Postgres, each event written once in the order seen, which each reads on from a cursor of its own.
- Alternatives: The indexer calling each of them directly, which loses an event whenever the one called is down; a queue product, which Aviary does not otherwise need.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: index strategy programs and their versions, with the strategy page's version history](https://github.com/imDev2023/testing-pipeline/issues/117)

### PIPESCOPE-117: Keeping program and mint facts current

- Question: How does Aviary keep the facts behind the trust flags current, since an upgrade authority, a mint authority, a supply or an extension can change after it is first read?
- Answer: Who can upgrade each program is read from the header the ProgramData watch already reads every minute and written when it changes; every mint is read again every hour (`mintRefresh` in `terminal-api`'s config module), its flags worked out with Pipeline's SDK's `decodeMint` at the epoch it was read in.
- Alternatives: Reading each mint once, when a market first brings it, which leaves a flag showing after the authority behind it is gone; reading every mint every minute, which would wake the database for nothing.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: strategy metadata, trust facts and the facts panel, with the feed's filters](https://github.com/imDev2023/testing-pipeline/issues/119)

### PIPESCOPE-118: What a metadata fetch keeps

- Question: What does Aviary keep of each fetch of a strategy's metadata, and how does a refusal read?
- Answer: One row per outcome in `metadata_snapshots` (the URI, Pipeline's SDK's status, the fetch's or validator's errors, the document's SHA-256, the document as validated and its author text as the explainer's normaliser leaves it), a new row only when the URI, the status or the hash changes; what could not be fetched is `metadata-unreachable`, and a document of a refused content type, not JSON, or refused by Pipeline's validator is `metadata-invalid`, as Pipeline's SDK gives them.
- Alternatives: Keeping only the newest outcome, which loses the change a new explanation key needs; a status of our own for a refused content type.
- Specified in: [`docs/spec/pipescope-architecture.md`, Metadata fetcher](spec/pipescope-architecture.md#metadata-fetcher)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: strategy metadata, trust facts and the facts panel, with the feed's filters](https://github.com/imDev2023/testing-pipeline/issues/119)

### PIPESCOPE-119: The feed's filters in the address and the API

- Question: How do the feed's filters reach the API, and how does a filtered feed's address read?
- Answer: The address carries `liquidity` and `volume` (one of the screens' steps, in SOL), `created` (`1h`, `24h` or `7d`) and `hide` (Pipeline's flags, separated by commas), ignoring any other value; `GET /v1/markets` takes `min_sol_liquidity` and `min_sol_volume_24h` in lamports, `created_within` in seconds and `hide`, and answers, besides the page, how many markets there are, how many the filters keep, how many have no SOL side, and every flag present with its description.
- Alternatives: Filtering in the page over the markets loaded, which cannot count what is not loaded; filters kept in the browser and not the address.
- Specified in: [`docs/spec/pipescope-screens.md`, Filters](spec/pipescope-screens.md#filters)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: strategy metadata, trust facts and the facts panel, with the feed's filters](https://github.com/imDev2023/testing-pipeline/issues/119)

### PIPESCOPE-120: A strategy's name and description on the pages

- Question: Which of a strategy's author text do the pages show, and what does a strategy show before its metadata is first fetched?
- Answer: Its name from valid metadata wherever the strategy is named, and its description under the name at the head of its page, both as the explainer's normaliser leaves them, in the author's style; before the first fetch, the short address with "Metadata not read yet".
- Alternatives: The name only; the author's text as fetched, with its control and text-direction characters.
- Specified in: [`docs/spec/pipescope-screens.md`, Strategy page](spec/pipescope-screens.md#strategy-page)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: strategy metadata, trust facts and the facts panel, with the feed's filters](https://github.com/imDev2023/testing-pipeline/issues/119)

### PIPESCOPE-121: The market page's facts before its explanation and forms

- Question: Where does the market page's facts panel sit while the explanation and the forms have not landed beside it?
- Answer: In the lower band, under the trades, at its full width, with "This market", "Its strategy" and "Its mints" side by side and one under another on narrow screens; the explanation and the forms take the band's first column when they land.
- Alternatives: The facts in the band's right column with its left column empty.
- Specified in: [`docs/spec/pipescope-screens.md`, Explanation, actions and facts](spec/pipescope-screens.md#explanation-actions-and-facts)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: strategy metadata, trust facts and the facts panel, with the feed's filters](https://github.com/imDev2023/testing-pipeline/issues/119)

### PIPESCOPE-122: Token names as Aviary keeps them

- Question: Where does a token's name come from, and how is it kept and shown?
- Answer: From its mint's Token-2022 token metadata extension, or else its Metaplex metadata account, read with the mint and again every hour; its symbol and name go through the author-text normaliser (control, direction and zero-width characters stripped), the symbol capped at 16 characters and the name at 64 (`AUTHOR_TEXT_CAPS` in the explainer's rules module), and a page shows the symbol, or the name when there is no symbol, in the author's style beside the short address.
- Alternatives: Keeping the names exactly as the chain holds them, which lets a direction override make one token's name read as another's; no cap on the symbol, which lets one author's file set a table row's width.
- Specified in: [`docs/spec/pipescope-screens.md`, Token names and images](spec/pipescope-screens.md#token-names-and-images)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: token names and images, and search](https://github.com/imDev2023/testing-pipeline/issues/120)

### PIPESCOPE-123: Where a token's image is found

- Question: What does Aviary fetch to find the image a token's metadata names, and how often?
- Answer: The token metadata URI once, under the metadata fetcher's limits and at most 1 MB: if what it serves is a PNG, JPEG or WebP by its first bytes, that is the image; if it is a JSON document of at most 64 KB, the `https:` URL in its `image` is fetched once more under the same limits; nothing else is fetched; each URI's outcome is kept once, shared by every mint naming it, and a URI is fetched again only when a mint names another, except that one which could not be reached is tried again after each hourly read of every mint, since a host can be down for a moment; only the URIs of mints that name themselves are fetched, and never those of SOL and USDC.
- Alternatives: Treating the URI only as a document, which misses tokens whose URI is the picture; never trying again after a failed fetch, which loses a token's image for good to one busy moment of its host; following `ipfs:` and `ar:` links through a gateway, which would add a third party.
- Specified in: [`docs/spec/pipescope-architecture.md`, Metadata fetcher](spec/pipescope-architecture.md#metadata-fetcher)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: token names and images, and search](https://github.com/imDev2023/testing-pipeline/issues/120)

### PIPESCOPE-124: The search endpoint

- Question: How does `terminal-api` answer a search?
- Answer: `GET /v1/search?q=&limit=`, from Postgres: a query of 1 to 100 characters compared as text and never as a pattern; each group (strategies, markets, mints) counted in full and served up to `limit` (20 by default, at most 100, `PAGE_LIMITS.search`), a whole address typed coming first, then strategies by their market count, markets newest first and mints by their market count; SOL and USDC found by Aviary's names for them, every market a mint trades on named with it, and the three examples shown when nothing is typed kept in the screens' config module and checked by the end-to-end tests to find something on devnet.
- Alternatives: Searching in the browser over the feed's pages, which misses whatever is not loaded; a cap on the markets listed with a mint, which the spec does not ask for.
- Specified in: [`docs/spec/pipescope-architecture.md`, API](spec/pipescope-architecture.md#api)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: token names and images, and search](https://github.com/imDev2023/testing-pipeline/issues/120)

### PIPESCOPE-125: The marks for SOL and USDC

- Question: What marks do SOL and USDC carry beside the names Aviary gives them?
- Answer: Marks Aviary draws itself and ships with the app, in the page's ink at the 20 px of a token's image: three slanted bars for SOL and a ringed dollar sign for USDC.
- Alternatives: Solana's and Circle's own logos, whose green and blue would break the rule that nothing on a page is coloured but the canary yellow and an author's purple.
- Specified in: [`docs/spec/pipescope-screens.md`, Token names and images](spec/pipescope-screens.md#token-names-and-images)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: token names and images, and search](https://github.com/imDev2023/testing-pipeline/issues/120)
### PIPESCOPE-126: Canary's re-run

- Question: How does the owner re-run Canary on a market or a strategy?
- Answer: With `pnpm canary:rerun --market <m> | --strategy <s>`, which signs the request with the operator wallet, `CANARY_OPERATOR` (the project's devnet wallet), and posts it to `POST /v1/canary/reruns`, which takes it only with that wallet's signature and a time within 2 minutes of its own; the one owner operation in the API, since it must wake a `CanaryRun` object.
- Alternatives: Writing the request to Postgres for the runs to find, which would need a job reading the database every minute and keep it awake; a shared secret in the Worker.
- Specified in: [`docs/spec/pipescope-architecture.md`, Canary runner](spec/pipescope-architecture.md#canary-runner)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-23 in [Aviary: Canary in a Container, run by CanaryRun, with results in Postgres](https://github.com/imDev2023/testing-pipeline/issues/124)

### PIPESCOPE-127: How Canary's triggers reach its runs

- Question: How do the outbox's events reach the `CanaryRun` objects without waking the database to look for them?
- Answer: Canary's reader drains the outbox from its own cursor right after each indexer job that opened Postgres, one drain at a time in the `Indexer` object, which the 6-hourly sweep job asks to drain first; an event is acknowledged only once its runs were handed over, and a new market waits for its strategy's version to be recorded, for at most 30 minutes.
- Alternatives: A job reading the outbox every minute, which keeps the free database awake all month.
- Specified in: [`docs/spec/pipescope-architecture.md`, Canary runner](spec/pipescope-architecture.md#canary-runner)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: Canary in a Container, run by CanaryRun, with results in Postgres](https://github.com/imDev2023/testing-pipeline/issues/124)

### PIPESCOPE-128: A Canary run that fails

- Question: What happens when a market's snapshot or run fails, as when the RPC refuses or the container restarts?
- Answer: The run's alarm tries the market again after waits doubling from 30 seconds to 10 minutes, six attempts in all, then records that Aviary could not run it, keeps its earlier results and goes on; a refusal by the binary (its 400) is recorded at once, and a market whose rounds pass 6 minutes is put off to a later alarm, so an alarm stays within its 15 minutes.
- Alternatives: Recording a "not run" result, which would replace a real result with one about Aviary's own trouble.
- Specified in: [`docs/spec/pipescope-architecture.md`, Canary runner](spec/pipescope-architecture.md#canary-runner)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: Canary in a Container, run by CanaryRun, with results in Postgres](https://github.com/imDev2023/testing-pipeline/issues/124)

### PIPESCOPE-129: A Canary run whose strategy is upgraded under it

- Question: What does a version's run do when the chain no longer runs that version's code?
- Answer: It hands every market still to do to the strategy's newer recorded version, each run still due when it was, and records those markets as moved; while the watch has not recorded the newer version, it waits a minute at a time, five times.
- Alternatives: Running the markets anyway, which would store the newer code's results under the older version.
- Specified in: [`docs/spec/pipescope-architecture.md`, Canary runner](spec/pipescope-architecture.md#canary-runner)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: Canary in a Container, run by CanaryRun, with results in Postgres](https://github.com/imDev2023/testing-pipeline/issues/124)

### PIPESCOPE-130: One Canary run at a time in the container

- Question: How do several versions' runs share the one container?
- Answer: The container's object takes one market's run at a time, in the order asked, so a `basic` instance's quarter vCPU and 1 GiB serve one run at a time; a run that has waited 3 minutes for its turn is given back to be tried again, and each answer is given 4 minutes.
- Alternatives: Letting runs share the instance at once, which risks its memory and slows each run alike.
- Specified in: [`docs/spec/pipescope-architecture.md`, Canary runner](spec/pipescope-architecture.md#canary-runner)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: Canary in a Container, run by CanaryRun, with results in Postgres](https://github.com/imDev2023/testing-pipeline/issues/124)

### PIPESCOPE-131: Canary's results in the API

- Question: How does the API serve Canary's results?
- Answer: `GET /v1/markets/{market}/canary` serves a market's latest result of each check under its strategy's current version, or the version asked for, each with the binary's reason and `terminal-api`'s sentences for what the check does and when and on which version it ran, and the "could not sell back" notice as the reasons of the results it rests on; `GET /v1/strategies/{program}/versions/{slot}/canary` serves the version's roll-up, computed from its markets' latest results.
- Alternatives: Storing a roll-up per run, which a run of one market would leave out of date.
- Specified in: [`docs/spec/pipescope-architecture.md`, Canary runner](spec/pipescope-architecture.md#canary-runner)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Aviary: Canary in a Container, run by CanaryRun, with results in Postgres](https://github.com/imDev2023/testing-pipeline/issues/124)

### PIPESCOPE-132: Who pays for a quote's simulation

- Question: Which account pays the fee of the simulation behind a trade-box quote?
- Answer: The fee wallet, which does not sign, so a quote works before the trader's wallet holds any SOL; it keeps a little devnet SOL for that.
- Alternatives: The trader's wallet, which fails every quote for a wallet that has never held SOL.
- Specified in: [`docs/spec/pipescope-architecture.md`, Trading path](spec/pipescope-architecture.md#trading-path)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-23 in [Aviary: trade plain mints](https://github.com/imDev2023/testing-pipeline/issues/121)

### PIPESCOPE-133: How long the fast path waits

- Question: How long does the trade fast path wait for a signature to confirm before it answers that it has not?
- Answer: 60 s, about a blockhash's life, after which the page says the trade joins Trades once Aviary reads it, if it lands.
- Alternatives: Waiting until the transaction's blockhash has expired by block height.
- Specified in: [`docs/spec/pipescope-architecture.md`, One place for every value](spec/pipescope-architecture.md#one-place-for-every-value)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: trade plain mints](https://github.com/imDev2023/testing-pipeline/issues/121)

### PIPESCOPE-134: A prepared swap grown old

- Question: What happens when the trader asks to sign a swap that was prepared a while ago?
- Answer: A prepared swap older than 45 s is built and simulated again, and shown again, before the wallet is asked, since its blockhash would soon expire.
- Alternatives: Letting the wallet send it and fail on an expired blockhash; rebuilding it on a timer while the review is open, which spends RPC credits while nobody acts.
- Specified in: [`docs/spec/pipescope-screens.md`, One place for every value](spec/pipescope-screens.md#one-place-for-every-value)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: trade plain mints](https://github.com/imDev2023/testing-pipeline/issues/121)

### PIPESCOPE-135: Which mints the trade box quotes

- Question: Which mints does the trade box quote and build swaps of?
- Answer: Every mint but a Token-2022 mint with a transfer fee, no transfers or a pause switch, since the box promises exactly what leaves the wallet and what arrives; a mint with a transfer hook is quoted and traded with its hook's accounts (`PIPESCOPE-154`), and its simulation shows whether the hook allows the swap.
- Alternatives: The earlier default, plain mints only, a transfer hook refused too until hooked mints were built; quoting every mint and letting the simulation show what really moves, which leaves the breakdown's numbers wrong for transfer-fee mints.
- Specified in: [`docs/spec/pipescope-architecture.md`, Trading path](spec/pipescope-architecture.md#trading-path)
- Changes by: build-time constant
- Status: changed 2026-11-24
- Decided: 2026-11-23 in [Aviary: trade plain mints](https://github.com/imDev2023/testing-pipeline/issues/121); changed 2026-11-24 in [Aviary: hooked mints, markets of three or four mints, and the wallet page](https://github.com/imDev2023/testing-pipeline/issues/122)

### PIPESCOPE-136: The trade box's real-wallet check

- Question: How is the trade box's criterion of a buy signed once in a real wallet met?
- Answer: By the Playwright test wallet, which registers through the Wallet Standard as Phantom does and signs with the project's devnet key `e2e-trader.json`, connecting, reviewing and signing one buy on devnet through the real page of the local run, with no human step; what Phantom, Solflare or Backpack show when set to mainnet is no longer part of the ticket.
- Alternatives: The earlier criterion: the same buy signed once in a real wallet extension in the owner's Chrome, with screenshots, and a note of what Phantom, Solflare or Backpack do when set to mainnet, as `PIPESCOPE-94` asks of each signing flow.
- Specified in: [the ticket, Aviary: trade plain mints](https://github.com/imDev2023/testing-pipeline/issues/121)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: trade plain mints](https://github.com/imDev2023/testing-pipeline/issues/121)

### PIPESCOPE-137: How the live socket is tried again while it fails

- Question: How soon is the indexer's live socket tried again when it cannot be opened or its subscription is refused, and is it reopened when it drops with no viewer left?
- Answer: Each try that ends before the RPC confirms the subscription waits twice the last, from the 15 s alarm up to 5 minutes (`SOCKET_REOPEN_BACKOFF_MAX_MS`), and a viewer arriving meanwhile does not try ahead of it, while the every-minute reconciliation still brings each trade to the pages; a socket that drops once no room has a viewer stays closed until the next viewer opens it.
- Alternatives: Trying again on every 15 s alarm, which asks and reconciles with a refusing RPC four times a minute for as long as anyone watches; reopening a socket that drops during the 3 minutes after the last viewer left.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Aviary: follow-ups found in #118's candles and live rooms](https://github.com/imDev2023/testing-pipeline/issues/214)

### PIPESCOPE-138: How the live path waits on the RPC

- Question: How does the indexer fetch the transactions the live socket reports when the RPC is slow to serve them or refuses?
- Answer: Each reported transaction is asked for as soon as it is reported, at most two at a time (`RPC_WAITS.transaction.atOnce`), within one wait from its arrival (`RPC_WAITS.transaction`), and is indexed and published as soon as it is served, with no earlier transaction or slow publish holding it back; "not served yet" and a rate limit are asked again within the wait, and any other refusal or error leaves it to reconciliation at once.
- Alternatives: Each transaction asked for in turn for up to 8 s, every error taken for "not served yet", and the batch published only once all were done, so one slow or rate-limiting answer held every live trade back.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Aviary: follow-ups found in #118's candles and live rooms](https://github.com/imDev2023/testing-pipeline/issues/214)

### PIPESCOPE-139: Candles written again from the trades

- Question: How do markets whose trades were indexed before candles were kept, or whose candles were lost since, get their candles?
- Answer: Each new instance of the indexer, on its first run, compares every market and mint pair's priced swaps with its candles at the lengths kept forever and writes the pairs that disagree again from their trades, at every length within its retention, under the candles table's lock.
- Alternatives: A one-time script run by hand against each database; a data migration that folds the trades in SQL, a second copy of the fold.
- Specified in: [`docs/spec/pipescope-architecture.md`, Candles](spec/pipescope-architecture.md#candles)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: follow-ups found in #118's candles and live rooms](https://github.com/imDev2023/testing-pipeline/issues/214)

### PIPESCOPE-140: A market's live room only for a known market

- Question: Does `/v1/live/markets/{address}` open a room for any well-formed address?
- Answer: No: it opens a room only for a market Aviary has indexed, and answers 404 for any other address, so no address opens a room, and the indexer's socket, for nothing; when the database cannot be read, the room opens anyway, since live updates need no database.
- Alternatives: A room for any well-formed address, which costs no database read but lets anyone hold the socket open on addresses that are no market.
- Specified in: [`docs/spec/pipescope-architecture.md`, Live rooms](spec/pipescope-architecture.md#live-rooms)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: follow-ups found in #118's candles and live rooms](https://github.com/imDev2023/testing-pipeline/issues/214)

### PIPESCOPE-141: Forms from Pipeline's old actions section

- Question: Does Aviary render forms from the `actions` section that Pipeline 0.2 dropped from its metadata standard, which other strategies still publish?
- Answer: Yes: when a strategy's valid metadata has no `aviary_actions`, its `actions` section, the same shape, is read by the same validator and builder (the `strategy-actions` package) and each form carries the same instruction check, outside-the-router line and accounts; `aviary_actions` wins when a document has both.
- Alternatives: Ignoring the old section as Pipeline does, so such a strategy shows "No forms".
- Specified in: [`docs/spec/pipescope.md`, Custom-action and create-market forms](spec/pipescope.md#custom-action-and-create-market-forms)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: custom-action forms, the create-market page and a place for product panels](https://github.com/imDev2023/testing-pipeline/issues/123)

### PIPESCOPE-142: Forms on devnet while some metadata is valid

- Question: What does devnet show now that some strategies, our own among them, publish valid metadata?
- Answer: Every strategy with valid metadata shows its forms and every other one the unavailable state with its reason; the create-market page lists the create forms, and its no-valid-metadata line appears only while no strategy has valid metadata, which tests check on a database where none does.
- Alternatives: Keeping #123's devnet criterion as first written (every devnet strategy unavailable), which no longer holds.
- Specified in: [the ticket, Aviary: custom-action forms, the create-market page and a place for product panels](https://github.com/imDev2023/testing-pipeline/issues/123)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: custom-action forms, the create-market page and a place for product panels](https://github.com/imDev2023/testing-pipeline/issues/123)

### PIPESCOPE-143: How a form's instruction is checked

- Question: How does a form's result line decide whether the instruction it calls is in the deployed program?
- Answer: By the discriminator the form sends (the metadata's own, or Anchor's from its name), looked up in the instruction list of the strategy's current version; a pass names the instruction the program runs, with the metadata's own name beside it when that differs, and a warn says "what this form calls could not be checked" when no instruction has that discriminator or no list is recorded.
- Alternatives: Matching the metadata's instruction name against the list, which a label or name that lies about its discriminator would pass.
- Specified in: [`docs/spec/pipescope-architecture.md`, Trading path](spec/pipescope-architecture.md#trading-path)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: custom-action forms, the create-market page and a place for product panels](https://github.com/imDev2023/testing-pipeline/issues/123)

### PIPESCOPE-144: A new market's state keypair and its creator cap

- Question: Who makes and signs with a new market's fresh state keypair, and how much SOL may the strategy's setup take from the creator?
- Answer: The page makes the keypair for each review and signs with it after the API built and simulated the transaction, so no key reaches the API; `create_market` carries a cap of 0.1 SOL, `CREATE_MARKET_MAX_CREATOR_LAMPORTS` in `terminal-api`'s config module, and the simulation shows what the setup takes.
- Alternatives: The API making the keypair and signing first, which would put a key on the server; a cap the creator types.
- Specified in: [`docs/spec/pipescope-architecture.md`, Trading path](spec/pipescope-architecture.md#trading-path)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Aviary: custom-action forms, the create-market page and a place for product panels](https://github.com/imDev2023/testing-pipeline/issues/123)

### PIPESCOPE-145: SOL around a custom action, and who signs it

- Question: When does Aviary wrap and unwrap SOL around a custom action or a new market, and what may it ask to be signed?
- Answer: When the instruction writes to the wallet's own wrapped-SOL account, the sum of the amount arguments the metadata writes in wrapped SOL is moved into it before the instruction, and an account the wallet did not hold is created first and closed back into the wallet after it, in the same transaction, while one it already held is left as it was; an instruction that needs a signature from anyone but the wallet (and a new market's state) is refused before it is simulated.
- Alternatives: Leaving wrapped SOL to the user; wrapping for every action that names wrapped SOL anywhere.
- Specified in: [`docs/spec/pipescope-architecture.md`, Trading path](spec/pipescope-architecture.md#trading-path)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: custom-action forms, the create-market page and a place for product panels](https://github.com/imDev2023/testing-pipeline/issues/123)

### PIPESCOPE-146: The one-slot read for product panels

- Question: How does a product's panel read a market's state and the outside accounts it needs?
- Answer: `GET /v1/markets/{market}/state?accounts=` reads the market's state and at most 8 named accounts in one request at one slot, each account's data returned up to 64 KiB, `MARKET_READ` in `terminal-api`'s config module, so the public read is no general RPC on Aviary's key.
- Alternatives: Each panel asking the RPC itself; no limit on the accounts named.
- Specified in: [`docs/spec/pipescope-architecture.md`, API](spec/pipescope-architecture.md#api)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Aviary: custom-action forms, the create-market page and a place for product panels](https://github.com/imDev2023/testing-pipeline/issues/123)

### PIPESCOPE-147: Where a product's panel and forms go

- Question: Where does each of our products put its panel and its own forms in Aviary?
- Answer: In a registry in `terminal-web` (`apps/terminal-web/src/products/registry.ts`) keyed by the product's strategy program: its panel on the market page's lower band after the trades and before the explanation, its forms under Actions after the strategy's metadata forms, on that program's markets and nowhere else; empty until the products' Aviary tickets fill it.
- Alternatives: A page per product; panels chosen by the strategy's metadata, which anyone can write.
- Specified in: [`docs/spec/pipescope-screens.md`, Explanation, actions and facts](spec/pipescope-screens.md#explanation-actions-and-facts)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: custom-action forms, the create-market page and a place for product panels](https://github.com/imDev2023/testing-pipeline/issues/123)

### PIPESCOPE-148: The checks' order and plain names on the pages

- Question: In what order do the pages list Canary's checks, and by what names?
- Answer: In the prototype's order, what a trader most needs first, from Reading the market and Buy, then sell straight back to Pipeline's own conformance check and Instructions beyond Pipeline's own, with Supply held outside the pool, added after the prototype, beside Token authorities acting; each by the prototype's plain name, in one list in `terminal-api`'s `canaryView.ts` that serves each result with its name and in that order.
- Alternatives: The order of the checks in the Canary spec, which puts the conformance report second and the cost of a round trip eleventh; the check ids alone.
- Specified in: [`docs/spec/pipescope-screens.md`, Canary outcomes](spec/pipescope-screens.md#canary-outcomes)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Aviary: Canary's results on the pages and the trade box's exit-test notice](https://github.com/imDev2023/testing-pipeline/issues/125)

### PIPESCOPE-149: The phrase a row shows

- Question: What short phrase stands beside the one Canary result a row shows, and which return does a market of three or four mints show?
- Answer: A phrase `terminal-api` writes from the result's own numbers ("a 0.01 SOL round trip returned 48.6%", "buys of 1 SOL or more could not sell back"), or else the check's plain name; a market of three or four mints shows the return of the pair that returned least, and a strategy's row counts the markets its version cannot read, never outcomes.
- Alternatives: The result's whole sentence, too long for a row; the average of the pairs' returns, which hides the worst pair.
- Specified in: [`docs/spec/pipescope-screens.md`, What a row says about Canary](spec/pipescope-screens.md#what-a-row-says-about-canary)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Aviary: Canary's results on the pages and the trade box's exit-test notice](https://github.com/imDev2023/testing-pipeline/issues/125)

### PIPESCOPE-150: When the upgrade notice shows

- Question: When do the strategy page and its market pages carry "Upgraded on <date>; tests and explanation for this version are pending.", and what date does it name?
- Answer: While the strategy's current version has no Canary result of its own and an older version is recorded: on a market page created before the upgrade until that market has one (a market made since never saw the version before), on the strategy page until any of its markets has one; a market whose strategy has no version recorded yet reads as not run, never as a failure; the date is the day the upgrade's transaction landed, or the day Aviary first saw the version; the explanation's own part reads as pending until it exists (#127).
- Alternatives: Keeping the notice until the explanation exists too, which waits on the owner's approval of a paid call and could hold it for days after the tests are in.
- Specified in: [`docs/spec/pipescope-screens.md`, Explanation, actions and facts](spec/pipescope-screens.md#explanation-actions-and-facts)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: Canary's results on the pages and the trade box's exit-test notice](https://github.com/imDev2023/testing-pipeline/issues/125)

### PIPESCOPE-151: A stranded market's words, and Canary read with the page

- Question: When does a stranded market's page say it was left behind by an upgrade, and what happens when Canary's results cannot be read?
- Answer: It says so only when the market was created before its strategy's current version was deployed; Canary's results are read with the page, so the head, the trade box and the facts panel agree from the first paint, and when they cannot be read Canary's part says so with Try again and the trade box says it cannot repeat what Canary saw.
- Alternatives: The sentence on every stranded market, untrue for one created on a version that cannot read it; each panel reading Canary on its own, which can leave the trade box without its notice while the facts panel shows the fail.
- Specified in: [`docs/spec/pipescope-screens.md`, Markets that cannot trade](spec/pipescope-screens.md#markets-that-cannot-trade)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: Canary's results on the pages and the trade box's exit-test notice](https://github.com/imDev2023/testing-pipeline/issues/125)

### PIPESCOPE-152: Wrapped SOL on the wallet page

- Question: How does the wallet page show the wrapped SOL a wallet holds?
- Answer: Apart from the tokens it lists, as the offer to unwrap naming the amount, or the empty accounts whose rent comes back, which closes the wrapped-SOL accounts the wallet owns into it, as many as one transaction holds and the rest offered again after, simulated first and signed in the wallet; the wallet's SOL stands in the page's head.
- Alternatives: Listing wrapped SOL among the tokens that trade on Pipeline, beside the offer, which would show the same SOL twice; closing only the wallet's associated wrapped-SOL account, leaving any other.
- Specified in: [`docs/spec/pipescope-screens.md`, Wallet page](spec/pipescope-screens.md#wallet-page)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: hooked mints, markets of three or four mints, and the wallet page](https://github.com/imDev2023/testing-pipeline/issues/122)

### PIPESCOPE-153: What the wallet page lists as held

- Question: Which of a wallet's tokens does "What you hold that trades on Pipeline" list, and in what order?
- Answer: Every token it holds a non-zero balance of, in any of its token accounts under either token program, that a market Aviary has indexed trades, with each of those markets, newest first, ordered by the name the page shows; tokens no market trades are only counted, and empty token accounts are neither listed nor counted.
- Alternatives: Counting empty token accounts as tokens not listed; ordering by balance, which mixes tokens of different worth on devnet.
- Specified in: [`docs/spec/pipescope-screens.md`, Wallet page](spec/pipescope-screens.md#wallet-page)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: hooked mints, markets of three or four mints, and the wallet page](https://github.com/imDev2023/testing-pipeline/issues/122)

### PIPESCOPE-154: How a hooked mint's accounts are resolved

- Question: How does Aviary find the accounts a mint's transfer hook needs, and where does a swap carry them?
- Answer: In one module of `terminal-api` (`trading/hooks.ts`) for swaps and custom actions alike, each transfer resolved on its own from the mint's `ExtraAccountMetaList` by Token-2022's own client, every transfer the transaction makes in the mint covered (the trader's transfer and Pipeline's and the integrator's fees taken in it), each account once with the highest role any transfer gives it; a sell's go in the router's `input_hook_accounts`, a buy's after the strategy's own accounts, and a custom action's after its own, for the transfers both ways between the wallet's token account the action writes and the market's vault of each hooked mint; a refusal by the hook is named as the hook's, and a holder's CPI Guard or required memos are named as the holder's own settings.
- Alternatives: Pipeline's hosted API, which refuses to build swaps whose input mint has a transfer hook; resolving only the trader's transfer, which leaves out a hook whose accounts depend on the destination when Pipeline's fee is taken in the mint.
- Specified in: [`docs/spec/pipescope-architecture.md`, Trading path](spec/pipescope-architecture.md#trading-path)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: hooked mints, markets of three or four mints, and the wallet page](https://github.com/imDev2023/testing-pipeline/issues/122)

### PIPESCOPE-155: Trades of other pairs on a market of three or four mints

- Question: How does a market page's Trades table read a trade between two mints other than the pair on show?
- Answer: By the trade's own pair, as the API gives it with every trade: a Buy or a Sell of that pair's base mint, its price in that pair's quote mint, with the pair named under the price; a trade of the pair on show is read by that pair, flipped or not.
- Alternatives: Reading every trade against the pair on show, which counted any trade not paid in its quote mint as a Sell, at a price in mints the pair does not hold; leaving such trades out of the table.
- Specified in: [`docs/spec/pipescope-screens.md`, Trades](spec/pipescope-screens.md#trades)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: hooked mints, markets of three or four mints, and the wallet page](https://github.com/imDev2023/testing-pipeline/issues/122)

### PIPESCOPE-156: The wallet page's endpoints

- Question: Which endpoints serve the wallet page?
- Answer: `GET /v1/traders/{trader}/trades`, the feed's trader page with every mint it names; `GET /v1/traders/{trader}/holdings`, the wallet's SOL, wrapped SOL and token accounts read through RPC with each listed token's markets from Postgres; and `POST /v1/unwrap/prepare`, the unwrap built and simulated, whose signature `POST /v1/transactions` waits on as for a custom action; the prepare counts against the 60-a-minute limit of quotes and prepares (`PIPESCOPE-90`).
- Alternatives: Reading a wallet's balances from Pipeline's hosted API, which ADR 0003 ruled out; reading them in the browser, which would put an RPC key in the page.
- Specified in: [`docs/spec/pipescope-architecture.md`, API](spec/pipescope-architecture.md#api)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: hooked mints, markets of three or four mints, and the wallet page](https://github.com/imDev2023/testing-pipeline/issues/122)

### PIPESCOPE-157: The unwrap's signing check

- Question: How is the unwrap, a new signing flow, checked in a wallet?
- Answer: As the ticket asks, by the Playwright test wallet signing with a devnet key, here the project's devnet wallet, through the real page of the local run, as `PIPESCOPE-136` settled for the trade box; no real wallet extension in the owner's Chrome.
- Alternatives: `PIPESCOPE-94`'s run in a real wallet extension set to devnet, driven in the owner's Chrome, with screenshots.
- Specified in: [the ticket, Aviary: hooked mints, markets of three or four mints, and the wallet page](https://github.com/imDev2023/testing-pipeline/issues/122)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: hooked mints, markets of three or four mints, and the wallet page](https://github.com/imDev2023/testing-pipeline/issues/122)

### PIPESCOPE-158: Where an evidence chip points

- Question: Which fact row does an explanation's evidence chip highlight?
- Answer: A row of the evidence the explanation was given, listed under it in a closed disclosure, "The evidence it was given (N items)", each row its id, what it is, its value as the model read it and where Aviary read it; a chip opens the list, marks that row, brings it into view and moves the focus to it.
- Alternatives: A row of the live facts panel, which describes the chain as it is now rather than as the model read it, gives its rows no evidence ids, and has no rows for Pipeline's rules, Canary's roll-up or the author text.
- Specified in: [`docs/spec/pipescope-explainer.md`, Presentation](spec/pipescope-explainer.md#presentation)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: the explanation on the strategy and market pages](https://github.com/imDev2023/testing-pipeline/issues/127)

### PIPESCOPE-159: Which explanation a page shows

- Question: Which explanation does a strategy page or a market page show, and when does the notice about text addressed to AI tools show?
- Answer: The explanation of the key the strategy's current version has at the moment the page is read, worked out as the `explainerKeys` job works it out, once the approve command wrote it, and then the upgrade notice says only "tests for this version are pending"; otherwise "No explanation for this version yet.", and the notice about text addressed to AI tools whenever Aviary's detector finds such text in the current metadata or the shown explanation's own flag is set.
- Alternatives: The newest explanation recorded for the strategy, which would keep showing one written before its author text or its Canary outcomes changed.
- Specified in: [`docs/spec/pipescope-explainer.md`, Presentation](spec/pipescope-explainer.md#presentation)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: the explanation on the strategy and market pages](https://github.com/imDev2023/testing-pipeline/issues/127)

### PIPESCOPE-160: A "This is wrong" report

- Question: What does a "This is wrong" report carry, and what can be reported?
- Answer: A report is `POST /v1/explanations/{key}/reports` against any key that has an explanation, with an optional note of up to 600 characters (`REPORT_NOTE_MAX` in the API's config module), counted against the 10 reports a minute per address of `PIPESCOPE-90`; `pnpm explainer:reports` lists it with its key, the strategy version and the note.
- Alternatives: A report with no note; reports only against the version's current key, which would refuse a reader whose page was open while the key changed.
- Specified in: [`docs/spec/pipescope-explainer.md`, Presentation](spec/pipescope-explainer.md#presentation)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: the explanation on the strategy and market pages](https://github.com/imDev2023/testing-pipeline/issues/127)

### PIPESCOPE-161: How the explanation is set beside the facts

- Question: How is the explanation laid out beside the facts, and how is a point marked by its basis?
- Answer: On the strategy page the explanation sits beside the facts above 1080 px and above them at 1080 px and narrower, as on the market page; a point stated by the evidence has a solid bullet, an inferred one a hollow bullet and the word "inferred", and an author point a bullet and a sentence in the author's colour, upright since only Literata's upright face is served, with "the author's words" beside it, under a key to the three bullets.
- Alternatives: The facts above the explanation on phones; author points in italic, which the browser would have to fake.
- Specified in: [`docs/spec/pipescope-screens.md`, Strategy page](spec/pipescope-screens.md#strategy-page)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: the explanation on the strategy and market pages](https://github.com/imDev2023/testing-pipeline/issues/127)

### PIPESCOPE-162: A product's forms in place of the metadata's

- Question: May one of our products' own forms stand in for the strategy's metadata forms and its create form?
- Answer: Yes: a product names the metadata forms its own fill in (`replaces` in `apps/terminal-web/src/products/registry.ts`), which Actions then leaves out, and may give its own create form (`Create`), which the create-market page shows in place of the metadata's.
- Alternatives: Showing the metadata forms beside the product's, which repeats each action with raw inputs.
- Specified in: [`docs/spec/pipescope-screens.md`, Explanation, actions and facts](spec/pipescope-screens.md#explanation-actions-and-facts)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)

### PIPESCOPE-163: Strategy-program events

- Question: Does the indexer keep the events strategy programs log, and in what form?
- Answer: Yes: every `Program data:` line a strategy program writes itself in a successful transaction, whole, in `strategy_events` with the 32 bytes after its discriminator as its subject, for products to decode their own; the live path stores strategy calls and events as reconciliation does.
- Alternatives: Reading a market's history from the chain on each page view; decoding each product's events in the indexer.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)
### PIPESCOPE-164: A market's due keeper jobs

- Question: How does a product panel learn which keeper jobs are due on its market?
- Answer: `GET /v1/markets/{market}/keeper` reads the market's state, and any account its product's due rules watch, at one slot, asks `packages/keeper-jobs` what is due, and gives each unit with the keeper runner's latest record of it and, when every record since the runner last landed it is a hold, a park, a failure or a wait, the time of the first of them as how long it has been due; a market of another strategy has nothing due.
- Alternatives: Computing the due rules in the browser, which would put every product's client in the page; a time it fell due read from the chain's history, which the indexer does not keep per market.
- Specified in: [`docs/spec/pipescope-architecture.md`, API](spec/pipescope-architecture.md#api)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Buy wall AMM: Aviary panel and forms](https://github.com/imDev2023/testing-pipeline/issues/57)

### PIPESCOPE-165: Creating and seeding a market in one transaction

- Question: How does Aviary send a new market's seed with its creation, as Pipeline's guide recommends?
- Answer: `POST /v1/markets/prepare` takes an optional `seed`, the strategy's own add_liquidity action: `create_market`, `init_fee_account` for each mint and the seed in one transaction, the seed built against the market `create_market` would record, learnt by simulating `create_market` alone and reading the router's Market account; any strategy's metadata can use it.
- Alternatives: Seeding from the market page in a second transaction, which leaves a created market open to nobody until its seeder returns; product code that knows each strategy's vaults.
- Specified in: [`docs/spec/pipescope-architecture.md`, API](spec/pipescope-architecture.md#api)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Buy wall AMM: Aviary panel and forms](https://github.com/imDev2023/testing-pipeline/issues/57)


### PIPESCOPE-166: A new market opened in the transaction that creates it

- Question: How does a product's create form open its market in the same transaction that creates it?
- Answer: `POST /v1/markets/prepare` takes `then`, the new market's mints and vaults in order as the product's form works them out, and adds the router's `init_fee_account` for each mint and up to two actions of the strategy's metadata by name, each built against the market as it will be, with its own wrapped SOL; vaults not among the create form's accounts and mints it was not filled with are refused.
- Alternatives: A tax-AMM-only endpoint, which every product with a launch would repeat; the API working out the vaults from the metadata's account names, which no standard fixes.
- Specified in: [`docs/spec/pipescope-architecture.md`, Trading path](spec/pipescope-architecture.md#trading-path)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Tax AMM in Aviary: the launch form and the tax panel](https://github.com/imDev2023/testing-pipeline/issues/75)

### PIPESCOPE-167: Aviary's own address lookup table

- Question: How does a transaction too large as a legacy one fit when its market has recorded no lookup table, as a new market never has?
- Answer: Aviary keeps one frozen lookup table per cluster of the accounts transactions pass and do not invoke (the router's event authority and config, wrapped SOL, the cluster's USDC, Token-2022, the rent sysvar and every strategy's record when it was made), named by `AVIARY_LOOKUP_TABLE`, on devnet `3s6YeCtZRoQ3i9MBTRUE5dQn6uvC7AK6qFr8B6oWZsyz`, and every prepared transaction may use it beside the market's own.
- Alternatives: A table per launch made by the creator first, which is a second transaction; a table Aviary keeps extending, which would need a key Aviary holds.
- Specified in: [`docs/spec/pipescope-architecture.md`, Trading path](spec/pipescope-architecture.md#trading-path)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-24 in [Tax AMM in Aviary: the launch form and the tax panel](https://github.com/imDev2023/testing-pipeline/issues/75)

### PIPESCOPE-168: Liquidity from a strategy's own reserves

- Question: What liquidity does Aviary show for a market whose vaults hold more than its liquidity?
- Answer: The strategy's own reserve of each mint, read by the indexer from the market state at the slot it reads the vaults, by a reader keyed by the strategy's program (`packages/terminal-indexer/src/reserves.ts`), kept beside what the vault holds; the feed, the facts, Canary's part and the feed's liquidity filter show and filter on it where there is one, else on what the vault holds.
- Alternatives: Reading the reserves only on the tax panel, which would leave the feed and the facts showing tax owed as liquidity; computing them when a page is served, which the feed's filter cannot do in SQL.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Tax AMM in Aviary: the launch form and the tax panel](https://github.com/imDev2023/testing-pipeline/issues/75)

## Canary checks (CANARY)

### CANARY-01: What Canary claims

- Question: What do Canary checks claim about a market?
- Answer: Only what they observed: they trade a private copy of one market the way a trader would and record what happened, for one market, one strategy version and one slot; they detect and cannot prove a market safe.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, What Canary is](spec/pipescope-canary.md#what-canary-is)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-02: Coverage

- Question: Which strategies and markets does Canary cover?
- Answer: Every strategy and every market registered with the router, not a chosen list.
- Alternatives: Only the four strategies on devnet when the ticket was written.
- Specified in: [`docs/spec/pipescope-canary.md`, What Canary is](spec/pipescope-canary.md#what-canary-is)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-03: Pipeline's own checker and flags

- Question: How does Canary relate to Pipeline's trust flags and `pipeline-check`?
- Answer: It builds on both and repeats neither: it runs `pipeline-check` unchanged on every market copy and keeps the report as one result, the conformance report, and it reuses the trust flags for token facts.
- Alternatives: Checks of our own in place of Pipeline's.
- Specified in: [`docs/spec/pipescope-canary.md`, Three layers, and what each one sees](spec/pipescope-canary.md#three-layers-and-what-each-one-sees)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-04: How a run trades

- Question: How does a Canary run copy and trade a market?
- Answer: It builds a copy of the market in a local Solana VM from the cluster's own program bytes with `pipeline-check`'s cloner, with signature checks off so it can act as any key; every trade goes through the router's real `swap` and is committed, each swap is compared with a quote taken just before it, and each scenario starts from a fresh copy.
- Alternatives: The quoter's `simulate_swap`, which never commits state and so cannot buy and then sell.
- Specified in: [`docs/spec/pipescope-canary.md`, How a run works](spec/pipescope-canary.md#how-a-run-works)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-05: Money side

- Question: Which side of a market does Canary spend and count in?
- Answer: The money side: wrapped SOL when the market has it, otherwise the mint whose vault holds the smallest share of that mint's supply; sizes are always set on it, and a sale only sells what a buy in the same run produced.
- Alternatives: Sizing sales by a share of the token vault, which sold tokens that could not exist and gave false alarms.
- Specified in: [`docs/spec/pipescope-canary.md`, The money side and sizes](spec/pipescope-canary.md#the-money-side-and-sizes)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-06: Sizes with wrapped SOL

- Question: Which sizes does Canary trade in a market with wrapped SOL?
- Answer: 0.00001, 0.001, 0.01, 0.1, 1 and 10 SOL, with 0.01 SOL as the reference size.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, The money side and sizes](spec/pipescope-canary.md#the-money-side-and-sizes)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-07: Sizes without wrapped SOL

- Question: Which sizes does Canary trade in a market without wrapped SOL?
- Answer: 1, 100, 1,000, 10,000 and 50,000 parts per million of the money vault, with 1,000 as the reference size; when that vault holds under 2,000,000 units, 0.01, 0.1, 1, 10 and 100 whole tokens, with 1 token as the reference size.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, The money side and sizes](spec/pipescope-canary.md#the-money-side-and-sizes)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-08: Waits

- Question: After which waits does Canary sell or trade again?
- Answer: The same slot, the next slot, 10 seconds, 1 minute, 10 minutes, 1 hour, 1 day, 3 days and 30 days.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, Clock positions](spec/pipescope-canary.md#clock-positions)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-09: Launch clock

- Question: How does Canary test rules that depend on a market's launch time?
- Answer: It sets the clock back to the market's creation time and to 10 seconds, 1 minute, 10 minutes, 1 hour and 1 day after it, against today's state, so the figures show the strategy's time rules and not what early buyers got.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, Clock positions](spec/pipescope-canary.md#clock-positions)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-10: Outcomes

- Question: What outcomes can a Canary result have?
- Answer: One of five (pass, warn, fail, not run or noted), always with the number behind it and a code-written sentence giving the reason; outcomes are never added up into a score, a badge or a colour.
- Alternatives: Numbers only, with no outcome words.
- Specified in: [`docs/spec/pipescope-canary.md`, Outcomes](spec/pipescope-canary.md#outcomes)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-11: What can fail

- Question: Which findings count as a fail?
- Answer: Only what the ordinary trade meets right now: a buy of the reference size or the smallest size at the cluster's current clock, sold back in the same slot or the next; anything that depends on another time, a larger size or an authority choosing to act is at most a warn.
- Alternatives: A fail for conditional findings too; a fail for some of them and a warn for others.
- Specified in: [`docs/spec/pipescope-canary.md`, Outcomes](spec/pipescope-canary.md#outcomes)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-12: Round-trip return bands

- Question: What round-trip return passes, warns and fails?
- Answer: 95% or more back is a pass, 50% up to 95% is a warn, and under 50% is a fail.
- Alternatives: A fail under 80% in place of 50%.
- Specified in: [`docs/spec/pipescope-canary.md`, Outcomes](spec/pipescope-canary.md#outcomes)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-13: Tolerance over time

- Question: How much may a round trip's return differ at another time before it is a warn?
- Answer: Over 1 point less than in the same slot, or than now, is a warn.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, Exit test](spec/pipescope-canary.md#exit-test)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-14: How a failure is named

- Question: How does Canary name a failed step?
- Answer: By its class (cannot read state, strategy refused, router refused, token program refused, crash or out of compute) with the program that raised it and the error's own name and message; a crash or an out-of-compute is at least a warn.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, How a failure is named](spec/pipescope-canary.md#how-a-failure-is-named)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-15: The checks

- Question: Which checks does Canary run?
- Answer: Seventeen, with stable ids: `readable`, `conformance`, `exit_sizes`, `exit_hold`, `exit_late`, `exit_launch_clock`, `exit_wallets`, `exit_transferred`, `exit_queue`, `quote_matches_swap`, `cost`, `direct_call`, `token_authorities`, `transaction_accounts`, `contained_mint`, `outside_supply` (since 2026-11-23, `CANARY-47`) and `custom_instructions`.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, The checks](spec/pipescope-canary.md#the-checks)
- Changes by: spec only
- Status: changed 2026-11-23
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-16: Wallets

- Question: From which wallets does Canary trade?
- Answer: Five fresh wallets, the market creator, the strategy's upgrade authority and each mint authority, each from the same starting state, and a queue of five buyers who sell in the order they bought, judged on their total.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, Exit test](spec/pipescope-canary.md#exit-test)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-17: Token authorities acting

- Question: What does Canary do with a mint's authorities?
- Answer: It acts as each one that is a wallet and trades again: minting 100 times the vault's holding and selling it, freezing the buyer's account, setting the transfer fee to 100%, moving the buyer's tokens as permanent delegate, or pausing the mint; the result is at most a warn.
- Alternatives: Reporting only that an authority exists, as the trust flags do.
- Specified in: [`docs/spec/pipescope-canary.md`, Control](spec/pipescope-canary.md#control)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-18: Custom instructions

- Question: Does Canary call a strategy's custom instructions?
- Answer: No: it lists every instruction beyond Pipeline's six, with how often each has been called and by which signers, and does not call them.
- Alternatives: Replaying them as well, which needs each strategy's argument layout; leaving them out.
- Specified in: [`docs/spec/pipescope-canary.md`, Custom instructions are listed, not called](spec/pipescope-canary.md#custom-instructions-are-listed-not-called)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-19: The upgrade authority's power

- Question: Does Canary test what an upgrade could do?
- Answer: No: an upgradeable program can become anything, so every result holds for one strategy version and the facts panel says the program can be upgraded.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, What Canary does not do](spec/pipescope-canary.md#what-canary-does-not-do)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-20: Records

- Question: What does Aviary keep of each Canary run?
- Answer: One record per check per market with its inputs, outcome, reason and numbers, a roll-up per strategy version, the latest record of each check per market and version, and every earlier record whose outcome differed from the one after it.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, Records](spec/pipescope-canary.md#records)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-21: What counts as "could not sell back"

- Question: Which Canary result puts the notice in the trade box?
- Answer: Any latest result of `exit_sizes`, `exit_hold`, `exit_wallets`, `exit_transferred` or `exit_queue` for the current strategy version in which a buy worked and the sale of what it bought failed, whether a fail or a warn, with its condition stated; a low return or a result about another time does not count.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, What counts as "a buyer could not sell back"](spec/pipescope-canary.md#what-counts-as-a-buyer-could-not-sell-back)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-22: Runs started by events

- Question: Which events start a Canary run?
- Answer: A new strategy version (every market of that strategy), a router upgrade (every market), and a market being created or registered (that market at once, then 10 minutes, 1 hour and 1 day later).
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, When Canary runs](spec/pipescope-canary.md#when-canary-runs)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-23: Scheduled sweep

- Question: How often is every market re-checked on a schedule?
- Answer: Every 6 hours.
- Alternatives: Every hour; once a day.
- Specified in: [`docs/spec/pipescope-canary.md`, When Canary runs](spec/pipescope-canary.md#when-canary-runs)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-24: Where Canary runs

- Question: Where do Canary checks run?
- Answer: As a native Rust binary in a Cloudflare Container on a `basic` instance with internet access off, driven by one Durable Object per strategy version that builds the RPC snapshot and posts it in.
- Alternatives: A WASM build inside a Worker, which could not run the router swap; a small server elsewhere, kept as the fallback.
- Specified in: [`docs/adr/0005-canary-checks-run-natively-in-a-container.md`, Canary checks run natively in a Cloudflare Container](adr/0005-canary-checks-run-natively-in-a-container.md#canary-checks-run-natively-in-a-cloudflare-container)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### CANARY-25: Snapshots

- Question: How does the container get chain data without a network?
- Answer: The Durable Object posts one snapshot a market; when a trade names an account the snapshot lacks, the binary answers with the missing addresses and the snapshot is posted again, at most four times, after which the affected checks are "not run".
- Alternatives: Giving the container an RPC key and network access.
- Specified in: [`docs/spec/pipescope-canary.md`, How a run works](spec/pipescope-canary.md#how-a-run-works)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14)

### CANARY-26: Licence seam

- Question: Can Canary run in production without executing the router's BSL-licensed code?
- Answer: Yes: every trade in the checks goes through one swap function with two implementations, through the router on devnet or calling the strategy directly plus Pipeline's Apache-2.0 settlement code, so production can switch without a rewrite; only the conformance report then becomes "not run".
- Alternatives: Relying on the router's `simulate_swap` in production, which would need a use grant.
- Specified in: [`docs/spec/pipescope-architecture.md`, Canary runner](spec/pipescope-architecture.md#canary-runner)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Record MetalLegBob's answers to the follow-up DM](https://github.com/imDev2023/testing-pipeline/issues/27)

### CANARY-27: A refused wallet-to-wallet transfer

- Question: How does Canary report a bought token that cannot be sent to a second wallet?
- Answer: As a warn, for any token, stating that the token could not be sent to another wallet and what the buyer got back by selling it; `exit_transferred` fails only when a transferred token cannot then be sold, and a refusal never raises the trade box's notice.
- Alternatives: A warn only when the hook is ours, which would exempt our own product; keeping the fail and writing an exception into the bar.
- Specified in: [`docs/spec/pipescope-canary.md`, Exit test](spec/pipescope-canary.md#exit-test)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### CANARY-28: Canary's config module

- Question: Where do Canary's policy values live in code?
- Answer: As named constants in `crates/canary/src/config.rs`: sizes, waits, launch-clock offsets, clock rates, the pass and fail bands, the tolerance, wallet counts, the token authorities' actions, compute limits and snapshot rounds; a change to any of them changes the `harness` version on every result.
- Alternatives: Values written in each check's code.
- Specified in: [`docs/spec/pipescope-canary.md`, One place for every value](spec/pipescope-canary.md#one-place-for-every-value)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### CANARY-29: A contained token after its unlock

- Question: What does `contained_mint` report for a mint whose transfer hook extension remains with both its program and its authority unset, as a contained token's does after its unlock?
- Answer: "Not run", as for a mint with no hook, never a warn for a hook that is not ours.
- Alternatives: Treating the empty extension as a hook that is not ours, a warn.
- Specified in: [`docs/spec/pipescope-canary.md`, Control](spec/pipescope-canary.md#control)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### CANARY-30: The endpoint's snapshot and answer

- Question: What does the container's endpoint take and answer, and how does the binary know a round is the last?
- Answer: `POST /run` takes one market's snapshot (the market, the round from 1, the cluster's clock and every account read by address, `null` where the cluster has none, so an address absent from the snapshot is one it lacks) and answers with one record per check or with exactly the addresses a trade named that the snapshot lacks; at round `SNAPSHOT_ROUNDS` it answers with records whatever it lacks.
- Alternatives: The Durable Object counting rounds and sending a separate "last" flag; a second endpoint for the last round.
- Specified in: [`crates/canary/README.md`, Run it](../crates/canary/README.md#run-it)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)

### CANARY-31: Which checks an account the snapshot lacks affects

- Question: When a snapshot lacks accounts at the last round, which checks are "not run"?
- Answer: Every check when the copy itself lacked them; otherwise only the checks whose trades named them: `readable` for its probes, and `exit_sizes`, `quote_matches_swap` and `cost`, which share the size ladder's trades; each such record names the accounts.
- Alternatives: Every check whenever anything is lacking.
- Specified in: [the ticket, Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)

### CANARY-32: Readability's probes in every direction

- Question: What does `readable` quote in a direction whose input is not the money side?
- Answer: What the smallest buy of that mint would deliver, so the probe only sells what a buy produced, or one unit when that buy quotes nothing.
- Alternatives: A share of that mint's vault, as the prototype did.
- Specified in: [the ticket, Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)

### CANARY-33: A market that refuses every trade

- Question: When are a market's trading checks "not run" because it refuses every trade?
- Answer: When every direction's probe is refused cleanly; when a probe crashes or runs out of compute the trading checks still run, because a swap that works without a quote is itself a finding.
- Alternatives: "Not run" whenever no direction quotes.
- Specified in: [the ticket, Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)

### CANARY-34: Where `cost` reads Pipeline's fee

- Question: Where does `cost` take Pipeline's fee from, given that the router's config account holds no fee?
- Answer: From what the router charged in the copy, the `pipeline_fee` of each swap's return data, in the mint the router reports it took it in (`fee_mint`, Pipeline 0.3): as charged when that is the money side, as on a sale into wrapped SOL, and valued at the sale's own price (what arrived per token, before any fee taken from it) when it is the token; no fee rate is written in Canary.
- Alternatives: The earlier default, the sale's fee always charged in the token and valued at the sale's price, which Pipeline 0.3 made wrong on every market that trades wrapped SOL; The fee rate of `pipeline-strategy-interface` (`PIPELINE_FEE_BPS`), which would hide a router that charged differently.
- Specified in: [`docs/spec/pipescope-canary.md`, Fee honesty](spec/pipescope-canary.md#fee-honesty)
- Changes by: spec only
- Status: changed 2026-11-22
- Decided: 2026-11-12 in [Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)

### CANARY-35: Compute limit of the read-only calls

- Question: What compute limit do `pipeline_market_info` and account resolution run under?
- Answer: The quote's limit, `QUOTE_COMPUTE_LIMIT` (200,000 units), as an integrator's quoter runs them; running out of it is "out of compute".
- Alternatives: The swap's limit, 1,400,000 units, as `pipeline-check`'s cloner resolves accounts.
- Specified in: [the ticket, Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)

### CANARY-36: Wallets from a seed chosen per run

- Question: How are a run's new random wallets made, so that a snapshot's later rounds can supply accounts derived from them?
- Answer: Each wallet comes from a seed chosen at random once per run; the endpoint's first answer carries the seed and every later round of that run is posted with it, so the rounds trade from the same wallets while no strategy can know Canary's wallets in advance.
- Alternatives: A new random key per trade, whose derived accounts no later round could supply; wallets derived from the market and the size, which a strategy could compute and treat differently.
- Specified in: [`crates/canary/README.md`, Run it](../crates/canary/README.md#run-it)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)

### CANARY-37: A transferred token's return when the buyer's is low too

- Question: How does `exit_transferred` judge a second wallet's return below the pass band when the buyer's own return from the same round trip is below it too?
- Answer: By the tolerance: a warn when the second wallet's return is more than `TOLERANCE_PPM` (1 point) below the buyer's own, otherwise a pass, because the low return is the market's own and `cost` reports it.
- Alternatives: A warn whenever the second wallet's return is below the pass band; a pass whenever the buyer's own is below it too.
- Specified in: [`docs/spec/pipescope-canary.md`, Exit test](spec/pipescope-canary.md#exit-test)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary over time and across wallets (holding, later, launch clock, insiders, transferred tokens, a queue of buyers)](https://github.com/imDev2023/testing-pipeline/issues/114)

### CANARY-38: Each exit record says whether it counts as "could not sell back"

- Question: How does the trade box know which exit records count as "a buyer could not sell back"?
- Answer: Every exit record carries `could_not_sell_back` in its numbers, true exactly when a wallet's buy worked and the sale of what it bought then failed in that record, never for a refused wallet-to-wallet transfer alone, and always false in `exit_late` and `exit_launch_clock`.
- Alternatives: The terminal working the condition out from each check's numbers.
- Specified in: [`docs/spec/pipescope-canary.md`, What counts as "a buyer could not sell back"](spec/pipescope-canary.md#what-counts-as-a-buyer-could-not-sell-back)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary over time and across wallets (holding, later, launch clock, insiders, transferred tokens, a queue of buyers)](https://github.com/imDev2023/testing-pipeline/issues/114)

### CANARY-39: What makes an insider a program's address

- Question: When is a market creator, upgrade authority or mint authority a program's address that `exit_wallets` skips and names, rather than a wallet it trades as?
- Answer: When the key is off the Ed25519 curve (a program-derived address), is a program, or is an account a program other than the System Program holds; each skip names the role, the address and which of the three it is.
- Alternatives: Only an account a program holds, as the prototype skipped, which would trade as a program-derived address that has no account.
- Specified in: [`docs/spec/pipescope-canary.md`, Exit test](spec/pipescope-canary.md#exit-test)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary over time and across wallets (holding, later, launch clock, insiders, transferred tokens, a queue of buyers)](https://github.com/imDev2023/testing-pipeline/issues/114)

### CANARY-40: What the checks over time and across wallets trade and compare with

- Question: Which amount do `exit_hold`, `exit_late`, `exit_launch_clock`, `exit_wallets`, `exit_transferred` and `exit_queue` trade, and what is "now" for the checks over time?
- Answer: The reference size, or the largest size that stood in for it in `exit_sizes`, named as a stand-in; each check over time measures its own round trip at the cluster's clock and judges every other position against it, and a market whose launch-clock positions are all still ahead is "not run" in `exit_launch_clock`.
- Alternatives: Comparing with `exit_sizes`'s reference row, which a different wallet traded.
- Specified in: [`docs/spec/pipescope-canary.md`, Exit test](spec/pipescope-canary.md#exit-test)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary over time and across wallets (holding, later, launch clock, insiders, transferred tokens, a queue of buyers)](https://github.com/imDev2023/testing-pipeline/issues/114)

### CANARY-41: The exit checks' swaps in `quote_matches_swap`

- Question: Which of the swaps the exit checks commit does `quote_matches_swap` compare, and which of them are the ordinary trade, whose differences fail?
- Answer: Every swap of every exit check; the ordinary trade is a swap of the reference size by a fresh wallet in the copy's own state at the cluster's clock or the next slot, and any other swap's difference is a warn.
- Alternatives: Only `exit_sizes`'s swaps, as the first Canary ticket compared.
- Specified in: [`docs/spec/pipescope-canary.md`, Quote against swap](spec/pipescope-canary.md#quote-against-swap)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary over time and across wallets (holding, later, launch clock, insiders, transferred tokens, a queue of buyers)](https://github.com/imDev2023/testing-pipeline/issues/114)

### CANARY-42: Which checks an account the snapshot lacks affects, over time and across wallets

- Question: When the last snapshot still lacks an account that one of the checks over time and across wallets named, which checks are "not run"?
- Answer: That check, every check over time and across wallets when `exit_sizes`'s trades named it (they trade its reference amount), and `quote_matches_swap`, which compares every swap; the record names the accounts, as `CANARY-31` does for the others.
- Alternatives: Every check whenever anything is lacking.
- Specified in: [the ticket, Aviary: Canary over time and across wallets (holding, later, launch clock, insiders, transferred tokens, a queue of buyers)](https://github.com/imDev2023/testing-pipeline/issues/114)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary over time and across wallets (holding, later, launch clock, insiders, transferred tokens, a queue of buyers)](https://github.com/imDev2023/testing-pipeline/issues/114)
### CANARY-43: Which token authority is a wallet

- Question: When does `token_authorities` act as an authority, and when is it a program's address that is "not run"?
- Answer: By the rule `exit_wallets` uses for insiders (`CANARY-39`): a key off the Ed25519 curve, a program, or an account a program holds, such as a market's own state or an SPL multisig, is "not run", naming the owner program; any other authority is a wallet Canary acts as.
- Alternatives: Acting as every authority, which the copy's switched-off signature checks would allow even for addresses only a program can sign for; signing as an SPL multisig's members.
- Specified in: [`docs/spec/pipescope-canary.md`, Control](spec/pipescope-canary.md#control)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's control checks, token authorities acting, and transfer-hook accounts](https://github.com/imDev2023/testing-pipeline/issues/115)

### CANARY-44: Authorities of the money side's mint

- Question: How does `token_authorities` act as an authority of the money side's mint, which the trader spends rather than holds?
- Answer: In the same round trip as for a token: freezing the buyer's account or pausing the mint between the buy and the sale, setting the transfer fee before the buy, and, as permanent delegate, taking what the sale returned; a mint authority sells what it minted into each other mint, each sale from the same state.
- Alternatives: Acting only as the authorities of the mints a trader buys.
- Specified in: [`docs/spec/pipescope-canary.md`, Control](spec/pipescope-canary.md#control)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's control checks, token authorities acting, and transfer-hook accounts](https://github.com/imDev2023/testing-pipeline/issues/115)

### CANARY-45: What the direct swap refuses

- Question: Which of the router's rules does the swap implementation that calls the strategy directly keep?
- Answer: Those a trader can meet: a trader account that is not a token account of its mint, a swap that lowers the trader's output balance (`OutputDecreased`, since Pipeline `3fd85ce`), and every refusal of Pipeline's settlement code, named in that code's words since the router's error numbers are not published under Apache-2.0; any refusal undoes the swap, and the strategy runs one call level higher than under the router. The router has had no pause since Pipeline 0.2.0.
- Alternatives: The earlier default, with a paused router among the refusals, before Pipeline 0.2.0 removed the pause and `3fd85ce` added the output-balance rule; settling without the router's rules, so a swap the router refuses would look tradable.
- Specified in: [`docs/spec/pipescope-canary.md`, Built on](spec/pipescope-canary.md#built-on)
- Changes by: spec only
- Status: changed 2026-11-19
- Decided: 2026-11-12 in [Aviary: Canary's control checks, token authorities acting, and transfer-hook accounts](https://github.com/imDev2023/testing-pipeline/issues/115)

### CANARY-46: The instruction list in the snapshot

- Question: How does `custom_instructions` get the list `terminal-api` works out, and what does it do without one?
- Answer: The snapshot's optional `instructions` field carries whether the program is built with Anchor and each instruction's name, call count and signers; Canary drops Pipeline's six by name, notes the rest, and records "not run" when the field is absent.
- Alternatives: The binary working the list out from the program's bytes, which `PIPESCOPE-92` rules out.
- Specified in: [`docs/spec/pipescope-canary.md`, Custom instructions are listed, not called](spec/pipescope-canary.md#custom-instructions-are-listed-not-called)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's control checks, token authorities acting, and transfer-hook accounts](https://github.com/imDev2023/testing-pipeline/issues/115)

### CANARY-47: Supply outside the pool

- Question: How does Canary's `outside_supply` (`HOOK-50`) tell when supply held outside a market's pool could be sold into the real quote buyers paid in, and on which markets?
- Answer: On every market, by one rule: after the ordinary buy, the part of the supply outside the pool (supply less the market's vault) that the market cannot buy back, sold first, takes `OUTSIDE_SUPPLY_WARN_PPM` (1 point) or more of the quote vault, a warn; the part is what is left once the largest sale of the outside supply that quotes, found in up to `OUTSIDE_SUPPLY_SEARCH_STEPS` (20) halvings, is taken out, a quote paying out more than the quote vault really holds counting as refused. Only supply that never came out of the pool, on a market that never pays out more than its real quote (a virtual reserve), is left over, so a market seeded with the whole supply or with an all-real quote passes; 1 point, the tolerance's size, keeps rounding dust from warning while the containment launch's default 20% takes all but dust of a buyer's quote.
- Alternatives: Warning on a share of the quote vault the whole outside supply takes, which would warn on every traded market on a virtual reserve because buyers' own tokens are outside its pool too; checking only markets known to have a virtual reserve, which Canary cannot read without each strategy's own layout and which would exempt the strategies it does not know.
- Specified in: [`docs/spec/pipescope-canary.md`, Control](spec/pipescope-canary.md#control)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### CANARY-48: A new market's later runs

- Question: When are a new market's runs 10 minutes, 1 hour and 1 day later counted from?
- Answer: From the market's creation, so a market the indexer finds late, as its first backfill finds every market, runs once at once and then only at the times still ahead.
- Alternatives: Counting from when the indexer found it, which would run every old market four times after a backfill.
- Specified in: [`docs/spec/pipescope-canary.md`, When Canary runs](spec/pipescope-canary.md#when-canary-runs)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-23 in [Aviary: Canary in a Container, run by CanaryRun, with results in Postgres](https://github.com/imDev2023/testing-pipeline/issues/124)

## Explainer (EXPLAINER)

### EXPLAINER-01: What the explainer may say

- Question: What may the explainer say?
- Answer: Only what its evidence shows: it narrates the evidence it is given beside the code-rendered facts panel, which stays the source of truth, and code checks its output before anyone sees it.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-explainer.md`, What the explainer is](spec/pipescope-explainer.md#what-the-explainer-is)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-02: What the model call can reach

- Question: What can the model call reach?
- Answer: Nothing: it has no tools, no browsing, no secrets and no actions, reads a prepared input and returns JSON, so a successful injection can only change words.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-explainer.md`, What the explainer is](spec/pipescope-explainer.md#what-the-explainer-is)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-03: One explanation per strategy version

- Question: What does one explanation describe?
- Answer: One strategy version, not one market: market-level facts come from one representative market, the one with the most swaps through Pipeline, and are worded as "the sampled market".
- Alternatives: An explanation per market.
- Specified in: [`docs/spec/pipescope-explainer.md`, What the explainer is](spec/pipescope-explainer.md#what-the-explainer-is)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-04: When an explanation is made

- Question: When is a new explanation made?
- Answer: Once per key (the program, the strategy version, the hash of the author text, the hash of the Canary outcomes, the prompt version and the model); a page view never makes one, and traders cannot ask for one.
- Alternatives: Explanations on demand.
- Specified in: [`docs/spec/pipescope-explainer.md`, When an explanation is made](spec/pipescope-explainer.md#when-an-explanation-is-made)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-05: Approval queue

- Question: Who starts the paid model calls?
- Answer: The owner: new keys wait in a queue with an estimated cost, and the owner approves them in one go with one command on their Mac, which also writes the spend ledger; nothing paid runs on its own, and there is no admin page.
- Alternatives: Running automatically for every new version under a spending cap approved once.
- Specified in: [`docs/spec/pipescope-explainer.md`, Approval queue](spec/pipescope-explainer.md#approval-queue)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-06: Where generation runs

- Question: Where does the explainer's model call run?
- Answer: On the owner's Mac, through `pnpm explainer:approve`, from evidence the API built and stored with the key; no LLM key is in Cloudflare, so nothing paid can run from the deployed product.
- Alternatives: A Workflow in Cloudflare with the LLM key in its Secrets Store.
- Specified in: [`docs/spec/pipescope-architecture.md`, Explainer jobs](spec/pipescope-architecture.md#explainer-jobs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

### EXPLAINER-07: Evidence

- Question: What evidence does the model receive?
- Answer: Items with ids in five groups: P (Pipeline's fixed rules), F (chain facts), C (Canary results), S (source excerpts, only when the build is verified) and A (author text, untrusted).
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-explainer.md`, Inputs](spec/pipescope-explainer.md#inputs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-08: Author text

- Question: How is a strategy author's text handled before the model sees it?
- Answer: It is normalised in code: control and text-direction characters stripped, the name capped at 64 characters, the description at 600 and each action label at 64, images dropped and links neither passed on nor fetched; each action's discriminator is cross-checked against the program's instructions.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-explainer.md`, Inputs](spec/pipescope-explainer.md#inputs)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-09: Pipeline's trust facts and metadata standard

- Question: Does the explainer use Pipeline's trust facts and metadata standard or its own?
- Answer: Pipeline's: program and mint facts are computed with `pipeline-client`, metadata is validated with its parser, a metadata `source` is only a lead for a verified build, and `security.audits` and `conformance` links stay untrusted author text.
- Alternatives: A fact table with flag names of our own.
- Specified in: [`docs/spec/pipescope-explainer.md`, Pipeline's trust facts and metadata standard](spec/pipescope-explainer.md#pipelines-trust-facts-and-metadata-standard)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-10: The prompt

- Question: What is the model told?
- Answer: The system prompt `explainer-v0`, word for word as in the spec; any change to its text is a new prompt version, which makes new explanations.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-explainer.md`, The prompt, version `explainer-v0`](spec/pipescope-explainer.md#the-prompt-version-explainer-v0)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-11: No verdicts, scores or advice

- Question: Which words and claims may an explanation never contain?
- Answer: No verdicts, scores, advice, price predictions or links, and none of the banned terms (safe, secure, audit, trustworthy, legit, scam, rug, honeypot, guarantee, recommend, certified, vetted, approved and their variants).
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-explainer.md`, The prompt, version `explainer-v0`](spec/pipescope-explainer.md#the-prompt-version-explainer-v0)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-12: Length limits

- Question: How long may an explanation be?
- Answer: A summary of 2 to 3 sentences and at most 70 words, at most 14 claims of at most 45 words each, and at most 6 unknowns of at most 35 words each.
- Alternatives: Shorter; more explanatory.
- Specified in: [`docs/spec/pipescope-explainer.md`, The validator](spec/pipescope-explainer.md#the-validator)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-13: The validator

- Question: What must an output pass before it is shown?
- Answer: Eight checks in code: every sentence cites an id that exists, every number, date and address appears in the cited evidence, the text is plain, no banned term or advice appears, author and inferred claims are marked, the limits hold and the schema matches; on a failure it retries once with the errors, and otherwise the page shows the facts alone.
- Alternatives: A second model as a screen, which would double the paid calls.
- Specified in: [`docs/spec/pipescope-explainer.md`, The validator](spec/pipescope-explainer.md#the-validator)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-14: Text addressed to AI

- Question: What happens when a strategy's metadata addresses AI tools?
- Answer: Aviary shows a fixed sentence saying so, when either the model's flag or its own pattern detector fires, even when no explanation is shown.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-explainer.md`, The validator](spec/pipescope-explainer.md#the-validator)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-15: Presentation

- Question: How is an explanation laid out?
- Answer: Presentation A, short first: a code-written label, the summary with evidence chips, the unknowns always visible, the full list of points one click away, and a "This is wrong" control, all rendered as plain text beside the facts panel.
- Alternatives: Presentation B, sections; presentation C, a ledger.
- Specified in: [`docs/spec/pipescope-explainer.md`, Presentation](spec/pipescope-explainer.md#presentation)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-16: The label

- Question: How is an explanation labelled?
- Answer: By a code-written line above it naming the date, the inputs and the version slot, saying it was written by an AI, can be wrong, and is not an audit, a safety rating or advice.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-explainer.md`, Presentation](spec/pipescope-explainer.md#presentation)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-17: Tone

- Question: In what tone is an explanation written?
- Answer: Neutral, short, plain sentences with "you" for the trader, saying what the code and accounts allow and never what anyone intends, with what the evidence does not settle listed and never guessed.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-explainer.md`, Tone and length](spec/pipescope-explainer.md#tone-and-length)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-18: Model

- Question: Which model writes explanations?
- Answer: `claude-haiku-5-5`, with structured outputs and adaptive thinking at high effort, at under $0.01 an explanation; if any input fails the validator twice on the first paid run, the owner decides whether to move to a larger model.
- Alternatives: Opus 5.5; Sonnet 5.5.
- Specified in: [`docs/spec/pipescope-explainer.md`, Model and cost](spec/pipescope-explainer.md#model-and-cost)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-19: Testing

- Question: How is the explainer tested without paying for model calls?
- Answer: CI runs the validator on recorded outputs with no model call: the recorded samples must pass and every hostile fixture's bad output must fail; a live evaluation runs only when the owner approves it.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-explainer.md`, Testing](spec/pipescope-explainer.md#testing)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15)

### EXPLAINER-20: Where explanations appear

- Question: Where does a trader see an explanation?
- Answer: On the strategy page and on each market page beside that market's own facts panel; until one is approved and passes the validator, the page shows the facts panel alone.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope.md`, The explainer](spec/pipescope.md#the-explainer)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3)

### EXPLAINER-21: One module for the prompt's rules

- Question: Where do the banned terms, the length limits, the caps on author text, the prompt version and the model's id live?
- Answer: In `packages/terminal-explainer/src/rules.ts`, from which the prompt is rendered and which the validator, the evidence builder and the approve command import, with a test that the rendered prompt equals the spec's text.
- Alternatives: The same values written in the prompt's text and again in the validator.
- Specified in: [`docs/spec/pipescope-explainer.md`, One place for every value](spec/pipescope-explainer.md#one-place-for-every-value)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### EXPLAINER-22: What the normaliser strips and caps

- Question: Which characters does the author-text normaliser strip, and what does it cap besides the name, the description and the action labels?
- Answer: Every control character and every format character (Unicode `Cc` and `Cf`, which take in each text-direction mark and zero-width character), after line breaks and tabs become a space; the create form's description and each argument's description are capped as a description, at 600 characters, and each argument's label, each tag and the category as a label, at 64; links, the image, the source, the conformance report and the security contact are left out, and what it removed is counted.
- Alternatives: The earlier default, the category passed through as written, since Pipeline's validator accepts a category it does not know; stripping only control and text-direction characters, which leaves other invisible characters in a name.
- Specified in: [`docs/spec/pipescope-explainer.md`, Inputs](spec/pipescope-explainer.md#inputs)
- Changes by: build-time constant
- Status: changed 2026-11-24
- Decided: 2026-11-23 in [Aviary: strategy metadata, trust facts and the facts panel, with the feed's filters](https://github.com/imDev2023/testing-pipeline/issues/119)

### EXPLAINER-23: How keys are made and leave the queue

- Question: What makes an explanation's key, and what happens to a pending key a newer one replaces?
- Answer: `terminal-api`'s `explainerKeys` job works out each strategy's current key every 5 minutes (its author part also holds the metadata status and whether it has a seeding section) and records a new one pending with its evidence, waiting while a changed metadata link is not fetched yet; only the strategy's current key stays pending, so a newer key supersedes an older one and a key that becomes current again returns to the queue.
- Alternatives: Making keys at once from the indexer, Canary's runs and the metadata fetcher; keeping every pending key in the queue for the owner to skip.
- Specified in: [`docs/spec/pipescope-explainer.md`, When an explanation is made](spec/pipescope-explainer.md#when-an-explanation-is-made)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Aviary: explainer jobs: the evidence, the validator, the approval queue and the approve command](https://github.com/imDev2023/testing-pipeline/issues/126)

### EXPLAINER-24: What of the author text is evidence and what code checks

- Question: Which author text reaches the model, and what does code check of it now that Pipeline's metadata has no custom actions?
- Answer: A items are the name, description, category, tags, the create form's description and its arguments' labels and descriptions, and the outside reviews listed; code checks the create form and seeding against the version's instructions (`PipelineInitMarket`, `PipelineSeedLiquidity`) and ties each label to its argument in an F item that names the label by its A item's id.
- Alternatives: Cross-checking each action's discriminator, as the spec said before Pipeline's SDK 0.3 dropped custom actions; quoting the labels inside the F items.
- Specified in: [`docs/spec/pipescope-explainer.md`, Inputs](spec/pipescope-explainer.md#inputs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: explainer jobs: the evidence, the validator, the approval queue and the approve command](https://github.com/imDev2023/testing-pipeline/issues/126)

### EXPLAINER-25: A pending key's estimated cost

- Question: How is a pending key's cost estimated before the owner approves it?
- Answer: Its request's characters at 2.4 a token (measured with the free token-counting endpoint), and 8,000 output tokens a call (the first paid run measured about 7,480), for a first try and its retry, at the model's price in the rules module; the approve command asks with the sum and the most the calls could cost, and reports what was spent.
- Alternatives: Counting each key's tokens with the token-counting endpoint, which needs the API key in Cloudflare; pricing one call only.
- Specified in: [`docs/spec/pipescope-explainer.md`, Model and cost](spec/pipescope-explainer.md#model-and-cost)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Aviary: explainer jobs: the evidence, the validator, the approval queue and the approve command](https://github.com/imDev2023/testing-pipeline/issues/126)

### EXPLAINER-26: What the number check reads

- Question: Which text of the cited evidence does the validator's number check look in?
- Answer: Each cited item's label and value, which is what the model read; where Aviary read an item is never sent, so it is no evidence, and a Canary item carries its run date in its value.
- Alternatives: The label, the value and the source, as the prototype checked.
- Specified in: [`docs/spec/pipescope-explainer.md`, The validator](spec/pipescope-explainer.md#the-validator)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: explainer jobs: the evidence, the validator, the approval queue and the approve command](https://github.com/imDev2023/testing-pipeline/issues/126)

### EXPLAINER-27: The owner's explainer commands

- Question: Where do the owner's paid commands live, and how is the first paid run made?
- Answer: In `apps/terminal-explainer-cli`, the only package that imports the Anthropic SDK: `pnpm explainer:approve` and `pnpm explainer:reports`, `pnpm explainer:eval` for the five samples and the hostile fixture set, and `pnpm explainer:count` for exact input tokens from the free endpoint; each paid command asks first and appends one ledger line.
- Alternatives: The commands inside `terminal-explainer`, whose package `terminal-api` imports.
- Specified in: [`docs/spec/pipescope-architecture.md`, Explainer jobs](spec/pipescope-architecture.md#explainer-jobs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: explainer jobs: the evidence, the validator, the approval queue and the approve command](https://github.com/imDev2023/testing-pipeline/issues/126)

### EXPLAINER-28: Canary's records as evidence

- Question: Which Canary records does an explanation read?
- Answer: The representative market's latest result of each check with its run date, slot, outcome, reason and inputs, one item with each check's outcomes across the version's markets, and one naming the checks not run on the representative market; the representative market's tie after swaps and SOL vault goes to the first by address.
- Alternatives: Every market's records; one item per check not run.
- Specified in: [`docs/spec/pipescope-explainer.md`, Inputs](spec/pipescope-explainer.md#inputs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Aviary: explainer jobs: the evidence, the validator, the approval queue and the approve command](https://github.com/imDev2023/testing-pipeline/issues/126)

### EXPLAINER-29: Our products' facts and risks as evidence

- Question: What does the evidence add for a strategy that is one of our products?
- Answer: F items of what its panel shows of the representative market, read from its market state and the accounts it names at one slot, each giving that slot as its source, and the risks of every market of it from its spec; a product with no representative market gets its risks alone; a read that fails makes the key wait for the job's next run, since a recorded key is never rebuilt, and a caller with no RPC gets an item saying the market was not read.
- Alternatives: Leaving the products to the generic chain facts, which read vault balances and miss the cap, the wall and the ledgers.
- Specified in: [`docs/spec/pipescope-explainer.md`, Inputs](spec/pipescope-explainer.md#inputs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Buy wall AMM: Aviary panel and forms](https://github.com/imDev2023/testing-pipeline/issues/57)

## Tax AMM (TAX)

### TAX-01: Pricing, and where the tax is taken

- Question: How does a tax market price a trade and take its tax?
- Answer: Constant product, with the tax taken outside the curve, so the trader pays the tax while trading at the curve's price and quotes include the tax.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Pricing and the tax](spec/tax-amm.md#pricing-and-the-tax)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-02: Tax side

- Question: In which mint is the tax taken?
- Answer: Always in one mint, the tax side, chosen by the market's creator and fixed for the market's life; Aviary's launch form defaults it to the quote mint, SOL or USDC.
- Alternatives: Always the quote mint.
- Specified in: [`docs/spec/tax-amm.md`, Shape](spec/tax-amm.md#shape)
- Changes by: market-creation parameter
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-03: Highest tax

- Question: What is the highest buy or sell tax a tax market may ever charge?
- Answer: 10%, the constant `MAX_TAX_BPS` (1000), so no tax market can be a honeypot through its tax.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Constants](spec/tax-amm.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-04: Rates and their ranges

- Question: Who sets a market's tax rates?
- Answer: Its creator: a buy tax and a sell tax in basis points, each with a range fixed at creation inside 0 to `MAX_TAX_BPS`, which the rate can never leave.
- Alternatives: Automatic taxes that move with volatility or volume.
- Specified in: [`docs/spec/tax-amm.md`, Creation parameters](spec/tax-amm.md#creation-parameters)
- Changes by: market-creation parameter
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-05: Tax authority

- Question: Who may change a market's taxes after creation?
- Answer: Only its optional tax authority, which may move the rates inside their fixed ranges, change the recipients and renounce; a change of rates waits `RATE_CHANGE_DELAY_SLOTS` (300 slots, twice a blockhash's 150 blocks) as the market's pending rates, decreases included, so no change can reach a swap signed with a blockhash before it while fewer than half the slots are skipped, renouncing cancels a change still pending, and the other actions take effect at once; nobody else can change anything about a market, us included, and the program has no admin.
- Alternatives: The earlier default, every change taking effect at once, which let the authority put a rate change on either side of a victim's swap and take its slippage allowance as tax (hardening finding H010); capping how far one change may move a rate, one change per slot, which shrinks that take but never removes it; accepting it, the trader's minimum output being the protection; moving the tax authority to another address.
- Specified in: [`docs/spec/tax-amm.md`, Rates](spec/tax-amm.md#rates)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-22
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19); changed by the owner on 2026-11-22 in [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67)

### TAX-06: Suite share

- Question: What share of the tax goes to the suite?
- Answer: 10% of every tax, the constant `SUITE_SHARE_BPS` (1000), taken before the creator's split and shown to creators in the launch form.
- Alternatives: No share, earning only through Aviary's integrator fee.
- Specified in: [`docs/spec/tax-amm.md`, Constants](spec/tax-amm.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-07: Suite treasury

- Question: Where is the suite share paid?
- Answer: To the wallet `SUITE_TREASURY`, set at build time; on devnet a wallet whose key is kept outside the repo.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Constants](spec/tax-amm.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-08: Number of recipients

- Question: How many tax recipients may a market have?
- Answer: Up to 4, the constant `MAX_RECIPIENTS`.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Constants](spec/tax-amm.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-09: Recipients and the burn

- Question: How is the creator's part of the tax split?
- Answer: By shares the creator sets, among at least one recipient and an optional burn, summing to exactly 10,000 basis points; there is no burn when the tax side is SOL.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Creation parameters](spec/tax-amm.md#creation-parameters)
- Changes by: market-creation parameter
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-10: Payout

- Question: How is the tax paid out?
- Answer: Never during a swap: it is booked as owed per slot and stays in the tax-side vault until anyone calls the permissionless `distribute` for a slot, so a closed or frozen recipient account can never make swaps fail.
- Alternatives: Paying recipients inside each swap.
- Specified in: [`docs/spec/tax-amm.md`, Payout](spec/tax-amm.md#payout)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-11: Locked liquidity

- Question: Can liquidity be added to or taken out of a tax market?
- Answer: No: it is seeded once and locked for good, with no LP shares, no LP fee and no instruction that takes liquidity out; tokens sent to a vault outside a swap or the seed are donations and never credited.
- Alternatives: Open LPs with shares and an LP fee; liquidity the creator can withdraw.
- Specified in: [`docs/spec/tax-amm.md`, Locked for good](spec/tax-amm.md#locked-for-good)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-12: The seed

- Question: Who seeds a market, and when?
- Answer: The seeder named at creation, once, before any swap, in the same transaction as the market's creation; a launchpad graduating a token seeds through `pipeline_seed_liquidity` instead.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, The seed](spec/tax-amm.md#the-seed)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-13: Virtual reserve

- Question: Can a token launch with only the token deposited?
- Answer: Yes: a creator may set a virtual reserve on one side, which pricing counts as held there and which is never paid out and never changes.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Virtual reserve](spec/tax-amm.md#virtual-reserve)
- Changes by: market-creation parameter
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-14: Two mints

- Question: How many mints does a tax market hold?
- Answer: Exactly two.
- Alternatives: Markets with more than two mints.
- Specified in: [`docs/spec/tax-amm.md`, Shape](spec/tax-amm.md#shape)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-15: Exact-out

- Question: Does the tax AMM support exact-out swaps?
- Answer: No: it is exact-in only, and an exact-out quote or swap is refused.
- Alternatives: Exact-out swaps in v1.
- Specified in: [`docs/spec/tax-amm.md`, Pricing and the tax](spec/tax-amm.md#pricing-and-the-tax)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-16: Mint rules

- Question: Which mints may a tax market hold?
- Answer: SPL Token mints, and Token-2022 mints carrying only extensions on an allowlist (transfer hook, metadata pointer, token metadata, group pointer, group member pointer, token group and token group member), every other extension refused at creation; a transfer hook only when it is cleared or is the containment hook with the mint's unlock PDA as its authority, checked at creation; and at the seed, through either seed path, no mint authority and no freeze authority on any mint but a quote mint (`TAX-58`).
- Alternatives: The earlier default, any hook program and mint and freeze authorities allowed and disclosed, which let a token's issuer refuse sells, mint into the curve or freeze a vault once buyers were in (hardening findings H007, H008, H009, H016); refusing only foreign hooks, leaving the authorities disclosed; allowing more extensions, which would admit quote mints such as PYUSD.
- Specified in: [`docs/spec/tax-amm.md`, Mint rules](spec/tax-amm.md#mint-rules)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-22
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19); changed by the owner on 2026-11-22 in [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67)

### TAX-17: Market addresses

- Question: At which addresses do a market's accounts live?
- Answer: The market state is a fresh keypair the creator signs with, and each vault is a PDA derived from it, so every address is known before the market is created; markets seeded by another program live at a PDA keyed by the seeder and the two mints.
- Alternatives: A PDA keyed by the market's parameters, as Pipeline's template does, which another market with the same seeds could take first.
- Specified in: [`docs/spec/tax-amm.md`, Addresses](spec/tax-amm.md#addresses)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-18: Counters for the containment hook

- Question: What does a market count for the containment hook's unlock?
- Answer: Volume per mint, tax collected and swap count, changed only by router swaps and kept at fixed offsets in the market state that later versions never move.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Counters for the containment hook](spec/tax-amm.md#counters-for-the-containment-hook)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-19: Rounding

- Question: Which way does the maths round?
- Answer: The tax rounds up and the curve's output rounds down, in u128, so the product of the effective reserves never falls.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Pricing and the tax](spec/tax-amm.md#pricing-and-the-tax)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-20: Custom actions and metadata

- Question: Which actions does the tax AMM expose?
- Answer: Five: `seed`, `distribute`, `set_taxes`, `set_recipients` and `renounce_tax_authority`, each emitting an event, declared in metadata with category `amm` and the tag `tax`.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Custom actions and metadata](spec/tax-amm.md#custom-actions-and-metadata)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-21: Mainnet upgrade policy

- Question: What is the tax AMM's upgrade policy on mainnet?
- Answer: Frozen (upgrade authority removed) before any mainnet deployment, because the containment hook's unlock trusts its counters and its vaults hold locked liquidity.
- Alternatives: The shared default of a multisig with a timelock first.
- Specified in: [`docs/spec/tax-amm.md`, Upgrades and freezing](spec/tax-amm.md#upgrades-and-freezing)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

### TAX-22: Security contact

- Question: Where does a security report about the tax AMM go?
- Answer: To this repo's private vulnerability reporting page on GitHub, named as `security.contact` in the strategy metadata and in the program's `security.txt`, never a personal address.
- Alternatives: An email address; a handle.
- Specified in: [`docs/spec/tax-amm.md`, Custom actions and metadata](spec/tax-amm.md#custom-actions-and-metadata)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### TAX-23: Compute ceilings

- Question: How much compute may each instruction use?
- Answer: 25,000 units for a quote and 60,000 for a swap, up to 150,000 for `pipeline_seed_liquidity`, set from what Pipeline's constant-product example costs until the build measures each one.
- Alternatives: Fixing them only after measuring.
- Specified in: [`docs/spec/tax-amm.md`, Compute ceilings](spec/tax-amm.md#compute-ceilings)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### TAX-24: Invariants

- Question: Which invariants does the tax AMM's fuzzing check?
- Answer: Seven beyond the shared three: vaults cover the reserves and everything owed, a swap never lowers the product of the effective reserves, every tax is split exactly, no rate leaves its range, only router swaps change the reserves and the counters, the counters never fall, and a market without a tax authority never changes.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Invariants](spec/tax-amm.md#invariants)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### TAX-25: In Aviary

- Question: What does Aviary show and offer for the tax AMM?
- Answer: Its five actions through Aviary's generic forms, its own launch form on the create-market page that shows the whole split before signing, and a tax panel on each market's page with the rates and their ranges, the tax authority, the recipients, the tax collected and what each slot is owed.
- Alternatives: The generic `init` form for launching.
- Specified in: [`docs/spec/tax-amm.md`, In Aviary](spec/tax-amm.md#in-aviary)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### TAX-26: Where its policy values live

- Question: Where do the tax AMM's policy values live in code?
- Answer: The four constants are build-time constants in one config module of the program, which no other file repeats; the mint extension allowlist lives in one small shared crate that the tax AMM, the containment hook and the lending AMM all depend on; every other policy value is a creation parameter held in the market state.
- Alternatives: A copy of the allowlist in each program.
- Specified in: [`docs/spec/tax-amm.md`, Where its policy values live](spec/tax-amm.md#where-its-policy-values-live)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### TAX-27: Build tickets

- Question: How are the tax AMM and the containment hook cut into build tickets?
- Answer: Eleven tickets for the tax AMM and seven for the hook, each hook ticket free to start as soon as the tax AMM ticket it builds on has merged.
- Alternatives: Building the hook strictly after the whole tax AMM.
- Specified in: [`docs/spec/tax-amm.md`, Build tickets](spec/tax-amm.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### TAX-28: Expected Canary warns

- Question: Which Canary warns are expected on a tax market we create?
- Answer: `cost` and `exit_queue` whenever the two taxes together pass about 4.5%, and `token_authorities` while a mint keeps an authority that could act on holders; no other check may warn or fail.
- Alternatives: None recorded.
- Specified in: [`docs/spec/tax-amm.md`, Canary checks](spec/tax-amm.md#canary-checks)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### TAX-29: Program id

- Question: At which address does the tax AMM live?
- Answer: `J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t`, the address of the program keypair Pipeline's generator was given, kept in `~/.config/testing-pipeline/devnet/tax-amm.json`.
- Alternatives: A vanity address.
- Specified in: [`docs/toolchain.md`, Keys](toolchain.md#keys)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58)

### TAX-30: The market state's layout

- Question: What does the market state hold beyond the fields the spec names, and where does each field sit?
- Answer: A status, the vault authority's bump, a flag set when the tax authority renounces and 64 zero bytes kept for later fields, in a 596-byte account with the tax side at offset 10 and `tax_collected` at offset 460, every offset pinned by a test.
- Alternatives: No reserved bytes, so a new field would need a new layout version; telling a renounced market apart only from its events.
- Specified in: [`docs/spec/tax-amm.md`, Counters for the containment hook](spec/tax-amm.md#counters-for-the-containment-hook)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59)

### TAX-31: How a refused market is reported

- Question: How does the program say why it refused a market?
- Answer: Every rule on the creation parameters and the mints refuses with an error of its own, and a mint refused for an extension is logged with Token-2022's number for it, so Aviary's launch form can name the rule.
- Alternatives: One error for any bad parameter.
- Specified in: [`docs/spec/tax-amm.md`, Creation parameters](spec/tax-amm.md#creation-parameters)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59)

### TAX-32: How the mint rules read a mint

- Question: How does the shared mint-rules crate find a mint's extensions?
- Answer: It reads the extension entries itself, as Token-2022 lays them out, and depends on no other crate, so an extension Token-2022 adds later is refused by its number and a program using the crate pulls in nothing else.
- Alternatives: Token-2022's own interface crate, which fails to read an extension newer than its version and brings its dependencies into every program that uses the rules.
- Specified in: [`docs/spec/tax-amm.md`, Where its policy values live](spec/tax-amm.md#where-its-policy-values-live)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59)

### TAX-33: Creating the vaults

- Question: When and how are a market's vaults created?
- Answer: By `pipeline_init_market` itself, after every rule has passed, so a refused mint gets the error of the rule it breaks, each vault sized by its mint's token program, and with lamports already at a vault's address kept as a donation rather than blocking the creation.
- Alternatives: Anchor's `init` constraints, which read the mints before the program can check them and fail with a generic error on an extension they don't know.
- Specified in: [`docs/spec/tax-amm.md`, Addresses](spec/tax-amm.md#addresses)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59)

### TAX-34: IDL and TypeScript client

- Question: Where do the tax AMM's IDL and TypeScript client come from?
- Answer: The Anchor IDL is built by `anchor idl build` and committed beside the program, and the client is generated from it by Codama in Node-runnable TypeScript, each checked against the other and the program by tests.
- Alternatives: A hand-written client; a client compiled to JavaScript in a package of its own.
- Specified in: [`docs/spec/tax-amm.md`, Custom actions and metadata](spec/tax-amm.md#custom-actions-and-metadata)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59)

### TAX-35: The vault authority in a swap

- Question: How does a swap reach the vault authority that signs the transfer out of a vault?
- Answer: `pipeline_resolve_accounts` lists it, read-only, after the output vault, and `pipeline_swap` checks it against the PDA from the market state's stored bump before signing with it.
- Alternatives: Vaults owned by the market state itself, which a fresh keypair's account can't sign for; the authority's address stored in the market state, which would spend 32 of its 64 reserved bytes on what the stored bump already gives.
- Specified in: [`docs/spec/tax-amm.md`, Addresses](spec/tax-amm.md#addresses)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: seed a market and trade it with buy and sell tax](https://github.com/imDev2023/testing-pipeline/issues/60)

### TAX-36: How a refused seed or trade is reported

- Question: How does the program say why it refused a seed or a trade?
- Answer: With an error of its own for each rule: a seed from anyone but the seeder, a second seed, and a zero seed on a side without a virtual reserve; a trade whose output would be 0, and one that would pay out more than the real reserve; exact-out has its own error too, though the router refuses exact-out swaps itself before they reach the strategy.
- Alternatives: One error for any refused trade.
- Specified in: [`docs/spec/tax-amm.md`, Pricing and the tax](spec/tax-amm.md#pricing-and-the-tax)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: seed a market and trade it with buy and sell tax](https://github.com/imDev2023/testing-pipeline/issues/60)

### TAX-37: The tax cap and the suite share in the IDL

- Question: How do Aviary and the demo script learn the tax cap and the suite share without restating them?
- Answer: The program publishes `MAX_TAX_BPS` and `SUITE_SHARE_BPS` in its IDL with Anchor's `#[constant]`, so the TypeScript client generated from it carries both, and the config module stays their one place.
- Alternatives: Each reader restating the values; reading them from a market, which does not hold them.
- Specified in: [`docs/spec/tax-amm.md`, Where its policy values live](spec/tax-amm.md#where-its-policy-values-live)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: seed a market and trade it with buy and sell tax](https://github.com/imDev2023/testing-pipeline/issues/60)

### TAX-38: What renouncing leaves in the market state

- Question: What does the market state hold once its tax authority renounces?
- Answer: The default key as its tax authority, as on a market created without one, and its renounced flag set, so Aviary can tell the two apart while both refuse every action for good.
- Alternatives: Keeping the former authority's key beside the flag, which would leave a key in the field that can no longer act.
- Specified in: [`docs/spec/tax-amm.md`, Tax authority](spec/tax-amm.md#tax-authority)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: the tax authority](https://github.com/imDev2023/testing-pipeline/issues/62)

### TAX-39: Emptying a recipient slot that is still owed

- Question: May `set_recipients` empty a recipient slot that is still owed tax, or hand it to another wallet?
- Answer: Neither: a slot still owed tax keeps its wallet until it is paid out, refused with `OwedSlotLeftEmpty` when emptied and `OwedSlotRedirected` when handed to another wallet, so what a slot is owed always goes to the wallet that earned it; the authority pays it out first with `distribute`, in the same transaction if it likes, shares may move whatever is owed, and the burn share may still drop to 0 since the burn needs no wallet.
- Alternatives: The earlier default, the slot handed to another wallet with what it was owed, which let the authority hand every slot to itself and pay them out in one transaction (hardening finding H023); allowing an owed slot to be emptied, which would strand the owed amount for good once the authority renounced; moving the owed amount to another slot, which would make `set_recipients` change owed amounts.
- Specified in: [`docs/spec/tax-amm.md`, Payout](spec/tax-amm.md#payout)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-22
- Decided: 2026-11-12 in [Tax AMM: the tax authority](https://github.com/imDev2023/testing-pipeline/issues/62); changed by the owner on 2026-11-22 in [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67)

### TAX-40: How a refused tax authority action is reported

- Question: How does the program say why it refused `set_taxes`, `set_recipients` or `renounce_tax_authority`?
- Answer: With `AlreadyRenounced` on a market whose authority renounced, `NoTaxAuthority` on one created without an authority and `NotTaxAuthority` for any other signer, checked in that order, then the same error as creation for a rate or split creation would refuse.
- Alternatives: One error for any signer who is not the tax authority.
- Specified in: [`docs/spec/tax-amm.md`, Tax authority](spec/tax-amm.md#tax-authority)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: the tax authority](https://github.com/imDev2023/testing-pipeline/issues/62)

### TAX-41: How metadata describes seeding from another program

- Question: How does the strategy metadata tell a launcher how to fill in `pipeline_seed_liquidity`, which Pipeline's metadata standard has no field for?
- Answer: A top-level `seed_liquidity` form shaped as `init` is, which the validator allows as an unknown key: the seeded market state as a `pda:` source keyed by `input:seeder` and both mints, `data` as init's arguments under the same IDL type with the seeder marked ignored, and the program's own accounts after Pipeline's fixed seed accounts, so the SDK's `resolveInit` resolves it as the demo does.
- Alternatives: A prose description only, which no tool could resolve; a `create_market` custom action, which is called by a wallet, not by another program.
- Specified in: [`docs/spec/tax-amm.md`, Custom actions and metadata](spec/tax-amm.md#custom-actions-and-metadata)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: seeding from another program](https://github.com/imDev2023/testing-pipeline/issues/63)

### TAX-42: How a seed request is checked

- Question: What does `pipeline_seed_liquidity` check beyond the creation rules and mint rules, and what does it report?
- Answer: Exactly one amount per mint (an error of its own otherwise), `data` exactly the creation parameters, escrows owned by the seeder as the `seed` action requires of the seeder's accounts, and `SeedResult.taken` as what it measured leaving each escrow, with every market created by the same code as a market created through the router.
- Alternatives: Reporting the amounts requested as taken, as Pipeline's reference strategy does; a second copy of the creation checks for seeded markets.
- Specified in: [`docs/spec/tax-amm.md`, The seed](spec/tax-amm.md#the-seed)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: seeding from another program](https://github.com/imDev2023/testing-pipeline/issues/63)

### TAX-43: Which tax slots `distribute` pays

- Question: How does `distribute` name a slot, and which calls does it refuse or treat as nothing to do?
- Answer: By the slot's number as the market state books it, 0 to 3 the tax recipients, 4 the burn and 5 the suite share; a number above 5 and a recipient slot the market does not use are refused with errors of their own, and a slot owed nothing moves nothing, creates no account and emits no event.
- Alternatives: Paying every slot in one call, which one broken recipient account would block; treating an unused slot like a slot owed nothing.
- Specified in: [`docs/spec/tax-amm.md`, Payout](spec/tax-amm.md#payout)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: pay the tax out with distribute](https://github.com/imDev2023/testing-pipeline/issues/61)

### TAX-44: Where `distribute` pays

- Question: Into which account is a slot paid, and which accounts are refused?
- Answer: A tax recipient or the suite share only into its wallet's associated token account for the tax-side mint, created at the caller's expense when missing, and paid even when the wallet has handed that SPL Token account to another owner, since refusing would strand the slot's tax for good once the authority renounces; the burn names no wallet (the default key) and burns from the vault; any other wallet or token account is refused, including the wallet's account of the other mint.
- Alternatives: Refusing an associated token account whose owner the wallet has handed away, which a review on 2026-11-12 showed strands that slot's tax after a renounce; paying any token account the wallet owns.
- Specified in: [`docs/spec/tax-amm.md`, Payout](spec/tax-amm.md#payout)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: pay the tax out with distribute](https://github.com/imDev2023/testing-pipeline/issues/61)

### TAX-45: The `distribute` action's inputs

- Question: How does the metadata's `distribute` action find a market's tax-side mint and a slot's wallet, which no metadata account source can name?
- Answer: As two address inputs, `tax_mint` and `recipient` (the default key for the burn), from which it derives the vault and the token account; whoever builds the call (Aviary's tax panel, the keeper runner, the demo script) reads both from the market state, and the program refuses any that are not the slot's.
- Alternatives: One action per tax side with fixed indexes, which a terminal would have to choose between; passing both vaults and mints and leaving the recipient's token account to the caller.
- Specified in: [`docs/spec/tax-amm.md`, Payout](spec/tax-amm.md#payout)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: pay the tax out with distribute](https://github.com/imDev2023/testing-pipeline/issues/61)

### TAX-46: The suite treasury and the slot numbers in the IDL

- Question: How do Aviary and the demo script learn the suite share's wallet and which slot is the burn's and which the suite share's, all of which `distribute` needs?
- Answer: The program publishes `SUITE_TREASURY`, `BURN_SLOT` and `SUITE_SLOT` in its IDL with Anchor's `#[constant]`, beside the tax cap and the suite share, so the generated client carries them and the config module (and `MAX_RECIPIENTS`, from which the slots follow) stays their one place.
- Alternatives: Each reader restating the address and the slot numbers.
- Specified in: [`docs/spec/tax-amm.md`, Where its policy values live](spec/tax-amm.md#where-its-policy-values-live)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: pay the tax out with distribute](https://github.com/imDev2023/testing-pipeline/issues/61)

### TAX-47: The demo's two markets

- Question: Which markets does the demo script create, trade and pay out?
- Answer: Two: one taxed in wrapped SOL, Aviary's default tax side, whose recipients are paid wrapped SOL and which burns nothing, and one taxed in a token, whose burn lowers the token's supply.
- Alternatives: One market taxed in a token, which never shows a payout in wrapped SOL.
- Specified in: [`docs/toolchain.md`, Local demo run](toolchain.md#local-demo-run)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: pay the tax out with distribute](https://github.com/imDev2023/testing-pipeline/issues/61)

### TAX-48: The burn's own action

- Question: How does `distribute` keep payouts from write-locking the tax-side mint, which only the burn changes?
- Answer: The mint is read-only for a payout and writable only for the burn, which refuses a read-only mint; the metadata describes the one instruction as two actions, `distribute` with the mint read-only and `burn`, for the burn slot, with the mint writable, so payouts of SOL-taxed markets never write-lock the native mint.
- Alternatives: One action with the mint always writable, which would serialize every payout against every transfer of the mint; a separate burn instruction.
- Specified in: [`docs/spec/tax-amm.md`, Payout](spec/tax-amm.md#payout)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: pay the tax out with distribute](https://github.com/imDev2023/testing-pipeline/issues/61)

### TAX-49: The maths re-checks the creation rules

- Question: Should the pricing and the split refuse a rate above the cap and shares that are not the whole themselves, when creation and the tax authority's changes already refuse them?
- Answer: Yes: the pricing refuses a rate above `MAX_TAX_BPS` and the split refuses shares that do not sum to 10,000 with the burn share, for every input, so the proven properties hold for the maths on its own and not only for the market states creation allows.
- Alternatives: Relying on the creation rules alone, which left the pricing applying any rate up to 100% and the split booking shares past the whole on small taxes if a market state ever held them.
- Specified in: [`docs/spec/tax-amm.md`, Pricing and the tax](spec/tax-amm.md#pricing-and-the-tax)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: proofs of the pricing, tax and split maths](https://github.com/imDev2023/testing-pipeline/issues/64)

### TAX-50: How the tax AMM's maths is proven

- Question: Which properties of the pricing, tax and split maths are proven, and how is each established?
- Answer: The property list in `docs/security/tax-amm/maths-properties.md`, chosen with Book of Knowledge: Kani proves for every input what needs no quotient and the rest for small inputs, Z3 proves every quotient claim for every input from lemmas proven on their own, and Proptest checks each property of the tax, a swap, the split and the curve on the compiled code, on at least 10,000 cases that exercise it.
- Alternatives: Kani alone, whose full-domain proofs about quotients do not finish; Z3 on whole trades directly, which does not finish either.
- Specified in: [`docs/spec/tax-amm.md`, Maths proofs](spec/tax-amm.md#maths-proofs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: proofs of the pricing, tax and split maths](https://github.com/imDev2023/testing-pipeline/issues/64)

### TAX-51: Bump searches and the compute ceilings

- Question: How is `distribute` held to its compute ceiling when its cost depends on how many bumps the slot wallet's associated token account needs?
- Answer: The ceilings leave out what a bump search spends beyond an address's first bump, 1,500 units a try, which for `distribute` is 4,500 units for each further bump when it creates the account (the associated token program derives it twice more) and 1,500 when it does not; the spec states that rule so a caller can size a payout's compute limit, and the tests subtract exactly that.
- Alternatives: A higher ceiling, which no ceiling can make safe since the search has no fixed bound; asserting the raw cost, which fails at random for about one wallet in a few thousand; changing `distribute` to take the bump as an argument, which the metadata's account sources cannot supply.
- Specified in: [`docs/spec/tax-amm.md`, Compute ceilings](spec/tax-amm.md#compute-ceilings)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: invariant fuzzing across every instruction](https://github.com/imDev2023/testing-pipeline/issues/65)

### TAX-52: What every holder can exit means on a tax market

- Question: How does the fuzzer check the bar's shared invariant that every holder can still exit, given that a tax market never pays out its virtual reserve?
- Answer: Every wallet's whole holding of either mint quotes, or is refused as dust or, only on a market with a virtual reserve, because the curve would pay out more than the real reserve, in which case the largest sale the real reserve covers must quote unless it is itself dust (hardening finding H036, signed off); every sequence ends with every wallet selling all it holds, and each sale settles unless the spec refuses it.
- Alternatives: Requiring every whole holding to sell, which a single-sided launch refuses by design; checking quotes only, which would miss a swap that fails after its quote.
- Specified in: [`docs/spec/tax-amm.md`, Invariants](spec/tax-amm.md#invariants)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: invariant fuzzing across every instruction](https://github.com/imDev2023/testing-pipeline/issues/65)

### TAX-53: The devnet demo market

- Question: Which market does the demo create on devnet, where Pipeline's registry and anyone looking will see it?
- Answer: One, the demo market: a fresh demo token against wrapped SOL, taxed in wrapped SOL as Aviary's launch form defaults it, with a buy tax of 3% and a sell tax of 5% inside ranges its tax authority can move them in, two tax recipients and no virtual reserve, so `pipeline-check` checks it at its default amounts; all its parameters are in one block of the demo script, `SOL_MARKET`. The token-taxed market, the tax authority's changes and the launchpad stay on local validators.
- Alternatives: The whole local demo on devnet, which would leave a renounced market and a burn-taxed market of throwaway tokens in the registry beside the one the ticket publishes; a market with a virtual reserve, which `pipeline-check` can check only with explicit amounts.
- Specified in: [`docs/toolchain.md`, Deploy to devnet](toolchain.md#deploy-to-devnet)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66)

### TAX-54: Links that stay at commits on main

- Question: How do the registered metadata URI and every link inside the metadata point at commits that stay reachable from `main`, when a squash merge leaves a branch's commits off it and a file cannot name the commit that holds it?
- Answer: Three merges. The first lands the deploy tooling, and its merge commit is what is deployed and registered; while the repo is private, the registration takes the metadata's address on `main`, which resolves once the repo is public, with the demo's `--metadata-not-yet-public`. The second records the deploy in `deployments/devnet.json` and commits the demo market's conformance report and the README that says where the program is. The third pins `metadata.json` with `publish.ts pin`: the source and the IDL at the deployed commit, the report and the README at the second merge's commit; then `update_metadata` points the router at the metadata at the third merge's commit, and, once the repo is public, `publish.ts verify` checks every link resolves at a commit on `main`. A test fails when the metadata names a commit other than the deployed one, or a report other than the committed one.
- Alternatives: The earlier default, which registered at a metadata URI at the deploy commit and assumed the repo public before the deploy; two merges with the report linked at a branch commit, which a squash merge leaves off `main`; links at `main`, whose content can change after the report was taken; merge commits instead of squash merges, against the repo's convention.
- Specified in: [`docs/toolchain.md`, Deploy to devnet](toolchain.md#deploy-to-devnet)
- Changes by: spec only
- Status: changed 2026-11-19
- Decided: 2026-11-16 in [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66)

### TAX-55: Tax recipients that are the market's own addresses

- Question: May a tax recipient be one of the market's own addresses or the programs it runs on?
- Answer: No: creation and `set_recipients` refuse a recipient that is the market state, its vault authority, its vaults or mints, the tax AMM, the router or the market's signer under it, or a token or associated token program (`NotAWallet`), since none could ever move what it is paid while its payout event reads as paid.
- Alternatives: Allowing them and leaving such tax stuck in an account nobody controls (hardening finding H024).
- Specified in: [`docs/spec/tax-amm.md`, Creation parameters](spec/tax-amm.md#creation-parameters)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-20 in [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67)

### TAX-56: A market state a newer build wrote

- Question: What does the program do with a market state whose version byte is newer than the one it writes?
- Answer: Every instruction refuses it (`NewerStateVersion`), so a build rolled back under markets a newer build wrote never reads them with an older layout's meaning; fields added into the reserved bytes keep the version byte, as the pending rates did, since markets created before read zeros there.
- Alternatives: Reading any version, which would misread fields a newer layout gave other meanings (hardening finding H069).
- Specified in: [`docs/spec/tax-amm.md`, Counters for the containment hook](spec/tax-amm.md#counters-for-the-containment-hook)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-20 in [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67)

### TAX-57: The release gate before an upgrade

- Question: How is an upgrade kept from stranding a market that already exists?
- Answer: Before a new build replaces the deployed one, its release gate copies every tax market on the cluster with the cluster's slot, and reads and quotes each both ways with the new bytes at that slot, at the spec's price and exactly as the deployed build does; `scripts/deploy-devnet.sh` runs it on the very bytes it deploys and records what it read, and every `cargo test` runs it on a committed copy of devnet's markets.
- Alternatives: Trusting the layout tests alone, which can't tell whether real markets still quote (hardening finding H038).
- Specified in: [`docs/spec/tax-amm.md`, Upgrades and freezing](spec/tax-amm.md#upgrades-and-freezing)
- Changes by: spec only
- Status: default
- Decided: 2026-11-20 in [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67)

### TAX-58: The quote mints

- Question: Which mints may keep a mint or freeze authority when a tax market is seeded?
- Answer: Only the quote mints, the build-time list `QUOTE_MINTS`: SPL Token's and Token-2022's native SOL mints and the cluster's USDC (Circle's devnet mint on devnet; a mainnet build names mainnet's before it is frozen).
- Alternatives: No exception, which would refuse every market quoted in USDC; a creation parameter naming the quote side, which a decoy creator would set to its own token.
- Specified in: [`docs/spec/tax-amm.md`, Mint rules](spec/tax-amm.md#mint-rules)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-22 in [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67)

### TAX-59: The seed names the market's terms

- Question: How does a seeder make sure the market it funds has the terms it agreed to?
- Answer: `seed` takes `expected_terms`, the SHA-256 of the Borsh encoding of the mints, the creation parameters as stored and any pending rate change, and refuses a mismatch before anything moves (`TermsChanged`); the metadata's `seed` action takes it as a `pubkey`-typed argument, since metadata arguments have no fixed-size byte type, and `pipeline_seed_liquidity` needs none, since its caller passes the parameters themselves.
- Alternatives: Binding no terms, which let anyone lure a seeder into funding a look-alike market with a huge virtual reserve on the other side (hardening finding H019); a `bytes` argument, which the metadata encodes with a length prefix; accepting it because Aviary creates and seeds in one transaction for one signer.
- Specified in: [`docs/spec/tax-amm.md`, The seed](spec/tax-amm.md#the-seed)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-22 in [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67)

### TAX-60: The launch form

- Question: What does Aviary's launch form for a tax market ask, and how does it send the launch?
- Answer: The token as mint 0 and SOL or the cluster's USDC as mint 1, taxed in that quote mint unless the creator chooses the token, a buy and a sell tax with their ranges (3% and 5%, each free between 0 and `MAX_TAX_BPS`, by default), the creator's wallet or no one as tax authority, up to four recipients with the creator's wallet first, the burn's share, the seed and an optional virtual reserve on the quote side, sent as one transaction with the creator as seeder, shortened by Aviary's lookup table.
- Alternatives: Sending the seed as a second transaction, which the hash of the terms makes safe but leaves a market created and unseeded when the second is never signed; any quote mint, which the generic create form still offers.
- Specified in: [`docs/spec/tax-amm.md`, In Aviary](spec/tax-amm.md#in-aviary)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Tax AMM in Aviary: the launch form and the tax panel](https://github.com/imDev2023/testing-pipeline/issues/75)

### TAX-61: How the launch form refuses a mint

- Question: How does the launch form refuse a mint the mint rules refuse, before any signature?
- Answer: By the simulation before the signature, which runs the program's own rules, so the refusal is the program's error naming its rule, followed by the mint and, for an extension, its Token-2022 name from the number the program logs; the form keeps no copy of the rules.
- Alternatives: Checking the mint's extensions and authorities in the page, which would be a second copy of the allowlist that `programs/mint-rules` keeps once.
- Specified in: [`docs/spec/tax-amm.md`, In Aviary](spec/tax-amm.md#in-aviary)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Tax AMM in Aviary: the launch form and the tax panel](https://github.com/imDev2023/testing-pipeline/issues/75)

### TAX-62: What the tax panel shows

- Question: What does the tax panel show, and from what?
- Answer: From the one-slot read of the market state and its vaults: the rates in force at that slot with their ranges, a waiting change with its slot and the time left, the authority or that there is none or it renounced, the split with the suite share first, the tax collected and owed, a line and a payout button for each used recipient slot, the burn while it has a share or is owed, and the suite share, then the real reserves, the virtual reserve and what the vaults hold.
- Alternatives: Reading the panel from Aviary's indexed events, which would lag the chain and could miss a payout made elsewhere.
- Specified in: [`docs/spec/tax-amm.md`, In Aviary](spec/tax-amm.md#in-aviary)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Tax AMM in Aviary: the launch form and the tax panel](https://github.com/imDev2023/testing-pipeline/issues/75)

### TAX-63: Canary's warns on a market with a virtual reserve

- Question: Which of Canary's warns may a tax market with a virtual reserve show besides those of every tax market?
- Answer: `conformance`, when `pipeline-check`'s `quotes` sizes its large sale past the real reserve, which the program refuses, and `outside_supply`, both findings the spec already accepts for a virtual reserve (H036, H086), named in the tax AMM's Canary checks for such markets only.
- Alternatives: Changing Canary's `conformance` to pass explicit amounts to `pipeline-check` on such markets, a Canary ticket of its own; holding the criterion to the markets #75 launched, which already meet it.
- Specified in: [`docs/spec/tax-amm.md`, Canary checks](spec/tax-amm.md#canary-checks)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Tax AMM in Aviary: the launch form and the tax panel](https://github.com/imDev2023/testing-pipeline/issues/75)

## Containment hook (HOOK)

### HOOK-01: Transfers while contained

- Question: Where may a contained token move?
- Answer: Only into or out of its home market's vault or that market's Pipeline fee account, and into no account outside those two whose owner can change (`HOOK-47`); every wallet-to-wallet transfer is refused, including between a holder's own wallets and to a CEX deposit address.
- Alternatives: The earlier default, only into or out of its home market's vault or that market's Pipeline fee account; every wallet-to-wallet transfer is refused, including between a holder's own wallets and to a CEX deposit address (changed by the owner's answer 1a on #74 on 2026-11-23); wallet-to-wallet transfers between keypair wallets signed by their owner.
- Specified in: [`docs/spec/containment-hook.md`, The allow rule](spec/containment-hook.md#the-allow-rule)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-23
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-02: Integrator fees on sells

- Question: Can an integrator charge a fee on a sell of a contained token?
- Answer: No: no integrator fee account is allowed, so integrators pass a zero fee on sells; buys pay their integrator fee in the quote mint as usual; an integrator fee account that is the home vault or the fee account itself passes, but paying either is a donation.
- Alternatives: The earlier default, the same without the note on the vault and the fee account (made exact by hardening finding H045 of #74 on 2026-11-23); a launcher-set list of integrator fee accounts allowed as destinations.
- Specified in: [`docs/spec/containment-hook.md`, What this refuses](spec/containment-hook.md#what-this-refuses)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-23
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-03: One home market

- Question: How many home markets may a contained token have?
- Answer: Exactly one.
- Alternatives: Several home markets, for example against SOL and against USDC.
- Specified in: [`docs/spec/containment-hook.md`, Checks on the home market](spec/containment-hook.md#checks-on-the-home-market)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-04: Which markets can be a home market

- Question: On which strategy may a home market live?
- Answer: Only the tax AMM, whose program id is fixed in the hook at build time, with the market's tax side on the quote mint.
- Alternatives: Home markets on other strategies; a tax side on the contained token.
- Specified in: [`docs/spec/containment-hook.md`, Checks on the home market](spec/containment-hook.md#checks-on-the-home-market)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-05: Unlock goal

- Question: What does the unlock goal measure?
- Answer: The tax collected by the home market, in quote-mint base units, with no minimum age.
- Alternatives: Volume, with or without a minimum-tax floor; a minimum age as part of the goal.
- Specified in: [`docs/spec/containment-hook.md`, Unlock goal](spec/containment-hook.md#unlock-goal)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-06: Where the goal is counted

- Question: Which program counts progress toward the unlock goal?
- Answer: The tax AMM, in its market state, which the hook's `unlock` reads; so the hook trusts the tax AMM's code, which has to be frozen too.
- Alternatives: A counter in the hook; counting transfers into the Pipeline fee account; a wrapper program reading the router's return data; the tax AMM's volume counter.
- Specified in: [`docs/adr/0006-unlock-goal-counted-by-the-home-market.md`, The unlock goal is counted by the home market's strategy, not by the hook](adr/0006-unlock-goal-counted-by-the-home-market.md#the-unlock-goal-is-counted-by-the-home-markets-strategy-not-by-the-hook)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-07: Who sets the goal and the deadline

- Question: Who sets a token's unlock goal and deadline, and can they change?
- Answer: The launcher, once, at binding, signed by the mint authority; binding is write-once, nothing changes the config afterwards, not the launcher and not us, and the hook refuses every transfer until it is done.
- Alternatives: Changing the goal or the deadline after binding, even only lowering them.
- Specified in: [`docs/spec/containment-hook.md`, Binding (`bind`)](spec/containment-hook.md#binding-bind)
- Changes by: market-creation parameter
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-08: A deadline is required

- Question: What happens if the goal is never met or the home market breaks?
- Answer: Every binding carries an unlock deadline, and once it passes the unlock is due even if the goal was never met.
- Alternatives: None recorded.
- Specified in: [`docs/spec/containment-hook.md`, Unlock deadline](spec/containment-hook.md#unlock-deadline)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-09: Longest deadline

- Question: How far away may the unlock deadline be?
- Answer: At most 90 days after the binding.
- Alternatives: None recorded.
- Specified in: [`docs/spec/containment-hook.md`, Unlock deadline](spec/containment-hook.md#unlock-deadline)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-10: Who triggers the unlock

- Question: Who may unlock a token once the unlock is due?
- Answer: Anyone: `unlock` is permissionless, Aviary shows an Unlock button, and there is no keeper job for it in v1.
- Alternatives: A keeper job of ours.
- Specified in: [`docs/spec/containment-hook.md`, Unlock (`unlock`)](spec/containment-hook.md#unlock-unlock)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-11: What the unlock does

- Question: What does unlocking change on the mint?
- Answer: It clears both the transfer hook program and the hook authority, so the token becomes an ordinary Token-2022 token, tradable everywhere that accepts it (a mint with any of the group extensions still needs Meteora's approval for a permissionless DAMM v2 pool, and Aviary warns on it), and records the unlock time in a config that is never closed.
- Alternatives: The earlier default, it clears both the transfer hook program and the hook authority, so the token becomes an ordinary Token-2022 token, and records the unlock time in a config that is never closed (changed by the owner's answer 6a on #74 on 2026-11-23).
- Specified in: [`docs/spec/containment-hook.md`, Unlock (`unlock`)](spec/containment-hook.md#unlock-unlock)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-23
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-12: Mint rules at binding

- Question: Which mints can be contained?
- Answer: Token-2022 mints whose only extensions are on the tax AMM's allowlist and whose freeze authority is unset; `bind` needs the mint authority's signature, and a launch revokes it after `bind` and before the seed, since the tax AMM's seed refuses a mint that keeps one (`TAX-16`).
- Alternatives: The earlier default, the mint authority allowed to stay set for good, which let a launcher mint and sell into its home market (hardening finding H008 of the tax AMM); allowing a freeze authority, as the tax AMM once did.
- Specified in: [`docs/spec/containment-hook.md`, Checks on the mint](spec/containment-hook.md#checks-on-the-mint)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-22
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18); changed by the owner on 2026-11-22 in [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67)

### HOOK-13: How the hook decides

- Question: How does the hook treat a transfer it cannot check?
- Answer: It refuses it: one program serves every contained token, its `Execute` fails closed unless the config and the validation account are present and the source or destination is an allowed account, and it makes no CPI.
- Alternatives: Keeping `test-hook`'s path that approves a transfer when its accounts are left out.
- Specified in: [`docs/spec/containment-hook.md`, The allow rule](spec/containment-hook.md#the-allow-rule)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-14: Launching a contained token

- Question: How is a contained token launched in v1?
- Answer: By a devnet CLI script that creates the mint, creates the home market, binds with the goal and deadline as required flags with no defaults, then seeds; Aviary v1 does not launch tokens, and graduation from a launchpad is not supported.
- Alternatives: A launch page in Aviary; launchpad graduation into a contained home market.
- Specified in: [`docs/spec/containment-hook.md`, Launch in v1](spec/containment-hook.md#launch-in-v1)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-15: Mainnet upgrade policy

- Question: What is the hook's upgrade policy on mainnet?
- Answer: Frozen (upgrade authority removed) before any mainnet use, since a key that could upgrade it could block every contained token's transfers at once.
- Alternatives: An upgradeable hook under a multisig with a timelock, the shared default.
- Specified in: [`docs/spec/containment-hook.md`, Upgrade policy](spec/containment-hook.md#upgrade-policy)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-16: Compute ceilings

- Question: How much compute may each instruction use?
- Answer: `Execute` 10,000 units, `bind` 60,000 and `unlock` 30,000.
- Alternatives: None recorded.
- Specified in: [`docs/spec/containment-hook.md`, Compute ceilings](spec/containment-hook.md#compute-ceilings)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-17: In Aviary

- Question: What does Aviary show for a contained token?
- Answer: A panel on the home market's page (that the token is contained, the tax collected against the goal, the deadline, who receives the tax and whether its authority is live, the supply outside the pool, a warning on weak terms, what containment cannot see, and for a mint with group extensions that some venues may not accept it after the unlock), an Unlock button once the unlock is due, and the one-line rule in the trade box before a buy, built into Aviary since the hook has no strategy metadata.
- Alternatives: The earlier default, a panel on the home market's page (that the token is contained, the tax collected against the goal, the deadline), an Unlock button once the unlock is due, and the one-line rule in the trade box before a buy, built into Aviary since the hook has no strategy metadata (changed by the owner's answers 2a, 4a, 5a and 6a on #74 on 2026-11-23).
- Specified in: [`docs/spec/containment-hook.md`, In Aviary](spec/containment-hook.md#in-aviary)
- Changes by: spec only
- Status: changed 2026-11-23
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-18: Invariants

- Question: Which invariants does the hook's fuzzing check?
- Answer: Five beyond the shared three: no transfer between two accounts outside the home vault and the fee account, and no delivery outside them into an account whose owner can change, refusal when a hook account is missing or substituted, an unchanging config, `unlock` succeeding exactly when due, and every holder still able to exit through the home market.
- Alternatives: The earlier default, five beyond the shared three: no transfer between two accounts outside the home vault and the fee account, refusal when a hook account is missing or substituted, an unchanging config, `unlock` succeeding exactly when due, and every holder still able to exit through the home market (changed by the hardening of #74 on 2026-11-23 for `HOOK-47`).
- Specified in: [`docs/spec/containment-hook.md`, Invariants](spec/containment-hook.md#invariants)
- Changes by: spec only
- Status: changed 2026-11-23
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-19: Framework

- Question: Is the hook written in Anchor, although the `test-hook` it starts from is native code?
- Answer: Yes, in Anchor like every program of ours, keeping `test-hook`'s validation account and account order; it goes native only if `Execute` cannot stay under its ceiling in Anchor.
- Alternatives: Native code, as `test-hook` is written.
- Specified in: [`docs/spec/containment-hook.md`, Starting point](spec/containment-hook.md#starting-point)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### HOOK-20: A second devnet token

- Question: Which unlocks does the devnet demo show?
- Answer: Two: one contained token unlocked by a short deadline, and a second unlocked by reaching a small goal, so the unlock's read of the deployed tax AMM's counter is shown on devnet too.
- Alternatives: Only the token unlocked by its deadline.
- Specified in: [`docs/spec/containment-hook.md`, Done means](spec/containment-hook.md#done-means)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### HOOK-21: Where its policy values live

- Question: Where do the hook's policy values live in code?
- Answer: The longest unlock deadline and the tax AMM's program id are build-time constants in one config module of the program; the mint extension allowlist is the shared crate's, with the hook's stricter rule on the freeze authority added on top; the unlock goal and the unlock deadline are `bind`'s arguments, with no default anywhere.
- Alternatives: None recorded.
- Specified in: [`docs/spec/containment-hook.md`, Where its policy values live](spec/containment-hook.md#where-its-policy-values-live)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### HOOK-22: Expected Canary warns

- Question: Which Canary warns are expected on a contained token's home market?
- Answer: `exit_transferred` on every contained token, `contained_mint` while the hook can still be upgraded, and `token_authorities` while the launcher keeps the mint authority, beside the tax AMM's own.
- Alternatives: None recorded.
- Specified in: [`docs/spec/containment-hook.md`, Canary checks](spec/containment-hook.md#canary-checks)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23)

### HOOK-23: The edges of the unlock terms

- Question: What exactly do "later than now" and "at most 90 days" allow, and in what units are the goal and the deadline given?
- Answer: The goal is a `u64` in quote-mint base units above zero; the deadline is a Unix time strictly later than the binding's clock, and one exactly `MAX_UNLOCK_DEADLINE_SECS` (7,776,000 seconds) after it is allowed, a rule proved with Kani over every pair of times.
- Alternatives: A `u128` goal to match the tax AMM's `tax_collected` counter; allowing a deadline equal to the binding time.
- Specified in: [`docs/spec/containment-hook.md`, Binding (`bind`)](spec/containment-hook.md#binding-bind)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Containment hook: bind a token to its home market](https://github.com/imDev2023/testing-pipeline/issues/68)

### HOOK-24: Who pays for a binding

- Question: Must the mint authority also pay the rent of the config and the validation account?
- Answer: No: `bind` takes a payer that may be the mint authority or any other signer, so only the mint authority's signature is what makes the binding the launcher's.
- Alternatives: The mint authority pays, which a launcher whose mint authority is a cold key holding no SOL could not do.
- Specified in: [`docs/spec/containment-hook.md`, Binding (`bind`)](spec/containment-hook.md#binding-bind)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Containment hook: bind a token to its home market](https://github.com/imDev2023/testing-pipeline/issues/68)

### HOOK-25: Binding in its own transaction

- Question: Since `bind` does not fit in the market's creation transaction (1,307 of 1,232 bytes, measured), how does the launch script send it?
- Answer: In the next transaction, before the seed, measuring the size on every run and sending one transaction whenever it fits; it creates no address lookup table, with which the transaction would be 690 bytes.
- Alternatives: An address lookup table created first, which costs a transaction of its own and a slot's wait before it can be used.
- Specified in: [`docs/spec/containment-hook.md`, Launch in v1](spec/containment-hook.md#launch-in-v1)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Containment hook: bind a token to its home market](https://github.com/imDev2023/testing-pipeline/issues/68)

### HOOK-26: The launch script's own choices

- Question: What does the launch script choose for the token and its home market besides the goal and the deadline?
- Answer: Wrapped SOL as the quote mint unless `--quote-mint` names another, 6 decimals and a supply of 1,000,000,000 tokens, and a home market with a 3% buy tax (range 1% to 8%), a 5% sell tax (range 0% to 9%), the launcher as tax authority, seeder and only tax recipient, no burn, and a 30 SOL virtual quote reserve, all in one block at the top of the script.
- Alternatives: Flags for every market parameter, which the launch form in Aviary would carry instead once Aviary launches tokens.
- Specified in: [the ticket, Containment hook: bind a token to its home market](https://github.com/imDev2023/testing-pipeline/issues/68)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Containment hook: bind a token to its home market](https://github.com/imDev2023/testing-pipeline/issues/68)

### HOOK-27: Where the tax AMM's address comes from

- Question: How is the tax AMM's program id fixed in the hook?
- Answer: The hook's config module takes it from the tax AMM's own crate (`tax_amm::ID`), and reads the market state through the offsets that crate publishes, so the address and the layout are each written once in the workspace and a test fails if the hook's reading and the tax AMM's layout disagree.
- Alternatives: The address written out again in the hook's config module, checked against the tax AMM's by a test.
- Specified in: [`docs/spec/containment-hook.md`, Where its policy values live](spec/containment-hook.md#where-its-policy-values-live)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Containment hook: bind a token to its home market](https://github.com/imDev2023/testing-pipeline/issues/68)

### HOOK-28: `Execute` stays in Anchor

- Question: Does `Execute` stay under its 10,000-unit ceiling in Anchor, or must it be written natively?
- Answer: It stays in Anchor: it costs 5,578 to 5,603 units on each hooked transfer of a trade, measured through devnet's router, because it checks the config and the validation account with the bumps the config stores and reads the source's `transferring` flag straight from its bytes, with no CPI.
- Alternatives: A native `Execute`, as `test-hook` is written, which the measurement made unnecessary.
- Specified in: [`docs/spec/containment-hook.md`, Measured](spec/containment-hook.md#measured)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Containment hook: a contained token moves only through its home market](https://github.com/imDev2023/testing-pipeline/issues/69)

### HOOK-29: The launch script's seed and trades

- Question: How does the launch script seed and trade a contained token after binding it?
- Answer: It seeds 800,000,000 of the 1,000,000,000 tokens single-sided on the market's virtual quote reserve, buys with one whole unit of the quote mint and sells half of what it bought through the router with Pipeline's SDK, resolving the hook accounts from the validation account with Token-2022's own client, checks before sending anything that the launcher can pay for the whole launch, and shows the hook refusing a wallet-to-wallet transfer and a sell with a 50 basis point integrator fee in simulation, so no failed transaction lands.
- Alternatives: Seeding both sides, which would make the launcher wrap quote liquidity the virtual reserve already prices; sending the refused transactions, which would leave failed transactions on devnet.
- Specified in: [the ticket, Containment hook: a contained token moves only through its home market](https://github.com/imDev2023/testing-pipeline/issues/69)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Containment hook: a contained token moves only through its home market](https://github.com/imDev2023/testing-pipeline/issues/69)

### HOOK-30: Who signs `unlock`

- Question: Does `unlock` take a signer of its own, such as a caller account?
- Answer: No: its accounts are the mint, the config, the unlock PDA, the market state and Token-2022, so anyone can send it and pays only the transaction fee, as a fresh wallet with no tie to the token does in the tests and the launch script.
- Alternatives: A caller account that signs, which adds an account and checks nothing the unlock needs.
- Specified in: [`docs/spec/containment-hook.md`, Unlock (`unlock`)](spec/containment-hook.md#unlock-unlock)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Containment hook: unlock by the goal or the deadline](https://github.com/imDev2023/testing-pipeline/issues/70)

### HOOK-31: A second unlock

- Question: How is a second `unlock` refused?
- Answer: By the config, which records the first unlock's time, with its own error `AlreadyUnlocked` (6022) before any call to Token-2022, which would refuse it anyway because the hook authority that must sign is gone.
- Alternatives: Leaving the refusal to Token-2022's authority check alone, whose error says nothing about the unlock.
- Specified in: [`docs/spec/containment-hook.md`, Unlock (`unlock`)](spec/containment-hook.md#unlock-unlock)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Containment hook: unlock by the goal or the deadline](https://github.com/imDev2023/testing-pipeline/issues/70)

### HOOK-32: How the unlock says what made it due

- Question: How does `unlock` record whether the goal or the deadline made it due?
- Answer: In a log line, "Unlocked by the goal: <collected> of <goal> collected" or "Unlocked by the deadline <deadline>", naming the goal when both hold; the config records only the time, as the spec's accounts table says.
- Alternatives: An Anchor event; a field in the config for the reason, which would change the config's layout.
- Specified in: [`docs/spec/containment-hook.md`, Unlock (`unlock`)](spec/containment-hook.md#unlock-unlock)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Containment hook: unlock by the goal or the deadline](https://github.com/imDev2023/testing-pipeline/issues/70)

### HOOK-33: The launch script's unlock

- Question: How does the launch script show a token unlocked by its goal and another by its deadline?
- Answer: An optional `--unlock goal` or `--unlock deadline`: by the goal it trades rounds of a buy of one whole unit of the quote mint and a sell back until the goal is collected, refusing up front a goal that would take more than 10 rounds; by the deadline it waits, refusing up front a deadline less than 60 or more than 600 seconds away and a goal the launch's own trades could reach; a fresh wallet funded with 0.002 SOL sends the unlock; without the flag the token stays contained.
- Alternatives: Always unlocking, which would leave no way to launch a token that stays contained; a separate unlock script, which would repeat the launch's setup to find the market.
- Specified in: [the ticket, Containment hook: unlock by the goal or the deadline](https://github.com/imDev2023/testing-pipeline/issues/70)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Containment hook: unlock by the goal or the deadline](https://github.com/imDev2023/testing-pipeline/issues/70)

### HOOK-34: The deadline without the market state

- Question: Does an unlock by the deadline still need the home market's state to be readable?
- Answer: No: a market state at the recorded address that can no longer be read as the tax AMM's (another owner, another size, discriminator or version, or closed) counts as the goal not reached, so the deadline still unlocks; before the deadline such a market state is refused with `NotATaxMarketState`.
- Alternatives: The earlier default, the same without the version (`HOOK-43` added it on 2026-11-23); refusing every unlock whose market state cannot be read, which would trap holders for good if a tax AMM upgrade changed the account, the case the deadline exists for.
- Specified in: [`docs/spec/containment-hook.md`, Unlock (`unlock`)](spec/containment-hook.md#unlock-unlock)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-23
- Decided: 2026-11-16 in [Containment hook: unlock by the goal or the deadline](https://github.com/imDev2023/testing-pipeline/issues/70)

### HOOK-35: The launch script's rehearsal of the devnet launch

- Question: How does one run of the launch script rehearse the devnet launch, with its two contained tokens and the sweep of Pipeline's fee?
- Answer: Each `--goal` and `--deadline` pair launches one token, one after another in the same run, with `--unlock` given for every token or for none, and every launch sweeps Pipeline's fee from the fee account its sell paid into to Pipeline's treasury with the router's `sweep_fees`: the token's, with the hook accounts, on a home market quoted in a mint other than wrapped SOL, and the quote mint's on one quoted in wrapped SOL, whose token fee account Pipeline 0.3 leaves empty (`BAR-44`).
- Alternatives: The earlier default, always sweeping the fee in the token through the hook, which on a market quoted in wrapped SOL has nothing to sweep since Pipeline 0.3; Two runs of the script, one per token; a separate rehearsal script, which would repeat the launch's setup.
- Specified in: [the ticket, Containment hook: invariant fuzzing of contained tokens](https://github.com/imDev2023/testing-pipeline/issues/71)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Containment hook: invariant fuzzing of contained tokens](https://github.com/imDev2023/testing-pipeline/issues/71)

### HOOK-36: How the fuzzer judges the hook's invariants

- Question: How does the containment hook's invariant fuzzer check its five invariants?
- Answer: On every market shape the tax AMM's fuzzer builds, with the contained mint at either index and the tax AMM's own invariants lifted beside the hook's, it checks invariant 1 by the balances of every account of the token the world knows (what leaves the outside accounts must reach the home vault or the fee account, and the reverse), invariant 5 by simulating a sale of every signer's whole holding through the router with the hook accounts, and runs 1,000 sequences of up to 50 steps in CI, spread over every core.
- Alternatives: Reading each transaction's token transfers for invariant 1, which would miss a token moved by an instruction the reader does not know; checking only quotes for invariant 5, which never runs the hook.
- Specified in: [the ticket, Containment hook: invariant fuzzing of contained tokens](https://github.com/imDev2023/testing-pipeline/issues/71)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Containment hook: invariant fuzzing of contained tokens](https://github.com/imDev2023/testing-pipeline/issues/71)

### HOOK-37: What `bind`'s ceiling counts

- Question: Does `bind`'s compute ceiling count what its bump searches spend, which depends on the mint's address?
- Answer: No: like the tax AMM's ceilings, it leaves out the 1,500 units each of its four searches spends for every bump tried after the first, so `bind` costs the same 20,916 units on every mint against its 60,000.
- Alternatives: Counting the whole cost, which reached 55,416 units in the fuzzer and would fail on a rare mint; passing the bumps to `bind` as arguments, which would change its instruction.
- Specified in: [`docs/spec/containment-hook.md`, Compute ceilings](spec/containment-hook.md#compute-ceilings)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Containment hook: invariant fuzzing of contained tokens](https://github.com/imDev2023/testing-pipeline/issues/71)

### HOOK-38: How the launch script checks a home market's conformance

- Question: How does the launch script show that a contained token's home market passes Pipeline's conformance checker, while the token is contained and after its unlock?
- Answer: Given `--pipeline-check`, it runs `pipeline-check --fail-on-warn` on the home market after the launch's refusals and again after the unlock, with the explicit trade sizes `CONFORMANCE_AMOUNTS` (1,000,000, 100,000,000 and 1,000,000,000 base units) that a market launched single-sided on a virtual quote reserve needs, and stops unless every check passed but `exact_out_refund`, skipped.
- Alternatives: The checker's own sizes, which it takes from vault balances and which ask a large sell of the token that the little real quote reserve cannot pay (`InsufficientLiquidity`, a warn); running the checker by hand between two runs of the script, which would split one token's life over two runs.
- Specified in: [`docs/toolchain.md`, Containment hook](toolchain.md#containment-hook)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Containment hook: deploy on devnet and launch a contained token](https://github.com/imDev2023/testing-pipeline/issues/73)

### HOOK-39: Which refusals the launch script lands on chain

- Question: Which of the hook's refusals does the launch script send past the preflight, so that each lands on chain with a signature, rather than showing it in simulation?
- Answer: The wallet-to-wallet `transfer_checked` of every token, and, for a token unlocked by its goal, the `unlock` sent while the home market's `tax_collected` is above zero but below the goal; the sell with an integrator fee, the `unlock` right after the seed and the second `unlock` stay in simulation.
- Alternatives: Every refusal in simulation, which leaves the devnet demo without a signature for what containment refuses; every refusal on chain, which adds failed transactions that show nothing the simulated ones do not.
- Specified in: [`docs/toolchain.md`, Containment hook](toolchain.md#containment-hook)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Containment hook: deploy on devnet and launch a contained token](https://github.com/imDev2023/testing-pipeline/issues/73)

### HOOK-40: The devnet demo's contained tokens and their record

- Question: What terms do the devnet demo's contained tokens get, and where is the run recorded?
- Answer: One run of the launch script: the first token against wrapped SOL with a goal of 5,000,000,000 lamports and a deadline 240 seconds after the run starts, unlocked by the deadline, the second against wrapped SOL with a goal of 100,000,000 lamports and a deadline a day away, unlocked by the goal, and the third against the devnet SPL Token mint of `HOOK-41`, left contained; every signature and address of the run is in `deployments/devnet-demo-containment-hook.json`, and each `pipeline-check` report in `programs/containment-hook/conformance/devnet/`.
- Alternatives: A deadline of days for the first token, which would leave the ticket open until it passed; a goal of whole SOL for the second, which would cost the launcher a round of trades for every 0.03 SOL of tax.
- Specified in: [`docs/toolchain.md`, Containment hook](toolchain.md#containment-hook)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Containment hook: deploy on devnet and launch a contained token](https://github.com/imDev2023/testing-pipeline/issues/73)

### HOOK-41: Pipeline's fee in the token on devnet

- Question: Since Pipeline 0.3.0 takes its fee in a market's fee mint, which is wrapped SOL on any market that trades it, how does the devnet demo still show Pipeline's fee in a contained token swept through the hook?
- Answer: The two contained tokens against wrapped SOL sweep Pipeline's fee in SOL from the market's wrapped-SOL fee account, and a third contained token, quoted in a devnet SPL Token mint of ours, pays the fee on its sells in the token into its fee account through the hook, which `sweep_fees` then moves to Pipeline's treasury with the hook accounts.
- Alternatives: Sweeping only the wrapped-SOL fee accounts, which never shows the hook passing the fee account; quoting both tokens in an SPL Token mint of ours instead of wrapped SOL, which leaves a home market quoted in wrapped SOL, the launch script's default quote, untried on devnet.
- Specified in: [`docs/spec/containment-hook.md`, Done means](spec/containment-hook.md#done-means)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Containment hook: deploy on devnet and launch a contained token](https://github.com/imDev2023/testing-pipeline/issues/73)

### HOOK-42: The goal counts from the binding

- Question: May `bind` bind a home market that has already collected tax?
- Answer: No: `bind` refuses a market state whose tax collected is above zero (`MarketAlreadyCollectedTax`), so the unlock goal counts only tax collected under containment; a launch binds before its seed, when nothing can have traded, so this refuses only a market that traded before its token was pointed at the hook.
- Alternatives: Recording the counter at binding as a baseline, which needs a new field in the config, whose layout is frozen (`HOOK-46`); requiring the market not yet seeded as well, which adds a dependency on another tax AMM offset for no further protection, since an unseeded market has collected nothing.
- Specified in: [`docs/spec/containment-hook.md`, Checks on the home market](spec/containment-hook.md#checks-on-the-home-market)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### HOOK-43: Which market state versions the hook reads

- Question: How does the hook read a home market state written by a later version of the tax AMM?
- Answer: As unreadable: the hook reads a market state only at version 1, the one it was built against, so `bind` refuses a newer one and `unlock` leaves it to the deadline; a tax AMM build that changes its version fails the hook's own build until the hook is reviewed against it.
- Alternatives: Reading any version, which a later tax AMM build that kept the account's size but moved the counter would turn into a forged early unlock; refusing every unlock of such a market, which would trap holders for good, the case the deadline exists for (`HOOK-34`).
- Specified in: [`docs/spec/containment-hook.md`, Unlock (`unlock`)](spec/containment-hook.md#unlock-unlock)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### HOOK-44: A multisig mint authority

- Question: May a mint whose mint authority is a Token-2022 multisig be bound?
- Answer: No: `bind` checks one signer, and a multisig account's address can sign only through the keypair it was created at, which would bind the mint without the multisig's other signers, so `bind` refuses a mint authority owned by Token-2022 (`MintAuthorityIsMultisig`); a launcher binds first and may move the authority to a multisig afterwards, until the seed revokes it.
- Alternatives: Accepting the multisig's signers in the remaining accounts and checking M of N, more code on a path each token takes once.
- Specified in: [`docs/spec/containment-hook.md`, Binding (`bind`)](spec/containment-hook.md#binding-bind)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### HOOK-45: `Execute`'s own address checks

- Question: Since Token-2022 passes the validation account and the config at their derived addresses, does `Execute` still check that each sits at its PDA?
- Answer: Yes, both behind one helper: each check costs about 1,500 units and `Execute` stays near 5,700 of its 10,000, and the hook, frozen before mainnet, keeps no identity check that rests on the caller; the helper keeps the two from drifting apart.
- Alternatives: Dropping both, keeping the owner, discriminator and stored-mint checks, about 3,000 units less per hooked transfer; the review's mutation run found every substitution through a real transfer refused either way.
- Specified in: [`docs/spec/containment-hook.md`, The allow rule](spec/containment-hook.md#the-allow-rule)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### HOOK-46: The frozen config layout and the hook's release gate

- Question: What must a redeploy of the hook prove for tokens contained before it?
- Answer: The config's version 1 layout never changes while any token is bound, and no build replaces the deployed hook until its release gate, run by `scripts/deploy-devnet.sh` on the very bytes it deploys, has checked a census of every account the hook owns against its copy (on devnet also against every config the committed fixture and the launch record hold, missing ones passing only with an override that names why), bound a fresh mint, decoded every config on the cluster with the new build, traded, refused a wallet transfer, a buy into an account whose owner can change and a direct `Execute`, swept the fee account where the fee is in the token, and unlocked by the goal and at the deadline each token still contained; balances in accounts whose owner can change are reported, never refused.
- Alternatives: Reallocating a versioned config before it grows, which every instruction would then have to handle; trusting the tests on fresh configs, which cannot see a layout change that breaks only configs written by the deployed build.
- Specified in: [`docs/spec/containment-hook.md`, Upgrade policy](spec/containment-hook.md#upgrade-policy)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### HOOK-47: Destinations whose owner can change

- Question: Since Token-2022 lets an account's owner hand the whole account to another wallet with no transfer and no hook call, how does the hook keep a contained token in its home market?
- Answer: `Execute` refuses a destination other than the home vault and the fee account unless it carries the immutable owner extension, as every associated token account of Token-2022 does (`DestinationOwnerCanChange`); sells and sources are untouched, so every holder can still exit; Pipeline's `pipeline-check` fakes its traders' accounts without the extension, so its `quote_matches_swap` and `round_trip`, and `exact_out_refund` where it runs, are known failures on contained markets until its checker writes it, in the hook's conformance test, the launch script's run and Canary.
- Alternatives: Also accepting a destination at the associated token address of the owner its data names, which accepts the same accounts on chain and exists only to keep `pipeline-check` passing, at a bump search's cost; keeping the location-only rule and disclosing the escape; a rule on sources, which an owner change, moving no tokens, would never meet.
- Specified in: [`docs/spec/containment-hook.md`, The allow rule](spec/containment-hook.md#the-allow-rule)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### HOOK-48: What containment polices

- Question: Does containment also refuse holders that are programs or smart wallets, whose control can change hands without a transfer?
- Answer: No: containment polices token movements, not who controls a key, so a Squads vault, a program's account or a wrapper issuing receipts is disclosed in the spec and on Aviary's panel rather than refused; every unit in such a structure came in by a taxed buy and leaves only by a taxed sell.
- Alternatives: Refusing a destination whose owner is off the ed25519 curve, about 160 units, which closes every trustless program-held structure but refuses smart-wallet users, DAO and program treasuries and aggregator routes into program-owned accounts.
- Specified in: [`docs/spec/containment-hook.md`, What the hook cannot see](spec/containment-hook.md#what-the-hook-cannot-see)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### HOOK-49: What the unlock goal promises

- Question: Since whoever receives the tax can reach the goal for a fraction of it, atomically, what does the goal promise?
- Answer: That a third party pays at least the goal to force the unlock (102% to 125% of it); the launcher as sole recipient pays `1 - 0.9a + f(2 - t)/t` of it (12.38% at 10% and 10% on wrapped SOL, 16.12% at the launch default), possibly in one transaction, which the spec states with its numbers and Aviary's panel shows by naming the recipients, the launcher's share, whether the tax authority is live and any pending rate change.
- Alternatives: `bind` refusing a home market whose tax authority is live, which stops rate changes after the binding but not the wash; counting only tax paid by non-recipients, which a recipient evades from another wallet; a goal seen in an earlier slot, which needs new config state (`HOOK-46`).
- Specified in: [`docs/spec/containment-hook.md`, Unlock goal](spec/containment-hook.md#unlock-goal)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### HOOK-50: Supply held outside the pool

- Question: What protects buyers from a launcher selling supply held outside the home market's pool into the real quote they paid in?
- Answer: Disclosure: Canary's `outside_supply` warn and Aviary's panel show it, and the launch script's defaults keep less of the supply outside the pool; the drain is a virtual reserve's property, possible on any AMM.
- Alternatives: The tax AMM's seed requiring a contained mint's whole supply in the vault, so a launcher gets an allocation only by buying it.
- Specified in: [`docs/spec/containment-hook.md`, Canary checks](spec/containment-hook.md#canary-checks)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### HOOK-51: The mainnet freeze gate

- Question: How is `HOOK-15`'s freeze enforced, given one key upgrades both the hook and the tax AMM?
- Answer: Both programs are frozen together in one transaction, and every contained mint's hook fields are checked before and after (its program the hook and its authority its unlock PDA, or both cleared); a script does the check and the freeze and refuses unless both end with no upgrade authority, and on devnet it runs as a check only.
- Alternatives: Recording the rule now and building the script in the mainnet ticket.
- Specified in: [`docs/spec/containment-hook.md`, Upgrade policy](spec/containment-hook.md#upgrade-policy)
- Changes by: spec only
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

### HOOK-52: The quote mint at binding

- Question: Does `bind` check the home market's quote mint, whose payouts every holder's exit depends on?
- Answer: Yes: `bind` takes the quote mint, which must be the market's other mint, refuses one with a live transfer hook (any program's, this hook's included; a hook cleared for good passes), and refuses one with a mint or freeze authority unless it is on the tax AMM's quote list, by the tax AMM's own rule, so the list has one place.
- Alternatives: Refusing any quote with a freeze authority or a hook, which rules out USDC; refusing only a quote with a hook; relying on the tax AMM's creation and seed rules alone, which a later tax AMM change could loosen after the hook is frozen.
- Specified in: [`docs/spec/containment-hook.md`, Checks on the home market](spec/containment-hook.md#checks-on-the-home-market)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-23 in [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74)

## Buy wall AMM (POOL4)

`POOL4-01` to `POOL4-21` keep the numbers their tickets proposed, which the buy wall AMM's build tickets already cite.

### POOL4-01: Whether we build it

- Question: Do we build a port of IMD's Pool4 design at all?
- Answer: Yes, as our own strategy, the buy wall AMM, built, deployed on devnet and registered with Pipeline.
- Alternatives: Supporting only an existing port in Aviary; building on top of one.
- Specified in: [`docs/spec/pool4-for-solana.md`, Buy wall AMM](spec/pool4-for-solana.md#buy-wall-amm)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-02: Fee rate

- Question: What fee does a buy wall market charge?
- Answer: A rate chosen per market at creation, from 0.25% to 3% (`MIN_FEE_BPS`, `MAX_FEE_BPS`), never changeable; Aviary's create form pre-fills 1%.
- Alternatives: IMD's fixed 1%; 0.5% swept plus 0.15% kept by the pool.
- Specified in: [`docs/spec/pool4-for-solana.md`, Creation parameters](spec/pool4-for-solana.md#creation-parameters)
- Changes by: market-creation parameter
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-03: Fee token

- Question: In which token is the fee taken?
- Answer: Always SOL: from the SOL paid in on a buy and from the SOL paid out on a sell.
- Alternatives: On whichever token comes in, as IMD does.
- Specified in: [`docs/spec/pool4-for-solana.md`, The fee](spec/pool4-for-solana.md#the-fee)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-04: Who gets the fee

- Question: Who gets the fee?
- Answer: 10% to IMD and Adam, the designer share (`DESIGNER_SHARE_BPS`); 10% to us, the suite share (`SUITE_SHARE_BPS`); and 80% to the market, divided between its fee recipient and its buy wall as its creator sets.
- Alternatives: Everything to one recipient; a part kept in the curve; other shares.
- Specified in: [`docs/spec/pool4-for-solana.md`, Constants](spec/pool4-for-solana.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-05: Where the designer share waits

- Question: Where is the designer share paid while IMD and Adam have no known Solana address?
- Answer: It builds up in each market and waits there; the wallet is the constant `DESIGNER_RECIPIENT`, unset on devnet and set by an upgrade before the program is frozen.
- Alternatives: A program-wide vault with a settable recipient; paying it to us to pass on.
- Specified in: [`docs/spec/pool4-for-solana.md`, Constants](spec/pool4-for-solana.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-06: Trimmed tokens and SOL

- Question: What happens to trimmed tokens and trimmed SOL?
- Answer: A reward share of 0% to 30% per market (the form pre-fills 15%) goes to one rewards recipient and the rest is burned, the reward share paid only on trimmed tokens the cap's own fall matched ([POOL4-49](#pool4-49-which-retired-tokens-earn-the-reward-share)); all trimmed SOL becomes the buy wall, and tokens the wall buys are burned whole.
- Alternatives: The earlier default, in which tokens the wall buys went through the same split and every retired token earned the reward share; burning everything; IMD's fixed 85/15 with its three-way reward split.
- Specified in: [`docs/spec/pool4-for-solana.md`, Creation parameters](spec/pool4-for-solana.md#creation-parameters)
- Changes by: market-creation parameter
- Status: changed 2026-11-17
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-07: Staking

- Question: Is staking with streamed rewards in v1?
- Answer: No; a market's rewards recipient can be a staking program later.
- Alternatives: Shipping a staking vault and dripper with v1, as IMD has.
- Specified in: [`docs/spec/pool4-for-solana.md`, Not in v1](spec/pool4-for-solana.md#not-in-v1)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-08: With the containment hook

- Question: Can a buy wall market be a contained token's home market?
- Answer: Not in v1, because the hook's first version binds only tax AMM markets; the buy wall AMM works with plain mints and keeps everything a later hook version would need.
- Alternatives: Requiring the hook; making these markets home markets in v1.
- Specified in: [`docs/spec/pool4-for-solana.md`, With the containment hook](spec/pool4-for-solana.md#with-the-containment-hook)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-09: How markets are created

- Question: Who creates a buy wall market, and how?
- Answer: Anyone: seeded by a launchpad in one call, or created and seeded by the creator in one transaction, with one seed that is locked for good.
- Alternatives: Only by graduation from one bonding curve.
- Specified in: [`docs/spec/pool4-for-solana.md`, Creating a market](spec/pool4-for-solana.md#creating-a-market)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-10: Control after the seed

- Question: Who controls a market after the seed?
- Answer: Nobody, us included: no close, no withdrawal and no parameter change; each of the two recipients may hand its own role to another wallet.
- Alternatives: IMD's owner powers (close, withdraw, change every parameter); recipients fixed for good.
- Specified in: [`docs/spec/pool4-for-solana.md`, Recipients](spec/pool4-for-solana.md#recipients)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-11: What a creator chooses

- Question: Which parameters does a market's creator choose?
- Answer: The fee, the wall split, the reward share, both recipients, the cap floor (0.1% to 100% of the seeded tokens) and the cap decay (0% to 100% of them a day), all fixed at creation; the form pre-fills a floor of 20% and a decay of 20% a day, IMD's own ratios.
- Alternatives: Everything per market; everything fixed.
- Specified in: [`docs/spec/pool4-for-solana.md`, Creation parameters](spec/pool4-for-solana.md#creation-parameters)
- Changes by: market-creation parameter
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-12: The buy wall's guard

- Question: How is the buy wall kept from being placed at a pumped price?
- Answer: By IMD's guard, per slot ([`POOL4-50`](#pool4-50-when-the-walls-floor-moves)): at a slot's first update the wall's floor drops to the previous slot's close and rises about 4% a day (`FLOOR_CRAWL_BPS`) toward a reference that follows the price by at most 2% per 12 seconds (`REF_STEP_BPS`, `REF_STEP_WINDOW`).
- Alternatives: The earlier default, the floor dropping at once with every swap's price; refusing to place the wall when the price is far above a reference.
- Specified in: [`docs/spec/pool4-for-solana.md`, Constants](spec/pool4-for-solana.md#constants)
- Changes by: build-time constant
- Status: changed 2026-11-17
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-13: Cap decay while idle

- Question: Does cap decay allowance build up while a market is idle?
- Answer: For at most one day, the constant `DECAY_CREDIT_WINDOW`.
- Alternatives: Without limit, as in IMD's hook.
- Specified in: [`docs/spec/pool4-for-solana.md`, Constants](spec/pool4-for-solana.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-14: Minimum trim and exact-out

- Question: Is there a minimum trim size, and are exact-out swaps supported?
- Answer: No minimum trim, and exact-in only in v1.
- Alternatives: A minimum trim; exact-out across the wall.
- Specified in: [`docs/spec/pool4-for-solana.md`, After pricing](spec/pool4-for-solana.md#after-pricing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-15: Keeper jobs and tips

- Question: Which keeper jobs does a market need, and what do they pay?
- Answer: Four permissionless actions: place the wall, settle, pay rewards and sweep fees; only placing the wall tips its caller, the lower of 0.002 SOL (`KEEPER_TIP_CAP`) and the market's fee rate times the SOL handled, once 0.01 SOL (`WALL_THRESHOLD`) is idle or spent.
- Alternatives: A flat share of the work on every job; jobs only our keeper may call.
- Specified in: [`docs/spec/pool4-for-solana.md`, Keeper jobs](spec/pool4-for-solana.md#keeper-jobs)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-16: Upgrades never strand a market

- Question: How do upgrades avoid stranding markets?
- Answer: A fixed-size market state with a layout version and reserved space, a release gate that replays every live market against the new build before it deploys, and fixtures of every released layout in CI.
- Alternatives: Migrating accounts at each upgrade; resizable accounts.
- Specified in: [`docs/spec/pool4-for-solana.md`, Market state](spec/pool4-for-solana.md#market-state)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-17: Mint rules

- Question: Which tokens may a buy wall market hold?
- Answer: The token against wrapped SOL only, with the token's mint and freeze authorities removed and any transfer hook cleared by the time of the seed (the hook as `POOL4-48` says), and only the tax AMM's allowlist of Token-2022 extensions.
- Alternatives: The earlier default, the same with any transfer hook accepted whatever its program and authority; allowing mint and freeze authorities, as the tax AMM does; other quote mints.
- Specified in: [`docs/spec/pool4-for-solana.md`, Mint rules](spec/pool4-for-solana.md#mint-rules)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-17
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-18: Mainnet upgrade policy

- Question: What is the buy wall AMM's upgrade policy on mainnet?
- Answer: Frozen before any mainnet deployment, after the designer share's wallet is set.
- Alternatives: The shared default of a multisig with a timelock first.
- Specified in: [`docs/spec/pool4-for-solana.md`, Upgrades and freezing](spec/pool4-for-solana.md#upgrades-and-freezing)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20)

### POOL4-19: Build order and the first deploy

- Question: In what order is the buy wall AMM built, and when does it first reach devnet?
- Answer: Feature tickets first, verified on a local validator and in LiteSVM against devnet's router, then the release gate, then hardening, then one devnet ticket that deploys, registers, runs the demo market and proves the gate with a real upgrade; hardening comes before the deploy, so the registered bytes are the hardened ones and the layout freezes once.
- Alternatives: Deploying after the first slice and upgrading devnet through the gate with every later ticket; hardening last, after the deploy.
- Specified in: [`docs/spec/pool4-for-solana.md`, Build tickets](spec/pool4-for-solana.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut Pool4 for Solana's build tickets](https://github.com/imDev2023/testing-pipeline/issues/24)

### POOL4-20: The first layout fixture

- Question: Where does the first layout fixture come from before any market exists on devnet?
- Answer: From a LiteSVM market traded through the real router, marked synthetic, until the devnet demo market provides a real one; CI keeps both.
- Alternatives: Waiting for devnet before the release gate can run in CI.
- Specified in: [`docs/spec/pool4-for-solana.md`, Fixtures in CI](spec/pool4-for-solana.md#fixtures-in-ci)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut Pool4 for Solana's build tickets](https://github.com/imDev2023/testing-pipeline/issues/24)

### POOL4-21: The market state's discriminator

- Question: How is the market state's account discriminator chosen?
- Answer: It is written as fixed bytes in the code, never derived from the type's name, so a rename can never strand a market.
- Alternatives: Anchor's default discriminator, derived from the type's name.
- Specified in: [`docs/spec/pool4-for-solana.md`, Byte offsets](spec/pool4-for-solana.md#byte-offsets)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Cut Pool4 for Solana's build tickets](https://github.com/imDev2023/testing-pipeline/issues/24)

### POOL4-22: The market state's discriminator and layout version

- Question: Which bytes are the market state's account discriminator, and how are its layout version and status numbered?
- Answer: The discriminator is the ASCII bytes `BWMARKET`, the first layout is version 1 and the only one every instruction accepts until another is deployed, and `status` is 1 once created and 2 once seeded, so a zeroed account never reads as a market.
- Alternatives: Anchor's derived discriminator frozen as fixed bytes; status 0 for a created market.
- Specified in: [`docs/spec/pool4-for-solana.md`, Byte offsets](spec/pool4-for-solana.md#byte-offsets)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Buy wall AMM: a market opens (the program from the template, the fixed-size market state, creation and the seed)](https://github.com/imDev2023/testing-pipeline/issues/47)

### POOL4-23: What the market state keeps beyond the spec's field list

- Question: Which fields does the fixed layout hold that the spec's field list did not name, and how wide is each kind of field?
- Answer: It also keeps the creation parameters `cap_floor_bps` and `cap_decay_bps` (the cap floor and cap decay can only be computed at the seed) and the bumps of the vault authority and both vaults; ledgers, the cap and other amounts of one token are 64-bit, while square-root prices, liquidity, the counters, the decay credit and the lifetime totals are 128-bit, and 305 zeroed bytes are reserved.
- Alternatives: Computing the cap floor and decay at creation from an intended seed; 64-bit lifetime totals.
- Specified in: [`docs/spec/pool4-for-solana.md`, Byte offsets](spec/pool4-for-solana.md#byte-offsets)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Buy wall AMM: a market opens (the program from the template, the fixed-size market state, creation and the seed)](https://github.com/imDev2023/testing-pipeline/issues/47)

### POOL4-24: The vault authority in a swap

- Question: How does a swap reach the vault authority that signs the transfer out of a vault, when a program can sign for a PDA only if its account is passed in and the router passes only its ten fixed accounts?
- Answer: `pipeline_resolve_accounts` lists two accounts, the output vault and then the vault authority (read-only), and `pipeline_swap` checks the authority against the PDA from the market state's stored bump before signing with it, as the tax AMM does (`TAX-35`).
- Alternatives: The earlier default, a swap resolving one account, the output vault, which the runtime cannot sign out of; vaults that own themselves, which keeps one account but changes creation, metadata and the spec's Addresses and leaves `authority_bump` unused.
- Specified in: [`docs/spec/pool4-for-solana.md`, Addresses](spec/pool4-for-solana.md#addresses)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-12
- Decided: 2026-11-12 in [Buy wall AMM: plain trading through the router](https://github.com/imDev2023/testing-pipeline/issues/48)

### POOL4-25: The fee shares in the IDL

- Question: How does the demo script learn the designer share and the suite share to check a swap's fee split, without restating them?
- Answer: The program publishes `DESIGNER_SHARE_BPS` and `SUITE_SHARE_BPS` in its IDL with Anchor's `#[constant]`, so the generated TypeScript client carries both and `config.rs` stays their one place, as the tax AMM does (`TAX-37`).
- Alternatives: Restating them in the demo; publishing the price bounds too, which Codama 2.8 renders as invalid TypeScript for a u128 of 2^96.
- Specified in: [`docs/spec/pool4-for-solana.md`, Constants](spec/pool4-for-solana.md#constants)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Buy wall AMM: plain trading through the router](https://github.com/imDev2023/testing-pipeline/issues/48)

### POOL4-26: Dividing by two square-root prices

- Question: How does the pricing divide by a product of two square-root prices, which the spec's rule stages one price at a time where a product could overflow?
- Answer: It divides once by the product, which fits in 256 bits because each price is below 2^128 and gives the same floor or ceiling as the staged divisions; with a sell computing its `need` only when it reaches its target, this took the costliest quote measured from 35,648 to 15,682 compute units of its 40,000 ceiling, and only numerators can overflow, which refuses the trade.
- Alternatives: Dividing by one price at a time, as the rule first read.
- Specified in: [`docs/spec/pool4-for-solana.md`, Rules for both](spec/pool4-for-solana.md#rules-for-both)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Buy wall AMM: plain trading through the router](https://github.com/imDev2023/testing-pipeline/issues/48)

### POOL4-27: Paying a swap's output to another wallet's account

- Question: Does the strategy refuse a swap whose output account belongs to someone other than the trader?
- Answer: No: the router lets a trader name the account its output goes to, and the strategy pays exactly that account exactly the quote, refusing only the output vault itself, which would book a payout that never moved.
- Alternatives: Refusing any output account the trader does not own, which would break a router feature for nothing the market risks.
- Specified in: [`docs/spec/pool4-for-solana.md`, Bypass](spec/pool4-for-solana.md#bypass)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Buy wall AMM: plain trading through the router](https://github.com/imDev2023/testing-pipeline/issues/48)

### POOL4-28: How metadata describes seeding from another program

- Question: How does the buy wall AMM's metadata tell a launcher how to fill in `pipeline_seed_liquidity`, which Pipeline's metadata standard has no field for?
- Answer: As the tax AMM does (`TAX-41`): a top-level `seed_liquidity` form shaped as `init` is, with the seeded market state as a `pda:` source keyed by `input:seeder`, `input:token_mint` and wrapped SOL, `data` as init's arguments under the same IDL type with the seeder marked ignored, and the vault authority and both vaults after Pipeline's fixed seed accounts.
- Alternatives: A prose description only, which no tool could resolve; a `create_market` custom action, which is called by a wallet, not by another program.
- Specified in: [`docs/spec/pool4-for-solana.md`, Custom actions and metadata](spec/pool4-for-solana.md#custom-actions-and-metadata)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Buy wall AMM: seeding by another program](https://github.com/imDev2023/testing-pipeline/issues/53)

### POOL4-29: How a seed request is checked

- Question: What does the buy wall AMM's `pipeline_seed_liquidity` check beyond the creation, mint and seed rules, and what does it report and emit?
- Answer: Exactly two amounts, the token's then wrapped SOL's (an error of its own otherwise), `data` exactly the creation parameters, escrows owned by the seeder as `seed` requires of the seeder's accounts, `SeedResult.taken` as what it measured leaving each escrow, and the same `MarketCreated` and `MarketSeeded` events as the router's path, every market being created and opened by the same code as one created through the router and seeded by `seed`; any signer, a wallet included, may call it and becomes its market's seeder.
- Alternatives: Reporting the amounts requested as taken, as Pipeline's reference strategy does; an event of its own for a graduation; refusing an on-curve seeder (a wallet) so only programs' PDAs can seed, which protects nothing the seeder-keyed address does not already protect and would stop a wallet launching its own market this way.
- Specified in: [`docs/spec/pool4-for-solana.md`, The seed](spec/pool4-for-solana.md#the-seed)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Buy wall AMM: seeding by another program](https://github.com/imDev2023/testing-pipeline/issues/53)

### POOL4-30: What a swap that moves the cap reports

- Question: What does a swap that lowers the inventory cap or trims the curve emit, and how does the demo learn the cap's constants without restating them?
- Answer: Two events, `CapLowered` (market state, the new cap, how far it fell, what the curve held, the decay credit left) and `Trimmed` (market state, the tokens retired, the SOL moved to idle SOL, the new liquidity, the cap), each emitted only when its step changes something; and the program publishes `DECAY_CREDIT_WINDOW` and `MIN_LIQUIDITY` in its IDL with Anchor's `#[constant]`, as it does the fee shares (`POOL4-25`), so the demo's model of the cap reads them from the generated client.
- Alternatives: One combined event for both steps; an event on every swap whether or not the cap moved; restating the two constants in the demo, which the one-place rule forbids.
- Specified in: [`docs/spec/pool4-for-solana.md`, Custom actions and metadata](spec/pool4-for-solana.md#custom-actions-and-metadata)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Buy wall AMM: the inventory cap (the ratchet, the decay credit and the trim)](https://github.com/imDev2023/testing-pipeline/issues/49)

### POOL4-31: The ratchet after a sell

- Question: Does the ratchet run only after buys, as the spec's summary puts it, or after any swap that leaves the curve below the cap, as step 6's rule reads?
- Answer: After any swap: step 6 compares the curve with the cap whichever way the trade went, so a sell that leaves the curve still below a cap the decay credit kept from falling all the way lowers it too, within the credit and the floor.
- Alternatives: Buys only, which would leave such a cap above the curve until the next buy.
- Specified in: [`docs/spec/pool4-for-solana.md`, After pricing](spec/pool4-for-solana.md#after-pricing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Buy wall AMM: the inventory cap (the ratchet, the decay credit and the trim)](https://github.com/imDev2023/testing-pipeline/issues/49)

### POOL4-32: When the floor's clock moves

- Question: Does the wall's floor reset its clock (`floor_time`) on every swap, or only on a swap where it crawls toward the reference?
- Answer: At every slot's first update, a swap's or `place_wall`'s, whether or not the floor crawled, as step 4 of "After pricing" reads ([`POOL4-50`](#pool4-50-when-the-walls-floor-moves)), so the floor crawls only by the time since that update and never by a whole day at once when the reference first rises above it after a quiet spell.
- Alternatives: The earlier default, on every swap, which the floor's slot rule replaced since the floor no longer changes inside a slot; only when the floor crawls, which would let a floor that sat at the reference for a long time jump a full day's crawl on the first swap after the reference moved up.
- Specified in: [`docs/spec/pool4-for-solana.md`, After pricing](spec/pool4-for-solana.md#after-pricing)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-17
- Decided: 2026-11-16 in [Buy wall AMM: the buy wall (two-step pricing, the guard and `place_wall`)](https://github.com/imDev2023/testing-pipeline/issues/50)

### POOL4-33: When a wall counts as placed

- Question: When does pricing treat the buy wall as placed, given that `place_wall` can leave a top with no liquidity when almost nothing is idle?
- Answer: Exactly when `wall_liquidity` is above 0; a top with no liquidity trades as no wall, so every trade moves along the curve alone in one step.
- Alternatives: Whenever `wall_top` is set, which would split such trades into two steps along the same liquidity for nothing but an extra rounding.
- Specified in: [`docs/spec/pool4-for-solana.md`, What is stored](spec/pool4-for-solana.md#what-is-stored)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: the buy wall (two-step pricing, the guard and `place_wall`)](https://github.com/imDev2023/testing-pipeline/issues/50)

### POOL4-34: What `place_wall` takes and reports

- Question: Which accounts does `place_wall` take, where may its tip go, and what does it report?
- Answer: The caller signs; the tip goes to any wrapped SOL account the caller names except the market's own SOL vault (the metadata form names the caller's own); it emits `WallPlaced` with the caller, the tip account, the old wall's spent SOL, what closing it moved, the dust swept, the tip and the new wall; and the lifetime total of tokens the wall bought grows when a wall is closed, by what that wall bought.
- Alternatives: No signer, since the tip goes wherever the caller says anyway; a tip only to the caller's associated token account, created if missing, which costs more compute and rent on every call.
- Specified in: [`docs/spec/pool4-for-solana.md`, `place_wall`](spec/pool4-for-solana.md#place_wall)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: the buy wall (two-step pricing, the guard and `place_wall`)](https://github.com/imDev2023/testing-pipeline/issues/50)

### POOL4-35: The wall's constants in the IDL

- Question: How does the demo's model of the wall and its guard learn the constants it needs without restating them?
- Answer: The program publishes `WALL_THRESHOLD`, `KEEPER_TIP_CAP`, `FLOOR_CRAWL_BPS`, `REF_STEP_BPS` and `REF_STEP_WINDOW` in its IDL with Anchor's `#[constant]`, as it does the fee shares (`POOL4-25`) and the cap's constants (`POOL4-30`), and the demo reads them from the generated client.
- Alternatives: Restating them in the demo, which the one-place rule forbids.
- Specified in: [`docs/spec/pool4-for-solana.md`, Constants](spec/pool4-for-solana.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: the buy wall (two-step pricing, the guard and `place_wall`)](https://github.com/imDev2023/testing-pipeline/issues/50)

### POOL4-36: Every holder can exit, at a price bound

- Question: When a holding is more than the curve can take before `MIN_SQRT_PRICE`, as a trim down to `MIN_LIQUIDITY` near the bound can make it, should the pricing sell what it can, or is the whole holding refused, and what does the invariant "every holder can exit" then ask?
- Answer: The whole holding is refused with `PriceBoundReached`, as the pricing's rules already say, since an exact-in swap keeps all its input and cannot fill in part; the holder exits by selling the most the curve can take, so the invariant asks that the whole holding sells, or pays nothing, or that the most the curve can take sells or pays nothing while one token unit more is refused for the bound.
- Alternatives: A partial fill that pays for what the curve can take and keeps the rest of the input, which takes the rest from the trader; refusing such a holding with `ZeroOutput` when the curve holds less than a lamport above the bound, which changes a program error for no holder's gain; keeping trims from shrinking the curve below what every holding needs, which no market can know.
- Specified in: [`docs/spec/pool4-for-solana.md`, Invariants for test layer 3](spec/pool4-for-solana.md#invariants-for-test-layer-3)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: a holder can be refused an exit with PriceBoundReached](https://github.com/imDev2023/testing-pipeline/issues/152)

### POOL4-37: How a payout names and checks its recipient's account

- Question: Which account do `pay_rewards` and `sweep_fees` pay, and what do they do when it is missing or no longer the recipient's?
- Answer: The caller names the recipient's wallet, which must be the one the market or the program names, and only that wallet's associated token account for the mint is paid: created at the caller's expense when it does not exist (never created, closed, or holding only lamports sent to its address), and refused with `RecipientAccountNotTheirs` when it exists but its owner was reassigned, so only that payout waits until the recipient hands its role over.
- Alternatives: Any token account the recipient owns, which the associated token program's idempotent create would accept and which Aviary and indexers could not predict; reading the recipient from the market state without naming it, which Pipeline's metadata forms cannot describe.
- Specified in: [`docs/spec/pool4-for-solana.md`, The recipient's token account](spec/pool4-for-solana.md#the-recipients-token-account)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: payouts and recipient handovers (`settle`, `pay_rewards`, `sweep_fees`)](https://github.com/imDev2023/testing-pipeline/issues/51)

### POOL4-38: Who signs the payouts and what they report

- Question: Who signs `settle`, `pay_rewards`, `sweep_fees` and the handovers, when may a handover happen, and what does each report?
- Answer: `settle` needs no signature but the fee payer's, since it pays nobody; `pay_rewards` and `sweep_fees` are signed by the caller, who pays for a missing recipient account; the payouts are refused until the market is seeded, while a handover, signed by the role's current recipient, may happen at any time, before the seed too; they emit `Settled`, `RewardsPaid`, `FeesSwept` and `RecipientChanged`, and the lifetime totals of tokens burned and rewards paid grow with each.
- Alternatives: A named caller on `settle`, as `place_wall` has for its tip, which it has no use for; handovers only once a market is open.
- Specified in: [`docs/spec/pool4-for-solana.md`, Recipients](spec/pool4-for-solana.md#recipients)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: payouts and recipient handovers (`settle`, `pay_rewards`, `sweep_fees`)](https://github.com/imDev2023/testing-pipeline/issues/51)

### POOL4-39: Testing the designer slot before its wallet is set

- Question: How is fee slot 1's payout tested while `DESIGNER_RECIPIENT` is unset in every build that is deployed?
- Answer: A `test-designer-recipient` feature of the program sets the constant to a test key nobody holds, in `config.rs` beside the real value, and gives that build a program id of its own, so deployed at the program's address it would refuse every instruction; CI builds the program a second time with it and runs the payout tests against that build.
- Alternatives: Testing slot 1 only in the pure functions, never through the router; leaving its payout untested until the constant is set.
- Specified in: [`docs/spec/pool4-for-solana.md`, Constants](spec/pool4-for-solana.md#constants)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: payouts and recipient handovers (`settle`, `pay_rewards`, `sweep_fees`)](https://github.com/imDev2023/testing-pipeline/issues/51)

### POOL4-40: The fee slots' wallets in the IDL

- Question: How does the demo learn the wallets fee slots 1 and 2 are paid to without restating them?
- Answer: The program publishes `DESIGNER_RECIPIENT` and `SUITE_TREASURY` in its IDL with Anchor's `#[constant]`, as the tax AMM publishes its suite treasury, and the demo reads them from the generated client.
- Alternatives: Restating them in the demo, which the one-place rule forbids.
- Specified in: [`docs/spec/pool4-for-solana.md`, Constants](spec/pool4-for-solana.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: payouts and recipient handovers (`settle`, `pay_rewards`, `sweep_fees`)](https://github.com/imDev2023/testing-pipeline/issues/51)

### POOL4-41: What the release gate runs on each market

- Question: What exactly does the release gate run on each market, and which quotes does it compare?
- Answer: With the candidate and the cluster's router it resolves a buy and a sell, compares exact-in quotes both ways at a tenth, a hundredth and a thousandth of the input vault with the deployed build's on the same state, checks `pipeline_market_info` against the router's record, seeds a market waiting for its seed as its seeder would, runs each keeper job that this tree's rules say is due on the state as downloaded or that the deployed build ran on the snapshot, then buys with a hundredth of the SOL vault and sells what that bought, each delivering exactly the candidate's quote.
- Alternatives: The earlier default, the same without `pipeline_market_info` and with only the keeper jobs this tree's rules say are due, which let a candidate that narrows a rule drop that job from its own test; one quote each way; judging keeper jobs due after the trades; comparing whole market states after the trades.
- Specified in: [`docs/spec/pool4-for-solana.md`, A release gate](spec/pool4-for-solana.md#a-release-gate)
- Changes by: spec only
- Status: changed 2026-11-16
- Decided: 2026-11-16 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-42: How a release declares a pricing change

- Question: How does a release declare the pricing change that lets its quotes differ from the deployed build's?
- Answer: In `programs/buy-wall-amm/release.json`, committed with it, by naming the executable hash of each build whose quotes it changes, so a declaration left in place after its release deploys covers nothing more; it lets amounts differ but never a served quote become a refusal, and unlocks a deploy only as committed.
- Alternatives: A yes or no flag, which would keep covering later releases until someone reset it.
- Specified in: [`docs/spec/pool4-for-solana.md`, A release gate](spec/pool4-for-solana.md#a-release-gate)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: the release gate and layout fixtures, so no upgrade can strand a market](https://github.com/imDev2023/testing-pipeline/issues/54)

### POOL4-43: What a passing gate run must cover for a deploy

- Question: Which passing gate run lets the deploy script deploy a build?
- Answer: One recorded for the same cluster (by genesis hash) and the same executable hash, made against the build deployed there now and covering every market there now, kept per cluster in `deployments/release-gate/buy-wall-amm/`, with a local validator's records kept out of git.
- Alternatives: Any passing run of the same build hash, which an upgrade or a new market since would make stale; running the gate inside the deploy script.
- Specified in: [`docs/spec/pool4-for-solana.md`, A release gate](spec/pool4-for-solana.md#a-release-gate)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: the release gate and layout fixtures, so no upgrade can strand a market](https://github.com/imDev2023/testing-pipeline/issues/54)

### POOL4-44: How the gate is proved to catch stranding

- Question: How are the test builds made that prove the gate catches stranding?
- Answer: From edited copies of the workspace, built in a target directory of their own, never from features in the program's source: a moved field, the market state type renamed with its discriminator left to Anchor and an account 8 bytes larger, each refused on every open market, a payout rule narrowed so fee slot 2 can no longer be swept and a fee slot 2 whose wallet is refused as unset, each refused on every market the deployed build swept it on and on the gate's own market, and a field appended into the reserve as layout version 2 and the designer's wallet set as the upgrade that sets `DESIGNER_RECIPIENT` will set it, each passed, on every fixture in CI.
- Alternatives: The earlier default, the same without the refused fee slot wallet and the designer's wallet set, which proved nothing about a wallet the gate's own tree would also refuse (review finding R2G-03); the default before it, the same without the narrowed payout rule, which proved nothing about keeper jobs; Cargo features that switch layouts in `state.rs`, which would put stranding layouts into the audited source.
- Specified in: [`docs/spec/pool4-for-solana.md`, Fixtures in CI](spec/pool4-for-solana.md#fixtures-in-ci)
- Changes by: spec only
- Status: changed 2026-11-18
- Decided: 2026-11-18 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-45: How the gate reads a cluster

- Question: How does the gate read accounts from a cluster?
- Answer: Through read-only JSON-RPC calls sent with `curl`, so it can send nothing, and so the owner's firewall, which holds back every freshly built binary's network calls until allowed by hand, never stalls it after a rebuild; it keeps only an RPC URL's scheme and host in what it prints and saves.
- Alternatives: `pipeline-check`'s own HTTP client, which would add an HTTP stack to the on-chain workspace and be held back after every rebuild.
- Specified in: [`docs/spec/pool4-for-solana.md`, A release gate](spec/pool4-for-solana.md#a-release-gate)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: the release gate and layout fixtures, so no upgrade can strand a market](https://github.com/imDev2023/testing-pipeline/issues/54)

### POOL4-46: When a failed step counts against a candidate

- Question: Which of the steps a candidate fails refuse it, when a market's token, its recipients or the router can make a step fail under every build?
- Answer: A failed step counts unless the deployed build failed the same step, matched by kind and not by name, on the same snapshot with the same error (the instruction error, which carries the failing program's own error code, or the whole message when no program raised it) starting in the same program, as recorded in the snapshot when it is taken (so fixtures compare without the deployed program); each replay asks the build it runs for the wallet of every fee slot it sweeps, never the gate's own tree, so the deployed build's record shows what that build pays; the layout checks (reading the market state, finding the market, account resolution, the quotes and `pipeline_market_info`) always run and always count, both replays sign with the same keys derived from the market, and the failures that do not count are printed and recorded with the pass.
- Alternatives: The earlier default, the same failure matched by its program alone and each fee slot's wallet taken from the gate's own tree, which let a third party's block of a market inside the buy wall AMM excuse a different regression of that step there (review finding R2G-01) and a tree that refuses a slot's wallet drop that sweep from both replays (R2G-03); the default before it, every step must pass, which any market whose token's hook refuses the gate's trader or whose fee recipient made its account unpayable vetoes forever, for every build; excusing a shared failure whatever program it starts in, which would let a candidate fail in its own code where the deployed build failed in a hook; running the deployed build again at check time, which fixtures cannot, since they carry no programs.
- Specified in: [`docs/spec/pool4-for-solana.md`, A release gate](spec/pool4-for-solana.md#a-release-gate)
- Changes by: spec only
- Status: changed 2026-11-18
- Decided: 2026-11-18 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-47: Markets the router has not recorded

- Question: What does the gate do with a market state the router has no Market for, or a market missing a router fee account?
- Answer: The snapshot copies such a market as if the router had recorded what `pipeline_market_info` gives and saves it marked unregistered, and the replay registers it with the router's `register_existing_market` and `init_fee_account` for both mints, migrates a market the router recorded before Pipeline 0.3's fee mints with `migrate_market`, and creates any missing fee account of a recorded market, as anyone may, then checks it like the rest.
- Alternatives: The earlier default, without the migration, under which the 0.3 router refuses every trade of a market recorded before fee mints and the gate took it for unrecorded; The earlier behaviour, aborting the whole run, which let anyone block every upgrade with one direct `pipeline_seed_liquidity` call; leaving such markets out of the check, which would not check them at all.
- Specified in: [`docs/spec/pool4-for-solana.md`, A release gate](spec/pool4-for-solana.md#a-release-gate)
- Changes by: spec only
- Status: changed 2026-11-22
- Decided: 2026-11-16 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-48: A transfer hook at the seed

- Question: May a buy wall market be seeded with a Token-2022 token whose transfer hook can still change or refuse transfers, when whoever controls the hook could make it refuse every sell but their own once holders have bought and then sell into the curve and the buy wall?
- Answer: No: both seeding paths refuse with `TransferHookLive` a token whose transfer hook extension still names a hook program or a hook authority, so a hooked token is seeded only with both unset (all 64 bytes of the extension zero), the state a contained token reaches after its unlock, and a token without the extension is unaffected.
- Alternatives: Requiring only the hook authority removed, which leaves a hook program that can be upgraded or that reads an admin account of its own; accepting any hook and disclosing the risk, the earlier rule, under which a live hook could turn a market into a honeypot.
- Specified in: [`docs/spec/pool4-for-solana.md`, Mint rules](spec/pool4-for-solana.md#mint-rules)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-17 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-49: Which retired tokens earn the reward share

- Question: Which retired tokens earn the reward share, now that a rewards recipient can retire tokens itself by washing a buy against the decay credit, selling a dip into a tight cap or selling into the wall and closing it, all in one transaction?
- Answer: Only trimmed tokens matched by the cap's own fall: the ratchet adds every unit the cap falls to `cap_fall_unmatched`, which never holds more than one day's allowance (the most the decay credit holds, so no single trim draws on days of others' buying, review finding R2-01), a trim moves `min(trimmed tokens, cap_fall_unmatched)` from it into `retired_rewardable`, and `settle` pays `floor(retired_rewardable x reward_share_bps / 10,000)` and burns the rest of `retired_tokens`, so the rest of a trim, the tokens a closed wall bought and `place_wall`'s dust burn whole and the rewards never exceed `reward_share_bps` of `seeded_tokens - cap_floor`.
- Alternatives: The earlier rule, in which every retired token earned the reward share; lagging the ratchet by a slot so a same-transaction round trip never trims; paying no reward share on trims; accepting the behaviour and disclosing it.
- Specified in: [`docs/spec/pool4-for-solana.md`, After pricing](spec/pool4-for-solana.md#after-pricing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-17 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-50: When the wall's floor moves

- Question: When may the wall's floor change, and when may `place_wall` run, so that neither a price that lasts only inside one transaction or slot nor a quiet spell's crawl can move the buy wall?
- Answer: Only at a slot's first update, as the reference already moves (a swap's in "After pricing" step 4, or `place_wall`'s own when no swap has run in the slot yet, which leaves the slot unmarked): the floor crawls toward the reference, never above it nor the previous slot's close `last_close`, and drops to that close if it is lower, so it never changes inside a slot and is never above the price the slot opened at; `place_wall` is refused with `SwapThisSlot` in a slot a swap already ran in, and places the wall at `min(price, floor, low_since_placement)` with the floor brought up to date, where `low_since_placement` is the lowest close since the last placement (the seed counts as one; every swap lowers it to its close and none raises it; 0, a market written before the field, caps nothing), then resets it to the price at placement, so a dump bought back, in its own slot or later, still caps the next placement at its low whatever trades in between; the owner chose this hybrid of the slot-based floor and a placement cap on 2026-11-19, after round 2 of the review found that the floor alone let a back-runner buy a third party's dump back to the floor within its slot and sell into a wall placed at the old floor with the dump's trimmed SOL, for 1% to 5% of the curve's SOL.
- Alternatives: The earlier default, the same slot-based floor with the wall placed at `min(price, floor)`, which round 2's back-run of a fall across one slot boundary profited from (VERIFY-H003); capping the placement at the lowest close of the last slot that traded instead, which a tiny swap first in the slot after the dump reset to about the floor, so the back-run paid again (the branch's code review, 2026-11-19); refusing, rather than lowering, a placement when the previous slot's lowest close is below the floor, which stops a one-boundary back-run but not one that holds the price for a further slot; IMD's rule, the floor crawling and dropping to every swap's own price, which let a sell to a dip bought straight back in one transaction drag the whole wall down for days (SOS finding H003) and a buy after a quiet day capture the crawl by placing the wall above its own starting price and selling into it (H004, H050); keeping IMD's rule and disclosing both risks.
- Specified in: [`docs/spec/pool4-for-solana.md`, After pricing](spec/pool4-for-solana.md#after-pricing)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-19
- Decided: 2026-11-17 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-51: The market's clocks never run backwards

- Question: What does a market do with a Clock whose Unix time is earlier than a time it has stored, the cap's `decay_time` or the guard's `ref_time` and `floor_time`?
- Answer: Each stored time becomes the later of itself and the Clock's time, so a clock that goes back credits nothing and the same seconds are never counted twice for the cap's decay credit, the reference's step or the floor's crawl; Agave's Clock never goes back from one slot to the next (review finding H009), so on a live cluster this changes nothing and is defence in depth.
- Alternatives: The earlier rule, storing the Clock's time as it is, under which a clock that went back and then forward would count the overlap twice; refusing a swap whose clock is earlier than a stored time, which would stop trading over a validator's error.
- Specified in: [`docs/spec/pool4-for-solana.md`, After pricing](spec/pool4-for-solana.md#after-pricing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-17 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-52: Which wallets a role may be handed to

- Question: Besides the default key, which wallets does a handover refuse?
- Answer: The role's current wallet, refused with `SameRecipient` so every `RecipientChanged` reports a change, and the market's own addresses (its market state, its vault authority, either vault, the program, the router's Market account, which is the market signer PDA, and both mints), refused with `NotAWallet`, since no key signs for a token account any of them owns and the role's income would be stranded there; any other key is still accepted in one step, so a typo stays the holder's own risk.
- Alternatives: The earlier default, refusing only the default key, which let a holder strand a role's income in an account of the market's own and emit a `RecipientChanged` that changed nothing; a two-step handover that the new wallet accepts by signing, which would also catch typos but needs a pending recipient for each role in the market state and a second instruction.
- Specified in: [`docs/spec/pool4-for-solana.md`, Recipients](spec/pool4-for-solana.md#recipients)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-17 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-53: Every gate run trades a market of its own

- Question: What does the release gate check on a cluster with no market, where replaying the cluster's markets checks nothing and a build that refuses every instruction, such as one declared for another address, would pass?
- Answer: Every gate run, `run` and `check` alike, also makes a market of its own with the candidate in a LiteSVM world of its own, holding only the router the replay runs and the candidate at the snapshot's clock, with the router's config made as devnet's (a 0.01 SOL listing fee) and the program registered, so no account of the cluster's (a fixed fee wallet's reassigned token account) can refuse every candidate there; it creates and seeds the market through the router, trades it past its first wall and settlement and checks it as a cluster's market, every keeper job that has become due included and every quote required to serve, its payouts paid into token accounts made fresh, and refuses the candidate if any step there fails, none excused as shared with the deployed build; a record of a pass says so, and a record without it never covers a deploy (review findings H097, H098 and R2G-02).
- Alternatives: The earlier default, the same market made in the cluster's own world after the cluster's markets, readying the router's config and registration only where the snapshot lacked them, under which a router pause or a reassigned wrapped SOL account of `SUITE_TREASURY` or `DESIGNER_RECIPIENT` refused every candidate, an emergency fix included (review finding R2G-02); running the market with the deployed build too and excusing what fails under both, which fixtures cannot, since they carry no programs; refusing a cluster with no market outright unless told to allow it, which would block a first deploy or demand a separate smoke test; leaving it, under which a cluster with no market passed any build vacuously and the deploy script accepted it.
- Specified in: [`docs/spec/pool4-for-solana.md`, A release gate](spec/pool4-for-solana.md#a-release-gate)
- Changes by: spec only
- Status: changed 2026-11-18
- Decided: 2026-11-18 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-54: One deploy path with the release gate in front

- Question: How does the buy wall AMM reach devnet when the shared verified-build deploy script and the release gate's own deploy script both exist?
- Answer: Through one path, `scripts/deploy-devnet.sh buy-wall-amm`, which builds the commit with solana-verify in Docker as for every program and, before it sends anything, runs the program's own pre-deploy check, `programs/buy-wall-amm/scripts/pre-deploy.sh`, on the very bytes built: it asks `buy-wall-gate verify-record` for a passing gate record for that executable hash on that cluster, made against the build deployed there now and covering every market there now, and a refusal stops the deploy. The gate is run first on the same verified build (`--build-only --out`), and its record, like `deployments/devnet.json`, does not count as an uncommitted change. The gate's own `deploy.sh`, which deployed any `.so` it was given, is gone.
- Alternatives: Keeping `deploy.sh` beside the shared script, two ways to deploy one program, only one of them verified; `deploy.sh` taking the verified build from the shared script, which keeps two deploy commands; a case for the buy wall AMM written into the shared script, where a hook in the program's folder keeps the gate's knowledge beside the gate.
- Specified in: [`docs/spec/pool4-for-solana.md`, How to run it](spec/pool4-for-solana.md#how-to-run-it)
- Changes by: spec only
- Status: default
- Decided: 2026-11-20 in [Buy wall AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/56)

### POOL4-55: The devnet demo market

- Question: Which market does the demo create on devnet, where Pipeline's registry and anyone looking will see it?
- Answer: One, the worked example's market: a fresh test token of 6 decimals with its mint authority removed (it never has a freeze authority), seeded with 1,000,000 tokens and 10 SOL at IMD's launch values (a 1% fee, half of the market's part to the wall, a 15% reward share, a cap floor and a cap decay of 20% a day), all in the demo's `DEMO` block, so the devnet market reproduces the worked example's two trades to the unit before it places its wall, settles, hands both recipient roles over and pays everything out. Its 10 SOL seed stays in it for good. The launchpad's graduated market stays on local validators.
- Alternatives: A market a tenth the size, which saves 9 devnet SOL but leaves the worked example unproved on devnet and needs many more buys before idle SOL reaches `WALL_THRESHOLD`; the whole local demo on devnet, which would add the stand-in launchpad, a test program never deployed there.
- Specified in: [`docs/toolchain.md`, Deploy to devnet](toolchain.md#deploy-to-devnet)
- Changes by: spec only
- Status: default
- Decided: 2026-11-20 in [Buy wall AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/56)

### POOL4-56: What shows a live market survived an upgrade

- Question: After an upgrade on devnet, what must the live demo market still do before the upgrade counts as done?
- Answer: The demo run again with `--market <the demo market's state>`: from the market state as read, it buys and sells back through the router, the buy lowering the cap and the sell trimmed, places the wall, sells into it, settles, pays the rewards and sweeps fee slots 0 and 2 to the market's recipients as they are, with slot 1 refused while `DESIGNER_RECIPIENT` is unset, every quote and every step checked against the spec's formulas and the whole market state read back after each; then `pipeline-check --fail-on-warn` against devnet, and on devnet Pipeline's hosted API quotes the market both ways at the program's own quotes.
- Alternatives: Only quoting the market, which proves the layout still reads but not that every instruction still runs; a separate after-upgrade script, which would repeat the demo's spec model.
- Specified in: [`docs/toolchain.md`, Deploy to devnet](toolchain.md#deploy-to-devnet)
- Changes by: spec only
- Status: default
- Decided: 2026-11-20 in [Buy wall AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/56)

### POOL4-57: The create form's pre-filled values

- Question: What does Aviary's buy wall create form start with?
- Answer: IMD's launch values, a 1% fee, a 15% reward share, a cap floor of 20% and a cap decay of 20% a day, with half the market's part of the fee to the buy wall (the worked example's and the devnet demo's split, since IMD's hook has none) and the connected wallet as fee recipient, rewards recipient and seeder, all in `CREATE_FORM_DEFAULTS` in `apps/terminal-web/src/products/buyWall/config.ts`; the creator may change any before signing.
- Alternatives: An empty form; the whole market's part of the fee to the wall, which leaves the fee recipient nothing.
- Specified in: [`docs/spec/pool4-for-solana.md`, Aviary's panel](spec/pool4-for-solana.md#aviarys-panel)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Buy wall AMM: Aviary panel and forms](https://github.com/imDev2023/testing-pipeline/issues/57)

### POOL4-58: What the panel reads and how it reads it

- Question: Where does the buy wall panel read each value, and how fresh is it?
- Answer: From the market state, the token's mint and the Clock sysvar, read in one request at one slot through the API and decoded at the spec's offsets by the program's generated client in one module the explainer shares; read again every 30 seconds while the page is in view, 1.5 seconds after a burst of the market's trades and after each of its own transactions (`BUY_WALL_REFRESH_MS`, `BUY_WALL_TRADE_PAUSE_MS`); the allowance is brought up to the chain's Clock read with them, and the tokens burned are a share of the mint's supply plus the tokens burned.
- Alternatives: Pipeline's API and the vault balances, which count retired tokens, the wall, idle SOL and unpaid fees as liquidity; the market's events; reading only on load.
- Specified in: [`docs/spec/pool4-for-solana.md`, Aviary's panel](spec/pool4-for-solana.md#aviarys-panel)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Buy wall AMM: Aviary panel and forms](https://github.com/imDev2023/testing-pipeline/issues/57)

### POOL4-59: The keeper job buttons and the handover forms

- Question: How does the panel offer the keeper jobs and the recipients' handovers?
- Answer: Each job due by `packages/keeper-jobs`, from the API, is a button that prepares the job's own metadata action for the viewer's wallet, filled from the market state so nobody types a recipient, with what it would move and the keeper runner's last attempt; a pressed job stays with its confirmation until its review is left; each handover form is offered only to the connected wallet holding that role, and stays while its review is open after the role has moved; the strategy's metadata forms of these six actions are left out of Actions (`PIPESCOPE-162`), the seed's kept.
- Alternatives: The generic metadata forms alone, where a payer types the recipient's wallet; a handover form offered to every wallet, which the program refuses for all but the holder.
- Specified in: [`docs/spec/pool4-for-solana.md`, Aviary's panel](spec/pool4-for-solana.md#aviarys-panel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Buy wall AMM: Aviary panel and forms](https://github.com/imDev2023/testing-pipeline/issues/57)

## Lending AMM (LENDING)

### LENDING-01: What it is

- Question: What kind of market is a lending AMM market?
- Answer: A two-mint constant-product pool with open LP shares, priced on its total reserves, that lends part of one side to a lending market between swaps.
- Alternatives: A wrapper that adds lending to other curves; liquidity from the creator only.
- Specified in: [`docs/spec/lending-pool.md`, What it is](spec/lending-pool.md#what-it-is)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-02: Lending market

- Question: Which lending market does it lend to?
- Answer: Kamino Lend only, through its cToken deposit and redeem instructions and never through obligations, with every Kamino call and read in one module.
- Alternatives: Jupiter Lend, which uses the last spare call level inside a swap and is out of scope for this map; an adapter that can be switched at runtime.
- Specified in: [`docs/spec/lending-pool.md`, What it is](spec/lending-pool.md#what-it-is)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-03: Lent mints and reserves

- Question: Which mints are lent, and to which Kamino reserves?
- Answer: Only WSOL and USDC, each tied to one Kamino reserve compiled in per cluster as `LENT_MINTS` (mainnet: the main market's SOL and USDC reserves; devnet: our own lending market); market creators never choose a reserve.
- Alternatives: A reserve chosen by the market's creator, who could then borrow the LPs' deposits away; lending both sides of a market.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-04: Buffer target

- Question: How much of the lent side stays in the market for swaps?
- Answer: 20%, the constant `BUFFER_TARGET_BPS` (2000), the same for every market.
- Alternatives: A buffer target chosen per market.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-05: Buffer band

- Question: How far may the buffer drift before it is rebalanced?
- Answer: Between 10% and 30% (`BUFFER_MIN_BPS` 1000, `BUFFER_MAX_BPS` 3000); `rebalance` acts only outside that band.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-06: Smallest rebalance

- Question: What is the smallest move `rebalance` makes?
- Answer: 0.05 SOL for WSOL and 5 USDC for USDC, the constant `MIN_REBALANCE`; smaller moves are skipped.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-07: Withdraw mode

- Question: What does a market do when Kamino runs short of free liquidity?
- Answer: It enters withdraw mode when Kamino's free liquidity is below 5 times (`WITHDRAW_MODE_ENTER`) what the market lends or would lend, redeeming all it can and depositing nothing, and leaves it once the free liquidity has stayed above 10 times (`WITHDRAW_MODE_EXIT`) for `WITHDRAW_MODE_EXIT_DELAY_SLOTS` (LENDING-93).
- Alternatives: The earlier default, it enters withdraw mode when Kamino's free liquidity is below 5 times (`WITHDRAW_MODE_ENTER`) what the market lends or would lend, redeeming all it can and depositing nothing, and leaves it above 10 times (`WITHDRAW_MODE_EXIT`); doing nothing beyond the buffer and in-swap redeems; a fixed utilisation threshold such as 95%.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: changed 2026-11-17
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-08: Highest LP fee

- Question: What is the highest LP fee a market may charge?
- Answer: 2%, the constant `MAX_LP_FEE_BPS` (200).
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-09: LP fee per market

- Question: Who sets a market's LP fee?
- Answer: Its creator, at creation and for good, up to the cap; Aviary's form defaults it to 0.30% (30 basis points).
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Creation parameters](spec/lending-pool.md#creation-parameters)
- Changes by: market-creation parameter
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-10: First deposit

- Question: How is the first depositor kept from inflating share prices?
- Answer: The first deposit locks 1,000 LP base units for good (`MINIMUM_LIQUIDITY`), and every LP mint has 9 decimals (`LP_DECIMALS`).
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-11: Swaps larger than the buffer

- Question: What does a swap do when it must pay out more of the lent side than the buffer holds?
- Answer: It redeems just the shortfall from Kamino in the same swap and never deposits; a trade above the buffer plus what Kamino can pay right now is refused cleanly, in the quote as in the swap.
- Alternatives: Spending only the buffer and leaving every redeem to keeper jobs.
- Specified in: [`docs/spec/lending-pool.md`, Redeeming the shortfall](spec/lending-pool.md#redeeming-the-shortfall)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-12: Valuing cTokens

- Question: At what rate are the market's cTokens valued?
- Answer: At the rate stored in Kamino's reserve account, with no projection to the current slot, read only from a reserve refreshed recently enough once the market holds cTokens: in the same slot for adding (LENDING-91), within about an hour for quotes and swaps (LENDING-92), and at any age once the reserve is deprecated, since its rate never moves again.
- Alternatives: The earlier default, at the rate stored in Kamino's reserve account, everywhere, with no projection to the current slot; projecting the rate to the current slot, which would copy Kamino's interest maths into our program.
- Specified in: [`docs/spec/lending-pool.md`, The stored rate, everywhere](spec/lending-pool.md#the-stored-rate-everywhere)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-17
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-13: Who bears Kamino's losses

- Question: Who bears a loss that Kamino writes off?
- Answer: The LPs, pro rata through the value of their shares; there is no insurance fund.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Kamino's losses fall on LPs](spec/lending-pool.md#kaminos-losses-fall-on-lps)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-14: Checking Kamino's reserve

- Question: What happens if Kamino's reserve account stops matching what the program expects?
- Answer: Every instruction that reads the reserve checks its address, owner, size, discriminator, lending market, mints and version (1, or `u64::MAX` once deprecated) first, and that the lent mint's `LENT_MINTS` entry still names the reserve and collateral mint the market recorded, and refuses rather than misprices; removing liquidity in kind never reads it, so a Kamino change, or an upgrade that edits a row, can stop trading but never trap LPs.
- Alternatives: The earlier default, every instruction that reads the reserve checks its address, owner, size, discriminator, lending market and mints first, and refuses rather than misprices; removing liquidity in kind never reads it, so a Kamino change can stop trading but never trap LPs.
- Specified in: [`docs/spec/lending-pool.md`, Checking the reserve before reading it](spec/lending-pool.md#checking-the-reserve-before-reading-it)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-17
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-15: Rebalancing

- Question: How does the buffer return to its target?
- Answer: Through `rebalance`, a permissionless custom action that moves the buffer back to its target only when it is outside the band, fails inside it, and pays no tip; adding liquidity joins the buffer and never calls Kamino.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, The rule](spec/lending-pool.md#the-rule)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-16: When the keeper calls rebalance

- Question: When does our keeper runner call `rebalance`?
- Answer: After each transaction on the market, which the runner sees on its own socket, and in its sweep of every market every 10 minutes.
- Alternatives: Acting when Aviary's indexer sees a market leave its band, as first specified.
- Specified in: [`docs/spec/keeper-runner.md`, The jobs](spec/keeper-runner.md#the-jobs)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)

### LENDING-17: When Kamino cannot pay

- Question: Does the program have switches of its own for when Kamino cannot pay?
- Answer: No: it reads Kamino's state at each call, trading from the buffer alone under the reserve's emergency mode or a deprecated reserve, and under the lending market's emergency mode until the reserve is an hour stale, since klend then refreshes none of its reserves, skipping deposits when cToken use is blocked, and always letting LPs leave in kind.
- Alternatives: The earlier default, no: it reads Kamino's state at each call, trading from the buffer alone under emergency mode or a deprecated reserve, skipping deposits when cToken use is blocked, and always letting LPs leave in kind.
- Specified in: [`docs/spec/lending-pool.md`, When Kamino can't pay](spec/lending-pool.md#when-kamino-cant-pay)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-17
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-18: Removing liquidity

- Question: How does an LP leave?
- Answer: By burning shares for a pro rata part of the other side, the buffer and the cTokens, either in cash, with the cTokens redeemed from Kamino, or in kind, with the cTokens paid out as they are, which works whatever state Kamino is in.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Removing](spec/lending-pool.md#removing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-19: Locking LP shares

- Question: How is liquidity made protocol-owned for good?
- Answer: With `lock_lp`, which moves LP shares into the market's lock account that no instruction ever moves them out of; locked shares still earn the LP fee and the yield as depth for traders, while burnt shares hand their value to the remaining LPs.
- Alternatives: Burning the shares.
- Specified in: [`docs/spec/lending-pool.md`, Locking](spec/lending-pool.md#locking)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-20: Who earns what

- Question: Who earns the LP fee and the lending yield?
- Answer: The LPs, all of both, through the value of their shares; we take nothing from the strategy and neither does a market's creator.
- Alternatives: A performance fee to our treasury, for example a tenth of the yield; a split with the market's creator.
- Specified in: [`docs/spec/lending-pool.md`, Who earns what](spec/lending-pool.md#who-earns-what)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-21: No admin

- Question: Can anyone pause or change a lending AMM market?
- Answer: No: the program has no admin, so nobody, us included, can pause it, change a market or move a market to another reserve.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, What it is](spec/lending-pool.md#what-it-is)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-22: Market addresses

- Question: At which address does a market live?
- Answer: At a PDA of the other mint, the lent mint and the LP fee, so there is one market per pair, lent side and fee; markets seeded by another program live at a seeder-scoped PDA instead.
- Alternatives: A fresh keypair per market, as the tax AMM uses, which allows many markets per pair.
- Specified in: [`docs/spec/lending-pool.md`, Addresses](spec/lending-pool.md#addresses)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-23: Mint rules

- Question: Which mints may trade against the lent side?
- Answer: Those that pass the tax AMM's mint rules, so hooked tokens are allowed and transfer-fee or permanent-delegate mints are refused; the lent side is exactly the listed SPL Token mint.
- Alternatives: Any mint the router supports, transfer fees included.
- Specified in: [`docs/spec/lending-pool.md`, Mint rules](spec/lending-pool.md#mint-rules)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-24: Exact-out and market shape

- Question: Does the lending AMM support exact-out swaps or more than two mints?
- Answer: No: it is exact-in only, with exactly two mints.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Not in v1](spec/lending-pool.md#not-in-v1)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-25: Seeding

- Question: Can another program create and fund a lending AMM market in one call?
- Answer: Yes, through `pipeline_seed_liquidity`, which mints the first deposit's shares to the LP recipient; naming the market's vault authority as recipient locks them.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Seeding](spec/lending-pool.md#seeding)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-26: Mainnet upgrade policy

- Question: What is the lending AMM's upgrade policy on mainnet?
- Answer: Frozen (upgrade authority removed) before any mainnet deployment; a Kamino change then stops trading but never traps LPs, and a new strategy version serves new markets.
- Alternatives: A multisig with a timelock, kept to follow changes in Kamino, which would be an admin key every LP has to trust.
- Specified in: [`docs/spec/lending-pool.md`, Upgrades and freezing](spec/lending-pool.md#upgrades-and-freezing)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-27: Compute ceilings

- Question: How much compute may each instruction use?
- Answer: Each instruction's highest measured cost plus headroom (`LENDING-88`): from 20,000 units for `pipeline_quote` to 140,000 for `pipeline_seed_liquidity`, with 35,000 for a swap without a redeem and 75,000 with one, 90,000 for `rebalance`, 60,000 for `add_liquidity` and 50,000 for `lock_lp`; raising one needs a written reason.
- Alternatives: The earlier default, from 40,000 units for `lock_lp` to 200,000 for `pipeline_seed_liquidity`, set before measuring; before that, 20,000 units for `lock_lp`, set for one transfer.
- Specified in: [`docs/spec/lending-pool.md`, Compute ceilings](spec/lending-pool.md#compute-ceilings)
- Changes by: build-time constant
- Status: changed 2026-11-16
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-28: Devnet lending market

- Question: What does the lending AMM lend to on devnet?
- Answer: Our own Kamino lending market, with a WSOL reserve and a reserve for our own test USDC mint, since Circle's devnet USDC cannot be minted freely.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Devnet](spec/lending-pool.md#devnet)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-29: Kamino's code

- Question: Does our program compile in Kamino's code?
- Answer: No: it calls Kamino's deployed program with instruction data, account lists and reserve offsets written by hand from klend 1.28.0, because klend is BSL 1.1 with no use grant until 2027-11-17.
- Alternatives: Depending on the klend crate.
- Specified in: [`docs/spec/lending-pool.md`, Building it](spec/lending-pool.md#building-it)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-30: Aviary's panel

- Question: What does Aviary show for a lending AMM market?
- Answer: The lent side and its Kamino reserve, the buffer against its band and withdraw mode, the largest sell the buffer and Kamino can pay, Kamino's utilisation and flags, the LP fee, share value, locked shares and yield, and the actions as forms.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Aviary's panel](spec/lending-pool.md#aviarys-panel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-31: Custom actions and metadata

- Question: Which actions does the lending AMM expose?
- Answer: Four: `add_liquidity`, `remove_liquidity`, `lock_lp` and `rebalance`, each emitting an event, declared in metadata with category `amm` and the tags `lending` and `kamino`.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Custom actions and metadata](spec/lending-pool.md#custom-actions-and-metadata)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-32: Invariants

- Question: Which invariants does the lending AMM's fuzzing check?
- Answer: Six beyond the shared three, among them that recorded balances never exceed what the market holds, that no instruction lowers an LP share's value at a fixed Kamino rate, that a removal in kind always succeeds, and that a swap never deposits into Kamino.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Invariants for test layer 3](spec/lending-pool.md#invariants-for-test-layer-3)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21)

### LENDING-33: What the withdraw mode thresholds are measured against

- Question: Against what are withdraw mode's 5 times and 10 times measured?
- Answer: The larger of what the market has lent and what its target would lend, so a market that has redeemed everything does not leave withdraw mode at once and flap.
- Alternatives: The target alone; what the market has lent right now, as first written.
- Specified in: [`docs/spec/lending-pool.md`, Withdraw mode](spec/lending-pool.md#withdraw-mode)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Cut the lending pool's build tickets](https://github.com/imDev2023/testing-pipeline/issues/25)

### LENDING-34: Hardening and the first deploy

- Question: When does the lending AMM's hardening ticket run?
- Answer: Before the first devnet deploy, so the program registered with Pipeline is the hardened one, as for the buy wall AMM.
- Alternatives: Last, after the deploy, as the shared bar words it.
- Specified in: [`docs/spec/lending-pool.md`, Build tickets](spec/lending-pool.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the lending pool's build tickets](https://github.com/imDev2023/testing-pipeline/issues/25)

### LENDING-35: How its build tickets are verified

- Question: Where is the work of the lending AMM's build tickets verified?
- Answer: In LiteSVM through the real router copied from devnet and klend's deployed bytes, on both cluster builds; devnet itself is used in the first ticket, which creates our Kamino lending market, and in the deploy ticket.
- Alternatives: A devnet deploy and upgrade in every ticket.
- Specified in: [`docs/spec/lending-pool.md`, Build tickets](spec/lending-pool.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Cut the lending pool's build tickets](https://github.com/imDev2023/testing-pipeline/issues/25)

### LENDING-36: Devnet demo market

- Question: What is the lending AMM's demo market on devnet?
- Answer: WSOL lent against a fresh test token with no authorities, with an LP fee of 30 basis points and at least 0.5 SOL on the lent side, and a second depositor holding at least 5 SOL in our WSOL reserve.
- Alternatives: A market that lends test USDC.
- Specified in: [the ticket, Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Cut the lending pool's build tickets](https://github.com/imDev2023/testing-pipeline/issues/25)

### LENDING-37: The devnet lending market's script

- Question: How is our devnet Kamino lending market created and exercised?
- Answer: By `scripts/kamino-devnet`, a standalone TypeScript package with its own lockfile that builds Kamino's instructions with Kamino's MIT-licensed SDK and offers each step (setup, status, layout, the three parties, emergency mode and the whole proof) as a command the devnet demo can call.
- Alternatives: A Rust script beside `scripts/quote-devnet`, with every Kamino instruction written by hand.
- Specified in: [`docs/spec/lending-pool.md`, Devnet](spec/lending-pool.md#devnet)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Lending AMM: our Kamino lending market on devnet](https://github.com/imDev2023/testing-pipeline/issues/77)

### LENDING-38: Where the devnet lending market's addresses live

- Question: Where do the program and the later scripts find our devnet lending market's addresses?
- Answer: In `deployments/kamino-devnet.json`, a committed file of its own, where every address is derived with `createAccountWithSeed` from the market owner's or the test USDC mint authority's key in `~/.config/testing-pipeline/devnet/`, so the keys alone rebuild it.
- Alternatives: Account keypairs kept in the key folder; the addresses only in the spec's `LENT_MINTS` rows.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Lending AMM: our Kamino lending market on devnet](https://github.com/imDev2023/testing-pipeline/issues/77)

### LENDING-39: Devnet reserves' borrow rate curve

- Question: How steep is the borrow rate curve of our devnet reserves?
- Answer: 0% a year at 0% utilisation, 200% at 50%, 500% at 80% and 1,000% at 100%, so the test borrower's 3.5 SOL at 70% utilisation pays about 440 lamports of interest a second and a demo market's lending yield shows within seconds.
- Alternatives: Kamino's mainnet SOL curve, a few percent a year, under which a demo market's yield grows by less than a lamport a second.
- Specified in: [`docs/spec/lending-pool.md`, Devnet](spec/lending-pool.md#devnet)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Lending AMM: our Kamino lending market on devnet](https://github.com/imDev2023/testing-pipeline/issues/77)

### LENDING-40: Devnet reserves' price max age

- Question: How old a Pyth price do our devnet reserves accept?
- Answer: A week (604,800 seconds), because devnet's sponsored Pyth feeds can stop for long stretches, as on 2026-11-23 when klend refused the devnet demo's borrow after both had stood still for over 25 minutes, and on devnet a price only gates the test borrower's loan; Kamino's mainnet SOL and USDC reserves accept 120 and 180 seconds.
- Alternatives: The earlier default, 600 seconds, from feeds seen updating about every 5 minutes on 2026-11-10; Kamino's mainnet ages, which would refuse a borrow for much of each cycle; posting fresh Pyth prices ourselves before each borrow, which depends on Pyth's devnet pipeline running.
- Specified in: [`docs/spec/lending-pool.md`, Devnet](spec/lending-pool.md#devnet)
- Changes by: runtime setting
- Status: changed 2026-11-23
- Decided: 2026-11-10 in [Lending AMM: our Kamino lending market on devnet](https://github.com/imDev2023/testing-pipeline/issues/77)

### LENDING-41: Devnet reserves' risk settings and caps

- Question: What collateral settings, limits and caps do our devnet reserves have?
- Answer: Both take collateral at a 75% loan-to-value with an 85% liquidation threshold and a borrow factor of 100%, both can be borrowed, and each has deposit and borrow limits and a daily withdrawal cap of 10,000 SOL or 100,000,000 test USDC.
- Alternatives: Only test USDC as collateral and only WSOL borrowable.
- Specified in: [`docs/spec/lending-pool.md`, Devnet](spec/lending-pool.md#devnet)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Lending AMM: our Kamino lending market on devnet](https://github.com/imDev2023/testing-pipeline/issues/77)

### LENDING-42: What the devnet parties deposit and borrow

- Question: How much do the second depositor, the plain cToken holder and the test borrower put into our devnet reserves?
- Answer: The second depositor, the devnet wallet, supplies 5 SOL and 100,000 test USDC, the plain cToken holder deposits and redeems 0.1 SOL and 100 test USDC, and the test borrower posts 1,000 test USDC and borrows 3.5 SOL.
- Alternatives: A second depositor in the WSOL reserve only, the one the ticket's criterion names.
- Specified in: [`docs/spec/lending-pool.md`, Devnet](spec/lending-pool.md#devnet)
- Changes by: runtime setting
- Status: default
- Decided: 2026-11-10 in [Lending AMM: our Kamino lending market on devnet](https://github.com/imDev2023/testing-pipeline/issues/77)

### LENDING-43: Which cluster's lent mints a build carries

- Question: How does the program choose between the devnet and mainnet rows of `LENT_MINTS`?
- Answer: By the crate's `devnet` or `mainnet` feature, exactly one of them, with `devnet` the default because devnet is the only cluster this project deploys to; CI builds both, and the devnet rows must equal `deployments/kamino-devnet.json`.
- Alternatives: No default feature, so every build and test command names its cluster; a mainnet default.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-12 in [Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78)

### LENDING-44: The market state's final layout

- Question: What does a lending AMM market's state hold, and how can it grow?
- Answer: Every field the whole spec needs from the first build (withdraw mode, the recorded cTokens and the running totals deposited into and redeemed from Kamino included), after a version byte, at fixed offsets, with 256 reserved bytes that only ever gain appended fields, a zeroed value meaning the old behaviour; 663 bytes.
- Alternatives: Adding fields with each ticket and reallocating; a smaller reserve.
- Specified in: [`docs/spec/lending-pool.md`, Market state](spec/lending-pool.md#market-state)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78)

### LENDING-45: Where an LP's shares go

- Question: Into which account does `add_liquidity` mint an LP's shares?
- Answer: The LP's shares account, a token account of the LP mint owned by the LP at the PDA `["lp_shares", market_state, lp]`, which `add_liquidity` creates at the LP's expense if it is missing, because metadata cannot describe the associated token account of a mint that is itself a PDA.
- Alternatives: The LP's associated token account, which a generic desk could not build from the metadata; any token account the LP names.
- Specified in: [`docs/spec/lending-pool.md`, Addresses](spec/lending-pool.md#addresses)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78)

### LENDING-46: How add_liquidity takes its amounts

- Question: In what order does `add_liquidity` take the most an LP will add of each mint?
- Answer: By mint index, `max_0` and `max_1`, as its accounts are ordered, so a form can show each amount with its own mint's decimals whichever side is lent.
- Alternatives: By side, `max_other` and `max_lent`, as the spec first wrote it.
- Specified in: [`docs/spec/lending-pool.md`, Adding](spec/lending-pool.md#adding)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78)

### LENDING-47: The collateral mint at creation

- Question: How does market creation get the lent mint's collateral mint, which its cToken account needs?
- Answer: As a named input of the metadata's `init` form, which Aviary's form fills in, and which the program refuses unless it is the collateral mint `LENT_MINTS` names for the lent mint.
- Alternatives: A fixed address in the metadata, which cannot serve both lent mints; creating the cToken account later, at the first `rebalance`.
- Specified in: [`docs/spec/lending-pool.md`, Custom actions and metadata](spec/lending-pool.md#custom-actions-and-metadata)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78)

### LENDING-48: How add_liquidity gets the reserve

- Question: How does `add_liquidity` get the Kamino reserve it values the lent side from?
- Answer: As its last named account, which the metadata's `add_liquidity` action takes as the named input `reserve` and Aviary's form fills in, and which the program refuses unless it is the reserve `LENT_MINTS` names for the market's lent mint.
- Alternatives: A metadata source reading the reserve from the market state, which the metadata schema at `5ad130d` does not have; a remaining account after the hook accounts, which would let a deposit leave it out.
- Specified in: [`docs/spec/lending-pool.md`, Custom actions and metadata](spec/lending-pool.md#custom-actions-and-metadata)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79)

### LENDING-49: Where the reserve sits in a swap's accounts

- Question: Where do quotes and swaps find the Kamino reserve, and how is it locked?
- Answer: Third among the strategy accounts `pipeline_resolve_accounts` lists, after the output vault and the vault authority, read-only, so ordinary swaps never write-lock the reserve every Kamino user of that mint shares; a trade built without it fails the reserve check with `ReserveWrongAddress`.
- Alternatives: After the hook accounts, which would make its place depend on the output mint.
- Specified in: [`docs/spec/lending-pool.md`, Accounts](spec/lending-pool.md#accounts)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79)

### LENDING-50: Valuing cTokens at the edges

- Question: What are a market's cTokens worth when the reserve's total supply or cToken supply is 0, or when the value does not fit a u64?
- Answer: Nothing when either supply is 0, which can only understate where klend would use its initial rate of one, and a value above a u64 is refused (`Overflow`); a total supply klend's own fixed point cannot compute (beyond 128 bits, or negative) refuses with `ReserveSupplyInvalid`.
- Alternatives: klend's initial rate of one for an empty reserve.
- Specified in: [`docs/spec/lending-pool.md`, Total reserves](spec/lending-pool.md#total-reserves)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79)

### LENDING-51: One error for each part of the reserve check

- Question: How does a reserve that fails the check say which part failed?
- Answer: With its own error for each part, in the order the check runs: address, owner, size, discriminator, lending market, liquidity mint, collateral mint.
- Alternatives: One error for every part, with the part only in the logs.
- Specified in: [`docs/spec/lending-pool.md`, Checking the reserve before reading it](spec/lending-pool.md#checking-the-reserve-before-reading-it)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79)

### LENDING-52: Where the Kamino fixtures live

- Question: Where do the tests and the local demo run get Kamino's accounts and program?
- Answer: The tests load accounts dumped from each cluster at one slot and committed in `programs/lending-amm/tests/fixtures/kamino/<cluster>/`, replaced only on purpose; klend's bytes from both clusters are fetched into the gitignored `fixtures/klend/` and refused unless they match the hashes in `fixtures/pins.env`; the local demo run clones our devnet lending market's accounts afresh from devnet and warps the validator past their slot.
- Alternatives: The local demo run on the committed devnet dump; caching klend's bytes in CI rather than fetching them on every run.
- Specified in: [`docs/spec/lending-pool.md`, Building it](spec/lending-pool.md#building-it)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79)

### LENDING-53: How the target and the band round

- Question: How is the target buffer rounded, and is a share exactly at an edge of the band inside it or outside it?
- Answer: The target is `floor(L x BUFFER_TARGET_BPS / 10,000)`, and the band is compared exactly in 128-bit integers with both edges inside it, so a deposit leaves exactly the target and an uncapped redeem asks for exactly the target.
- Alternatives: The target rounded up; the edges outside the band; comparing shares rounded to whole basis points.
- Specified in: [`docs/spec/lending-pool.md`, The rule](spec/lending-pool.md#the-rule)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80)

### LENDING-54: What a rebalance with nothing to do does

- Question: What does `rebalance` do inside the band, below the floor, or when Kamino can pay nothing of a redeem?
- Answer: It fails and changes nothing, with `WithinBand` inside the band and `BelowMinRebalance` below the lent mint's `MIN_REBALANCE` or when Kamino can pay nothing, so a keeper's simulation shows there is nothing to do and nobody pays for a no-op.
- Alternatives: Succeeding without moving anything, which a keeper would pay for; one error for both cases.
- Specified in: [`docs/spec/lending-pool.md`, The rule](spec/lending-pool.md#the-rule)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80)

### LENDING-55: How many cTokens a rebalance redeems

- Question: How many cTokens does `rebalance` burn to redeem a shortfall?
- Answer: As many as are worth at most the shortfall at the stored rate, `floor(s x S_ctoken / S_total)`, or all the market holds once the shortfall reaches their whole value, so the buffer never passes its target at that rate and lands less than one cToken's worth short of it.
- Alternatives: Rounding up, as the in-swap redeem does to cover a payout, which could carry the buffer one cToken's worth past its target.
- Specified in: [`docs/spec/lending-pool.md`, The rule](spec/lending-pool.md#the-rule)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80)

### LENDING-56: How rebalance checks Kamino's accounts

- Question: Which of the accounts `rebalance` passes to klend does the program check itself, rather than leave to klend?
- Answer: All of them, before calling klend: klend's id, SPL Token, the instructions sysvar, the lent and collateral mints, the reserve, its liquidity supply, its lending market and that market's authority PDA, each failing with `KaminoAccountWrong` unless the reserve or lending market check names it, and its own buffer vault and cToken account by address.
- Alternatives: Checking only the reserve and the klend program and leaving the rest to klend's own constraints, which would also refuse them but with klend's errors and only for the accounts klend constrains.
- Specified in: [`docs/spec/lending-pool.md`, Custom actions and metadata](spec/lending-pool.md#custom-actions-and-metadata)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80)

### LENDING-57: How rebalance takes its Kamino accounts

- Question: How does a keeper or Aviary's form give `rebalance` the Kamino accounts of a market's lent mint?
- Answer: As the metadata's named inputs `lent_mint`, `reserve`, `lending_market`, `reserve_liquidity_supply` and `collateral_mint`, with the lending market authority as klend's PDA of the lending market and the caller a read-only signer, and the band's three constants exported in the IDL for forms and keepers to read.
- Alternatives: A metadata source reading them from the market state or the reserve, which the metadata schema at `5ad130d` does not have.
- Specified in: [`docs/spec/lending-pool.md`, Custom actions and metadata](spec/lending-pool.md#custom-actions-and-metadata)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80)

### LENDING-58: Kamino's rounding in a rebalance

- Question: May a `rebalance` lower the lent side's total, and so an LP share's value, by Kamino's own rounding?
- Answer: Yes, by at most one unit of the lent mint, since klend takes back a deposit's cTokens rounded up and the market values its cTokens rounded down; the tests and the fuzzer allow exactly that unit and no more.
- Alternatives: Depositing one unit less so the total can never fall, which leaves the buffer a unit above its target and still cannot cover a redeem's rounding.
- Specified in: [`docs/spec/lending-pool.md`, The rule](spec/lending-pool.md#the-rule)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80)

### LENDING-59: Headroom below Kamino's limits on a redeem

- Question: How far below Kamino's freely available liquidity and withdrawal cap does `rebalance` plan a redeem, given that klend pays at the rate it refreshes the reserve to inside the redeem?
- Answer: 10 basis points of each limit, the constant `KAMINO_RATE_HEADROOM_BPS`, about a week of interest at 5% a year since the reserve's last refresh, and none on the value of the market's own cTokens.
- Alternatives: No headroom, which makes klend refuse a redeem capped at a limit whenever the reserve was not refreshed in the same slot; calling klend's `refresh_reserve` first, which needs the reserve's oracle accounts whenever its price is stale, a dependency the cToken path otherwise avoids; projecting the interest, which would copy Kamino's interest maths.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-16 in [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80)

### LENDING-60: How a redeeming swap's accounts are resolved

- Question: How does `pipeline_resolve_accounts` decide whether a trade needs Kamino's redeem accounts, and which does it list?
- Answer: A lent-side output resolves in two rounds, the second reading the reserve and running the quote with the one pricing function, and only a trade that quote redeems gets the reserve writable and, after it, klend, the lending market, its authority, the reserve's liquidity supply and collateral mint, the market's cToken account, SPL Token once and the instructions sysvar; an other-side output resolves in one round, and a reserve failing its check or a refused trade gets no redeem accounts.
- Alternatives: Always listing the redeem accounts for a lent-side output, which would write-lock the reserve every Kamino user of that mint shares on every sale; one round with the redeem accounts guessed from vault balances, which cannot value the cTokens.
- Specified in: [`docs/spec/lending-pool.md`, Accounts](spec/lending-pool.md#accounts)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: redeem a swap's shortfall from Kamino inside the swap](https://github.com/imDev2023/testing-pipeline/issues/81)

### LENDING-61: A swap built without its redeem accounts

- Question: How does a swap recognise the redeem accounts, and what does one that needs a redeem but lacks them do?
- Answer: It recognises them by klend's id right after a lent-side output's reserve and checks them only when the trade redeems, each failing with `KaminoAccountWrong` unless the reserve or lending market check names it; without them it fails with its own error, `RedeemAccountsMissing`, and changes nothing, so the integrator resolves again.
- Alternatives: Spending only the buffer and refusing the rest with `BeyondBuffer`, which would not tell the integrator that resolving again fixes it; checking the redeem accounts on every swap that carries them, which costs compute for nothing.
- Specified in: [`docs/spec/lending-pool.md`, Accounts](spec/lending-pool.md#accounts)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: redeem a swap's shortfall from Kamino inside the swap](https://github.com/imDev2023/testing-pipeline/issues/81)

### LENDING-62: What Kamino can pay a swap

- Question: How much of a shortfall may a swap plan to redeem, given that klend pays at the rate it refreshes the reserve to inside the redeem?
- Answer: What Kamino can pay right now with the same `KAMINO_RATE_HEADROOM_BPS` taken off its freely available liquidity and withdrawal cap as for `rebalance`, read from the lending market and the clock only when the output passes the buffer; a larger shortfall is refused with `BeyondBuffer` by the quote and the swap alike.
- Alternatives: Kamino's limits with no headroom, under which a quote could promise a trade klend then refuses whenever the reserve was not refreshed in the same slot.
- Specified in: [`docs/spec/lending-pool.md`, Redeeming the shortfall](spec/lending-pool.md#redeeming-the-shortfall)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: redeem a swap's shortfall from Kamino inside the swap](https://github.com/imDev2023/testing-pipeline/issues/81)

### LENDING-63: What a redeeming swap records and tells

- Question: What does a swap that redeems record, and what does it emit?
- Answer: It measures the lent mint that arrived in its buffer vault and the cTokens that left its cToken account, fails with `RedeemPaidShort` below the shortfall, keeps anything above it in the buffer, adds what arrived to its running total redeemed, and emits `ShortfallRedeemed` with the shortfall, the cTokens burned, the lent mint received and the buffer, cTokens and running total afterwards.
- Alternatives: Recording what it asked klend for rather than what moved; leaving the redeem to the router's swap event, which carries only the trade's amounts.
- Specified in: [`docs/spec/lending-pool.md`, Redeeming the shortfall](spec/lending-pool.md#redeeming-the-shortfall)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: redeem a swap's shortfall from Kamino inside the swap](https://github.com/imDev2023/testing-pipeline/issues/81)

### LENDING-64: Kamino's rounding in a redeeming swap

- Question: May a swap that redeems lower the lent side's total, and so `R x L`, by Kamino's own rounding?
- Answer: Yes, by at most one unit of the lent mint, as a `rebalance` may, since klend pays its rounded-down rate for the cTokens burned while the market values the rest rounded down too; the tests and the fuzzer allow exactly that unit and no more.
- Alternatives: Refusing a redeem whose rounding would lower the total, which would refuse ordinary sales over a single unit.
- Specified in: [`docs/spec/lending-pool.md`, Invariants for test layer 3](spec/lending-pool.md#invariants-for-test-layer-3)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: redeem a swap's shortfall from Kamino inside the swap](https://github.com/imDev2023/testing-pipeline/issues/81)

### LENDING-65: How an in-kind removal leaves Kamino's accounts out

- Question: How does one `remove_liquidity` instruction take Kamino's accounts in cash and none at all in kind?
- Answer: It takes them last as Anchor optional accounts, among them a writable copy of the collateral mint so that the shared one stays read-only and an in-kind removal never write-locks it; an in-kind removal passes the program's own id in their seven places and never reads them, and metadata has two forms of the one instruction, `remove_liquidity` in cash and `remove_liquidity_in_kind` naming it by its discriminator with `strategy_program` in those places.
- Alternatives: Kamino's accounts as remaining accounts recognised by klend's id, which metadata cannot describe; two instructions, which would change the spec's one `remove_liquidity { lp, min_other, min_lent, in_kind }`.
- Specified in: [`docs/spec/lending-pool.md`, Custom actions and metadata](spec/lending-pool.md#custom-actions-and-metadata)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82)

### LENDING-66: When a cash removal redeems

- Question: When does a removal in cash redeem the cTokens' part, and when does it refuse?
- Answer: After checking every Kamino account as `rebalance` does, it refuses with `KaminoCannotPay` before burning anything or calling Kamino unless the part's value at the stored rate is within what Kamino can pay right now as a swap's redeem counts it, headroom included; cTokens worth less than one unit at the stored rate are not redeemed and stay in the market, and a cash removal that would then pay nothing is refused with `ZeroRemoval`; a cash removal that must redeem without Kamino's accounts fails with `KaminoAccountsMissing`.
- Alternatives: Calling klend and letting it refuse, which would not name the cause; Kamino's limits with no headroom, under which klend could refuse a removal the program let through.
- Specified in: [`docs/spec/lending-pool.md`, Removing](spec/lending-pool.md#removing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82)

### LENDING-67: What a cash removal pays and records

- Question: What does an LP receive for the cTokens' part in cash, and what does the market record and tell?
- Answer: klend redeems the part into the market's buffer vault and the LP receives the buffer's part plus everything klend paid, as measured, at the rate klend refreshed to; the market records exactly what left, adds klend's payout to its running total redeemed, and emits `LiquidityRemoved` with the shares, the share count after, what each mint paid, the cTokens that left, whether in kind and klend's payout.
- Alternatives: Paying only the part's value at the stored rate and keeping the interest klend accrued in the refresh, which belongs to those cTokens; redeeming straight into the LP's account, which the market could not measure.
- Specified in: [`docs/spec/lending-pool.md`, Removing](spec/lending-pool.md#removing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82)

### LENDING-68: Which accounts a removal or a lock takes shares from and pays into

- Question: From which LP token accounts may a removal or a lock take shares, and where do in-kind cTokens go?
- Answer: From any token account of the LP mint the signer owns, never one they are only a delegate of (`WrongAccount`); in-kind cTokens go to the LP's associated token account for the collateral mint, which the associated token program creates at the LP's expense only when it is missing.
- Alternatives: Only the LP's shares account PDA, which would strand shares an LP moved elsewhere; letting a delegate remove, which would pay a delegate another holder's liquidity.
- Specified in: [`docs/spec/lending-pool.md`, Removing](spec/lending-pool.md#removing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82)

### LENDING-69: The lock account and the first lock

- Question: Who creates the lock account, and how do forms find it?
- Answer: The market's first `lock_lp` creates it, the vault authority's associated token account for the LP mint, at that LP's expense, and the `lock_lp` metadata action takes it as the named input `lock_account`, since metadata cannot describe the associated token account of a mint that is itself a PDA; it emits `SharesLocked` with the shares locked, the lock account's balance and the share count.
- Alternatives: Creating the lock account at market creation, which would add rent and a fifth account to every creation transaction already near its size limit.
- Specified in: [`docs/spec/lending-pool.md`, Locking](spec/lending-pool.md#locking)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82)

### LENDING-70: min_lent in each form

- Question: What does `min_lent` bound in a cash removal and in an in-kind one?
- Answer: The lent mint actually paid: the buffer's part plus klend's payout in cash, and the buffer's part alone in kind, where the cTokens' part is fixed by the market's recorded cTokens.
- Alternatives: Bounding the lent side's value including in-kind cTokens at the stored rate, which would make an in-kind removal read the reserve.
- Specified in: [`docs/spec/lending-pool.md`, Removing](spec/lending-pool.md#removing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82)

### LENDING-71: A removal's rounding

- Question: May a removal lower the value of an LP share?
- Answer: Per share none of `R`, `B` and `c` falls, since each part rounds down; the market values the remaining cTokens rounded down, so `L x lp / N` may read one unit of the lent mint lower, which the tests and the fuzzer allow and no more.
- Alternatives: Paying fewer cTokens so that the floored value never falls, which would depart from the spec's `c x lp / N`.
- Specified in: [`docs/spec/lending-pool.md`, Invariants for test layer 3](spec/lending-pool.md#invariants-for-test-layer-3)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82)

### LENDING-72: The running totals after an in-kind removal

- Question: How do the running totals deposited into and redeemed from Kamino follow cTokens an LP takes in kind, so that the lending yield `V + redeemed - deposited` stays right?
- Answer: The cTokens take their share of the market's cTokens of the net amount lent, `deposited - redeemed`, rounded towards zero, off `deposited`, or off `redeemed` while redeemed is the larger, so the yield falls by the same fraction as `V`, the part that left with the cTokens, without the in-kind path reading the reserve to value them.
- Alternatives: Leaving the totals unchanged, which would show a market that paid out half its cTokens in kind as having lost half its lent value; adding the cTokens' value to `redeemed`, which needs the reserve that the in-kind path must never read.
- Specified in: [`docs/spec/lending-pool.md`, Removing](spec/lending-pool.md#removing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82)

### LENDING-73: How withdraw mode measures Kamino and the market

- Question: What exactly does `rebalance` compare to enter and leave withdraw mode?
- Answer: The reserve's freely available liquidity (`total_available_amount` less queued withdrawal tickets, at the stored rate) against `X = max(V, T)` with `T = L - floor(L x BUFFER_TARGET_BPS / 10,000)`, entering below `WITHDRAW_MODE_ENTER x X`, leaving above `WITHDRAW_MODE_EXIT x X` and keeping the mode at and between both edges, the products taken in 128 bits.
- Alternatives: `T` rounded down; the total available amount without the queued tickets; comparing at or below and at or above, which would let both edges change the mode.
- Specified in: [`docs/spec/lending-pool.md`, Withdraw mode](spec/lending-pool.md#withdraw-mode)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-74: A rebalance that changes withdraw mode but moves nothing

- Question: What does a `rebalance` do when it should enter or leave withdraw mode but has nothing to move, such as entering when Kamino can pay nothing, or leaving with the buffer inside its band?
- Answer: It succeeds and records the mode, emitting its event, while a call that neither moves nor changes the mode still refuses as a no-op, with `BelowMinRebalance` in withdraw mode once everything is redeemed.
- Alternatives: Refusing it like any no-op, which would leave a market that cannot redeem anything right now out of withdraw mode, ready to lend back into the crunch.
- Specified in: [`docs/spec/lending-pool.md`, Withdraw mode](spec/lending-pool.md#withdraw-mode)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-75: The floor in withdraw mode

- Question: Does the lent mint's `MIN_REBALANCE` apply to the redeems `rebalance` makes in withdraw mode?
- Answer: Yes, except for a redeem that takes every cToken the market holds, so a market can always empty out its last cTokens however little they are worth.
- Alternatives: The floor always, which could leave dust lent to a reserve in a crunch; no floor, which would let keepers pay for redeems of a few lamports again and again.
- Specified in: [`docs/spec/lending-pool.md`, Withdraw mode](spec/lending-pool.md#withdraw-mode)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-76: Rebalance while Kamino redeems nothing

- Question: What does `rebalance` do while either emergency mode is on or the reserve is deprecated?
- Answer: It refuses with its own error, `KaminoStopped`, before anything else, changing nothing and leaving withdraw mode as it was.
- Alternatives: Planning as usual and failing with `BelowMinRebalance`, or calling klend and letting it refuse, either of which hides why.
- Specified in: [`docs/spec/lending-pool.md`, When Kamino can't pay](spec/lending-pool.md#when-kamino-cant-pay)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-77: Rebalance while cToken deposits are blocked

- Question: What does `rebalance` do above the band while Kamino blocks cToken deposits (`block_ctoken_usage`)?
- Answer: It skips the deposit and refuses with `KaminoDepositsBlocked`, changing nothing, while redeems below the band go ahead and leaving withdraw mode is still recorded.
- Alternatives: Calling klend and letting it refuse with its own error.
- Specified in: [`docs/spec/lending-pool.md`, When Kamino can't pay](spec/lending-pool.md#when-kamino-cant-pay)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-78: A cash removal while Kamino redeems nothing

- Question: May an LP remove in cash while Kamino redeems nothing, when the stored rate values their cTokens' part at nothing, as after a total write-off?
- Answer: No: whenever Kamino redeems nothing and the LP's part holds any cTokens, a cash removal refuses with `KaminoCannotPay` before calling Kamino, and the LP removes in kind, taking their cTokens.
- Alternatives: Letting the cash path skip cTokens worth nothing at the stored rate, which would leave the LP's cTokens behind for the remaining LPs.
- Specified in: [`docs/spec/lending-pool.md`, When Kamino can't pay](spec/lending-pool.md#when-kamino-cant-pay)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-79: What Kamino can pay without the lending market's account

- Question: How do account resolution, and a quote or swap built without the redeem accounts, count what Kamino can pay, when they have the reserve but not the lending market?
- Answer: From the reserve alone (its emergency mode, deprecation, free liquidity and withdrawal cap), so a trade the reserve refuses gets no redeem accounts and fails with `BeyondBuffer`, while one only the lending market's emergency mode refuses gets them and its quote and swap refuse it.
- Alternatives: Assuming Kamino can pay anything, which listed klend's accounts for trades Kamino could not pay and sent the swap built from them back to resolution with `RedeemAccountsMissing`; a third round to read the lending market.
- Specified in: [`docs/spec/lending-pool.md`, Accounts](spec/lending-pool.md#accounts)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-80: A redeem on a stale reserve

- Question: How does `rebalance` redeem what Kamino can pay when the reserve's stored rate is older than `KAMINO_RATE_HEADROOM_BPS` covers, so klend's refreshed rate would carry a capped redeem past Kamino's limits?
- Answer: The keeper puts klend's own `refresh_reserve`, with the reserve's oracle accounts, before `rebalance` in the same transaction, so the redeem is planned at a rate refreshed in that slot; alone, the call fails whole and changes nothing.
- Alternatives: A larger or rate-aware headroom; `rebalance` calling `refresh_reserve` itself, which needs the oracle accounts in every call; projecting the interest, which the spec rules out.
- Specified in: [`docs/spec/lending-pool.md`, The rule](spec/lending-pool.md#the-rule)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-81: Withdraw mode's events

- Question: What does the market emit when `rebalance` enters or leaves withdraw mode?
- Answer: `WithdrawModeEntered` or `WithdrawModeLeft`, with the market, the free liquidity and the exposure `X` it measured, before the call's `Rebalanced` if it moved anything.
- Alternatives: One event with a flag; putting the mode into `Rebalanced`, which a call that moves nothing does not emit.
- Specified in: [`docs/spec/lending-pool.md`, Withdraw mode](spec/lending-pool.md#withdraw-mode)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-82: The demo market's size and the tests' second depositor

- Question: How large is the demo market, and how do the `devnet` build's tests keep its WSOL reserve out of withdraw mode?
- Answer: The demo market's first deposit puts 0.5 SOL on the lent side, as the devnet ticket asks, and its later deposits are small enough that the lent side stays near 0.6 SOL, so it fits the 5 SOL the devnet wallet keeps free in the WSOL reserve, and the `devnet` build's tests give the dumped reserve a second depositor of their own that keeps 2,500 SOL free.
- Alternatives: The earlier default, a lent side near 0.4 SOL from a first deposit of 0.35 SOL, which the devnet ticket's 0.5 SOL ruled out; topping the devnet reserve up for the demo, which would make the devnet ticket's demo depend on a larger second depositor; shrinking every test market to fit 5 SOL.
- Specified in: [`docs/spec/lending-pool.md`, Devnet](spec/lending-pool.md#devnet)
- Changes by: spec only
- Status: changed 2026-11-22
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-83: Rebalance runs alone in its transaction

- Question: How is `rebalance` kept from being sandwiched, with Kamino's free liquidity moved before it and back after it in the same transaction to force a market into or out of withdraw mode?
- Answer: It refuses with `RebalanceNotAlone` unless called directly, at the transaction's level, beside nothing but compute budget instructions and klend's `refresh_reserve` or `refresh_reserves_batch`, and once per transaction, as the instructions sysvar shows, since another market's `rebalance` deposits into or redeems from Kamino as klend's own instructions would.
- Alternatives: The earlier default, it refuses with `RebalanceNotAlone` unless called directly, at the transaction's level, beside nothing but compute budget instructions, klend's `refresh_reserve` and other `rebalance` calls, as the instructions sysvar shows; refusing only klend's own instructions, which another program calling klend would get around; measuring free liquidity over time, which needs state the market does not keep; accepting the sandwich.
- Specified in: [`docs/spec/lending-pool.md`, Withdraw mode](spec/lending-pool.md#withdraw-mode)
- Changes by: fixed on-chain once deployed
- Status: changed 2026-11-17
- Decided: 2026-11-16 in [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)

### LENDING-84: Seeding checks the Kamino reserve

- Question: Does `pipeline_seed_liquidity` check the lent mint's Kamino reserve, which creation alone never reads?
- Answer: Yes: the reserve is one of its accounts, and it refuses one that fails the reserve check or is deprecated, exactly as the first deposit through `add_liquidity` does, so a seeded market and a created one refuse the same openings.
- Alternatives: Leaving the reserve out, which saves 33 bytes of the graduation transaction but lets a launchpad open a market against a deprecated reserve that would never lend.
- Specified in: [`docs/spec/lending-pool.md`, Seeding](spec/lending-pool.md#seeding)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: seeding by a launchpad](https://github.com/imDev2023/testing-pipeline/issues/84)

### LENDING-85: Where a seed's shares go, and how a launchpad names that account

- Question: How does `pipeline_seed_liquidity` reach the LP recipient's associated token account for the LP mint, which metadata cannot describe because the LP mint is itself a PDA?
- Answer: The strategy creates that account itself, idempotently, through the associated token program from the payer's SOL, and checks its address, and the metadata's `seed_liquidity` form takes it as the named input `lp_recipient_shares`, which is the lock account when the LP recipient is the market's vault authority.
- Alternatives: The LP's shares PDA `["lp_shares", market_state, lp_recipient]` that `add_liquidity` uses, which metadata can describe but which would put a locked seed outside the lock account indexers read; asking the launchpad to create the account first, which it cannot before the LP mint exists.
- Specified in: [`docs/spec/lending-pool.md`, Seeding](spec/lending-pool.md#seeding)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: seeding by a launchpad](https://github.com/imDev2023/testing-pipeline/issues/84)

### LENDING-86: Graduation transactions on hooked tokens use a lookup table

- Question: Does a launchpad's graduation, with `register_existing_market` and both `init_fee_account` calls in the same transaction, fit Solana's 1,232 bytes?
- Answer: As a legacy transaction signed by the creator alone it does on SPL Token and plain Token-2022 tokens (at most 1,221 bytes), and with a transfer hook's two accounts it does not (1,287), so a launchpad graduating a hooked token sends a version 0 transaction with an address lookup table of the accounts every graduation shares (1,044 bytes in the tests).
- Alternatives: Dropping accounts from `pipeline_seed_liquidity` (the reserve, the associated token program), which saves at most 66 bytes and gives up LENDING-84 or LENDING-85; recording the market in a second transaction, which the ticket's same-transaction rule excludes.
- Specified in: [`docs/spec/lending-pool.md`, Seeding](spec/lending-pool.md#seeding)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Lending AMM: seeding by a launchpad](https://github.com/imDev2023/testing-pipeline/issues/84)

### LENDING-87: Seeding's events

- Question: What does `pipeline_seed_liquidity` emit for indexers?
- Answer: `MarketCreated`, as every creation does, then `MarketSeeded` with the seeder, the LP recipient, the account the shares went to, the amounts taken, the shares minted and the share count afterwards.
- Alternatives: `LiquidityAdded` with the LP recipient as the LP, which would hide that the deposit came from a launchpad's escrows and not from the recipient's wallet.
- Specified in: [`docs/spec/lending-pool.md`, Seeding](spec/lending-pool.md#seeding)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Lending AMM: seeding by a launchpad](https://github.com/imDev2023/testing-pipeline/issues/84)

### LENDING-88: Compute ceilings from measured costs

- Question: How far above what an instruction is measured to cost does its compute ceiling sit, and what do the tests check?
- Answer: Every instruction is measured in every state of Kamino on both cluster builds and on fixed keys, the spec's table carries the highest cost of each row, and each ceiling is that cost plus a quarter, rounded up to a multiple of 5,000, except where a written reason keeps or raises it (`add_liquidity` and `lock_lp`, whose address searches vary with the keys); the tests assert every cost against its ceiling and each ceiling against the rule.
- Alternatives: A fixed margin in compute units; leaving the ceilings set before measuring, which left up to twice the cost as headroom; leaving out what bump searches spend beyond an address's first bump, as `TAX-51` does for the tax AMM.
- Specified in: [`docs/spec/lending-pool.md`, Compute ceilings](spec/lending-pool.md#compute-ceilings)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-16 in [Lending AMM: the fuzzer against a moving Kamino, and the proofs completed](https://github.com/imDev2023/testing-pipeline/issues/85)

### LENDING-89: How the fuzzer moves Kamino

- Question: How does the stateful fuzzer move Kamino between steps, so the invariants are checked against a moving rate and every state Kamino can be in?
- Answer: Interest raises the rate, by edits of what borrowers owe and by klend's own `refresh_reserve` after time passes; write-offs with klend's real `socialize_loss` lower it, one in ten of them of the whole supply, which deprecates the reserve; borrowers move the free liquidity around withdraw mode's thresholds; and `block_ctoken_usage`, both emergency modes and a failed layout check switch on and off, all on klend's deployed bytes.
- Alternatives: A fixed Kamino state per case, as the feature tickets fuzzed; moving the rate only by klend's refresh, at the pace of the interest the dumped reserves' borrowers pay.
- Specified in: [`docs/spec/lending-pool.md`, Invariants for test layer 3](spec/lending-pool.md#invariants-for-test-layer-3)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Lending AMM: the fuzzer against a moving Kamino, and the proofs completed](https://github.com/imDev2023/testing-pipeline/issues/85)

### LENDING-90: Each invariant shown able to fail by a broken build

- Question: How is each invariant of the fuzzer shown able to fail, and kept so?
- Answer: A table of deliberately broken builds, each one careless edit (a rounding flipped the wrong way, a missing check) made to a copy of the program's source and built in its own target directory, so the program's source never carries them; a test runs the fuzzer on each from a fixed seed and requires it caught by the invariant the table names, at least one build for every invariant, in CI on every push.
- Alternatives: Cargo features that switch the mistakes on inside the program's source; mutation testing with a generic tool, whose mutants are not tied to an invariant.
- Specified in: [`docs/spec/lending-pool.md`, Invariants for test layer 3](spec/lending-pool.md#invariants-for-test-layer-3)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Lending AMM: the fuzzer against a moving Kamino, and the proofs completed](https://github.com/imDev2023/testing-pipeline/issues/85)

### LENDING-91: How fresh the reserve must be for adding

- Question: How recently must Kamino's reserve have been refreshed when `add_liquidity` values a market's cTokens at its stored rate?
- Answer: In the same slot (`ADD_MAX_RESERVE_AGE_SLOTS`, 0), as klend itself asks before stating its exchange rate, once the market holds cTokens; otherwise it refuses with `ReserveStale`, and a depositor puts klend's `refresh_reserve` first in the same transaction.
- Alternatives: Accepting the stored rate at any age, which let a deposit added before a refresh and removed after it take the LPs' unrefreshed interest, since adding and removing charge no fee; projecting the interest, which would copy Kamino's interest maths; refreshing the reserve by CPI inside `add_liquidity`, which would write-lock the shared reserve and add four oracle accounts to every deposit.
- Specified in: [`docs/spec/lending-pool.md`, The stored rate, everywhere](spec/lending-pool.md#the-stored-rate-everywhere)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-17 in [Lending AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/86)

### LENDING-92: How fresh the reserve must be for quotes and swaps

- Question: How recently must Kamino's reserve have been refreshed when a quote or a swap values a market's cTokens at its stored rate?
- Answer: Within `TRADE_MAX_RESERVE_AGE_SLOTS` (9,000 slots, about an hour), once the market holds cTokens and the reserve is not deprecated, so no round trip across a refresh pays Pipeline's fee twice; beyond it quotes and swaps refuse with `ReserveStale` until someone puts klend's `refresh_reserve` first.
- Alternatives: Accepting the stored rate at any age, under which a round trip paid on our devnet reserves left days without a refresh; the same slot, as for adding, which would ask every swap of every integrator to refresh the reserve first and write-lock it.
- Specified in: [`docs/spec/lending-pool.md`, The stored rate, everywhere](spec/lending-pool.md#the-stored-rate-everywhere)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-17 in [Lending AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/86)

### LENDING-93: Withdraw mode waits before it leaves

- Question: How is a market kept from being taken out of withdraw mode by one reading of Kamino's free liquidity, inflated by a deposit and a redeem around `rebalance` in one Jito bundle?
- Answer: The first `rebalance` that sees the free liquidity above the exit threshold records its slot in `exit_seen_slot`, the first field taken from the market state's reserved space, and stays; the market leaves only at a `rebalance` at least `WITHDRAW_MODE_EXIT_DELAY_SLOTS` (9,000 slots, about an hour) later that sees it so too, and any reading at or below the threshold in between, or any `rebalance` while Kamino redeems nothing, starts the wait again.
- Alternatives: Leaving at the first reading above the threshold, which a bundle could force at no risk; a deposit-weighted measure over time, which Kamino's reserve does not keep.
- Specified in: [`docs/spec/lending-pool.md`, Withdraw mode](spec/lending-pool.md#withdraw-mode)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-17 in [Lending AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/86)

### LENDING-94: Leaving with the lent side alone

- Question: How does an LP leave when the other mint's freeze authority or transfer hook stops its transfers, which every `remove_liquidity` makes?
- Answer: With `remove_lent_side`, which burns shares for the buffer's part in the lent mint and the cTokens' part as cTokens, each with its own minimum (`min_lent`, `min_ctokens`), moves nothing of the other mint and reads no Kamino account, and leaves the other side's part in the market for the LPs who stay.
- Alternatives: A flag on `remove_liquidity`, which would change both of its metadata forms; keeping the other side's part owed to the LP, which would need a record per LP; accepting that such a mint traps the lent side.
- Specified in: [`docs/spec/lending-pool.md`, Leaving with the lent side alone](spec/lending-pool.md#leaving-with-the-lent-side-alone)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-17 in [Lending AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/86)

### LENDING-95: The keeper refreshes reserves and sweeps withdraw mode

- Question: Who keeps the reserves fresh enough to quote, and the readings of a market waiting to leave withdraw mode honest?
- Answer: Our keeper runner, which refreshes each reserve a lending AMM market lends to whenever its last refresh is more than half of `TRADE_MAX_RESERVE_AGE_SLOTS` old, and whose sweeps every 10 minutes send `rebalance` to a market in withdraw mode whenever its simulation succeeds.
- Alternatives: Leaving refreshes to traders and Aviary alone, which would leave devnet markets unquotable for days at a time.
- Specified in: [`docs/spec/lending-pool.md`, When it runs](spec/lending-pool.md#when-it-runs)
- Changes by: spec only
- Status: default
- Decided: 2026-11-17 in [Lending AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/86)

### LENDING-96: The local demo run waits out withdraw mode's exit on fast slots

- Question: How does the local demo run show a market leaving withdraw mode, now that leaving takes `WITHDRAW_MODE_EXIT_DELAY_SLOTS`?
- Answer: Its validator is started with `--ticks-per-slot 8`, about 11 slots a second on the owner's Mac, and the demo waits for the slot the market may leave at, about 14 minutes; on devnet it waits the hour.
- Alternatives: A shorter delay in the `devnet` build, which would weaken the deployed bytes; skipping the exit in the demo.
- Specified in: [`docs/toolchain.md`, Local demo run](toolchain.md#local-demo-run)
- Changes by: spec only
- Status: default
- Decided: 2026-11-17 in [Lending AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/86)

### LENDING-97: How the devnet demo shows the lending yield

- Question: How does the devnet demo show that the market earns from Kamino while a borrower holds a loan?
- Answer: Right after the test borrower borrows, the demo reads the market's lending yield so far, `V + redeemed - deposited` at the stored rate klend's `refresh_reserve` leaves, twice, refreshing the reserve before each read, and stops unless the second read is the higher, reading again for up to a minute while interest is still below a lamport.
- Alternatives: Reading the yield across the hour of withdraw mode's wait, when the market holds no cTokens and earns nothing; comparing the stored rate alone, which says nothing about the market.
- Specified in: [`docs/spec/lending-pool.md`, Devnet](spec/lending-pool.md#devnet)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87)

### LENDING-98: Pipeline's hosted API on a market that reads Kamino

- Question: What does the devnet demo do with Pipeline's hosted API, when a lending AMM market's quotes read Kamino's reserve, an account of another program?
- Answer: It requires the API to list the demo market, and quotes a buy and a sale within the buffer through it; each quote it gives must equal the program's own on the same state with the same accounts resolved, while a refusal is recorded with the API's answer and does not stop the run.
- Alternatives: Stopping the run on a refusal, which would make our devnet demo depend on Pipeline's API reading other programs' accounts; skipping the API.
- Specified in: [`docs/spec/lending-pool.md`, Devnet](spec/lending-pool.md#devnet)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87)

### LENDING-99: Where the release gates' shared code lives

- Question: Where does the code the buy wall AMM's and the lending AMM's release gates share live?
- Answer: In one host crate, `programs/release-gate`: the gate records the deploy path trusts, the read-only cluster reads, the release declaration and the reading of a failed step's error, which the buy wall AMM's gate re-exports with its behaviour unchanged.
- Alternatives: The lending AMM's gate depending on the buy wall AMM's gate crate; a copy of the code in each gate.
- Specified in: [`docs/spec/lending-pool.md`, A release gate](spec/lending-pool.md#a-release-gate)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87)

### LENDING-100: How the release gate replays a stale Kamino reserve

- Question: How does the release gate replay a market whose Kamino reserve the cluster left stale, with no live oracle in LiteSVM?
- Answer: Each replay marks the reserve's saved price as checked at the snapshot's clock and refreshes it with klend's own `refresh_reserve` before anything else, the same in the deployed build's replay and the candidate's, so both compare on identical state.
- Alternatives: Moving the Pyth account's publish time; copying live oracle accounts, which would differ between the two replays.
- Specified in: [`docs/spec/lending-pool.md`, A release gate](spec/lending-pool.md#a-release-gate)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87)

### LENDING-101: What the release gate runs on each market

- Question: What does the lending AMM's release gate run on each market?
- Answer: Account resolution both ways, quotes both ways at a tenth, a hundredth and a thousandth of the input vault compared with the deployed build's, `pipeline_market_info`, `rebalance` when it is due or the deployed build ran it, a buy and the sale of what it bought, and a sale beyond the buffer that redeems from Kamino, each swap delivering exactly its quote.
- Alternatives: Adding liquidity and every removal (cash, in kind, the lent side alone) as well, which could be added later.
- Specified in: [`docs/spec/lending-pool.md`, A release gate](spec/lending-pool.md#a-release-gate)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87)

### LENDING-102: The release gate's own market

- Question: In what world does the release gate make and trade a market of its own with the candidate?
- Answer: In one holding only the router, klend, the candidate and the lent mints' Kamino accounts with Kamino's stops cleared and a second depositor of 2,500 SOL in each reserve, where it creates a WSOL-lent market of 10 SOL at 30 basis points and rebalances, trades and sells beyond the buffer, every step counting.
- Alternatives: Using the cluster's reserve as it is, where a borrower or an emergency switch on devnet could refuse every candidate, an emergency fix included.
- Specified in: [`docs/spec/lending-pool.md`, A release gate](spec/lending-pool.md#a-release-gate)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87)

### LENDING-103: How the release gate is shown to catch stranding

- Question: How is the lending AMM's release gate shown to refuse a build that would strand a market?
- Answer: A test build that swaps two fields of the market state, listed in `programs/lending-amm/gate/test-builds.json` and built from an edited copy of the source by `scripts/broken-builds.py` beside the fuzzer's broken builds, must be refused on a market holding cTokens, one whose `rebalance` succeeds but lends nothing on its own market and where the deployed build sold beyond the buffer, and the fuzzer's `no-sale-beyond-the-buffer` on every market and on the gate's own.
- Alternatives: A `test-builds` command of the gate's own, as the buy wall AMM's has.
- Specified in: [`docs/spec/lending-pool.md`, A release gate](spec/lending-pool.md#a-release-gate)
- Changes by: spec only
- Status: default
- Decided: 2026-11-22 in [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87)

### LENDING-104: The create form's defaults

- Question: Where do the lending AMM create form's pre-filled LP fee and `lent_index` live, and what are they?
- Answer: An LP fee of 30 bps and `lent_index` 1 (the form takes the token first and the lent mint second), in `terminal-api`'s config module as `LENDING_AMM.create`, which the page reads through `GET /v1/lending-amm/create` and never writes.
- Alternatives: Writing the defaults in the page's own config, which the pages' rule of one place for every value refuses.
- Specified in: [`docs/spec/lending-pool.md`, Aviary's panel](spec/lending-pool.md#aviarys-panel)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)

### LENDING-105: Where the panel is worked out

- Question: Where are the lending AMM panel's figures worked out from the chain?
- Answer: In `terminal-api` (`src/products/lendingAmm/`), from one `getMultipleAccounts` at one slot after a first read of the market state, with the keeper runner's copy of the program's rules, served at `GET /v1/markets/{market}/lending-amm` and shared with the explainer's facts.
- Alternatives: Decoding the generic one-slot read (`PIPESCOPE-146`) in the browser, which would put the program's rules in the page and leave the explainer a copy of its own.
- Specified in: [`docs/spec/lending-pool.md`, Aviary's panel](spec/lending-pool.md#aviarys-panel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)

### LENDING-106: How the largest sells are stated

- Question: How does the panel state the largest sell the buffer pays alone and the largest Kamino can pay on top?
- Answer: As amounts of the other token typed in the trade box (the fees taken on the input counted), each the largest input the program's pricing pays within the edge, found by binary search, and as "every sell the market can take" when no input reaches it; none while the market has no liquidity, the reserve fails its check or is too stale to trade.
- Alternatives: Amounts of the lent mint paid out, which a seller cannot type; a price impact in percent.
- Specified in: [`docs/spec/lending-pool.md`, Aviary's panel](spec/lending-pool.md#aviarys-panel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)

### LENDING-107: Kamino's supply rate on the panel

- Question: Which supply rate does the panel show for the reserve?
- Answer: Kamino's SDK's borrow-interest part of the supply rate at the reserve's stored state: utilisation times the curve's borrow rate there, linear between its points, times one less the protocol take rate, a year, with no projection and without the reward distribution's part.
- Alternatives: The SDK's estimate projected to the current time, or the rate with rewards added.
- Specified in: [`docs/spec/lending-pool.md`, Aviary's panel](spec/lending-pool.md#aviarys-panel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)

### LENDING-108: Kamino's refresh around Aviary's lending forms

- Question: When does Aviary put klend's `refresh_reserve` in a lending AMM action's transaction?
- Answer: First, for a deposit into a market holding cTokens and for `rebalance` (except while Kamino redeems nothing or the lending market's emergency mode is on), as the keeper runner does; and alone, as a form anyone may send, once the reserve is older than half of `TRADE_MAX_RESERVE_AGE_SLOTS`.
- Alternatives: Leaving the refresh to the keeper runner, which fails every deposit into a market holding cTokens made from Aviary while the runner is not running.
- Specified in: [`docs/spec/lending-pool.md`, Aviary's panel](spec/lending-pool.md#aviarys-panel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)

### LENDING-109: The lending AMM's own forms

- Question: Which lending AMM actions does Aviary fill in itself, and what happens to the metadata's forms of them?
- Answer: `add_liquidity`, `remove_liquidity` in cash and in kind, `lock_lp` and `rebalance`, filled in from the panel's read and built from the strategy's metadata, standing in for the metadata's own forms of them; `remove_lent_side` stays a metadata form.
- Alternatives: Showing both, the metadata forms with their raw inputs above Aviary's filled-in ones; filling in `remove_lent_side` too, which is for a frozen or refusing other mint only.
- Specified in: [`docs/spec/lending-pool.md`, Aviary's panel](spec/lending-pool.md#aviarys-panel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)

### LENDING-110: SOL back from a cash removal

- Question: Is the SOL a cash removal pays unwrapped in its transaction?
- Answer: Yes when the wallet holds no wrapped-SOL account of its own, which the removal creates and closes back into the wallet; one the wallet holds keeps what the removal pays, as for every custom action (`PIPESCOPE-145`).
- Alternatives: Always closing the wallet's wrapped-SOL account after the removal, which would also unwrap wrapped SOL the wallet kept for itself.
- Specified in: [`docs/spec/lending-pool.md`, Aviary's panel](spec/lending-pool.md#aviarys-panel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)

### LENDING-111: Where the market's history shows

- Question: Where does Aviary list a lending AMM market's history, and how much at once?
- Answer: In a panel of its own under the lending AMM panel, the strategy's events on the market newest first, each a sentence with who and its transaction, 25 a page (`LENDING_AMM.historyPage`).
- Alternatives: Mixing the strategy's events into the market page's trades table.
- Specified in: [`docs/spec/lending-pool.md`, Aviary's panel](spec/lending-pool.md#aviarys-panel)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)

### LENDING-112: The lending AMM in the explainer's evidence

- Question: What does the explainer's evidence add for a lending AMM version?
- Answer: The sampled market's panel facts, read at one slot when the key is made, and the spec's three risks as fixed text, all F items; the risks alone, and a line saying the panel was not read, when the chain cannot be read.
- Alternatives: Leaving the panel's facts to the model to infer from the vaults, which hold the buffer and not the lent value.
- Specified in: [`docs/spec/lending-pool.md`, Aviary's panel](spec/lending-pool.md#aviarys-panel)
- Changes by: spec only
- Status: default
- Decided: 2026-11-24 in [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88)

## Not decided yet

Open on 2026-11-10; the session that settles each one adds its blocks above.

- [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22): it merges the terminal's spec files and adds a block only if it settles something new.
- Not yet specified on the map: single-use AMMs, Canary results published on-chain as attestations, and Canary calling a strategy's custom instructions.

## Follow-ups

Places where a spec disagrees with a later answer, spreads one value over several places, or fixes in prose something that should be one named value.
They are listed here for the sessions that own those specs, not fixed in this file's PR.

- `LENDING-104` to `LENDING-112`, `PIPESCOPE-162` and `PIPESCOPE-163`: set by the session of [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `LENDING-19`: the owner approved burning LP shares as the way to make liquidity protocol-owned; the spec adds `lock_lp` for that and has a burn hand its value to the remaining LPs, a refinement the owner was not asked about.
- `BAR-18`, `BAR-27`, `POOL4-19`, `LENDING-34`: `README.md` makes the hardening ticket each program's last build ticket, and the owner's answer for the tax AMM and the containment hook puts it after the deploy; the buy wall AMM and the lending AMM harden before their first deploy, a choice of their sessions.
  One order belongs in `README.md`, with a product's departure and its reason in that product's file.
- `SUITE-06`: the map's Notes still give the order set while charting, with the terminal first; `tax-amm.md` says the tax AMM is built first.
- Pipeline's own fee of 0.25% is the router's setting, not ours; Aviary now reads it from the router's config (`PIPESCOPE-91`), but three program specs and the glossary still write it as a fixed number.
- `SUITE-16`, `BAR-02`, `BAR-31`: Pipeline's commit is now pinned once in code, as the `rev` in `programs/Cargo.toml`, and `README.md` (Starting point) names that place; the "Building it" sections of the four program specs still write the commit out.
- `TAX-02`, `LENDING-09`: the launch forms' defaults are stated in the product specs (the tax side's in two sections of `tax-amm.md`) but live in Aviary's forms; `pool4-for-solana.md` says its pre-filled values are kept in one place in the form, and the other two should say the same.
- `TAX-06`, `POOL4-04`: `GLOSSARY.md` gives the suite share and the designer share as fixed tenths, so a change to either constant also has to edit the glossary; it should name the constant, not the number.
- `SUITE-04`, `SUITE-05`, `SUITE-07`, `SUITE-12` to `SUITE-14`: these live only in the map's body; when the map closes they need a home in `docs/spec/README.md`.
- `SUITE-29` to `SUITE-31`: the owner answered these on a ticket that is still open, so "Specified in" names the ticket; the session that closes it points them at wherever the site's own docs record them.
- `LENDING-36`: this lives only in its build ticket; `lending-pool.md` (Devnet) should state it, so it has a home once its ticket closes.
- `BAR-29`, `TAX-22` to `TAX-28`, `HOOK-19` to `HOOK-22`, `POOL4-19` to `POOL4-21`, `LENDING-34` to `LENDING-36`: set by the sessions that cut the build tickets and not yet put to the owner, so they are those sessions' defaults until the owner has been asked.
- `HOOK-23` to `HOOK-27`: set by the session of [Containment hook: bind a token to its home market](https://github.com/imDev2023/testing-pipeline/issues/68) and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `BAR-41`: answered on 2026-11-19 in a question dialog of the session of [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66), which cannot tell whether the owner or the coordinating session answered, so it stays that session's default until the owner confirms it.
- `LENDING-86`: since Pipeline 0.2 dropped the config account from `register_existing_market`, a hooked token's graduation fits a legacy transaction when its shares are locked (1,222 bytes) but not when they go to a wallet (1,254); `lending-pool.md` has the new figures, and the decision's own figures (1,287) are the lending AMM session's to update.
- `BAR-42`, `TAX-53`, `TAX-54`: set by the session of [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `HOOK-30` to `HOOK-34`: set by the session of [Containment hook: unlock by the goal or the deadline](https://github.com/imDev2023/testing-pipeline/issues/70) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `HOOK-42` to `HOOK-46`, `BAR-46`: set by the session of [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74) from its internal adversarial review and listed for the owner on that ticket as the session's own decisions, so they are that session's defaults until the owner or MetalLegBob has reacted.
- `HOOK-35` to `HOOK-37`: set by the session of [Containment hook: invariant fuzzing of contained tokens](https://github.com/imDev2023/testing-pipeline/issues/71) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `TAX-30` to `TAX-34`: set by the session of [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59) and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `BAR-30` to `BAR-37`, `TAX-29`: set by the session of [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58) and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `PIPESCOPE-143` to `PIPESCOPE-147`: set by the session of [Aviary: custom-action forms, the create-market page and a place for product panels](https://github.com/imDev2023/testing-pipeline/issues/123) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked; `PIPESCOPE-141` and `PIPESCOPE-142` are the owner's answers of 2026-11-24 on that ticket.
- `EXPLAINER-23` to `EXPLAINER-28`: set by the session of [Aviary: explainer jobs: the evidence, the validator, the approval queue and the approve command](https://github.com/imDev2023/testing-pipeline/issues/126) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `PIPESCOPE-91`: since Pipeline 0.3 the router's config account holds no swap fee: the fee is a constant of the router, which the SDK mirrors as `PIPELINE_FEE_BPS`, and the explainer's P item reads that constant; the decision should name the SDK's constant, not the config account.
- `LENDING-16`, `POOL4-15`, `SUITE-34`: when each keeper job runs is written in `keeper-runner.md` and again in `lending-pool.md` (When it runs) and `pool4-for-solana.md` (For the keeper runner); `lending-pool.md` still has Aviary's indexer start `rebalance`, which the runner's spec replaced with its own socket.
- `PIPESCOPE-65` to `PIPESCOPE-85`: set by the session of [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16) from a clickable prototype; the owner was asked about `PIPESCOPE-65` to `PIPESCOPE-70`, `PIPESCOPE-73`, `PIPESCOPE-76`, `PIPESCOPE-80` and `PIPESCOPE-82` and told the session to go ahead with its recommended answers without reacting to the screens one by one, and the rest were listed on the prototype's decisions page or follow from other tickets' inputs and were not asked, so all are that session's defaults until the owner or MetalLegBob has reacted.
- `POOL4-22`, `POOL4-23`: set by the session of [Buy wall AMM: a market opens (the program from the template, the fixed-size market state, creation and the seed)](https://github.com/imDev2023/testing-pipeline/issues/47) and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-25` to `POOL4-27`: set by the session of [Buy wall AMM: plain trading through the router](https://github.com/imDev2023/testing-pipeline/issues/48) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked; `POOL4-24` is the owner's answer to that session's question.
- `LENDING-53` to `LENDING-59`: set by the session of [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `LENDING-73` to `LENDING-83`: set by the session of [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83) while building, where the spec left the choice open, and not yet put to the owner, so they are that session's defaults until the owner or MetalLegBob has reacted.
- `POOL4-30`, `POOL4-31`: set by the session of [Buy wall AMM: the inventory cap (the ratchet, the decay credit and the trim)](https://github.com/imDev2023/testing-pipeline/issues/49) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-41` to `POOL4-45`: set by the session of [Buy wall AMM: the release gate and layout fixtures, so no upgrade can strand a market](https://github.com/imDev2023/testing-pipeline/issues/54) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `BAR-43`, `BAR-44`, and the 2026-11-22 changes to `CANARY-34`, `HOOK-35` and `POOL4-47`: set by the session of [Pipeline 0.3: re-pin the router, SDK and pipeline-check, adapt every program and Canary, and check the pin daily](https://github.com/imDev2023/testing-pipeline/issues/194) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-46`, `POOL4-47`, and the changes to `POOL4-41` and `POOL4-44`: set by the session of [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55) to fix review findings H013, H020 and H033 in the release gate, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-51` to `POOL4-53`: set by the session of [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55) to harden the market's clocks (review finding H009), fix review findings H022 and H063 in the handovers and fix review findings H097 and H098 in the release gate, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- The 2026-11-18 changes to `POOL4-44`, `POOL4-46` and `POOL4-53`: set by the session of [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55) to fix findings R2G-01 to R2G-03 of the second internal review of the release gate, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-32` to `POOL4-35`: set by the session of [Buy wall AMM: the buy wall (two-step pricing, the guard and `place_wall`)](https://github.com/imDev2023/testing-pipeline/issues/50) while building, where the spec left the choice open or read two ways, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-36`: set by the session of [Buy wall AMM: a holder can be refused an exit with PriceBoundReached](https://github.com/imDev2023/testing-pipeline/issues/152) from the spec's existing rule that a trade reaching a price bound is refused, and not yet put to the owner, so it is that session's default until the owner has been asked.
- `SUITE-47`: set by the session of [Move the project to a new repository without the old pull request refs, then make it public](https://github.com/imDev2023/testing-pipeline/issues/167) within the move the owner chose (`SUITE-46`), and not yet put to the owner, so it is that session's default until the owner has been asked.
- `MIN_OPENING_SQRT_PRICE` (`pool4-for-solana.md`, Constants) can never refuse a seed: with at least `MIN_SEED_LAMPORTS` (0.1 SOL) and at most 2^64 - 1 token units, the lowest opening square-root price is about 2^45.3, above 2^40; it stays as a guard, and whether the floor on the opening price should be higher, or `MIN_SEED_LAMPORTS` lower, is MetalLegBob's to decide.
- `LENDING-43` to `LENDING-47`: set by the session of [Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78) while building, where the spec left the choice open or the metadata schema at `5ad130d` could not express what the spec first wrote (`LENDING-45`, `LENDING-46`, `LENDING-47`); the owner was not asked, so all are that session's defaults until the owner or MetalLegBob has reacted.
- `PIPESCOPE-86` to `PIPESCOPE-97`, `CANARY-28`, `CANARY-29`, `EXPLAINER-21`: set by the session of [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22) and not yet put to the owner, so they are that session's defaults until the owner has been asked; `CANARY-29` carries a seam that [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23) named.
- `BAR-04`, `BAR-29`, `PIPESCOPE-87`: Pipeline's crates are on crates.io and its SDK on npm since 2026-11-10; the terminal uses the published packages, while the bar still pins the on-chain workspace's crates by git `rev` and the programs' demo scripts link a local SDK build from `scripts/fetch-pipeline.sh`; whether they move to the published packages is for the bar's owner.
- `BAR-40`, `TAX-51`, `TAX-52`: set by the session of [Tax AMM: invariant fuzzing across every instruction](https://github.com/imDev2023/testing-pipeline/issues/65) while building and not yet put to the owner, so they are that session's defaults until the owner or MetalLegBob has reacted.
- `POOL4-54` to `POOL4-56`: set by the session of [Buy wall AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/56) while building and not yet put to the owner, so they are that session's defaults until the owner or MetalLegBob has reacted.
- `SUITE-48`: set by the session of [Progress site: link straight to the public repository](https://github.com/imDev2023/testing-pipeline/issues/186), which read its ticket as every link going to GitHub, and not yet put to the owner, so it is that session's default until the owner has been asked.
- `SUITE-49` to `SUITE-53`: set by the session of [Keeper runner: the runner, its wallet and the tax AMM's `distribute`](https://github.com/imDev2023/testing-pipeline/issues/94) while building and not yet put to the owner, so they are that session's defaults until the owner or MetalLegBob has reacted.
- `SUITE-54` to `SUITE-56`: set by the session of [Keeper runner: the buy wall AMM's four jobs](https://github.com/imDev2023/testing-pipeline/issues/95) while building and not yet put to the owner, so they are that session's defaults until the owner or MetalLegBob has reacted.
- `PIPESCOPE-99` to `PIPESCOPE-103`: set by the session of [Aviary: scaffold both Workers, the database, the page shell with its themes, and the devnet deploy](https://github.com/imDev2023/testing-pipeline/issues/113) while building and not yet put to the owner, so they are that session's defaults until the owner or MetalLegBob has reacted; Devnet help's wallet steps (`apps/terminal-web/src/content/devnet-help.ts`) follow each wallet's help pages of 2026-11-22 and were not tried in the wallets.
- `BAR-45`, `LENDING-97` to `LENDING-103`, the 2026-11-22 change to `LENDING-82` and the 2026-11-23 change to `LENDING-40`: set by the session of [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `SUITE-60`: the lending AMM's `MIN_REBALANCE` of each reserve and its `KAMINO_RATE_HEADROOM_BPS` live in `programs/lending-amm/src/config.rs` and again in `packages/keeper-jobs/lending-amm.ts`, whose tests check the two agree; the program's next release can export them in its IDL, as it does the band, and the copy can go.
- `SUITE-59` to `SUITE-62`: set by the session of [Keeper runner: the lending AMM's `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/96) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `CANARY-47`: the check is the owner's answer 5a on [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74) (`HOOK-50`); its rule, its 1-point threshold and its search were set by that session while building and not yet put to the owner, so they are that session's defaults until the owner or MetalLegBob has reacted.
- `PIPESCOPE-137` to `PIPESCOPE-140`: set by the session of [Aviary: follow-ups found in #118's candles and live rooms](https://github.com/imDev2023/testing-pipeline/issues/214) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-57` to `POOL4-59`, `PIPESCOPE-164`, `PIPESCOPE-165`, `EXPLAINER-29`: set by the session of [Buy wall AMM: Aviary panel and forms](https://github.com/imDev2023/testing-pipeline/issues/57) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked; `POOL4-57`'s IMD values are the spec's.
