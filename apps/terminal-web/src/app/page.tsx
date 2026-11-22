import { BRAND } from "@/brand";
import { ConnectionPanel } from "@/components/ConnectionPanel";
import styles from "./page.module.css";

/** The feed's page. Until the indexer lands (#116) it shows Aviary's own connection to devnet, in the panel pattern every later panel follows. */
export default function Feed() {
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>New on Pipeline</h1>
        <p className={styles.lede}>
          Anyone can register a strategy with Pipeline, and Pipeline vets none of them. {BRAND.name} will list every market and strategy on devnet with what
          it read and measured; the list arrives with {BRAND.name}&apos;s indexer.
        </p>
      </header>
      <div className={styles.panels}>
        <ConnectionPanel />
      </div>
    </div>
  );
}
