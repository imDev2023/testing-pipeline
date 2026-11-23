import type { Metadata } from "next";
import Link from "next/link";
import { SubjectAddress } from "@/components/Address";
import styles from "@/components/heads/Head.module.css";
import { StrategyFacts } from "@/components/strategy/StrategyFacts";
import { StrategyMarkets } from "@/components/strategy/StrategyMarkets";
import { AuthorText } from "@/components/Voice";
import page from "@/components/strategy/Strategy.module.css";
import { VersionHistory } from "@/components/strategy/VersionHistory";
import { formatDate, formatInteger, shortAddress } from "@/format";
import { ROUTES } from "@/routes";
import { readStrategy } from "@/serverReads";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const read = await readStrategy(address);
  // A name is the author's: the tab shows it with the short address, as every page does.
  return { title: read.ok && read.value.name ? `${read.value.name} (${shortAddress(address)})` : `Strategy ${shortAddress(address)}` };
}

/**
 * A strategy's page (docs/spec/pipescope-screens.md, Strategy page): its head, with the name its
 * valid metadata gives in the author's style, or its address and "Metadata unavailable"; its facts;
 * its markets; and its version history. What Canary saw comes with #125 and the explanation with #127.
 */
export default async function StrategyPage({ params }: Props) {
  const { address } = await params;
  const read = await readStrategy(address);
  if (!read.ok) {
    return (
      <div className={styles.failed} role="alert">
        <h1>Strategy</h1>
        <p>Could not load this strategy. {read.message}</p>
        <Link href={ROUTES.strategy(address)}>Try again</Link>
      </div>
    );
  }
  const strategy = read.value;
  return (
    <div className={page.page}>
      <header className={styles.head}>
        <h1>{strategy.name ? <AuthorText>{strategy.name}</AuthorText> : "Strategy"}</h1>
        {strategy.description && (
          <p className={page.description}>
            <AuthorText>{strategy.description}</AuthorText>
          </p>
        )}
        <SubjectAddress address={strategy.program} short />
        {!strategy.name && <p className={page.note}>{strategy.metadata.status === "not-fetched" ? "Metadata not read yet, so it is listed under its address" : "Metadata unavailable, so it is listed under its address"}</p>}
        <dl className={styles.facts}>
          <div>
            <dt>Markets</dt>
            <dd>{formatInteger(strategy.market_count)}</dd>
          </div>
          <div>
            <dt>Registered</dt>
            <dd>
              <time dateTime={strategy.registered_at}>{formatDate(new Date(strategy.registered_at))}</time>
            </dd>
          </div>
        </dl>
      </header>
      <StrategyFacts strategy={strategy} />
      <StrategyMarkets program={strategy.program} />
      <VersionHistory program={strategy.program} />
    </div>
  );
}
