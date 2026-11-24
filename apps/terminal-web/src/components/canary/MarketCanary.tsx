// What a market page says of Canary outside the facts panel (docs/spec/pipescope-screens.md, Trade
// box, Markets that cannot trade and Explanation, actions and facts, "After an upgrade";
// docs/spec/pipescope.md, A failed exit test in the trade box and When a strategy is upgraded;
// PIPESCOPE-18, PIPESCOPE-19, PIPESCOPE-79; #125). Every sentence about a result is the API's.
import type { CanaryResults, CanaryUpgrade, Market } from "terminal-api/contract";
import { formatDayOf, formatInteger } from "@/format";
import { TokenAmount } from "../MarketsTable";
import { Outcome } from "./Outcome";
import styles from "./Canary.module.css";

/** Canary's results as a page read them: the API's answer, or why it could not be read. */
export type CanaryRead = { ok: true; value: CanaryResults } | { ok: false; message: string };

/**
 * The notice under the head of a strategy page and its market pages, until the new version has results
 * of its own; once the new version has its explanation (#127), it says only the tests are pending, so
 * it never contradicts the explanation shown below it.
 */
export function UpgradeNotice({ upgrade, explained = false }: { upgrade: CanaryUpgrade | null; explained?: boolean }) {
  if (!upgrade) return null;
  return (
    <p className={styles.plainNotice} role="status">
      Upgraded on {formatDayOf(new Date(upgrade.upgraded_at))}; {explained ? "tests" : "tests and explanation"} for this version are pending.
    </p>
  );
}

/** The fact a stranded market's head carries, as a fail. */
export function StrandedHead() {
  return (
    <p className={styles.headFact}>
      <Outcome outcome="fail" /> <span>the strategy&apos;s current version cannot read this market</span>
    </p>
  );
}

/** In place of a stranded market's trade box: why it cannot trade, and what its vaults still hold. */
export function StrandedPanel({ market, canary }: { market: Market; canary: CanaryResults }) {
  // A stranded market has results, so its strategy's version is recorded.
  const version = canary.version!;
  const deployedAt = version.deployed_at;
  const leftBehind = deployedAt !== null && new Date(market.created_at) < new Date(deployedAt);
  return (
    <section className={styles.stranded} aria-label="This market cannot be traded">
      <p>
        This market cannot be traded through Pipeline. The current version of its strategy, deployed in slot {formatInteger(version.deploy_slot)}, cannot read this market&apos;s state, so it can give no quote and take no swap.
        {leftBehind && " The market was left behind by an upgrade of the strategy."}
      </p>
      <div className={styles.holdings}>
        <span className={styles.holdingsLabel}>What its vaults still hold</span>
        {market.mints.map((m) => (
          <TokenAmount key={m.mint} raw={m.liquidity} decimals={m.decimals} mint={m.mint} symbol={m.symbol} token={m.token} />
        ))}
      </div>
    </section>
  );
}

/** The line a market that refuses every trade by its own rules keeps above its trade box. */
export function RefusesLine({ canary }: { canary: CanaryResults }) {
  const refusal = canary.summary?.refuses;
  if (!refusal) return null;
  const error = refusal.name ? `${refusal.name}${refusal.message ? `: ${refusal.message}` : ""}` : (refusal.raw ?? "its own error");
  return <p className={styles.plainNotice}>This market refuses every trade by its own rules ({error}). A quote here returns the strategy&apos;s own error.</p>;
}

/**
 * The exit-test notice, on canary yellow directly above the trade box's button (PIPESCOPE-18): each
 * sentence the API wrote, and one tick box, asked again on every visit and stored nowhere.
 */
export function ExitNotice({ sentences, ticked, onTick, id }: { sentences: readonly string[]; ticked: boolean; onTick: (ticked: boolean) => void; id: string }) {
  if (!sentences.length) return null;
  return (
    <div className={styles.notice} data-canary="notice" role="note">
      {sentences.map((sentence) => (
        <p key={sentence}>{sentence}</p>
      ))}
      <label className={styles.tick} htmlFor={id}>
        <input id={id} type="checkbox" checked={ticked} onChange={(e) => onTick(e.target.checked)} />
        I have read this
      </label>
    </div>
  );
}
