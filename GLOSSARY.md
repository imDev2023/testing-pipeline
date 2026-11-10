# testing-pipeline

A suite of products built on Pipeline, MetalLegBob's permissionless router for experimental Solana markets.
The repo and folder keep the working name testing-pipeline until the owner names the suite.
Its reason to exist is that new market designs on Solana get no distribution, and Pipeline only fixes that if people can find, trust and trade what is listed on it.

Product names below marked "working name" are placeholders until the wayfinder map settles them.

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

**Containment hook** (working name):
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
_Avoid_: admin, owner (the Owner is the person this suite is built for)

**Tax recipient**:
An address that receives a fixed share of a market's tax.
_Avoid_: beneficiary, fee receiver

**Suite share**:
Our fixed tenth of every tax market's tax, paid to the suite's treasury before the rest is split.
_Avoid_: protocol fee (Meteora's term), platform fee

**Virtual reserve**:
An amount a market prices as if it held on one side, so a token can launch without the other side; it is never paid out.
_Avoid_: fake liquidity, virtual liquidity

### Our products (working names)

**Pipescope** (working name):
Our Pipeline terminal: it finds every strategy and market as it appears, charts them from swap events, trades them through the router with our integrator fee, renders their custom-action forms and shows Canary results and an explainer for each.
_Avoid_: dashboard, explorer, screener alone (it trades too)

**Fee mint**:
A mint Pipescope takes its integrator fee in when a trader pays with it: SOL and USDC; a swap paying with any other mint carries no integrator fee.
_Avoid_: quote mint (a market need not quote in it), fee token

**Fee wallet**:
The wallet Pipescope's integrator fees are paid into; it is not the suite's treasury, which receives the tax AMM's suite share.
_Avoid_: treasury (Pipeline's and the suite's are other wallets), revenue wallet

**Canary checks** (working name):
The automated tests Pipescope runs against each strategy version in the quoter: the exit test, quote against swap, fee honesty and control, re-run whenever the strategy is upgraded.
_Avoid_: audit (they detect, they cannot prove safety), score, rating

**Exit test**:
The Canary check that buys and then sells back from random wallets, at several sizes and with the clock moved forward, to catch markets that let people in but not out.
_Avoid_: honeypot check alone, sell test

**Explainer**:
Pipescope's plain-language account of what a strategy version's facts mean for a trader, written by an LLM from evidence Pipescope prepares (chain facts, Canary results, source only when the build is verified, and author text marked untrusted), and shown only after code has checked it.
_Avoid_: AI summary, review, audit

**Facts panel**:
The part of a Pipescope strategy or market page that code renders from Pipescope's own chain data and Canary results; the explainer narrates it and can never change it.
_Avoid_: overview, AI panel

**Evidence id**:
The id of one item of evidence given to the explainer (P, F, C, S or A and a number), which every sentence of an explanation must cite and code checks.
_Avoid_: citation (the Claude API feature, which we do not use), footnote

**Tax AMM** (working name):
Our strategy whose markets always take their tax on the tax side, outside the price curve, with liquidity locked for good; built to pair with the containment hook.
_Avoid_: tax token (the token is not the AMM)

**Tax market**:
A market on the tax AMM.
_Avoid_: tax pool, taxed pair

**Pool4 for Solana** (working name):
Our port of IMD's Pool4 design to a Pipeline strategy: the strategy is the only liquidity provider, trims inventory above a cap after sells, burns most of what it trims, splits the rest, and keeps a buy wall under the price.
_Avoid_: Pool4 alone (that is IMD's Uniswap v4 product)

**Inventory cap**:
The most of the token a Pool4-style market may hold after a sell; anything above it is trimmed.
_Avoid_: max supply, reserve limit

**Trim**:
Removing a Pool4-style market's token inventory above the inventory cap together with the proportional SOL, without moving the price.
_Avoid_: burn (the burn is what happens to most of the trimmed tokens), skim

**Buy wall**:
A Pool4-style market's SOL-only bid below the price, funded by the SOL that trims recover.
_Avoid_: floor (it moves), treasury

**Lending pool** (working name):
Our strategy that keeps a buffer of its liquidity for swaps and lends the rest to a lending market between them.
_Avoid_: vault (Meteora's Dynamic Vault is the prior art), yield pool

**Buffer**:
The share of a lending pool's liquidity kept in its own vaults so swaps never wait on the lending market.
_Avoid_: reserve (a lending market's term)

**Single-use AMM**:
A strategy designed for one client protocol's or game's token design, built by us for that client.
_Avoid_: custom AMM alone, white-label

**Keeper job**:
A permissionless instruction that someone must call on a schedule to keep a market or product working, such as rebalancing a buy wall or a buffer.
_Avoid_: cron (that is how we run it, not what it is), bot

### People and parties

**Owner**:
The person this suite is built for, who decides scope and spends money.
_Avoid_: user (that is a trader or LP), client

**MetalLegBob**:
Pipeline's author (display name mlbob), founder of The Fantastical Finance Factory; see `research/metallegbob.md`.
_Avoid_: Bob, the dev

**Factory**:
MetalLegBob's project The Fantastical Finance Factory (@fffactoryhq, token $MOTION), where Pipeline's revenue goes.
_Avoid_: fffactory in prose, Motion (that is the token)

**IMD**:
imd.fun's AI agent swarm and its token, whose developer designed Pool4 and to whom MetalLegBob asked a Pool4 port to route some fees.
_Avoid_: the oracle alone, the swarm alone
