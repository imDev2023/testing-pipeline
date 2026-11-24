// Adapted from Top-pad b833a7b, tests/ui/src/wallet.ts (itself from Stoker at 43e196b); owned here since.
// The Playwright test wallet (PIPESCOPE-94): a Wallet Standard wallet registered in the page under test
// before any app code runs, so the page sees an ordinary installed Solana wallet. It exists only in
// this test suite and is injected by Playwright, so no build of the web app ever contains it (the
// production build is checked for it by apps/terminal-web/scripts/check-no-test-wallet.ts). The key stays in Node and signs through an
// exposed function, so a test decides per request whether the "user" approves or declines.
//
// The key is the devnet test trader's, ~/.config/testing-pipeline/devnet/e2e-trader.json, and only
// on devnet runs and local demo runs (which send to the local validator) is it read: on the recorded fixtures (CI) the wallet holds the trader's address and no
// key, so it connects, quotes and reviews exactly as recorded, and can decline but never sign.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { expect, type Locator, type Page } from "@playwright/test";
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getAddressEncoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { SEND_RPC } from "./target.ts";

export const TEST_WALLET_NAME = "Aviary Test Wallet";
/** The test trader's address: ~/.config/testing-pipeline/devnet/e2e-trader.json's public key, which holds devnet SOL. */
export const TEST_TRADER = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW";
const TRADER_KEY = `${homedir()}/.config/testing-pipeline/devnet/e2e-trader.json`;

/** The test trader's signer, read only for runs against devnet. */
export async function testTraderSigner(): Promise<KeyPairSigner> {
  if (!existsSync(TRADER_KEY)) throw new Error(`the test trader's key is not at ${TRADER_KEY}`);
  const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(TRADER_KEY, "utf8")) as number[]));
  if (signer.address !== TEST_TRADER) throw new Error(`${TRADER_KEY} is not the test trader ${TEST_TRADER}`);
  return signer;
}

const ICON = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#13222c"/>` +
    `<path d="M9 12h14v10H9z" fill="none" stroke="#f9fbfb" stroke-width="2.5" stroke-linejoin="round"/><circle cx="19" cy="17" r="1.8" fill="#f9fbfb"/></svg>`,
).toString("base64")}`;

export type TestWallet = {
  /** Every transaction the wallet was asked to sign, in order, as the page handed it over. */
  requests: Transaction[];
  /** Each signature the wallet sent, base64. */
  sent: string[];
  /** The next signature request is declined, as a user pressing "Reject" in their wallet. */
  declineNext: () => void;
};

type InitArgs = { name: string; icon: string; address: string; publicKey: number[] };

/** Runs in the page before any app code: registers the wallet with whichever Wallet Standard app shows up. */
function register({ name, icon, address, publicKey }: InitArgs) {
  const chains = ["solana:devnet"] as const;
  const account = Object.freeze({ address, publicKey: new Uint8Array(publicKey), chains, features: ["solana:signAndSendTransaction"] as const, label: name });
  let accounts: (typeof account)[] = [];
  const listeners = new Set<(p: { accounts: typeof accounts }) => void>();
  const changed = () => listeners.forEach((l) => l({ accounts }));
  const toB64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
  const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const signAndSend = (window as unknown as { __testWalletSignAndSend: (tx: string) => Promise<string> }).__testWalletSignAndSend;

  const wallet = {
    version: "1.0.0",
    name,
    icon,
    chains,
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          accounts = [account];
          changed();
          return { accounts };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          accounts = [];
          changed();
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event: string, listener: (p: { accounts: typeof accounts }) => void) => {
          if (event !== "change") return () => undefined;
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      },
      // As a wallet does, it signs the transaction and sends it through its own RPC, answering with the signature.
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          const signatures: { signature: Uint8Array }[] = [];
          for (const { transaction } of inputs) signatures.push({ signature: fromB64(await signAndSend(toB64(transaction))) });
          return signatures;
        },
      },
    },
  };

  const give = (api: { register: (w: unknown) => unknown }) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) => give((e as CustomEvent).detail));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: give }));
}

/**
 * Opens the wallet menu from a "Connect wallet" button and returns the test wallet's entry in it. A
 * click that lands before the page has hydrated does nothing, so it clicks again until the menu is open.
 */
export async function connectTestWallet(page: Page, button: Locator) {
  const item = page.getByRole("menuitem", { name: TEST_WALLET_NAME });
  await expect(async () => {
    if (!(await item.isVisible())) await button.click();
    await expect(item).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await item.click();
}

/** The project's devnet wallet, ~/.config/testing-pipeline/devnet/wallet.json, as a signer: the wallet page's devnet test unwraps its wrapped SOL (#122). */
export async function projectWalletSigner(): Promise<KeyPairSigner> {
  const file = `${homedir()}/.config/testing-pipeline/devnet/wallet.json`;
  if (!existsSync(file)) throw new Error(`the project's devnet wallet is not at ${file}`);
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(file, "utf8")) as number[]));
}

/**
 * Installs the wallet into a page; call before the first navigation. It holds the signer's address,
 * the test trader's by default; without a signer it holds the test trader's and declines every signature.
 */
export async function installTestWallet(page: Page, signer: KeyPairSigner | null): Promise<TestWallet> {
  let decline = false;
  const wallet: TestWallet = { requests: [], sent: [], declineNext: () => void (decline = true) };
  const decodeTx = getTransactionDecoder();
  const rpc = signer ? createSolanaRpc(SEND_RPC) : null;
  await page.exposeFunction("__testWalletSignAndSend", async (b64: string) => {
    const tx = decodeTx.decode(getBase64Encoder().encode(b64));
    wallet.requests.push(tx);
    if (decline || !signer || !rpc) {
      decline = false;
      throw new Error("User rejected the request.");
    }
    const signed = await partiallySignTransaction([signer.keyPair], tx);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
    const signature = getBase64Decoder().decode(signed.signatures[signer.address]!);
    wallet.sent.push(signature);
    return signature;
  });
  const holds = signer?.address ?? TEST_TRADER;
  await page.addInitScript(register, { name: TEST_WALLET_NAME, icon: ICON, address: holds, publicKey: Array.from(getAddressEncoder().encode(holds as never)) } satisfies InitArgs);
  return wallet;
}
