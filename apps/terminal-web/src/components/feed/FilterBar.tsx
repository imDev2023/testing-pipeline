"use client";

// The feed's four filters (docs/spec/pipescope-screens.md, Feed, "Filters"; PIPESCOPE-72): liquidity
// and volume in the last 24 hours on a market's SOL side, the time since creation, each one of the
// screens' config steps, and "Hide markets with", which lists Pipeline's trust flags present, each
// with its fixed description. Every filter starts off; a change is a new page address.
import { useState } from "react";
import type { FlagFact } from "terminal-api/contract";
import { FEED_FILTERS } from "@/config";
import { pageHref, type FeedFilters } from "@/feedFilters";
import flagStyles from "../Flags.module.css";
import styles from "./FilterBar.module.css";

const sol = (n: number) => `At least ${n} SOL`;
const within = (hours: number) => (hours === 1 ? "In the last hour" : hours % 24 === 0 && hours > 24 ? `In the last ${hours / 24} days` : `In the last ${hours} hours`);

function Choice({ label, value, steps, words, any, onChange }: { label: string; value: number | null; steps: number[]; words: (n: number) => string; any: string; onChange: (value: number | null) => void }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <select className={styles.select} value={value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
        <option value="">{any}</option>
        {steps.map((n) => (
          <option key={n} value={String(n)}>
            {words(n)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FilterBar({ filters: chosen, flags, onChange: navigate }: { filters: FeedFilters; flags: FlagFact[]; onChange: (next: FeedFilters) => void }) {
  // What the reader chose shows at once; the address, which the page reloads its rows from, follows,
  // and the bar follows the address when it changes some other way (back, a link that clears them).
  const address = pageHref(chosen);
  const [seen, setSeen] = useState(address);
  const [filters, setFilters] = useState(chosen);
  if (seen !== address) {
    setSeen(address);
    setFilters(chosen);
  }
  const onChange = (next: FeedFilters) => {
    setFilters(next);
    navigate(next);
  };
  // A flag hidden by a link but on no market now still shows, so it can be cleared.
  const listed = [...flags, ...filters.hide.filter((f) => !flags.some((x) => x.flag === f)).map((flag) => ({ flag, description: "No market has this flag now." }))];
  const toggle = (flag: string, on: boolean) => onChange({ ...filters, hide: on ? [...filters.hide, flag] : filters.hide.filter((f) => f !== flag) });
  return (
    <form className={styles.bar} aria-label="Filter the markets" onSubmit={(e) => e.preventDefault()}>
      <Choice label="Liquidity" value={filters.liquidity} steps={FEED_FILTERS.liquiditySol} words={sol} any="Any amount" onChange={(liquidity) => onChange({ ...filters, liquidity })} />
      <Choice label="Volume, 24 hours" value={filters.volume} steps={FEED_FILTERS.volume24hSol} words={sol} any="Any amount" onChange={(volume) => onChange({ ...filters, volume })} />
      <Choice label="Created" value={filters.created} steps={FEED_FILTERS.createdWithinHours} words={within} any="Any time" onChange={(created) => onChange({ ...filters, created })} />
      <details className={styles.field}>
        <summary className={styles.summary}>
          <span className={styles.label}>Hide markets with</span>
          <span className={styles.select}>{filters.hide.length === 0 ? "Nothing hidden" : filters.hide.length === 1 ? filters.hide[0] : `${filters.hide.length} flags`}</span>
        </summary>
        <fieldset className={styles.pop}>
          <legend className={styles.legend}>These are Pipeline&apos;s trust flags: facts about a market&apos;s program and mints, not verdicts. Every box starts empty.</legend>
          {listed.map(({ flag, description }) => (
            <label key={flag} className={styles.check}>
              <input type="checkbox" checked={filters.hide.includes(flag)} onChange={(e) => toggle(flag, e.target.checked)} />
              <span>
                <span className={flagStyles.flag}>{flag}</span> <span className={styles.description}>{description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </details>
    </form>
  );
}
