// The keeper wallet's key, read only from the file KEEPER_KEYPAIR names (docs/spec/keeper-runner.md,
// "The keeper wallet"): a `solana-keygen` JSON file, on the owner's Mac
// ~/.config/testing-pipeline/devnet/keeper.json, in Docker a read-only mount. Nothing here
// writes the key anywhere, and no error repeats the file's contents.

import { readFileSync, statSync } from 'node:fs';

import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';

export async function loadKeypair(path: string): Promise<{ signer: KeyPairSigner; warnings: string[] }> {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        throw new Error(`cannot read the keeper wallet's key at ${path} (KEEPER_KEYPAIR): ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}`);
    }
    let bytes: unknown;
    try {
        bytes = JSON.parse(text);
    } catch {
        throw new Error(`${path} (KEEPER_KEYPAIR) is not a solana-keygen key file: not JSON`);
    }
    if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        throw new Error(`${path} (KEEPER_KEYPAIR) is not a solana-keygen key file: it must hold 64 bytes`);
    }
    let signer: KeyPairSigner;
    try {
        signer = await createKeyPairSignerFromBytes(new Uint8Array(bytes));
    } catch {
        throw new Error(`${path} (KEEPER_KEYPAIR) does not hold a valid key pair`);
    }
    const warnings: string[] = [];
    // Group or others may read it: say so, since a leaked key loses the float.
    if ((statSync(path).mode & 0o077) !== 0) warnings.push(`${path} can be read by other users of this machine; chmod 600 it`);
    return { signer, warnings };
}
