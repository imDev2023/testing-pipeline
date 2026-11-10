# Which lending market the lending pool lends to

Researched 2026-11-09 for [#12](https://github.com/imDev2023/testing-pipeline/issues/12); it feeds [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21).
Every fact below is dated 2026-11-09 unless it says otherwise.
A follow-up check for the design ticket, in `lending-market-kamino-facts.md` beside this file, covers devnet reserve setup, farm rewards, the main market's flags and caps, the exchange rate and its staleness, who can set emergency mode, and the withdrawal queue; it corrects one point below: only Kamino's global admin can set `block_ctoken_usage`, not a reserve's admin.
Source code was read from shallow clones in a scratchpad, never copied into this repo; commits are listed under Sources.
On-chain checks were read-only: `getAccountInfo` and `getProgramAccounts` on the public devnet RPC and on Helius's free tier for mainnet, plus transaction logs of recent mainnet calls for compute units.

## Answer

The lending pool should lend to **Kamino Lend (klend)**, through its cToken instructions `deposit_reserve_liquidity` and `redeem_reserve_collateral`, and never through obligations.
Jupiter Lend's Earn is the only serious alternative and should stay a second adapter for keeper jobs only.
MarginFi and Save are worse fits on every axis that matters here.

Why Kamino:

- An in-swap redeem nests one level less than Jupiter Lend's withdraw, so it leaves one call level spare inside a Pipeline swap, where Jupiter Lend uses the last one.
- The cToken instructions refresh the reserve themselves and read no oracle, so the strategy needs no separate `refresh_reserve` call and no oracle accounts.
- It is deployed on devnet at its mainnet program id, and anyone can create a lending market and reserves there, so the lending pool can have a real devnet demo; Jupiter Lend's devnet programs are stale and its own docs say to test against cloned mainnet state instead.
- A redeem costs about 30k compute units and 12 accounts.

What the choice does not fix: near full utilisation any lending market refuses withdrawals, so swaps larger than the buffer plus what the reserve can pay out still fail, whichever market we pick.

## How the lending pool would call a lending market

There are two call paths, and they face different limits.

- **Keeper job** (rebalancing the buffer): a custom action called directly, so the strategy is the top-level program and the lending market sits one level below it.
  Every candidate works here.
- **In-swap withdrawal** (topping up the buffer when a swap needs more than it holds): the router is the top-level program, the strategy is at stack height 2, the lending market at 3, and whatever the lending market calls below that.
  Pipeline counts trader, router (1), strategy (2), token program (3), transfer hook (4) and says this "leaves one level spare" (`docs/ROUTER.md` lines 156 to 158 at Pipeline `a2d5bfb`), so the limit on devnet and mainnet is stack height 5.
  The deeper limit of SIMD-0268 is not active on devnet or mainnet (`docs/DEVNET.md` line 94).
  Traders using smart wallets add one level (`docs/STRATEGY-GUIDE.md` line 89), and so would any aggregator program that calls Pipeline's router by CPI.
- Compute: about 1.3M units remain for the strategy per transaction, and the router itself uses 30 to 35k (`docs/STRATEGY-GUIDE.md` line 90, `docs/ROUTER.md` line 159).
- Accounts: `pipeline_resolve_accounts` returns up to about 30 accounts per round, up to four rounds (`docs/ROUTER.md` lines 150 to 152).
- Quotes: the quoter caps a quote at 200,000 compute units by default (`docs/STRATEGY-GUIDE.md` line 71), so a quote should read the lending market's state rather than simulate a call into it.

## Kamino Lend (klend)

Program `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`, source read at release 1.28.0 (`686913e`, 2026-11-06).
Mainnet program last deployed 2026-10-26 (slot 461744249).

### CPI surface

- **Deposit** is `deposit_reserve_liquidity(liquidity_amount)`: it moves the lent mint into the reserve and mints cTokens (collateral tokens) to the depositor.
  Accounts (12): owner (signer), reserve, lending market, lending market authority (PDA), liquidity mint, reserve liquidity supply, reserve collateral mint, depositor's liquidity account, depositor's cToken account, collateral token program (SPL Token), liquidity token program (SPL Token or Token-2022), instructions sysvar (`handlers/handler_deposit_reserve_liquidity.rs` lines 106 to 151).
  A permissioned market also wants its permissioning authority to sign as a last remaining account (`utils/permissioning.rs` lines 77 to 94); whether the main market is permissioned for deposits is unverified.
- **Withdraw** is `redeem_reserve_collateral(collateral_amount)`: it burns cTokens and pays out the lent mint at the reserve's exchange rate.
  It takes the same 12 accounts, and the destination must be owned by the owner (`handlers/handler_redeem_reserve_collateral.rs` lines 97 to 143).
- The strategy signs as owner with its own PDA, holds the cTokens itself, and keeps the lent mint as WSOL for the SOL reserve (its liquidity mint is `So11111111111111111111111111111111111111112`).

### Refresh requirements

- Both instructions call `refresh_reserve` internally with no price, which accrues interest and marks the reserve fresh for the current slot (`handlers/handler_deposit_reserve_liquidity.rs` line 54, `handlers/handler_redeem_reserve_collateral.rs` line 42, `lending_market/lending_operations.rs` lines 55 to 109).
- Their staleness check asks only for a current-slot update with no price status (`PriceStatusFlags::NONE`, `lending_operations.rs` lines 154 to 160 and 619 to 625), so no oracle account and no separate refresh instruction is needed.
- This internal refresh is in the handler at releases 1.12.2 (2025-08-26), 1.14.0 and 1.24.0 as well (checked with `gh api` on the file's history), so the devnet deployment has it too.
- The obligation instructions are a different story: `deposit_reserve_liquidity_and_obligation_collateral` and `withdraw_obligation_collateral_and_redeem_reserve_collateral` run `check_refresh`, which refuses any call whose top-level program is not klend itself or one of 16 whitelisted programs (Squads, Kamino Vaults, Meteora's vault and others) with `CpiDisabled` (`utils/refresh_ix_utils.rs` lines 49 to 66, `lending_market/ix_utils.rs` lines 53 to 91, `utils/consts.rs` lines 227 to 244).
  Our strategy cannot use obligations, in a swap or in a keeper job, unless Kamino whitelists it.

### Compute

Measured from the logs of the last 120 mainnet transactions on the main market's USDC reserve on 2026-11-09.
In the deposit and the redeem whose call trees were inspected, klend ran at stack height 2, called by another program, with SPL Token as its only callee, which also shows the cToken path accepting CPI on mainnet.

| Instruction | Samples | Median | Range |
| --- | --- | --- | --- |
| `deposit_reserve_liquidity` | 5 | 43,704 | 43,610 to 43,954 |
| `redeem_reserve_collateral` | 9 | 29,670 | 29,558 to 29,889 |
| `refresh_reserve` (not needed by us) | 148 | 21,106 | 11,653 to 29,664 |

So an in-swap redeem nests klend at 3 and SPL Token at 4, leaving height 5 free.

### Near full utilisation

- A redeem fails with `InsufficientLiquidity` when it asks for more than the reserve's freely available liquidity, which is its available liquidity minus what queued withdrawal tickets have claimed (`state/reserve.rs` lines 312 to 317 and 1017 to 1029).
- A redeem also counts against the reserve's withdrawal cap per interval when one is configured (`lending_market/lending_operations.rs` lines 634 to 640, `lending_market/withdrawal_cap_operations.rs`).
- Kamino has a withdrawal queue: `enqueue_to_withdraw` parks cTokens behind a ticket, and anyone (a payer signer) can later call `withdraw_queued_liquidity` to pay the ticket out as liquidity returns (`lending_operations.rs` lines 645 to 690, `handlers/handler_withdraw_queued_liquidity.rs` line 288).
  Tickets can only be issued where the lending market has enabled ticket issuance (`handlers/handler_enqueue_to_withdraw.rs`); whether the main market has it on is unverified.
  Queued tickets come before plain redeems, so other lenders' tickets shrink what an in-swap redeem can take.
- Borrowing above a configured utilisation is blocked per reserve (`utilization_limit_block_borrowing_above_pct`, `state/reserve.rs` line 1777), but interest can still push utilisation higher.
- A reserve in emergency mode refuses redeems as well as deposits (`lending_market/lending_checks.rs` lines 26 to 32 and 328).
- A reserve's admin can set `block_ctoken_usage`, which blocks cToken deposits but not cToken redeems, so exits stay open (`lending_checks.rs` lines 234 to 237; `redeem_reserve_collateral_checks` at line 315 has no such check).
- On 2026-11-09 the main market (`7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`) had 58 reserves; SOL (`d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q`) and USDC (`D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59`) were active with `block_ctoken_usage` 0 (decoded from account data at offset 4862).
- Kamino's free API gave SOL 2,403,007 supplied and 2,185,146 borrowed (about 91% utilised, about 218k SOL free), and USDC 145.9M supplied and 125.1M borrowed (about 86%, about 20.9M free) (`https://api.kamino.finance/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves/metrics`).

### Token-2022

- The lent mint may be SPL Token or Token-2022; a Token-2022 mint may carry only listed extensions, with a zero transfer fee, no transfer hook program set, and not paused (`utils/constraints.rs` lines 42 to 160).
- cToken mints are always SPL Token (`collateral_token_program: Program<Token>` in both handlers).
- A contained token (one under our containment hook) can therefore never be lent, which matters only if the lending pool wanted to lend the token side; it lends the SOL or USDC side.

### Devnet and testing

- klend is deployed on devnet at the same program id, last deployed 2026-09-01 (slot 491561420), with 328 reserves across many markets created by others.
  Which release devnet runs is unverified; it is after 1.12.2, so the cToken path behaves as above.
- Anyone can create a lending market and becomes its owner (`handlers/handler_init_lending_market.rs` line 30), and only the owner or its proposer authority can add reserves (`lending_market/lending_operations.rs` lines 4773 to 4779).
- A reserve's config must name at least one enabled price source (Scope, Switchboard or Pyth) to be valid (`state/token_info.rs` lines 104 to 109), even though the cToken path never reads it; what a devnet reserve needs to pass this is unverified.
- So the lending pool can have its own devnet lending market and reserve for demos, and LiteSVM tests can load the deployed klend program with a handful of cloned mainnet accounts (reserve, lending market, mints, supply vault), with no oracle accounts.
- Licence: klend is BSL 1.1 with no additional use grant until 2027-11-17 (`LICENSE`); we only call Kamino's deployed program and load its deployed bytes in tests, never run our own copy in production.

## Jupiter Lend (Earn)

Built by Fluid (Instadapp): Lending `jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9` over Liquidity `jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC`, both last deployed on mainnet 2026-10-06.
Integration docs read at `jup-ag/jupiter-lend` `7960a14`, program source at `Instadapp/fluid-solana-programs` `626b177` (2026-02-11), and the knowledge base's `jupiter/03-lend-perps-predict-jupusd-dev.md` section 1.

### CPI surface

- `deposit(amount)` and `withdraw(amount)` on the Lending program, plus share-based `mint` and `redeem`; each returns the shares as return data (`docs/earn/cpi.md`).
- Deposit takes 17 accounts and withdraw 18, plus the Lending program; the Liquidity program, its PDA, the token reserve, the Earn supply position, two rate models and the vault are all among them (`docs/earn/cpi.md`).
- Token accounts must already exist and be owned by the signer, so the strategy's PDA owns its fToken (jlToken) account.
- `withdraw(u64::MAX)` withdraws everything but skips the withdrawal-limit check, so check the withdrawable amount first (`docs/earn/cpi.md`, "Special Considerations").
- No refresh instruction and no oracle are needed; Lending updates its exchange prices itself (`programs/lending/src/utils/withdraw.rs` lines 38 to 50).
- Lending and Liquidity have no stack-height checks; only the flash-loan program has (`programs/flashloan/src/validate.rs` line 27).

### Call depth and compute

- A withdraw burns the fTokens through the token program and then calls Liquidity's `operate`, which transfers the underlying out through the token program again (`programs/lending/src/utils/withdraw.rs` lines 14 to 31 and 71 to 80).
- The mainnet withdraw whose call tree was inspected confirms it: Lending at height 1 called Token at 2, Liquidity at 2 and Token at 3; an inspected `redeem` called by another program ran Lending at 2 and reached Token at 4.
- Inside a Pipeline swap that is router 1, strategy 2, Lending 3, Liquidity 4, Token 5: it uses the last level, and fails with any extra outer level (a smart wallet or an aggregator calling the router).
- Compute from 120 recent mainnet signatures of the Lending program: `deposit` median 55,986 (47,858 to 59,903, 14 samples), `withdraw` median 55,647 (40,938 to 67,287, 26 samples), `redeem` median 66,131 (21 samples).

### Near full utilisation

- All Earn depositors of a mint share one supply position on the Liquidity layer, and its withdrawal limit expands over time, so a withdrawal fails with `WithdrawalLimitReached` once the whole pool's recent withdrawals use it up (`programs/liquidity/src/state/user_supply_position.rs` line 229).
- Borrows are refused above the mint's maximum utilisation (`programs/liquidity/src/module/user.rs` line 155).
- The keyless API gave, on 2026-11-09: jlUSDC 479.2M total with 51.6M withdrawable now (limit expands 50% over 6 hours); jlWSOL 274,023 SOL total with 68,507 withdrawable (25% over 6 hours) (`https://api.jup.ag/lend/v1/earn/tokens`, `liquiditySupplyData`).

### Token-2022

- Token-2022 mints are allowed with a whitelist of extensions, zero transfer fee, no transfer hook program set and an `Initialized` default state; the Token-2022 native mint is refused (`crates/library/src/token/spl.rs` lines 66 to 116).

### Devnet and testing

- Devnet has separate programs (Lending `7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3`, Liquidity `5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL`), last deployed 2025-07-21 and 2025-07-24 by their programdata.
- Jupiter's own guide says they "do not match the current IDL", the SDK does not target devnet, and integrators should "test against mainnet, or a local validator with the mainnet programs cloned" (`docs/earn/cpi.md`, Devnet); the guide dates the deploy to May 2025, which disagrees with the programdata.
- So Jupiter Lend can only be tested in LiteSVM or Surfpool with two cloned programs and about ten cloned accounts, never demoed on devnet.
- Licence: Fluid's programs are BSL 1.1 until 2029-07-24, with a use grant for education only (`LICENSE`); calling the deployed programs is unaffected.

## MarginFi and Save, briefly

- **MarginFi v2** (`MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA`, source `8665b8d`): deposits go into a per-owner `MarginfiAccount`, and every withdraw runs a health check over the account's banks and their oracle accounts passed as remaining accounts (`programs/marginfi/src/instructions/marginfi_account/withdraw.rs` lines 230 to 248), so an in-swap withdraw depends on fresh oracles.
  It has no devnet deployment at its mainnet id (checked by `getAccountInfo`); its staging program `stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct` is on mainnet (`programs/marginfi/src/constants.rs` line 12).
  Its repo carries Kamino and Jupiter Lend mock programs, which suggests MarginFi itself now deposits into them (unverified).
- **Save (Solend)** (`So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo`, source `d04ce00`, last commit 2025-07-02): `deposit_reserve_liquidity` and `redeem_reserve_collateral` require the reserve refreshed in the same slot (`token-lending/program/src/processor.rs` lines 713 and 862), and `refresh_reserve` takes Pyth and Switchboard price accounts (lines 516 to 528).
  Redeems pass a market-wide outflow rate limiter (lines 884 to 895).
  The program uses SPL Token only, with no Token-2022 references in its source.
  A separate devnet program `ALend7Ketfx5bxh6ghsCDXAoDrhvEmsXT3cynB6aPLgx` exists; its age is unchecked.

## Side by side

| | Kamino Lend (cToken path) | Jupiter Lend Earn | MarginFi v2 | Save |
| --- | --- | --- | --- | --- |
| Deposit / withdraw | `deposit_reserve_liquidity` / `redeem_reserve_collateral` | `deposit` / `withdraw` | `lending_account_deposit` / `lending_account_withdraw` | `deposit_reserve_liquidity` / `redeem_reserve_collateral` |
| Refresh in the same transaction | None (internal, no oracle) | None | Oracle accounts on withdraw | `refresh_reserve` with Pyth and Switchboard |
| Accounts per call | 12 | 17 / 18 | Account, bank, vaults, plus bank and oracle per position | About 10 plus a refresh |
| Compute (mainnet median) | 43.7k / 29.7k | 56.0k / 55.6k | Not measured | Not measured |
| Deepest stack height in a Pipeline swap | 4 (one spare) | 5 (none spare) | 4, plus oracle freshness | 4, plus a refresh |
| Near full utilisation | Fails above freely available liquidity; withdrawal queue; per-interval cap | Fails above the shared, slowly expanding withdrawal limit | Fails on bank liquidity | Fails on liquidity; outflow rate limiter |
| Token-2022 lent mint | Yes, no hook, zero fee | Yes, no hook, zero fee | Yes (details unverified) | No |
| Devnet | Same program id, current, anyone can make a market | Stale programs; test on cloned mainnet | None at mainnet id | Separate old program |

## Prior art: Meteora's Dynamic Vault

- Meteora's Dynamic Vault is the closest prior art: a vault keeps liquidity in its token vault, an off-chain operator (Hermes) moves it in and out of lending strategies, and a user withdrawal can pull from a strategy first when the vault is short (`withdraw_directly_from_strategy`).
- In its current source the only external lending strategy with a working handler is Jupiter Lend; the Kamino, MarginFi and Solend variants remain in the enum but are unsupported (docs.meteora.ag Dynamic Vault pages, mirrored in the knowledge base at `raw/meteora-docs/pages/developer-guides__dynamic-vault__changelog.md` and `legacy-products__dynamic-vault__hermes__rebalance-crank.md`; the program source `mercurial-vault` is not public, so this rests on Meteora's docs).
- That choice fits a vault called at the top level, where Jupiter Lend's extra level costs nothing; our in-swap path is one level deeper, which is why it points the other way for us.
- Meteora's vault program is on klend's CPI whitelist (`utils/consts.rs` line 233), so Meteora could have used Kamino's obligations; we cannot.

## Corrections to earlier notes

- `research/estimates.md` says calling a lending market inside a swap of a hooked token exceeds the call-depth limit.
  It does not, for the lent side: the lending call and the hooked token's transfer are sibling calls under the strategy, and neither Kamino nor Jupiter Lend accepts a mint with a transfer hook, so the lent mint never carries one.
  The real limit is Jupiter Lend's withdraw at height 5 plus any extra outer level; Kamino's redeem stays at height 4.
- `research/estimates.md` says Kamino's devnet presence is unknown; klend is on devnet at its mainnet id, so a devnet demo is possible with our own lending market, and cloned mainnet state is needed only for tests against real reserves.

## Open questions for Lending pool design (#21)

1. Does a swap ever redeem from the lending market, or only spend the buffer while keeper jobs rebalance?
   If it redeems, the quote must read the reserve's freely available liquidity and withdrawal cap, and swaps above buffer plus that amount must fail cleanly.
2. Which mints are lent: only SOL (WSOL) and USDC, the side that has a Kamino main-market reserve?
3. Which reserve on mainnet (the main market's SOL reserve `d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q`?), and on devnet, our own lending market (what oracle config does its reserve need) or someone else's?
4. How does the market's price and each LP's share value the cTokens: at the reserve's exchange rate refreshed in the same call, or at the last keeper job's rate?
5. What does the lending pool do when the reserve is nearly fully borrowed (SOL was about 91% on 2026-11-09): raise the buffer, queue a withdrawal ticket, or stop lending?
6. What happens if Kamino sets `block_ctoken_usage` or emergency mode on our reserve: deposits stop in the first case, and in emergency mode redeems stop too, so swaps live on the buffer alone?
7. Do cToken holders miss Kamino's farm rewards, which attach to obligations (unverified)?
8. Should the strategy keep a lending-market adapter so Jupiter Lend can be added for keeper jobs later, or once SIMD-0268 raises the call-depth limit?
9. Test plan: a LiteSVM test of the in-swap redeem at one extra outer level (a smart-wallet trader), and a devnet demo against our own klend market.

## Sources

Code (read-only clones in a scratchpad):

- Pipeline `a2d5bfbe62ff61d3ca0ce7a976520da61a0f16c4`: `docs/ROUTER.md`, `docs/STRATEGY-GUIDE.md`, `docs/DEVNET.md`, `docs/INTEGRATOR-GUIDE.md` (https://github.com/MetalLegBob/pipeline).
- Kamino klend `686913ee421e0c5f3dc44c4c8344461ee0e4fb89` (release 1.28.0), files under `programs/klend/src/` as cited (https://github.com/Kamino-Finance/klend/tree/686913ee421e0c5f3dc44c4c8344461ee0e4fb89); handler history from `gh api repos/Kamino-Finance/klend/commits?path=programs/klend/src/handlers/handler_deposit_reserve_liquidity.rs`.
- Jupiter Lend integration guide `7960a14a5a760abc41db3ed1395dc5cb56a1f8db`: `docs/earn/cpi.md`, `README.md` (https://github.com/jup-ag/jupiter-lend).
- Fluid Solana programs `626b177f235224bc5d074d39439cd2558f542886`: `programs/lending`, `programs/liquidity`, `programs/flashloan`, `crates/library` as cited (https://github.com/Instadapp/fluid-solana-programs).
- MarginFi v2 `8665b8d1afc4d39bf7e575a85c663580e35c6314` (https://github.com/mrgnlabs/marginfi-v2).
- Save `d04ce00bbf4356c4fd32b3be38eb9760b696bb3e` (https://github.com/solendprotocol/solana-program-library).
- Surfpool (https://github.com/txtx/surfpool, README: a drop-in `solana-test-validator` replacement that mirrors mainnet state without a snapshot) and LiteSVM (https://github.com/LiteSVM/litesvm).

Knowledge base (`/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora`):

- `jupiter/03-lend-perps-predict-jupusd-dev.md` section 1 (Jupiter Lend programs, Earn CPI, devnet ids).
- `meteora/03-dev-dbc-vaults-launch.md` "Dynamic Vault" and the raw Meteora docs pages named above.

On chain and APIs (2026-11-09):

- Program existence and last-deploy slots: `getAccountInfo` on each program and its programdata, mainnet and `https://api.devnet.solana.com`.
- Kamino reserves: `getProgramAccounts` on klend filtered by size 8624 (and by lending market at offset 32), decoding the liquidity mint at offset 128, reserve status at 4856 and `block_ctoken_usage` at 4862, from the `Reserve` and `ReserveConfig` layouts in `state/reserve.rs`.
- Compute units: `getSignaturesForAddress` then `getTransaction` logs, for the USDC reserve `D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59` (120 signatures) and the Jupiter Lend Lending program (120 signatures).
- `https://api.kamino.finance/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves/metrics` and `https://api.jup.ag/lend/v1/earn/tokens` (both free and keyless).
