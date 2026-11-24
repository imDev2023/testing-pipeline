// Transfer-hook extra accounts (docs/spec/pipescope-architecture.md, Trading path; PIPESCOPE-33): the
// one place Aviary works out which accounts a Token-2022 mint's transfer hook needs, from the mint's
// own `ExtraAccountMetaList`, for every transaction it prepares, swaps and custom actions alike,
// because neither Pipeline's SDK nor its hosted API resolves them.
//
// Each transfer is resolved on its own, by Token-2022's own client (`resolveExtraAccountMetasForExecute`),
// since a hook's accounts can be derived from the transfer's source, destination, owner or amount; a
// transaction that moves the mint more than once (a swap's trader-to-vault transfer and its fees) gets
// the accounts of every transfer, each once. Token-2022 finds a hook's accounts among those passed by
// their addresses, so accounts one transfer needs and another does not do no harm.
//
// Where a swap's go (docs/spec/containment-hook.md, Hook accounts callers must pass): a sell's, for the
// trader's transfers in the input mint, in the router's `input_hook_accounts`; a buy's, for the vault
// paying the trader, after the strategy's own accounts, where the strategy finds them to pay out and
// where the router finds them for Pipeline's fee taken in the output.
import { getBase64Encoder, getAddressDecoder, mergeRoles, type AccountMeta, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { resolveExtraAccountMetasForExecute } from "@solana-program/token-2022";
import type { FeeSide } from "@pipeline-sol/sdk";
import type { TradeMint } from "./market";
import { Refused } from "./quote";

/** One transfer of a mint: from `source` to `destination`, signed for by `owner`, of `amount` base units. */
export type Transfer = { source: Address; destination: Address; owner: Address; amount: bigint };

/** The accounts after `existing`, each once, an address given twice keeping the higher of its roles. */
function merged(existing: readonly AccountMeta[], more: readonly AccountMeta[]): AccountMeta[] {
  const out = [...existing];
  for (const meta of more) {
    const at = out.findIndex((m) => m.address === meta.address);
    if (at < 0) out.push(meta);
    else out[at] = { address: meta.address, role: mergeRoles(out[at]!.role, meta.role) };
  }
  return out;
}

/**
 * The extra accounts `mint`'s transfer hook needs for each of `transfers`, followed by its hook
 * program and validation account, each once; none for a mint with no transfer hook program.
 */
export async function hookAccounts(rpc: Rpc<SolanaRpcApi>, mint: TradeMint, transfers: readonly Transfer[]): Promise<AccountMeta[]> {
  const hook = mint.transferHook;
  if (!hook) return [];
  let accounts: AccountMeta[] = [];
  for (const t of transfers) {
    let resolved: AccountMeta[];
    try {
      resolved = await resolveExtraAccountMetasForExecute({ rpc, transferHookProgramAddress: hook, source: t.source, mint: mint.address, destination: t.destination, owner: t.owner, amount: t.amount });
    } catch (e) {
      // A list naming an account that does not exist yet, or data the hook's seeds cannot read: told as the hook's, never a bare failure.
      const raw = (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, "the RPC");
      throw new Refused({ class: "hook_refused", sentence: `The token's transfer hook needs accounts Aviary could not work out, so there is no swap to build: ${raw.replace(/\.$/, "")}.`, name: null, number: null, message: null, program: hook, raw });
    }
    accounts = merged(accounts, resolved);
  }
  return accounts;
}

/** A token account's owner sits after its mint: bytes 32 to 64. */
const OWNER_OFFSET = 32;

/** Who signs for a token account's transfers: its owner, read from the account. */
async function ownerOf(rpc: Rpc<SolanaRpcApi>, tokenAccount: Address): Promise<Address> {
  const { value } = await rpc.getAccountInfo(tokenAccount, { encoding: "base64", commitment: "confirmed" }).send();
  if (!value) {
    const sentence = `The market's vault ${tokenAccount} could not be read, so the accounts its token's transfer hook needs cannot be worked out.`;
    throw new Refused({ class: "unavailable", sentence, name: null, number: null, message: null, program: null, raw: sentence });
  }
  const bytes = new Uint8Array(getBase64Encoder().encode(value.data[0]));
  return getAddressDecoder().decode(bytes.subarray(OWNER_OFFSET, OWNER_OFFSET + 32));
}

export type SwapTransfers = {
  trader: Address;
  inputMint: TradeMint;
  outputMint: TradeMint;
  traderInput: Address;
  traderOutput: Address;
  inputVault: Address;
  outputVault: Address;
  /** The market's fee account for the mint Pipeline's fee is taken in. */
  feeAccount: Address;
  feeSide: FeeSide;
  /** The integrator's account for the input mint, when an integrator fee is charged. */
  integratorAccount: Address | null;
  /** What goes into the market, what the strategy is quoted to send, and the two fees, each in the mint it is taken in. */
  amountIn: bigint;
  amountOut: bigint;
  pipelineFee: bigint;
  integratorFee: bigint;
};

/**
 * A swap's hook accounts: `input`, for the router's `input_hook_accounts` (the trader's transfer into
 * the vault, and Pipeline's and the integrator's fees when taken in the input), and `output`, to
 * follow the strategy's own accounts (the vault paying the trader, and Pipeline's fee when taken in
 * the output). Both are empty for mints with no transfer hook.
 */
export async function swapHookAccounts(rpc: Rpc<SolanaRpcApi>, s: SwapTransfers): Promise<{ input: AccountMeta[]; output: AccountMeta[] }> {
  const input: Transfer[] = [{ source: s.traderInput, destination: s.inputVault, owner: s.trader, amount: s.amountIn }];
  if (s.feeSide === "input") input.push({ source: s.traderInput, destination: s.feeAccount, owner: s.trader, amount: s.pipelineFee });
  if (s.integratorAccount) input.push({ source: s.traderInput, destination: s.integratorAccount, owner: s.trader, amount: s.integratorFee });
  const output: Transfer[] = [];
  if (s.outputMint.transferHook) {
    output.push({ source: s.outputVault, destination: s.traderOutput, owner: await ownerOf(rpc, s.outputVault), amount: s.amountOut });
    if (s.feeSide === "output") output.push({ source: s.traderOutput, destination: s.feeAccount, owner: s.trader, amount: s.pipelineFee });
  }
  return { input: await hookAccounts(rpc, s.inputMint, input), output: await hookAccounts(rpc, s.outputMint, output) };
}
