// The tax AMM's launch form, apart from its drawing (docs/spec/tax-amm.md, "In Aviary" and "Creating a
// market"; #75): what the creator types becomes the market's creation parameters, its seed and the hash
// of its terms, and the request that creates the market, its fee accounts and its seed in one
// transaction (PIPESCOPE-166). The token is mint 0 and SOL or USDC mint 1, and the tax side defaults to
// the quote mint, so recipients are paid in SOL or USDC rather than in the token they would sell.
//
// The form checks only what it needs to show the split and build the request: each field filled and
// readable, each rate inside its range under the program's cap (`MAX_TAX_BPS`, from its IDL), the
// shares adding up to the whole. Every other creation and mint rule is the program's, which the
// simulation before the signature runs, so a refusal names the program's own rule.
import { isAddress, type Address } from "@solana/kit";
import { BURN_SLOT, findVault0Pda, findVault1Pda, MAX_TAX_BPS, type InitParams } from "tax-amm-scripts/client/index.ts";
import { termsArg, webTermsHash } from "tax-amm-scripts/terms-web.ts";
import type { MarketOpening } from "terminal-api/contract";
import { parseAmount } from "@/trade";
import { DEFAULT_ADDRESS, splitOf, type SplitPart } from "./split";

export type LaunchValues = {
  /** The token's mint, by address. */
  token: string;
  quote: "sol" | "usdc";
  taxedIn: "quote" | "token";
  /** Rates and their ranges, in percent to two places. */
  buyTax: string;
  sellTax: string;
  buyMin: string;
  buyMax: string;
  sellMin: string;
  sellMax: string;
  authority: "wallet" | "none";
  /** Each recipient's wallet and share of the creator's part, in percent. */
  recipients: readonly { wallet: string; share: string }[];
  burnShare: string;
  /** The quote side's virtual reserve, in the quote mint's tokens; empty for none. */
  virtualReserve: string;
  seedToken: string;
  seedQuote: string;
};

type MintRead = { mint: Address; decimals: number };

export type LaunchContext = {
  /** The connected wallet, which creates and seeds the market. */
  wallet: Address | null;
  /** The token's mint once read, else null, with why when its read is over: it failed, or the address is no mint. */
  token: MintRead | null;
  tokenProblem?: string | null;
  /** SOL and USDC, which Aviary names itself. */
  quotes: { sol: MintRead; usdc: MintRead };
};

/** A launch whose every field is usable: the mints in the market's order, the creation parameters, the seed and the split. */
export type ValidLaunch = { mints: [Address, Address]; params: InitParams; seed: [bigint, bigint]; split: SplitPart[] };

const QUOTE_NAMES = { sol: "SOL", usdc: "USDC" } as const;
/** Tax recipients a market can name: their slots come before the burn's, as the IDL numbers them. */
export const MAX_RECIPIENTS = BURN_SLOT;
const percent = (bps: number) => `${bps / 100}%`;

/** A percentage typed to two places, as basis points; null when it is no such percentage. */
export function percentBps(text: string): number | null {
  const typed = text.trim();
  if (/^0*(\.0*)?$/.test(typed) && typed !== "" && typed !== ".") return 0;
  const read = parseAmount(typed, 2);
  return read.kind === "amount" && read.value <= 1_000_000n ? Number(read.value) : null;
}

/** An amount typed in a mint's tokens, as base units: null for empty or zero, or the reason it cannot be read. */
function amountOf(text: string, decimals: number, whose: string): { value: bigint } | { reason: string } | null {
  if (/^\s*0*(\.0*)?\s*$/.test(text)) return null;
  const read = parseAmount(text, decimals);
  if (read.kind === "invalid") return { reason: read.reason.startsWith("This token has") ? `${whose} has ${decimals} decimal places.` : `${whose}: ${read.reason}` };
  return read.kind === "amount" ? { value: read.value } : null;
}

/** The launch as creation parameters, a seed and a split, or the first thing missing or wrong. */
export function readLaunch(values: LaunchValues, context: LaunchContext): { launch: ValidLaunch; missing: null } | { launch: null; missing: string } {
  const no = (missing: string) => ({ launch: null, missing }) as const;
  const quote = context.quotes[values.quote];
  const quoteName = QUOTE_NAMES[values.quote];
  const token = values.token.trim();
  if (!isAddress(token)) return no("Enter the token's mint address.");
  if (token === quote.mint) return no(`The token must be another mint than the ${quoteName} it is paired with.`);
  if (!context.wallet) return no("Connect your wallet: it creates and seeds the market.");
  if (context.tokenProblem) return no(context.tokenProblem);
  if (!context.token || context.token.mint !== token) return no("Waiting for the token's mint to be read.");

  const rates: Record<"buy" | "sell", { rate: number; min: number; max: number }> = { buy: { rate: 0, min: 0, max: 0 }, sell: { rate: 0, min: 0, max: 0 } };
  for (const side of ["buy", "sell"] as const) {
    const [rate, min, max] = [values[`${side}Tax`], values[`${side}Min`], values[`${side}Max`]].map(percentBps);
    if (rate === null || rate === undefined) return no(`Enter the ${side} tax as a percentage, such as 3 or 2.5.`);
    if (min === null || min === undefined || max === null || max === undefined) return no(`Enter the ${side} tax's lowest and highest rates as percentages.`);
    if (max > MAX_TAX_BPS) return no(`The ${side} tax's highest rate can be at most ${percent(MAX_TAX_BPS)}, the program's cap.`);
    if (min > max) return no(`The ${side} tax's lowest rate is above its highest.`);
    if (rate < min || rate > max) return no(`The ${side} tax, ${percent(rate)}, is outside its range of ${percent(min)} to ${percent(max)}.`);
    rates[side] = { rate, min, max };
  }

  if (!values.recipients.length) return no("Name at least one tax recipient.");
  if (values.recipients.length > MAX_RECIPIENTS) return no(`A market has at most ${MAX_RECIPIENTS} tax recipients.`);
  const recipients: Address[] = [];
  const shares: number[] = [];
  for (const [i, r] of values.recipients.entries()) {
    const wallet = r.wallet.trim();
    if (!isAddress(wallet)) return no(`Tax recipient ${i + 1} is not an address.`);
    const share = percentBps(r.share);
    if (share === null || share === 0) return no(`Enter tax recipient ${i + 1}'s share as a percentage above 0.`);
    recipients.push(wallet);
    shares.push(share);
  }
  const burn = percentBps(values.burnShare);
  if (burn === null) return no("Enter the burn's share as a percentage, or 0.");
  const total = shares.reduce((a, b) => a + b, 0) + burn;
  if (total !== 10_000) return no(`The recipients' shares and the burn's add up to ${percent(total)}; they must add up to 100%.`);
  const taxSide = values.taxedIn === "quote" ? 1 : 0;
  if (burn > 0 && taxSide === 1 && values.quote === "sol") return no("SOL can't be burned, so a market taxed in SOL has no burn share.");

  const virtual = amountOf(values.virtualReserve, quote.decimals, `The virtual reserve of ${quoteName}`);
  if (virtual && "reason" in virtual) return no(virtual.reason);
  const seedToken = amountOf(values.seedToken, context.token.decimals, "The token");
  if (seedToken && "reason" in seedToken) return no(seedToken.reason);
  if (!seedToken) return no("Enter how much of the token to seed the market with.");
  const seedQuote = amountOf(values.seedQuote, quote.decimals, quoteName);
  if (seedQuote && "reason" in seedQuote) return no(seedQuote.reason);
  if (!seedQuote && !virtual) return no(`Enter how much ${quoteName} to seed the market with, or price it with a virtual reserve.`);

  const unused = MAX_RECIPIENTS - recipients.length;
  const params: InitParams = {
    taxSide,
    buyTaxBps: rates.buy.rate,
    sellTaxBps: rates.sell.rate,
    buyTaxMinBps: rates.buy.min,
    buyTaxMaxBps: rates.buy.max,
    sellTaxMinBps: rates.sell.min,
    sellTaxMaxBps: rates.sell.max,
    taxAuthority: values.authority === "wallet" ? context.wallet : DEFAULT_ADDRESS,
    seeder: context.wallet,
    recipients: [...recipients, ...Array<Address>(unused).fill(DEFAULT_ADDRESS)],
    shares: [...shares, ...Array<number>(unused).fill(0)],
    burnShareBps: burn,
    virtualSide: 1,
    virtualReserve: virtual?.value ?? 0n,
  };
  return { launch: { mints: [token, quote.mint], params, seed: [seedToken.value, seedQuote?.value ?? 0n], split: splitOf(params.recipients, params.shares, burn) }, missing: null };
}

/** The create form's arguments by their metadata names, as the API takes them. */
function initArgs(params: InitParams): Record<string, string> {
  return {
    tax_side: String(params.taxSide),
    buy_tax_bps: String(params.buyTaxBps),
    sell_tax_bps: String(params.sellTaxBps),
    buy_tax_min_bps: String(params.buyTaxMinBps),
    buy_tax_max_bps: String(params.buyTaxMaxBps),
    sell_tax_min_bps: String(params.sellTaxMinBps),
    sell_tax_max_bps: String(params.sellTaxMaxBps),
    tax_authority: params.taxAuthority,
    seeder: params.seeder,
    ...Object.fromEntries(Array.from(params.recipients).map((r, i) => [`recipient_${i}`, r])),
    ...Object.fromEntries(Array.from(params.shares).map((s, i) => [`share_${i}`, String(s)])),
    burn_share_bps: String(params.burnShareBps),
    virtual_side: String(params.virtualSide),
    virtual_reserve: String(params.virtualReserve),
  };
}

/**
 * What the page asks the API to prepare for a launch with the new market state's keypair: the create
 * form's values, and the market opened in the same transaction with its seed, against the vaults the
 * new market state's address gives, and the hash of the terms it is created with (TAX-59).
 */
export async function launchRequest(launch: ValidLaunch, marketState: Address): Promise<{ args: Record<string, string>; inputs: Record<string, string>; then: MarketOpening }> {
  const [mint0, mint1] = launch.mints;
  const [[vault0], [vault1], hash] = await Promise.all([findVault0Pda({ marketState, mint0 }), findVault1Pda({ marketState, mint1 }), webTermsHash(launch.mints, launch.params)]);
  return {
    args: initArgs(launch.params),
    inputs: { mint_0: mint0, mint_1: mint1 },
    then: {
      mints: [mint0, mint1],
      vaults: [vault0, vault1],
      actions: [{ action: "seed", args: { amount_0: String(launch.seed[0]), amount_1: String(launch.seed[1]), expected_terms: termsArg(hash) }, inputs: {} }],
    },
  };
}
