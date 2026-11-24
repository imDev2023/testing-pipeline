// The buy wall AMM's devnet demo market (#56) as its panel and forms read it: the market as the API
// lists it, and the one-slot read of its state and its token's mint (fixtures/buy-wall-demo-market.json,
// copied from terminal-api's tests).
import { readFileSync } from "node:fs";
import type { Market, MarketRead } from "terminal-api/contract";

export const DEMO = JSON.parse(readFileSync(`${import.meta.dirname}/buy-wall-demo-market.json`, "utf8")) as {
  slot: number;
  market: string;
  market_state: { address: string; owner: string; data: string };
  token_mint: { address: string; owner: string; data: string };
};
export const BUY_WALL = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const WSOL = "So11111111111111111111111111111111111111112";

export const demoMarket: Market = {
  address: DEMO.market,
  strategy: BUY_WALL,
  market_state: DEMO.market_state.address,
  created_at: "2026-11-20T04:13:55.000Z",
  created_by: "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt",
  created_signature: null,
  fee_mint: WSOL,
  supports_exact_out: false,
  mints: [
    { mint: DEMO.token_mint.address, symbol: null, token: null, decimals: 6, vault: "8xZyjFv9maYh227Y4yyrSbMLiruna8sHKzmuoViv6dZc", liquidity: "864268710755", flags: [] },
    { mint: WSOL, symbol: "SOL", token: null, decimals: 9, vault: "AsXnGex7us8spZKJ75ygGAk5y9Ghg22dCmNAtr4fgRig", liquidity: "11270777495", flags: [] },
  ],
  quote_mint: WSOL,
  base_mint: DEMO.token_mint.address,
  stats_24h: { trades: 0, volume_quote: "0" },
  strategy_name: "Aviary Buy Wall AMM",
  strategy_metadata: "valid",
  flags: [],
  canary: null,
};

const account = (a: { address: string; owner: string; data: string }, role: "market_state" | "named") => ({
  address: a.address,
  role,
  exists: true,
  owner: a.owner,
  lamports: "1",
  executable: false,
  size: Buffer.from(a.data, "base64").length,
  data: a.data,
});
export const demoRead: MarketRead = { market: DEMO.market, slot: DEMO.slot, accounts: [account(DEMO.market_state, "market_state"), account(DEMO.token_mint, "named")] };

