# Postgres on Neon is Aviary's only system of record

Aviary keeps everything it knows (strategies, strategy versions, markets, trades, candles, cursors, metadata snapshots, Canary records, verified builds and explanations) in its own Neon Postgres project, reached from the Workers through Hyperdrive with its query cache off, because devnet history can be reset and Aviary's own database must be the record.
We chose Postgres over D1 because Top-pad's indexer, candle and migration code is Postgres and is copied in, because trades are kept forever and a mainnet terminal would outgrow D1's 10 GB per database, and because the candle rebuilds and feed queries are ordinary SQL.
Decided by the owner in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13) on 2026-11-10.

## Consequences

- Neon's free plan gives 100 compute-hours a project a month, so the indexer asks the chain before it touches the database and lets it sleep when devnet is quiet; if that is not enough, the database moves to a paid plan, which the owner approves.
- Hyperdrive's cache stays off because it never invalidates a cached read on a write; the only caches are explicit ones in KV.
- Durable Object storage holds only working state (the indexer's socket and alarm, a Canary run's progress), never records.
