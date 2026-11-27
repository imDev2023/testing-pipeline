import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SubjectAddress } from "@/components/Address";
import styles from "@/components/heads/Head.module.css";
import bands from "@/components/market/Market.module.css";
import { MarketFacts } from "@/components/facts/MarketFacts";
import { MarketLive } from "@/components/market/MarketLive";
import { ContainmentLive } from "@/products/containment/live";
import { MarketLowBand } from "@/components/market/MarketLowBand";
import { StrategyName } from "@/components/StrategyName";
import { MintLabel } from "@/components/MintLabel";
import { formatDate, shortAddress } from "@/format";
import { ROUTES } from "@/routes";
import { readMarket, readMarketCanary, readMarketContainment, readStrategyExplanation } from "@/serverReads";
import { StrandedHead, UpgradeNotice, type CanaryRead } from "@/components/canary/MarketCanary";
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
 * chart with the trades beneath it, live, and the trade box in the column beside them; then the lower
 * band, a product's panel, the strategy version's explanation (#127) and the strategy's forms beside
 * the facts panel. What Canary
 * saw is read with the page: a stranded market's head carries its fail and it gets no trade box, the
 * trade box repeats a failed exit test, and after an upgrade the notice sits under the head (#125).
 */
export default async function MarketPage({ params }: Props) {
  const { address } = await params;
  const [read, canary] = await Promise.all([readMarket(address), readMarketCanary(address)]);
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
  const [explanation, containment] = await Promise.all([readStrategyExplanation(value.strategy), readMarketContainment(value.address, value.strategy)]);
  const mint = (address: string) => value.mints.find((m) => m.mint === address)!;
  const base = mint(value.base_mint);
  const quote = mint(value.quote_mint);
  return (
    <div className={bands.page}>
      <MarketHead market={value} base={base} quote={quote} canary={canary} explained={!explanation.ok || explanation.value.explanation !== null} />
      {/* The containment panel's reads reach the trade box's rule through this (#76). */}
      <ContainmentLive initial={containment?.ok ? containment.value : null}>
        <div className={`${bands.top} ${bands.withTrade}`}>
          {/* The chart's length and Flip are read from the page's address. */}
          <Suspense fallback={null}>
            <MarketLive market={value} canary={canary} />
          </Suspense>
        </div>
        <MarketLowBand market={value} explanation={explanation} containment={containment} facts={<MarketFacts market={value.address} canary={canary} />} />
      </ContainmentLive>
    </div>
  );
}

function MarketHead({ market, base, quote, canary, explained }: { market: Market; base: MarketMint; quote: MarketMint; canary: CanaryRead; explained: boolean }) {
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
      {canary.ok && canary.value.summary?.stranded && <StrandedHead />}
      {canary.ok && <UpgradeNotice upgrade={canary.value.upgrade} explained={explained} />}
    </header>
  );
}
