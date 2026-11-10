# testing-pipeline

A suite of products built on Pipeline, MetalLegBob's permissionless router for experimental Solana markets.
The suite's public name is Aviary; the repo and folder keep the internal name testing-pipeline.
Its reason to exist is that new market designs on Solana get no distribution, and Pipeline only fixes that if people can find, trust and trade what is listed on it.

Product names below are the public names the owner settled on 2026-11-10; where one replaced a working name, its _Avoid_ line says which.

## Language

### Pipeline (what we build on, not what we build)

**Pipeline**:
MetalLegBob's permissionless on-chain router: any program that implements its strategy interface can register once and have every market it creates found, quoted and traded through one swap instruction.
_Avoid_: the protocol (ambiguous with our own products), aggregator, DEX

**Router**:
Pipeline's on-chain program, `PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34`, which keeps the registry of strategies and markets, moves a trader's input into a strategy, calls it, measures the result and charges the Pipeline fee.
_Avoid_: aggregator, swap program

**Strategy**:
A Solana program that implements Pipeline's five strategy instructions, holds its own liquidity and decides prices.
_Avoid_: pool program, hook (that is a Token-2022 or Uniswap v4 term), adapter

**Strategy version**:
A strategy's program bytes as of one upgrade; a strategy that is upgraded becomes a new strategy version, and Canary checks attach to versions, not to strategies.
_Avoid_: release, build

**Verified build**:
A deployed program whose bytes are shown, by rebuilding a published commit in a pinned Docker build and comparing hashes, to come from that source; Aviary uses a strategy version's source as evidence only when its build is verified.
_Avoid_: verified program (says nothing about source), open source (published source is not verified source), audited

**Market**:
One tradable instance created from a strategy and recorded by the router, with two to four mints, a vault per mint and a market state.
_Avoid_: pair (a market can hold four mints), pool (use pool only for the liquidity inside a market)

**Market state**:
The account a strategy owns that holds one market's data.
_Avoid_: pool account, config

**Market signer**:
The router's per-market address that signs every router call into a strategy, so a strategy can tell a call came from Pipeline for that exact market.
_Avoid_: router authority, admin

**Listing fee**:
The one-time SOL fee a strategy's upgrade authority pays to register the strategy with the router (0.01 SOL on devnet).
_Avoid_: registration cost, deploy fee

**Pipeline fee**:
The router's 0.25% of each swap's input, measured on-chain and charged on every hop; it goes to Pipeline's treasury, never to us.
_Avoid_: protocol fee (Meteora's term), router tax

**Integrator**:
Anything that finds, quotes, routes or charts Pipeline markets for traders: a terminal, a bot, an indexer or a chart site.
_Avoid_: front-end (an integrator may have none), partner

**Integrator fee**:
The extra fee an integrator attaches to a swap through the router, at a rate the trader signs, paid into the integrator's own token account; it has no cap, so integrators must show it.
_Avoid_: referral fee (that is DBC's), platform fee

**Custom action**:
Any strategy instruction that is not a swap, such as adding liquidity or claiming, which users call directly on the strategy without the router or its fee.
_Avoid_: admin function, side instruction

**Strategy metadata**:
The JSON file a registered strategy points at (schema `pipeline-strategy-metadata/1`) with its name, links and the forms for its custom actions; integrators treat it as untrusted user content.
_Avoid_: token metadata (that is the mint's), manifest

**Quote**:
What a strategy says a swap would do now, from its `pipeline_quote`, which must share code with its `pipeline_swap`.
_Avoid_: price (a quote is an amount for an amount), estimate

**Quoter**:
Pipeline's `pipeline-quoter` crate, which runs a strategy's real deployed code in an embedded Solana VM on account data you supply.
_Avoid_: simulator (RPC simulation is the other way to quote), oracle

**Conformance checker**:
Pipeline's `pipeline-check`, which quotes and trades a market through the real router in a local Solana VM and reports Pass, Warn, Fail or Skip per check; a strategy's developer runs it and may publish its report.
_Avoid_: Canary checks (Aviary's own, run on every strategy version), audit

**Swap event**:
The `SwapEvent` the router emits once per swap through a self-call, which carries everything needed to chart a trade.
_Avoid_: trade log, fill

**Bypass**:
Calling a strategy directly instead of through the router, which Pipeline allows; bypassed swaps pay no Pipeline fee and emit no swap event.
_Avoid_: direct swap (ambiguous), backdoor

**Seeding**:
Another program creating and funding a new market on a strategy in one call through the optional `pipeline_seed_liquidity`, for example a launch graduating into it.
_Avoid_: migration (that is DBC's), bootstrap

### Tokens and pools

**Transfer hook**:
The Token-2022 extension that makes every transfer of a mint call a chosen program, which may refuse it.
_Avoid_: hook alone when Uniswap v4 hooks are also in play

**Vamp**:
A third party opening its own pool for someone else's token to take that token's volume and fees; MetalLegBob's "vampire LP".
_Avoid_: copycat (a copied token, not a copied pool), fork

**Containment hook**:
A transfer hook that lets a token move only into or out of its home market until its unlock, so it cannot be vamped while young.
_Avoid_: lock (it locks trading venues, not tokens), anti-sniper

**Contained token**:
A token whose transfer hook is the containment hook and that has not been unlocked yet.
_Avoid_: locked token, hooked token (any mint with a transfer hook)

**Launcher**:
Whoever creates a contained token and binds it, proven by holding the token's mint authority.
_Avoid_: creator (the router's word for whoever creates a market), deployer, dev

**Binding**:
The launcher's one-time act, never changeable afterwards, of fixing a contained token's home market, unlock goal and unlock deadline.
_Avoid_: registration, setup

**Home market**:
The one market a contained token may trade in before its unlock.
_Avoid_: main pool, official pool

**Unlock goal**:
The tax collected in a contained token's home market, fixed at binding, after which anyone may unlock it.
_Avoid_: graduation (DBC's term for leaving a curve), threshold alone

**Unlock deadline**:
The time, fixed at binding, after which anyone may unlock a contained token even if its unlock goal was never met.
_Avoid_: expiry, timeout

**Unlock**:
Removing a contained token's transfer hook program and hook authority, once its unlock goal is met or its unlock deadline passes, so the token becomes tradable everywhere.
_Avoid_: graduation, release

**Tax**:
A fee a token's market charges on top of the Pipeline fee and pays to that token's own recipients.
_Avoid_: Pipeline fee, transfer fee (a Token-2022 extension that taxes every transfer)

**Tax side**:
The one mint of a market in which its tax is always taken, whichever way the trade goes.
_Avoid_: fee token, quote side (the tax side need not be the quote)

**Buy tax**:
The tax a market takes when the tax side is paid in.
_Avoid_: entry fee, buy fee

**Sell tax**:
The tax a market takes when the tax side is paid out.
_Avoid_: exit fee, sell fee

**Tax authority**:
The one address that may change a tax market's rates, within ranges fixed when the market was created, and its tax recipients, until it renounces.
_Avoid_: admin, owner (the Owner is the person who runs this project)

**Tax recipient**:
An address that receives a fixed share of a market's tax.
_Avoid_: beneficiary, fee receiver

**Suite share**:
Our fixed tenth of every tax market's tax and of every buy wall market's fee, paid to the suite's treasury before the rest is split.
_Avoid_: protocol fee (Meteora's term), platform fee

**Virtual reserve**:
An amount a market prices as if it held on one side, so a token can launch without the other side; it is never paid out.
_Avoid_: fake liquidity, virtual liquidity

### Our products

**Aviary**:
The public name of the suite and of its terminal, which share it: the terminal finds every strategy and market as it appears, charts them from swap events, trades them through the router with our integrator fee, renders their custom-action forms and shows Canary results and an explainer for each.
In these documents Aviary alone means the terminal, and the suite is called the suite.
_Avoid_: Pipescope (the working name, retired because it borrowed Pipeline's), dashboard, explorer, screener alone (it trades too)

**Suite**:
Everything we build on Pipeline: the terminal and our on-chain products, which carry the suite's name before their own in public (Aviary Tax AMM, Aviary Containment Hook, Aviary Buy Wall AMM, Aviary Lending AMM).
_Avoid_: the protocol, the platform, the Factory (that is MetalLegBob's)

**Fee mint**:
A mint Aviary takes its integrator fee in when a trader pays with it: SOL and USDC; a swap paying with any other mint carries no integrator fee.
_Avoid_: quote mint (a market need not quote in it), fee token

**Fee wallet**:
The wallet Aviary's integrator fees are paid into; it is not the suite's treasury, which receives the tax AMM's suite share.
_Avoid_: treasury (Pipeline's and the suite's are other wallets), revenue wallet

**Canary checks**:
The automated tests Aviary runs on a private copy of each market, for the strategy version then deployed: readability, Pipeline's conformance report, the exit test, quote against swap, fee honesty and control; re-run when the strategy or the router is upgraded, when a market is created, and on a schedule.
_Avoid_: audit (they detect, they cannot prove safety), score, rating

**Canary result**:
The record of one Canary check on one market of one strategy version at one slot: what was tried, what was measured, and an outcome of pass, warn, fail, not run or noted.
_Avoid_: verdict, finding (a result can be a clean pass), score

**Exit test**:
The Canary checks that buy and then sell back: at several sizes, after waits, with the clock set back to the market's launch, from fresh wallets and insiders' wallets, with transferred tokens, and as a queue of buyers leaving in turn, to catch markets that let people in but not out.
_Avoid_: honeypot check alone, sell test

**Canary run**:
One run of the Canary checks against one strategy version, on all of its markets or on one of them, with the date and inputs it used; its results stay attached to that version.
_Avoid_: scan, audit, test run

**Round-trip return**:
The share of what a trader put into a buy, Pipeline fee included, that comes back when they sell everything they bought.
_Avoid_: slippage (that is price movement against a quote), tax, spread

**Ordinary trade**:
The trade Canary judges hardest: a small buy at the present clock, sold straight back; only what it meets can make a Canary result fail.
_Avoid_: test trade, base case

**Money side**:
The mint of a market that Canary spends and counts its results in: wrapped SOL when the market has it.
_Avoid_: quote side (a market need not have one), tax side (that is the tax AMM's)

**Stranded market**:
A market whose strategy's current version can no longer read its market state, left behind by an upgrade, so it cannot be quoted or traded through Pipeline.
_Avoid_: dead market, broken pool, closed market (a closed market is read and refuses trades by its own rules)

**Conformance report**:
The report of Pipeline's own checker, `pipeline-check`, on one market: whether quoting and trading it through the router behaves as the strategy interface requires.
_Avoid_: audit, Canary result alone (Canary keeps it as one result among its own)

**Explainer**:
Aviary's plain-language account of what a strategy version's facts mean for a trader, written by an LLM from evidence Aviary prepares (chain facts, Canary results, source only when the build is verified, and author text marked untrusted), and shown only after code has checked it.
_Avoid_: AI summary, review, audit

**Facts panel**:
The part of an Aviary strategy or market page that code renders from Aviary's own chain data and Canary results; the explainer narrates it and can never change it.
_Avoid_: overview, AI panel

**Evidence id**:
The id of one item of evidence given to the explainer (P, F, C, S or A and a number), which every sentence of an explanation must cite and code checks.
_Avoid_: citation (the Claude API feature, which we do not use), footnote

**Trade link**:
A link Aviary's Telegram bot sends that opens one market's trade box with a swap filled in; nothing is signed until the trader acts there in their own wallet.
_Avoid_: buy link, deep link alone (a wallet's browse link is one too), blink (a Solana Action a wallet unfurls)

**Alert**:
A message Aviary's Telegram bot sends without being asked, because the chat turned it on or watches what changed: a new strategy, a new market, an upgrade or a changed Canary outcome.
_Avoid_: notification (Telegram's word for any message), signal and call (an alert is a fact, never advice to trade)

**Watch list**:
The strategies and markets a Telegram chat has asked the bot to send alerts about.
_Avoid_: favourites, portfolio (it holds no wallet and no balances)

**Tax AMM**:
Our strategy whose markets always take their tax on the tax side, outside the price curve, with liquidity locked for good; built to pair with the containment hook.
_Avoid_: tax token (the token is not the AMM)

**Tax market**:
A market on the tax AMM.
_Avoid_: tax pool, taxed pair

**Buy wall AMM**:
Our port of IMD's Pool4 design to a Pipeline strategy: each market owns all its liquidity, trims inventory above a cap after sells, burns what it trims except for a reward share, and keeps a buy wall under the price.
_Avoid_: Pool4 for Solana (the working name; Pool4 is IMD's product name, so ours only credits it), Pool4 alone (that is IMD's Uniswap v4 product)

**Buy wall market**:
A market on the buy wall AMM.
_Avoid_: Pool4-style market, Pool4 pool

**Inventory cap**:
The most of the token a buy wall market may hold after a sell; anything above it is trimmed.
_Avoid_: max supply, reserve limit

**Trim**:
Removing a buy wall market's token inventory above the inventory cap together with the proportional SOL, without moving the price.
_Avoid_: burn (the burn is what happens to most of the trimmed tokens), skim

**Buy wall**:
A buy wall market's SOL-only bid below the price, funded by the SOL that trims recover and by any part of its fee the market's creator sent there.
_Avoid_: floor (it moves), treasury

**Cap floor**:
The lowest a buy wall market's inventory cap can ever fall, fixed when the market is created.
_Avoid_: floor alone (the buy wall has its own), minimum supply

**Cap decay**:
The most a buy wall market's inventory cap may fall in a day, however much is bought.
_Avoid_: burn rate (the cap is not the supply), emission

**Retired tokens**:
Tokens a buy wall market has trimmed or its buy wall has bought, waiting to be burned and split.
_Avoid_: burned (not yet), treasury

**Reward share**:
The part of a buy wall market's retired tokens that goes to its rewards recipient instead of being burned.
_Avoid_: staking yield (the recipient need not be a staking program), tax

**Designer share**:
The fixed tenth of every buy wall market's fee owed to IMD and Adam, who designed Pool4.
_Avoid_: royalty, IMD tax

**Lending AMM**:
Our strategy that keeps a buffer of its liquidity for swaps and lends the rest to a lending market between them.
_Avoid_: lending pool (the working name; it reads as a pool to lend to or borrow from, which is a lending market), vault (Meteora's Dynamic Vault is the prior art), yield pool

**Buffer**:
The share of a lending AMM's liquidity kept in its own vaults so swaps never wait on the lending market.
_Avoid_: reserve (a lending market's term)

**Lent side**:
The one mint of a lending AMM market whose liquidity is partly lent to a lending market; the market's other mint is never lent.
_Avoid_: quote side (the lent side is chosen for lending, not for quoting), collateral

**Lending market**:
An outside protocol that lends deposited tokens to borrowers and pays the depositors interest; for the lending AMM, Kamino Lend.
_Avoid_: money market, lending protocol

**cToken**:
The receipt a lending market mints for a deposit, redeemable later for the deposit plus interest at the lending market's exchange rate.
_Avoid_: collateral token (true only inside a borrower's position), LP share

**Withdraw mode**:
A lending AMM market's state while its lending market is too short of free liquidity to pay it back quickly: it lends nothing and takes back everything it can.
_Avoid_: emergency mode (that is the lending market's own switch), pause

**Single-use AMM**:
A strategy designed for one client protocol's or game's token design, built by us for that client.
_Avoid_: custom AMM alone, white-label

**Keeper job**:
A permissionless instruction that someone must call on a schedule to keep a market or product working, such as rebalancing a buy wall or a buffer.
_Avoid_: cron (that is how we run it, not what it is), bot

**Keeper runner**:
Our program that calls the keeper jobs of every market of our strategies when they are due, paying from the keeper wallet; anyone may run their own copy, since every keeper job is permissionless.
_Avoid_: keeper alone (ambiguous between the job and the runner), bot, crank

**Keeper wallet**:
The wallet the keeper runner pays transaction fees and account rent from, and receives keeper tips into; it holds a small float and nothing else.
_Avoid_: hot wallet, operations wallet (Top-pad's term), treasury

**Keeper tip**:
What a keeper job pays its caller for the work, bounded by what the market earned on that work; only the buy wall AMM's `place_wall` pays one.
_Avoid_: reward (that is the reward share), bounty

**Hardening ticket**:
The last build ticket of each of our on-chain programs, in which a fresh session runs the internal adversarial review and fixes what it finds.
_Avoid_: audit (an audit is external), security pass

**Release gate**:
The check a new build of one of our strategies must pass before it may be deployed as an upgrade: it replays every live market of the program against the new build, so no upgrade can leave a stranded market.
_Avoid_: migration (nothing is migrated), smoke test

### People and parties

**Owner**:
The person who runs this project: sets its scope, answers each decision with a default and spends money.
_Avoid_: user (that is a trader or LP), client

**MetalLegBob**:
Pipeline's author (display name mlbob), founder of The Fantastical Finance Factory, for whom the suite is built, so he may change any of its decisions; see `research/metallegbob.md`.
_Avoid_: Bob, the dev

**Factory**:
MetalLegBob's project The Fantastical Finance Factory (@fffactoryhq, token $MOTION), where Pipeline's revenue goes.
_Avoid_: fffactory in prose, Motion (that is the token)

**IMD**:
imd.fun's AI agent swarm and its token, whose developer designed Pool4 and to whom MetalLegBob asked a Pool4 port to route some fees.
_Avoid_: the oracle alone, the swarm alone

### How decisions are kept

**Default**:
A decision as the owner answered it, which stands until MetalLegBob changes it.
_Avoid_: final decision, requirement

**Decision register**:
`docs/decisions.md`, the list of every decision settled for the suite: one block each, with a stable ID, the single place where its value lives and how it would change.
_Avoid_: changelog, ADR (an ADR argues one lasting trade-off; the register indexes every decision)
