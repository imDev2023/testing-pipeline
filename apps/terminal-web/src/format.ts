// The one module of formatters every page writes numbers, addresses and dates with
// (docs/spec/pipescope-screens.md, "On every page"), so one page never mixes two notations.

/** An address as people read it: its first four and last four characters, "6efY...dnYp". */
export function shortAddress(address: string): string {
  return address.length <= 11 ? address : `${address.slice(0, 4)}...${address.slice(-4)}`;
}

const SIGNIFICANT = 4;
const plain = new Intl.NumberFormat("en-US", { maximumSignificantDigits: SIGNIFICANT });

/** A number rounded to four significant figures, so the unit it is written in is chosen after rounding. */
const rounded = (value: number) => (value === 0 ? 0 : Number(value.toPrecision(SIGNIFICANT)));

/** An amount in tokens, never dollars: four significant figures, with "M" for millions and "B" for billions. */
export function formatAmount(value: number): string {
  const r = rounded(value);
  const size = Math.abs(r);
  if (size >= 1e9) return `${plain.format(r / 1e9)}B`;
  if (size >= 1e6) return `${plain.format(r / 1e6)}M`;
  return plain.format(r);
}

/** An amount held in a token's base units, as its mint's decimals read it. */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  return formatAmount(Number(raw) / 10 ** decimals);
}

/** A digit as a subscript, U+2080 to U+2089. */
const subscript = (n: number) => String(n).replace(/\d/g, (d) => String.fromCodePoint(0x2080 + Number(d)));

/**
 * A price: below 0.0001 its leading zeros are counted in a subscript, "0.0₇2307" for
 * 0.00000002307, on the chart's axis and everywhere else; from 0.0001 up, it is written like an
 * amount. Both keep four significant figures.
 */
export function formatPrice(value: number): string {
  const r = rounded(value);
  if (r <= 0 || r >= 1e-4) return formatAmount(r);
  const [mantissa = "0", exponent = "0"] = r.toExponential(SIGNIFICANT - 1).split("e");
  const digits = mantissa.replace(".", "").replace(/0+$/, "");
  return `0.0${subscript(-Number(exponent) - 1)}${digits}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** A date in UTC, "10 Nov 2026, 04:54 UTC". */
export function formatDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}

/** How long ago, as lists show it beside the date on hover: "12s ago", "4m ago", "3h ago", "2d ago". */
export function formatAge(date: Date, now: Date = new Date()): string {
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** A day written as an ISO date ("2026-11-22"), as the screens write it: "22 Nov 2026". */
export function formatDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** A count such as a slot, whole and grouped by thousands: "520,629,097". */
export function formatInteger(value: number | bigint): string {
  return integer.format(value);
}

/** A day in UTC, as the screens write it: "23 Nov 2026". */
export function formatDayOf(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** A share in millionths, as Canary's returns are recorded, to one decimal place: "98.5%". */
export function formatPercentPpm(ppm: number): string {
  return `${(Math.round(ppm / 1_000) / 10).toFixed(1)}%`;
}
