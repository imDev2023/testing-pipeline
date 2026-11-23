import type { Metadata } from "next";
import Link from "next/link";
import { splitTyped } from "terminal-api/amounts";
import { Fees } from "terminal-api/contract";
import { ApiFailure, getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { Table } from "@/components/Table";
import { formatTokenAmount } from "@/format";
import { ROUTES } from "@/routes";
import { formatBps } from "@/trade";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Fees" };

/** The example: 1 SOL paid for a token, in lamports. */
const EXAMPLE_LAMPORTS = 1_000_000_000n;
const sol = (lamports: bigint) => `${formatTokenAmount(lamports, 9)} SOL`;

/**
 * Fees (docs/spec/pipescope-screens.md, "Fees and Devnet help"; docs/spec/pipescope.md, The integrator
 * fee): one table and three short parts. Every rate is read from the API, Pipeline's own included,
 * so none is written into this page.
 */
export default async function FeesPage() {
  let fees: Fees;
  try {
    fees = await getFromApi("/v1/fees", Fees);
  } catch (e) {
    return (
      <article className={styles.page}>
        <h1>Fees</h1>
        <p role="alert">Could not load the fees. {e instanceof ApiFailure ? e.message : "Something went wrong on this page."}</p>
        <Link href={ROUTES.fees}>Try again</Link>
      </article>
    );
  }
  const pipeline = formatBps(fees.pipeline_fee_bps);
  const ours = formatBps(fees.integrator_fee_bps);
  const feeMints = fees.fee_mints.map((m) => m.symbol);
  const paidIn = feeMints.join(" or ");
  const example = splitTyped(EXAMPLE_LAMPORTS, { feeSide: "input", pipelineBps: fees.pipeline_fee_bps, integratorBps: fees.integrator_fee_bps });
  const total = formatBps(fees.pipeline_fee_bps + fees.integrator_fee_bps);

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Fees</h1>
        <p className={styles.lede}>
          What a swap through {BRAND.name} costs, and who gets each part. Every swap also shows its own fees in the trade box before you sign.
        </p>
      </header>

      <Table
        caption="The fees on a swap"
        columns={[
          { key: "fee", label: "Fee" },
          { key: "rate", label: "Rate" },
          { key: "when", label: "When it is charged" },
          { key: "who", label: "Who gets it" },
        ]}
        rows={[
          {
            key: "pipeline",
            cells: {
              fee: "Pipeline fee",
              rate: pipeline,
              when: "Every swap: on what goes into the market, or on what arrives when you buy the market's fee mint",
              who: "Pipeline's router, by its own setting",
            },
          },
          { key: "ours", cells: { fee: BRAND.feeLabel, rate: ours, when: `Swaps you pay in ${paidIn}`, who: `${BRAND.name}'s fee wallet` } },
          { key: "strategy", cells: { fee: "The strategy's own fees and taxes", rate: "Set by each strategy", when: "As the strategy's rules say: included in its quote", who: "As the strategy's rules say" } },
          { key: "network", cells: { fee: "Solana network fee", rate: `${sol(BigInt(fees.network_fee_per_signature))} a signature`, when: "Every transaction", who: "Solana's validators" } },
        ]}
      />

      <section className={styles.part} aria-labelledby="example">
        <h2 id="example">An example</h2>
        <p>
          You pay {sol(EXAMPLE_LAMPORTS)} for a token. The amount you type is everything that leaves your wallet for the swap, so the fees come out of it:
        </p>
        <dl className={styles.example}>
          <div>
            <dt>Goes into the market</dt>
            <dd>{sol(example.netSent)}</dd>
          </div>
          <div>
            <dt>Pipeline fee, {pipeline}</dt>
            <dd>{sol(example.pipelineFeeOnInput)}</dd>
          </div>
          <div>
            <dt>
              {BRAND.feeLabel}, {ours}
            </dt>
            <dd>{sol(example.integratorFee)}</dd>
          </div>
          <div className={styles.total}>
            <dt>Leaves your wallet</dt>
            <dd>{sol(example.totalSpend)}</dd>
          </div>
        </dl>
        <p className={styles.note}>
          That is {total} in all, before the strategy&apos;s own fees and taxes, which its quote already includes, and the network fee.
        </p>
      </section>

      <section className={styles.part} aria-labelledby="no-fee">
        <h2 id="no-fee">What carries no {BRAND.feeLabel}</h2>
        <ul>
          <li>Swaps paid in any token other than {paidIn}.</li>
          <li>A strategy&apos;s own actions.</li>
          <li>Creating a market.</li>
        </ul>
      </section>

      <section className={styles.part} aria-labelledby="cannot">
        <h2 id="cannot">What the fee cannot do</h2>
        <ul>
          <li>The swap is built from exactly the rate on screen.</li>
          <li>Every swap is simulated before your wallet is asked to sign.</li>
          <li>{BRAND.name} never holds your tokens or your keys.</li>
        </ul>
      </section>
    </article>
  );
}
