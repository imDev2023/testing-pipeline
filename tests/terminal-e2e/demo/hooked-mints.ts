// The setup of Aviary's hooked-mints demo (#122, the ticket's local demo run): on a local validator
// running devnet's router (demo/hooked-validator.sh), two constant-product markets of Pipeline's
// test-strategy-cp, each trading wrapped SOL against a Token-2022 mint with a transfer hook:
//
//   allowlist  Pipeline's test-hook, whose one extra account is a whitelist naming the pool's vault
//              of the token, so every buy and sell passes the hook only with that account;
//   refill     Pipeline's test-hook-refill, whose four extra accounts are fixed addresses, two of them
//              writable (its stash, left empty, and its target), so a swap must carry them writable.
//
// Each market is created through the router and seeded with the strategy's own `deposit`, whose
// transfer of the token carries the hook's accounts; the Playwright test wallet's trader is funded
// with SOL, and so is Aviary's fee wallet, which pays for quotes' simulations, with its wrapped-SOL
// account for the integrator fee, both read from terminal-api's wrangler.jsonc. The trades themselves go through Aviary's trade box: src/trade-hooked.spec.ts, which
// reads the markets from fixtures/hooked-demo/markets.json, written here.
//
//   node tests/terminal-e2e/demo/hooked-mints.ts
//
// Before it, from the repo's root, with the toolchain (source scripts/toolchain-env.sh):
//   scripts/fetch-router.sh && scripts/fetch-pipeline.sh sdk programs
//   tests/terminal-e2e/demo/hooked-validator.sh fixtures/hooked-demo/ledger --rpc-port 8977 \
//     --faucet-port 9977 --gossip-port 8987 --dynamic-port-range 8400-8450
// After it, the trades: docs/toolchain.md, "Aviary's hooked-mints demo".
//
// Environment: DEMO_RPC (http://127.0.0.1:8977), DEMO_DIR (fixtures/hooked-demo, where the
// validator script made the demo's throwaway key). Nothing goes to devnet.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pipeline from "@pipeline-sol/sdk";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getSyncNativeInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  extension,
  getCreateAssociatedTokenIdempotentInstruction as getCreateAssociatedToken2022Instruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getPreInitializeInstructionsForMintExtensions,
  resolveExtraAccountMetasForExecute,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  AccountRole,
  addSignersToTransactionMessage,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type AccountMeta,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { TEST_TRADER } from "../src/wallet.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const RPC = process.env.DEMO_RPC ?? "http://127.0.0.1:8977";
const DIR = process.env.DEMO_DIR ?? join(ROOT, "fixtures/hooked-demo");
const DEPLOY = join(ROOT, "fixtures/pipeline/programs/target/deploy");
/** Where the trade box's demo spec reads the markets: beside the demo's key, since Playwright empties test-results/ as it starts. */
export const HOOKED_MARKETS = join(DIR, "markets.json");

const CP = address("yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx");
const WSOL = pipeline.NATIVE_MINT_ADDRESS;
const POOL_FEE_BPS = 30;
const DECIMALS = 6;
/** What each market is seeded with: 10 SOL and 1,000,000 tokens, a price of 0.00001 SOL. */
const SEED_LAMPORTS = 10_000_000_000n;
const SEED_TOKENS = 1_000_000n * 10n ** BigInt(DECIMALS);
const TRADER_LAMPORTS = 20_000_000_000n;

const rpc = createSolanaRpc(RPC);
const encoder = getAddressEncoder();
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const keypair = async (file: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));

async function confirmed(signature: string, what: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const { value } = await rpc.getSignatureStatuses([signature as never]).send();
    if (value[0]?.err) throw new Error(`${what} failed: ${JSON.stringify(value[0].err, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v))}`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return;
    await sleep(500);
  }
  throw new Error(`${what} did not confirm`);
}

async function send(payer: KeyPairSigner, what: string, instructions: Instruction[], signers: KeyPairSigner[] = []): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) => addSignersToTransactionMessage(signers, m),
    ),
  );
  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  await confirmed(signature, what);
  log(`${what}: ${signature}`);
  return signature;
}

async function airdrop(to: Address, amount: bigint): Promise<void> {
  // A validator's faucet can refuse the first request right after it starts; it is asked again.
  for (let attempt = 0; ; attempt++) {
    try {
      const signature = await rpc.requestAirdrop(to, lamports(amount), { commitment: "confirmed" }).send();
      await confirmed(signature, `airdrop to ${to}`);
      return;
    } catch (e) {
      if (attempt >= 10) throw e;
      await sleep(1_000);
    }
  }
}

const ata = async (owner: Address, mint: Address, tokenProgram: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];

/** The constant-product strategy's own `deposit` (no LP shares; Pipeline's playground), with the token's hook accounts after its own. */
function deposit(depositor: Address, pool: Address, a: { from: Address; vault: Address; mint: Address; program: Address }, b: typeof a, amounts: [bigint, bigint], hookAccounts: AccountMeta[]): Instruction {
  const data = new Uint8Array(24);
  data.set([242, 35, 198, 137, 82, 225, 242, 182]); // sha256("global:deposit")[..8]
  const view = new DataView(data.buffer);
  view.setBigUint64(8, amounts[0], true);
  view.setBigUint64(16, amounts[1], true);
  return {
    programAddress: CP,
    accounts: [
      { address: depositor, role: AccountRole.READONLY_SIGNER },
      { address: pool, role: AccountRole.WRITABLE },
      { address: a.from, role: AccountRole.WRITABLE },
      { address: b.from, role: AccountRole.WRITABLE },
      { address: a.vault, role: AccountRole.WRITABLE },
      { address: b.vault, role: AccountRole.WRITABLE },
      { address: a.mint, role: AccountRole.READONLY },
      { address: b.mint, role: AccountRole.READONLY },
      { address: a.program, role: AccountRole.READONLY },
      { address: b.program, role: AccountRole.READONLY },
      ...hookAccounts,
    ],
    data,
  };
}

export type HookedMarket = {
  kind: "allowlist" | "refill";
  market: Address;
  pool: Address;
  mint: Address;
  vault: Address;
  hookProgram: Address;
  validation: Address;
  /** The hook's extra accounts, in its list's order, and which of them are writable. */
  extras: { address: Address; writable: boolean }[];
};

async function hookedMarket(authority: KeyPairSigner, kind: HookedMarket["kind"], hookProgram: Address): Promise<HookedMarket> {
  const mint = await generateKeyPairSigner();
  const [pool] = await getProgramDerivedAddress({ programAddress: CP, seeds: ["pool", encoder.encode(WSOL), encoder.encode(mint.address), new Uint8Array([POOL_FEE_BPS & 0xff, POOL_FEE_BPS >> 8])] });
  const vaultA = await ata(pool, WSOL, TOKEN_PROGRAM_ADDRESS);
  const vaultB = await ata(pool, mint.address, TOKEN_2022_PROGRAM_ADDRESS);
  const holderA = await ata(authority.address, WSOL, TOKEN_PROGRAM_ADDRESS);
  const holderB = await ata(authority.address, mint.address, TOKEN_2022_PROGRAM_ADDRESS);
  const [validation] = await getProgramDerivedAddress({ programAddress: hookProgram, seeds: ["extra-account-metas", encoder.encode(mint.address)] });

  // The mint, with its transfer hook set to the hook program, and the demo's tokens.
  const extensions = [extension("TransferHook", { authority: authority.address, programId: hookProgram })];
  const space = BigInt(getMintSize(extensions));
  await send(authority, `${kind}: the mint ${mint.address}`, [
    getCreateAccountInstruction({ payer: authority, newAccount: mint, lamports: await rpc.getMinimumBalanceForRentExemption(space).send(), space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    ...getPreInitializeInstructionsForMintExtensions(mint.address, extensions),
    getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: authority.address }),
    getCreateAssociatedToken2022Instruction({ payer: authority, ata: holderB, owner: authority.address, mint: mint.address }),
    getMintToInstruction({ mint: mint.address, token: holderB, mintAuthority: authority, amount: SEED_TOKENS * 2n }),
  ], [mint]);

  // The hook's validation account, which names its extra accounts.
  let extras: HookedMarket["extras"];
  if (kind === "allowlist") {
    const [whitelist] = await getProgramDerivedAddress({ programAddress: hookProgram, seeds: ["whitelist", encoder.encode(mint.address)] });
    extras = [{ address: whitelist, writable: false }];
    await send(authority, `${kind}: the hook's list, allowing the pool's vault`, [
      {
        programAddress: hookProgram,
        accounts: [
          { address: authority.address, role: AccountRole.WRITABLE_SIGNER },
          { address: validation, role: AccountRole.WRITABLE },
          { address: whitelist, role: AccountRole.WRITABLE },
          { address: mint.address, role: AccountRole.READONLY },
          { address: address("11111111111111111111111111111111"), role: AccountRole.READONLY },
        ],
        data: new Uint8Array([...Buffer.from("tsthkini"), ...encoder.encode(vaultB)]),
      },
    ]);
  } else {
    // An empty stash of wrapped SOL, owned by the hook's ["stash"] address: on each transfer the hook empties it into the target, so here it moves nothing.
    const [stashAuthority] = await getProgramDerivedAddress({ programAddress: hookProgram, seeds: ["stash"] });
    const stash = await ata(stashAuthority, WSOL, TOKEN_PROGRAM_ADDRESS);
    extras = [
      { address: stash, writable: true },
      { address: stashAuthority, writable: false },
      { address: holderA, writable: true },
      { address: TOKEN_PROGRAM_ADDRESS, writable: false },
    ];
    await send(authority, `${kind}: the stash and the hook's list`, [
      getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: stash, owner: stashAuthority, mint: WSOL }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: holderA, owner: authority.address, mint: WSOL }),
      {
        programAddress: hookProgram,
        accounts: [
          { address: authority.address, role: AccountRole.WRITABLE_SIGNER },
          { address: validation, role: AccountRole.WRITABLE },
          { address: mint.address, role: AccountRole.READONLY },
          { address: address("11111111111111111111111111111111"), role: AccountRole.READONLY },
        ],
        data: new Uint8Array([...Buffer.from("refilini"), ...extras.flatMap((e) => [...encoder.encode(e.address), e.writable ? 1 : 0])]),
      },
    ]);
  }

  // The market through the router, and the fee account for wrapped SOL, the market's fee mint: Pipeline takes its fee in it both ways.
  await send(authority, `${kind}: the market`, [
    await pipeline.createMarket({
      creator: authority.address,
      strategyProgram: CP,
      marketState: pool,
      initData: new Uint8Array([POOL_FEE_BPS & 0xff, POOL_FEE_BPS >> 8]),
      maxCreatorLamports: 100_000_000n,
      strategyAccounts: [
        { address: WSOL, role: AccountRole.READONLY },
        { address: mint.address, role: AccountRole.READONLY },
        { address: vaultA, role: AccountRole.WRITABLE },
        { address: vaultB, role: AccountRole.WRITABLE },
        { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: pipeline.ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
    }),
  ]);
  const market = await pipeline.marketPda(CP, pool);
  await send(authority, `${kind}: the market's fee account for wrapped SOL`, [await pipeline.initFeeAccount({ payer: authority.address, market, mint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS })]);

  // Seeded with the strategy's deposit; its transfer of the token carries the hook's accounts, resolved from the hook's list.
  const hookAccounts = await resolveExtraAccountMetasForExecute({ rpc, transferHookProgramAddress: hookProgram, source: holderB, mint: mint.address, destination: vaultB, owner: authority.address, amount: SEED_TOKENS });
  await send(authority, `${kind}: seeded with ${SEED_LAMPORTS} lamports and ${SEED_TOKENS} base units`, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: holderA, owner: authority.address, mint: WSOL }),
    getTransferSolInstruction({ source: authority, destination: holderA, amount: SEED_LAMPORTS }),
    getSyncNativeInstruction({ account: holderA }),
    deposit(authority.address, pool, { from: holderA, vault: vaultA, mint: WSOL, program: TOKEN_PROGRAM_ADDRESS }, { from: holderB, vault: vaultB, mint: mint.address, program: TOKEN_2022_PROGRAM_ADDRESS }, [SEED_LAMPORTS, SEED_TOKENS], hookAccounts),
  ]);
  return { kind, market, pool, mint: mint.address, vault: vaultB, hookProgram, validation, extras };
}

async function main() {
  const authority = await keypair(join(DIR, "authority.json"));
  const hook = (await keypair(join(DEPLOY, "test_hook-keypair.json"))).address;
  const refill = (await keypair(join(DEPLOY, "test_hook_refill-keypair.json"))).address;
  log(`RPC ${RPC}; demo key ${authority.address}; test-hook ${hook}; test-hook-refill ${refill}`);
  await airdrop(authority.address, 100_000_000_000n);
  await airdrop(address(TEST_TRADER), TRADER_LAMPORTS);

  // Aviary's fee wallet as the local API knows it: it pays for quotes' simulations, and its wrapped-SOL account takes the integrator fee.
  const { vars } = parseJsonc(readFileSync(join(ROOT, "apps/terminal-api/wrangler.jsonc"), "utf8")) as { vars: { INTEGRATOR_FEE: { wallet: string; accounts: Record<string, string> } } };
  const feeWallet = address(vars.INTEGRATOR_FEE.wallet);
  const feeAccount = await ata(feeWallet, WSOL, TOKEN_PROGRAM_ADDRESS);
  if (feeAccount !== vars.INTEGRATOR_FEE.accounts[WSOL]) throw new Error(`the fee wallet's wrapped-SOL account in wrangler.jsonc is not its associated account ${feeAccount}`);
  await airdrop(feeWallet, 1_000_000_000n);
  await send(authority, "the fee wallet's wrapped-SOL account", [getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: feeAccount, owner: feeWallet, mint: WSOL })]);

  const configData = (await rpc.getAccountInfo(await pipeline.configPda(), { encoding: "base64" }).send()).value;
  const config = configData ? pipeline.decodeConfig(new Uint8Array(Buffer.from(configData.data[0], "base64"))) : null;
  if (!config) throw new Error("the router's config account is missing: start the validator with demo/hooked-validator.sh");
  if (!(await rpc.getAccountInfo(await pipeline.strategyPda(CP), { encoding: "base64" }).send()).value) {
    await send(authority, "test-strategy-cp registered with the router", [
      await pipeline.registerStrategy({
        payer: authority.address,
        registrar: authority.address,
        strategyProgram: CP,
        listingFeeRecipient: config.listingFeeRecipient,
        metadataUri: "https://example.com/aviary-hooked-demo/test-strategy-cp.json",
        maxListingFeeLamports: config.listingFeeLamports,
      }),
    ]);
  }

  const markets = [await hookedMarket(authority, "allowlist", hook), await hookedMarket(authority, "refill", refill)];
  mkdirSync(dirname(HOOKED_MARKETS), { recursive: true });
  writeFileSync(HOOKED_MARKETS, `${JSON.stringify({ rpc: RPC, trader: TEST_TRADER, markets }, null, 2)}\n`);
  log(`markets written to ${HOOKED_MARKETS}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
