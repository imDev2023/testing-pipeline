# Prior art for behavioural testing of Solana programs

Researched on 2026-11-09 for [#8](https://github.com/imDev2023/testing-pipeline/issues/8), which feeds [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14).
Pipeline's source was read from a scratchpad clone at commit `a2d5bfb`; Jupiter facts come from the owner's knowledge base at `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora` (paths below are relative to it, with the live URL where the mirror gives one).
Everything is dated 2026-11-09 unless a source says otherwise; anything not checked against its own primary source is marked unverified.

## The answer in brief

- No tool found tests an arbitrary Solana market program's behaviour from outside.
  The Solana token scanners read static mint and holder state; none documents a simulated buy and sell (see "Solana token scanners").
- The closest prior art is on EVM, where token code is arbitrary in the way Pipeline strategies are: Honeypot.is simulates a buy and a sell and replays sells from real holders, and HoneyCheck (an October 2026 paper) adds a wait between buy and sell, a quote-against-sale comparison and published false-positive figures.
- On Solana, the nearest things are Jupiter's own gates: a $500 buy-then-sell round trip that every routed market must pass every 30 minutes, and `jupiter-amm-test-kit`, which asserts in LiteSVM that a swap's token deltas equal its quote exactly.
- Every simulator reviewed tests only the state at one moment.
  Each documents, or is shown to have, the same blind spots: restrictions added after the buy (a later blacklist, fee change or upgrade), and code that detects it is being simulated.
- Simulated "cannot sell" checks have very few false positives (HoneyCheck: 0 of 967 benign tokens); their errors are mostly false negatives, and the false positives that do occur come from benign mechanisms such as cooldowns and presale locks.
- Canary can close the blacklist gap that EVM simulators leave open, because LiteSVM runs without signature checks: it can act as each authority, use its powers, and re-run the exit test.

## Solana token scanners

None of the seven checked documents a buy-then-sell test on Solana, and none inspects the market or pool program, its upgradeability or its upgrade authority.
They read mint, metadata and holder state and indexed history.

- **RugCheck** (no public docs or methodology; its GitHub organisation has no public repositories): a live report for BONK has `mint`, `token` (mint and freeze authority), `token_extensions`, `tokenMeta`, `topHolders` (with an `insider` flag), `lockers`, `markets`, `risks`, `score` and `score_normalised` (https://api.rugcheck.xyz/v1/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/report, read 2026-11-09).
  Its `markets` entries name a known DEX type (`marketType`), the mints, liquidity accounts and an LP-lock block, with no program id or upgrade authority, so an unknown market program is invisible to it.
  Risks seen in live reports include "Mutable metadata", "Freeze Authority still enabled", "Creator history of rugged tokens", "Single holder ownership" and "High holder concentration"; a research agent found the raw score to be the sum of the risk scores plus one, and the official risk list and the normalisation are not published (unverified).
  Reports are cached; a fresh scan (`refresh`) needs a paid key, per its Swagger spec (https://api.rugcheck.xyz/swagger/doc.json, read by a research agent).
- **GoPlus, Solana (Beta)** reads Token-2022 state: `default_account_state`, `non_transferable`, `transfer_fee` with `scheduled_fee_rate` and its `epoch`, `transfer_hook` (address and whether it is a known malicious address), and whether each power is still live: `mintable`, `freezable`, `closable`, `metadata_mutable`, `transfer_fee_upgradable`, `default_account_state_upgradable`, `transfer_hook_upgradable` and `balance_mutable_authority` (the permanent-delegate case); pools appear only as DEX name, address and statistics (https://docs.gopluslabs.io/reference/response-detail-1.md).
  It warns that a hook "may block user from trading" but does not run it, mentions no sell test, and says a `trusted_token` value other than "1" "does not indicate that the token is untrustworthy" (same page).
  A separate endpoint simulates one transaction the caller supplies and reports asset and ownership changes (https://docs.gopluslabs.io/reference/preruntxusingpost.md, read by a research agent); it is a building block, not an exit test.
- **Birdeye** says it plainly: "There is no honeypot flag on Solana, because the equivalent danger is a live freeze authority", and "On Solana, there is no exit liquidity endpoint" (https://data.birdeye.so/docs/use-cases/risk-and-integrity/rug-checker.md).
  Its Solana security fields cover creator and owner holdings, metadata authority, top-10 concentration, `freezeAuthority`, `transferFeeData`, `nonTransferable` and `jupStrictList`, but no transfer hook, permanent delegate or default account state; `isHoneypot`, `buyTax` and `sellTax` exist only in its EVM schema (https://data.birdeye.so/docs/data-api/security/get-defi-token-security.md, read by a research agent).
- **Webacy** measures buy and sell tax "by simulating a swap" on EVM chains only; on Solana it reports the Token-2022 transfer fee as the tax, with a 5-minute cache (https://docs.webacy.com/api-reference/trading-lite/get-simplified-token-analysis-with-security-indicators.md, read by a research agent).
- **Solsniffer** claims "+22 indicators" with "its own logic" and a "proprietary algorithm" score, and names none of them (https://solsniffer.gitbook.io/solsniffer-user-guide/product-snif-tokens/token-sniffer, read by a research agent); its site returned HTTP 403.
- **De.Fi Scanner**'s documentation covers Solidity code only (https://docs.de.fi/security-toolkit/scanner.md); a Solana scanner in its Telegram bot is mentioned only in a blog recap, and its checks are unverified.
- **DexScreener** runs no documented checks of its own; it refers only to unnamed "third-party audit partners" and disclaims any warranty about tokens (https://docs.dexscreener.com/llms-full.txt, read by a research agent).
- **False positives**: none of them publishes an accuracy, false-positive or false-negative figure.
- **Why they stop at the mint**: on Solana most tokens share the SPL Token program and trade on a handful of known AMMs, so a freeze authority or a Token-2022 extension is the only place a sale can be blocked; Pipeline strategies break that assumption, because the market program itself is arbitrary code, as EVM tokens are.

## Jupiter's gates: the nearest Solana prior art

- **Routing gate.** Jupiter's docs say "Every 30 minutes, the routing engine re-checks the liquidity of each market", and markets that fail "are removed from routing".
  A market must pass one of two tests: less than 30% loss on a $500 buy sold straight back on the same market (`($500 - Final USD value) / $500`), or less than 20% difference in price per token between a $1000 buy and a $500 buy (`raw/jupiter-developers/pages/swap__routing__amm__market-listing.md`, from https://developers.jup.ag/docs/swap/routing/amm/market-listing).
  This is a liquidity test, not a honeypot test, but it is a buy-then-sell round trip that re-runs on a schedule, which is the shape of Canary's exit test.
- **Quote parity.** To be routed, an AMM implements the `Amm` trait and proves parity with `jupiter-amm-test-kit`, which "snapshots a live pool, runs your `Amm::quote`, executes your program's native swap instruction in LiteSVM, and asserts the on-chain token deltas equal the quote exactly" (`raw/jupiter-developers/pages/swap__routing__amm__integration.md`, from https://developers.jup.ag/docs/swap/routing/amm/integration).
  The kit's own limits, from https://github.com/jup-ag/jupiter-amm-interface/tree/main/test-kit (README last changed at `11def4a`, 2026-10-20): exact-in only; one native instruction per swap; the swap must work as a plain top-level instruction, so "programs that introspect the instructions sysvar" cannot be driven; one signer; fresh token accounts, so transfer-hook side accounts may not work; and "the SVM clock pinned to the snapshot moment".
  Canary's quote against swap is the same test, run by the integrator instead of the AMM's author, so it should not inherit the kit's fixed clock or its exact-in limit.
- **Prerequisites are human.** Jupiter also weighs "code health", a "security audit", "traction" and team, and integrates only AMMs it chooses (same integration page).
- **Programs may legitimately tell flows apart.** Jupiter documents a signer that jup.ag adds to its own trades so that prop AMMs "can identify this flow" and "quote it tighter spreads" (same integration page).
  So a market that treats traders differently by who they are or how the transaction is built is not exotic, and Canary must assume a strategy can do it.
- **JupShield and the Tokens API.** JupShield shows warnings such as "Not Sellable, Not Verified, Low Liquidity, Low Organic Activity, or New Listing" on verification submissions, and they "do not automatically lead to a rejection" (`raw/jupiter-docs/pages/user-docs__launch__vrfd__faq.md`); swap pages also show Has Freeze Authority, Has Mint Authority and transfer-fee rates (`jupiter/01-products-user-docs.md`, section 2.15).
  How "Not Sellable" is decided is not documented (unverified).
  The Tokens API's `audit` object carries only `isSus`, `mintAuthorityDisabled`, `freezeAuthorityDisabled`, `topHoldersPercentage`, `devBalancePercentage` and `devMints`, and the docs warn that `isSus` is present only when flagged and "not all risky tokens will have this flag" (`raw/jupiter-developers/llms-full.txt`, lines 2672 to 2803).
  Jupiter says the spam, honeypot and "not sellable" warnings in wallets such as Phantom come from third parties "such as Blockaid" that it does not control (`user-docs__launch__vrfd__faq.md`).

## EVM honeypot simulators: the closest analogue

### Honeypot.is

- `GET /v2/IsHoneypot` takes a token or pair address, picks "the most suitable pair based on liquidity" unless told, and can simulate liquidity for a token not yet listed; no API key was needed on 2026-11-09 (https://docs.honeypot.is/ishoneypot).
- It returns `simulationSuccess`, `honeypotResult.isHoneypot` with a `honeypotReason`, and `simulationResult` with `buyTax`, `sellTax`, `transferTax`, `buyGas`, `sellGas`, and `maxBuy` and `maxSell` "only ... if we detected them" (same page).
- **Holder analysis** replays sells from real holders: `holders` is "the amount of holders that we have analyzed, and NOT the number of actual holders", `successful` and `failed` count those who can and cannot sell, and `siphoned` counts holders whose tokens moved without consent (same page).
  A live call for PEPE on Ethereum analysed 14,885 holders, of which 14,884 could sell and 1 could not (https://api.honeypot.is/v2/IsHoneypot?address=0x6982508145454Ce325dDbE47a25d4ec3d2311933&chainID=1, called 2026-11-09 by a research agent).
- **Contract checks** come from the execution trace: `openSource` requires "every single contract called during the buy/sell process" to be open source, and `hasProxyCalls` flags any delegatecall on the path; "the results from here are cached and may be outdated" (same page).
- **Flags and thresholds**: sell-failure rates, siphon rate above 10%, `transfer_blocked` for non-DEX transfers, taxes above 21%, 40% and "generally >50%", sell gas of 2M and 3.5M, sniper wallets that cannot sell, low sell limits and one sell per block; "flags can be added/removed, as well as their threshold for getting triggered can change" (https://docs.honeypot.is/summary_flags).
- **Time and upgrades**: nothing documented; which wallet buys, what sizes and whether a fork is used are not documented either (unverified).
- **False positives**: "In some very rare cases, legit transfers are marked as siphoned - we are working on reducing the false positives" (https://docs.honeypot.is/ishoneypot); no rate is published.

### GoPlus token security (EVM)

- Behaviour fields include `is_honeypot`, `cannot_buy`, `cannot_sell_all`, `buy_tax`, `sell_tax`, `transfer_tax`, `trading_cooldown`, `transfer_pausable`, `slippage_modifiable` (owner can change the tax), `personal_slippage_modifiable` (per-address tax), `is_blacklisted`, `is_whitelisted`, `is_anti_whale` and `anti_whale_modifiable`; owner fields include `owner_change_balance`, `hidden_owner`, `can_take_back_ownership`, `is_proxy`, `external_call` and `is_mintable` (https://docs.gopluslabs.io/reference/response-details).
- The docs do not label fields as simulated or static, but the tax fields carry sandbox caveats that imply simulation: "A token's anti-bot mechanism may affect our sandbox environment, resulting in a "cannot_buy" of "1"" (and a buy tax of 1), and "Sometimes token's trading-cool-down mechanism would affect our sandbox system" (sell and transfer tax); "When the contract is closed-source, other risk items will return null", which implies the owner fields come from source analysis (same page).
- Its useful idea for Canary is the owner-capability list: who can change fees, pause, blacklist or move balances later.

### HoneyCheck (Cernera, La Morgia, Mei, Sassi, arXiv 2610.10149, 2026-10-07)

- "Pump-and-Dump meets Honeypot Tokens: Detection and Analysis of Telegram Bait-and-Trap Schemes" builds a "transaction-simulation tool that detects honeypot tokens before purchase" on Ethereum and BNB Smart Chain, and releases it as open source (https://arxiv.org/abs/2610.10149; all quotes below are from https://arxiv.org/html/2610.10149v1).
- **Method**: on a local fork, a freshly generated address buys "0.1% of the pool liquidity, with a minimum trade value of $10", approves, waits, and sells its whole balance; it compares the router's `getAmountsOut` quote with what the sale really returns and flags buy or sell fees above 90%.
- **Time**: it waits τ = 0, 1, 5 and 10 seconds and longer, advancing the fork by the matching number of blocks, to catch tokens that "permit selling only in the same block as the purchase or within a few subsequent blocks"; "without this delay, an immediate sell may succeed and incorrectly suggest that the token is freely sellable".
  Waiting found 62, 187 and 191 more honeypots at 1, 5 and 10 seconds than an immediate sale, and "no further changes for larger values".
- **Who trades**: it found allowlisted "colluding addresses" (4,039 of them) by replaying the sequence from them "instead of a freshly generated one, confirming that, unlike the fresh address, it can both buy and sell freely".
- **False positives**: all 967 tokens on PancakeSwap's reviewed list were "correctly" classed as not honeypots, and "we observe no positive classification that contradicts the provided labels"; it agreed with 1,676 of 1,859 externally labelled honeypots (90.2%).
  On the same 1,859, Honeypot.is found 87.1% and GoPlus 59.6%; most of Honeypot.is's misses were "unknown" (the pool no longer had liquidity) or "low risk" (the behaviour had stopped), because commercial tools test present state rather than the state at purchase.
- **Stated limits**: it "cannot detect blocklist-based honeypots", where the owner blacklists buyers in a later transaction, because "a single buy-then-sell sequence at a fixed block ... cannot capture restrictions that are introduced only after the purchase"; trading that is disabled until a presale completes "is a common and benign practice"; and "more sophisticated anti-simulation mechanisms" are future work.

### Older academic detectors

- HoneyBadger (Torres et al., USENIX Security 2019) finds honeypots that bait exploiters, not tokens that block sales, by symbolic execution of bytecode; "87% of the reported contracts are indeed honeypots" (https://arxiv.org/abs/1902.06976).
- "Trade or Trick?" (Xia et al., SIGMETRICS 2021) classifies Uniswap scam tokens from transaction behaviour with 96.45% precision and 96.79% recall (https://arxiv.org/abs/2109.00229, section 4.5).
- CRPWarner reports 84.9% precision on 13,484 real contracts (https://arxiv.org/abs/2403.01425), and TrapHunter, which adds "fork-based dynamic validation" to static and LLM analysis, reports 81.8% precision and 85.4% recall on 269 contracts (https://arxiv.org/abs/2607.18753); both figures are from the abstracts, read by a research agent.
- On Solana, "From Hype to Collapse" labels 76,469 of 100,063 new Orca, Raydium and Meteora tokens of the first half of 2025 as rug pulls (freeze-authority abuse, liquidity withdrawal, pump-and-dump), with "a labeling false-positive rate of 0.26%" from a manual audit of 382 samples (https://arxiv.org/abs/2603.24625); no Solana paper found measures a simulation-based detector.

## Wallet transaction simulation

- Blowfish, bought by Phantom (Blowfish's post is dated 2024-11-19, https://web.archive.org/web/20241204113915/https://blog.blowfish.xyz/blowfish-phantom-our-next-chapter-in-crypto-security/), simulated Solana transactions for wallets; its docs no longer load, so these facts come from an archived copy of its Solana scan reference (2024-09-08, https://web.archive.org/web/20240908192154/https://docs.blowfish.xyz/reference/scan-transactions-solana).
- It reported state changes (SOL and SPL transfers, approvals, owner changes) and warned on, among others, `BFP_LOADER_AUTHORITY_CHANGE` ("It allows the new authority to change the deployed program at any time"), `TRADE_FOR_NOTHING`, `IMBALANCED_DOLLAR_VALUE` and `RELIABLE_SIMULATION_NOT_POSSIBLE`.
- It documented simulation evasion directly: state changes "potentially non-deterministic due to simulation spoofing attacks" come with a `RELIABLE_SIMULATION_NOT_POSSIBLE` warning of `CRITICAL` severity.
- Its token warnings included `HONEYPOT`, `HIGH_TRADING_TAX`, `TRADING_TAX_MODIFIABLE`, `TRADING_COOLDOWN`, `TRADING_CAN_BE_STOPPED`, `BALANCES_MODIFIABLE` and `BLOCKLIST_ALLOWLIST`, mirroring GoPlus.
- Blockaid, which Jupiter names as Phantom's token-warning source, now keeps its docs behind a login (https://docs.blockaid.io/docs/token-scanning redirects to a login page); its blog describes token scanning as "a multi-layer detection engine" across static and LLM code review, on-chain behaviour, market signals, fund tracing and metadata, with no false-positive rate (https://blockaid.io/blog/how-share-protected-copy-traders-from-malicious-tokens-with-blockaid).
  Whether Blockaid simulates a sale on Solana, and how it decides "not sellable", is unverified.

## Solana fuzzers and analyzers

- **Trident** (Ackee Blockchain) is a "manually-guided" stateful fuzzer whose instruction sequences ("flows") are written by hand, because random sequences are mostly invalid; it runs on its own TridentSVM over Anza's SVM API, not LiteSVM (https://github.com/Ackee-Blockchain/trident).
  Its client can `warp_to_epoch`, `warp_to_slot`, `warp_to_timestamp` and `forward_in_time` (`crates/fuzz/src/trident/client.rs`), and it can load a program dumped from a cluster, but "coverage is only gathered for the programs deployed through an entrypoint", which needs the source (https://github.com/Ackee-Blockchain/trident/blob/master/documentation/docs/trident-manifest/index.md).
  It is a tool for a program's author, not for testing someone else's deployed program.
- **Sec3 X-ray** is open-source static analysis that parses Rust source to LLVM-IR, so it needs source; its rules include arbitrary CPI, account cosplay, unvalidated bump seeds and rule 1017, `MaliciousSimulation`: "Detects potentially malicious code that simulates transactions" (https://github.com/sec3-product/x-ray).
- **FuzzDelSol** ("Fuzz on the Beach", ACM CCS 2023) is "the first binary-only coverage-guided fuzzing architecture for Solana smart contracts", evaluated on 6,049 contracts, with no precision figure in the abstract (https://arxiv.org/abs/2309.03006).
- **LiteSVM 0.18.2**, which Pipeline's quoter pins, has `send_transaction` (commits state) and `simulate_transaction`, which takes `&self` and so never commits, plus `warp_to_slot`, which moves only the slot, and `set_sysvar` for the whole clock (`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/litesvm-0.18.2/src/lib.rs`, lines 1580 to 1697).

## Upgrades: how others keep a verdict current

- OtterSec's verified-builds service (https://github.com/otter-sec/solana-verified-programs-api, `d2c2ba9`, 2026-09-10) listens for `UPGRADE_PROGRAM_INSTRUCTION` on the upgradeable loader through a Helius webhook and marks an upgraded program unverified; "all programs are also fetched every ~5 minutes in case a webhook is missed or a program is closed".
  Its `GET https://verify.osec.io/status/<program>` returns `is_verified`, `on_chain_hash`, `executable_hash`, `repo_url`, `last_verified_at`, `is_frozen` and `is_closed` (live calls, 2026-11-09).
  For Pipeline's router, which is on devnet only, it answered "On chain program not verified" with an empty hash, so the service appears to watch mainnet only (inference).
- The upgradeable loader's `ProgramData` account holds `slot`, the "Slot that the program was last modified", and the upgrade authority (https://docs.rs/solana-loader-v3-interface/latest/solana_loader_v3_interface/state/enum.UpgradeableLoaderState.html); the quoter skips this 45-byte header when it loads a program and has `load_program` to reload one "after an upgrade" (`crates/pipeline-quoter/src/lib.rs`, lines 173 to 190).
- Jupiter re-checks every market's liquidity every 30 minutes (routing gate above); Honeypot.is caches some results and warns they "may be outdated".
- No tool found re-runs a behavioural simulation on every upgrade of the program under test; Canary's rule that checks attach to strategy versions has no direct precedent.

## What Pipeline already guarantees, and what it leaves to Canary

- The router stops a hostile strategy from taking more from the trader, refunding more than was sent, re-entering the router, paying output elsewhere, moving collected fees, taking the trader's lamports or pulling input as a permanent delegate; every attack fails the whole transaction (`programs/test-strategy-evil/src/lib.rs`, `crates/pipeline-tests/tests/adversarial.rs` and `security.rs`).
  Canary need not test these again.
- The router does not stop: a quote that lies (the hostile strategy's `QuoteLies` quotes 2,000 for 1,000 and pays 1,000; only the trader's minimum catches it), a quote that never ends (`QuoteHog`, stopped by the quoter's 200,000-unit cap), a strategy that refuses or shrinks sales, behaviour that changes with time, state or who trades, custom actions that move liquidity or change fees, and bypass (`crates/pipeline-tests/tests/quoter.rs`, lines 289 to 345; `docs/STRATEGY-GUIDE.md`, section 2).
  These are Canary's job.
- The strategy guide's rules "quote and swap must agree" and "be deterministic" (results may depend only on the accounts, the instruction data and the Clock and Rent sysvars) are not enforced by the router (`docs/STRATEGY-GUIDE.md`, section 2, rules 1 and 3).
- `Quoter::simulate_swap` runs the whole router swap for a new random keypair each time, with synthetic token accounts, through `simulate_transaction`, and returns only the router's result (`crates/pipeline-quoter/src/lib.rs`, lines 480 to 543).
  So it cannot chain a buy into a sale on the same wallet: the exit test needs a harness that commits the buy with `send_transaction` on a copy of the market's accounts.
- The quoter builds its LiteSVM with `with_sigverify(false)` (`crates/pipeline-quoter/src/lib.rs`, line 152), so a harness built the same way can sign as any key, including a strategy's upgrade authority or a market's admin, without its private key.
- `Quoter::set_clock` sets slot, epoch and Unix time together, and the epoch also picks the Token-2022 transfer fee (`crates/pipeline-quoter/src/lib.rs`, lines 222 to 231).
- The integrator guide asks for "neutral facts and no judgements" (upgradeable or frozen, mint and freeze authorities, liquidity, market age, volume) and says "Pipeline does not vet strategies" (`docs/INTEGRATOR-GUIDE.md`, section 5).
- Licence: the router is BSL 1.1 with "Additional Use Grant: None", which allows only "non-production use" (`programs/pipeline/LICENSE`), yet `simulate_swap` executes the router's program and the integrator guide recommends it (`docs/INTEGRATOR-GUIDE.md`, line 33).
  Whether running the router's bytecode inside Canary counts as production use is a question for MetalLegBob.
  The fallback is to call the strategy's `pipeline_swap` directly with the market signer marked as a signer (possible with signature checks off, unverified) and apply Pipeline's Apache-licensed `pipeline_strategy_interface::settlement::settle` to the measured balances (`crates/pipeline-strategy-interface/src/lib.rs`, line 365).

## Recommendation: what Canary should add

Each item names the prior art it comes from.

### Exit test

1. **A committed round trip per wallet**: buy, then sell the whole balance from the same wallet in state that keeps the buy, as HoneyCheck does; two independent `simulate_swap` calls would miss a strategy that records its buyers.
2. **Many fresh wallets plus the insiders**: run the round trip from several random keypairs and from the market creator, the strategy's upgrade authority and any signer named in the strategy metadata's custom actions; a difference between the two groups is itself a finding (HoneyCheck's colluding addresses; GoPlus's `is_whitelisted`).
3. **A size ladder tied to liquidity**: start at 0.1% of the market's vault value with a small floor (HoneyCheck), include the equivalent of Jupiter's $500 benchmark, and climb; report the largest sale that succeeds (Honeypot.is `maxSell`) and the round-trip loss at each size, and show Jupiter's two thresholds as a neutral "would pass Jupiter's liquidity gate" fact rather than a fail.
4. **A time ladder**: sell in the same slot, one slot later, and after about 5 seconds, 10 seconds, 1 minute, 10 minutes, 1 day and one epoch, setting slot, epoch and Unix time together with `set_clock` (HoneyCheck's τ, extended for Solana's clock-based vesting and epoch-based Token-2022 fees).
5. **Sales of tokens that did not come from the market**: a wallet that received the token by plain transfer must also be able to sell, and a plain transfer between wallets must work (Honeypot.is `transferTax` and `transfer_blocked`).
6. **Say why a sale failed**: the strategy refused, the token refused (transfer hook, freeze, default-frozen accounts, non-transferable), the market's fee account was missing, or the strategy ran out of compute; Pipeline's integrator guide lists the token-side causes (`docs/INTEGRATOR-GUIDE.md`, section 6).
7. **Sell compute**: report the compute units a sale uses against the buy and against the transaction limit (Honeypot.is's gas flags).

### Quote against swap

1. **Exact equality**: the router-measured result of a committed swap must equal `Quoter::quote` for the same state, byte for byte, as `jupiter-amm-test-kit` asserts; any difference fails, because Pipeline's guide requires both to come from one function.
2. **Both directions, the size ladder and, where `supports_exact_out` is set, exact-out**, which Jupiter's kit does not cover.
3. **At the real clock and after moving it**, not pinned to the snapshot moment as the kit is.
4. **Within the quoter's compute cap**: a quote over 200,000 units is reported as "cannot be quoted off-chain" (the hostile `QuoteHog`).

### Fee honesty

1. **Measure realised cost, not claimed cost**: split each leg's loss into the Pipeline fee, the integrator fee and the Token-2022 transfer fee (all from the swap event and the mint), and the remainder, which is the strategy's own fee and price impact; the remainder at the smallest size approximates the strategy's fee and is compared with what its metadata or explainer claims (Honeypot.is `buyTax`, `sellTax`; HoneyCheck's quote-against-sale).
2. **Buy and sell separately**, with Honeypot.is's tax bands (above 21%, 40% and 50%) and HoneyCheck's 90% as display levels, not verdicts.
3. **Per wallet and over time**: the fee must be the same for fresh wallets and insiders (GoPlus `personal_slippage_modifiable`) and must not rise along the time ladder; run at the next epoch too, because the quoter picks Token-2022 fees by epoch.
4. **After the authorities act**: re-measure after the control step below has used every fee-changing power it found (GoPlus `slippage_modifiable`; Blowfish `TRADING_TAX_MODIFIABLE`).

### Control

1. **Program**: upgradeable or frozen; the upgrade authority and what it is (a wallet, a multisig or another program); `ProgramData.slot`; the program hash as the strategy version; and whether a verified build exists (OtterSec's registry on mainnet, a local `solana-verify` hash on devnet).
2. **Mints**: mint and freeze authority, and every Token-2022 extension with its authority (transfer hook, permanent delegate, transfer fee, default account state, non-transferable), as Solana scanners already report.
3. **Use every power, then re-test**: in the harness, sign as each authority found (upgrade authority, market creator, metadata signers), call each custom action, and re-run the exit test and fee honesty; this is the step that catches the later blacklist and fee change that HoneyCheck and Honeypot.is cannot, and it answers MetalLegBob's question of "whether its liquidity can leave" by measuring vault balances after each action.
4. **Bypass**: call `pipeline_swap` directly, without the router; if it succeeds, the strategy does not check the market signer, so trades can skip the Pipeline fee and the swap event (`docs/STRATEGY-GUIDE.md`, rule 4).
5. **Signs of simulation awareness**: report as a neutral fact any strategy whose `pipeline_resolve_accounts` asks for the Instructions or SlotHashes sysvar or other accounts that describe the transaction rather than the market, and load real recent clock and account state rather than LiteSVM defaults (Blowfish's `RELIABLE_SIMULATION_NOT_POSSIBLE`; X-ray's `MaliciousSimulation`; Jupiter's flow detection).

### When to re-run

- On every upgrade of a strategy program (watch the upgradeable loader's upgrade instruction for registered strategies and poll `ProgramData.slot`, as OtterSec does), on any change to a market mint's authorities or extensions, and on each `MetadataUpdated` event.
- On a schedule per market, because its state moves (Jupiter re-checks every 30 minutes); the interval is for [#14](https://github.com/imDev2023/testing-pipeline/issues/14) to set.
- Every result says what it covers: "at slot X, on program hash Y"; a pass is never a promise about later state or a later version.

## False positives to expect

- Sale-failure findings will be rare and reliable; HoneyCheck saw none on 967 benign tokens.
- Benign mechanisms will look like traps: anti-bot code, cooldowns, presale or launch locks, vesting, and per-slot limits (GoPlus's sandbox notes, HoneyCheck's presale note); report the mechanism and the time it lifts, not "honeypot".
- Moving the clock can make an oracle-priced strategy fail on a stale price; classify such errors separately.
- Most misses will be false negatives: a later upgrade, state changed after the test, or code that knows it is simulated; that is why Canary attaches results to a strategy version and a slot, and why the glossary says Canary checks detect and cannot prove safety.

## Sources

- Pipeline at `a2d5bfb`: `programs/test-strategy-evil/src/lib.rs`, `crates/pipeline-quoter/src/lib.rs`, `crates/pipeline-tests/tests/adversarial.rs`, `security.rs`, `quoter.rs`, `docs/STRATEGY-GUIDE.md`, `docs/INTEGRATOR-GUIDE.md`, `programs/pipeline/LICENSE`, `LICENSING.md`.
- Jupiter knowledge base: `raw/jupiter-developers/pages/swap__routing__amm__market-listing.md`, `swap__routing__amm__integration.md`, `raw/jupiter-docs/pages/user-docs__launch__vrfd__faq.md`, `raw/jupiter-developers/llms-full.txt`, `jupiter/01-products-user-docs.md`, `jupiter/02-developer-platform-and-apis.md`.
- https://github.com/jup-ag/jupiter-amm-interface/tree/main/test-kit
- Solana scanners: https://api.rugcheck.xyz/swagger/doc.json, https://docs.gopluslabs.io/reference/response-detail-1.md, https://data.birdeye.so/docs/use-cases/risk-and-integrity/rug-checker.md, https://docs.webacy.com/llms.txt, https://solsniffer.gitbook.io/solsniffer-user-guide/llms-full.txt, https://docs.de.fi/security-toolkit/scanner.md, https://docs.dexscreener.com/llms-full.txt
- https://docs.honeypot.is/ishoneypot and https://docs.honeypot.is/summary_flags
- https://docs.gopluslabs.io/reference/response-details
- https://arxiv.org/abs/2610.10149 (HoneyCheck), https://arxiv.org/abs/1902.06976, https://arxiv.org/abs/2109.00229, https://arxiv.org/abs/2403.01425, https://arxiv.org/abs/2607.18753, https://arxiv.org/abs/2603.24625, https://arxiv.org/abs/2309.03006
- https://web.archive.org/web/20240908192154/https://docs.blowfish.xyz/reference/scan-transactions-solana
- https://blockaid.io/blog/how-share-protected-copy-traders-from-malicious-tokens-with-blockaid
- https://github.com/Ackee-Blockchain/trident and https://github.com/sec3-product/x-ray
- https://github.com/otter-sec/solana-verified-programs-api and https://verify.osec.io/status/
- https://docs.rs/solana-loader-v3-interface/latest/solana_loader_v3_interface/state/enum.UpgradeableLoaderState.html
- LiteSVM 0.18.2 source in the local cargo registry.
