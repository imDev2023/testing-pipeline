"use client";

import { useState } from "react";
import { EXPLORER } from "@/config";
import styles from "./Address.module.css";

/** An address that is the subject of its page: whole, with Copy and a link to the block explorer. */
export function SubjectAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <span className={styles.subject}>
      {/* On a narrow screen the address breaks once, at its middle, rather than leaving a few characters on a line of their own. */}
      <code className={styles.whole}>
        {address.slice(0, Math.ceil(address.length / 2))}
        <wbr />
        {address.slice(Math.ceil(address.length / 2))}
      </code>
      <span className={styles.actions}>
        <button type="button" onClick={copy} aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </button>
        <a href={EXPLORER.address(address)} rel="noreferrer" target="_blank">
          Explorer
        </a>
      </span>
    </span>
  );
}
