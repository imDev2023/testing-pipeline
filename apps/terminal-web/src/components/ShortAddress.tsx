import { shortAddress } from "@/format";
import styles from "./ShortAddress.module.css";

/** An address shown short, "6efY...dnYp", with the whole address on hover (docs/spec/pipescope-screens.md, "On every page"). */
export function ShortAddress({ address }: { address: string }) {
  return (
    <span className={styles.address} title={address}>
      {shortAddress(address)}
    </span>
  );
}
