import type { ReactNode } from "react";
import styles from "./Table.module.css";

export type Column = { key: string; label: string };
export type Row = { key: string; cells: Record<string, ReactNode> };

/**
 * A table that becomes a list of small blocks at the width theme.css names, one block a row, with
 * each value under its column's name (docs/spec/pipescope-screens.md, "Phones and narrow windows").
 */
export function Table({ caption, columns, rows }: { caption: string; columns: Column[]; rows: Row[] }) {
  return (
    <table className={styles.table}>
      <caption className={styles.caption}>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} scope="col">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            {columns.map((column) => (
              <td key={column.key} data-label={column.label}>
                {row.cells[column.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
