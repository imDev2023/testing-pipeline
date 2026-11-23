# Keeper runner

The keeper runner calls every keeper job of every market of our strategies when it is due, and pays for it from the keeper wallet.
Its design is [`docs/spec/keeper-runner.md`](../../docs/spec/keeper-runner.md); this file says how to run it.
Every keeper job is permissionless, so anyone can run their own copy with their own key.

Today it runs seven jobs, each defined in [`packages/keeper-jobs`](../../packages/keeper-jobs):

- the tax AMM's `distribute`, one transaction per owed slot, the burn slot included, in the daily pass;
- the buy wall AMM's `place_wall`, after each transaction on a market and in every sweep;
- its `settle`, in the hourly pass, at most once every `KEEPER_SETTLE_INTERVAL` on each market;
- its `pay_rewards` and `sweep_fees`, one transaction per fee slot, in the daily pass, slot 1 only once the program's `DESIGNER_RECIPIENT` is set;
- the lending AMM's `rebalance`, after each transaction on a market and in every sweep, whenever the program would act (the buffer outside its band, withdraw mode entered, left or waited out), with klend's `refresh_reserve` first in the same transaction except while the lending market's emergency mode is on;
- klend's `refresh_reserve` on its own, in the same passes, for a lending AMM market holding cTokens whose reserve was last refreshed more than half of `TRADE_MAX_RESERVE_AGE_SLOTS` ago, so the market keeps quoting.

`place_wall` tips the keeper wallet's wrapped-SOL account, which the placement creates when it is missing; once that account holds more than `KEEPER_TIP_UNWRAP_AT`, the end of the pass closes it into the float.
The lending AMM's jobs read the market's Kamino reserve, its lending market and the clock as well as the market state: its entry names them, and the runner reads them with the market in one request.

## The decisions it rests on

Each is a default MetalLegBob may change: name its ID in an issue, in a comment on a pull request, or in a message to the owner.
They are all in the decision register, [`docs/decisions.md`](../../docs/decisions.md).

- `SUITE-26`: a keeper wallet made only for the runner, with tight caps a transaction, a market a day and a day.
- `SUITE-27`: a failed job is retried and then parked until its market changes; at a cap or below the minimum balance nothing is sent.
- `SUITE-28`: the runner keeps the buy wall's keeper tips and covers every market of our strategies, other people's too.
- `SUITE-32`: on devnet it runs on the owner's Mac under launchd, never on the owner's Cloudflare account, and as a Docker image anywhere else.
- `SUITE-33`, `SUITE-34`: which jobs it calls, and when: its own socket, a sweep, an hourly and a daily pass, and a full pass whenever it starts.
- `SUITE-35`: each job's due rule is written once, in `packages/keeper-jobs`, which Aviary's panels use too.
- `SUITE-36`: Alchemy's free devnet endpoint for reads, simulations and sends.
- `SUITE-37`, `SUITE-58`: what it records, in Aviary's database (`keeper_runs` and `keeper_run_jobs`) or, without one, as `record` rows in its log: only the passes that sent, held or parked something.
- `SUITE-57`: after every pass it posts a heartbeat signed with the keeper wallet's key to Aviary's API, so the keeper page knows it is running while the database sleeps.
- `SUITE-49`: the socket and market discovery on Aviary's Helius key once it exists, on Solana's public devnet endpoint until then, since Alchemy's free tier serves neither.
- `SUITE-50`: a payout simulated without a `Distributed` event had nothing to do, as when another keeper paid it first.
- `SUITE-51`: a job's cost is what its simulation takes from the wallet, and what it spent is what left the wallet once it landed, never less than its fee.
- `SUITE-52`: an RPC that cannot be asked never counts as the job failing.
- `SUITE-53`: a misspelt `KEEPER_` variable stops the runner at start.
- `SUITE-54`: a payout that would create its recipient's token account waits until it pays at least that account's rent.
- `SUITE-55`: no cap and not the minimum balance hold the unwrapping of the tips, whose fee still counts in today's spend.
- `SUITE-56`: `settle` runs at most once every `KEEPER_SETTLE_INTERVAL` on a market, a restart included, learned from the keeper wallet's own transactions.
- `TAX-43`, `TAX-45`, `TAX-48`: how the tax AMM's `distribute` names its slots and their wallets, and why only the burn takes the mint writable.
- `SUITE-59`: a due rule that needs more than its market's state names the accounts it reads, and the runner reads them with the market.
- `SUITE-60`: the lending AMM's `rebalance` is due exactly when the program would act, its own rule written again on the stored state.
- `SUITE-61`: reserves are refreshed by a job of their own once older than half of `TRADE_MAX_RESERVE_AGE_SLOTS`, their fees counting in the day's total but against no market.
- `SUITE-62`: a refusal code means "nothing to do" or "try again in a later slot" only when the product's own program refused.
- `LENDING-16`, `LENDING-93`, `LENDING-95`: when the lending AMM's `rebalance` runs, why leaving withdraw mode takes readings an hour apart, and why the keeper refreshes reserves and sweeps withdraw mode.
- `POOL4-37`, `POOL4-38`, `POOL4-48`, `POOL4-50`: how the buy wall AMM's payouts name their recipients' accounts and who signs them, why `pay_rewards` needs no hook accounts, and why `place_wall` waits for a slot no swap has run in.

## Settings

Every policy value is in [`src/settings.ts`](src/settings.ts) and nowhere else, each overridable by an environment variable of its name prefixed `KEEPER_`.
The runner logs every value it started with in its first line, so the log always says what a run used.

| Variable | What it sets |
| --- | --- |
| `KEEPER_FLOAT_TARGET` | The balance `devnet-airdrop` tops the wallet up to, in SOL |
| `KEEPER_LOW_BALANCE` | Below it every pass warns, in SOL |
| `KEEPER_MIN_BALANCE` | Below it nothing is sent, in SOL |
| `KEEPER_MAX_TX_COST` | The most one transaction may cost, in SOL |
| `KEEPER_MARKET_DAILY_CAP` | The most spent on one market in a UTC day, in SOL |
| `KEEPER_DAILY_CAP` | The most spent in a UTC day, in SOL |
| `KEEPER_PRIORITY_FEE_MICROLAMPORTS` | The priority fee |
| `KEEPER_TIP_UNWRAP_AT` | The wrapped-SOL balance at which keeper tips are unwrapped, in SOL |
| `KEEPER_RETRY_DELAYS` | The waits before each retry of a failed job, such as `30s,2m,10m` |
| `KEEPER_SWEEP_INTERVAL` | How often every market is re-read, such as `10m` |
| `KEEPER_SETTLE_INTERVAL` | How often the hourly pass runs, such as `1h` |
| `KEEPER_DAILY_PASS_UTC` | When the daily pass runs, `HH:MM` in UTC |
| `KEEPER_KEYPAIR` | The key file, from `solana-keygen` |
| `KEEPER_RPC_URL` | Reads, simulations and sends; defaults to Alchemy's devnet endpoint from `ALCHEMY_API_KEY` |
| `KEEPER_WS_URL` | The socket, which must serve `logsSubscribe` |
| `KEEPER_DISCOVERY_RPC_URL` | Where markets are found, which must serve `getProgramAccounts` |
| `KEEPER_DATABASE_URL` | Aviary's database, where recorded passes go; defaults to the project's `DATABASE_URL`, and unset, the runner logs them |
| `KEEPER_HEARTBEAT_URL` | Where each pass's signed heartbeat goes, Aviary's `/keeper/heartbeat` (`http://localhost:8811/keeper/heartbeat` for Aviary's local run); unset, none is sent |

A `KEEPER_` variable not in this table stops the runner at start.
No log line carries an API key or a password from a URL, and none carries the keeper wallet's key.

## On the owner's Mac

The keeper wallet is `~/.config/testing-pipeline/devnet/keeper.json`, address `8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2`.
It is topped up only with `devnet-airdrop ~/.config/testing-pipeline/devnet/keeper.json --target 2`; the runner never funds itself.

```sh
pnpm keeper:install     # builds the runner and loads the launchd agent testing-pipeline.keeper
pnpm keeper:status      # the agent's state, the wallet's balance, today's spend and the last pass
pnpm keeper:once        # one full pass of every job, then exit
pnpm keeper:uninstall   # unloads and removes the agent
```

The agent starts [`scripts/keeper-run.sh`](../../scripts/keeper-run.sh) at login and whenever it stops, from the checkout `pnpm keeper:install` ran in.
launchd has no direnv, so the script loads `~/.config/env/global.env` and the project's `.env` itself, then runs the built runner, `dist/keeper.mjs`, on the Node version `docs/toolchain.md` names.
A setting for the agent goes into the project's `.env`, followed by `pnpm keeper:install` again.
The log is `~/Library/Logs/testing-pipeline-keeper.log`, one JSON row a line: `start` with the settings, a `pass` row per pass, and a `job` row for each job sent, held, parked or skipped, with its signature, cost or reason.
A pass that sent, held or parked something is also recorded in Aviary's database, the project's `DATABASE_URL`, and shown on Aviary's keeper page, `/keeper`; without a database it is logged as one `record` row instead, and a `heartbeat` row says when a heartbeat was refused or did not arrive.
When the Mac sleeps the jobs wait, and the full pass at the next start catches up.
An `unwrap` row says when the tips were closed into the float.

While the agent runs, the buy wall AMM's demo market on devnet never keeps a job due for long: the runner places the wall within seconds of a trade that makes it due.
So stop the agent (`pnpm keeper:uninstall`) before `programs/buy-wall-amm/scripts/demo.ts --market <its state> --trade-only`, which the release gate's devnet fixture is saved after, and before the demo walks the market's keeper jobs itself; install it again afterwards.

## Docker

The image holds only the bundled runner on Node 24; the key is mounted read-only when it runs.

```sh
pnpm install
pnpm --filter keeper image      # builds dist/keeper.mjs, then the image testing-pipeline-keeper
docker run --rm \
  -v ~/.config/testing-pipeline/devnet/keeper.json:/keys/keeper.json:ro \
  -e ALCHEMY_API_KEY \
  testing-pipeline-keeper         # or: testing-pipeline-keeper once
```

`KEEPER_KEYPAIR` is `/keys/keeper.json` in the image; any other setting is passed with `-e`.
In Docker the rows go to standard output.

## Testing

```sh
pnpm --filter keeper test           # settings, what a pass records, the heartbeat and the runner's genericity, no chain needed (CI runs these, and packages/keeper-jobs's tests)
TEST_DATABASE_URL=postgres://terminal:terminal@127.0.0.1:5462/postgres \
  pnpm --filter keeper test:db      # the writer to Aviary's database (CI's terminal job runs these, with its Postgres)
```

The runner's own tests run against a local validator running devnet's router, the tax AMM, the buy wall AMM and the lending AMM, with devnet's klend and our Kamino lending market cloned, after the local demos have registered the strategies (`docs/toolchain.md`, "Local demo run"), with a fake clock for the passes:

```sh
source scripts/toolchain-env.sh
bash programs/lending-amm/scripts/fetch-klend.sh devnet
bash programs/lending-amm/scripts/fetch-accounts.sh
scripts/local-validator.sh          # in another shell
(cd programs/tax-amm/scripts && pnpm demo --cluster localnet \
  --payer ~/.config/testing-pipeline/devnet/wallet.json \
  --upgrade-authority ~/.config/testing-pipeline/devnet/upgrade-authority.json)
(cd programs/buy-wall-amm/scripts && pnpm demo --cluster localnet \
  --payer ~/.config/testing-pipeline/devnet/wallet.json \
  --upgrade-authority ~/.config/testing-pipeline/devnet/upgrade-authority.json)
(cd programs/lending-amm/scripts && pnpm demo --cluster localnet --register-only \
  --payer ~/.config/testing-pipeline/devnet/wallet.json \
  --upgrade-authority ~/.config/testing-pipeline/devnet/upgrade-authority.json)
pnpm --filter keeper test:local     # LOCAL_VALIDATOR_URL names another validator; TEST_DATABASE_URL as above
```

They show a job sent when due and only then, a market owing nothing sending nothing, another keeper paying first costing only a simulation, each cap and the minimum balance holding a job, today's spend rebuilt after a restart equal to the spend before it, a failing job retried at `RETRY_DELAYS` and then parked until its market changes, an RPC hiccup while building a job not counted as its failure, `keeper once` running one pass and exiting without ever printing the key, and the pass that paid out recorded once with every signature, in the database or as one `record` row in the log, while the passes that sent nothing record nothing and every pass sends its heartbeat.
For the buy wall AMM they show the wall placed from the runner's own socket after the swap that makes it due, its tip landing in the keeper wallet's wrapped-SOL account, which the same transaction creates, the tips unwrapped once that account holds more than `TIP_UNWRAP_AT` and not at exactly it, `settle` never twice within `SETTLE_INTERVAL` on a market even across a restart, and the daily pass paying the rewards and sweeping fee slots 0 and 2 but never slot 1, with a payout into a missing account worth less than its rent left waiting at no cost.
For the lending AMM they show `rebalance` sent from the runner's own socket within a minute of a swap that pushes the buffer out of its band, a deposit after a buy and a redeem after a sale beyond the buffer, each leaving the buffer at its target; a sweep catching a market that left its band while the socket was closed, both ways; a rival keeper's rebalance between the runner's read and its simulation leaving only a `WithinBand` refusal, skipped with no transaction sent; and the reserve refreshed once its last refresh is more than 4,500 slots old, and not before.
Each test makes its own markets and sees only those, so the tests can share one validator.
The lending AMM's reserve-refresh test waits about 4,500 slots, so it skips itself on a validator at the usual pace; run it on a validator of its own started with `--ticks-per-slot 8` (`node --test --test-name-pattern refreshed test/local/lending.test.ts`), not with the rest, since fast slots put the block time ahead of the wall clock and the buy wall's `settle` test reads when it last ran from block times.

On devnet, `node apps/keeper/scripts/demo-lending.ts --payer ~/.config/testing-pipeline/devnet/wallet.json --buy <lamports>` (or `--sell <token units>`) trades the lending AMM's demo market out of its band and prints the swap, the runner's `rebalance` and the buffer's share before, after the swap and after the rebalance.
