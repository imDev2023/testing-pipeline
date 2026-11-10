// Keys in the devnet key folder (`~/.config/testing-pipeline/devnet/`), in the Solana CLI's JSON format.
// A missing key is created with mode 600 in a folder of mode 700; an existing key file is never overwritten.
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";

import { KEY_FILES } from "./policy.ts";

export type KeyName = keyof typeof KEY_FILES;
export type Keys = Record<KeyName, KeyPairSigner>;

export async function loadKeys(dir: string, options: { createWallet?: boolean } = {}): Promise<Keys> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keys = {} as Keys;
  for (const [name, file] of Object.entries(KEY_FILES) as [KeyName, string][]) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      if (name === "wallet" && !options.createWallet) {
        throw new Error(`The devnet wallet ${path} does not exist (docs/toolchain.md, Devnet)`);
      }
      writeKeyFile(path);
    }
    keys[name] = await readKeyFile(path);
  }
  return keys;
}

async function readKeyFile(path: string): Promise<KeyPairSigner> {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  return createKeyPairSignerFromBytes(bytes);
}

function writeKeyFile(path: string) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const secret = Buffer.concat([Buffer.from(jwk.d!, "base64url"), Buffer.from(jwk.x!, "base64url")]);
  writeFileSync(path, JSON.stringify(Array.from(secret)), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}
