// A custom action and a new market, prepared and simulated as swaps are (docs/spec/pipescope-architecture.md,
// Trading path and Simulation before every signature; PIPESCOPE-09): the strategy's instruction built
// from its validated metadata, an action with the `strategy-actions` package (BAR-41) and a new market
// with Pipeline's SDK's `buildCreateMarketFromMetadata`, then simulated exactly as it would be signed,
// with the wallet as fee payer, and returned with what signing would change in the wallet.
//
// A custom action is signed directly on the strategy, outside the router's swap protections. When it
// takes wrapped SOL from the wallet's own wrapped-SOL account, or pays into it, SOL is wrapped before it
// and the account closed back into the wallet after it, in the same transaction, so SOL in and out is
// plain SOL as in a swap (PIPESCOPE-145). Nothing is prepared that needs a signature the wallet cannot
// give: a new market's fresh state keypair is made and kept in the page, which signs with it
// (PIPESCOPE-144). Aviary holds no keys.
import { buildCreateMarketFromMetadata, NATIVE_MINT_ADDRESS, resolveAccountSource, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, type ArgValue, type MarketView, type MetadataInit, type SourceContext } from "@pipeline-sol/sdk";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getSyncNativeInstruction } from "@solana-program/token";
import { AccountRole, createNoopSigner, getAddressDecoder, getBase64Encoder, type Address, type GetAccountInfoApi, type Instruction, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { buildActionInstruction, type AviaryAction } from "strategy-actions";
import type { BalanceChange, TransactionSimulation } from "../contract";
import { decodeFailure } from "./failure";
import { fitTransaction, marketLookupTable, runSimulation, TooLarge, type LookupTable } from "./prepare";
import { COMMITMENT, Refused } from "./quote";

export type FormValues = { args: Record<string, ArgValue>; inputs: Record<string, Address> };

const refusal = (failureClass: "needs_signer" | "bad_input" | "too_large", sentence: string, raw = sentence) => new Refused({ class: failureClass, sentence, name: null, number: null, message: null, program: null, raw });

/** Pipeline's SDK's refusal of a form's values (`MetadataInstructionError`), matched by name since two copies of the SDK can be installed. */
const formError = (e: unknown): e is Error => e instanceof Error && e.name === "MetadataInstructionError";

/** Builds with `build`, answering a value the metadata's types refuse (an argument out of range, an input missing) as a refusal naming it. */
async function built<T>(build: () => Promise<T>): Promise<T> {
  try {
    return await build();
  } catch (e) {
    if (formError(e)) throw refusal("bad_input", `The form could not be built: ${e.message}.`, e.message);
    throw e;
  }
}

/** Refuses an instruction that needs a signature from anyone but those who sign in the page: the wallet, and a new market's state. */
function signedOnlyBy(instructions: readonly Instruction[], signers: readonly Address[], what: string) {
  for (const meta of instructions.flatMap((i) => i.accounts ?? [])) {
    const signs = meta.role === AccountRole.READONLY_SIGNER || meta.role === AccountRole.WRITABLE_SIGNER;
    if (signs && !signers.includes(meta.address)) throw refusal("needs_signer", `${what} needs a signature from ${meta.address}, which is not your wallet, so Aviary cannot prepare it for your wallet to sign.`);
  }
}

/** What an amount argument written in wrapped SOL adds up to: the SOL wrapped before the instruction that takes it. */
async function wrappedSolOf(args: AviaryAction["args"], values: FormValues["args"], context: SourceContext): Promise<bigint> {
  let total = 0n;
  for (const arg of args ?? []) {
    if (arg.type !== "u64" || !arg.decimals_of) continue;
    if ((await resolveAccountSource(arg.decimals_of, context)) !== NATIVE_MINT_ADDRESS) continue;
    total += BigInt(String(values[arg.name]));
  }
  return total;
}

/**
 * The strategy's instruction with the wallet's wrapped SOL handled around it: when it writes to the
 * wallet's own wrapped-SOL account, that account is created if missing and `wrap` lamports moved in
 * before it, and closed back into the wallet after it.
 */
async function aroundWrappedSol(main: Instruction, trader: Address, wrap: bigint): Promise<{ instructions: Instruction[]; wrapped: bigint }> {
  const [account] = await findAssociatedTokenPda({ owner: trader, mint: NATIVE_MINT_ADDRESS, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const writes = (main.accounts ?? []).some((a) => a.address === account && (a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER));
  if (!writes) return { instructions: [main], wrapped: 0n };
  const signer = createNoopSigner(trader);
  const before: Instruction[] = [getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: account, owner: trader, mint: NATIVE_MINT_ADDRESS, tokenProgram: TOKEN_PROGRAM_ADDRESS })];
  if (wrap > 0n) before.push(getTransferSolInstruction({ source: signer, destination: account, amount: wrap }), getSyncNativeInstruction({ account }));
  return { instructions: [...before, main, getCloseAccountInstruction({ account, destination: trader, owner: signer })], wrapped: wrap };
}

export type ActionInput = FormValues & {
  action: AviaryAction;
  market: MarketView;
  trader: Address;
  /** Token programs known for mints the market does not hold (`input:` mints), else read through `rpc`. */
  tokenPrograms?: Record<string, Address>;
  rpc?: Rpc<GetAccountInfoApi>;
};

/** A custom action as the instructions of its transaction, the action itself among them, and the SOL wrapped for it. */
export async function actionTransaction(input: ActionInput): Promise<{ instructions: Instruction[]; action: Instruction; wrapped: bigint }> {
  const { action, market, trader, args, inputs, tokenPrograms, rpc } = input;
  const main = await built(() => buildActionInstruction({ action, market, wallet: trader, args, inputs, tokenPrograms, rpc }));
  signedOnlyBy([main], [trader], "This action");
  const context: SourceContext = { strategyProgram: market.strategyProgram, wallet: trader, market, marketState: market.marketState, inputs, tokenPrograms, rpc };
  const wrap = await built(() => wrappedSolOf(action.args, args, context));
  return { ...(await aroundWrappedSol(main, trader, wrap)), action: main };
}

export type CreateInput = FormValues & {
  init: MetadataInit;
  strategy: Address;
  trader: Address;
  /** The new market state's address, made in the page, when the create form makes one. */
  marketState?: Address;
  maxCreatorLamports: bigint;
  tokenPrograms?: Record<string, Address>;
  rpc?: Rpc<GetAccountInfoApi>;
};

/** A new market as the instructions of its transaction: the router's `create_market` from the create form, with wrapped SOL handled as for an action. */
export async function createMarketTransaction(input: CreateInput) {
  const { init, strategy, trader, args, inputs, marketState, tokenPrograms, rpc } = input;
  const { instruction, resolved } = await built(() =>
    buildCreateMarketFromMetadata({ init, strategyProgram: strategy, creator: trader, marketState, args, inputs, tokenPrograms, rpc, maxCreatorLamports: input.maxCreatorLamports }),
  );
  signedOnlyBy([instruction], resolved.marketStateSigns ? [trader, resolved.marketState] : [trader], "Creating this market");
  const wrap = await built(() => wrappedSolOf(init.args, args, { strategyProgram: strategy, wallet: trader, marketState: resolved.marketState, inputs, tokenPrograms, rpc }));
  return { ...(await aroundWrappedSol(instruction, trader, wrap)), market: resolved.market, marketState: resolved.marketState, marketStateSigns: resolved.marketStateSigns };
}

type Held = { lamports: bigint; owner: string; data: readonly [string, string] } | null;

const base64 = getBase64Encoder();
const addressDecoder = getAddressDecoder();
/** A token account's mint, owner and amount, or null for an account that is no token account. */
function tokenAccount(held: Held): { mint: string; owner: string; amount: bigint } | null {
  if (!held || (held.owner !== TOKEN_PROGRAM_ADDRESS && held.owner !== TOKEN_2022_PROGRAM_ADDRESS)) return null;
  const bytes = new Uint8Array(base64.encode(held.data[0]));
  // A token account is 165 bytes and more; a mint is 82 (and Token-2022 marks its accounts at byte 165).
  if (bytes.length < 165 || (bytes.length > 165 && bytes[165] !== 2)) return null;
  return { mint: addressDecoder.decode(bytes.subarray(0, 32)), owner: addressDecoder.decode(bytes.subarray(32, 64)), amount: new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(64, true) };
}

/**
 * What signing would change in the wallet, from the accounts read before and simulated after: its
 * SOL, then each watched token account it owns before or after, in the order watched, and the token
 * accounts it gains, with the rent each holds. Accounts of anyone else are not the wallet's change.
 */
export function measureWallet(input: { trader: Address; watched: readonly Address[]; before: readonly Held[]; after: readonly Held[] }): Pick<TransactionSimulation, "changes" | "new_accounts"> {
  const changes: BalanceChange[] = [];
  const created: TransactionSimulation["new_accounts"] = [];
  input.watched.forEach((account, i) => {
    const [was, now] = [input.before[i] ?? null, input.after[i] ?? null];
    if (account === input.trader) {
      changes.unshift({ mint: null, account, before: String(was?.lamports ?? 0n), after: String(now?.lamports ?? 0n) });
      return;
    }
    const [wasToken, nowToken] = [tokenAccount(was), tokenAccount(now)];
    const mine = (t: ReturnType<typeof tokenAccount>) => t !== null && t.owner === input.trader;
    if (!mine(wasToken) && !mine(nowToken)) return;
    const mint = (wasToken ?? nowToken)!.mint;
    changes.push({ mint, account, before: String(wasToken?.amount ?? 0n), after: String(nowToken?.amount ?? 0n) });
    if (!was && now) created.push({ account, mint, rent: String(now.lamports) });
  });
  return { changes, new_accounts: created };
}

/**
 * A prepared transaction: the instructions fitted into one transaction paid by the wallet (a legacy
 * one when it fits, else shortened by the market's lookup table), simulated with the wallet and every
 * account it writes watched, and returned only when the simulation passed.
 */
export async function prepareTransaction(
  rpc: Rpc<SolanaRpcApi>,
  input: { instructions: Instruction[]; trader: Address; strategy: string; market: Address | null; what: string },
): Promise<{ transaction: string | null; simulation: TransactionSimulation }> {
  const { instructions, trader } = input;
  const writable = instructions.flatMap((i) => (i.accounts ?? []).filter((a) => a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER).map((a) => a.address));
  const watched = [...new Set([trader, ...writable])];
  const [before, { value: lifetime }, table] = await Promise.all([
    rpc.getMultipleAccounts(watched, { encoding: "base64", commitment: COMMITMENT }).send(),
    rpc.getLatestBlockhash({ commitment: COMMITMENT }).send(),
    input.market ? marketLookupTable(rpc, input.market) : Promise.resolve<LookupTable | null>(null),
  ]);
  let fitted;
  try {
    fitted = fitTransaction(instructions, trader, lifetime, table);
  } catch (e) {
    if (e instanceof TooLarge) throw refusal("too_large", e.message.replace(/^This swap/, input.what));
    throw e;
  }
  const { value, networkFee } = await runSimulation(rpc, fitted.wire, fitted.messageBytes, watched, input.what);
  const logs = [...(value.logs ?? [])];
  const units = value.unitsConsumed === undefined ? null : Number(value.unitsConsumed);
  const common = { logs, compute_units: units, network_fee: String(networkFee) };
  if (value.err !== null) return { transaction: null, simulation: { ok: false, failure: decodeFailure(value.err, logs, { strategy: input.strategy }), changes: [], new_accounts: [], ...common } };
  const held = (a: { lamports: bigint; owner: string; data: unknown } | null): Held => (a && a.lamports > 0n ? { lamports: a.lamports, owner: a.owner, data: a.data as readonly [string, string] } : null);
  const measured = measureWallet({ trader, watched, before: before.value.map(held), after: (value.accounts ?? []).map(held) });
  return { transaction: fitted.wire, simulation: { ok: true, failure: null, ...measured, ...common } };
}
