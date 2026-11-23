# Keeper runner

Decided with the owner in [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45) on 2026-11-10.
It builds on the keeper jobs of [`pool4-for-solana.md`](pool4-for-solana.md) (the buy wall AMM, "Keeper jobs"), [`lending-pool.md`](lending-pool.md) (the lending AMM, "When it runs") and [`tax-amm.md`](tax-amm.md) ("Payout"), and on Aviary's architecture in [`pipescope-architecture.md`](pipescope-architecture.md).
Terms are as in `GLOSSARY.md`: keeper job, keeper runner, keeper wallet, keeper tip.
Like every decision in this spec, each one here is a default MetalLegBob may change.

## What it is

- The keeper runner is one Node program in this repo, `apps/keeper`, that calls every keeper job of every market of our strategies when it is due, and pays for it from the keeper wallet.
- On devnet it runs on the owner's Mac as a launchd agent, reading the keeper wallet's key from `~/.config/testing-pipeline/devnet/keeper.json`.
- Nothing of it runs on the owner's Cloudflare account (owner, 2026-11-10): the work is for MetalLegBob, so it must cost the owner nothing.
  Aviary itself stays on Cloudflare as [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13) decided; only the keeper runner, the one part that holds a hot key and spends SOL, lives elsewhere.
- It is portable: a Docker image and a README let MetalLegBob, or anyone, run it on their own machine with their own key, since every keeper job is permissionless.
- When the Mac sleeps or is off, jobs wait.
  Nothing breaks meanwhile: swaps keep working, a lending AMM swap redeems its own shortfall from Kamino, payouts only arrive later, and Aviary's panels show every due job as a button anyone can press.

## The jobs

| Product | Job | Due when | How the runner learns it |
| --- | --- | --- | --- |
| Buy wall AMM | `place_wall` | `idle_sol` or the wall's `converted` reaches `WALL_THRESHOLD` | After each transaction on the market, and in every sweep |
| Buy wall AMM | `settle` | `retired_tokens` above 0, at most once an hour per market | The hourly pass |
| Buy wall AMM | `pay_rewards` | `rewards_owed` above 0 | The daily pass |
| Buy wall AMM | `sweep_fees { slot }` | A slot's ledger above 0; slot 1 only once `DESIGNER_RECIPIENT` is set | The daily pass, one transaction per slot |
| Lending AMM | `rebalance` | The program would act: the buffer outside its band by at least `MIN_REBALANCE`, the market entering or leaving withdraw mode or redeeming in it, or a sighting of the exit threshold to record or forget ([`SUITE-60`](../decisions.md#suite-60-keeper-runner-when-the-lending-amms-rebalance-is-due)) | After each transaction on the market, and the 10-minute sweep |
| Lending AMM | klend's `refresh_reserve` | The market holds cTokens and its reserve was last refreshed more than half of `TRADE_MAX_RESERVE_AGE_SLOTS` ago, unless the lending market's emergency mode is on ([`SUITE-61`](../decisions.md#suite-61-keeper-runner-refreshing-the-lending-amms-reserves)) | After each transaction on the market, and the 10-minute sweep |
| Tax AMM | `distribute { slot }` | A slot is owed more than 0 (the burn slot included) | The daily pass, one transaction per slot |

- The containment hook's `unlock` has no keeper job in v1, as [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18) decided: anyone who wants it presses Aviary's Unlock button.
- A job a later product adds joins this table and the jobs package below; the runner itself does not change.
- The lending AMM's spec says the runner acts when Aviary's indexer sees a market leave its band; the runner watches the chain itself instead (see "Triggers"), which gives the same result without tying it to Aviary.

### One definition of due

- Each job's due rule is a pure function of the market state in one shared package, `packages/keeper-jobs`, with the instruction builder for that job.
- A due rule that needs more than the market state names the accounts it reads in its product's entry (`watches`), and the runner reads them with the market in one `getMultipleAccounts`, so the rule sees one moment of the chain: the lending AMM's entry reads the market's Kamino reserve, its lending market and the clock sysvar, since withdraw mode and the reserve's age depend on them ([`SUITE-59`](../decisions.md#suite-59-keeper-runner-accounts-a-due-rule-reads-beyond-the-market)).
- The keeper runner and Aviary's panels both use it, so a button shows in Aviary exactly when the runner would act.
- Each product's package entry also names the refusal codes that mean "nothing to do" (for example the lending AMM's `WithinBand`, or a payout with nothing owed), which the runner treats as a skip, not a failure.
- A program that succeeds without effect when there is nothing to do, rather than refusing, says so in its entry instead: the tax AMM's `distribute` on a slot owed nothing succeeds and moves nothing ([`TAX-43`](../decisions.md#tax-43-which-tax-slots-distribute-pays)), so its entry has no "nothing to do" code and counts a simulation that emits no `Distributed` event as nothing to do ([`SUITE-50`](../decisions.md#suite-50-keeper-runner-nothing-to-do-when-a-program-does-not-refuse)).
- A refusal code counts as either only when the product's own program refused: the same number from another program in the transaction (klend's in the lending AMM's `refresh_reserve`, a token program's) is a failure like any other ([`SUITE-62`](../decisions.md#suite-62-keeper-runner-whose-refusal-codes-count)).
- It also names the refusal codes that mean "try again in a later slot", which the runner retries from the next slot, never counting them as a failure: the buy wall AMM's `SwapThisSlot`, which refuses `place_wall` in a slot a swap already ran in ([`POOL4-50`](../decisions.md#pool4-50-when-the-walls-floor-moves); a market with a swap in every slot can starve it, the Low residual R2-03 the owner signed off).

## Which markets

- Every market of our strategies on devnet, including markets other people create, within the spending caps.
- The runner finds them with `getProgramAccounts` on each of our strategy programs when it starts and in every 10-minute sweep, and adds a market as soon as a transaction names one it does not know.
- The per-market daily cap is what stops anyone from making us pay for many markets with fresh recipients (see "Spending caps").

## Triggers

- **Its own socket**: one `logsSubscribe` subscription per strategy program of ours, held open while the runner runs; a notification makes the runner fetch that transaction, find which of our markets it touched, re-read their market states and check `place_wall` and `rebalance`.
  The socket reconnects on its own, and every reconnect runs a sweep so nothing between is missed.
- **The 10-minute sweep**: re-reads every known market's state in batches of 100 with `getMultipleAccounts` and checks `place_wall` and `rebalance`; this also catches withdraw mode, which depends on Kamino's state rather than our market's.
- **The hourly pass**: `settle`, at most once every `SETTLE_INTERVAL` on each market, a restart included: the runner learns when each job of the hourly pass last ran on each market from the keeper wallet's own successful transactions of the last `SETTLE_INTERVAL`, each job known by its instruction's discriminator in `packages/keeper-jobs`, and holds it back in every pass until the interval is up ([`SUITE-56`](../decisions.md#suite-56-keeper-runner-settle-at-most-hourly-across-a-restart)).
- **The daily pass** at `DAILY_PASS_UTC`: `pay_rewards`, `sweep_fees` and `distribute`.
- **On start**: one full pass of every job, since the Mac may have slept through any of the above; paying out again after a restart costs only transaction fees, because each payout pays the whole amount owed and the next one finds nothing.
- The runner reads only the chain; it never polls Aviary's database (see "What it records").

## RPC

- Alchemy's free devnet endpoint, from `ALCHEMY_API_KEY` in the owner's `~/.config/env/global.env`, so the runner's load stays off both Aviary's own Helius key (budgeted at about 500,000 of its 1 million free credits) and the owner's shared Helius key (already rate-limited when several sessions run).
- The HTTP and WebSocket URLs are the settings `KEEPER_RPC_URL` and `KEEPER_WS_URL`; their defaults are built from `ALCHEMY_API_KEY`.
- The first build ticket checks that Alchemy's devnet WebSocket serves `logsSubscribe`; if it does not, the socket uses Aviary's Helius key and HTTP stays on Alchemy, and the ticket records which.
- It does not: on 2026-11-20 ([the first build ticket](https://github.com/imDev2023/testing-pipeline/issues/94)) Alchemy's free devnet WebSocket answered `logsSubscribe` with `Method 'logsSubscribe' not found`, and its free tier refuses `getProgramAccounts` too (`getProgramAccounts is not available on the Free tier`), which finding the markets needs.
  So the socket and market discovery go to Aviary's Helius key, once the project's `.env` has it as `RPC_URL` ([Aviary: owner setup](https://github.com/imDev2023/testing-pipeline/issues/110)), and until then to Solana's public devnet endpoint, which serves both free and without a key; reads, simulations and sends stay on Alchemy ([`SUITE-49`](../decisions.md#suite-49-keeper-runner-the-socket-and-discovery-off-alchemy)).
  Discovery has its own setting, `DISCOVERY_RPC_URL`, beside `RPC_URL` and `WS_URL`.
- No paid tier: if the free tier runs out, the runner slows its sweeps rather than spending.

## Sending a job

1. Build the job's transaction from `packages/keeper-jobs`, with the keeper wallet as fee payer and, for `place_wall`, the keeper wallet's wrapped-SOL account as the tip account (created in the same transaction if missing).
   A buy wall market's token never has a live transfer hook (the seed refuses one, `POOL4-48`), so its `pay_rewards` needs no hook accounts.
2. Simulate it.
   A "nothing to do" refusal is a skip and costs nothing; a "try again in a later slot" refusal is sent again from a later slot and costs nothing; any other simulation error counts as a failure (below).
   The same holds for a job that passed simulation and then lands refused with a "try again in a later slot" code, as `place_wall` does when a swap reaches the slot first: it costs that transaction's fee, is sent again from a later slot, and is not a failure.
3. Estimate its cost (the fee plus the rent of any account it creates) and check it against every cap; a job over a cap is held, not sent.
   The estimate is what the simulation takes from the keeper wallet: its balance before, less its balance in the simulation's result, which has the fee taken ([`SUITE-51`](../decisions.md#suite-51-keeper-runner-what-a-job-costs)).
4. Send it at `PRIORITY_FEE_MICROLAMPORTS` (0 on devnet) and wait for confirmation.
- A payout that would create its recipient's token account waits until what it pays is worth that account's rent: the job's entry in `packages/keeper-jobs` gives the reason, the runner skips it at no cost and checks again in its next pass, and a payout into an account that exists goes whatever it pays; a buy wall market's rewards are valued at the market's price ([`SUITE-54`](../decisions.md#suite-54-keeper-runner-a-payout-into-an-account-it-would-create)).
- One job is sent at a time, so two jobs never race each other or count the same cap headroom twice.
- Another keeper running the same job first is harmless: the second simulation finds nothing to do.

### Failures

- A failed job is retried after 30 seconds, 2 minutes and 10 minutes (`RETRY_DELAYS`).
- After the last retry the job is parked: the runner leaves that job on that market alone until the market's state changes, and records the park with the last error.
- Only the job's own failure counts: a simulation or a landed transaction refused with any code but a "nothing to do" or "try again in a later slot" one, or an instruction that cannot be built.
  When the RPC cannot be asked (a transport error, a timeout, a send that never lands before its blockhash expires) the job is not counted as failed and is due again in the next pass, so an RPC outage never parks a job that would succeed ([`SUITE-52`](../decisions.md#suite-52-keeper-runner-when-the-rpc-fails)).
- A parked job still shows as due in Aviary, with its button, so anyone can press it.

### When the wallet runs low or a cap is reached

- Below `LOW_BALANCE` the runner keeps working and records a low-balance warning in every pass.
- Below `MIN_BALANCE`, or once a cap is reached, it sends no job (for the day, or for that market) and records why; Aviary's keeper page shows it.
  It still unwraps its tips, which lifts the balance (see "Keeper tips").
- The runner never funds itself.
  The keeper wallet is topped up only with `devnet-airdrop ~/.config/testing-pipeline/devnet/keeper.json --target 2`, run by the owner or an agent session in the background, as the owner's global rules say for every devnet wallet.

## The keeper wallet

- A new key made only for the runner, `~/.config/testing-pipeline/devnet/keeper.json`, by the first build ticket with `solana-keygen new`.
- It is not `wallet.json` (the deploy wallet) or `upgrade-authority.json`, so a leaked keeper key loses only its float and controls nothing.
- The key lives only in that file on the owner's Mac: never in the repo, the Docker image, a Worker, a GitHub secret or a log.
  The path is the setting `KEEPER_KEYPAIR`, so someone else's copy points at their own key; the Docker image takes it as a read-only mount.
- Its public address is published (here, and in Aviary's keeper page), so anyone can see what it spends: `8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2`, made on 2026-11-20 by [the first build ticket](https://github.com/imDev2023/testing-pipeline/issues/94).
- Its float is kept at `FLOAT_TARGET` (2 SOL) by `devnet-airdrop`.

### Keeper tips

- The buy wall AMM's `place_wall` is the only job that pays a keeper tip, into the keeper wallet's wrapped-SOL account.
- The runner keeps its tips: once that account holds more than `TIP_UNWRAP_AT`, the end of the pass closes the account to unwrap them into the float (the account's rent comes back too), and the next `place_wall` recreates it.
- No cap and not `MIN_BALANCE` hold the unwrap, since it returns far more than its fee; the fee still counts in today's spend ([`SUITE-55`](../decisions.md#suite-55-keeper-runner-unwrapping-tips-under-the-caps)).
- `place_wall` pays for itself: at the lowest fee (0.25%) on the smallest work (`WALL_THRESHOLD`, 0.01 SOL) the tip is at least 25,000 lamports, five times the 5,000-lamport transaction fee.
- The other jobs pay no tip, so their fees and any recipient token accounts they create come out of the float.
- Caps count what the runner spends, never net of tips.

## Spending caps

All the runner's policy values live in one module, `apps/keeper/src/settings.ts`, each one overridable by an environment variable of the same name prefixed `KEEPER_`; no other file repeats a value.
The runner logs the values it started with.
A `KEEPER_` variable that names no setting stops the runner at start, so a misspelt override never leaves a default in force ([`SUITE-53`](../decisions.md#suite-53-keeper-runner-a-misspelt-setting)).

| Setting | Default | What it limits |
| --- | --- | --- |
| `FLOAT_TARGET` | 2 SOL | The balance `devnet-airdrop` tops the keeper wallet up to |
| `LOW_BALANCE` | 0.5 SOL | Below it, every pass records a low-balance warning |
| `MIN_BALANCE` | 0.1 SOL | Below it, the runner sends nothing |
| `MAX_TX_COST` | 0.003 SOL | The most one transaction may cost: the fee plus the rent of one new token account (2,039,280 lamports for a plain one) |
| `MARKET_DAILY_CAP` | 0.01 SOL | The most the runner spends on one market in a UTC day |
| `DAILY_CAP` | 0.1 SOL | The most the runner spends in a UTC day, all markets together |
| `PRIORITY_FEE_MICROLAMPORTS` | 0 | The priority fee on devnet |
| `TIP_UNWRAP_AT` | 0.05 SOL | The wrapped-SOL balance at which tips are unwrapped |
| `RETRY_DELAYS` | 30 s, 2 min, 10 min | The retries before a job is parked |
| `SWEEP_INTERVAL` | 10 min | How often every market is re-read |
| `SETTLE_INTERVAL` | 1 hour | How often `settle` may run per market |
| `DAILY_PASS_UTC` | 00:00 | When the daily pass runs |
| `KEEPER_KEYPAIR` | `~/.config/testing-pipeline/devnet/keeper.json` | Where the key is read from |
| `RPC_URL` | Alchemy devnet, from `ALCHEMY_API_KEY` | The RPC the runner reads, simulates and sends through |
| `WS_URL`, `DISCOVERY_RPC_URL` | Aviary's Helius key (`RPC_URL` in the project's `.env`), else Solana's public devnet endpoint | The socket, and the `getProgramAccounts` that finds the markets, which Alchemy's free tier does not serve (see "RPC") |
| `DATABASE_URL` | the project's `DATABASE_URL`, else unset | Aviary's database, where runs are recorded; unset, the runner only logs |
| `HEARTBEAT_URL` | unset | Where each pass's signed heartbeat goes, `terminal-api`'s `/keeper/heartbeat`; unset, none is sent (see "How Aviary shows it") |

- A new market's first payouts may create up to five recipient token accounts (a tax market with four recipients and the suite share), about 0.0102 SOL, so on its first day the last one can wait for the next day's cap; that is accepted.
- What the runner has spent today is rebuilt from the chain whenever it starts: the keeper wallet's own transactions since 00:00 UTC (`getSignaturesForAddress`, then each one's fee and balance changes), per market from the accounts each one touched.
  A transaction's spend is what left the keeper wallet, and never less than its fee, so one that brings lamports back (unwrapping tips) still counts its fee; it is put to the first known market among its accounts.
  A lending AMM reserve's `refresh_reserve` names no market, so its fee counts in today's total and against `DAILY_CAP` but against no market's cap: a reserve serves every market that lends to it, and the job is due at most once every 4,500 slots per reserve (`SUITE-61`).
  A sent job is counted the same way once it lands, so the spend the runner tracks and the spend a restart rebuilds are one sum ([`SUITE-51`](../decisions.md#suite-51-keeper-runner-what-a-job-costs)).
  So the runner keeps no state file, and a restart can never reset a cap.
  This holds because the keeper wallet is used by the runner alone.

## What it records

- The runner writes to Aviary's Postgres (`DATABASE_URL`, the Neon project `terminal-devnet`) directly, as the explainer's approve command does from the Mac, never through Aviary's public API.
  Its default is the project's own `DATABASE_URL`, the one Aviary's local run uses, so the runner on the owner's Mac records into the database the keeper page reads; `KEEPER_DATABASE_URL` names another ([`SUITE-58`](../decisions.md#suite-58-keeper-runner-which-passes-and-jobs-are-recorded)).
- Two tables, in Aviary's database package (`packages/terminal-db`): `keeper_runs`, a row per pass (when, which pass, the keeper wallet that ran it, its balance, today's spend in all and by market, the caps and the settings it ran with, any warning, and what the pass counted), and `keeper_run_jobs`, a row per job it sent, held or parked (market, product, job, slot, outcome, signature, cost, the estimate, the cap that held it, the error and the attempt).
- It writes only in passes that sent, held or parked something, in one database transaction per pass.
  Neon's free plan gives 100 compute-hours a month, and the database must sleep while devnet is quiet; `place_wall`, `rebalance` and `settle` follow swaps, when Aviary's indexer has just woken the database anyway, and the daily pass wakes it once a day.
- What counts ([`SUITE-58`](../decisions.md#suite-58-keeper-runner-which-passes-and-jobs-are-recorded)):
  - a job whose transaction landed, whatever it did (sent, refused, too early for its slot, or without effect), with its signature and what it cost, so every lamport the runner spends is on the page;
  - a job held by a cap, recorded once a UTC day for each cap that holds it, and again once it has been anything but held, so a cap reached at noon does not wake the database every sweep until midnight;
  - a parked job;
  - whatever ends a recorded hold or park, so the page stops showing the job waiting: being unparked because its market changed, any other outcome, or no longer being due at all, as when another keeper sent it (`no-longer-due`);
  - the keeper wallet unwrapping its tips, as a job with no market.
  A job retried after a failure, or sent again from a later slot, runs in a pass of its own, `retry`, recorded the same way.
  When today's spend cannot be rebuilt from the chain for a pass (a send whose landing was unknown, then an RPC that cannot be asked), the pass records it as unknown, never as nothing spent, and the page keeps showing the last spend that was known.
  Errors and warnings are recorded with every URL cut to its scheme and host, since a path or query can carry an API key and the page is public.
- Without `DATABASE_URL` (someone else's copy, or before Aviary's database exists) the runner logs each recorded pass as one `record` row, exactly as the database would hold it, and works the same.
  A database that cannot be reached, or that refuses the write, never stops the runner: the pass is logged the same way with the reason.
  Records are written one at a time behind the passes, so a slow database never holds up a job, and the runner's connection closes after 20 idle seconds, so it never keeps Neon awake between passes.
- Logs go to `~/Library/Logs/testing-pipeline-keeper.log` on the Mac, and to standard output in Docker.

## How Aviary shows it

These are for Aviary's build tickets ([Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22)) and each product's Aviary panel ticket.
The tables and the runner's writer were built by [Aviary: the keeper page and the keeper runner's records](https://github.com/imDev2023/testing-pipeline/issues/129).

- Each market's panel shows every keeper job that is due, from `packages/keeper-jobs`, with how long it has been due, the runner's last attempt from `keeper_run_jobs` (sent, held by a cap, or parked with its error) and a button that prepares and simulates the job for the viewer's own wallet, as any custom action.
- The keeper page, `/keeper` (`PIPESCOPE-97`), shows whether the runner is running, the keeper wallet's address and balance (read through RPC), today's spend against each cap (all markets against `DAILY_CAP`, the costliest transaction against `MAX_TX_COST`, each market against `MARKET_DAILY_CAP`), the last pass of each kind, every held or parked job, the latest jobs with their transactions, and any warning; it is read-only and public, like the rest of Aviary, and `GET /keeper` serves it ([`PIPESCOPE-104`](../decisions.md#pipescope-104-what-the-keeper-page-shows)).
- **Is it running?** Since a quiet pass writes nothing, Postgres cannot tell a quiet runner from a stopped one, so after every pass the runner posts a heartbeat to `terminal-api`'s `POST /keeper/heartbeat` (`HEARTBEAT_URL`): which pass ran, when, its `SWEEP_INTERVAL`, its caps and its warnings, signed with the keeper wallet's key ([`SUITE-57`](../decisions.md#suite-57-keeper-runner-how-aviary-knows-it-is-running), owner, 2026-11-22).
  - `terminal-api` keeps only heartbeats signed by `KEEPER_WALLET`, the keeper wallet's published address, so no secret is shared and nobody else can make a stopped runner look alive; one whose time is more than two minutes from the Worker's clock is refused, so an old one cannot be replayed.
  - It keeps the newest heartbeat of each kind of pass in its `TERMINAL_CACHE` KV namespace, at most one of each kind every 30 seconds, so a heartbeat never wakes the database; each counts against the sender's IP like a read.
  - If the last heartbeat (one-off `once` runs aside) is older than the `SWEEP_INTERVAL` that heartbeat carries plus five minutes, the page says the runner looks stopped; with no heartbeat at all it says it cannot tell.
  - Parks live only in the runner's memory, so the page shows only parks recorded since the runner's current run started, a time every heartbeat carries.
  - Its warnings are cut to fit a heartbeat (at most 20, each at most 1,000 characters), so a long RPC error never gets the heartbeat refused.
  - A heartbeat goes in the background, one at a time, and never holds up or stops the runner.
- A database or an RPC that does not answer leaves the rest of the page standing, each panel saying what it could not read.

## Running it

- **On the owner's Mac**: a launchd agent, `testing-pipeline.keeper`, with `RunAtLoad` and `KeepAlive`, started by a script in `scripts/` that loads `~/.config/env/global.env` and the project's `.env` (launchd has no direnv) and runs the built program on the Node version in `docs/toolchain.md`.
  `pnpm keeper:install` writes and loads the agent, `pnpm keeper:uninstall` removes it, and `pnpm keeper:status` prints the wallet's balance, today's spend and the last pass.
- **Anywhere else**: the Docker image built from `apps/keeper`, with the key mounted read-only and the settings as environment variables, documented in `apps/keeper/README.md`, which also lists the decisions here and invites MetalLegBob to change any of them.
- **One-off**: `pnpm keeper:once` runs one full pass and exits, for tests, demos and anyone who would rather press nothing in Aviary.
- On mainnet the runner would need its own hosting decision; that belongs to the mainnet effort, which is out of scope.

## Testing it

- Unit tests of every due rule in `packages/keeper-jobs` against market states from each product's fixtures, including the boundary values (exactly `WALL_THRESHOLD`, the band's edges, slot 1 with `DESIGNER_RECIPIENT` unset).
- Tests of the runner against a local validator running devnet's router and our programs (each product's local demo run), with a fake clock for the passes: a job sent when due and only then, a "nothing to do" refusal skipped at no cost, every cap holding a job, the spend rebuilt after a restart equal to the spend before it, a failing job retried and parked, and a second keeper racing the runner costing only a refused simulation.
- On devnet, for each product as its deploy ticket lands: the runner calling that product's jobs on its demo market, with the signatures in the PR.

## Build tickets

Cut by [Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45) on 2026-11-10, labelled `build`, one session each, in run order:

1. [Keeper runner: the runner, its wallet and the tax AMM's `distribute`](https://github.com/imDev2023/testing-pipeline/issues/94): `apps/keeper`, `packages/keeper-jobs`, the keeper wallet, the caps, the launchd agent and the Docker image, after [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66).
2. [Keeper runner: the buy wall AMM's four jobs](https://github.com/imDev2023/testing-pipeline/issues/95): with keeper tips, after the first and [Buy wall AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/56).
3. [Keeper runner: the lending AMM's `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/96): after the first and [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87).

Each waits for the product whose jobs it adds to be on devnet, so the runner is built against deployed programs; the second and third can run in either order.
Aviary's side (the `keeper_runs` table and its writer, due jobs on each panel, the keeper page) is left to [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22), where it is posted as a comment.
