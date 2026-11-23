import type { Metadata } from "next";
import Link from "next/link";
import { SubjectAddress } from "@/components/Address";
import styles from "@/components/heads/Head.module.css";
import { formatDate, formatInteger, shortAddress } from "@/format";
import { ROUTES } from "@/routes";
import { readStrategy } from "@/serverReads";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: `Strategy ${shortAddress(address)}` };
}

/**
 * A strategy's page (docs/spec/pipescope-screens.md, Strategy page). This ticket draws its head, so
 * a row of the feed opens somewhere real; its name comes with strategy metadata (#119), its version
 * history with #117. Until it has a name, its heading says what it is and its address follows.
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
    <header className={styles.head}>
      <h1>Strategy</h1>
      <SubjectAddress address={strategy.program} short />
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
  );
}
