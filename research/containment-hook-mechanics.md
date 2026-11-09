# How the containment hook works with the router and unlocks

Research for [#10](https://github.com/imDev2023/testing-pipeline/issues/10), feeding [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18).
All facts dated 2026-11-09 and read from primary sources: code, the owner's knowledge base and first-party docs.
Nothing was sent on chain.

## Sources read

| Source | Version | Where |
| --- | --- | --- |
| Pipeline (router, `test-hook`, `test-hook-refill`, `test-strategy-cp`, tests, docs) | commit `a2d5bfb` (2026-11-09 07:14 UTC) | https://github.com/MetalLegBob/pipeline, read from a scratchpad clone |
| The Factory's transfer hook | commit `da2529b` (2026-11-07) | https://github.com/MetalLegBob/fantastical-finance-factory, `programs/transfer-hook` |
| Token-2022 program and interface | commit `486240c` (2026-11-08) | https://github.com/solana-program/token-2022 |
| `pinocchio-transfer-hook-interface` 0.1.0, the hook CPI that Token-2022 at `486240c` uses | crates.io, sha256 `cd99db01...` matching Token-2022's `Cargo.lock` | https://crates.io/crates/pinocchio-transfer-hook-interface |
| `spl-transfer-hook-interface` | commit `5949f23` (2026-11-02) | https://github.com/solana-program/transfer-hook |
| Meteora DBC, DAMM v2 and DLMM Token-2022 docs, and the DBC hook routing census | owner's KB mirror | `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora/raw/` |

In the citations below, `pipeline:` means the Pipeline repo at `a2d5bfb`, `fff:` the Factory repo at `da2529b`, `t22:` Token-2022 at `486240c`, `phi:` the pinocchio hook interface 0.1.0, and `kb:` the Jupiter and Meteora knowledge base.

## Short answer

- The containment hook must allow exactly two accounts per home market: the home market's vault for the contained mint, and the market's Pipeline fee account for that mint (the associated token account of the router PDA `["fees", market]`).
- The treasury needs no allowlist entry, because `sweep_fees` moves tokens out of the fee account, which is already allowed.
- Integrator fee accounts matter only when an integrator charges a fee on a sell, and if they are allowed at all they must be allowed as destinations only.
- The unlock is two Token-2022 calls signed by a PDA of the containment hook program: `TransferHookInstruction::Update` with no program id, then `SetAuthority(TransferHookProgramId, None)`.
- Both must be cleared, not just the program id, because Meteora's DAMM v2 and DLMM accept a hooked mint permissionlessly only when both the hook program id and the hook authority are unset, which is also what DBC does at graduation.
- After the unlock the router and integrators need nothing new: Token-2022 skips the hook when the program id is null, and stale hook accounts are ignored.
- No program can read the swap event, and the router keeps no volume on chain, so the trustless volume counter belongs in the home market's strategy: our tax AMM should count the quote-side volume of router swaps in its market state, and the hook's permissionless `unlock` should read it.
- Pipeline's `test-hook` allowlist fails open when a caller leaves out its extra accounts, so the containment hook must not start from it; the Factory's hook shows the fail-closed pattern to copy.

## 1. Every transfer of a contained token in Pipeline's flows

Call the contained token H.
These are all the Token-2022 transfers of H that the router or a strategy makes, and therefore every call into the transfer hook.

| Flow | Transfer of H | Made by | Source: cite |
| --- | --- | --- | --- |
| Sell H | trader's H account to the home market's H vault | router, authority trader | `pipeline:programs/pipeline/src/lib.rs:472` |
| Sell H | trader's H account to the market's H fee account, `ceil(net_sent x 0.25%)`, never zero when `net_sent > 0` | router | `pipeline:programs/pipeline/src/lib.rs:540-552`, `pipeline:crates/pipeline-strategy-interface/src/lib.rs:365-399` |
| Sell H with an integrator fee | trader's H account to the integrator fee account, any H token account the trader passes | router | `pipeline:programs/pipeline/src/lib.rs:554-571`, `:1190-1192` |
| Sell H exact-out | refund from the H vault back to the trader, if the strategy refunds | strategy | `pipeline:docs/INTEGRATOR-GUIDE.md` section 6 ("Exact-out with transfer-fee input tokens") |
| Buy H | the home market's H vault to the trader's output account | strategy, authority the strategy's vault owner | `pipeline:programs/test-strategy-cp/src/lib.rs:177-245` |
| Sweep | the market's H fee account to the treasury owner's H associated token account | router, signed by the `["fees", market]` PDA | `pipeline:programs/pipeline/src/lib.rs:602-648` |
| Seeding or a liquidity custom action | depositor or seeder escrow to the H vault | strategy | `pipeline:programs/test-strategy-cp/src/lib.rs:65-120`, `:255-310` |

On a buy the Pipeline fee and any integrator fee are taken in the input mint (SOL or USDC), so they never touch H (`pipeline:programs/pipeline/src/lib.rs:540-571`).
The fee account address is pinned: it must equal the associated token account of `["fees", market]` for the input mint (`pipeline:programs/pipeline/src/lib.rs:412-421`; seed `b"fees"` at `pipeline:crates/pipeline-strategy-interface/src/lib.rs:41`).
It must exist before the first sell, and anyone can create it with the idempotent `init_fee_account` (`pipeline:programs/pipeline/src/lib.rs:360-379`).
The router does not check who owns the trader's output account, only its mint and token program (`pipeline:programs/pipeline/src/lib.rs:453-470`), so a buy can deliver H to any H account.
`sweep_fees` really runs the hook: Pipeline's audit test drives a hostile hook inside it (`pipeline:crates/pipeline-tests/tests/sos2_h006.rs:1-18`).

### What Pipeline's own tests prove

- An allow-all hook works for buys and sells through the router (`pipeline:crates/pipeline-tests/tests/token2022.rs:175-233`).
- A hook that allows only the vault lets buys through and refuses sells, because the Pipeline fee transfer goes to a fee account that is not allowed; adding the fee account to the allowlist makes sells work (`pipeline:crates/pipeline-tests/tests/token2022.rs:236-334`).
- Pipeline documents the same limit: "A mint whose hook rejects transfers into the market's fee account cannot be sold through Pipeline, though it can be bought" (`pipeline:docs/INTEGRATOR-GUIDE.md:96`).

## 2. The allow rule that contains H

The Factory's hook and Pipeline's `test-hook` both pass a transfer when its source or its destination is allowed (`fff:programs/transfer-hook/src/instructions/transfer_hook.rs:94-111`; `pipeline:programs/test-hook/src/lib.rs:42-58`).
With the allowed set equal to {home market's H vault, market's H fee account}, every flow in the table passes:

- sells pass on the destination (vault, then fee account);
- buys and exact-out refunds pass on the source (vault);
- sweeps pass on the source (fee account), so the treasury account needs no entry;
- seeding and liquidity deposits pass on the destination (vault).

And the transfers a vamp needs are refused:

- a wallet to another wallet, or to a vamp pool's vault (neither side allowed);
- a vamp pool's vault to a buyer (neither side allowed);
- a second Pipeline market for H, whose vault is not allowed, so it cannot even be funded.

The property that makes this sound: the only allowed accounts that can be a source are moved by programs, the vault by the home market's strategy and the fee account only by the router's `sweep_fees`.
So every transfer of H touches the home market, and H that sits anywhere else can only move back into the home market.
H that a buyer delivers straight to someone else's account, or that the treasury receives from a sweep, is stuck there until the unlock except for selling into the home market; that is a gift or a sale, not an escape.

### Integrator fee accounts

The router takes the integrator fee in the input mint, so on a sell of H it is paid in H to whatever H account the integrator passed (`pipeline:programs/pipeline/src/lib.rs:1190-1192`).
With a rate of zero the router makes no transfer at all: `ceil_bps(x, 0)` is 0 and the transfer is guarded by `if integrator_fee > 0` (`pipeline:crates/pipeline-strategy-interface/src/lib.rs:275-282`, `pipeline:programs/pipeline/src/lib.rs:555`).
So integrators can always trade a contained token by charging no fee on its sells; buys carry their fee in SOL as usual.
If integrators are to earn fees on sells, their H fee accounts must be allowed, and they must be allowed as destinations only.
Allowed as a source too, as the plain "source or destination" rule would make them, an integrator fee account becomes an escape: anyone can send H into it and its owner, a wallet, can send H on to a vamp.
The rule then becomes "pass if the source is in the allowed sources {vault, fee account}, or the destination is in the allowed destinations {vault, fee account, listed integrator fee accounts}".
The list of integrator fee accounts must be gated (set by the launcher, for example Pipescope's own), because a permissionless list would let a vamp list its own vault and run a bid-only pool that buys H from sellers.

### Fail closed: do not start from `test-hook`

Token-2022 calls the hook with only its four base accounts (source, mint, destination, authority) when the transfer does not include the hook's validation account; the validation account and every extra account are optional (`phi:src/instructions/execute.rs:139-179`; same in `spl-transfer-hook-interface` at `5949f23`, `interface/src/onchain.rs:15-55`).
Pipeline's `test-hook` approves any transfer when its whitelist account is missing (`pipeline:programs/test-hook/src/lib.rs:45-47`), so anyone can skip its allowlist by sending a plain `transfer_checked` that names the hook program but leaves out the validation account.
It is a test fixture, but `research/estimates.md` proposed starting from it; the containment hook must instead refuse every transfer unless the validation account and its config account are present and correct.
The Factory's hook does this: its Anchor accounts struct requires all seven accounts with a seeds check on the validation account, it refuses zero amounts, checks the mint's owner, and checks Token-2022's `transferring` flag on the source so that nobody can call `Execute` directly (`fff:programs/transfer-hook/src/instructions/transfer_hook.rs:23-57`, `:79-156`).
Token-2022 sets `transferring` on both accounts only for the duration of the hook call (`t22:program/src/processor.rs:611-636`; flag defined at `t22:interface/src/extension/transfer_hook/mod.rs:39-48`).
For confidential transfers Token-2022 passes `u64::MAX` as the amount (`phi:src/instructions/execute.rs:63-67`), so a contained mint should not carry the confidential transfer extension, or the hook must refuse that amount.

### Shape of the extra accounts

Every hook call in a router sell (vault, fee account, integrator) gets the same tail of hook accounts (`pipeline:programs/pipeline/src/lib.rs:447-450`, `:472-571`; Pipeline's audit item H040, "One hook tail serves three transfers", `pipeline:docs/SECURITY-AUDIT.md:695`).
Token-2022 resolves each extra account by key from the accounts it is given, so a superset works (`phi:src/instructions/execute.rs:229-247`).
The Factory resolves one whitelist PDA per side, seeded by the token account (`fff:programs/transfer-hook/src/instructions/initialize_extra_account_meta_list.rs:28-54`), so a router sell would need whitelist PDAs for the trader, the vault, the fee account and the integrator in one tail.
A containment hook whose only extra account is one fixed per-mint config PDA, holding the allowed sources and destinations, serves every transfer with a two- or three-account tail (hook program, validation account, config), well under the roughly 28 hook accounts that fit the default heap (`pipeline:docs/INTEGRATOR-GUIDE.md:105`).
Writability is passed through intact by the router and by the example strategy (`pipeline:programs/pipeline/src/lib.rs:833-840`, `pipeline:programs/pipeline/src/token.rs:148-155`), and Token-2022 de-escalates a writable extra account to read-only if the caller passed it read-only (`phi:src/instructions/execute.rs:262-284`); a read-only config avoids depending on every caller getting that right.

### Where the hook tails go, and who supplies them

- Sells: the router's `input_hook_accounts` (`pipeline:docs/INTEGRATOR-GUIDE.md:48-49`).
- Buys: after the strategy's own accounts, for the strategy's output transfer (`pipeline:docs/INTEGRATOR-GUIDE.md:48`; `pipeline:crates/pipeline-tests/tests/token2022.rs:219-226`).
- Sweeps: `sweep_fees`'s remaining accounts (`pipeline:programs/pipeline/src/lib.rs:641`).
- Neither Pipeline client resolves hook accounts; both take them from the caller (`pipeline:sdk/ts/src/instructions.ts:282-322`, `pipeline:crates/pipeline-client/src/lib.rs:430-492`), so Pipescope must resolve them from the validation account itself, and a fee sweeper that omits them gets a revert from a fail-closed hook.

### Call depth

On a buy the hook runs at the last nested level: router (1), strategy (2), Token-2022 (3), hook (4) (`pipeline:docs/ROUTER.md:156-158`).
So the containment hook must make no CPI in `Execute`, as the Factory's hook already does ("Makes no outbound CPIs", `fff:README.md:37`).

## 3. The unlock

### What Token-2022 allows

- A mint's `TransferHook` extension holds two fields, `authority` and `program_id`, both nullable (`t22:interface/src/extension/transfer_hook/mod.rs:30-37`), set by `InitializeTransferHook` before `InitializeMint` (`t22:program/src/extension/transfer_hook/processor.rs:25-51`).
- `TransferHookInstruction::Update` sets `program_id` to any value, including null, and must be signed by the current `authority` (`t22:program/src/extension/transfer_hook/processor.rs:53-86`).
- `SetAuthority` with `AuthorityType::TransferHookProgramId` replaces or clears the authority, signed by the current one (`t22:program/src/processor.rs:947-959`); once it is null, `Update` fails with `NoAuthorityExists` for good (`t22:program/src/extension/transfer_hook/processor.rs:67-68`).
- A non-multisig authority only has to be a signer (`t22:program/src/processor.rs`, `validate_owner`), so a PDA signs through `invoke_signed`.
- When `program_id` is null, Token-2022 does not call any hook during a transfer (`t22:program/src/processor.rs:432`, `:611`).

### The design this gives

1. The launcher creates the mint with `InitializeTransferHook(authority = PDA, program_id = containment hook)`, where the PDA is a per-mint address of the containment hook program such as `["unlock", mint]`, derivable before the mint exists.
2. The containment hook program exposes no instruction that calls `Update` except `unlock`, so nobody, the launcher included, can re-point or remove the hook early.
3. `unlock` is permissionless: anyone calls it, it checks that the unlock goal is met, then calls `Update(program_id = None)` and `SetAuthority(TransferHookProgramId, None)` signed by the PDA, in one instruction at depth 2.
4. Anyone can verify a contained mint: its hook authority equals that PDA and its hook program is ours.

That makes the unlock a keeper job only in the loose sense: it needs one call by anyone once the goal is met, and Pipescope can show the button.
The guarantee rests on the containment hook program itself: while it is upgradeable, its upgrade authority can change the rules or the unlock, so it must be frozen before any mainnet use.

### Why both fields must be cleared

- Meteora's DBC revokes "the transfer-hook program id and transfer-hook authority from the base mint" when a hooked curve completes (`kb:raw/meteora-docs/pages/core-products__dbc__transfer-hook-pools.md`, "Completion And Migration"), and all 519 migrated DBC hook mints on 2026-10-26 had both set to the zero key (`kb:raw/findings/2026-10-26-dbc-hook-routing.md:10`).
- DAMM v2 accepts `TransferHook` permissionlessly "only when both the hook program ID and hook authority are unset" (`kb:raw/meteora-docs/pages/core-products__damm-v2__token-2022-support.md:35`, `:104`), and so does DLMM (`kb:raw/meteora-docs/pages/core-products__dlmm__token-2022-support.md:27`, `:55`).
- So clearing only the program id would leave the token barred from permissionless Meteora pools, which defeats "composable everywhere".

### After the unlock

- Token-2022: transfers skip the hook; the mint keeps a `TransferHook` extension with both fields null, and token accounts keep their `TransferHookAccount` extension (required for any mint with the extension, `t22:interface/src/extension/mod.rs:1303`).
- Because of that leftover extension, the deprecated `Transfer` instruction without a mint still fails with `MintRequiredForTransfer` (`t22:program/src/processor.rs:440-447`); routers and wallets use `transfer_checked`, and graduated DBC mints are in the same state.
- Router: it does not track hooks at all; integrators stop passing hook accounts, and any stale ones they still pass are appended to `transfer_checked` and ignored by Token-2022 (`pipeline:programs/pipeline/src/token.rs:121-123`).
- Off-chain resolvers add no hook accounts for a null program id (`t22:program/src/offchain.rs:191`).
- Other routers: Jupiter's Metis did not route live DBC hook pools, but routed the DAMM v2 pools of 4 of 4 graduated hook mints, and Jupiter's own program made 48% of their post-graduation swaps (`kb:raw/findings/2026-10-26-dbc-hook-routing.md:15`, `:19`).
- Before the unlock, only routers that forward hook accounts carry hooked pools (OKX, DFlow and Axiom carried 85% of DBC hook-pool swaps, same file, `:40`); for Pipeline markets this is moot, because a contained token can only trade in its home market anyway.

## 4. Measuring home-market volume trustlessly

### What a program cannot use

- The swap event: the router emits `SwapEvent` through a self-CPI (`pipeline:programs/pipeline/src/lib.rs:574`); inner instructions are not part of the transaction's message, and the instructions sysvar holds only "the serialized instructions in a Message" (https://docs.anza.xyz/runtime/sysvars), so no program sees it.
- Router state: the router's `Market` account holds no volume, only the strategy, market state, mints, vaults, flags, creator, creation time and bumps (`pipeline:programs/pipeline/src/lib.rs:934-947`).
- The fee account's balance: `sweep_fees` empties it and anyone can call it (`pipeline:programs/pipeline/src/lib.rs:601-648`), and anyone can transfer into it.

### What can work

| Option | How | Counts | Weak points |
| --- | --- | --- | --- |
| A. Counter in the home market's strategy (recommended) | Our tax AMM adds the quote-side amount of every `pipeline_swap` signed by the market signer to a cumulative field in its market state; the hook's `unlock` reads that account after checking its owner and address | Router swaps only, in SOL (or the quote mint), matching the swap events Pipescope charts | Works only for home markets on strategies that keep such a counter (in v1, ours); trusts that strategy's code, so the tax AMM must be frozen too |
| B. Counter in the hook | A writable per-mint state account in the hook's extra accounts; `Execute` adds the amount of every transfer into or out of the home vault, after the `transferring` check | Trades in H units, including bypass trades | Also counts seeding, liquidity custom actions and donations, so an open liquidity action makes the goal free to fake; every transfer of H write-locks the counter; callers must pass it writable |
| B'. Count only Pipeline fees into the fee account | The hook adds transfers into the H fee account; sell volume is about 400 times that | Router sells only | Donations into the fee account count too, so faking volume V costs only 0.25% of V, with no tax; buys are invisible |
| C. Wrapper that reads the router's return data | A program that CPIs the router can read `SwapResult` (`net_sent`, `received`, fees) from return data (`pipeline:programs/pipeline/src/lib.rs:589-597`) and record it | Only swaps made through the wrapper | Direct router swaps are missed; uses the one spare call-depth level |

Faking volume under option A costs per unit the Pipeline fee (0.25%), the market's fee and its tax; the cheapest gamer is whoever receives the tax, since they get most of their tax back.
A third party trying to unlock a token early in order to vamp it pays the full tax, so the cost falls on the party the unlock goal guards against.

## 5. Other things the design depends on

- Binding the home market: the hook's config must hold the vault and fee account before the first deposit; the fee account follows from the market address, the vault only from the strategy (recorded in the router's `Market.vaults`, `pipeline:programs/pipeline/src/lib.rs:789-810`).
- A first-come binding is open to front-running, so binding should be signed by the launcher, write-once, and done before seeding; with `pipeline_seed_liquidity`, which creates and funds a market in one call, the vault address must be computed in advance (for the example strategy it is the pool's associated token account, `pipeline:crates/pipeline-tests/tests/token2022.rs:250-252`).
- Minting and burning do not call the hook (only `transfer_checked` paths do, `t22:program/src/processor.rs:611-636`), so a launcher can mint supply before binding, and a fail-closed hook can refuse every transfer until the config exists.
- Router upgrades: the fee account's derivation belongs to the router, which is upgradeable on devnet; if a router upgrade changed it, sells of contained tokens would fail until their unlock (unverified risk, nothing in the repo plans it).
- A contained token is a honeypot vector by construction: if the home market's strategy breaks or is upgraded badly, holders cannot move H anywhere; Pipescope's exit test still applies, since sells into the home market are the allowed way out.
- The Factory is no unlock precedent: its hook has no unlock path, its whitelist is append-only and global to the program, and the transfer-hook authority on its three mints is a 2-of-3 Squads vault with a 24-hour timelock that has not been burned (`fff:README.md:25-26`, `:64-75`; `fff:programs/transfer-hook/src/instructions/add_whitelist_entry.rs`).
- Not measured: the compute cost of the hook on each of the three hooked transfers in a sell.

## Recommendation

1. Write a new fail-closed containment hook on the Factory's pattern (all accounts required, `transferring` check, no CPI, zero amounts refused), with one read-only per-mint config PDA as its only extra account.
2. Allowed sources are the home market's H vault and the H fee account; allowed destinations are those two plus an optional, launcher-set, write-once list of integrator fee accounts; never let an account a wallet controls be an allowed source.
3. Make the mint's transfer-hook authority a PDA of the hook program, give the program a single permissionless `unlock` that clears both the hook program id and the hook authority, and freeze the hook program before mainnet.
4. Count the unlock goal in our tax AMM's market state as cumulative quote-side volume of router swaps, and have `unlock` read it; support home markets on other strategies later, if at all.
5. Pipescope resolves hook tails for contained tokens itself, charges no integrator fee on their sells unless its fee account is listed, shows the unlock state, and offers the unlock call once the goal is met.
