import Link from "next/link";
import type { StrategyDetail } from "terminal-api/contract";
import { formatDate, formatInteger, formatTokenAmount } from "@/format";
import { ROUTES } from "@/routes";
import { ShortAddress } from "../Address";
import { FlagFacts } from "../Flags";
import { StrategyName } from "../StrategyName";
import { FactList } from "./Facts";
import styles from "./Facts.module.css";

/** What a metadata status says, in the words the prototype settled (docs/spec/pipescope-screens.md). */
const METADATA_WORDS: Record<StrategyDetail["metadata"]["status"], string> = {
  valid: "Valid",
  missing: "Unavailable: none published",
  unreachable: "Unavailable: the link could not be fetched",
  invalid: "Unavailable: the document is not valid",
  "not-fetched": "Not read yet",
};

/**
 * The metadata's status, with the link itself as plain text (a link the author chose is never made
 * clickable), and what the fetch or Pipeline's validator said behind a disclosure, as plain text,
 * since it can quote the document.
 */
export function MetadataFact({ metadata }: { metadata: StrategyDetail["metadata"] }) {
  const said = [...metadata.errors, ...metadata.warnings];
  return (
    <>
      {METADATA_WORDS[metadata.status]}
      {metadata.uri && <span className={styles.sub}>{metadata.uri}</span>}
      {said.length > 0 && (
        <details className={styles.sub}>
          <summary>{metadata.status === "unreachable" ? "What the fetch said" : "What Pipeline's validator said"}</summary>
          <ul className={styles.extensions}>
            {said.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** Who can upgrade a program, as the facts word it. */
export function upgradeAuthorityFact(strategy: Pick<StrategyDetail, "upgrade_authority" | "flags">) {
  if (strategy.upgrade_authority)
    return (
      <>
        <ShortAddress address={strategy.upgrade_authority} /> can replace the program&apos;s code
      </>
    );
  if (strategy.flags.includes("frozen")) return "None: the program is frozen";
  if (strategy.flags.includes("program-missing")) return "None: no program is deployed at this address";
  return <span className={styles.note}>Not read yet</span>;
}

/** The current version: its slot, and its date when known. */
export function versionFact(strategy: Pick<StrategyDetail, "current_version">) {
  const v = strategy.current_version;
  if (!v) return <span className={styles.note}>Not read yet</span>;
  return `Deployed in slot ${formatInteger(v.deploy_slot)}${v.deployed_at ? `, ${formatDate(new Date(v.deployed_at))}` : ""}`;
}

/** A market's strategy, as the facts panel's "Its strategy" part shows it. */
export function StrategyFactList({ strategy }: { strategy: StrategyDetail }) {
  return (
    <>
      <FactList
        label="Its strategy"
        facts={[
          {
            name: "Strategy",
            value: (
              <Link href={ROUTES.strategy(strategy.program)}>
                <StrategyName program={strategy.program} name={strategy.name} metadata={strategy.metadata.status} />
              </Link>
            ),
          },
          { name: "Upgrade authority", value: upgradeAuthorityFact(strategy) },
          { name: "This version", value: versionFact(strategy) },
          { name: "Verified build", value: "None: source not verified" },
          { name: "Metadata", value: <MetadataFact metadata={strategy.metadata} /> },
          strategy.fee_paid !== null && { name: "Listing fee paid", value: `${formatTokenAmount(BigInt(strategy.fee_paid), 9)} SOL` },
        ]}
      />
      <FlagFacts facts={strategy.flag_facts} />
    </>
  );
}
