import type { Metadata } from "next";
import { BRAND } from "@/brand";
import { SubjectAddress } from "@/components/Address";
import { CHECKED_ON, DEVNET_USDC_MINT, DIFFERENCES, SOL_FAUCET, USDC_FAUCET, WALLETS } from "@/content/devnet-help";
import { formatDay } from "@/format";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Devnet help" };

/** Devnet help (docs/spec/pipescope-screens.md, "Fees and Devnet help"): four parts, from src/content/devnet-help.ts. */
export default function DevnetHelp() {
  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Devnet help</h1>
        <p className={styles.lede}>
          {BRAND.name} runs on Solana&apos;s devnet, where tokens are free and have no value. {BRAND.name} has no faucet of its own; the faucets named here were
          checked on {formatDay(CHECKED_ON)}.
        </p>
      </header>

      <section className={styles.part} aria-labelledby="wallet">
        <h2 id="wallet">Point your wallet at devnet</h2>
        <div className={styles.wallets}>
          {WALLETS.map((wallet) => (
            <div key={wallet.name} className={styles.wallet}>
              <h3>{wallet.name}</h3>
              <ol>
                {wallet.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.part} aria-labelledby="sol">
        <h2 id="sol">Get devnet SOL</h2>
        <p>
          Ask <a href={SOL_FAUCET.href}>{SOL_FAUCET.label}</a> for devnet SOL with your wallet&apos;s address. Solana&apos;s command-line airdrop is closed on
          devnet, so the web faucet is the way.
        </p>
      </section>

      <section className={styles.part} aria-labelledby="usdc">
        <h2 id="usdc">Get devnet USDC</h2>
        <p>
          Ask <a href={USDC_FAUCET.href}>{USDC_FAUCET.label}</a> for USDC on Solana Devnet. Devnet USDC is this mint:
        </p>
        <SubjectAddress address={DEVNET_USDC_MINT} />
      </section>

      <section className={styles.part} aria-labelledby="different">
        <h2 id="different">What is different on devnet</h2>
        <ul>
          {DIFFERENCES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}
