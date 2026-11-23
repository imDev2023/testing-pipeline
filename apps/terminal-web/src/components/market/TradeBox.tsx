"use client";

// The trade box (docs/spec/pipescope-screens.md, Trade box, The amount typed, Review and sign;
// docs/spec/pipescope.md, Trading and How the fee is shown before signing). From top to bottom: what
// the trader pays, fees included, with their balance and "Use it all"; Switch the two sides; what they
// receive, expected; the slippage they accept; what the swap costs, always open; the button; and the
// closing line. Asking to swap opens the review, which builds and simulates the swap exactly as it
// would be signed, shows what signing would change in the wallet, and only then turns on "Sign in
// wallet". After the wallet signs and sends, the API reads the trade back (the fast path) and it
// joins Trades. Every rate shown is the API's; every number the box uses is the screens' config's.
import { useSignAndSendTransaction } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import { getBase58Decoder, getBase64Encoder } from "@solana/kit";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Balances, Fees, PreparedSwap, Quote, TradeReport, type Failure, type Market, type Trade } from "terminal-api/contract";
import { ApiFailure, getFromApi, postToApi } from "@/api";
import { BRAND } from "@/brand";
import { DEFAULT_SLIPPAGE_PERCENT, EXPLORER, FAILED_SIMULATION_LOG_LINES, PREPARED_SWAP_MAX_AGE_MS, QUOTE_PAUSE_MS, SLIPPAGE_CHOICES_PERCENT } from "@/config";
import { formatInteger, formatTokenAmount, shortAddress } from "@/format";
import { formatBps, parseAmount, parseSlippage, tradeButton, useItAll, writeAmount } from "@/trade";
import { MintLabel } from "../MintLabel";
import { useWallet, type SolanaChain } from "../wallet/WalletProvider";
import styles from "./TradeBox.module.css";

const WSOL = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;

type QuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; quote: Quote }
  | { status: "refused"; failure: Failure; logs: readonly string[] }
  | { status: "failed"; message: string };

type Review =
  | { status: "building"; rebuilt: boolean }
  | { status: "ready"; prepared: PreparedSwap; at: number; rebuilt: boolean; walletNote: string | null }
  | { status: "failed"; prepared: PreparedSwap }
  | { status: "error"; message: string }
  | { status: "signing"; prepared: PreparedSwap; at: number }
  | { status: "sent"; prepared: PreparedSwap; signature: string }
  | { status: "confirmed"; prepared: PreparedSwap; signature: string; slot: number }
  | { status: "unsettled"; prepared: PreparedSwap; signature: string; message: string; failure: Failure | null };

const failureOf = (e: unknown) => (e instanceof ApiFailure ? e.message : "Something went wrong on this page.");
/** A decoded sentence continued after a colon: "No quote: the strategy refused it: ...". */
const continued = (sentence: string) => (/^(The|It|Your) /.test(sentence) ? sentence[0]!.toLowerCase() + sentence.slice(1) : sentence);

export function TradeBox({ market, onTraded }: { market: Market; onTraded: (trades: Trade[]) => void }) {
  const ids = useId();
  const { account, chain, openMenu } = useWallet();
  const mintOf = useCallback((address: string) => market.mints.find((m) => m.mint === address)!, [market.mints]);
  const label = (address: string) => mintOf(address).symbol ?? shortAddress(address);
  const decimalsOf = (address: string) => mintOf(address).decimals;

  // The box opens paying the quote mint and receiving the base mint.
  const [pay, setPay] = useState(market.quote_mint);
  const [receive, setReceive] = useState(market.base_mint);
  const [typed, setTyped] = useState("");
  const [slippageChoice, setSlippageChoice] = useState<number | "other">(DEFAULT_SLIPPAGE_PERCENT);
  const [slippageTyped, setSlippageTyped] = useState("");
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [review, setReview] = useState<Review | null>(null);
  const [fees, setFees] = useState<Fees | null>(null);
  const [balances, setBalances] = useState<Record<string, bigint> | null>(null);
  const [balancesAsked, setBalancesAsked] = useState(0);

  const payDecimals = decimalsOf(pay);
  const receiveDecimals = decimalsOf(receive);
  const amount = useMemo(() => (payDecimals === null ? ({ kind: "invalid", reason: "" } as const) : parseAmount(typed, payDecimals)), [typed, payDecimals]);
  const slippage = slippageChoice === "other" ? parseSlippage(slippageTyped) : ({ kind: "bps", value: Math.round(slippageChoice * 100) } as const);
  const slippageBps = slippage.kind === "bps" ? slippage.value : null;

  // The rates before any quote: the API's, never numbers written here.
  useEffect(() => {
    const controller = new AbortController();
    getFromApi("/v1/fees", Fees, { signal: controller.signal }).then(setFees, () => undefined);
    return () => controller.abort();
  }, []);

  // The connected wallet's balance in each of the market's mints, again after each swap.
  const trader = account?.address ?? null;
  useEffect(() => {
    if (!trader) return;
    const controller = new AbortController();
    getFromApi(`/v1/traders/${trader}/balances?mints=${market.mints.map((m) => m.mint).join(",")}`, Balances, { signal: controller.signal }).then(
      (answer) => setBalances(Object.fromEntries(answer.balances.map((b) => [b.mint, BigInt(b.amount)]))),
      () => !controller.signal.aborted && setBalances(null),
    );
    return () => controller.abort();
  }, [trader, market.mints, balancesAsked]);

  // A quote 350 ms after the last keystroke; an answer to an earlier amount is thrown away.
  const asked = useRef(0);
  const value = amount.kind === "amount" ? amount.value : null;
  useEffect(() => {
    const ask = ++asked.current;
    if (value === null) {
      setQuote({ status: "idle" });
      return;
    }
    setQuote({ status: "loading" });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ market: market.address, input_mint: pay, output_mint: receive, amount: String(value), ...(trader ? { trader } : {}) });
      getFromApi(`/v1/quote?${query}`, Quote, { signal: controller.signal }).then(
        (answer) => ask === asked.current && setQuote({ status: "ready", quote: answer }),
        (e: unknown) => {
          if (ask !== asked.current || controller.signal.aborted) return;
          setQuote(e instanceof ApiFailure && e.failure ? { status: "refused", failure: e.failure, logs: e.logs } : { status: "failed", message: failureOf(e) });
        },
      );
    }, QUOTE_PAUSE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [market.address, pay, receive, value, trader]);

  // Changing the amount, a mint or the slippage leaves the review and asks for a new quote.
  const leaveReview = () => setReview(null);
  const choosePay = (mint: string) => {
    leaveReview();
    if (mint === receive) setReceive(pay);
    setPay(mint);
    setTyped("");
  };
  const chooseReceive = (mint: string) => {
    leaveReview();
    if (mint === pay) {
      setPay(receive);
      setTyped("");
    }
    setReceive(mint);
  };
  const switchSides = () => {
    leaveReview();
    setPay(receive);
    setReceive(pay);
    setTyped("");
  };

  const button = tradeButton({ connected: Boolean(account), amount: amount.kind, quote: quote.status === "loading" ? "loading" : quote.status === "ready" ? "ready" : "none", noticeUnticked: false });

  const build = useCallback(
    async (rebuilt: boolean) => {
      if (!trader || value === null || slippageBps === null) return;
      setReview({ status: "building", rebuilt });
      try {
        const prepared = await postToApi("/v1/swaps/prepare", { market: market.address, input_mint: pay, output_mint: receive, amount: String(value), slippage_bps: slippageBps, trader }, PreparedSwap);
        setReview(prepared.simulation.ok && prepared.transaction ? { status: "ready", prepared, at: Date.now(), rebuilt, walletNote: null } : { status: "failed", prepared });
      } catch (e) {
        setReview({ status: "error", message: failureOf(e) });
      }
    },
    [trader, value, slippageBps, market.address, pay, receive],
  );

  const settle = useCallback(
    async (prepared: PreparedSwap, signature: string) => {
      setReview({ status: "sent", prepared, signature });
      try {
        const report = await postToApi("/v1/trades", { signature, market: market.address }, TradeReport);
        onTraded(report.trades);
        setReview({ status: "confirmed", prepared, signature, slot: report.slot });
      } catch (e) {
        setReview({ status: "unsettled", prepared, signature, message: failureOf(e), failure: e instanceof ApiFailure ? e.failure : null });
      }
      setBalancesAsked((n) => n + 1);
    },
    [market.address, onTraded],
  );

  const symbolOfPay = label(pay);
  const balance = balances?.[pay] ?? null;
  const showsBreakdown = review === null;

  return (
    <section className={styles.box} aria-labelledby={`${ids}-heading`}>
      <h2 id={`${ids}-heading`} className={styles.srOnly}>
        Swap
      </h2>

      {/* 1. You pay, fees included */}
      <div className={styles.side}>
        <label className={styles.sideLabel} htmlFor={`${ids}-pay`}>
          You pay, fees included
        </label>
        <div className={styles.field}>
          <input
            id={`${ids}-pay`}
            className={styles.amount}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={typed}
            aria-describedby={`${ids}-pay-note`}
            onChange={(e) => {
              leaveReview();
              setTyped(e.target.value);
            }}
          />
          <MintSelect id={`${ids}-pay-mint`} label="Mint to pay with" value={pay} market={market} onChange={choosePay} />
        </div>
        <p id={`${ids}-pay-note`} className={styles.under}>
          {amount.kind === "invalid" && amount.reason ? (
            <span role="alert">{amount.reason}</span>
          ) : account && balance !== null && payDecimals !== null ? (
            <>
              <span>
                Balance {formatTokenAmount(balance, payDecimals)} {symbolOfPay}
              </span>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  leaveReview();
                  setTyped(writeAmount(useItAll(balance, { isSol: pay === WSOL }), payDecimals));
                }}
              >
                Use it all
              </button>
            </>
          ) : null}
        </p>
      </div>

      {/* 2. Switch the two sides */}
      <button type="button" className={styles.switch} onClick={switchSides}>
        Switch the two sides
      </button>

      {/* 3. You receive, expected */}
      <div className={styles.side}>
        <span className={styles.sideLabel} id={`${ids}-receive-label`}>
          You receive, expected
        </span>
        <div className={styles.field}>
          <output className={styles.amount} aria-labelledby={`${ids}-receive-label`} aria-live="polite">
            {quote.status === "ready" && receiveDecimals !== null ? formatTokenAmount(BigInt(quote.quote.expected_out), receiveDecimals) : quote.status === "loading" ? "…" : "0"}
          </output>
          <MintSelect id={`${ids}-receive-mint`} label="Mint to receive" value={receive} market={market} onChange={chooseReceive} />
        </div>
        {quote.status === "refused" && (
          <div className={styles.refused} role="alert">
            <p>No quote: {continued(quote.failure.sentence)}</p>
            <code className={styles.raw}>{quote.failure.raw}</code>
            <LogTail logs={quote.logs} />
          </div>
        )}
        {quote.status === "failed" && (
          <p className={styles.refused} role="alert">
            No quote: {quote.message}
          </p>
        )}
      </div>

      {/* 4. Slippage you accept */}
      <fieldset className={styles.slippage}>
        <legend className={styles.sideLabel}>Slippage you accept</legend>
        <div className={styles.choices}>
          {SLIPPAGE_CHOICES_PERCENT.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={slippageChoice === choice}
              onClick={() => {
                leaveReview();
                setSlippageChoice(choice);
              }}
            >
              {choice}%
            </button>
          ))}
          <label className={styles.other}>
            <span className={styles.srOnly}>Another slippage, in percent</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="Other"
              value={slippageTyped}
              data-chosen={slippageChoice === "other" || undefined}
              onFocus={() => setSlippageChoice("other")}
              onChange={(e) => {
                leaveReview();
                setSlippageChoice("other");
                setSlippageTyped(e.target.value);
              }}
            />
            <span aria-hidden="true">%</span>
          </label>
        </div>
        {slippage.kind === "invalid" && slippageChoice === "other" && slippageTyped !== "" && (
          <p className={styles.under} role="alert">
            {slippage.reason}
          </p>
        )}
      </fieldset>

      {/* 5. What this swap costs, always open; the review takes its place */}
      {showsBreakdown ? (
        <Breakdown market={market} pay={pay} receive={receive} quote={quote.status === "ready" ? quote.quote : null} fees={fees} slippageBps={slippageBps} />
      ) : (
        <ReviewPanel
          review={review}
          market={market}
          account={account}
          chain={chain}
          onBack={leaveReview}
          onRebuild={() => void build(true)}
          onSent={(prepared, signature) => void settle(prepared, signature)}
          onDeclined={(note) => setReview((r) => (r && (r.status === "signing" || r.status === "ready") ? { status: "ready", prepared: r.prepared, at: r.at, rebuilt: false, walletNote: note } : r))}
          onSigning={() => setReview((r) => (r && r.status === "ready" ? { status: "signing", prepared: r.prepared, at: r.at } : r))}
          onAgain={() => {
            setReview(null);
            setTyped("");
          }}
        />
      )}

      {/* 7. The button, while the breakdown shows */}
      {showsBreakdown && (
        <div className={styles.action}>
          <button
            type="button"
            className={styles.primary}
            disabled={button.action === null}
            aria-describedby={button.reason ? `${ids}-reason` : undefined}
            onClick={() => (button.action === "connect" ? openMenu() : void build(false))}
          >
            {button.label}
          </button>
          {button.reason && (
            <p id={`${ids}-reason`} className={styles.under}>
              {button.reason}
            </p>
          )}
        </div>
      )}

      {/* 8. The closing line */}
      <p className={styles.closing}>One market, one hop, exact in. Every swap is simulated before your wallet is asked to sign. Devnet tokens have no value.</p>
    </section>
  );
}

function MintSelect({ id, label, value, market, onChange }: { id: string; label: string; value: string; market: Market; onChange: (mint: string) => void }) {
  return (
    <>
      <label htmlFor={id} className={styles.srOnly}>
        {label}
      </label>
      <select id={id} className={styles.mint} value={value} onChange={(e) => onChange(e.target.value)}>
        {market.mints.map((m) => (
          <option key={m.mint} value={m.mint}>
            {m.symbol ?? shortAddress(m.mint)}
          </option>
        ))}
      </select>
    </>
  );
}

/** One amount in a mint, as the box writes it: four significant figures and the mint's name. */
function Amount({ raw, mint, market }: { raw: string; mint: string; market: Market }) {
  const held = market.mints.find((m) => m.mint === mint)!;
  return (
    <>
      {held.decimals === null ? raw : formatTokenAmount(BigInt(raw), held.decimals)} <MintLabel mint={mint} symbol={held.symbol} />
    </>
  );
}

function Breakdown({ market, pay, receive, quote, fees, slippageBps }: { market: Market; pay: string; receive: string; quote: Quote | null; fees: Fees | null; slippageBps: number | null }) {
  const pipelineBps = quote?.pipeline_fee_bps ?? fees?.pipeline_fee_bps ?? null;
  const feeMints = fees?.fee_mints ?? [];
  const charged = quote ? quote.integrator_fee_bps > 0 : feeMints.some((m) => m.mint === pay);
  const integratorBps = quote?.integrator_fee_bps ?? fees?.integrator_fee_bps ?? null;
  const intoFeeMint = quote ? quote.fee_side === "output" : market.fee_mint === receive;
  const minimum = quote && slippageBps !== null ? (BigInt(quote.expected_out) * BigInt(10_000 - slippageBps)) / 10_000n : null;
  const none = <span className={styles.none}>none yet</span>;
  const feeMintNames = feeMints.map((m) => m.symbol).join(" or ");
  return (
    <section className={styles.costs} aria-label="What this swap costs">
      <h3 className={styles.costsHeading}>What this swap costs</h3>
      <dl className={styles.rows}>
        <div>
          <dt>Goes into the market</dt>
          <dd>{quote ? <Amount raw={quote.net_sent} mint={pay} market={market} /> : none}</dd>
        </div>
        <div>
          <dt>
            Pipeline fee{pipelineBps === null ? "" : `, ${formatBps(pipelineBps)}`}
            <span className={styles.rowNote}>{intoFeeMint ? "of what arrives" : "of what goes into the market"}</span>
          </dt>
          <dd>{quote ? <Amount raw={quote.pipeline_fee} mint={quote.pipeline_fee_mint} market={market} /> : none}</dd>
        </div>
        {charged ? (
          <div>
            <dt>
              {BRAND.feeLabel}
              {integratorBps === null ? "" : `, ${formatBps(integratorBps)}`}
            </dt>
            <dd>{quote ? <Amount raw={quote.integrator_fee} mint={pay} market={market} /> : none}</dd>
          </div>
        ) : (
          <div className={styles.wide}>
            <dt>
              {BRAND.feeLabel}, none on this swap{feeMintNames ? `: only charged when you pay in ${feeMintNames}` : ""}
            </dt>
          </div>
        )}
        <div>
          <dt>The strategy&apos;s own fees and taxes</dt>
          <dd>included in the quote</dd>
        </div>
        <div className={styles.total}>
          <dt>Leaves your wallet</dt>
          <dd>{quote ? <Amount raw={quote.total_spend} mint={pay} market={market} /> : none}</dd>
        </div>
        <div>
          <dt>Expected output</dt>
          <dd>{quote ? <Amount raw={quote.expected_out} mint={receive} market={market} /> : none}</dd>
        </div>
        <div>
          <dt>Minimum received{slippageBps === null ? "" : `, after ${formatBps(slippageBps)} slippage`}</dt>
          <dd>{minimum !== null ? <Amount raw={String(minimum)} mint={receive} market={market} /> : none}</dd>
        </div>
      </dl>
    </section>
  );
}

type ReviewProps = {
  review: Review | null;
  market: Market;
  account: UiWalletAccount | null;
  chain: SolanaChain;
  onBack: () => void;
  onRebuild: () => void;
  onSigning: () => void;
  onSent: (prepared: PreparedSwap, signature: string) => void;
  onDeclined: (note: string) => void;
  onAgain: () => void;
};

function ReviewPanel(props: ReviewProps) {
  const { review, market } = props;
  if (!review) return null;
  return (
    <section className={styles.review} aria-labelledby="review-heading" aria-live="polite">
      <h3 id="review-heading" className={styles.costsHeading}>
        Review this swap
      </h3>
      {review.status === "building" && <p>{review.rebuilt ? "Building the swap again, since the first build had grown too old to land, and simulating it." : "Building the swap and simulating it, exactly as it would be signed."}</p>}
      {review.status === "error" && (
        <>
          <p role="alert">The swap could not be built. {review.message}</p>
          <div className={styles.reviewActions}>
            <button type="button" onClick={props.onBack}>
              Back
            </button>
          </div>
        </>
      )}
      {review.status === "failed" && <FailedSimulation prepared={review.prepared} onBack={props.onBack} />}
      {(review.status === "ready" || review.status === "signing") && (
        <>
          {review.status === "ready" && review.rebuilt && <p className={styles.note}>The swap was built and simulated again, since the first build had grown too old to land.</p>}
          <Changes prepared={review.prepared} market={market} />
          {review.status === "ready" && review.walletNote && (
            <p className={styles.note} role="status">
              {review.walletNote}
            </p>
          )}
          {props.account ? (
            <SignControls {...props} account={props.account} prepared={review.prepared} at={review.at} signing={review.status === "signing"} />
          ) : (
            <p role="alert">Connect your wallet again to sign.</p>
          )}
        </>
      )}
      {(review.status === "sent" || review.status === "confirmed" || review.status === "unsettled") && (
        <>
          <p>
            {review.status === "sent" ? "Sent. Waiting for the chain to confirm it." : review.status === "confirmed" ? `Confirmed in slot ${formatInteger(review.slot)}. The trade is at the top of Trades.` : review.message}
          </p>
          {review.status === "unsettled" && review.failure && <code className={styles.raw}>{review.failure.raw}</code>}
          <p>
            <a href={EXPLORER.transaction(review.signature)} target="_blank" rel="noreferrer">
              Transaction <code>{shortAddress(review.signature)}</code> on the explorer
            </a>
          </p>
          {review.status !== "sent" && (
            <div className={styles.reviewActions}>
              <button type="button" onClick={props.onAgain}>
                Make another swap
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Step 2: what the simulation used and what signing would change in the wallet. */
function Changes({ prepared, market }: { prepared: PreparedSwap; market: Market }) {
  const { simulation: sim, quote } = prepared;
  const rent = sim.new_accounts.reduce((n, a) => n + BigInt(a.rent), 0n);
  return (
    <>
      <p>
        The simulation went through.{sim.compute_units === null ? "" : ` It used ${formatInteger(sim.compute_units)} compute units.`} This is what signing would change in your wallet:
      </p>
      <dl className={styles.rows}>
        <div>
          <dt>Leaves</dt>
          <dd>
            <Amount raw={sim.paid ?? quote.total_spend} mint={quote.input_mint} market={market} />
          </dd>
        </div>
        <div>
          <dt>Arrives, expected</dt>
          <dd>
            <Amount raw={sim.received ?? quote.expected_out} mint={quote.output_mint} market={market} />
          </dd>
        </div>
        <div>
          <dt>Arrives, at least</dt>
          <dd>
            <Amount raw={prepared.min_amount_out} mint={quote.output_mint} market={market} />
          </dd>
        </div>
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
    </>
  );
}

/** Step 4: the failure decoded, its log behind a disclosure, and no way to sign. */
function FailedSimulation({ prepared, onBack }: { prepared: PreparedSwap; onBack: () => void }) {
  const failure = prepared.simulation.failure;
  return (
    <div role="alert" className={styles.failedSim}>
      <p>The simulation failed, so there is nothing to sign.</p>
      {failure && (
        <>
          <p className={styles.decoded}>{failure.sentence}</p>
          <code className={styles.raw}>{failure.raw}</code>
        </>
      )}
      <LogTail logs={prepared.simulation.logs} />
      <p className={styles.note}>The sign button stays off while the simulation fails.</p>
      <div className={styles.reviewActions}>
        <button type="button" className={styles.primary} disabled>
          Sign in wallet
        </button>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

/** The last lines of a program's log behind a disclosure, as a failed simulation shows them. */
function LogTail({ logs }: { logs: readonly string[] }) {
  const tail = logs.slice(-FAILED_SIMULATION_LOG_LINES);
  if (!tail.length) return null;
  return (
    <details className={styles.logs}>
      <summary>The program&apos;s last {tail.length === 1 ? "log line" : `${tail.length} log lines`}</summary>
      <pre>{tail.join("\n")}</pre>
    </details>
  );
}

/** Step 3: Sign in wallet, beside Back. The wallet signs and sends; a decline returns here with nothing changed. */
function SignControls({
  account,
  chain,
  prepared,
  at,
  signing,
  onBack,
  onRebuild,
  onSigning,
  onSent,
  onDeclined,
}: ReviewProps & { account: UiWalletAccount; prepared: PreparedSwap; at: number; signing: boolean }) {
  const signAndSend = useSignAndSendTransaction(account, chain);
  const sign = async () => {
    // A blockhash lasts about a minute: an older build is made and simulated again before the wallet is asked.
    if (Date.now() - at > PREPARED_SWAP_MAX_AGE_MS) return onRebuild();
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
    onSent(prepared, signature);
  };
  return (
    <>
      <div className={styles.reviewActions}>
        <button type="button" className={styles.primary} onClick={() => void sign()} disabled={signing}>
          {signing ? "Waiting for your wallet" : "Sign in wallet"}
        </button>
        <button type="button" onClick={onBack} disabled={signing}>
          Back
        </button>
      </div>
      <p className={styles.note}>Signed in your own wallet. {BRAND.name} never holds your keys.</p>
    </>
  );
}
