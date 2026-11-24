// Wraps a little of a devnet test key's SOL into its wrapped-SOL account (#122), so the wallet page
// has wrapped SOL to offer to unwrap: run for the Playwright test trader before recording the fixtures
// (docs/toolchain.md, "Aviary's end-to-end tests"), since a sale into SOL through the trade box closes
// that account and leaves none.
//
//   node tests/terminal-e2e/demo/wrap-sol.ts [--key e2e-trader] [--lamports 10000000]
//
// The key is ~/.config/testing-pipeline/devnet/<key>.json; RPC_URL is devnet's, from the project's .env.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getSyncNativeInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

const { values } = parseArgs({ options: { key: { type: "string", default: "e2e-trader" }, lamports: { type: "string", default: "10000000" } } });
if (!/^[a-z0-9-]+$/.test(values.key)) throw new Error("--key names a key file in ~/.config/testing-pipeline/devnet/, such as e2e-trader");
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("RPC_URL is not set: run with the project's .env loaded.");
const rpc = createSolanaRpc(RPC_URL);
const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`${homedir()}/.config/testing-pipeline/devnet/${values.key}.json`, "utf8")) as number[]));
const WSOL = address("So11111111111111111111111111111111111111112");
const [account] = await findAssociatedTokenPda({ owner: signer.address, mint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS });
const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
const signed = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: account, owner: signer.address, mint: WSOL }),
          getTransferSolInstruction({ source: signer, destination: account, amount: BigInt(values.lamports) }),
          getSyncNativeInstruction({ account }),
        ],
        m,
      ),
  ),
);
const signature = getSignatureFromTransaction(signed);
await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
for (let attempt = 0; ; attempt++) {
  const { value } = await rpc.getSignatureStatuses([signature]).send();
  if (value[0]?.err) throw new Error(`${signature} failed: ${JSON.stringify(value[0].err, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v))}`);
  if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") break;
  if (attempt > 60) throw new Error(`${signature} did not confirm`);
  await new Promise((done) => setTimeout(done, 1_000));
}
console.log(`wrapped ${values.lamports} lamports for ${signer.address} into ${account}: ${signature}`);
