// `setup`: creates our Kamino lending market on devnet, as the spec's Devnet steps give it, and changes nothing that
// is already as it should be. A run from scratch creates the test USDC mint, the lending market and both reserves,
// configures each reserve while it holds only its seed, then opens it by raising its deposit limit with Kamino's full
// validation. A later run creates nothing, sends no transaction when nothing changed, and reports the same addresses.
import { Reserve } from "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve.js";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getCreateAccountWithSeedInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from "@solana-program/token";

import { writeAddressBook, type AddressBook } from "./addresses.ts";
import type { Context } from "./context.ts";
import { initLendingMarket, initReserve, reserveConfigItems, updateReserveConfig } from "./kamino.ts";
import { LENDING_MARKET_SIZE, RESERVE_SIZE, decodeLendingMarket } from "./layout.ts";
import {
  ACCOUNT_SEEDS,
  KLEND_PROGRAM,
  MARKET_OWNER_FUNDING,
  RESERVES,
  RESERVE_KEYS,
  RESERVE_SEED,
  TEST_USDC_DECIMALS,
  type ReserveKey,
} from "./policy.ts";
import { associatedTokenAccount, createAssociatedTokenAccount, wrapSol } from "./tokens.ts";

export interface SetupResult {
  book: AddressBook;
  /** What this run created or changed; empty when everything was already in place. */
  created: string[];
}

const CONFIG_UPDATES_PER_TRANSACTION = 4;

export async function setup(ctx: Context): Promise<SetupResult> {
  const { book } = ctx;
  const created: string[] = [];
  ctx.log(`Lending market ${book.lendingMarket.address}, owner ${book.lendingMarket.owner}`);

  if (!(await ctx.chain.account(book.testUsdc.mint))) {
    await createTestUsdcMint(ctx);
    created.push("test USDC mint");
  }

  const market = await ctx.chain.account(book.lendingMarket.address);
  if (!market) {
    await fundMarketOwner(ctx);
    await createLendingMarket(ctx);
    created.push("lending market");
  } else if (decodeLendingMarket(market.data).owner !== ctx.keys.marketOwner.address) {
    throw new Error(`lending market ${book.lendingMarket.address} has another owner`);
  }

  for (const key of RESERVE_KEYS) {
    if (!(await ctx.chain.account(book.reserves[key].address))) {
      await fundMarketOwner(ctx);
      await createReserve(ctx, key);
      created.push(`${RESERVES[key].label} reserve`);
    }
    const changed = await configureReserve(ctx, key);
    if (changed.length > 0) created.push(`${RESERVES[key].label} reserve config: ${changed.join(", ")}`);
  }

  if (writeAddressBook(ctx.bookPath, book)) ctx.log(`Wrote ${ctx.bookPath}`);
  ctx.log(created.length > 0 ? `Created or changed: ${created.join("; ")}` : "Nothing to create: all in place");
  return { book, created };
}

async function createTestUsdcMint(ctx: Context) {
  const { wallet, testUsdcMintAuthority } = ctx.keys;
  const mint = ctx.book.testUsdc.mint;
  const space = getMintSize();
  await ctx.chain.send(
    "create the test USDC mint",
    [
      createWithSeed(wallet, testUsdcMintAuthority, mint, ACCOUNT_SEEDS.testUsdcMint, await ctx.chain.rent(space), space, TOKEN_PROGRAM_ADDRESS),
      getInitializeMint2Instruction({
        mint,
        decimals: TEST_USDC_DECIMALS,
        mintAuthority: testUsdcMintAuthority.address,
      }),
    ],
    wallet,
  );
}

async function createLendingMarket(ctx: Context) {
  const { wallet, marketOwner } = ctx.keys;
  await ctx.chain.send(
    "create the lending market",
    [
      createWithSeed(
        wallet,
        marketOwner,
        ctx.book.lendingMarket.address,
        ACCOUNT_SEEDS.lendingMarket,
        await ctx.chain.rent(LENDING_MARKET_SIZE),
        LENDING_MARKET_SIZE,
        KLEND_PROGRAM,
      ),
      initLendingMarket(marketOwner, ctx.book),
    ],
    wallet,
  );
}

/** `init_reserve` takes Kamino's seed deposit from the owner's token account, so that account holds it first. */
async function createReserve(ctx: Context, key: ReserveKey) {
  const { wallet, marketOwner, testUsdcMintAuthority } = ctx.keys;
  const reserve = ctx.book.reserves[key];
  const seedSource = await associatedTokenAccount(marketOwner.address, reserve.liquidityMint);
  const missing = RESERVE_SEED - (await ctx.chain.tokenBalance(seedSource));
  const prepare: Instruction[] = [await createAssociatedTokenAccount(wallet, marketOwner.address, reserve.liquidityMint)];
  if (missing > 0n) {
    prepare.push(
      ...(key === "wsol"
        ? wrapSol(wallet, seedSource, missing)
        : [getMintToInstruction({ mint: reserve.liquidityMint, token: seedSource, mintAuthority: testUsdcMintAuthority, amount: missing })]),
    );
  }
  await ctx.chain.send(`put the ${RESERVES[key].label} reserve's seed in the owner's token account`, prepare, wallet);
  await ctx.chain.send(
    `create the ${RESERVES[key].label} reserve`,
    [
      createWithSeed(wallet, marketOwner, reserve.address, ACCOUNT_SEEDS.reserves[key], await ctx.chain.rent(RESERVE_SIZE), RESERVE_SIZE, KLEND_PROGRAM),
      initReserve(marketOwner, ctx.book, reserve, seedSource),
    ],
    wallet,
  );
}

/**
 * Moves every configured field of the reserve to its policy value. While the reserve holds only its seed (both
 * limits 0) Kamino lets the owner skip its validation; raising the deposit limit, which opens the reserve, always
 * runs it, so the opening changes go last.
 */
async function configureReserve(ctx: Context, key: ReserveKey): Promise<string[]> {
  const reserve = ctx.book.reserves[key];
  const items = reserveConfigItems(RESERVES[key], reserve.pythPrice);
  const read = async () => {
    const account = await ctx.chain.account(reserve.address);
    return Reserve.decode(Buffer.from(account!.data));
  };
  const current = await read();
  const pending = items.filter((item) => !sameBytes(item.current(current), item.value));
  if (pending.length === 0) return [];

  const predeposit = current.config.depositLimit.isZero() && current.config.borrowLimit.isZero();
  const preparing = pending.filter((item) => !item.opens);
  const opening = pending.filter((item) => item.opens);
  for (let i = 0; i < preparing.length; i += CONFIG_UPDATES_PER_TRANSACTION) {
    const batch = preparing.slice(i, i + CONFIG_UPDATES_PER_TRANSACTION);
    await ctx.chain.send(
      `configure the ${RESERVES[key].label} reserve: ${batch.map((item) => item.label).join(", ")}`,
      batch.map((item) => updateReserveConfig(ctx.keys.marketOwner, ctx.book, reserve.address, item.mode, item.value, predeposit)),
      ctx.keys.wallet,
    );
  }
  if (opening.length > 0) {
    await ctx.chain.send(
      `open the ${RESERVES[key].label} reserve: ${opening.map((item) => item.label).join(", ")}`,
      opening.map((item) => updateReserveConfig(ctx.keys.marketOwner, ctx.book, reserve.address, item.mode, item.value, false)),
      ctx.keys.wallet,
    );
  }

  const after = await read();
  const wrong = items.filter((item) => !sameBytes(item.current(after), item.value));
  if (wrong.length > 0) {
    throw new Error(`${RESERVES[key].label} reserve: ${wrong.map((item) => item.label).join(", ")} did not take effect`);
  }
  return pending.map((item) => item.label);
}

/** Tops the market owner's key up to its funding level, which covers the rent `init_reserve` charges it. */
async function fundMarketOwner(ctx: Context) {
  const { wallet, marketOwner } = ctx.keys;
  const balance = await ctx.chain.balance(marketOwner.address);
  if (balance >= MARKET_OWNER_FUNDING / 2n) return;
  await ctx.chain.send(
    "fund the market owner",
    [getTransferSolInstruction({ source: wallet, destination: marketOwner.address, amount: MARKET_OWNER_FUNDING - balance })],
    wallet,
  );
}

function createWithSeed(
  payer: TransactionSigner,
  base: TransactionSigner,
  newAccount: Address,
  seed: string,
  amount: bigint,
  space: number,
  programAddress: Address,
): Instruction {
  return getCreateAccountWithSeedInstruction({
    payer,
    newAccount,
    baseAccount: base,
    base: base.address,
    seed,
    amount,
    space,
    programAddress,
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
