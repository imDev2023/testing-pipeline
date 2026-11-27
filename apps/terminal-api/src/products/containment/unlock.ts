// The Unlock button's transaction (docs/spec/containment-hook.md, "Unlock"; #76): the hook's `unlock`,
// permissionless, sent and paid for by whichever wallet presses the button, built on the accounts the
// token's config records and simulated before any signature, as every transaction Aviary builds is.
import { TOKEN_2022_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { address, type Address, type Instruction, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { findConfigPda, findUnlockPda, getUnlockInstruction, type Config } from "containment-hook-scripts/client/index.ts";
import { HTTPException } from "hono/http-exception";
import { bytesOf, configOf, containmentStatus } from "./read";

/** The hook's `unlock` for `mint`, on the market state its config recorded at binding. */
export async function unlockInstruction(mint: Address, config: Config): Promise<Instruction> {
  const [[configAddress], [unlock]] = await Promise.all([findConfigPda({ mint }), findUnlockPda({ mint })]);
  return getUnlockInstruction({ mint, config: configAddress, unlock, marketState: config.marketState, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
/** "9 Jan 2027 at 13:06 UTC", from Unix seconds. */
const when = (seconds: bigint) => {
  const at = new Date(Number(seconds) * 1000);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} at ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
};

const unprocessable = (message: string) => new HTTPException(422, { message });

/**
 * A contained token's `unlock` and its home market, read from the chain now: refused for a mint that
 * is not contained, and for one already unlocked. Whether it is due is left to the simulation, whose
 * refusal names the hook's own reason.
 */
export async function unlockOf(rpc: Rpc<SolanaRpcApi>, mintAddress: string): Promise<{ instruction: Instruction; market: Address }> {
  const mint = address(mintAddress);
  const [[configAddress], [unlockPda]] = await Promise.all([findConfigPda({ mint }), findUnlockPda({ mint })]);
  const { value } = await rpc.getMultipleAccounts([mint, configAddress], { encoding: "base64", commitment: "confirmed" }).send();
  const [mintAccount, configAccount] = value.map((a) => (a ? { owner: a.owner as string, data: bytesOf(a.data) } : null));
  const config = configOf(configAccount ?? null);
  const status = containmentStatus(mint, mintAccount ?? null, config, unlockPda);
  if (status === "unlocked" && config?.unlockedAt.__option === "Some") throw unprocessable(`This token was already unlocked, on ${when(config.unlockedAt.value)}.`);
  if (status !== "contained" || !config) throw unprocessable("This mint is not a contained token, so there is nothing to unlock.");
  return { instruction: await unlockInstruction(mint, config), market: config.market };
}
