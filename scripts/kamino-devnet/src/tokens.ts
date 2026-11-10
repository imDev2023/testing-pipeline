// SPL Token helpers: associated token accounts and wrapping SOL into WSOL.
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getSyncNativeInstruction,
} from "@solana-program/token";

export async function associatedTokenAccount(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata;
}

export async function createAssociatedTokenAccount(
  payer: TransactionSigner,
  owner: Address,
  mint: Address,
): Promise<Instruction> {
  return getCreateAssociatedTokenIdempotentInstruction({
    payer,
    ata: await associatedTokenAccount(owner, mint),
    owner,
    mint,
  });
}

/** Moves `amount` lamports from `source` into a WSOL token account and syncs its token balance. */
export function wrapSol(source: TransactionSigner, wsolAccount: Address, amount: bigint): Instruction[] {
  return [
    getTransferSolInstruction({ source, destination: wsolAccount, amount }),
    getSyncNativeInstruction({ account: wsolAccount }),
  ];
}

/** Closes a WSOL token account, which returns its WSOL and rent to its owner as SOL. */
export function unwrapSol(owner: TransactionSigner, wsolAccount: Address): Instruction {
  return getCloseAccountInstruction({ account: wsolAccount, destination: owner.address, owner });
}
