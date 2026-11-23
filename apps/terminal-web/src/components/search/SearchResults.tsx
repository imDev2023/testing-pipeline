"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import type { Market, SearchResults as Results, Strategy } from "terminal-api/contract";
import { BRAND } from "@/brand";
import { CLUSTER, SEARCH_EXAMPLES } from "@/config";
import { formatInteger, shortAddress } from "@/format";
import { ROUTES } from "@/routes";
import { MintLabel } from "../MintLabel";
import { StrategyName } from "../StrategyName";
import { AuthorText } from "../Voice";
import styles from "./Search.module.css";

// Search's results and help (docs/spec/pipescope-screens.md, Search; PIPESCOPE-81), drawn the same in
// the header's box as the reader types and on the search page after Enter.

type Heading = "h2" | "h3";

const plural = (n: number, one: string, many: string) => `${formatInteger(n)} ${n === 1 ? one : many}`;

function Group({ title, total, shown, heading: H, children }: { title: string; total: number; shown: number; heading: Heading; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.group} aria-labelledby={id}>
      <H id={id} className={styles.groupTitle}>
        {title} <span className={styles.count}>{formatInteger(total)}</span>
      </H>
      <ul className={styles.list}>{children}</ul>
      {total > shown && (
        <p className={styles.note}>
          The first {formatInteger(shown)} of {formatInteger(total)}. Type more of the address to narrow it.
        </p>
      )}
    </section>
  );
}

function StrategyResult({ strategy, onPick }: { strategy: Strategy; onPick?: () => void }) {
  return (
    <li className={styles.item}>
      <Link href={ROUTES.strategy(strategy.program)} onClick={onPick} className={styles.subject}>
        <StrategyName program={strategy.program} name={strategy.name} metadata={strategy.metadata.status} />
      </Link>
      <span className={styles.detail}>{plural(strategy.market_count, "market", "markets")}</span>
    </li>
  );
}

function MarketResult({ market, onPick }: { market: Market; onPick?: () => void }) {
  const base = market.mints.find((m) => m.mint === market.base_mint)!;
  const quote = market.mints.find((m) => m.mint === market.quote_mint)!;
  return (
    <li className={styles.item}>
      <Link href={ROUTES.market(market.address)} onClick={onPick} className={styles.subject} title={market.address}>
        Market {shortAddress(market.address)}
      </Link>
      <span className={styles.detail}>
        <MintLabel mint={base.mint} symbol={base.symbol} token={base.token} /> / <MintLabel mint={quote.mint} symbol={quote.symbol} token={quote.token} />
      </span>
      <span className={styles.detail}>
        on <StrategyName program={market.strategy} name={market.strategy_name} metadata={market.strategy_metadata} />
      </span>
    </li>
  );
}

function MintResult({ mint, onPick }: { mint: Results["mints"]["results"][number]; onPick?: () => void }) {
  const fullName = mint.token?.symbol && mint.token.name && mint.token.name !== mint.token.symbol ? mint.token.name : null;
  return (
    <li className={styles.item}>
      <span className={styles.subject}>
        <MintLabel mint={mint.mint} symbol={mint.symbol} token={mint.token} />
      </span>
      {fullName && (
        <span className={styles.detail}>
          <AuthorText>{fullName}</AuthorText>
        </span>
      )}
      <span className={styles.detail}>
        Trades on {mint.markets.length === 1 ? "one market" : `${formatInteger(mint.markets.length)} markets`}:{" "}
        {mint.markets.map((market, i) => (
          <span key={market}>
            {i > 0 && ", "}
            <Link href={ROUTES.market(market)} onClick={onPick} title={market}>
              {shortAddress(market)}
            </Link>
          </span>
        ))}
      </span>
    </li>
  );
}

/** The results of one search: its three groups, or the no-match text. */
export function SearchResultsView({ results, heading = "h2", onPick }: { results: Results; heading?: Heading; onPick?: () => void }) {
  const { strategies, markets, mints } = results;
  if (!strategies.total && !markets.total && !mints.total) {
    return (
      <div className={styles.results}>
        <p>
          Nothing registered with Pipeline on {CLUSTER} matches <q className={styles.query}>{results.query}</q>.
        </p>
        <p className={styles.note}>A token that trades on no Pipeline market does not appear here, and two tokens can share one name.</p>
      </div>
    );
  }
  return (
    <div className={styles.results}>
      {strategies.total > 0 && (
        <Group title="Strategies" total={strategies.total} shown={strategies.results.length} heading={heading}>
          {strategies.results.map((s) => (
            <StrategyResult key={s.program} strategy={s} onPick={onPick} />
          ))}
        </Group>
      )}
      {markets.total > 0 && (
        <Group title="Markets" total={markets.total} shown={markets.results.length} heading={heading}>
          {markets.results.map((m) => (
            <MarketResult key={m.address} market={m} onPick={onPick} />
          ))}
        </Group>
      )}
      {mints.total > 0 && (
        <Group title="Mints" total={mints.total} shown={mints.results.length} heading={heading}>
          {mints.results.map((m) => (
            <MintResult key={m.mint} mint={m} onPick={onPick} />
          ))}
        </Group>
      )}
      {mints.total > 0 && (
        <p className={styles.note}>Token names are each token&apos;s own claim. {BRAND.name} names only SOL and USDC itself, and marks no other token as verified, so check the mint address.</p>
      )}
    </div>
  );
}

/** What can be searched for, with three examples that work, when nothing is typed. */
export function SearchHelp({ onPick }: { onPick?: () => void }) {
  return (
    <div className={styles.results}>
      <p>
        Search everything registered with Pipeline on {CLUSTER}: a strategy by its name or its program&apos;s address, a market by its address or its market state&apos;s, and a token by its symbol, its name or
        its mint&apos;s address.
      </p>
      <p className={styles.note}>Names match anywhere and in any case. Addresses match exactly as typed, from their start or their end, since an address&apos;s case is part of it.</p>
      <ul className={styles.examples} aria-label="Examples">
        {SEARCH_EXAMPLES.map(({ query, what }) => (
          <li key={query}>
            <Link href={ROUTES.search(query)} onClick={onPick}>
              {query}
            </Link>{" "}
            <span className={styles.detail}>{what}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
