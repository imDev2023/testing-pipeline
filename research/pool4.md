# Pool4, the design MetalLegBob asked us to port

Read on 2026-11-09 from https://pool4.imd.fun/docs (IMD's own docs); summarised, not copied.
Pool4 is a Uniswap v4 hook design by IMD (imd.fun); IMD is the first token using it, on an ETH/IMD pool, with burns bridged to Base.
For Uniswap v4 hook mechanics, read the owner's v4-hooks knowledge base (`/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/v4-hooks`, starting at `CONTEXT.md`).

## How it works

- The hook is the only liquidity provider and the only address that can initialise the pool, so liquidity is protocol-owned and nobody can front-run the launch.
- Trading is a plain full-range constant-product pool with a 1% fee, which is protocol revenue kept in its own ledger; the hook runs only after a swap settles, so quotes are not changed.
- An inventory cap limits how much IMD the pool may hold; after a sell, anything above the cap is trimmed by removing liquidity (not by swapping), so the price does not move.
- Buys lower the cap with the inventory, so the next sell meets a lower ceiling; `capFloor` is a hard bottom, and `capDecayTokensPerDay` limits how fast the cap can fall, so wash trading cannot speed it up.
- Of every trimmed batch, 85% is burned and 15% is split 30/40/30 between stakers (4.5% of the batch), a bonding reserve for IMD's lead orchestrator (6%) and reserved NFT inference nodes (4.5%).
- SOL-equivalent (ETH) recovered by a trim becomes a buy wall: one wide ETH-only bid below the price; if the price falls into it, it buys IMD.
- The wall never moves inside a swap; a keeper calls `rebalance()` when enough ETH is idle or the wall has bought enough, retiring what it bought through the same split and placing the ETH under the new price, for a tip capped at 1% of the ETH handled.
- The wall's floor drops to a new low at once but crawls up only about 4% a day from a block-lagged reference, so a one-block price spike cannot drag it.
- Staking is an ERC-4626 vault (sIMD) fed by a rate-limited dripper; bonding and the node program are reserves for products not yet live.
- Five permissionless keeper jobs: place the buy wall, settle claims, sort rewards, drip staking yield, finish burns on Base.
- The mechanism is meant to be forked; a permissionless launch factory is planned but not built.
- Contract names: `CappedBurnHook`, `RewardDistributor`, `StakedIMD`, `RewardDripper`, `BurnExecutor`, `BaseBurnReceiver`.

## Porting notes for a Pipeline strategy

- A Pipeline strategy already owns its liquidity, so "the hook is the only LP" is the default, not a special case.
- Without a containment hook, anyone can open a second pool for the token elsewhere; decide whether our port pairs with the containment hook.
- Burns are native on Solana; no bridge.
- The buy wall is a second price segment of the same strategy (SOL only, below the price), so the curve is piecewise: a full-range constant product plus a single-sided range; quote and swap must share that code.
- Trim, rebalance, distribute and drip are keeper jobs (custom actions), run by our scheduler and callable by anyone.
- Staking is a separate program or a set of custom actions with a share token; streaming must be rate-limited as in the original.
- MetalLegBob asked that a Solana variant share part of its fees with Adam and IMD; record the split as a decision.
- MetalLegBob already registered a 4-mint strategy on devnet with metadata named `pool4.json`; check whether it is his own Pool4 port before we start.
