// A home market's containment, read from the chain at one slot (docs/spec/containment-hook.md, "In
// Aviary"; #76): each Token-2022 mint of the market, its hook config and the market's state, with the
// Clock the deadline is measured against.
//
// A token is contained when its transfer hook program is ours, its hook authority is its unlock PDA
// and its config exists; anything less is shown as nothing, since a mint can name our hook without
// being bound. A token whose config records its unlock, with both hook fields cleared as `unlock`
// leaves them, is shown as unlocked, when and by which of the two.
import { TOKEN_2022_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { ExtensionType } from "@solana-program/token-2022";
import { address, getBase64Encoder, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { CONFIG_DISCRIMINATOR, CONTAINMENT_HOOK_PROGRAM_ADDRESS, findConfigPda, findUnlockPda, getConfigDecoder, type Config } from "containment-hook-scripts/client/index.ts";
import { getTaxMarketDecoder, getTaxMarketSize, SUITE_SHARE_BPS, TAX_AMM_PROGRAM_ADDRESS, TAX_MARKET_DISCRIMINATOR, type TaxMarket } from "tax-amm-scripts/client/index.ts";
import { CONTAINMENT } from "../../config";
import { extensionTypes, transferHookFields } from "../../trading/market";
import type { ContainedMint, MarketContainment, UnlockBy } from "./contract";

const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");
/** The tax AMM state version the hook reads; any other counts as a goal not reached, as the hook counts it (`HOOK-43`). */
const TAX_MARKET_VERSION = 1;

const base64 = getBase64Encoder();
export const bytesOf = (data: readonly [string, string]) => new Uint8Array(base64.encode(data[0]));
const startsWith = (bytes: Uint8Array, prefix: ArrayLike<number>) => bytes.length >= prefix.length && Array.from(prefix).every((b, i) => bytes[i] === b);

/** A tax market's state as the hook reads it, owner, size, discriminator and version checked; null for anything else. */
function taxMarketOf(account: { owner: string; data: Uint8Array } | null): TaxMarket | null {
  if (!account || account.owner !== TAX_AMM_PROGRAM_ADDRESS) return null;
  const { data } = account;
  if (data.length !== getTaxMarketSize() || !startsWith(data, TAX_MARKET_DISCRIMINATOR) || data[8] !== TAX_MARKET_VERSION) return null;
  return getTaxMarketDecoder().decode(data);
}

/** The hook's config from its account, owner and discriminator checked; null for anything else. */
export function configOf(account: { owner: string; data: Uint8Array } | null): Config | null {
  if (!account || account.owner !== CONTAINMENT_HOOK_PROGRAM_ADDRESS || !startsWith(account.data, CONFIG_DISCRIMINATOR)) return null;
  return getConfigDecoder().decode(account.data);
}

/**
 * Whether `mint` is contained or was until its unlock, from its account, its config and its unlock
 * PDA: contained while its transfer hook program is ours, its hook authority is its unlock PDA and its
 * config exists; unlocked once its config records the unlock and both hook fields are cleared; null
 * for anything else, a mint that names our hook without being bound included.
 */
export function containmentStatus(mint: Address, account: { owner: string; data: Uint8Array } | null, config: Config | null, unlockPda: Address): "contained" | "unlocked" | null {
  if (!account || account.owner !== TOKEN_2022_PROGRAM_ADDRESS || !config || config.mint !== mint) return null;
  const hook = transferHookFields(account.data);
  if (!hook) return null;
  if (config.unlockedAt.__option === "Some") return hook.program === null && hook.authority === null ? "unlocked" : null;
  return hook.program === CONTAINMENT_HOOK_PROGRAM_ADDRESS && hook.authority === unlockPda ? "contained" : null;
}

/** The Clock sysvar's Unix time. */
const clockTime = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(32, true);

/** Token-2022's group extensions: a mint with any of them needs Meteora's approval for a DAMM v2 pool even after its unlock (`HOOK-11`). */
const GROUP_EXTENSIONS = new Set<number>([ExtensionType.GroupPointer, ExtensionType.TokenGroup, ExtensionType.GroupMemberPointer, ExtensionType.TokenGroupMember]);

const BPS = 10_000n;
/** The part of the whole tax a share of the creator's part is, after the suite share (docs/spec/tax-amm.md, "Where the tax goes"). */
const ofTax = (share: number) => Number((BigInt(share) * (BPS - BigInt(SUITE_SHARE_BPS))) / BPS);
const DEFAULT_ADDRESS = "11111111111111111111111111111111";

/** Who receives the home market's tax, the launcher's part, the tax authority and a change of rates still waiting for its slot (`HOOK-49`). */
function taxOf(state: TaxMarket, launcher: Address, slot: bigint): ContainedMint["tax"] {
  const recipients = state.recipients.flatMap((wallet, i) => (wallet === DEFAULT_ADDRESS ? [] : [{ wallet, of_tax_bps: ofTax(state.shares[i]!), launcher: wallet === launcher }]));
  const waiting = state.pendingFromSlot !== 0n && slot < state.pendingFromSlot;
  return {
    recipients,
    burn_of_tax_bps: ofTax(state.burnShareBps),
    suite_of_tax_bps: SUITE_SHARE_BPS,
    launcher_of_tax_bps: recipients.filter((r) => r.launcher).reduce((sum, r) => sum + r.of_tax_bps, 0),
    authority: state.taxAuthorityRenounced ? { kind: "renounced" } : state.taxAuthority === DEFAULT_ADDRESS ? { kind: "none" } : { kind: "address", address: state.taxAuthority, launcher: state.taxAuthority === launcher },
    pending: waiting ? { buy_bps: state.pendingBuyTaxBps, sell_bps: state.pendingSellTaxBps, from_slot: Number(state.pendingFromSlot) } : null,
  };
}

/** The token's supply against the pool's real reserve of it, and the pool's real quote reserve (`HOOK-50`). */
function supplyOf(state: TaxMarket, mint: Address, mintData: Uint8Array): ContainedMint["supply"] {
  const side = state.mints.indexOf(mint);
  if (side < 0) return null;
  const total = new DataView(mintData.buffer, mintData.byteOffset, mintData.byteLength).getBigUint64(36, true);
  const inPool = state.reserves[side]!;
  return { total: String(total), in_pool: String(inPool), outside: String(total > inPool ? total - inPool : 0n), quote_in_pool: String(state.reserves[1 - side]!) };
}

/** Terms so small the containment means little (H049), by `CONTAINMENT.weakTerms`: the goal against the quote reserve, real and virtual, and the deadline against the binding. */
function weakTerms(config: Config, state: TaxMarket | null): ContainedMint["weak"] {
  const { goalOfQuoteReserveBps, deadlineMinSeconds } = CONTAINMENT.weakTerms;
  const quoteSide = state ? state.mints.indexOf(config.quoteMint) : -1;
  const quoteReserve = state && quoteSide >= 0 ? state.reserves[quoteSide]! + (state.virtualSide === quoteSide ? state.virtualReserve : 0n) : null;
  return {
    goal: quoteReserve !== null && config.unlockGoal * BPS < quoteReserve * BigInt(goalOfQuoteReserveBps),
    deadline: config.unlockDeadline - config.boundAt < BigInt(deadlineMinSeconds),
  };
}

/** Which of the two makes `unlock` pass now, as the hook's `unlock_due` decides: the goal when both hold; null when neither does. */
function dueBy({ now, deadline, goal, collected }: { now: bigint; deadline: bigint; goal: bigint; collected: bigint | null }): UnlockBy | null {
  if (collected !== null && collected >= goal) return "goal";
  return now >= deadline ? "deadline" : null;
}

/**
 * Which of the two unlocked a token, when the chain alone can tell: before its deadline only the goal
 * could, and past it with the goal still short now only the deadline could, since the tax collected
 * only grows. Null when the deadline had passed and the goal is reached now (or cannot be read), since
 * the goal may have been reached only after the unlock.
 */
function unlockedByFromChain({ unlockedAt, deadline, goal, collected }: { unlockedAt: bigint; deadline: bigint; goal: bigint; collected: bigint | null }): UnlockBy | null {
  if (unlockedAt < deadline) return "goal";
  return collected !== null && collected < goal ? "deadline" : null;
}

/** The line the hook logs on an unlock, naming which of the two made it due (programs/containment-hook/src/instructions/unlock.rs). */
const UNLOCKED_LINE = /^Program log: Unlocked by the (goal|deadline)\b/;

/** Which of the two a transaction's logs say unlocked the token, from a line the hook program itself logged; null when none does. */
export function unlockedByIn(logs: readonly string[]): UnlockBy | null {
  const running: string[] = [];
  for (const line of logs) {
    const invoked = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoked) running.push(invoked[1]!);
    else if (/^Program \S+ (success|failed)/.test(line)) running.pop();
    else if (running.at(-1) === CONTAINMENT_HOOK_PROGRAM_ADDRESS) {
      const by = UNLOCKED_LINE.exec(line);
      if (by) return by[1] as UnlockBy;
    }
  }
  return null;
}

/**
 * Which of the two the unlock's own log names, read from the unlock PDA's history: the PDA is named
 * by `bind` and `unlock` alone, so its history is short, and the unlock is its newest transaction
 * that succeeded. Null when no transaction in the history says.
 */
async function unlockedByLog(rpc: Rpc<SolanaRpcApi>, unlockPda: Address): Promise<UnlockBy | null> {
  const signatures = await rpc.getSignaturesForAddress(unlockPda, { limit: CONTAINMENT.unlockHistory, commitment: "confirmed" }).send();
  for (const { signature, err } of signatures) {
    if (err !== null) continue;
    const transaction = await rpc.getTransaction(signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }).send();
    const by = unlockedByIn(transaction?.meta?.logMessages ?? []);
    if (by) return by;
  }
  return null;
}

/** The market whose containment is read: its address, its state and its mints in order, as Aviary recorded them. */
export type HomeMarket = { address: string; strategy: string; marketState: string; mints: readonly string[]; createdBy: string };

/**
 * Reads the containment of `market`: every mint of it contained or once contained with this market as
 * its home. A market on any strategy but the tax AMM is no home market (`TAX_AMM_PROGRAM_ID` in the
 * hook's config module), so it is answered from the clock alone.
 */
export async function readContainment(rpc: Rpc<SolanaRpcApi>, market: HomeMarket): Promise<MarketContainment> {
  const home = market.strategy === TAX_AMM_PROGRAM_ADDRESS;
  const tokens = home ? market.mints.map((m) => address(m)) : [];
  const configs = await Promise.all(tokens.map(async (mint) => (await findConfigPda({ mint }))[0]));
  const unlocks = await Promise.all(tokens.map(async (mint) => (await findUnlockPda({ mint }))[0]));
  const wanted = [CLOCK_SYSVAR, ...(home ? [address(market.marketState)] : []), ...tokens, ...configs];
  const { context, value } = await rpc.getMultipleAccounts(wanted, { encoding: "base64", commitment: "confirmed" }).send();
  const accounts = value.map((a) => (a ? { owner: a.owner as string, data: bytesOf(a.data) } : null));
  const clock = accounts[0];
  if (!clock) throw new Error("the Clock sysvar was not served");
  const now = clockTime(clock.data);
  const slot = BigInt(context.slot);
  const state = taxMarketOf(accounts[1] ?? null);

  const contained: ContainedMint[] = [];
  const reasons: Promise<void>[] = [];
  tokens.forEach((mint, i) => {
    const mintAccount = accounts[2 + i] ?? null;
    const config = configOf(accounts[2 + tokens.length + i] ?? null);
    const status = containmentStatus(mint, mintAccount, config, unlocks[i]!);
    if (!status || !mintAccount || !config || config.market !== market.address) return;
    const isContained = status === "contained";
    const collected = state ? state.taxCollected : null;
    const unlockedAt = config.unlockedAt.__option === "Some" ? config.unlockedAt.value : null;
    const entry: ContainedMint = {
      mint,
      status: isContained ? "contained" : "unlocked",
      quote_mint: config.quoteMint,
      goal: String(config.unlockGoal),
      collected: collected === null ? null : String(collected),
      deadline: Number(config.unlockDeadline),
      bound_at: Number(config.boundAt),
      unlocked_at: unlockedAt === null ? null : Number(unlockedAt),
      unlocked_by: unlockedAt === null ? null : unlockedByFromChain({ unlockedAt, deadline: config.unlockDeadline, goal: config.unlockGoal, collected }),
      due: isContained ? dueBy({ now, deadline: config.unlockDeadline, goal: config.unlockGoal, collected }) : null,
      tax: state ? taxOf(state, address(market.createdBy), slot) : null,
      supply: state ? supplyOf(state, mint, mintAccount.data) : null,
      weak: weakTerms(config, state),
      group_extensions: extensionTypes(mintAccount.data).flatMap((type) => (GROUP_EXTENSIONS.has(type) ? [ExtensionType[type]!] : [])),
    };
    contained.push(entry);
    // Only the unlock's own log can tell when the deadline had passed and the goal is reached now.
    if (unlockedAt !== null && entry.unlocked_by === null) reasons.push(unlockedByLog(rpc, unlocks[i]!).then((by) => void (entry.unlocked_by = by)));
  });
  await Promise.all(reasons);

  return {
    market: market.address,
    slot: Number(context.slot),
    chain_time: Number(now),
    contained,
    weak_terms: { goal_of_quote_reserve_bps: CONTAINMENT.weakTerms.goalOfQuoteReserveBps, deadline_min_seconds: CONTAINMENT.weakTerms.deadlineMinSeconds },
  };
}
