import type { Metadata } from "next";
import Link from "next/link";
import { SubjectAddress } from "@/components/Address";
import styles from "@/components/heads/Head.module.css";
import { MintLabel } from "@/components/MintLabel";
import { ShortAddress } from "@/components/ShortAddress";
import { formatDate, shortAddress } from "@/format";
import { ROUTES } from "@/routes";
import { readMarket } from "@/serverReads";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const read = await readMarket(address);
  if (!read.ok) return { title: "Market" };
  const label = (mint: string) => read.value.mints.find((m) => m.mint === mint)?.symbol ?? shortAddress(mint);
  return { title: `${label(read.value.base_mint)} / ${label(read.value.quote_mint)}` };
}

/**
 * A market's page (docs/spec/pipescope-screens.md, Market page). This ticket draws its head, so a
 * row of the feed opens somewhere real; the chart, trades and trade box come with #118 and #121.
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
  const market = read.value;
  const mint = (address: string) => market.mints.find((m) => m.mint === address)!;
  const base = mint(market.base_mint);
  const quote = mint(market.quote_mint);
  return (
    <header className={styles.head}>
      <h1>
        <MintLabel mint={base.mint} symbol={base.symbol} /> / <MintLabel mint={quote.mint} symbol={quote.symbol} />
      </h1>
      <SubjectAddress address={market.address} short />
      <dl className={styles.facts}>
        <div>
          <dt>Strategy</dt>
          <dd>
            <Link href={ROUTES.strategy(market.strategy)}>
              <ShortAddress address={market.strategy} />
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
