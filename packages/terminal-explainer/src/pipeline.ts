// The P items (docs/spec/pipescope-explainer.md, Inputs): Pipeline's fixed rules and router facts,
// constant text Aviary keeps. Pipeline's fee is its SDK's constant, so it is stated in one place;
// who controls the router is the one value read, from the upgrade authority Aviary holds for it.
import { BPS_DENOMINATOR, PIPELINE_FEE_BPS } from "@pipeline-sol/sdk";
import type { Fact } from "./evidence";

const percent = (bps: bigint) => `${Number((Number(bps) * 100) / Number(BPS_DENOMINATOR))}%`;
const RULES = "Pipeline's documentation; constant text kept by Aviary";

/** Pipeline's rules, P1 to P6, with the router's upgrade authority as Aviary last read it (null when it has not). */
export function pipelineRules({ routerUpgradeAuthority }: { routerUpgradeAuthority: string | null }): Fact[] {
  return [
    { group: "Pipeline", label: "Pipeline fee", value: `${percent(PIPELINE_FEE_BPS)} of each swap through the router, taken by the router on every hop: on the input, or on the output when the output is the market's fee mint.`, source: "Pipeline's SDK, PIPELINE_FEE_BPS" },
    { group: "Pipeline", label: "Router protections on swaps", value: "The router moves your input into the strategy's vault, refuses the swap if you would receive less than your minimum, and never takes more than the amount you signed. You do not sign the call to the strategy, so it can pay you but cannot take from your accounts.", source: RULES },
    { group: "Pipeline", label: "Custom actions", value: "Any strategy instruction other than a swap is signed directly on the strategy; the router's protections and fee do not apply to it.", source: RULES },
    { group: "Pipeline", label: "Bypass", value: "A strategy may allow trades that skip the router; those pay no Pipeline fee and leave no swap event.", source: RULES },
    { group: "Pipeline", label: "Vetting", value: "Pipeline does not vet strategies; anyone can register one.", source: RULES },
    {
      group: "Pipeline",
      label: "Who controls the router",
      value: routerUpgradeAuthority ? `The router is upgradeable: its upgrade authority ${routerUpgradeAuthority} can replace the router's code.` : "The router's upgrade authority has not been read by Aviary.",
      source: "the router's ProgramData, read by Aviary's ProgramData watch",
    },
  ];
}
