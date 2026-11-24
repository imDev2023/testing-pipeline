import { FAILED_SIMULATION_LOG_LINES } from "@/config";
import styles from "./market/TradeBox.module.css";

/** The last lines of a program's log behind a disclosure, as a refused quote and a failed simulation show them. */
export function LogTail({ logs }: { logs: readonly string[] }) {
  const tail = logs.slice(-FAILED_SIMULATION_LOG_LINES);
  if (!tail.length) return null;
  return (
    <details className={styles.logs}>
      <summary>The program&apos;s last {tail.length === 1 ? "log line" : `${tail.length} log lines`}</summary>
      <pre>{tail.join("\n")}</pre>
    </details>
  );
}
