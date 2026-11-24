// The devnet markets the trade box's tests trade on, in the recorded fixtures too.

/** Pipeline's example constant-product market of SOL and a plain token (docs/DEVNET.md in Pipeline's repo). */
export const CP_MARKET = "3nWkYTqgJCcMV4S4DMrF77ZF27KA58nQSyZnNiPTZabe";
export const CP_TOKEN = "6DsWfiJk2zcHAgYjsMZYULGrVgzeedtnKbdy76vReMyp";
/** A curve market whose own rules refuse every trade: its strategy answers `WrongStatus`. */
export const REFUSING_MARKET = "Bna6AxcMszMtNkdzpXWLSYBHp1g7pZnREt2QJfdBkyDY";
export const WSOL = "So11111111111111111111111111111111111111112";
/**
 * A market of three mints (#122): a market of devnet's Counterflow strategy, which trades all six
 * directions exact-in. Its mints in order: QUOTE, Pipeline's example token, which the test trader
 * buys with SOL on the example market; X; and BEAR, which the pool mints and burns. By the quote mint
 * order its default pair is QUOTE for BEAR, since BEAR comes last.
 */
export const THREE_MINT_MARKET = "FNdAWctSKcRJ5n2AzxpgbqSKxrJbYHLHq7SiRxwGBpGo";
export const THREE_MINTS = { quote: CP_TOKEN, x: "5GcDp2oynopn5FbX51WXsroLM7Z61xqCpSGp6fST9Nm1", bear: "3YSYe6jQ7DKfZT2bNi8ZCwV5sBfn5WU2P3Rb46PPtQXR" } as const;
/** Each of the six directions with an amount the pool takes, in the order a wallet holding only QUOTE can trade them. */
export const THREE_MINT_PAIRS = [
  { from: "quote", to: "x", amount: "0.2" },
  { from: "quote", to: "bear", amount: "0.2" },
  { from: "x", to: "quote", amount: "0.5" },
  { from: "bear", to: "quote", amount: "0.05" },
  { from: "x", to: "bear", amount: "0.5" },
  { from: "bear", to: "x", amount: "0.05" },
] as const;
