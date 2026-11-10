// `prove` from scratch on a fresh local validator running devnet's Kamino Lend, then again as a re-run, and the CLI
// wired to the same commands.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { borrow } from "../src/borrower.ts";
import { openContext, type Context } from "../src/context.ts";
import { deposit } from "../src/ctokens.ts";
import { CTOKEN_HOLDER, TEST_BORROWER } from "../src/policy.ts";
import { prove } from "../src/prove.ts";
import { startLocalValidator, type LocalValidator } from "./local-validator.ts";

const run = promisify(execFile);
let validator: LocalValidator;
let ctx: Context;
let dir: string;

before(async () => {
  validator = await startLocalValidator(19_899);
  dir = mkdtempSync(join(tmpdir(), "kamino-devnet-prove-"));
  ctx = await openContext({
    url: validator.url,
    keysDir: join(dir, "devnet"),
    bookPath: join(dir, "kamino-devnet.json"),
    quiet: true,
    createWallet: true,
  });
  await ctx.chain.airdrop(ctx.keys.wallet.address, 100_000_000_000n);
});

after(async () => {
  await validator?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("prove runs every check of the ticket from scratch", async () => {
  const result = await prove(ctx, { rateWatchSeconds: 3 });
  assert.ok(result.created.includes("lending market"));
  assert.ok(result.checks.length > 40);
  assert.ok(result.lockedLamports > 5_000_000_000n, "the second depositor's 5 SOL is locked");
  assert.ok(result.spentLamports > 0n && result.spentLamports < 100_000_000n, `spent ${result.spentLamports}`);
  assert.match(result.summary, /\| create the lending market \| \[`/);
  assert.match(result.summary, /refused: ReserveEmergencyMode/);
});

test("prove runs again on the same market, creating nothing, after an interrupted run left cTokens and a loan", async () => {
  // What a run that stopped half way leaves behind: the plain holder's cTokens and the borrower's open loan.
  await deposit(ctx, ctx.keys.ctokenHolder, "wsol", CTOKEN_HOLDER.wsol);
  await borrow(ctx, TEST_BORROWER.borrow);
  const result = await prove(ctx, { rateWatchSeconds: 3 });
  assert.deepEqual(result.created, []);
});

test("the CLI runs the same commands against the same address book", async () => {
  const args = ["src/cli.ts", "--url", validator.url, "--keys", join(dir, "devnet"), "--addresses", join(dir, "kamino-devnet.json")];
  const { stdout } = await run("node", [...args, "status"]);
  assert.match(stdout, /WSOL reserve /);
  assert.match(stdout, /utilisation {6}0\.00%/);
  const book = JSON.parse(readFileSync(join(dir, "kamino-devnet.json"), "utf8"));
  assert.ok(stdout.includes(book.reserves.wsol.address));
  const layout = await run("node", [...args, "layout"]);
  assert.doesNotMatch(layout.stdout, /FAIL/);
  await assert.rejects(run("node", [...args, "take-back", "--reserve", "btc", "--amount", "1"]), /--reserve must be wsol or usdc/);
});
