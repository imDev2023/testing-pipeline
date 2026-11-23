// Aviary's token-image check token on devnet (#120): no devnet token named an image Aviary could keep
// on 2026-11-23 (every token metadata URI answered an HTTP error, or named no image), so this launches
// one that does, to see a token image on Aviary's pages against devnet's own data.
//
//   1. create a Token-2022 mint (6 decimals) whose token metadata extension names `--uri`, a JSON
//      document naming the image, mint its supply to the wallet and give up the mint authority (a tax
//      market's seed refuses a mint that keeps one, TAX-16), keeping the metadata's update authority so
//      the URI can be moved (`--update-uri`);
//   2. create a tax market of it against wrapped SOL, then seed it, from the tax AMM's own metadata, with
//      Pipeline's SDK, as the tax AMM's devnet demo creates its demo market (programs/tax-amm/scripts/demo.ts),
//      with only what Aviary's packages have (no tax AMM client), so CI's terminal job type-checks it;
//   3. buy the token once through the router, so the market has a price.
//
// The record goes to deployments/devnet-demo-token-image.json.
//
//   direnv exec <main checkout> node tests/terminal-e2e/demo/token-image-check.ts --uri <https URL of token.json>
//   direnv exec <main checkout> node tests/terminal-e2e/demo/token-image-check.ts --uri <same URL> --mint <mint>
//     (after a run that stopped before its market was created: on the token it made; it makes a new market)
//   direnv exec <main checkout> node tests/terminal-e2e/demo/token-image-check.ts --update-uri <https URL> --mint <mint>
//
// Devnet only. It signs with ~/.config/testing-pipeline/devnet/wallet.json, which pays about 0.06 SOL.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as pipeline from "@pipeline-sol/sdk";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getArrayEncoder,
  getBase64EncodedWireTransaction,
  getStructEncoder,
  getU16Encoder,
  getU64Encoder,
  getU8Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  addSignersToTransactionMessage,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TAX_AMM = address("J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t");
const SYSTEM = address("11111111111111111111111111111111");
const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WRAPPED_SOL = address("So11111111111111111111111111111111111111112");
const DEFAULT_ADDRESS = address("11111111111111111111111111111111");

/** The token: its name and symbol, its supply in base units (6 decimals), the market's seed and the one buy. */
const TOKEN_NAME = "Aviary Image Check";
const TOKEN_SYMBOL = "AVIMG";
const DECIMALS = 6;
const SUPPLY = 1_000_000_000_000n;
const SEED = [100_000_000_000n, 50_000_000n] as const;
const BUY_LAMPORTS = 5_000_000n;
/** The tax market's terms, as the tax AMM demo's demo market (SOL_MARKET): taxed in wrapped SOL, 3% in, 5% out. */
const TERMS = {
  taxSide: 1,
  buyTaxBps: 300,
  sellTaxBps: 500,
  buyTaxMinBps: 100,
  buyTaxMaxBps: 800,
  sellTaxMinBps: 0,
  sellTaxMaxBps: 900,
  shares: [6_000, 4_000, 0, 0],
  burnShareBps: 0,
  virtualSide: 0,
  virtualReserve: 0n,
};
const MAX_CREATOR_LAMPORTS = 100_000_000n;

const { values: options } = parseArgs({ options: { uri: { type: "string" }, "update-uri": { type: "string" }, mint: { type: "string" } }, strict: true });
const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) throw new Error("RPC_URL is not set: run it with the project's .env loaded (direnv exec <main checkout>).");
const rpc = createSolanaRpc(rpcUrl);
const record: Record<string, string> = {};

const utf8 = new TextEncoder();
const u32 = (n: number) => Uint8Array.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
const u64 = (n: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
};
const bytesOf = (a: Address) => Uint8Array.from(getAddressEncoder().encode(a));
const borshString = (s: string) => [...u32(utf8.encode(s).length), ...utf8.encode(s)];
const discriminator = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8);
const ix = (programAddress: Address, accounts: [Address, AccountRole][], data: ArrayLike<number>): Instruction => ({
  programAddress,
  accounts: accounts.map(([a, role]) => ({ address: a, role })),
  data: Uint8Array.from(data),
});
const { WRITABLE_SIGNER, WRITABLE, READONLY, READONLY_SIGNER } = AccountRole;

/** A tax market's vault for one of its mints: the tax AMM's PDA `["vault", market state, mint]`. */
async function vaultPda(marketState: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: TAX_AMM, seeds: [utf8.encode("vault"), bytesOf(marketState), bytesOf(mint)] });
  return pda;
}

/** The tax AMM's `InitParams`, Borsh-encoded in its order (programs/tax-amm/src). */
const initParamsEncoder = getStructEncoder([
  ["taxSide", getU8Encoder()],
  ["buyTaxBps", getU16Encoder()],
  ["sellTaxBps", getU16Encoder()],
  ["buyTaxMinBps", getU16Encoder()],
  ["buyTaxMaxBps", getU16Encoder()],
  ["sellTaxMinBps", getU16Encoder()],
  ["sellTaxMaxBps", getU16Encoder()],
  ["taxAuthority", getAddressEncoder()],
  ["seeder", getAddressEncoder()],
  ["recipients", getArrayEncoder(getAddressEncoder(), { size: 4 })],
  ["shares", getArrayEncoder(getU16Encoder(), { size: 4 })],
  ["burnShareBps", getU16Encoder()],
  ["virtualSide", getU8Encoder()],
  ["virtualReserve", getU64Encoder()],
]);

/**
 * The `seed` action's `expected_terms` (TAX-59): the SHA-256 of the two mints, the creation
 * parameters and the pending rate change (none at creation), written in base58 as a key.
 */
function expectedTerms(mints: readonly [Address, Address], params: Parameters<typeof initParamsEncoder.encode>[0]): Address {
  const hash = createHash("sha256");
  for (const mint of mints) hash.update(bytesOf(mint));
  hash.update(Uint8Array.from(initParamsEncoder.encode(params)));
  hash.update(new Uint8Array(12));
  return getAddressDecoder().decode(new Uint8Array(hash.digest()));
}

/** The tax AMM's `seed` action from its metadata, built as an instruction with Pipeline's SDK, as Aviary's forms build one. */
async function seedInstruction(metadata: unknown, view: pipeline.MarketView, wallet: Address, args: Record<string, bigint | Address>): Promise<Instruction> {
  type Action = { name: string; discriminator?: string; args?: pipeline.MetadataArg[]; accounts?: pipeline.MetadataAccount[] };
  const action = ((metadata as { aviary_actions?: Action[] }).aviary_actions ?? []).find((a) => a.name === "seed");
  if (!action) throw new Error("the tax AMM's metadata has no seed action");
  const specs = action.args ?? [];
  const encoded = pipeline.encodeArgs(specs, args);
  const accounts = await pipeline.resolveMetadataAccounts(action.accounts ?? [], { strategyProgram: view.strategyProgram, wallet, market: view, marketState: view.marketState, args: encoded });
  const discriminator = action.discriminator ? Uint8Array.from(Buffer.from(action.discriminator, "hex")) : await pipeline.anchorDiscriminator(action.name);
  return { programAddress: view.strategyProgram, accounts, data: Uint8Array.from([...discriminator, ...specs.flatMap((spec) => [...encoded[spec.name]!])]) };
}

async function ata(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [bytesOf(owner), bytesOf(tokenProgram), bytesOf(mint)] });
  return pda;
}
const createAtaIdempotent = async (payer: Address, owner: Address, mint: Address, tokenProgram: Address) =>
  ix(ATA_PROGRAM, [[payer, WRITABLE_SIGNER], [await ata(owner, mint, tokenProgram), WRITABLE], [owner, READONLY], [mint, READONLY], [SYSTEM, READONLY], [tokenProgram, READONLY]], [1]);

async function send(label: string, payer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[] = []): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage(extra, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const simulated = await rpc.simulateTransaction(wire, { encoding: "base64", commitment: "confirmed" }).send();
  if (simulated.value.err) throw new Error(`${label}: the simulation failed: ${JSON.stringify(simulated.value.err, (_, v) => (typeof v === "bigint" ? String(v) : v))}\n${(simulated.value.logs ?? []).join("\n")}`);
  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  for (let i = 0; i < 120; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`${label} failed: ${JSON.stringify(value[0].err)}`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") {
      console.log(`${label}: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
      record[label] = signature;
      return signature;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${label}: ${signature} not confirmed after 60 s`);
}

/** Step 1: the Token-2022 mint naming `uri` in its token metadata, its supply minted to the wallet, no mint authority. */
async function createToken(payer: KeyPairSigner, uri: string): Promise<Address> {
  const mint = await generateKeyPairSigner();
  // The mint with a metadata pointer to itself: its base, the account type, and the pointer's entry.
  const space = 165 + 1 + 4 + 64;
  // The token metadata entry Token-2022 adds when it is initialised, which the rent must already cover.
  const metadataLength = 4 + 32 + 32 + borshString(TOKEN_NAME).length + borshString(TOKEN_SYMBOL).length + borshString(uri).length + 4;
  const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(space + metadataLength)).send();
  const holder = await ata(payer.address, mint.address, TOKEN_2022);
  await send("create the check token", payer, [
    ix(SYSTEM, [[payer.address, WRITABLE_SIGNER], [mint.address, WRITABLE_SIGNER]], [...u32(0), ...u64(lamports), ...u64(BigInt(space)), ...bytesOf(TOKEN_2022)]),
    // MetadataPointerExtension::Initialize: the payer may move it, and it points at the mint itself.
    ix(TOKEN_2022, [[mint.address, WRITABLE]], [39, 0, ...bytesOf(payer.address), ...bytesOf(mint.address)]),
    // InitializeMint2: decimals, the payer as mint authority, no freeze authority.
    ix(TOKEN_2022, [[mint.address, WRITABLE]], [20, DECIMALS, ...bytesOf(payer.address), 0]),
    // The token metadata interface's Initialize: name, symbol and URI, the payer its update authority.
    ix(TOKEN_2022, [[mint.address, WRITABLE], [payer.address, READONLY], [mint.address, READONLY], [payer.address, READONLY_SIGNER]], [
      ...discriminator("spl_token_metadata_interface:initialize_account"),
      ...borshString(TOKEN_NAME),
      ...borshString(TOKEN_SYMBOL),
      ...borshString(uri),
    ]),
    await createAtaIdempotent(payer.address, payer.address, mint.address, TOKEN_2022),
    // MintTo, then SetAuthority(MintTokens) to none.
    ix(TOKEN_2022, [[mint.address, WRITABLE], [holder, WRITABLE], [payer.address, READONLY_SIGNER]], [7, ...u64(SUPPLY)]),
    ix(TOKEN_2022, [[mint.address, WRITABLE], [payer.address, READONLY_SIGNER]], [6, 0, 0]),
  ], [mint]);
  record["check token"] = mint.address;
  return mint.address;
}

/** Moves the token metadata's URI (the update authority signs), paying first for the longer entry. */
async function updateUri(payer: KeyPairSigner, mint: Address, uri: string) {
  await send("move the check token's URI", payer, [
    ix(SYSTEM, [[payer.address, WRITABLE_SIGNER], [mint, WRITABLE]], [...u32(2), ...u64(await rpc.getMinimumBalanceForRentExemption(BigInt(4 + uri.length)).send())]),
    // UpdateField with Field::Uri (variant 2).
    ix(TOKEN_2022, [[mint, WRITABLE], [payer.address, READONLY_SIGNER]], [...discriminator("spl_token_metadata_interface:updating_field"), 2, ...borshString(uri)]),
  ]);
}

/** Steps 2 and 3: the tax market of the token against wrapped SOL, seeded, then one buy through the router. */
async function createMarket(payer: KeyPairSigner, token: Address) {
  const metadata = pipeline.parseStrategyMetadata(JSON.parse(readFileSync(`${ROOT}programs/tax-amm/metadata.json`, "utf8")));
  if (!metadata.ok) throw new Error(`programs/tax-amm/metadata.json is invalid: ${metadata.errors.join("; ")}`);
  const init = metadata.value.init ?? (() => { throw new Error("the tax AMM's metadata has no init form"); })();
  const solHolder = await ata(payer.address, WRAPPED_SOL, TOKEN);
  // Wrapped SOL for the seed and the buy, with Pipeline's fee on the buy, less what the wallet already holds.
  const needed = SEED[1] + (pipeline.maxTotalSpend(BUY_LAMPORTS, 0) ?? BUY_LAMPORTS * 2n);
  const holding = await rpc.getTokenAccountBalance(solHolder, { commitment: "confirmed" }).send().then((r) => BigInt(r.value.amount), () => 0n);
  if (holding < needed) {
    await send("wrap the seed's and the buy's SOL", payer, [
      await createAtaIdempotent(payer.address, payer.address, WRAPPED_SOL, TOKEN),
      ix(SYSTEM, [[payer.address, WRITABLE_SIGNER], [solHolder, WRITABLE]], [...u32(2), ...u64(needed - holding)]),
      ix(TOKEN, [[solHolder, WRITABLE]], [17]),
    ]);
  }

  const mints = [token, WRAPPED_SOL] as const;
  const tokenPrograms = [TOKEN_2022, TOKEN];
  const marketStateKey = await generateKeyPairSigner();
  const marketState = marketStateKey.address;
  const recipients = [payer.address, (await generateKeyPairSigner()).address, DEFAULT_ADDRESS, DEFAULT_ADDRESS];
  const sent = { ...TERMS, taxAuthority: payer.address, seeder: payer.address, recipients };
  const args: Record<string, number | bigint | Address> = {
    tax_side: sent.taxSide,
    buy_tax_bps: sent.buyTaxBps,
    sell_tax_bps: sent.sellTaxBps,
    buy_tax_min_bps: sent.buyTaxMinBps,
    buy_tax_max_bps: sent.buyTaxMaxBps,
    sell_tax_min_bps: sent.sellTaxMinBps,
    sell_tax_max_bps: sent.sellTaxMaxBps,
    tax_authority: sent.taxAuthority,
    seeder: sent.seeder,
    burn_share_bps: sent.burnShareBps,
    virtual_side: sent.virtualSide,
    virtual_reserve: sent.virtualReserve,
  };
  sent.recipients.forEach((r, i) => (args[`recipient_${i}`] = r));
  sent.shares.forEach((s, i) => (args[`share_${i}`] = s));
  const { instruction: create } = await pipeline.buildCreateMarketFromMetadata({
    init,
    strategyProgram: TAX_AMM,
    creator: payer.address,
    marketState,
    args,
    inputs: { mint_0: mints[0], mint_1: mints[1] },
    tokenPrograms: { [mints[0]]: tokenPrograms[0]!, [mints[1]]: tokenPrograms[1]! },
    maxCreatorLamports: MAX_CREATOR_LAMPORTS,
    rpc,
  });
  const market = await pipeline.marketPda(TAX_AMM, marketState);
  const vault0 = await vaultPda(marketState, mints[0]);
  const vault1 = await vaultPda(marketState, mints[1]);
  const view: pipeline.MarketView = { market, strategyProgram: TAX_AMM, marketState, mints: [...mints], vaults: [vault0, vault1], tokenPrograms, supportsExactOut: false };
  // The tax AMM's metadata asks for all three in one transaction, which with a Token-2022 mint is 13
  // bytes past a transaction's limit; a market is closed until its seed and only its seeder (this
  // wallet) may seed it, so the seed follows in the next transaction.
  await send("create the check market and its fee accounts", payer, [
    create,
    ...(await Promise.all(mints.map((mint, i) => pipeline.initFeeAccount({ payer: payer.address, market, mint, tokenProgram: tokenPrograms[i]! })))),
  ], [marketStateKey]);
  await send("seed the check market", payer, [await seedInstruction(metadata.value, view, payer.address, { amount_0: SEED[0], amount_1: SEED[1], expected_terms: expectedTerms(mints, sent) })]);
  record["check market"] = market;
  record["check market state"] = marketState;
  const held = await Promise.all([vault0, vault1].map(async (vault) => BigInt((await rpc.getTokenAccountBalance(vault, { commitment: "confirmed" }).send()).value.amount)));
  if (held[0] !== SEED[0] || held[1] !== SEED[1]) throw new Error(`the market's vaults hold ${held}, not the seed ${SEED}`);
  console.log(`market ${market}: seeded, its vaults holding ${held}`);

  // One buy of the token with wrapped SOL.
  const trade = { mode: pipeline.TradeMode.ExactIn, inputIndex: 1, outputIndex: 0, amount: BUY_LAMPORTS, trader: payer.address, extra: new Uint8Array() };
  const strategyAccounts = await pipeline.resolveAccounts(rpc, view, trade, payer.address, { commitment: "confirmed" });
  const { quote } = await pipeline.quoteStrategy(rpc, view, trade, strategyAccounts, payer.address, { commitment: "confirmed" });
  const recorded = pipeline.decodeMarket(Uint8Array.from(Buffer.from((await rpc.getAccountInfo(market, { encoding: "base64", commitment: "confirmed" }).send()).value!.data[0], "base64")))!;
  const feeSide = pipeline.feeSideOf(recorded, token);
  const kept = feeSide === "output" ? pipeline.keptAfterOutputFee(quote.amountOut) : quote.amountOut;
  await send("buy the check token through the router", payer, [
    await pipeline.swap(
      {
        trader: payer.address,
        strategyProgram: TAX_AMM,
        marketState,
        traderInput: solHolder,
        traderOutput: await ata(payer.address, token, TOKEN_2022),
        inputVault: vault1,
        inputMint: WRAPPED_SOL,
        outputMint: token,
        inputTokenProgram: TOKEN,
        outputTokenProgram: TOKEN_2022,
        strategyAccounts,
      },
      { mode: pipeline.TradeMode.ExactIn, amountIn: BUY_LAMPORTS, amountOut: 0n, minAmountOut: kept, integratorFeeBps: 0, extra: new Uint8Array() },
      feeSide,
    ),
  ]);
}

async function main() {
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== DEVNET_GENESIS) throw new Error(`RPC_URL is not devnet (genesis ${genesis}): this runs on devnet only`);
  const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/testing-pipeline/devnet/wallet.json`, "utf8")) as number[]));
  if (options["update-uri"]) {
    if (!options.mint) throw new Error("--update-uri needs --mint");
    await updateUri(payer, address(options.mint), options["update-uri"]);
    return;
  }
  const uri = options.uri ?? (() => { throw new Error("--uri names the token's metadata document, an https: URL"); })();
  // With --mint, the token a run that stopped already created.
  const token = options.mint ? address(options.mint) : await createToken(payer, uri);
  record["check token"] = token;
  await createMarket(payer, token);
  const out = `${ROOT}deployments/devnet-demo-token-image.json`;
  writeFileSync(out, `${JSON.stringify({ note: "Aviary's token-image check token and its tax market on devnet (#120): tests/terminal-e2e/demo/token-image-check.ts", cluster: "devnet", date: new Date().toISOString().slice(0, 10), uri, ...record }, null, 2)}\n`);
  console.log(`recorded in ${out}`);
}

await main();
