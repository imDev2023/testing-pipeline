import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SubjectAddress } from "@/components/Address";
import styles from "@/components/heads/Head.module.css";
import bands from "@/components/market/Market.module.css";
import { MarketFacts } from "@/components/facts/MarketFacts";
import { MarketLive } from "@/components/market/MarketLive";
import { StrategyName } from "@/components/StrategyName";
import { MintLabel } from "@/components/MintLabel";
import { formatDate, shortAddress } from "@/format";
import { ROUTES } from "@/routes";
import { readMarket } from "@/serverReads";
import type { Market, MarketMint } from "terminal-api/contract";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const read = await readMarket(address);
  if (!read.ok) return { title: "Market" };
  const label = (mint: string) => read.value.mints.find((m) => m.mint === mint)?.symbol ?? shortAddress(mint);
  return { title: `${label(read.value.base_mint)} / ${label(read.value.quote_mint)}` };
}

/**
 * A market's page (docs/spec/pipescope-screens.md, Market page): its head, then the top band, the
 * chart with the trades beneath it, live, and the lower band, the facts panel. The trade box joins
 * the top band with #121; the lower band's explanation and forms with their tickets, beside the facts.
 */
export default async function MarketPage({ params }: Props) {
  const { address } = await params;
  const read = await readMarket(address);
  if (!read.ok) {
    return (
      <div className={styles.failed} role="alert">
        <h1>Market</h1>
        <p>Could not load this market. {read.message}</p>
        <Link href={ROUTES.market(address)}>Try again</Link>
      </div>
    );
  }
  const value = read.value;
  const mint = (address: string) => value.mints.find((m) => m.mint === address)!;
  const base = mint(value.base_mint);
  const quote = mint(value.quote_mint);
  return (
    <div className={bands.page}>
      <MarketHead market={value} base={base} quote={quote} />
      <div className={bands.top}>
        {/* The chart's length and Flip are read from the page's address. */}
        <Suspense fallback={null}>
          <MarketLive market={value} />
        </Suspense>
      </div>
      <div className={bands.low}>
        <MarketFacts market={value.address} />
      </div>
    </div>
  );
}

function MarketHead({ market, base, quote }: { market: Market; base: MarketMint; quote: MarketMint }) {
  return (
    <header className={styles.head}>
      <h1>
        <MintLabel mint={base.mint} symbol={base.symbol} token={base.token} /> / <MintLabel mint={quote.mint} symbol={quote.symbol} token={quote.token} />
      </h1>
      <SubjectAddress address={market.address} short />
      <dl className={styles.facts}>
        <div>
          <dt>Strategy</dt>
          <dd>
            <Link href={ROUTES.strategy(market.strategy)}>
              <StrategyName program={market.strategy} name={market.strategy_name} metadata={market.strategy_metadata} />
            </Link>
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time dateTime={market.created_at}>{formatDate(new Date(market.created_at))}</time>
          </dd>
        </div>
      </dl>
    </header>
  );
}
