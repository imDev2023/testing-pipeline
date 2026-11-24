"use client";

import { isAddress } from "@solana/kit";
import { useEffect, useRef, useState } from "react";
import { MintFacts, type Form, type FormArg } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { amountDecimals, argValue, type ArgReading, type FieldValue, type MintContext, type MintInfo } from "@/formValues";

/** A mint entered by address: being read, read with its facts, or not readable. */
export type EnteredMint = { status: "loading" } | { status: "read"; facts: MintFacts } | { status: "failed"; message: string };

export type FormFields = {
  values: Record<string, FieldValue>;
  setValue: (name: string, value: FieldValue) => void;
  inputs: Record<string, string>;
  setInput: (name: string, value: string) => void;
  /** Each mint input's mint, once a valid address is typed, keyed by the address typed. */
  entered: Record<string, EnteredMint | undefined>;
  /** Reads a mint again whose read failed. */
  retryMint: (mint: string) => void;
  context: MintContext;
  readings: Record<string, ArgReading>;
  /** What the form sends when every field holds a usable value, else null with the first thing missing. */
  request: { args: Record<string, FieldValue>; inputs: Record<string, string> } | null;
  missing: string | null;
  /** Bumped on every change, so a review built for earlier values is left. */
  version: number;
};

/**
 * A form's values and what they read as (docs/spec/pipescope.md, Custom-action and create-market forms):
 * each argument as typed and as the argument it becomes, each address entered, and the facts of each
 * mint entered by address, read as soon as a whole address is typed. A product's own form may start
 * with values filled in (`initial`, #57).
 */
export function useFormFields(form: Form, market: readonly MintInfo[], initial?: { values?: Record<string, FieldValue>; inputs?: Record<string, string> }): FormFields {
  const [values, setValues] = useState<Record<string, FieldValue>>(() => ({ ...initial?.values }));
  const [inputs, setInputs] = useState<Record<string, string>>(() => ({ ...initial?.inputs }));
  const [entered, setEntered] = useState<Record<string, EnteredMint | undefined>>({});
  const [version, setVersion] = useState(0);

  // Each whole address typed into a mint's field is read once, each with its own request, so one
  // answer never cuts off another still on its way; a read that failed is read again when asked
  // (`retryMint`). Until its answer, an address reads as loading.
  const mintAddresses = [...new Set(form.inputs.filter((i) => i.mint).map((i) => (inputs[i.name] ?? "").trim()).filter((a) => isAddress(a)))];
  const typedMints = mintAddresses.join(",");
  const reading = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const typed = new Set(typedMints ? typedMints.split(",") : []);
    for (const [mint, controller] of reading.current) {
      if (!typed.has(mint)) {
        controller.abort();
        reading.current.delete(mint);
      }
    }
    for (const mint of typed) {
      if (entered[mint] || reading.current.has(mint)) continue;
      const controller = new AbortController();
      reading.current.set(mint, controller);
      getFromApi(`/v1/mints/${mint}`, MintFacts, { signal: controller.signal }).then(
        (facts) => setEntered((now) => ({ ...now, [mint]: { status: "read", facts } })),
        (e: unknown) => !controller.signal.aborted && setEntered((now) => ({ ...now, [mint]: { status: "failed", message: e instanceof Error ? e.message : String(e) } })),
      ).finally(() => {
        if (reading.current.get(mint) === controller) reading.current.delete(mint);
      });
    }
  }, [typedMints, entered]);
  useEffect(() => {
    const all = reading.current;
    return () => {
      for (const controller of all.values()) controller.abort();
      all.clear();
    };
  }, []);
  const enteredNow: Record<string, EnteredMint | undefined> = { ...entered, ...Object.fromEntries(mintAddresses.filter((a) => !entered[a]).map((a) => [a, { status: "loading" } as const])) };

  const byInput: Record<string, MintInfo | null> = {};
  for (const input of form.inputs.filter((i) => i.mint)) {
    const read = enteredNow[(inputs[input.name] ?? "").trim()];
    byInput[input.name] = read?.status === "read" && read.facts.readable ? { mint: read.facts.mint, symbol: read.facts.symbol, token: read.facts.token, decimals: read.facts.decimals } : null;
  }
  const context: MintContext = { market, inputs: byInput };
  const readings: Record<string, ArgReading> = Object.fromEntries(form.args.map((arg) => [arg.name, argValue(arg, values[arg.name], amountDecimals(arg, context))]));
  const { request, missing } = requestOf(form, inputs, enteredNow, readings, context);

  return {
    values,
    setValue: (name, value) => {
      setValues((now) => ({ ...now, [name]: value }));
      setVersion((n) => n + 1);
    },
    inputs,
    setInput: (name, value) => {
      setInputs((now) => ({ ...now, [name]: value }));
      setVersion((n) => n + 1);
    },
    entered: enteredNow,
    retryMint: (mint) =>
      setEntered((now) => {
        const { [mint]: _failed, ...rest } = now;
        return rest;
      }),
    context,
    readings,
    request,
    missing,
    version,
  };
}

/** What a form sends when every field holds a usable value, else null with the first thing missing. */
function requestOf(form: Form, inputs: Record<string, string>, entered: Record<string, EnteredMint | undefined>, readings: Record<string, ArgReading>, context: MintContext): Pick<FormFields, "request" | "missing"> {
  for (const input of form.inputs) {
    const typed = (inputs[input.name] ?? "").trim();
    if (!isAddress(typed)) return { request: null, missing: `Enter ${input.name} as an address.` };
    const read = input.mint ? entered[typed] : undefined;
    if (input.mint && read?.status === "read" && !read.facts.readable) return { request: null, missing: `${input.name} is no mint.` };
  }
  for (const arg of form.args) {
    // An amount whose mint is entered by address waits for that mint's decimals.
    if (arg.decimals_of?.kind === "input" && UNSIGNED.includes(arg.type) && amountDecimals(arg, context) === null) {
      const read = entered[(inputs[arg.decimals_of.name] ?? "").trim()];
      if (read?.status === "failed") return { request: null, missing: `${arg.decimals_of.name} could not be read, so ${arg.name} has no decimals yet: try reading it again.` }; return { request: null, missing: `${arg.name} is written in the decimals of ${arg.decimals_of.name}, which is not read yet.` };
    }
    const reading = readings[arg.name]!;
    if (reading.kind === "empty") return { request: null, missing: `Fill in ${arg.name}.` };
    if (reading.kind === "invalid") return { request: null, missing: `${arg.name}: ${reading.reason}` };
  }
  const args = Object.fromEntries(form.args.map((arg) => [arg.name, (readings[arg.name] as { value: FieldValue }).value]));
  return { request: { args, inputs: Object.fromEntries(form.inputs.map((i) => [i.name, (inputs[i.name] ?? "").trim()])) }, missing: null };
}

/** The unsigned integer types, whose amounts are typed in their mint's decimals (./formValues, amountDecimals). */
const UNSIGNED: readonly FormArg["type"][] = ["u8", "u16", "u32", "u64"];
