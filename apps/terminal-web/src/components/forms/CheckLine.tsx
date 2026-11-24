import type { Form } from "terminal-api/contract";
import { BRAND } from "@/brand";
import { formatInteger } from "@/format";
import { ShortAddress } from "../ShortAddress";
import styles from "./Forms.module.css";
import { Outcome } from "./Outcome";

/** Anchor's snake-case reading of an instruction's name as a program compiles it: `SetTaxes` reads `set_taxes`. */
const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();

/** The instruction a form's heading says it calls: the program's own name for it when found, else the metadata's. */
export const callsOf = (form: Form) => form.check.instruction ?? form.name;

/**
 * A form's result line (docs/spec/pipescope-screens.md, Explanation, actions and facts): which
 * instruction of which program it calls and whether an instruction with the discriminator it sends is
 * in the deployed program (PIPESCOPE-92, PIPESCOPE-143): a pass naming the instruction the program
 * runs, with the metadata's own name beside it when that differs, or a warn, "what this form calls
 * could not be checked".
 */
export function CheckLine({ form, program, deploySlot, via }: { form: Form; program: string; deploySlot: number | null; via?: "router" }) {
  const target = (
    <>
      {via === "router" ? "Pipeline's router, which calls " : ""}
      <code>{callsOf(form)}</code> on the strategy <ShortAddress address={program} />
    </>
  );
  if (form.check.outcome === "pass") {
    const renamed = form.check.instruction !== null && snake(form.check.instruction) !== form.name.toLowerCase();
    return (
      <p className={styles.result}>
        <Outcome outcome="pass" />
        <span>
          Calls {target}. An instruction with the discriminator this form sends is in the deployed program{deploySlot === null ? "" : `, as deployed in slot ${formatInteger(deploySlot)}`}.
          {renamed && (
            <>
              {" "}
              The metadata names it <code>{form.name}</code>, but the instruction that runs is <code>{form.check.instruction}</code>.
            </>
          )}
        </span>
      </p>
    );
  }
  return (
    <p className={styles.result}>
      <Outcome outcome="warn" />
      <span>
        Calls {target}: what this form calls could not be checked,{" "}
        {form.check.reason === "no-instruction-list" ? `since ${BRAND.name} has not read the deployed program's instructions yet.` : "since no instruction of the deployed program has the discriminator it sends."}
      </span>
    </p>
  );
}
