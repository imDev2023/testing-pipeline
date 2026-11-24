// Requests signed by a wallet Aviary knows by address (the keeper's heartbeats, the operator's
// Canary re-runs): no secret is shared, and only that wallet's key can make one.
import { address, getBase58Encoder, getPublicKeyFromAddress, signatureBytes, verifySignature } from "@solana/kit";

/** Whether `signature` (base58) is `wallet`'s Ed25519 signature of `message`. */
export async function signedBy(wallet: string, message: Uint8Array, signature: string): Promise<boolean> {
  try {
    const bytes = getBase58Encoder().encode(signature);
    if (bytes.length !== 64) return false;
    const key = await getPublicKeyFromAddress(address(wallet));
    return await verifySignature(key, signatureBytes(new Uint8Array(bytes)), message);
  } catch {
    return false;
  }
}
