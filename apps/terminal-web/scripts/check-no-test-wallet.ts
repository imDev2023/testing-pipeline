// The production build contains no test wallet (PIPESCOPE-94; #121): the Playwright test wallet lives
// only in tests/terminal-e2e and is injected into the page by Playwright, so no file of the build that
// deploys may carry its marks. Run after the build: `node scripts/check-no-test-wallet.ts`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** What only the test wallet carries: its name, the function it signs through and its key's file. */
export const TEST_WALLET_MARKS = ["Aviary Test Wallet", "__testWalletSignAndSend", "e2e-trader.json"];

/** Every file under `dir` holding one of the marks, with the mark. */
export function findTestWallet(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const text = readFileSync(path).toString("latin1");
        for (const mark of TEST_WALLET_MARKS) if (text.includes(mark)) found.push(`${relative(dir, path)}: ${mark}`);
      }
    }
  };
  walk(dir);
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The OpenNext build is what deploys; it holds the Next build's output it serves.
  const build = join(fileURLToPath(new URL("..", import.meta.url)), ".open-next");
  let found: string[];
  try {
    found = findTestWallet(build);
  } catch {
    console.error(`No production build at ${build}: build it first (pnpm --filter terminal-web preview, or opennextjs-cloudflare build).`);
    process.exit(1);
  }
  if (found.length) {
    console.error(`The production build carries the test wallet:\n${found.join("\n")}`);
    process.exit(1);
  }
  console.log(`The production build (${build}) carries no test wallet.`);
}
