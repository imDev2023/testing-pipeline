// Prices as the API writes them: an amount of the quote mint for one of the base mint, after both
// mints' decimals, worked out exactly from the integer amounts of the swap that set it and written
// to PRICE_SIGNIFICANT_DIGITS, rounded half up (docs/spec/pipescope-architecture.md, Candles).
import type { Ratio } from "terminal-indexer";
import { PRICE_SIGNIFICANT_DIGITS } from "./config";

const TEN = 10n;
const pow10 = (n: number) => TEN ** BigInt(n);
const digits = (n: bigint) => n.toString().length;

/** `numerator / denominator`, both positive, as a decimal string of `significant` digits, rounded half up, without trailing zeros. */
export function decimalOf(numerator: bigint, denominator: bigint, significant: number = PRICE_SIGNIFICANT_DIGITS): string {
  if (numerator <= 0n || denominator <= 0n) throw new RangeError("a price is a positive fraction");
  // The power of ten of the first significant digit.
  let exponent = digits(numerator) - digits(denominator);
  const below = exponent >= 0 ? numerator < denominator * pow10(exponent) : numerator * pow10(-exponent) < denominator;
  if (below) exponent--;
  // Scaled so the integer part holds exactly `significant` digits.
  const shift = significant - 1 - exponent;
  const top = shift >= 0 ? numerator * pow10(shift) : numerator;
  const bottom = shift >= 0 ? denominator : denominator * pow10(-shift);
  let scaled = top / bottom;
  if (2n * (top % bottom) >= bottom) scaled++;
  if (shift <= 0) return (scaled * pow10(-shift)).toString();
  const text = scaled.toString().padStart(shift + 1, "0");
  const whole = text.slice(0, text.length - shift);
  const fraction = text.slice(text.length - shift).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * A candle's price, kept as `a` of the pair's first mint by address for `b` of its second, written
 * for the pair a page asks for: the quote mint for one of the base mint, in tokens.
 */
export function priceOf(ratio: Ratio, quoteIsA: boolean, quoteDecimals: number, baseDecimals: number): string {
  const [quoteUnits, baseUnits] = quoteIsA ? [ratio.a, ratio.b] : [ratio.b, ratio.a];
  return decimalOf(quoteUnits * pow10(baseDecimals), baseUnits * pow10(quoteDecimals));
}
