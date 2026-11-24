"use client";

// The unwrap offer on the wallet page (docs/spec/pipescope-screens.md, Wallet page, and Review and sign:
// "A custom action, creating a market and unwrapping SOL follow the same steps"; #122): the amount of
// wrapped SOL the wallet holds, which tax recipients are paid in (docs/spec/tax-amm.md), and "Unwrap",
// which builds and simulates closing the wallet's wrapped-SOL accounts, shows the SOL that would come
// back, and only then turns on "Sign in wallet". The wallet signs and sends; the API waits for it to
// confirm. Aviary holds no key.
import { useSignAndSendTransaction } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import { getBase58Decoder, getBase64Encoder } from "@solana/kit";
import { useCallback, useRef, useState } from "react";
import { Confirmation, PreparedUnwrap, type Failure } from "terminal-api/contract";
import { ApiFailure, postToApi } from "@/api";
import { BRAND } from "@/brand";
import { EXPLORER, PREPARED_TRANSACTION_MAX_AGE_MS } from "@/config";
import { formatInteger, formatTokenAmount, shortAddress } from "@/format";
import { LogTail } from "../LogTail";
import review from "../market/TradeBox.module.css";
import { useWallet, type SolanaChain } from "./WalletProvider";
import styles from "./WalletView.module.css";

const SOL_DECIMALS = 9;
const sol = (lamports: string | bigint) => `${formatTokenAmount(BigInt(lamports), SOL_DECIMALS)} SOL`;
const failureOf = (e: unknown) => (e instanceof ApiFailure ? e.message : "Something went wrong on this page.");

type Step =
  | { status: "offer" }
  | { status: "building"; rebuilt: boolean }
  | { status: "ready"; prepared: PreparedUnwrap; at: number; rebuilt: boolean; walletNote: string | null }
  | { status: "failed"; prepared: PreparedUnwrap }
  | { status: "error"; message: string }
  | { status: "signing"; prepared: PreparedUnwrap; at: number }
  | { status: "sent"; signature: string }
  | { status: "unsettled"; signature: string; message: string; failure: Failure | null };

export function Unwrap({ trader, wrapped, onConfirmed }: { trader: string; wrapped: string; onConfirmed: (done: { signature: string; slot: number }) => void }) {
  const { account, chain } = useWallet();
  const [step, setStep] = useState<Step>({ status: "offer" });
  // Each build is one generation: an answer for an earlier one (the trader went back meanwhile) is thrown away.
  const generation = useRef(0);

  const build = useCallback(
    async (rebuilt: boolean) => {
      const mine = ++generation.current;
      setStep({ status: "building", rebuilt });
      try {
        const prepared = await postToApi("/v1/unwrap/prepare", { trader }, PreparedUnwrap);
        if (mine !== generation.current) return;
        setStep(prepared.simulation.ok && prepared.transaction ? { status: "ready", prepared, at: Date.now(), rebuilt, walletNote: null } : { status: "failed", prepared });
      } catch (e) {
        if (mine === generation.current) setStep({ status: "error", message: failureOf(e) });
      }
    },
    [trader],
  );
  const back = () => {
    generation.current++;
    setStep({ status: "offer" });
  };
  const settle = useCallback(
    async (signature: string) => {
      setStep({ status: "sent", signature });
      try {
        const done = await postToApi("/v1/confirmations", { signature }, Confirmation);
        onConfirmed(done);
      } catch (e) {
        setStep({ status: "unsettled", signature, message: failureOf(e), failure: e instanceof ApiFailure ? e.failure : null });
      }
    },
    [onConfirmed],
  );

  return (
    <section className={styles.panel} aria-labelledby="unwrap-heading" aria-live="polite">
      <h2 id="unwrap-heading" className={styles.title}>
        Wrapped SOL
      </h2>
      {step.status === "offer" && (
        <>
          <p>
            This wallet holds {sol(wrapped)} as wrapped SOL, the form tax payouts arrive in. Unwrapping closes its wrapped SOL account and gives it back as SOL, with the
            account&apos;s rent.
          </p>
          <div>
            <button type="button" className={review.primary} onClick={() => void build(false)}>
              Unwrap
            </button>
          </div>
        </>
      )}
      {step.status !== "offer" && (
        <div className={`${review.review} ${styles.unwrapReview}`}>
          <h3 className={review.costsHeading}>Review this unwrap</h3>
          {step.status === "building" && (
            <p>{step.rebuilt ? "Building the unwrap again, since the first build had grown too old to land, and simulating it." : "Building the unwrap and simulating it, exactly as it would be signed."}</p>
          )}
          {step.status === "error" && (
            <>
              <p role="alert">The unwrap could not be built. {step.message}</p>
              <div className={review.reviewActions}>
                <button type="button" onClick={back}>
                  Back
                </button>
              </div>
            </>
          )}
          {step.status === "failed" && (
            <div role="alert" className={review.failedSim}>
              <p>The simulation failed, so there is nothing to sign.</p>
              {step.prepared.simulation.failure && (
                <>
                  <p className={review.decoded}>{step.prepared.simulation.failure.sentence}</p>
                  <code className={review.raw}>{step.prepared.simulation.failure.raw}</code>
                </>
              )}
              <LogTail logs={step.prepared.simulation.logs} />
              <p className={review.note}>The sign button stays off while the simulation fails.</p>
              <div className={review.reviewActions}>
                <button type="button" className={review.primary} disabled>
                  Sign in wallet
                </button>
                <button type="button" onClick={back}>
                  Back
                </button>
              </div>
            </div>
          )}
          {(step.status === "ready" || step.status === "signing") && (
            <>
              {step.status === "ready" && step.rebuilt && <p className={review.note}>The unwrap was built and simulated again, since the first build had grown too old to land.</p>}
              <Changes prepared={step.prepared} />
              {step.status === "ready" && step.walletNote && (
                <p className={review.note} role="status">
                  {step.walletNote}
                </p>
              )}
              {account ? (
                <Sign
                  account={account}
                  chain={chain}
                  prepared={step.prepared}
                  at={step.at}
                  signing={step.status === "signing"}
                  onBack={back}
                  onRebuild={() => void build(true)}
                  onSigning={() => setStep((s) => (s.status === "ready" ? { status: "signing", prepared: s.prepared, at: s.at } : s))}
                  onDeclined={(note) => setStep((s) => (s.status === "signing" || s.status === "ready" ? { status: "ready", prepared: s.prepared, at: s.at, rebuilt: false, walletNote: note } : s))}
                  onSent={(signature) => void settle(signature)}
                />
              ) : (
                <p role="alert">Connect your wallet again to sign.</p>
              )}
            </>
          )}
          {(step.status === "sent" || step.status === "unsettled") && (
            <>
              <p>{step.status === "sent" ? "Sent. Waiting for the chain to confirm it." : step.message}</p>
              {step.status === "unsettled" && step.failure && <code className={review.raw}>{step.failure.raw}</code>}
              <p>
                <a href={EXPLORER.transaction(step.signature)} target="_blank" rel="noreferrer">
                  Transaction <code>{shortAddress(step.signature)}</code> on the explorer
                </a>
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** What the simulation used and what signing would change in the wallet. */
function Changes({ prepared }: { prepared: PreparedUnwrap }) {
  const { simulation: sim } = prepared;
  return (
    <>
      <p>
        The simulation went through.{sim.compute_units === null ? "" : ` It used ${formatInteger(sim.compute_units)} compute units.`} This is what signing would change in your wallet:
      </p>
      <dl className={review.rows}>
        <div>
          <dt>Wrapped SOL unwrapped</dt>
          <dd>{sol(prepared.wrapped)}</dd>
        </div>
        <div>
          <dt>Comes back as SOL, with the rent</dt>
          <dd>{sol(sim.returned ?? "0")}</dd>
        </div>
        <div>
          <dt>Network fee</dt>
          <dd>{sol(sim.network_fee)}</dd>
        </div>
      </dl>
    </>
  );
}

type SignProps = {
  account: UiWalletAccount;
  chain: SolanaChain;
  prepared: PreparedUnwrap;
  at: number;
  signing: boolean;
  onBack: () => void;
  onRebuild: () => void;
  onSigning: () => void;
  onDeclined: (note: string) => void;
  onSent: (signature: string) => void;
};

/** Sign in wallet, beside Back. The wallet signs and sends; a decline returns here with nothing changed. */
function Sign({ account, chain, prepared, at, signing, onBack, onRebuild, onSigning, onDeclined, onSent }: SignProps) {
  const signAndSend = useSignAndSendTransaction(account, chain);
  const sign = async () => {
    // A blockhash lasts about a minute: an older build is made and simulated again before the wallet is asked.
    if (Date.now() - at > PREPARED_TRANSACTION_MAX_AGE_MS) return onRebuild();
    onSigning();
    let signature: string;
    try {
      const { signature: bytes } = await signAndSend({ transaction: new Uint8Array(getBase64Encoder().encode(prepared.transaction!)) });
      signature = getBase58Decoder().decode(bytes);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      onDeclined(/reject|declin|cancel|denied/i.test(message) ? "Your wallet did not sign it, so nothing was sent and nothing has changed." : `Your wallet did not send it: ${message}`);
      return;
    }
    onSent(signature);
  };
  return (
    <>
      <div className={review.reviewActions}>
        <button type="button" className={review.primary} onClick={() => void sign()} disabled={signing}>
          {signing ? "Waiting for your wallet" : "Sign in wallet"}
        </button>
        <button type="button" onClick={onBack} disabled={signing}>
          Back
        </button>
      </div>
      <p className={review.note}>Signed in your own wallet. {BRAND.name} never holds your keys.</p>
    </>
  );
}
