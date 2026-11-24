"use client";

// The review of a custom action or a new market (docs/spec/pipescope-screens.md, Review and sign: "A
// custom action, creating a market and unwrapping SOL follow the same steps"; PIPESCOPE-09,
// PIPESCOPE-78): the transaction built and simulated exactly as it would be signed, what signing would
// change in the wallet, and only then "Sign in wallet"; a failed simulation shows its error decoded and
// keeps the button off. After the wallet signs and sends, the API waits for it to confirm.
import { useSignAndSendTransaction } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import { getBase58Decoder, getBase64Encoder } from "@solana/kit";
import type { ReactNode } from "react";
import { TransactionReport, type Failure, type TransactionSimulation } from "terminal-api/contract";
import { ApiFailure, postToApi } from "@/api";
import { BRAND } from "@/brand";
import { EXPLORER, FAILED_SIMULATION_LOG_LINES, PREPARED_SWAP_MAX_AGE_MS } from "@/config";
import { formatInteger, formatTokenAmount, shortAddress } from "@/format";
import type { MintInfo } from "@/formValues";
import { MintLabel } from "../MintLabel";
import { ShortAddress } from "../ShortAddress";
import box from "../market/TradeBox.module.css";
import { useWallet } from "../wallet/WalletProvider";
import styles from "./Forms.module.css";

const SOL_DECIMALS = 9;

/** What a prepare answers, for an action or a new market. */
export type Prepared = { transaction: string | null; simulation: TransactionSimulation; wrapped_sol: string; accounts: { address: string; writable: boolean; signer: boolean }[] };

export type ReviewState<P extends Prepared> =
  | { status: "building"; rebuilt: boolean }
  | { status: "ready"; prepared: P; at: number; rebuilt: boolean; walletNote: string | null }
  | { status: "failed"; prepared: P }
  | { status: "error"; message: string; failure: Failure | null; logs: readonly string[] }
  | { status: "signing"; prepared: P; at: number }
  | { status: "sent"; prepared: P; signature: string }
  | { status: "confirmed"; prepared: P; signature: string; slot: number }
  | { status: "unsettled"; prepared: P; signature: string; message: string; failure: Failure | null };

export const failureOf = (e: unknown) => (e instanceof ApiFailure ? e.message : "Something went wrong on this page.");

export type ReviewProps<P extends Prepared> = {
  /** "Review this action", "Review the new market". */
  title: string;
  /** What the panel says while it builds and simulates. */
  building: string;
  review: ReviewState<P>;
  /** Names the mints of the balance changes. */
  mintOf: (mint: string) => MintInfo | null;
  onBack: () => void;
  onRebuild: () => void;
  onSigning: () => void;
  onDeclined: (note: string) => void;
  onSent: (prepared: P, signature: string) => void;
  /** Signs in the page before the wallet does, as a new market's state keypair does (PIPESCOPE-144). */
  presign?: (transaction: Uint8Array) => Promise<Uint8Array>;
  /** What the panel adds once the transaction confirmed. */
  confirmed?: (slot: number) => ReactNode;
};

/** Waits for a sent transaction to confirm through the API, answering its slot. */
export const confirmTransaction = (signature: string, about: { market?: string; strategy?: string }) => postToApi("/v1/transactions", { signature, ...about }, TransactionReport);

export function TransactionReview<P extends Prepared>(props: ReviewProps<P>) {
  const { review, title } = props;
  const { account } = useWallet();
  return (
    <section className={box.review} aria-label={title} aria-live="polite">
      <h3 className={box.costsHeading}>{title}</h3>
      {review.status === "building" && <p>{review.rebuilt ? "Building it again, since the first build had grown too old to land, and simulating it." : props.building}</p>}
      {review.status === "error" && (
        <div role="alert" className={box.failedSim}>
          <p>{review.failure ? "It could not be built, so there is nothing to sign." : "It could not be built."}</p>
          <p className={box.decoded}>{review.message}</p>
          {review.failure && <code className={box.raw}>{review.failure.raw}</code>}
          <LogTail logs={review.logs} />
          <div className={box.reviewActions}>
            <button type="button" onClick={props.onBack}>
              Back
            </button>
          </div>
        </div>
      )}
      {review.status === "failed" && <Failed prepared={review.prepared} onBack={props.onBack} />}
      {(review.status === "ready" || review.status === "signing") && (
        <>
          {review.status === "ready" && review.rebuilt && <p className={box.note}>It was built and simulated again, since the first build had grown too old to land.</p>}
          <Changes prepared={review.prepared} mintOf={props.mintOf} />
          {review.status === "ready" && review.walletNote && (
            <p className={box.note} role="status">
              {review.walletNote}
            </p>
          )}
          {account ? <SignControls {...props} account={account} prepared={review.prepared} at={review.at} signing={review.status === "signing"} /> : <p role="alert">Connect your wallet again to sign.</p>}
        </>
      )}
      {(review.status === "sent" || review.status === "confirmed" || review.status === "unsettled") && (
        <>
          <p>{review.status === "sent" ? "Sent. Waiting for the chain to confirm it." : review.status === "confirmed" ? `Confirmed in slot ${formatInteger(review.slot)}.` : review.message}</p>
          {review.status === "unsettled" && review.failure && <code className={box.raw}>{review.failure.raw}</code>}
          <p>
            <a href={EXPLORER.transaction(review.signature)} target="_blank" rel="noreferrer">
              Transaction <code>{shortAddress(review.signature)}</code> on the explorer
            </a>
          </p>
          {review.status === "confirmed" && props.confirmed?.(review.slot)}
          {review.status !== "sent" && (
            <div className={box.reviewActions}>
              <button type="button" onClick={props.onBack}>
                Done
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** An amount in a mint, written in its tokens when its decimals are known. */
function Amount({ raw, mint, mintOf }: { raw: bigint; mint: string | null; mintOf: ReviewProps<Prepared>["mintOf"] }) {
  if (mint === null) return <>{formatTokenAmount(raw, SOL_DECIMALS)} SOL</>;
  const known = mintOf(mint);
  return (
    <>
      {known?.decimals != null ? formatTokenAmount(raw, known.decimals) : `${raw} of its smallest units`} <MintLabel mint={mint} symbol={known?.symbol ?? null} token={known?.token ?? null} />
    </>
  );
}

/** What the simulation used and what signing would change in the wallet. */
function Changes({ prepared, mintOf }: { prepared: Prepared; mintOf: ReviewProps<Prepared>["mintOf"] }) {
  const sim = prepared.simulation;
  const rent = sim.new_accounts.reduce((n, a) => n + BigInt(a.rent), 0n);
  const wrapped = BigInt(prepared.wrapped_sol);
  return (
    <>
      <p>
        The simulation went through.{sim.compute_units === null ? "" : ` It used ${formatInteger(sim.compute_units)} compute units.`} This is what signing would change in your wallet:
      </p>
      <dl className={box.rows}>
        {sim.changes.map((change) => {
          const delta = BigInt(change.after) - BigInt(change.before);
          return (
            <div key={change.account}>
              <dt>{change.mint === null ? "SOL, with the network fee and any rent" : <MintLabel mint={change.mint} symbol={mintOf(change.mint)?.symbol ?? null} token={mintOf(change.mint)?.token ?? null} />}</dt>
              <dd>
                {delta === 0n ? (
                  "no change"
                ) : (
                  <>
                    {delta < 0n ? "leaves " : "arrives "}
                    <Amount raw={delta < 0n ? -delta : delta} mint={change.mint} mintOf={mintOf} />
                  </>
                )}
              </dd>
            </div>
          );
        })}
        <div>
          <dt>Network fee</dt>
          <dd>{formatTokenAmount(BigInt(sim.network_fee), SOL_DECIMALS)} SOL</dd>
        </div>
        {rent > 0n && (
          <div>
            <dt>{sim.new_accounts.length === 1 ? "Rent for a new token account" : `Rent for ${sim.new_accounts.length} new token accounts`}</dt>
            <dd>{formatTokenAmount(rent, SOL_DECIMALS)} SOL</dd>
          </div>
        )}
      </dl>
      {wrapped > 0n && <p className={box.note}>{formatTokenAmount(wrapped, SOL_DECIMALS)} SOL is wrapped for it, and what is left is unwrapped after it, in the same transaction.</p>}
      <details className={styles.disclosure}>
        <summary>The accounts, as built</summary>
        <ul className={styles.resolved}>
          {prepared.accounts.map((a, i) => (
            <li key={`${i}-${a.address}`}>
              <ShortAddress address={a.address} />
              {a.writable ? ", can change it" : ""}
              {a.signer ? ", signs" : ""}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function Failed({ prepared, onBack }: { prepared: Prepared; onBack: () => void }) {
  const failure = prepared.simulation.failure;
  return (
    <div role="alert" className={box.failedSim}>
      <p>The simulation failed, so there is nothing to sign.</p>
      {failure && (
        <>
          <p className={box.decoded}>{failure.sentence}</p>
          <code className={box.raw}>{failure.raw}</code>
        </>
      )}
      <LogTail logs={prepared.simulation.logs} />
      <p className={box.note}>The sign button stays off while the simulation fails.</p>
      <div className={box.reviewActions}>
        <button type="button" className={box.primary} disabled>
          Sign in wallet
        </button>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

function LogTail({ logs }: { logs: readonly string[] }) {
  const tail = logs.slice(-FAILED_SIMULATION_LOG_LINES);
  if (!tail.length) return null;
  return (
    <details className={box.logs}>
      <summary>The program&apos;s last {tail.length === 1 ? "log line" : `${tail.length} log lines`}</summary>
      <pre>{tail.join("\n")}</pre>
    </details>
  );
}

function SignControls<P extends Prepared>({ account, prepared, at, signing, onBack, onRebuild, onSigning, onSent, onDeclined, presign }: ReviewProps<P> & { account: UiWalletAccount; prepared: P; at: number; signing: boolean }) {
  const { chain } = useWallet();
  const signAndSend = useSignAndSendTransaction(account, chain);
  const sign = async () => {
    // A blockhash lasts about a minute: an older build is made and simulated again before the wallet is asked.
    if (Date.now() - at > PREPARED_SWAP_MAX_AGE_MS) return onRebuild();
    onSigning();
    let signature: string;
    try {
      let transaction = new Uint8Array(getBase64Encoder().encode(prepared.transaction!));
      if (presign) transaction = new Uint8Array(await presign(transaction));
      const { signature: bytes } = await signAndSend({ transaction });
      signature = getBase58Decoder().decode(bytes);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      onDeclined(/reject|declin|cancel|denied/i.test(message) ? "Your wallet did not sign it, so nothing was sent and nothing has changed." : `Your wallet did not send it: ${message}`);
      return;
    }
    onSent(prepared, signature);
  };
  return (
    <>
      <div className={box.reviewActions}>
        <button type="button" className={box.primary} onClick={() => void sign()} disabled={signing}>
          {signing ? "Waiting for your wallet" : "Sign in wallet"}
        </button>
        <button type="button" onClick={onBack} disabled={signing}>
          Back
        </button>
      </div>
      <p className={box.note}>Signed in your own wallet. {BRAND.name} never holds your keys.</p>
    </>
  );
}
