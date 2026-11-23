// The script's commands, run end to end against a local validator that runs devnet's own Kamino Lend.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { Reserve } from "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve.js";

import { readAddressBook } from "../src/addresses.ts";
import { openContext, type Context } from "../src/context.ts";
import { deposit, readReserve, redeem } from "../src/ctokens.ts";
import { attemptPlain, readLendingMarket, setEmergencyMode } from "../src/emergency.ts";
import { checkLayout, formatChecks } from "../src/layout-check.ts";
import { statusReport } from "../src/status.ts";
import { borrow, borrowerPosition, repayAll, watchRate } from "../src/borrower.ts";
import { secondDepositorPosition, supplySecondDepositor, takeBack } from "../src/parties.ts";
import { CTOKEN_INSTRUCTIONS } from "../src/kamino.ts";
import {
  decodeLendingMarket,
  decodeReserve,
  freeLiquidity,
  redeemValue,
  storedRate,
  storedRateRose,
  totalSupplySf,
  utilisationBps,
} from "../src/layout.ts";
import {
  CTOKEN_HOLDER,
  DEMO_TARGET_LENT_VALUE,
  KEY_FILES,
  KLEND_PROGRAM,
  PYTH_FEEDS,
  RESERVES,
  RESERVE_KEYS,
  RESERVE_SEED,
  SECOND_DEPOSITOR,
  TEST_BORROWER,
  WITHDRAW_MODE_EXIT,
  WSOL_MINT,
} from "../src/policy.ts";
import { refreshReserves } from "../src/refresh.ts";
import { setup } from "../src/setup.ts";
import { startLocalValidator, type LocalValidator } from "./local-validator.ts";

let validator: LocalValidator;
let ctx: Context;
let keysDir: string;
let bookPath: string;

before(async () => {
  validator = await startLocalValidator(18_899);
  const dir = mkdtempSync(join(tmpdir(), "kamino-devnet-keys-"));
  keysDir = join(dir, "devnet");
  bookPath = join(dir, "kamino-devnet.json");
  ctx = await openContext({ url: validator.url, keysDir, bookPath, quiet: true, createWallet: true });
  await ctx.chain.airdrop(ctx.keys.wallet.address, 100_000_000_000n);
});

after(async () => {
  await validator?.stop();
  if (keysDir) rmSync(join(keysDir, ".."), { recursive: true, force: true });
});

describe("setup", () => {
  test("from scratch, creates the lending market, the test USDC mint and both reserves, and opens them", async () => {
    const result = await setup(ctx);
    const book = result.book;
    assert.deepEqual(readAddressBook(bookPath), book);
    assert.ok(result.created.length > 0);

    const [marketAccount] = await ctx.chain.accounts([book.lendingMarket.address]);
    const market = decodeLendingMarket(marketAccount!.data);
    assert.equal(market.owner, ctx.keys.marketOwner.address);
    assert.equal(book.lendingMarket.owner, ctx.keys.marketOwner.address);
    assert.equal(book.testUsdc.mintAuthority, ctx.keys.testUsdcMintAuthority.address);

    for (const key of RESERVE_KEYS) {
      const entry = book.reserves[key];
      const [account] = await ctx.chain.accounts([entry.address]);
      const reserve = decodeReserve(account!.data);
      assert.equal(reserve.lendingMarket, book.lendingMarket.address);
      assert.equal(reserve.liquidityMint, key === "wsol" ? WSOL_MINT : book.testUsdc.mint);
      assert.equal(reserve.liquiditySupply, entry.liquiditySupply);
      assert.equal(reserve.collateralMint, entry.collateralMint);
      assert.equal(reserve.collateralSupply, entry.collateralSupply);
      assert.equal(reserve.depositLimit, RESERVES[key].depositLimit, `${key} is open for deposits`);
      assert.equal(reserve.totalAvailableAmount, RESERVE_SEED, `${key} holds only its seed`);
      assert.equal(reserve.collateralMintTotalSupply, RESERVE_SEED);
      assert.equal(await ctx.chain.mintSupply(entry.collateralMint), 0n, "no cTokens are minted for the seed");
      const idl = Reserve.decode(Buffer.from(account!.data));
      assert.equal(idl.config.tokenInfo.pythConfiguration.price, PYTH_FEEDS[key]);
    }

    for (const name of [KEY_FILES.marketOwner, KEY_FILES.testUsdcMintAuthority]) {
      assert.equal(statSync(join(keysDir, name)).mode & 0o777, 0o600, `${name} is private`);
    }
  });

  test("run again, creates nothing and reports the same addresses", async () => {
    const before = readFileSync(bookPath, "utf8");
    const signatures = ctx.chain.journal.length;
    const result = await setup(ctx);
    assert.deepEqual(result.created, []);
    assert.equal(readFileSync(bookPath, "utf8"), before);
    assert.equal(ctx.chain.journal.length, signatures, "no transaction was sent");
  });
});

describe("the plain cToken holder", () => {
  test("deposits and redeems with no oracle account and no refresh, and is paid at least at the stored rate", async () => {
    const holder = ctx.keys.ctokenHolder;
    for (const key of RESERVE_KEYS) {
      const amount = CTOKEN_HOLDER[key];
      const deposited = await deposit(ctx, holder, key, amount);
      assert.equal(deposited.after.totalAvailableAmount - deposited.before.totalAvailableAmount, amount);
      assert.ok(deposited.ctokens > 0n);
      assert.equal(
        deposited.after.collateralMintTotalSupply - deposited.before.collateralMintTotalSupply,
        deposited.ctokens,
      );

      const redeemed = await redeem(ctx, holder, key, "all");
      assert.equal(redeemed.ctokens, deposited.ctokens);
      assert.ok(redeemed.received >= redeemValue(redeemed.before, redeemed.ctokens));
      assert.equal(redeemed.before.totalAvailableAmount - redeemed.after.totalAvailableAmount, redeemed.received);

      for (const signature of [deposited.signature, redeemed.signature]) {
        const tx = await ctx.chain.transaction(signature);
        for (const feed of Object.values(PYTH_FEEDS)) assert.ok(!tx.accounts.includes(feed), "no oracle account");
        const kamino = tx.instructions.filter((ix) => ix.programId === KLEND_PROGRAM);
        assert.equal(kamino.length, 1);
        assert.ok(
          Object.values(CTOKEN_INSTRUCTIONS).some((d) => Buffer.from(d).equals(Buffer.from(kamino[0]!.discriminator))),
          "only a cToken deposit or redeem, no refresh",
        );
      }
    }
  });
});

describe("the second depositor", () => {
  test("supplies each reserve up to its target, which keeps WSOL free liquidity above 10 times a demo market's", async () => {
    for (const key of RESERVE_KEYS) {
      const supplied = await supplySecondDepositor(ctx, key);
      assert.ok(supplied, "the first supply deposits");
      assert.ok((await secondDepositorPosition(ctx, key)) >= SECOND_DEPOSITOR[key]);
      assert.equal(await supplySecondDepositor(ctx, key), null, "a second supply finds the target met");
    }
    const wsol = await readReserve(ctx, "wsol");
    assert.ok(freeLiquidity(wsol) >= WITHDRAW_MODE_EXIT * DEMO_TARGET_LENT_VALUE.wsol);
  });

  test("takes liquidity back, and supplies it again", async () => {
    const amount = 1_000_000_000n;
    const taken = await takeBack(ctx, "wsol", amount);
    assert.ok(taken.received <= amount && taken.received >= amount - 2n);
    assert.equal(freeLiquidity(taken.before) - freeLiquidity(taken.after), taken.received);
    assert.ok((await secondDepositorPosition(ctx, "wsol")) < SECOND_DEPOSITOR.wsol);
    assert.ok(await supplySecondDepositor(ctx, "wsol"));
    assert.ok((await secondDepositorPosition(ctx, "wsol")) >= SECOND_DEPOSITOR.wsol);
  });
});

describe("the test borrower", () => {
  test("opens an obligation on test USDC and borrows WSOL, which lowers free liquidity by what it borrowed", async () => {
    const borrowed = await borrow(ctx, TEST_BORROWER.borrow);
    assert.equal(freeLiquidity(borrowed.before) - freeLiquidity(borrowed.after), TEST_BORROWER.borrow);
    assert.ok(utilisationBps(borrowed.after) > 0n);
    const position = await borrowerPosition(ctx);
    assert.equal(position.collateralReserve, ctx.book.reserves.testUsdc.address);
    assert.ok(position.collateralCtokens > 0n);
    assert.ok(position.debt >= TEST_BORROWER.borrow);
  });

  test("while the loan is open the stored rate rises", async () => {
    const watched = await watchRate(ctx, 5);
    assert.ok(storedRateRose(watched.before, watched.after));
    assert.ok(watched.interest > 0n);
  });

  test("repays in full", async () => {
    const repaid = await repayAll(ctx);
    assert.equal((await borrowerPosition(ctx)).debt, 0n);
    assert.ok(repaid.repaid > TEST_BORROWER.borrow, "principal and interest");
    assert.equal(freeLiquidity(repaid.after) - freeLiquidity(repaid.before), repaid.repaid);
  });
});

describe("emergency mode", () => {
  test("with the WSOL reserve's emergency mode on, Kamino refuses the plain wallet's deposit and redeem; off, they work", async () => {
    const holder = ctx.keys.ctokenHolder;
    const amount = CTOKEN_HOLDER.wsol;
    await deposit(ctx, holder, "wsol", amount);

    await setEmergencyMode(ctx, "reserve", true);
    assert.equal((await readReserve(ctx, "wsol")).emergencyMode, 1);
    assert.equal((await attemptPlain(ctx, holder, "wsol", "deposit", amount)).error, "ReserveEmergencyMode");
    assert.equal((await attemptPlain(ctx, holder, "wsol", "redeem", 1n)).error, "ReserveEmergencyMode");

    await setEmergencyMode(ctx, "reserve", false);
    assert.equal((await readReserve(ctx, "wsol")).emergencyMode, 0);
    await deposit(ctx, holder, "wsol", amount);
    await redeem(ctx, holder, "wsol", "all");
  });

  test("with the lending market's emergency mode on, Kamino refuses deposits; off, they work", async () => {
    const holder = ctx.keys.ctokenHolder;
    await setEmergencyMode(ctx, "market", true);
    assert.equal((await readLendingMarket(ctx)).emergencyMode, 1);
    assert.equal((await attemptPlain(ctx, holder, "wsol", "deposit", CTOKEN_HOLDER.wsol, "market")).error, "GlobalEmergencyMode");
    await setEmergencyMode(ctx, "market", false);
    assert.equal((await readLendingMarket(ctx)).emergencyMode, 0);
    await deposit(ctx, holder, "wsol", CTOKEN_HOLDER.wsol);
    await redeem(ctx, holder, "wsol", "all");
  });
});

describe("reading the reserves back", () => {
  test("each reserve and the lending market have the size, discriminator and offsets the spec relies on", async () => {
    const checks = await checkLayout(ctx);
    assert.ok(checks.length > 50);
    assert.deepEqual(checks.filter((c) => !c.ok), [], formatChecks(checks));
  });

  test("status prints, per reserve, supply, borrowed, free liquidity, utilisation, stored rate and flags", async () => {
    await borrow(ctx, TEST_BORROWER.borrow);
    const report = await statusReport(ctx);
    for (const key of RESERVE_KEYS) {
      const r = await readReserve(ctx, key);
      const row = report.reserves.find((row) => row.key === key)!;
      assert.equal(row.totalSupply, totalSupplySf(r) >> 60n);
      assert.equal(row.freeLiquidity, freeLiquidity(r));
      assert.equal(row.utilisationBps, utilisationBps(r));
      assert.equal(row.storedRate, storedRate(r));
      assert.equal(row.emergencyMode, 0);
    }
    assert.ok(report.reserves.find((row) => row.key === "wsol")!.utilisationBps > 0n);
    for (const label of ["total supply", "borrowed", "free liquidity", "utilisation", "stored rate", "emergency mode", "block cToken usage"]) {
      assert.ok(report.text.includes(label), label);
    }
    await repayAll(ctx);
  });
});

describe("refreshing the reserves", () => {
  test("anyone refreshes each reserve, which brings its last update to the refresh's slot and accrues its interest", async () => {
    const before = await Promise.all(RESERVE_KEYS.map((key) => readReserve(ctx, key)));
    const refreshed = await refreshReserves(ctx, RESERVE_KEYS);
    assert.deepEqual(refreshed.map((r) => r.key), RESERVE_KEYS);
    for (const [i, key] of RESERVE_KEYS.entries()) {
      const after = await readReserve(ctx, key);
      assert.ok(after.lastUpdateSlot > before[i]!.lastUpdateSlot, `${key}: last update ${after.lastUpdateSlot}`);
      assert.equal(after.lastUpdateSlot, refreshed[i]!.slot, key);
      assert.ok(totalSupplySf(after) >= totalSupplySf(before[i]!), key);
    }
  });
});
