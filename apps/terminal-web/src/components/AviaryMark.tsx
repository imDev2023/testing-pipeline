import { CLUSTER_USDC, WRAPPED_SOL } from "terminal-api/config";
import styles from "./MintLabel.module.css";

/**
 * The marks Aviary gives the two mints it names itself (docs/spec/pipescope-screens.md, "Token names
 * and images"): drawn here and shipped with the app, in the page's ink like the rest of Aviary's own
 * words, the same 20 px square as a token's image. SOL's is three slanted bars, USDC's a ringed
 * dollar sign.
 */
export function AviaryMark({ mint }: { mint: string }) {
  if (mint === WRAPPED_SOL) {
    return (
      <svg className={styles.mark} viewBox="0 0 20 20" width={20} height={20} aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M6.2 4h10.6l-3 3H3.2zM3.2 8.5h10.6l3 3H6.2zM6.2 13h10.6l-3 3H3.2z" />
      </svg>
    );
  }
  if (mint === CLUSTER_USDC) {
    return (
      <svg className={styles.mark} viewBox="0 0 20 20" width={20} height={20} aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          d="M12.6 7.6c-.4-.9-1.4-1.4-2.6-1.4-1.5 0-2.6.8-2.6 1.9 0 2.6 5.3 1.4 5.3 4 0 1.1-1.1 1.9-2.7 1.9-1.3 0-2.3-.6-2.7-1.5M10 4.8v1.4M10 13.8v1.4"
        />
      </svg>
    );
  }
  return null;
}
