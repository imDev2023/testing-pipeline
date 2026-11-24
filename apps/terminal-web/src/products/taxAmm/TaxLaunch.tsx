"use client";

// The tax AMM's launch form on the create-market page (docs/spec/tax-amm.md, "In Aviary"; #75;
// PIPESCOPE-158): the token by its mint's address with its facts beneath, paired with SOL or USDC and
// taxed in it unless the creator chooses the token; the buy and sell tax with their ranges; the tax
// authority; the tax recipients, the burn and the seed. The whole split shows before signing, the suite
// share first. It builds `create_market`, both `init_fee_account` instructions and the seed as one
// transaction (PIPESCOPE-159), simulated before the wallet signs like every transaction Aviary builds,
// and a mint the program's mint rules refuse is refused there, with the rule it breaks.
import { address, generateKeyPairSigner, getTransactionDecoder, getTransactionEncoder, isAddress, partiallySignTransaction, type Address, type KeyPairSigner } from "@solana/kit";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AVIARY_MINT_NAMES, CLUSTER_USDC, WRAPPED_SOL } from "terminal-api/config";
import { MintFacts, PreparedMarket } from "terminal-api/contract";
import { getFromApi, postToApi } from "@/api";
import { TAX_LAUNCH_DEFAULTS } from "@/config";
import { formatTokenAmount } from "@/format";
import { MintFactList } from "@/components/facts/MarketFacts";
import { NewMarket } from "@/components/create/NewMarket";
import forms from "@/components/forms/Forms.module.css";
import { TransactionReview } from "@/components/forms/TransactionReview";
import { useReview } from "@/components/forms/useReview";
import { StaticPanel } from "@/components/Panel";
import { useWallet } from "@/components/wallet/WalletProvider";
import { launchRequest, MAX_RECIPIENTS, readLaunch, type LaunchValues } from "./launch";
import { mintRuleRefusal } from "./refusal";
import { SplitTable } from "./SplitTable";
import styles from "./TaxAmm.module.css";

/** SOL and the cluster's USDC, which Aviary names itself (terminal-api's config), with their mints' decimals. */
const QUOTES = {
  sol: { mint: address(WRAPPED_SOL), decimals: 9, name: AVIARY_MINT_NAMES[WRAPPED_SOL]! },
  usdc: { mint: address(CLUSTER_USDC), decimals: 6, name: AVIARY_MINT_NAMES[CLUSTER_USDC]! },
} as const;
const SOL_DECIMALS = 9;

type Read = { status: "loading" } | { status: "read"; facts: MintFacts } | { status: "failed"; message: string };

/** The token's mint, read once a whole address is typed, and again when asked. */
function useTokenFacts(typed: string): { read: Read | null; retry: () => void } {
  const [held, setHeld] = useState<{ mint: string; read: Read } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const mint = isAddress(typed) ? typed : null;
  useEffect(() => {
    if (!mint) return;
    const controller = new AbortController();
    getFromApi(`/v1/mints/${mint}`, MintFacts, { signal: controller.signal }).then(
      (facts) => setHeld({ mint, read: { status: "read", facts } }),
      (e: unknown) => !controller.signal.aborted && setHeld({ mint, read: { status: "failed", message: e instanceof Error ? e.message : String(e) } }),
    );
    return () => controller.abort();
  }, [mint, attempt]);
  return {
    read: mint && held?.mint === mint ? held.read : mint ? { status: "loading" } : null,
    retry: () => {
      setHeld(null);
      setAttempt((n) => n + 1);
    },
  };
}

export function TaxLaunch({ program }: { program: string }) {
  const id = useId();
  const { account, openMenu } = useWallet();
  const trader = (account?.address ?? null) as Address | null;
  const [typed, setTyped] = useState<LaunchValues>(() => ({ ...TAX_LAUNCH_DEFAULTS, recipients: [...TAX_LAUNCH_DEFAULTS.recipients] }));
  const [version, setVersion] = useState(0);
  const set = (change: Partial<LaunchValues>) => {
    setTyped((now) => ({ ...now, ...change }));
    setVersion((n) => n + 1);
  };
  // The first recipient is the connected wallet while its field is left empty; a market taxed in SOL has no burn share, whatever was typed before.
  const solTax = typed.taxedIn === "quote" && typed.quote === "sol";
  const values: LaunchValues = { ...typed, burnShare: solTax ? "0" : typed.burnShare, recipients: typed.recipients.map((r, i) => (i === 0 && r.wallet === "" && trader ? { ...r, wallet: trader } : r)) };

  const token = values.token.trim();
  const { read, retry } = useTokenFacts(token);
  const tokenFacts = read?.status === "read" && read.facts.readable ? read.facts : null;
  const quote = QUOTES[values.quote];
  const tokenSymbol = tokenFacts?.token?.symbol ?? tokenFacts?.token?.name ?? null;
  const tokenName = tokenSymbol ?? "the token";
  const taxName = values.taxedIn === "quote" ? quote.name : tokenName;

  const tokenProblem = read?.status === "failed" ? "Could not read the token's mint: read it again." : read?.status === "read" && (!read.facts.readable || read.facts.decimals === null) ? "The token's address is no mint." : null;
  const { launch, missing } = readLaunch(values, { wallet: trader, token: tokenFacts && tokenFacts.decimals !== null ? { mint: address(tokenFacts.mint), decimals: tokenFacts.decimals } : null, tokenProblem, quotes: QUOTES });

  // A new market state's keypair, made in the page for each review and never sent anywhere (PIPESCOPE-144).
  const state = useRef<KeyPairSigner | null>(null);
  // The launch is read again on every render, so preparing it is a plain function the review calls.
  const prepare = async () => {
    state.current = await generateKeyPairSigner();
    const request = await launchRequest(launch!, state.current.address);
    return postToApi("/v1/markets/prepare", { strategy: program, ...request, market_state: state.current.address, trader }, PreparedMarket);
  };
  const presign = useCallback(async (bytes: Uint8Array) => {
    if (!state.current) return bytes;
    const signed = await partiallySignTransaction([state.current.keyPair], getTransactionDecoder().decode(bytes));
    return new Uint8Array(getTransactionEncoder().encode(signed));
  }, []);
  const [created, setCreated] = useState<string | null>(null);
  const { review, start, handlers } = useReview({ prepare, about: { strategy: program }, version, trader, onConfirmed: (prepared) => setCreated(prepared.market) });
  const mintOf = (mint: string) =>
    mint === quote.mint ? { mint, symbol: quote.name, token: null, decimals: quote.decimals } : tokenFacts && mint === tokenFacts.mint ? { mint, symbol: null, token: tokenFacts.token, decimals: tokenFacts.decimals } : null;
  const refusal = review?.status === "failed" ? mintRuleRefusal(review.prepared.simulation.failure, review.prepared.simulation.logs, (mint) => (tokenFacts && mint === tokenFacts.mint ? (tokenFacts.token?.symbol ?? null) : null)) : null;

  const setRecipient = (i: number, change: Partial<LaunchValues["recipients"][number]>) => set({ recipients: typed.recipients.map((r, j) => (j === i ? { ...r, ...change } : r)) });

  return (
    <StaticPanel title="Launch a tax market">
      <div className={styles.launch}>
        <p className={forms.line}>
          The tax AMM&apos;s own launch form. It creates the market, its fee accounts and its seed in one transaction, so the market opens for trading as it is created. You sign it in your own wallet, after a simulation you see first; the
          liquidity you seed is locked for good. The strategy&apos;s create form below makes the market alone, which then waits for its seed.
        </p>

        <fieldset className={styles.group}>
          <legend className={styles.legend}>The token</legend>
          <div className={forms.field}>
            <label htmlFor={`${id}-token`}>Its mint, by address</label>
            <div className={forms.control}>
              <input id={`${id}-token`} type="text" autoComplete="off" spellCheck={false} value={values.token} onChange={(e) => set({ token: e.target.value })} />
            </div>
            {read?.status === "loading" && <p className={forms.note}>Reading this mint…</p>}
            {read?.status === "failed" && (
              <div className={forms.control} role="alert">
                <span className={forms.note}>Could not read this mint. {read.message}</span>
                <button type="button" onClick={retry}>
                  Read it again
                </button>
              </div>
            )}
            {read?.status === "read" &&
              (read.facts.readable ? (
                <div className={forms.facts} aria-label="The token's facts">
                  <MintFactList mint={read.facts} />
                </div>
              ) : (
                <p className={forms.reason} role="alert">
                  This address is no mint.
                </p>
              ))}
          </div>
          <Choice
            legend="Paired with"
            name={`${id}-quote`}
            value={values.quote}
            options={[
              ["sol", "SOL"],
              ["usdc", "USDC"],
            ]}
            onChange={(quote) => set({ quote })}
          />
          <Choice
            legend="Taxed in"
            name={`${id}-taxed`}
            value={values.taxedIn}
            options={[
              ["quote", `${quote.name}, so recipients are paid in ${quote.name}`],
              ["token", tokenSymbol ? `The token, ${tokenSymbol}` : "The token"],
            ]}
            onChange={(taxedIn) => set({ taxedIn })}
          />
        </fieldset>

        <fieldset className={styles.group}>
          <legend className={styles.legend}>Taxes</legend>
          <p className={forms.note}>
            Every tax is taken in {taxName}. Each rate stays between its lowest and highest for the market&apos;s life, and the tax authority can move it there, each change waiting about two minutes before it applies.
          </p>
          <Rate id={`${id}-buy`} label="Buy tax" what={`Taken when ${taxName} is paid in: when someone ${values.taxedIn === "quote" ? "buys the token" : `sells the token for ${quote.name}`}`} rate={values.buyTax} min={values.buyMin} max={values.buyMax} onChange={(rate, min, max) => set({ buyTax: rate, buyMin: min, buyMax: max })} />
          <Rate id={`${id}-sell`} label="Sell tax" what={`Taken when ${taxName} is paid out: when someone ${values.taxedIn === "quote" ? "sells the token" : `buys the token with ${quote.name}`}`} rate={values.sellTax} min={values.sellMin} max={values.sellMax} onChange={(rate, min, max) => set({ sellTax: rate, sellMin: min, sellMax: max })} />
          <Choice
            legend="Tax authority"
            name={`${id}-authority`}
            value={values.authority}
            options={[
              ["wallet", "Your wallet: it may change the taxes inside their ranges and the recipients, or renounce"],
              ["none", "None: the taxes and the recipients can never change"],
            ]}
            onChange={(authority) => set({ authority })}
          />
        </fieldset>

        <fieldset className={styles.group}>
          <legend className={styles.legend}>Where the tax goes</legend>
          <p className={forms.note}>Each recipient&apos;s share and the burn&apos;s are of what is left after the suite share, and add up to 100%.</p>
          {values.recipients.map((r, i) => (
            <div key={i} className={styles.recipient}>
              <label htmlFor={`${id}-recipient-${i}`}>Tax recipient {i + 1}</label>
              <div className={styles.recipientRow}>
                <div className={forms.control}>
                  <input id={`${id}-recipient-${i}`} type="text" autoComplete="off" spellCheck={false} value={r.wallet} onChange={(e) => setRecipient(i, { wallet: e.target.value })} />
                </div>
                <div className={`${forms.control} ${styles.percent}`}>
                  <input type="text" inputMode="decimal" autoComplete="off" aria-label={`Tax recipient ${i + 1}'s share, in percent`} value={r.share} onChange={(e) => setRecipient(i, { share: e.target.value })} />
                  <span aria-hidden="true">%</span>
                </div>
                <div className={styles.recipientActions}>
                  {trader && r.wallet.trim() !== trader && (
                    <button type="button" onClick={() => setRecipient(i, { wallet: trader })}>
                      Use your wallet
                    </button>
                  )}
                  {values.recipients.length > 1 && (
                    <button type="button" onClick={() => set({ recipients: typed.recipients.filter((_, j) => j !== i) })}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {values.recipients.length < MAX_RECIPIENTS && (
            <div>
              <button type="button" onClick={() => set({ recipients: [...typed.recipients, { wallet: "", share: "" }] })}>
                Add a recipient
              </button>
            </div>
          )}
          <div className={styles.recipient}>
            <label htmlFor={`${id}-burn`}>The burn&apos;s share</label>
            <div className={styles.recipientRow}>
              <p className={styles.note}>{solTax ? "SOL can't be burned, so a market taxed in SOL has no burn share." : `Burns its share of every tax, in ${taxName}.`}</p>
              <div className={`${forms.control} ${styles.percent}`}>
                <input id={`${id}-burn`} type="text" inputMode="decimal" autoComplete="off" value={values.burnShare} disabled={solTax} onChange={(e) => set({ burnShare: e.target.value })} />
                <span aria-hidden="true">%</span>
              </div>
            </div>
          </div>
          {launch ? <SplitTable split={launch.split} caption="The whole split of every tax, before you sign" /> : <p className={forms.note}>The whole split shows here once every field is filled.</p>}
        </fieldset>

        <fieldset className={styles.group}>
          <legend className={styles.legend}>The seed</legend>
          <p className={forms.note}>What you deposit, once, as the market&apos;s liquidity, locked for good. With a virtual reserve the {quote.name} side is priced as if it held that much more, which is never paid out, so you can seed the token alone.</p>
          <Amount id={`${id}-seed-token`} label={`Amount of ${tokenName}`} value={values.seedToken} onChange={(seedToken) => set({ seedToken })} />
          <Amount id={`${id}-seed-quote`} label={`Amount of ${quote.name}`} value={values.seedQuote} onChange={(seedQuote) => set({ seedQuote })} />
          <Amount id={`${id}-virtual`} label={`Virtual reserve of ${quote.name} (optional)`} value={values.virtualReserve} onChange={(virtualReserve) => set({ virtualReserve })} />
        </fieldset>

        {review ? (
          <>
            <TransactionReview
              title="Review the new tax market"
              building="Building the market, its fee accounts and its seed, and simulating them as one transaction, exactly as it would be signed."
              review={review}
              mintOf={mintOf}
              presign={presign}
              confirmed={() => (created ? <NewMarket market={created} /> : null)}
              {...handlers}
            />
            {refusal && (
              <p className={forms.reason} role="alert">
                {refusal}
              </p>
            )}
          </>
        ) : (
          <div className={forms.actions}>
            {account ? (
              <button type="button" className={forms.simulate} disabled={!launch} onClick={start} aria-describedby={launch ? undefined : `${id}-missing`}>
                Simulate the launch
              </button>
            ) : (
              <button type="button" className={forms.simulate} onClick={openMenu}>
                Connect wallet
              </button>
            )}
            {account && missing && (
              <span id={`${id}-missing`} className={forms.note}>
                {missing}
              </span>
            )}
          </div>
        )}
        {review?.status === "ready" && (
          <p className={forms.note}>
            The router lets the strategy&apos;s setup take at most {formatTokenAmount(BigInt(review.prepared.max_creator_lamports), SOL_DECIMALS)} SOL from your wallet for the market&apos;s accounts; the simulation above shows what it takes.
          </p>
        )}
      </div>
    </StaticPanel>
  );
}

/** One choice of a few, as radio buttons under its legend. */
function Choice<V extends string>({ legend, name, value, options, onChange }: { legend: string; name: string; value: V; options: readonly (readonly [V, string])[]; onChange: (value: V) => void }) {
  return (
    <fieldset className={styles.choice}>
      <legend className={styles.choiceLegend}>{legend}</legend>
      {options.map(([option, label]) => (
        <label key={option} className={styles.option}>
          <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
          <span>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** A tax's rate with its range, each in percent. */
function Rate({ id, label, what, rate, min, max, onChange }: { id: string; label: string; what: string; rate: string; min: string; max: string; onChange: (rate: string, min: string, max: string) => void }) {
  return (
    <div className={styles.rate}>
      <label htmlFor={id} className={styles.rateLabel}>
        {label}, in percent
      </label>
      <p className={`${forms.note} ${styles.rateWhat}`}>{what}.</p>
      <div className={styles.rateRow}>
        <div className={`${forms.control} ${styles.percent}`}>
          <input id={id} type="text" inputMode="decimal" autoComplete="off" value={rate} onChange={(e) => onChange(e.target.value, min, max)} />
          <span aria-hidden="true">%</span>
        </div>
        <div className={styles.range}>
          <span>between</span>
          <div className={`${forms.control} ${styles.percent}`}>
            <input type="text" inputMode="decimal" autoComplete="off" aria-label={`${label}'s lowest rate, in percent`} value={min} onChange={(e) => onChange(rate, e.target.value, max)} />
            <span aria-hidden="true">%</span>
          </div>
          <span>and</span>
          <div className={`${forms.control} ${styles.percent}`}>
            <input type="text" inputMode="decimal" autoComplete="off" aria-label={`${label}'s highest rate, in percent`} value={max} onChange={(e) => onChange(rate, min, e.target.value)} />
            <span aria-hidden="true">%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** An amount typed in a mint's tokens. */
function Amount({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className={forms.field}>
      <label htmlFor={id}>{label}</label>
      <div className={forms.control}>
        <input id={id} type="text" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}
