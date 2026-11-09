# Landscape: distribution, prior art and competitors

Collected 2026-11-09.
Facts about Jupiter and Meteora come from the owner's canonical knowledge base at `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora`; read the cited file there for detail and re-check anything that moves.

## Who routes and shows unusual markets

- Jupiter's Launchpad Screener lists DBC launchpads through Meteora and evaluates other technologies case by case (`raw/findings/2026-10-26-terminal-distribution.md`).
- On 2026-10-26 neither Jupiter's Metis router nor Titan routed live DBC transfer-hook pools; OKX's router, DFlow and Axiom carried 85% of those swaps, with Padre, Maestro, GMGN and Photon also seen (`raw/findings/2026-10-26-dbc-hook-routing.md`).
- After DBC revokes a token's transfer hook (program and authority set to the zero key), its pools route normally through Jupiter: the precedent for a containment hook's unlock.
- Photon adds launchpads one by one; DexScreener, Birdeye, GMGN and Codex identify sources by program or launchpad, each through its own request process (`raw/findings/2026-10-26-terminal-distribution.md`).
- MetalLegBob's own Factory pools waited just over 7 months for Jupiter routing (see `metallegbob.md`).

## Prior art for the ideas we weighed

- Over and under price markets already exist natively on Solana: Jupiter Forecast (provider `bisonfi`) runs 15-minute BTC up and down rounds settled from Chainlink (`jupiter/03-lend-perps-predict-jupusd-dev.md`, section 3.9); Jupiter also routes Polymarket and Kalshi event markets.
- A pool that lends idle liquidity existed as Meteora's DAMM v1 on Dynamic Vaults, now legacy; DLMM and DAMM v2 do not lend (`meteora/01-products-and-protocol.md`).
- Configurable launch curves exist as Meteora DBC configs (piecewise curves, fee schedulers, transfer-hook pools) (`meteora/03-dev-dbc-vaults-launch.md`).
- Tax tokens with a quote-side tax exist on DBC (`collectFeeMode QuoteToken`).
- Pool4 is IMD's Uniswap v4 design on EVM (see `pool4.md`).
- Behavioural testing of arbitrary Solana market programs: none known; RugCheck-style tools inspect tokens, not market programs (unverified, from memory).

## Others building near Pipeline (from the launch thread)

- einzxx: on devnet, distributing tokens by sending them to X handles.
- Rishee_A: wants to build reputation-as-currency markets on Pipeline.
- CryptoSteven88 (Tessera, tokenized pre-IPO assets): may list Tessera assets on Pipeline venues they are not already on.
- heisenburgirrs: says they are deploying on Pipeline.
- p6sha: the one skeptic, asking how Pipeline brings more attention than a graduated launch.
- No terminal, aggregator or bot said it would integrate (2026-11-09).
