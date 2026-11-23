"use client";

// A strategy's version history (docs/spec/pipescope-screens.md, Strategy page, "Version history";
// PIPESCOPE-19): one row for each strategy version, newest first, with its date, its slot and a link
// to its transaction. The newest is the one the page's results and explanation are for.
import { useCallback } from "react";
import { StrategyVersions, type StrategyVersion } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { formatDate, formatInteger } from "@/format";
import { ShortSignature } from "../Address";
import table from "../ListingTable.module.css";
import { useLoad } from "../Panel";
import styles from "./Strategy.module.css";

export const CURRENT_VERSION_NOTE = "The current version. The results and explanation on this page are for it.";
export const EARLIER_VERSION_NOTE = "An earlier version, replaced by an upgrade.";

/** When a version was deployed: its transaction's time, or when Aviary first saw it while that transaction is not found. */
function When({ version }: { version: StrategyVersion }) {
  const iso = version.deployed_at ?? version.seen_at;
  return <time dateTime={iso}>{formatDate(new Date(iso))}</time>;
}

export function VersionHistory({ program }: { program: string }) {
  const load = useCallback((signal: AbortSignal) => getFromApi(`/v1/strategies/${encodeURIComponent(program)}/versions`, StrategyVersions, { signal }), [program]);
  const { state, retry } = useLoad(load);
  return (
    <section className={styles.section} aria-labelledby="version-history">
      <h2 id="version-history" className={styles.title}>
        Version history {state.status === "loaded" && <span className={styles.count}>{formatInteger(state.data.versions.length)}</span>}
      </h2>
      {state.status === "loading" && <p className={styles.note}>Loading this strategy&apos;s versions…</p>}
      {state.status === "failed" && (
        <div className={styles.failed} role="alert">
          <p>Could not load this strategy&apos;s versions. {state.message}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {state.status === "loaded" &&
        (state.data.versions.length === 0 ? (
          <p className={styles.note}>Aviary has not read this strategy&apos;s program yet. Its versions appear here within a minute of the next read.</p>
        ) : (
          <div className={table.scroll}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col" className={table.num}>
                    Deployed in slot
                  </th>
                  <th scope="col">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {state.data.versions.map((v) => (
                  <tr key={v.deploy_slot} className={table.row}>
                    <td className={table.main}>
                      <When version={v} />
                      <span className={v.current ? styles.current : table.sub}>{v.current ? CURRENT_VERSION_NOTE : EARLIER_VERSION_NOTE}</span>
                    </td>
                    <td className={table.num}>
                      <span className={table.label}>Deployed in slot</span>
                      {formatInteger(v.deploy_slot)}
                    </td>
                    <td>
                      <span className={table.label}>Transaction</span>
                      {v.signature ? <ShortSignature signature={v.signature} /> : <span className={table.none}>not found yet</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
