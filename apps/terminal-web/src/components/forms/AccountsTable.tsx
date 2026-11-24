import type { Form } from "terminal-api/contract";
import type { MintContext } from "@/formValues";
import { Table } from "../Table";
import { AccountWords } from "./AccountWords";
import styles from "./Forms.module.css";

/**
 * "Every account it touches" (docs/spec/pipescope-screens.md, Explanation, actions and facts): each
 * account a form's instruction is given, by the metadata's name for it (an identifier, shown as code),
 * what it is in words, whether the instruction can change it, and whether it signs.
 */
export function AccountsTable({ form, context }: { form: Form; context: MintContext }) {
  return (
    <div className={styles.accounts}>
      <h4 className={styles.subheading} aria-hidden="true">
        Every account it touches
      </h4>
      <Table
        caption="Every account it touches"
        columns={[
          { key: "name", label: "Account" },
          { key: "what", label: "What it is" },
          { key: "writable", label: "Can change it" },
          { key: "signer", label: "Signs" },
        ]}
        rows={form.accounts.map((account, i) => ({
          key: `${i}-${account.name}`,
          // One element a cell, so a cell drawn as a labelled block at narrow widths keeps its value in one piece.
          cells: {
            name: (
              <span>
                <code>{account.name}</code>
              </span>
            ),
            what: (
              <span>
                <AccountWords source={account.source} context={context} />
              </span>
            ),
            writable: account.writable ? "yes" : "no",
            signer: account.signer ? "yes" : "no",
          },
        }))}
      />
    </div>
  );
}
