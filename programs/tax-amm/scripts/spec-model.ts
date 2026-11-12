// The tax AMM's formulas as docs/spec/tax-amm.md states them ("Pricing and the tax",
// "Where the tax goes" and "Counters for the containment hook"), written out here
// independently of the program, so the demo checks a market against the spec and not
// against the program's own code.

/** Basis points in a whole. */
const BPS = 10_000n;

/** What the spec says a market holds, as plain numbers. */
export type SpecMarket = {
    /** The suite share, a policy value the program publishes in its IDL. */
    suiteShareBps: number;
    taxSide: number;
    buyTaxBps: number;
    sellTaxBps: number;
    shares: number[];
    burnShareBps: number;
    virtualSide: number;
    virtualReserve: bigint;
    reserves: bigint[];
    /** Recipients 0 to 3, the burn, the suite share. */
    owed: bigint[];
    taxCollected: bigint;
    volume: bigint[];
    swapCount: bigint;
};

/** What a trade does, by the spec. */
export type SpecTrade = { out: bigint; tax: bigint };

const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** The effective reserve of side `i`: its real reserve plus the virtual reserve on its side. */
function effective(market: SpecMarket, i: number): bigint {
    return market.reserves[i]! + (i === market.virtualSide ? market.virtualReserve : 0n);
}

/**
 * Prices a trade of credited input `a` from side `i` to side `o`. Returns the reason the spec
 * refuses it instead, as a string.
 */
export function price(market: SpecMarket, i: number, o: number, a: bigint): SpecTrade | string {
    const [eIn, eOut] = [effective(market, i), effective(market, o)];
    const curve = (input: bigint) => (eIn + input === 0n ? 0n : (eOut * input) / (eIn + input));
    let paidFromReserve: bigint;
    let out: bigint;
    let tax: bigint;
    if (market.taxSide === i) {
        // Buy tax: taken from the input before the curve.
        tax = ceilDiv(a * BigInt(market.buyTaxBps), BPS);
        out = curve(a - tax);
        paidFromReserve = out;
    } else {
        // Sell tax: taken from the curve's output, which stays in the tax-side vault.
        const g = curve(a);
        tax = ceilDiv(g * BigInt(market.sellTaxBps), BPS);
        out = g - tax;
        paidFromReserve = g;
    }
    if (paidFromReserve > market.reserves[o]!) return 'it would pay out more than the real reserve';
    if (out === 0n) return 'its output would be 0';
    return { out, tax };
}

/** The tax split by slot: recipients 0 to 3, the burn, the suite share. */
export function split(market: SpecMarket, tax: bigint): bigint[] {
    const suite = (tax * BigInt(market.suiteShareBps)) / BPS;
    const rest = tax - suite;
    const slots = market.shares.map((share) => (rest * BigInt(share)) / BPS);
    slots.push((rest * BigInt(market.burnShareBps)) / BPS, suite);
    const booked = slots.slice(0, 5).reduce((sum, part) => sum + part, 0n);
    slots[0]! += rest - booked;
    return slots;
}

/** Applies a router swap of credited input `a` from `i` to `o`, and returns what it did. */
export function swap(market: SpecMarket, i: number, o: number, a: bigint): SpecTrade {
    const trade = price(market, i, o, a);
    if (typeof trade === 'string') throw new Error(`the spec refuses this trade: ${trade}`);
    if (market.taxSide === i) {
        market.reserves[i]! += a - trade.tax;
        market.reserves[o]! -= trade.out;
    } else {
        market.reserves[i]! += a;
        market.reserves[o]! -= trade.out + trade.tax;
    }
    split(market, trade.tax).forEach((part, slot) => (market.owed[slot]! += part));
    market.taxCollected += trade.tax;
    market.volume[i]! += a;
    market.volume[o]! += trade.out;
    market.swapCount += 1n;
    return trade;
}
