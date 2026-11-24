import type { Metadata } from "next";
import Link from "next/link";
import { SubjectAddress } from "@/components/Address";
import styles from "@/components/heads/Head.module.css";
import { Explanation } from "@/components/explanation/Explanation";
import { StrategyDescription } from "@/components/strategy/StrategyDescription";
import { StrategyFacts } from "@/components/strategy/StrategyFacts";
import { StrategyMarkets } from "@/components/strategy/StrategyMarkets";
import { AuthorText } from "@/components/Voice";
import page from "@/components/strategy/Strategy.module.css";
import { VersionHistory } from "@/components/strategy/VersionHistory";
import { formatDate, formatInteger, shortAddress } from "@/format";
import { ROUTES } from "@/routes";
import { readStrategy, readStrategyExplanation, readVersionCanary } from "@/serverReads";
import { UpgradeNotice } from "@/components/canary/MarketCanary";
import { CanaryHeading } from "@/components/canary/CanarySaw";
import { VersionCanary } from "@/components/canary/VersionCanary";

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
 * its explanation beside its facts at desktop width, before them in one column (#127); what Canary
 * saw on its current version, with the upgrade notice under the head while a new version has no
 * results yet (#125); its markets; and its version history.
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
  const [canary, explanation] = await Promise.all([strategy.current_version ? readVersionCanary(strategy.program, strategy.current_version.deploy_slot) : null, readStrategyExplanation(strategy.program)]);
  // The notice names the explanation as pending only when the read says there is none: when the read
  // failed the panel loads it on its own and may show one.
  const explained = !explanation.ok || explanation.value.explanation !== null;
  return (
    <div className={page.page}>
      <header className={styles.head}>
        <h1>{strategy.name ? <AuthorText>{strategy.name}</AuthorText> : "Strategy"}</h1>
        {strategy.description && <StrategyDescription text={strategy.description} cut={strategy.metadata.removed?.truncated.includes("description") ?? false} />}
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
        {canary?.ok && <UpgradeNotice upgrade={canary.value.upgrade} explained={explained} />}
      </header>
      <div className={page.explained}>
        <Explanation program={strategy.program} read={explanation} />
        <StrategyFacts strategy={strategy} />
      </div>
      {canary === null ? (
        <section className={page.canary} aria-label="What Canary saw on this version">
          <CanaryHeading level={2}>What Canary saw on this version</CanaryHeading>
          <p className={page.note}>Canary runs once this strategy&apos;s version has been read.</p>
        </section>
      ) : canary.ok ? (
        <VersionCanary rollup={canary.value} />
      ) : (
        <section className={page.canary} aria-label="What Canary saw on this version" role="alert">
          <CanaryHeading level={2}>What Canary saw on this version</CanaryHeading>
          <p>
            Could not load what Canary saw. {canary.message} <a href="">Try again</a>
          </p>
        </section>
      )}
      <StrategyMarkets program={strategy.program} />
      <VersionHistory program={strategy.program} />
    </div>
  );
}
