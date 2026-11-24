// The sentences served with each Canary result (docs/spec/pipescope-screens.md, Canary outcomes;
// docs/spec/pipescope-canary.md, The checks and What counts as "a buyer could not sell back";
// CANARY-21; #124), written once here so the page, the trade box and the Telegram bot show the
// same words. The reason itself is the binary's (crates/canary), which states the numbers behind
// an outcome; these say what each check does and when and on which version it ran, and which
// results put the "could not sell back" notice in the trade box. No policy value is repeated here:
// sizes, counts and bands are in the binary's reasons.
import type { CanaryRecord, StoredCanaryResult } from "terminal-db";

/** What each check does, from docs/spec/pipescope-canary.md, The checks. */
export const CHECK_ABOUT: Readonly<Record<string, string>> = {
  readable: "calls `pipeline_market_info`, resolves accounts and quotes the smallest size in every direction.",
  conformance: "runs `pipeline-check` on the copy and keeps its whole report.",
  exit_sizes: "buys each size and sells everything bought in the same slot.",
  exit_hold: "buys the reference size, then sells after each wait, each wait from the same bought state.",
  exit_late: "moves the clock forward by each wait, then buys and sells the reference size.",
  exit_launch_clock: "sets the clock to each launch-clock position, then buys and sells the reference size.",
  exit_wallets: "round-trips the reference size from fresh wallets, the market creator, the strategy's upgrade authority and each mint authority, each from the same starting state.",
  exit_transferred: "one wallet buys the reference size and sends the tokens to a second wallet, which sells them.",
  exit_queue: "wallets buy the reference size one after another, then sell in the same order.",
  quote_matches_swap: "compares every swap the run commits with the quote taken in the same state just before it.",
  cost: "reports the round-trip return at every size, and splits the loss into Pipeline's fee, Token-2022 transfer fees and the strategy's own fee and spread.",
  direct_call: "calls the strategy's `pipeline_swap` without the router, with another key signing as the market signer and with the real market signer not signing.",
  token_authorities: "acts as each authority that exists on the market's mints, then trades again.",
  transaction_accounts: "lists accounts the strategy asks for that describe the transaction, not the market.",
  contained_mint: "reads a hooked mint's hook program, whether it can still be upgraded, and the hook's authority.",
  outside_supply: "after the ordinary buy, quotes a sale of the supply held outside the market's pool, and finds the part the market cannot buy back.",
  custom_instructions: "lists every instruction in the strategy's code beyond Pipeline's six, with how often each has been called and by which signers.",
};

/** "Check `exit_sizes`: buys each size and sells everything bought in the same slot." */
export function aboutCheck(check: string): string {
  const about = CHECK_ABOUT[check];
  return about ? `Check \`${check}\`: ${about}` : `Check \`${check}\`.`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const grouped = (n: number) => n.toLocaleString("en-US");
const two = (n: number) => String(n).padStart(2, "0");

/** "10 Nov 2026", in UTC. */
export const dayOf = (at: Date): string => `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;

/** "Run on 10 Nov 2026, 04:54 UTC at slot 520,629,097, on the strategy version deployed in slot 520,151,724." */
export function ranLine(record: CanaryRecord): string {
  const at = new Date(record.run_at * 1000);
  const when = `${dayOf(at)}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
  const deployed = record.strategy_version.deploy_slot;
  const version = deployed === null ? "on a strategy version whose deploy slot is unknown" : `on the strategy version deployed in slot ${grouped(deployed)}`;
  return `Run on ${when} at slot ${grouped(record.slot)}, ${version}.`;
}

/** The exit checks whose results can say a buyer could not sell back (CANARY-21). */
export const SELL_BACK_CHECKS: readonly string[] = ["exit_sizes", "exit_hold", "exit_wallets", "exit_transferred", "exit_queue"];

/**
 * The "could not sell back" notice of a market (CANARY-21, CANARY-38): one sentence for each latest
 * exit result of the current version whose `could_not_sell_back` is true, a fail or a warn alike.
 * The sentence is the result's own reason, which states the size, the wait or the wallet's role and
 * the refusing program's error, after the day Canary saw it: "In Canary's test on 23 Nov 2026, a
 * wallet that bought 1 SOL or more could not sell back (...)".
 */
export function couldNotSellBack(latest: StoredCanaryResult[]): { check: string; sentence: string }[] {
  return latest
    .filter((r) => SELL_BACK_CHECKS.includes(r.check) && (r.record.numbers as { could_not_sell_back?: unknown } | null)?.could_not_sell_back === true)
    .map((r) => ({ check: r.check, sentence: `In Canary's test on ${dayOf(new Date(r.record.run_at * 1000))}, ${continued(r.record.reason)}` }));
}

/** A sentence carried on after a comma: its first word lower-cased when it is an ordinary word ("A wallet", "The market creator", a pair's "Buying mint 2:"), never a name or a number. */
const continued = (sentence: string) => (/^(A|An|The|All|Every|Each|One|Five|Some|Buying)\b/.test(sentence) ? sentence[0]!.toLowerCase() + sentence.slice(1) : sentence);
