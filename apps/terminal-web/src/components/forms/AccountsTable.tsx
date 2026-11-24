import type { Form } from "terminal-api/contract";
import type { MintContext } from "@/formValues";
import { Table } from "../Table";
import { AccountWords } from "./AccountWords";

/**
 * "Every account it touches" (docs/spec/pipescope-screens.md, Explanation, actions and facts): each
 * account a form's instruction is given, by the metadata's name for it (an identifier, shown as code),
 * what it is in words, whether the instruction can change it, and whether it signs.
 */
export function AccountsTable({ form, context }: { form: Form; context: MintContext }) {
  return (
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
        cells: {
          name: <code>{account.name}</code>,
          what: <AccountWords source={account.source} context={context} />,
          writable: account.writable ? "yes" : "no",
          signer: account.signer ? "yes" : "no",
        },
      }))}
    />
  );
}
