// Turns one confirmed router transaction into the feed's rows: strategies, markets and their mints,
// trades, and the transaction itself. Every write is idempotent, because the same transaction can
// arrive from more than one source (reconciliation, the trade fast path, the live socket) and from a
// re-index, and must write its rows once.
import { sql } from "drizzle-orm";
import { indexedTransactions, marketMints, markets, strategies, trades, type Db } from "terminal-db";
import { DECODER_VERSION, decodeRouterEvents, type EventDecoder, type RawTransaction } from "./decode";

/** What indexing wrote, counted by kind, and the markets whose accounts are to be read again because an event touched them. */
export type IndexResult = { counts: Record<string, number>; markets: string[] };

/** Indexes one transaction. Idempotent: a transaction already indexed writes nothing. */
export type TransactionHandler = (db: Db, tx: RawTransaction) => Promise<IndexResult>;

const blockDate = (raw: RawTransaction) => (raw.blockTime === null ? null : new Date(raw.blockTime * 1000));

/**
 * The router's handler. `decode` and `decoderVersion` are the event decoder and its version; the
 * defaults are Pipeline's SDK and `DECODER_VERSION`, and tests pass an older decoder to see an
 * unknown event kept and indexed later.
 */
export function pipelineHandler({ decode, decoderVersion = DECODER_VERSION }: { decode?: EventDecoder; decoderVersion?: number } = {}): TransactionHandler {
  return async (db, raw) => {
    const result: IndexResult = { counts: {}, markets: [] };
    // A failed transaction changed nothing on chain, so it has no rows.
    if (raw.meta === null || raw.meta.err !== null) return result;
    const signature = raw.transaction.signatures[0]!;
    const slot = BigInt(raw.slot);
    const blockIndex = raw.transactionIndex ?? null;
    const blockTime = blockDate(raw);
    const { events, unknown } = decodeRouterEvents(raw, decode);
    const count = (kind: string) => (result.counts[kind] = (result.counts[kind] ?? 0) + 1);
    const touched = new Set<string>();

    await db.transaction(async (tx) => {
      const [fresh] = await tx
        .insert(indexedTransactions)
        .values({ signature, slot, blockIndex, blockTime, decoderVersion, unknownEvents: unknown.length, raw: unknown.length ? raw : null })
        .onConflictDoNothing()
        .returning({ signature: indexedTransactions.signature });
      if (!fresh) return;
      if (unknown.length) result.counts.unknownEvents = unknown.length;

      for (const { eventIndex, event } of events) {
        switch (event.type) {
          case "StrategyRegistered": {
            const { strategy, feePaid, metadataUri } = event.data;
            await tx
              .insert(strategies)
              .values({ program: strategy, metadataUri, feePaid: String(feePaid), registeredAt: blockTime ?? new Date(0), registeredSlot: slot, registeredSignature: signature })
              // Found first by the registry snapshot: the event adds what only it knows.
              .onConflictDoUpdate({ target: strategies.program, set: { feePaid: String(feePaid), registeredSlot: slot, registeredSignature: signature } });
            count("strategies");
            break;
          }
          case "MetadataUpdated": {
            const { strategy, metadataUri } = event.data;
            await tx
              .update(strategies)
              .set({ metadataUri, metadataSlot: slot })
              .where(sql`${strategies.program} = ${strategy} and (${strategies.metadataSlot} is null or ${strategies.metadataSlot} <= ${slot})`);
            count("metadataUpdates");
            break;
          }
          case "MarketCreated": {
            const { market, strategy, marketState, mints, createdBy } = event.data;
            await tx
              .insert(markets)
              .values({ address: market, strategyProgram: strategy, marketState, createdBy, createdAt: blockTime ?? new Date(0), createdSlot: slot, createdSignature: signature })
              .onConflictDoUpdate({ target: markets.address, set: { createdSlot: slot, createdSignature: signature } });
            await tx
              .insert(marketMints)
              .values(mints.map((mint, position) => ({ market, position, mint })))
              .onConflictDoNothing();
            touched.add(market);
            count("markets");
            break;
          }
          case "Swap": {
            const s = event.data;
            await tx
              .insert(trades)
              .values({
                signature,
                eventIndex,
                slot,
                blockIndex,
                blockTime,
                market: s.market,
                strategy: s.strategy,
                trader: s.trader,
                inputMint: s.inputMint,
                outputMint: s.outputMint,
                mode: s.mode,
                netSent: String(s.netSent),
                received: String(s.received),
                pipelineFee: String(s.pipelineFee),
                feeMint: s.feeMint,
                integrator: s.integrator,
                integratorFee: String(s.integratorFee),
                unixTimestamp: s.unixTimestamp,
              })
              .onConflictDoNothing();
            touched.add(s.market);
            count("trades");
            break;
          }
          default:
            // FeesSwept, ConfigChanged and LookupTableRecorded are known and need no row of the feed's.
            break;
        }
      }
    });
    result.markets = [...touched];
    return result;
  };
}

