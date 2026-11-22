"use client";

import { Health } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { formatInteger } from "@/format";
import { Panel } from "./Panel";
import styles from "./ConnectionPanel.module.css";

// A module-level function, so the panel loads once per mount rather than once per render.
const loadHealth = (signal: AbortSignal) => getFromApi("/health", Health, { acceptStatuses: [503], signal });

/** What Aviary's API reads of devnet right now: the latest slot and whether its database answers. */
export function ConnectionPanel() {
  return (
    <Panel title={`${BRAND.name} on devnet`} what="devnet's latest slot" load={loadHealth}>
      {(health) => (
        <dl className={styles.facts}>
          <div>
            <dt>Latest slot</dt>
            <dd>{health.rpc.slot === null ? `Not read: ${health.rpc.error}.` : formatInteger(health.rpc.slot)}</dd>
          </div>
          <div>
            <dt>{BRAND.name}&apos;s database</dt>
            <dd>{health.database.ok ? "Answers." : `Not reached: ${health.database.error}.`}</dd>
          </div>
        </dl>
      )}
    </Panel>
  );
}
