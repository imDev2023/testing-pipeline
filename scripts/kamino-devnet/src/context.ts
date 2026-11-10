// What every command works with: the RPC, the keys in the devnet key folder and the address book they imply.
import { existsSync } from "node:fs";

import { deriveAddressBook, readAddressBook, type AddressBook } from "./addresses.ts";
import { Chain } from "./chain.ts";
import { loadKeys, type Keys } from "./keys.ts";

export interface Context {
  chain: Chain;
  keys: Keys;
  keysDir: string;
  bookPath: string;
  book: AddressBook;
  log(line: string): void;
}

export interface ContextOptions {
  url: string;
  keysDir: string;
  bookPath: string;
  quiet?: boolean;
  /** Tests on a local validator make a fresh wallet; on devnet the project's wallet must already exist. */
  createWallet?: boolean;
}

export async function openContext(options: ContextOptions): Promise<Context> {
  const log = options.quiet ? () => {} : (line: string) => console.log(line);
  const keys = await loadKeys(options.keysDir, { createWallet: options.createWallet });
  const book = await deriveAddressBook(keys.marketOwner.address, keys.testUsdcMintAuthority.address);
  if (existsSync(options.bookPath)) {
    const committed = readAddressBook(options.bookPath);
    if (committed.lendingMarket.address !== book.lendingMarket.address || committed.testUsdc.mint !== book.testUsdc.mint) {
      throw new Error(
        `${options.bookPath} names lending market ${committed.lendingMarket.address} and test USDC mint ` +
          `${committed.testUsdc.mint}, but the keys in ${options.keysDir} give ${book.lendingMarket.address} and ` +
          `${book.testUsdc.mint}: use the key folder that created them`,
      );
    }
  }
  return {
    chain: new Chain(options.url, log),
    keys,
    keysDir: options.keysDir,
    bookPath: options.bookPath,
    book,
    log,
  };
}
