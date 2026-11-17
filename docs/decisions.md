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

- **The ID** is a product prefix and a two-digit number.
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
- Answer: In one table, `keeper_runs`, of Aviary's Postgres, written directly from the runner, or in its log when it has no database; a public keeper page in Aviary shows the wallet, today's spend against each cap and every held or parked job.
- Alternatives: None recorded.
- Specified in: [`docs/spec/keeper-runner.md`, What it records](spec/keeper-runner.md#what-it-records)
- Changes by: spec only
- Status: default
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
- Answer: Yes: published from this repo, which is public before the first devnet deploy, with the on-chain workspace under Apache-2.0.
- Alternatives: Business Source License 1.1, as Pipeline's router uses; a public mirror of only the on-chain workspace beside a private monorepo.
- Specified in: [`docs/adr/0002-on-chain-source-public-under-apache-2.md`, Our on-chain source is public under Apache-2.0](adr/0002-on-chain-source-public-under-apache-2.md#our-on-chain-source-is-public-under-apache-20)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4)

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
- Answer: On `StrategyRegistered`, on `MetadataUpdated` and every hour, over `https:` only, at most 64 KB of JSON, with a 5 second timeout and at most 3 redirects, never fetching a URL found inside the document.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-architecture.md`, Metadata fetcher](spec/pipescope-architecture.md#metadata-fetcher)
- Changes by: build-time constant
- Status: default
- Decided: 2026-11-10 in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13)

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
- Answer: From the router's config account, read by `terminal-api` and returned with every quote and on the fees endpoint, so no page, message or check writes it as a number.
- Alternatives: The 0.25% written into the trade box and the Fees page.
- Specified in: [`docs/spec/pipescope-architecture.md`, The integrator fee's configuration](spec/pipescope-architecture.md#the-integrator-fees-configuration)
- Changes by: spec only
- Status: default
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
- Answer: As a test oracle only: the devnet tests compare our trades, candles, trust flags, quotes and unhooked swap transactions with its answers, and our Canary `conformance` result with its hosted checks; its `checks-*` flags are not shown, since Canary's own result says the same thing.
- Alternatives: Serving the feed, charts or wallet page from it, which ADR 0003 ruled out; showing its `checks-*` flags beside Canary's result.
- Specified in: [`docs/spec/pipescope-architecture.md`, Indexer](spec/pipescope-architecture.md#indexer)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

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
- Answer: Its criteria run on Aviary's devnet deployment against devnet data, every page it touches is checked at 1440, 390 and 360 px wide in the light and the dark theme with Playwright screenshots in the PR, and CI runs the same tests on recorded devnet fixtures with no network.
- Alternatives: Local runs only; CI against live devnet, which would spend Aviary's RPC credits and fail when devnet does.
- Specified in: [`docs/spec/pipescope-architecture.md`, Build tickets](spec/pipescope-architecture.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

### PIPESCOPE-97: Where the keeper page lives

- Question: Where in Aviary is the keeper runner's public page?
- Answer: At `/keeper`, read-only, linked from every page's footer beside Fees and Devnet help, and from each product panel's due keeper jobs.
- Alternatives: A page reached only from the product panels.
- Specified in: [`docs/spec/pipescope-architecture.md`, Build tickets](spec/pipescope-architecture.md#build-tickets)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)

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
- Answer: Sixteen, with stable ids: `readable`, `conformance`, `exit_sizes`, `exit_hold`, `exit_late`, `exit_launch_clock`, `exit_wallets`, `exit_transferred`, `exit_queue`, `quote_matches_swap`, `cost`, `direct_call`, `token_authorities`, `transaction_accounts`, `contained_mint` and `custom_instructions`.
- Alternatives: None recorded.
- Specified in: [`docs/spec/pipescope-canary.md`, The checks](spec/pipescope-canary.md#the-checks)
- Changes by: spec only
- Status: default
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
- Answer: From what the router charged in the copy, the `pipeline_fee` of each swap's return data, with the sale's fee (charged in the token) valued at the sale's own price; no fee rate is written in Canary.
- Alternatives: The fee rate of `pipeline-strategy-interface` (`PIPELINE_FEE_BPS`), which would hide a router that charged differently.
- Specified in: [the ticket, Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)
- Changes by: spec only
- Status: default
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
- Answer: Those a trader can meet: a paused router, a trader account that is not a token account of its mint, and every refusal of Pipeline's settlement code, named in that code's words since the router's error numbers are not published under Apache-2.0; any refusal undoes the swap, and the strategy runs one call level higher than under the router.
- Alternatives: Settling without the router's rules, so a paused router would look tradable.
- Specified in: [`docs/spec/pipescope-canary.md`, Built on](spec/pipescope-canary.md#built-on)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's control checks, token authorities acting, and transfer-hook accounts](https://github.com/imDev2023/testing-pipeline/issues/115)

### CANARY-46: The instruction list in the snapshot

- Question: How does `custom_instructions` get the list `terminal-api` works out, and what does it do without one?
- Answer: The snapshot's optional `instructions` field carries whether the program is built with Anchor and each instruction's name, call count and signers; Canary drops Pipeline's six by name, notes the rest, and records "not run" when the field is absent.
- Alternatives: The binary working the list out from the program's bytes, which `PIPESCOPE-92` rules out.
- Specified in: [`docs/spec/pipescope-canary.md`, Custom instructions are listed, not called](spec/pipescope-canary.md#custom-instructions-are-listed-not-called)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Aviary: Canary's control checks, token authorities acting, and transfer-hook accounts](https://github.com/imDev2023/testing-pipeline/issues/115)

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
- Answer: Only its optional tax authority, which may move the rates inside their fixed ranges, change the recipients and renounce, each taking effect at once; nobody else can change anything about a market, us included, and the program has no admin.
- Alternatives: Moving the tax authority to another address.
- Specified in: [`docs/spec/tax-amm.md`, Tax authority](spec/tax-amm.md#tax-authority)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

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
- Answer: SPL Token mints, and Token-2022 mints carrying only extensions on an allowlist (transfer hook, metadata pointer, token metadata, group pointer, group member pointer, token group and token group member); every other extension is refused at creation, while mint and freeze authorities are allowed.
- Alternatives: Allowing more extensions, which would admit quote mints such as PYUSD.
- Specified in: [`docs/spec/tax-amm.md`, Mint rules](spec/tax-amm.md#mint-rules)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19)

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

- Question: May `set_recipients` empty a recipient slot that is still owed tax?
- Answer: No: it refuses with `OwedSlotLeftEmpty`, so every owed amount always has a wallet or the burn to go to; the slot can be handed to another wallet instead, or paid out first, and the burn share may still drop to 0 since the burn needs no wallet.
- Alternatives: Allowing it, which would strand the owed amount in the vault for good once the authority renounced; moving the owed amount to another slot, which would make `set_recipients` change owed amounts, which none of the tax authority's actions does.
- Specified in: [`docs/spec/tax-amm.md`, Tax authority](spec/tax-amm.md#tax-authority)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-12 in [Tax AMM: the tax authority](https://github.com/imDev2023/testing-pipeline/issues/62)

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
- Answer: Every wallet's whole holding of either mint quotes, or is refused as dust or, only on a market with a virtual reserve, because the curve would pay out more than the real reserve, in which case the largest sale the real reserve covers must quote; every sequence ends with every wallet selling all it holds, and each sale settles unless the spec refuses it.
- Alternatives: Requiring every whole holding to sell, which a single-sided launch refuses by design; checking quotes only, which would miss a swap that fails after its quote.
- Specified in: [`docs/spec/tax-amm.md`, Invariants](spec/tax-amm.md#invariants)
- Changes by: spec only
- Status: default
- Decided: 2026-11-12 in [Tax AMM: invariant fuzzing across every instruction](https://github.com/imDev2023/testing-pipeline/issues/65)

## Containment hook (HOOK)

### HOOK-01: Transfers while contained

- Question: Where may a contained token move?
- Answer: Only into or out of its home market's vault or that market's Pipeline fee account; every wallet-to-wallet transfer is refused, including between a holder's own wallets and to a CEX deposit address.
- Alternatives: Wallet-to-wallet transfers between keypair wallets signed by their owner.
- Specified in: [`docs/spec/containment-hook.md`, The allow rule](spec/containment-hook.md#the-allow-rule)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-02: Integrator fees on sells

- Question: Can an integrator charge a fee on a sell of a contained token?
- Answer: No: no integrator fee account is allowed, so integrators pass a zero fee on sells; buys pay their integrator fee in the quote mint as usual.
- Alternatives: A launcher-set list of integrator fee accounts allowed as destinations.
- Specified in: [`docs/spec/containment-hook.md`, What this refuses](spec/containment-hook.md#what-this-refuses)
- Changes by: fixed on-chain once deployed
- Status: default
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
- Answer: It clears both the transfer hook program and the hook authority, so the token becomes an ordinary Token-2022 token, and records the unlock time in a config that is never closed.
- Alternatives: None recorded.
- Specified in: [`docs/spec/containment-hook.md`, Unlock (`unlock`)](spec/containment-hook.md#unlock-unlock)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-12: Mint rules at binding

- Question: Which mints can be contained?
- Answer: Token-2022 mints whose only extensions are on the tax AMM's allowlist and whose freeze authority is unset; the mint authority may stay set.
- Alternatives: Allowing a freeze authority, as the tax AMM does.
- Specified in: [`docs/spec/containment-hook.md`, Checks on the mint](spec/containment-hook.md#checks-on-the-mint)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

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
- Answer: A panel on the home market's page (that the token is contained, the tax collected against the goal, the deadline), an Unlock button once the unlock is due, and the one-line rule in the trade box before a buy, built into Aviary since the hook has no strategy metadata.
- Alternatives: None recorded.
- Specified in: [`docs/spec/containment-hook.md`, In Aviary](spec/containment-hook.md#in-aviary)
- Changes by: spec only
- Status: default
- Decided: 2026-11-10 in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18)

### HOOK-18: Invariants

- Question: Which invariants does the hook's fuzzing check?
- Answer: Five beyond the shared three: no transfer between two accounts outside the home vault and the fee account, refusal when a hook account is missing or substituted, an unchanging config, `unlock` succeeding exactly when due, and every holder still able to exit through the home market.
- Alternatives: None recorded.
- Specified in: [`docs/spec/containment-hook.md`, Invariants](spec/containment-hook.md#invariants)
- Changes by: spec only
- Status: default
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
- Answer: No: a market state at the recorded address that can no longer be read as the tax AMM's (another owner, another size or discriminator, or closed) counts as the goal not reached, so the deadline still unlocks; before the deadline such a market state is refused with `NotATaxMarketState`.
- Alternatives: Refusing every unlock whose market state cannot be read, which would trap holders for good if a tax AMM upgrade changed the account, the case the deadline exists for.
- Specified in: [`docs/spec/containment-hook.md`, Unlock (`unlock`)](spec/containment-hook.md#unlock-unlock)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-16 in [Containment hook: unlock by the goal or the deadline](https://github.com/imDev2023/testing-pipeline/issues/70)

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
- Answer: By IMD's guard: the wall's floor drops at once with the price and rises about 4% a day (`FLOOR_CRAWL_BPS`) toward a reference that follows the price by at most 2% per 12 seconds (`REF_STEP_BPS`, `REF_STEP_WINDOW`).
- Alternatives: Refusing to place the wall when the price is far above a reference.
- Specified in: [`docs/spec/pool4-for-solana.md`, Constants](spec/pool4-for-solana.md#constants)
- Changes by: build-time constant
- Status: default
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
- Answer: The token against wrapped SOL only, with the token's mint and freeze authorities removed by the time of the seed and only the tax AMM's allowlist of Token-2022 extensions.
- Alternatives: Allowing mint and freeze authorities, as the tax AMM does; other quote mints.
- Specified in: [`docs/spec/pool4-for-solana.md`, Mint rules](spec/pool4-for-solana.md#mint-rules)
- Changes by: fixed on-chain once deployed
- Status: default
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
- Answer: On every swap, as step 4 of "After pricing" reads ("Then `floor_time = now`"), so the floor crawls only by the time since the last swap and never by a whole day at once when the reference first rises above it after a quiet spell.
- Alternatives: Only when the floor crawls, which would let a floor that sat at the reference for a long time jump a full day's crawl on the first swap after the reference moved up.
- Specified in: [`docs/spec/pool4-for-solana.md`, After pricing](spec/pool4-for-solana.md#after-pricing)
- Changes by: fixed on-chain once deployed
- Status: default
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
- Answer: From edited copies of the workspace, built in a target directory of their own, never from features in the program's source: a moved field, the market state type renamed with its discriminator left to Anchor and an account 8 bytes larger, each refused on every open market, a payout rule narrowed so fee slot 2 can no longer be swept, refused on every market the deployed build swept it on, and a field appended into the reserve as layout version 2, passed, on every fixture in CI.
- Alternatives: The earlier default, the same without the narrowed payout rule, which proved nothing about keeper jobs; Cargo features that switch layouts in `state.rs`, which would put stranding layouts into the audited source.
- Specified in: [`docs/spec/pool4-for-solana.md`, Fixtures in CI](spec/pool4-for-solana.md#fixtures-in-ci)
- Changes by: spec only
- Status: changed 2026-11-16
- Decided: 2026-11-16 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

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
- Answer: A failed step counts unless the deployed build failed the same step, matched by kind and not by name, on the same snapshot with the failure starting in the same program, as recorded in the snapshot when it is taken (so fixtures compare without the deployed program); the layout checks (reading the market state, finding the market, account resolution, the quotes and `pipeline_market_info`) always run and always count, both replays sign with the same keys derived from the market, and the failures that do not count are printed and recorded with the pass.
- Alternatives: The earlier default, every step must pass, which any market whose token's hook refuses the gate's trader or whose fee recipient made its account unpayable vetoes forever, for every build; excusing a shared failure whatever program it starts in, which would let a candidate fail in its own code where the deployed build failed in a hook; running the deployed build again at check time, which fixtures cannot, since they carry no programs.
- Specified in: [`docs/spec/pool4-for-solana.md`, A release gate](spec/pool4-for-solana.md#a-release-gate)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-47: Markets the router has not recorded

- Question: What does the gate do with a market state the router has no Market for, or a market missing a router fee account?
- Answer: The snapshot copies such a market as if the router had recorded what `pipeline_market_info` gives and saves it marked unregistered, and the replay registers it with the router's `register_existing_market` and `init_fee_account` for both mints, and creates any missing fee account of a recorded market, as anyone may, then checks it like the rest.
- Alternatives: The earlier behaviour, aborting the whole run, which let anyone block every upgrade with one direct `pipeline_seed_liquidity` call; leaving such markets out of the check, which would not check them at all.
- Specified in: [`docs/spec/pool4-for-solana.md`, A release gate](spec/pool4-for-solana.md#a-release-gate)
- Changes by: spec only
- Status: default
- Decided: 2026-11-16 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

### POOL4-49: Which retired tokens earn the reward share

- Question: Which retired tokens earn the reward share, now that a rewards recipient can retire tokens itself by washing a buy against the decay credit, selling a dip into a tight cap or selling into the wall and closing it, all in one transaction?
- Answer: Only trimmed tokens matched by the cap's own fall: the ratchet adds every unit the cap falls to `cap_fall_unmatched`, a trim moves `min(trimmed tokens, cap_fall_unmatched)` from it into `retired_rewardable`, and `settle` pays `floor(retired_rewardable x reward_share_bps / 10,000)` and burns the rest of `retired_tokens`, so the rest of a trim, the tokens a closed wall bought and `place_wall`'s dust burn whole and the rewards never exceed `reward_share_bps` of `seeded_tokens - cap_floor`.
- Alternatives: The earlier rule, in which every retired token earned the reward share; lagging the ratchet by a slot so a same-transaction round trip never trims; paying no reward share on trims; accepting the behaviour and disclosing it.
- Specified in: [`docs/spec/pool4-for-solana.md`, After pricing](spec/pool4-for-solana.md#after-pricing)
- Changes by: fixed on-chain once deployed
- Status: default
- Decided: 2026-11-17 in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55)

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
- Answer: It enters withdraw mode when Kamino's free liquidity is below 5 times (`WITHDRAW_MODE_ENTER`) what the market lends or would lend, redeeming all it can and depositing nothing, and leaves it above 10 times (`WITHDRAW_MODE_EXIT`).
- Alternatives: Doing nothing beyond the buffer and in-swap redeems; a fixed utilisation threshold such as 95%.
- Specified in: [`docs/spec/lending-pool.md`, Constants](spec/lending-pool.md#constants)
- Changes by: build-time constant
- Status: default
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
- Answer: At the rate stored in Kamino's reserve account, everywhere, with no projection to the current slot.
- Alternatives: Projecting the rate to the current slot, which would copy Kamino's interest maths into our program.
- Specified in: [`docs/spec/lending-pool.md`, The stored rate, everywhere](spec/lending-pool.md#the-stored-rate-everywhere)
- Changes by: fixed on-chain once deployed
- Status: default
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
- Answer: Every instruction that reads the reserve checks its address, owner, size, discriminator, lending market and mints first, and refuses rather than misprices; removing liquidity in kind never reads it, so a Kamino change can stop trading but never trap LPs.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Checking the reserve before reading it](spec/lending-pool.md#checking-the-reserve-before-reading-it)
- Changes by: fixed on-chain once deployed
- Status: default
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
- Answer: No: it reads Kamino's state at each call, trading from the buffer alone under emergency mode or a deprecated reserve, skipping deposits when cToken use is blocked, and always letting LPs leave in kind.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, When Kamino can't pay](spec/lending-pool.md#when-kamino-cant-pay)
- Changes by: fixed on-chain once deployed
- Status: default
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
- Answer: From 20,000 units for `lock_lp` to 200,000 for `pipeline_seed_liquidity`, with 40,000 for a swap without a redeem and 80,000 with one; the build may lower a ceiling, and raising one needs a written reason.
- Alternatives: None recorded.
- Specified in: [`docs/spec/lending-pool.md`, Compute ceilings](spec/lending-pool.md#compute-ceilings)
- Changes by: build-time constant
- Status: default
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
- Answer: 600 seconds, because devnet's Pyth feeds were seen updating about every 5 minutes on 2026-11-10; Kamino's mainnet SOL and USDC reserves accept 120 and 180 seconds.
- Alternatives: Kamino's mainnet ages, which would refuse a borrow for much of each 5-minute cycle; posting fresh Pyth prices ourselves before each borrow.
- Specified in: [`docs/spec/lending-pool.md`, Devnet](spec/lending-pool.md#devnet)
- Changes by: runtime setting
- Status: default
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

## Not decided yet

Open on 2026-11-10; the session that settles each one adds its blocks above.

- [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22): it merges the terminal's spec files and adds a block only if it settles something new.
- Not yet specified on the map: single-use AMMs, Canary results published on-chain as attestations, and Canary calling a strategy's custom instructions.

## Follow-ups

Places where a spec disagrees with a later answer, spreads one value over several places, or fixes in prose something that should be one named value.
They are listed here for the sessions that own those specs, not fixed in this file's PR.

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
- `HOOK-30` to `HOOK-34`: set by the session of [Containment hook: unlock by the goal or the deadline](https://github.com/imDev2023/testing-pipeline/issues/70) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `TAX-30` to `TAX-34`: set by the session of [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59) and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `BAR-30` to `BAR-37`, `TAX-29`: set by the session of [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58) and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `LENDING-16`, `POOL4-15`, `SUITE-34`: when each keeper job runs is written in `keeper-runner.md` and again in `lending-pool.md` (When it runs) and `pool4-for-solana.md` (For the keeper runner); `lending-pool.md` still has Aviary's indexer start `rebalance`, which the runner's spec replaced with its own socket.
- `PIPESCOPE-65` to `PIPESCOPE-85`: set by the session of [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16) from a clickable prototype; the owner was asked about `PIPESCOPE-65` to `PIPESCOPE-70`, `PIPESCOPE-73`, `PIPESCOPE-76`, `PIPESCOPE-80` and `PIPESCOPE-82` and told the session to go ahead with its recommended answers without reacting to the screens one by one, and the rest were listed on the prototype's decisions page or follow from other tickets' inputs and were not asked, so all are that session's defaults until the owner or MetalLegBob has reacted.
- `POOL4-22`, `POOL4-23`: set by the session of [Buy wall AMM: a market opens (the program from the template, the fixed-size market state, creation and the seed)](https://github.com/imDev2023/testing-pipeline/issues/47) and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-25` to `POOL4-27`: set by the session of [Buy wall AMM: plain trading through the router](https://github.com/imDev2023/testing-pipeline/issues/48) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked; `POOL4-24` is the owner's answer to that session's question.
- `LENDING-53` to `LENDING-59`: set by the session of [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-30`, `POOL4-31`: set by the session of [Buy wall AMM: the inventory cap (the ratchet, the decay credit and the trim)](https://github.com/imDev2023/testing-pipeline/issues/49) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-41` to `POOL4-45`: set by the session of [Buy wall AMM: the release gate and layout fixtures, so no upgrade can strand a market](https://github.com/imDev2023/testing-pipeline/issues/54) while building, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-46`, `POOL4-47`, and the changes to `POOL4-41` and `POOL4-44`: set by the session of [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55) to fix audit findings H013, H020 and H033 in the release gate, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-32` to `POOL4-35`: set by the session of [Buy wall AMM: the buy wall (two-step pricing, the guard and `place_wall`)](https://github.com/imDev2023/testing-pipeline/issues/50) while building, where the spec left the choice open or read two ways, and not yet put to the owner, so they are that session's defaults until the owner has been asked.
- `POOL4-36`: set by the session of [Buy wall AMM: a holder can be refused an exit with PriceBoundReached](https://github.com/imDev2023/testing-pipeline/issues/152) from the spec's existing rule that a trade reaching a price bound is refused, and not yet put to the owner, so it is that session's default until the owner has been asked.
- `MIN_OPENING_SQRT_PRICE` (`pool4-for-solana.md`, Constants) can never refuse a seed: with at least `MIN_SEED_LAMPORTS` (0.1 SOL) and at most 2^64 - 1 token units, the lowest opening square-root price is about 2^45.3, above 2^40; it stays as a guard, and whether the floor on the opening price should be higher, or `MIN_SEED_LAMPORTS` lower, is MetalLegBob's to decide.
- `LENDING-43` to `LENDING-47`: set by the session of [Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78) while building, where the spec left the choice open or the metadata schema at `5ad130d` could not express what the spec first wrote (`LENDING-45`, `LENDING-46`, `LENDING-47`); the owner was not asked, so all are that session's defaults until the owner or MetalLegBob has reacted.
- `PIPESCOPE-86` to `PIPESCOPE-97`, `CANARY-28`, `CANARY-29`, `EXPLAINER-21`: set by the session of [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22) and not yet put to the owner, so they are that session's defaults until the owner has been asked; `CANARY-29` carries a seam that [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23) named.
- `BAR-04`, `BAR-29`, `PIPESCOPE-87`: Pipeline's crates are on crates.io and its SDK on npm since 2026-11-10; the terminal uses the published packages, while the bar still pins the on-chain workspace's crates by git `rev` and the programs' demo scripts link a local SDK build from `scripts/fetch-pipeline.sh`; whether they move to the published packages is for the bar's owner.
- `BAR-40`, `TAX-51`, `TAX-52`: set by the session of [Tax AMM: invariant fuzzing across every instruction](https://github.com/imDev2023/testing-pipeline/issues/65) while building and not yet put to the owner, so they are that session's defaults until the owner or MetalLegBob has reacted.
