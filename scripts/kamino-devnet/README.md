# kamino-devnet

Creates the Kamino lending market every lending AMM market on devnet lends to, and proves with real transactions that Kamino Lend on devnet does everything the lending AMM will ask of it ([Lending AMM: our Kamino lending market on devnet](https://github.com/imDev2023/testing-pipeline/issues/77), `docs/spec/lending-pool.md`, "Devnet").
It is a standalone package with its own lockfile, outside any workspace of this repo, as `scripts/quote-devnet` is.

## What it makes

- A lending market owned by a new key, `kamino-market-owner.json`.
- A test USDC mint (6 decimals) whose mint authority is `test-usdc-mint-authority.json`.
- A WSOL reserve and a test USDC reserve, each configured while it holds only Kamino's 100,000-unit seed and then opened by raising its deposit limit with Kamino's full validation; both name the live devnet Pyth feeds.

Every address is derived from a key with `createAccountWithSeed`, so a re-run finds the same accounts and keeps no account keypairs.
The addresses the lending AMM program and later scripts need are written to [`deployments/kamino-devnet.json`](../../deployments/kamino-devnet.json), which is committed.

Keys live only in `~/.config/testing-pipeline/devnet/` (mode 600); the setup creates the ones that do not exist yet, except the devnet wallet, `wallet.json`, which pays for everything and is the second depositor.
Fund the wallet with `devnet-airdrop` (`docs/toolchain.md`, Devnet), never a web faucet.

## Commands

```sh
source ../toolchain-env.sh   # Node 24 (docs/toolchain.md)
npm ci
npm run cli -- help
```

| Command | Who | What |
| --- | --- | --- |
| `setup` | market owner | Creates the market, the mint and both reserves, or checks they are as `src/policy.ts` says; changes only what differs |
| `status` | anyone | Per reserve: total supply, borrowed, free liquidity, utilisation, stored rate and flags, decoded at the spec's offsets |
| `layout` | anyone | Checks each reserve and the lending market against the spec's size, discriminator and offsets, and against Kamino's IDL layout |
| `supply [--reserve wsol\|usdc]` | second depositor | Tops the devnet wallet's supply up to its target (5 SOL and 100,000 test USDC) |
| `take-back --reserve R --amount N\|all` | second depositor | Takes liquidity back |
| `ctoken-deposit --reserve R [--amount N]` | plain cToken holder | `deposit_reserve_liquidity`, with no oracle account and no refresh |
| `ctoken-redeem --reserve R [--ctokens N]` | plain cToken holder | `redeem_reserve_collateral`, every cToken by default |
| `borrow [--amount N]` | test borrower | Opens an obligation on test USDC if needed and borrows WSOL (3.5 SOL by default) |
| `repay` | test borrower | Repays the WSOL debt in full |
| `emergency on\|off [--market]` | market owner | Sets the WSOL reserve's emergency mode, or the whole market's |
| `refresh [--reserve wsol\|usdc]` | anyone | klend's `refresh_reserve` for each reserve, which a lending AMM market's quotes need within `TRADE_MAX_RESERVE_AGE_SLOTS` of; the keeper runner keeps it so once it runs `rebalance` |
| `prove` | all | Every check of the ticket in one run, ending with the signatures and the devnet SOL spent and locked |

Amounts are in whole tokens (`--amount 0.5`).
`--url` defaults to public devnet; the script refuses any other cluster except a local validator.

## Policy values

Every value a reviewer may want changed (limits, the borrow rate curve, the price max age, loan-to-value, the withdrawal caps, the parties' amounts) is in [`src/policy.ts`](src/policy.ts).
They are defaults MetalLegBob may change; the next `setup` moves each reserve to whatever the file says.

## Tests

```sh
npm run typecheck
npm test
```

- `test/layout.test.ts` checks the spec's offsets against Kamino's own account layout and the reserve maths, with no network.
- `test/e2e.test.ts` and `test/prove.test.ts` run every command against a `solana-test-validator` that clones Kamino Lend's program and global config from devnet at start, with the two Pyth price accounts loaded at the current time; they need devnet reachable and Agave 4.4.1 on `PATH`.

## Notes

- Instructions are built with the generated builders of Kamino's MIT-licensed SDK, `@kamino-finance/klend-sdk`; the lending AMM program never compiles klend's BSL-licensed crate (`docs/spec/lending-pool.md`, "Building it").
- The SDK depends on `@solana/kit` 2.3, so this package pins kit 2.3 and the matching `@solana-program/system` 0.7 and `@solana-program/token` 0.5; npm warns about the SDK's own nested packages, which ask for kit 3, and none of them is loaded here.
- Transactions are confirmed by polling their status, not over WebSockets, which public devnet drops under Node 26 (`docs/toolchain.md`, Known problems).
- Transactions Kamino is expected to refuse are sent without a preflight simulation, so each refusal lands on chain with a signature.
