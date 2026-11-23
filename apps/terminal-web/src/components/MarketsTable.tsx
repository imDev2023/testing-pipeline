// A table of markets (docs/spec/pipescope-screens.md, Feed): the feed's, and a strategy's own on its
// page, which leaves out the strategy column (Strategy page, "Its markets").
import Link from "next/link";
import type { Market } from "terminal-api/contract";
import { formatAge, formatDate, formatInteger, formatTokenAmount } from "@/format";
import { ROUTES } from "@/routes";
import table from "./ListingTable.module.css";
import { MintLabel } from "./MintLabel";
import { ShortAddress } from "./ShortAddress";

const plural = (n: number, one: string, many: string) => `${formatInteger(n)} ${n === 1 ? one : many}`;

/** The amount a vault or a volume holds, in its mint's tokens, or a word when the mint is not read. */
function TokenAmount({ raw, decimals, mint, symbol }: { raw: string | null; decimals: number | null; mint: string; symbol: string | null }) {
  return (
    <span>
      {raw === null || decimals === null ? "not read" : formatTokenAmount(BigInt(raw), decimals)} <MintLabel mint={mint} symbol={symbol} />
    </span>
  );
}

export function Age({ iso }: { iso: string }) {
  const date = new Date(iso);
  return (
    <time dateTime={iso} title={formatDate(date)}>
      {formatAge(date)}
    </time>
  );
}

/**
 * The markets, newest first as given; `strategyColumn` false leaves out the strategy each belongs
 * to, on that strategy's own page, and `rowClass` adds a class to a row, as the feed marks a market
 * that has just arrived live.
 */
export function MarketsTable({ markets, strategyColumn = true, rowClass }: { markets: Market[]; strategyColumn?: boolean; rowClass?: (market: Market) => string | undefined }) {
  return (
    <div className={table.scroll}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col">Market</th>
            {strategyColumn && <th scope="col">Strategy</th>}
            <th scope="col">Created</th>
            <th scope="col" className={table.num}>
              Liquidity
            </th>
            <th scope="col" className={table.num}>
              Volume, 24h
            </th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => {
            const base = m.mints.find((x) => x.mint === m.base_mint)!;
            const quote = m.mints.find((x) => x.mint === m.quote_mint)!;
            return (
              <tr key={m.address} className={[table.row, rowClass?.(m)].filter(Boolean).join(" ")}>
                <td className={table.main}>
                  <Link href={ROUTES.market(m.address)} className={table.rowLink}>
                    <MintLabel mint={base.mint} symbol={base.symbol} /> / <MintLabel mint={quote.mint} symbol={quote.symbol} />
                  </Link>
                  <span className={table.sub}>
                    market <ShortAddress address={m.address} />
                  </span>
                </td>
                {strategyColumn && (
                  <td>
                    <span className={table.label}>Strategy</span>
                    <Link href={ROUTES.strategy(m.strategy)} className={table.inner}>
                      <ShortAddress address={m.strategy} />
                    </Link>
                  </td>
                )}
                <td>
                  <span className={table.label}>Created</span>
                  <Age iso={m.created_at} />
                </td>
                <td className={table.num}>
                  <span className={table.label}>Liquidity</span>
                  <span className={table.lines}>
                    {m.mints.map((x) => (
                      <TokenAmount key={x.mint} raw={x.liquidity} decimals={x.decimals} mint={x.mint} symbol={x.symbol} />
                    ))}
                  </span>
                </td>
                <td className={table.num}>
                  <span className={table.label}>Volume, 24h</span>
                  {m.stats_24h.trades === 0 ? (
                    <span className={table.none}>none</span>
                  ) : (
                    <>
                      <TokenAmount raw={m.stats_24h.volume_quote} decimals={quote.decimals} mint={quote.mint} symbol={quote.symbol} />
                      <span className={table.sub}>{plural(m.stats_24h.trades, "trade", "trades")}</span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
