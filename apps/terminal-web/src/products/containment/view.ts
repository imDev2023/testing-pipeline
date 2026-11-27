// What the containment panel, the trade box and the tax AMM's launch form say about a contained token
// (docs/spec/containment-hook.md, "In Aviary"; #76), in words, from the API's reading of the chain
// (`GET /v1/markets/{market}/containment`). The hook is not a strategy, so these words are Aviary's.
import { CONTAINMENT_HOOK_PROGRAM_ADDRESS } from "containment-hook-scripts/client/index.ts";
import type { ContainedMint, MarketContainment } from "terminal-api/containment";
import type { MintFacts } from "terminal-api/contract";

/** The rule in one line: the panel's, and the trade box's before a buy. */
export const CONTAINED_RULE = "This token can only be bought and sold in this market until it unlocks, and cannot be sent to another wallet.";

/** The tax collected as a share of the goal, in percent to one decimal place, at most 100; null when the tax collected could not be read. */
export function goalShare(entry: ContainedMint): number | null {
  if (entry.collected === null) return null;
  const goal = BigInt(entry.goal);
  if (goal === 0n) return 100;
  const tenths = (BigInt(entry.collected) * 1_000n) / goal;
  return Number(tenths > 1_000n ? 1_000n : tenths) / 10;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** A span of seconds in its two largest units, the second left out when it is zero: "3 days 5 hours", "2 hours". */
function span(seconds: number): string {
  let left = Math.max(0, Math.floor(seconds));
  const counts = SPAN_UNITS.map(([size, unit]) => {
    const n = Math.floor(left / size);
    left -= n * size;
    return [n, unit] as const;
  });
  const first = counts.findIndex(([n]) => n > 0);
  if (first < 0) return "0 seconds";
  const [n, unit] = counts[first]!;
  const next = counts[first + 1];
  return next && next[0] > 0 ? `${plural(n, unit)} ${plural(next[0], next[1])}` : plural(n, unit);
}

const SPAN_UNITS: readonly (readonly [number, string])[] = [
  [86_400, "day"],
  [3_600, "hour"],
  [60, "minute"],
  [1, "second"],
];

/** The time left until a deadline at `now` (both Unix seconds), or how long ago it passed. */
export function timeLeft(deadline: number, now: number): string {
  return deadline > now ? `in ${span(deadline - now)}` : `passed ${span(now - deadline)} ago`;
}

/** The trade box's one line before buying `receive` on this market: the rule when it is a contained token, else null. */
export function containedRuleFor(containment: MarketContainment | null, receive: string): string | null {
  return containment?.contained.some((m) => m.mint === receive && m.status === "contained") ? CONTAINED_RULE : null;
}

/**
 * The tax AMM's launch form's refusal of a mint whose transfer hook is ours, before any signature
 * (docs/spec/containment-hook.md, "Launch in v1"): its seed would fail for a token not yet bound, and
 * a token already bound has its home market. Null for any other mint, which the program's own mint
 * rules judge in the simulation.
 */
export function containedLaunchRefusal(facts: MintFacts): string | null {
  const hook = facts.extensions.find((e) => e.name === "Transfer hook");
  if (hook?.address !== CONTAINMENT_HOOK_PROGRAM_ADDRESS) return null;
  const who = facts.token?.symbol ?? facts.token?.name ?? "This token";
  return `${who}'s transfer hook is Aviary's containment hook, so this form cannot launch it: a contained token is launched by the containment hook's launch script, which binds it to its home market before the seed, and a token already bound has its home market.`;
}
