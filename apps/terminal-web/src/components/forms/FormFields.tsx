"use client";

import { useId } from "react";
import type { Form, FormArg } from "terminal-api/contract";
import { decimalsOf, mintOf } from "@/formValues";
import { MintFactList } from "../facts/MarketFacts";
import { MintLabel } from "../MintLabel";
import { AuthorText } from "../Voice";
import styles from "./Forms.module.css";
import type { FormFields as Fields } from "./useFormFields";

/**
 * A form's fields (docs/spec/pipescope-screens.md, Explanation, actions and facts, and Create market):
 * first each address the form asks for, a mint's facts beneath it as soon as it is read; then each
 * argument, with its author's label in the author's style and, plainly, the argument's name and type,
 * an amount in its mint's tokens when the metadata names the mint. `wallet` fills an address field
 * with the connected wallet's.
 */
export function FormFields({ form, fields, wallet }: { form: Form; fields: Fields; wallet: string | null }) {
  const id = useId();
  return (
    <fieldset className={styles.fields}>
      <legend className={styles.srOnly}>The form&apos;s fields</legend>
      {form.inputs.map((input) => {
        const typed = (fields.inputs[input.name] ?? "").trim();
        const read = input.mint ? fields.entered[typed] : undefined;
        const fieldId = `${id}-input-${input.name}`;
        return (
          <div key={input.name} className={styles.field}>
            <label htmlFor={fieldId} className={styles.fieldLabel}>
              <span>
                <code>{input.name}</code> {input.mint ? "a mint, by its address" : "an address"}
              </span>
            </label>
            <div className={styles.control}>
              <input id={fieldId} type="text" autoComplete="off" spellCheck={false} value={fields.inputs[input.name] ?? ""} onChange={(e) => fields.setInput(input.name, e.target.value)} />
              {!input.mint && wallet && (
                <button type="button" onClick={() => fields.setInput(input.name, wallet)}>
                  Use your wallet
                </button>
              )}
            </div>
            {read?.status === "loading" && <p className={styles.note}>Reading this mint…</p>}
            {read?.status === "failed" && (
              <p className={styles.note} role="alert">
                Could not read this mint. {read.message}
              </p>
            )}
            {read?.status === "read" &&
              (read.facts.readable ? (
                <div className={styles.facts} aria-label={`The facts of ${input.name}`}>
                  <MintFactList mint={read.facts} />
                </div>
              ) : (
                <p className={styles.reason} role="alert">
                  This address is no mint.
                </p>
              ))}
          </div>
        );
      })}
      {form.args.map((arg) => (
        <Field key={arg.name} id={`${id}-arg-${arg.name}`} arg={arg} fields={fields} wallet={wallet} />
      ))}
    </fieldset>
  );
}

function Field({ id, arg, fields, wallet }: { id: string; arg: FormArg; fields: Fields; wallet: string | null }) {
  const reading = fields.readings[arg.name];
  const mint = mintOf(arg.decimals_of, fields.context);
  const decimals = decimalsOf(arg.decimals_of, fields.context);
  const described = arg.description ? `${id}-description` : undefined;
  const label = (
    <span className={styles.fieldLabel}>
      {arg.label && (
        <>
          <AuthorText>{arg.label}</AuthorText>{" "}
        </>
      )}
      <span className={styles.identifier}>
        <code>{arg.name}</code> {arg.type}
        {mint && decimals !== null && (
          <>
            , in <MintLabel mint={mint.mint} symbol={mint.symbol} token={mint.token} />
          </>
        )}
      </span>
    </span>
  );
  if (arg.type === "bool") {
    return (
      <div className={styles.field}>
        <label className={styles.control}>
          <input type="checkbox" checked={fields.values[arg.name] === true} onChange={(e) => fields.setValue(arg.name, e.target.checked)} aria-describedby={described} />
          {label}
        </label>
        {arg.description && (
          <p id={described} className={styles.note}>
            <AuthorText>{arg.description}</AuthorText>
          </p>
        )}
      </div>
    );
  }
  const numeric = ["u8", "u16", "u32", "u64", "i64"].includes(arg.type);
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {arg.description && (
        <p id={described} className={styles.note}>
          <AuthorText>{arg.description}</AuthorText>
        </p>
      )}
      <div className={styles.control}>
        <input
          id={id}
          type="text"
          inputMode={numeric ? (decimals !== null ? "decimal" : "numeric") : undefined}
          autoComplete="off"
          spellCheck={false}
          value={typeof fields.values[arg.name] === "string" ? (fields.values[arg.name] as string) : ""}
          aria-describedby={described}
          aria-invalid={reading?.kind === "invalid" || undefined}
          onChange={(e) => fields.setValue(arg.name, e.target.value)}
        />
        {arg.type === "pubkey" && wallet && (
          <button type="button" onClick={() => fields.setValue(arg.name, wallet)}>
            Use your wallet
          </button>
        )}
      </div>
      {reading?.kind === "invalid" && (
        <p className={styles.reason} role="alert">
          {reading.reason}
        </p>
      )}
    </div>
  );
}
