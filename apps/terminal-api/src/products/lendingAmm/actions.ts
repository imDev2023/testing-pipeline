// The lending AMM's actions in Aviary (#88): its forms are the strategy's metadata forms, built and
// simulated as Aviary builds every custom action (`prepareActionResponse`), with klend's own
// `refresh_reserve` put first in the same transaction where the program asks for a reserve refreshed
// in that slot, as the keeper runner does (docs/spec/lending-pool.md, "The stored rate, everywhere"
// and "When it runs"):
//
// - `add_liquidity` into a market holding cTokens values them only at a rate refreshed in the same
//   slot (ADD_MAX_RESERVE_AGE_SLOTS, 0), so the deposit goes after a refresh;
// - `rebalance` decides on Kamino's state refreshed in its slot (finding S004), except while Kamino
//   redeems nothing, when klend refuses the refresh and the call only forgets a wait to leave
//   withdraw mode (finding R2F-02).
//
// klend refuses the refresh while the lending market's emergency mode is on, and a deprecated
// reserve is never brought up to date again, so neither gets one; the program's own refusal then
// says why, in the simulation.
import type { Address, GetAccountInfoApi, GetMultipleAccountsApi, Instruction, Rpc } from "@solana/kit";
import { lendingAmm, redeemsStopped, refreshReserveInstruction, type LendingMarket } from "keeper-jobs/lending-amm.ts";
import type { BeforeAction } from "../../trading/actionRoutes";

const COMMITMENT = "confirmed";

/** What the keeper reads of a lending AMM market and the accounts it watches, from the chain now; null for no lending AMM market state. */
export async function readKeeperView(rpc: Rpc<GetAccountInfoApi & GetMultipleAccountsApi>, marketState: Address): Promise<LendingMarket | null> {
  const { value } = await rpc.getAccountInfo(marketState, { encoding: "base64", commitment: COMMITMENT }).send();
  if (!value) return null;
  const data = new Uint8Array(Buffer.from(value.data[0], "base64"));
  if (!lendingAmm.isMarket(data)) return null;
  const named = lendingAmm.watches!(data);
  const accounts = await rpc.getMultipleAccounts([...named], { encoding: "base64", commitment: COMMITMENT }).send();
  return lendingAmm.decode(data, new Map(named.map((account, i) => [account, accounts.value[i] ? new Uint8Array(Buffer.from(accounts.value[i]!.data[0], "base64")) : null])));
}

/** The instructions that go before a lending AMM action: klend's `refresh_reserve` when the program needs it, else none. */
export const refreshFirst: BeforeAction = async ({ rpc, market, action }) => {
  if (action.name !== "add_liquidity" && action.name !== "rebalance") return [];
  const reading = await readKeeperView(rpc, market.view.marketState);
  const kamino = reading?.kamino;
  if (!reading || !kamino || reading.lendingMarket === null) return [];
  const refreshable = !kamino.lendingMarketEmergency && kamino.reserve.version === 1n;
  const wanted = action.name === "add_liquidity" ? reading.ctokens > 0n : !redeemsStopped(kamino);
  return refreshable && wanted ? [refreshReserveInstruction(reading.reserve, reading.lendingMarket, kamino.reserve) satisfies Instruction] : [];
};
