// A constant-product market made by a script, for Canary's tests (#124): two fresh SPL mints and a
// market between them on Pipeline's Apache-2.0 test-strategy-cp (devnet's constant product strategy,
// or a copy deployed at another address on a local validator), funded with the strategy's own
// `deposit`. Written for this repo with @solana/kit and Pipeline's SDK; nothing of Pipeline's own
// scripts is copied.
import * as pipeline from "@pipeline-sol/sdk";
import { getCreateAccountInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction, getMintSize, getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type createSolanaRpc,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";

/** devnet's constant product strategy, Pipeline's test-strategy-cp. */
export const DEVNET_CP = "yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx" as Address;
/** The pool fee of the markets made here, in basis points: part of each pool's address. */
const POOL_FEE_BPS = 30;
/** test-strategy-cp's `deposit`: sha256("global:deposit")[..8]. */
const DEPOSIT = Buffer.from("f223c68952e1f2b6", "hex");

type Rpc = ReturnType<typeof createSolanaRpc>;

/** Sends `instructions` paid by `payer` and waits until they are confirmed; returns the signature. */
export async function sendAndConfirm(rpc: Rpc, payer: KeyPairSigner, instructions: Instruction[]): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signed = await signTransactionMessageWithSigners(
    pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(instructions, m)),
  );
  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
  const deadline = Date.now() + 90_000;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(value[0].err)}`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return signature;
    if (Date.now() > deadline) throw new Error(`transaction ${signature} was not confirmed in 90 s`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

const ata = async (owner: Address, mint: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

/** A fresh SPL mint with `supply` in `authority`'s own account. */
async function mintWithSupply(rpc: Rpc, authority: KeyPairSigner, decimals: number, supply: bigint): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = getMintSize();
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  const own = await ata(authority.address, mint.address);
  await sendAndConfirm(rpc, authority, [
    getCreateAccountInstruction({ payer: authority, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: authority.address }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: authority, owner: authority.address, mint: mint.address, ata: own }),
    getMintToInstruction({ mint: mint.address, token: own, mintAuthority: authority, amount: supply }),
  ]);
  return mint.address;
}

/** Creates and funds a market of `strategy` (test-strategy-cp) between two fresh mints; returns its address and the signatures. */
export async function createCpMarket(rpc: Rpc, authority: KeyPairSigner, strategy: Address): Promise<{ market: Address; signatures: string[] }> {
  const signatures: string[] = [];
  const mintA = await mintWithSupply(rpc, authority, 6, 1_000_000_000_000n);
  const mintB = await mintWithSupply(rpc, authority, 9, 1_000_000_000_000n);
  const feeSeed = new Uint8Array([POOL_FEE_BPS & 0xff, POOL_FEE_BPS >> 8]);
  const encoder = getAddressEncoder();
  const [pool] = await getProgramDerivedAddress({ programAddress: strategy, seeds: ["pool", encoder.encode(mintA), encoder.encode(mintB), feeSeed] });
  const vaultA = await ata(pool, mintA);
  const vaultB = await ata(pool, mintB);
  signatures.push(
    await sendAndConfirm(rpc, authority, [
      await pipeline.createMarket({
        creator: authority.address,
        strategyProgram: strategy,
        marketState: pool,
        initData: feeSeed,
        maxCreatorLamports: 100_000_000n,
        strategyAccounts: [
          { address: mintA, role: AccountRole.READONLY },
          { address: mintB, role: AccountRole.READONLY },
          { address: vaultA, role: AccountRole.WRITABLE },
          { address: vaultB, role: AccountRole.WRITABLE },
          { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
          { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
          { address: pipeline.ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        ],
      }),
    ]),
  );
  const market = await pipeline.marketPda(strategy, pool);
  signatures.push(
    await sendAndConfirm(rpc, authority, [
      await pipeline.initFeeAccount({ payer: authority.address, market, mint: mintA, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      await pipeline.initFeeAccount({ payer: authority.address, market, mint: mintB, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    ]),
  );
  const data = new Uint8Array(24);
  data.set(DEPOSIT);
  new DataView(data.buffer).setBigUint64(8, 100_000_000_000n, true);
  new DataView(data.buffer).setBigUint64(16, 200_000_000_000n, true);
  const writable = (address: Address) => ({ address, role: AccountRole.WRITABLE });
  signatures.push(
    await sendAndConfirm(rpc, authority, [
      {
        programAddress: strategy,
        accounts: [
          { address: authority.address, role: AccountRole.READONLY_SIGNER },
          writable(pool),
          writable(await ata(authority.address, mintA)),
          writable(await ata(authority.address, mintB)),
          writable(vaultA),
          writable(vaultB),
          { address: mintA, role: AccountRole.READONLY },
          { address: mintB, role: AccountRole.READONLY },
          { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
          { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        ],
        data,
      },
    ]),
  );
  return { market, signatures };
}
