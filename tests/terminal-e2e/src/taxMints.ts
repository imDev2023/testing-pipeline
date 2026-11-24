// Fresh devnet tokens for the tax AMM's launch form (#75), made with the test trader's key: a plain SPL
// Token mint whose whole supply the trader holds and whose mint authority is then given up, as the
// seed asks of a token (docs/spec/tax-amm.md, "Mint rules"), and a Token-2022 mint carrying a
// permanent delegate, an extension the mint rules refuse, for the form to refuse before any signature.
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  AuthorityType,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { extension, getInitializeMintInstruction, getInitializePermanentDelegateInstruction, getMintSize as getMintSize2022, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";

/** Sends `instructions` signed by the payer and any other signers they name, and waits for them to confirm. */
export async function sendAndConfirm(rpcUrl: string, payer: KeyPairSigner, instructions: Instruction[]): Promise<string> {
  const rpc = createSolanaRpc(rpcUrl);
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  for (let attempt = 0; ; attempt++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`${signature} failed: ${JSON.stringify(value[0].err, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v))}`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return signature;
    if (attempt > 60) throw new Error(`${signature} did not confirm`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

/** A plain SPL Token mint with `decimals`, `supply` minted to the payer, and no mint or freeze authority left. */
export async function plainToken(rpcUrl: string, payer: KeyPairSigner, { decimals, supply }: { decimals: number; supply: bigint }): Promise<{ mint: Address; signature: string }> {
  const rpc = createSolanaRpc(rpcUrl);
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  const [account] = await findAssociatedTokenPda({ owner: payer.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const signature = await sendAndConfirm(rpcUrl, payer, [
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: payer.address, freezeAuthority: null }),
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: account, owner: payer.address, mint: mint.address }),
    getMintToInstruction({ mint: mint.address, token: account, mintAuthority: payer, amount: supply }),
    getSetAuthorityInstruction({ owned: mint.address, owner: payer, authorityType: AuthorityType.MintTokens, newAuthority: null }),
  ]);
  return { mint: mint.address, signature };
}

/** A Token-2022 mint carrying a permanent delegate, the payer, which the tax AMM's mint rules refuse. */
export async function permanentDelegateToken(rpcUrl: string, payer: KeyPairSigner): Promise<{ mint: Address; signature: string }> {
  const rpc = createSolanaRpc(rpcUrl);
  const mint = await generateKeyPairSigner();
  const delegate = extension("PermanentDelegate", { delegate: payer.address });
  const space = BigInt(getMintSize2022([delegate]));
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  const signature = await sendAndConfirm(rpcUrl, payer, [
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    getInitializePermanentDelegateInstruction({ mint: mint.address, delegate: payer.address }),
    getInitializeMintInstruction({ mint: mint.address, decimals: 6, mintAuthority: payer.address, freezeAuthority: null }),
  ]);
  return { mint: mint.address, signature };
}
