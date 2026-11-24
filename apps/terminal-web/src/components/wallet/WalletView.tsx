"use client";

// The wallet page (docs/spec/pipescope-screens.md, Wallet page; docs/spec/pipescope.md, Pages; #122):
// without a wallet, one sentence and "Connect wallet"; with one, its head (the whole address with Copy
// and an explorer link, its SOL and "Disconnect"), the offer to unwrap its wrapped SOL, what it holds
// that trades on Pipeline with those markets and the count of tokens no market trades, and its swaps
// through Pipeline's router, newest first and paged, with their fees and transactions. Balances come
// through the API from RPC; swaps from Aviary's own trades. Every panel loads on its own.
import Link from "next/link";
import { useCallback, useState } from "react";
import { Fees, Holdings, TraderTradesPage, type MintName, type Trade } from "terminal-api/contract";
import { ApiFailure, getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { EXPLORER, TRADES_SHOWN } from "@/config";
import { formatAge, formatDate, formatInteger, formatTokenAmount, shortAddress } from "@/format";
import { ROUTES } from "@/routes";
import { ShortSignature, SubjectAddress } from "../Address";
import head from "../heads/Head.module.css";
import table from "../ListingTable.module.css";
import { MintLabel } from "../MintLabel";
import { PanelFrame, useLoad } from "../Panel";
import { Unwrap } from "./Unwrap";
import { useWallet } from "./WalletProvider";
import styles from "./WalletView.module.css";

const SOL_DECIMALS = 9;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function WalletView() {
  const { account, openMenu, disconnect } = useWallet();
  return (
    <div className={styles.page}>
      <header className={head.head}>
        <h1>Wallet</h1>
      </header>
      {account ? (
        // Keyed by the wallet, so another wallet never sees the first one's balances, swaps or unwrap.
        <Connected key={account.address} address={account.address} onDisconnect={() => void disconnect()} />
      ) : (
        <section className={styles.panel} aria-label="No wallet connected">
          <p>Connect a wallet to see what it holds that trades on Pipeline, and every swap it made through Pipeline&apos;s router.</p>
          <div>
            <button type="button" className={styles.primary} onClick={openMenu}>
              Connect wallet
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Connected({ address, onDisconnect }: { address: string; onDisconnect: () => void }) {
  const loadHoldings = useCallback((signal: AbortSignal) => getFromApi(`/v1/traders/${address}/holdings`, Holdings, { signal }), [address]);
  const holdings = useLoad(loadHoldings);
  /** The unwrap that last confirmed, said so once the balances are read again without it. */
  const [unwrapped, setUnwrapped] = useState<{ signature: string; slot: number } | null>(null);
  const { retry } = holdings;
  const confirmed = useCallback(
    (done: { signature: string; slot: number }) => {
      setUnwrapped(done);
      retry();
    },
    [retry],
  );
  const clearUnwrapped = useCallback(() => setUnwrapped(null), []);
  const held = holdings.state.status === "loaded" ? holdings.state.data : null;

  return (
    <>
      <section className={styles.walletHead} aria-label="This wallet">
        <SubjectAddress address={address} />
        <dl className={head.facts}>
          <div>
            <dt>SOL</dt>
            <dd>{held ? `${formatTokenAmount(BigInt(held.sol), SOL_DECIMALS)} SOL` : holdings.state.status === "failed" ? "not read" : "…"}</dd>
          </div>
        </dl>
        <div>
          <button type="button" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
      </section>

      {unwrapped && (
        <section className={styles.panel} aria-label="Unwrapped" role="status">
          <p>Your wrapped SOL is SOL again: confirmed in slot {formatInteger(unwrapped.slot)}.</p>
          <p>
            <a href={EXPLORER.transaction(unwrapped.signature)} target="_blank" rel="noreferrer">
              Transaction <code>{shortAddress(unwrapped.signature)}</code> on the explorer
            </a>
          </p>
        </section>
      )}
      {held?.wrapped_sol && (
        <Unwrap trader={address} wrapped={held.wrapped_sol.amount} accounts={held.wrapped_sol.accounts.length} onStart={clearUnwrapped} onConfirmed={confirmed} onReload={retry} />
      )}

      <PanelFrame title="What you hold that trades on Pipeline" what="what this wallet holds" state={holdings.state} retry={holdings.retry}>
        {(data) => <HoldingsTable holdings={data} />}
      </PanelFrame>

      <Swaps address={address} />
    </>
  );
}

const nameOf = (names: readonly MintName[], mint: string) => names.find((n) => n.mint === mint) ?? { mint, symbol: null, token: null, decimals: null };

function Label({ names, mint }: { names: readonly MintName[]; mint: string }) {
  const named = nameOf(names, mint);
  return <MintLabel mint={mint} symbol={named.symbol} token={named.token} />;
}

/** A market as a list names it: its pair, base first, linked to its page. */
function MarketLink({ names, market, base, quote }: { names: readonly MintName[]; market: string; base: string; quote: string }) {
  return (
    <Link href={ROUTES.market(market)} className={styles.marketLink}>
      <Label names={names} mint={base} /> / <Label names={names} mint={quote} />
    </Link>
  );
}

function HoldingsTable({ holdings }: { holdings: Holdings }) {
  const { holdings: rows, markets, mints, not_listed: notListed } = holdings;
  return (
    <>
      {rows.length === 0 ? (
        <p className={styles.note}>This wallet holds no token that a Pipeline market trades.</p>
      ) : (
        <table className={`${table.table} ${styles.holdings}`}>
          <caption className={styles.srOnly}>Tokens this wallet holds that trade on Pipeline, with their markets</caption>
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col" className={table.num}>
                Balance
              </th>
              <th scope="col">Markets</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.mint} className={styles.row}>
                <td>
                  <span className={table.label}>Token</span>
                  <MintLabel mint={h.mint} symbol={h.symbol} token={h.token} />
                </td>
                <td className={table.num}>
                  <span className={table.label}>Balance</span>
                  {formatTokenAmount(BigInt(h.amount), h.decimals)}
                </td>
                <td>
                  <span className={table.label}>Markets</span>
                  <ul className={styles.markets}>
                    {h.markets.map((address) => {
                      const pair = markets.find((m) => m.address === address)!;
                      return (
                        <li key={address}>
                          <MarketLink names={mints} market={address} base={pair.base_mint} quote={pair.quote_mint} />
                        </li>
                      );
                    })}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={styles.note}>
        {notListed > 0 && `${plural(notListed, "token", "tokens")} in this wallet ${notListed === 1 ? "is" : "are"} not listed because no Pipeline market trades ${notListed === 1 ? "it" : "them"}. `}
        Balances are in tokens; there are no dollar prices on devnet.
      </p>
    </>
  );
}

type Page = { trades: Trade[]; mints: MintName[]; next: string | null };

const swapsPath = (address: string, before?: string) => `/v1/traders/${address}/trades?limit=${TRADES_SHOWN}${before ? `&before=${encodeURIComponent(before)}` : ""}`;

function Swaps({ address }: { address: string }) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [page, fees] = await Promise.all([getFromApi(swapsPath(address), TraderTradesPage, { signal }), getFromApi("/v1/fees", Fees, { signal })]);
      return { page, fees };
    },
    [address],
  );
  const { state, retry } = useLoad(load);
  const [later, setLater] = useState<Page | null>(null);
  const [more, setMore] = useState<{ status: "idle" | "loading" } | { status: "failed"; message: string }>({ status: "idle" });
  const next = later ? later.next : state.status === "loaded" ? state.data.page.next : null;

  const loadEarlier = useCallback(async () => {
    if (!next) return;
    setMore({ status: "loading" });
    try {
      const page = await getFromApi(swapsPath(address, next), TraderTradesPage);
      setLater((had) => ({ trades: [...(had?.trades ?? []), ...page.trades], mints: [...(had?.mints ?? []), ...page.mints], next: page.next }));
      setMore({ status: "idle" });
    } catch (e) {
      setMore({ status: "failed", message: e instanceof ApiFailure ? e.message : "Something went wrong on this page." });
    }
  }, [address, next]);

  return (
    <PanelFrame title="Your swaps through Pipeline" what="this wallet's swaps" state={state} retry={retry}>
      {({ page, fees }) => {
        const trades = [...page.trades, ...(later?.trades ?? [])];
        const names = [...page.mints, ...(later?.mints ?? [])];
        // Aviary's integrator fee goes to the fee wallet's accounts; any other integrator is named as one.
        const ours = new Set([fees.fee_wallet, ...fees.fee_mints.map((m) => m.account)]);
        return (
          <>
            {trades.length === 0 ? (
              <p className={styles.note}>This wallet has made no swap through Pipeline&apos;s router.</p>
            ) : (
              <table className={`${table.table} ${styles.swaps}`}>
                <caption className={styles.srOnly}>This wallet&apos;s swaps through Pipeline, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Market</th>
                    <th scope="col" className={table.num}>
                      Paid
                    </th>
                    <th scope="col" className={table.num}>
                      Received
                    </th>
                    <th scope="col" className={table.num}>
                      Fees
                    </th>
                    <th scope="col">Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <SwapRow key={`${t.signature}:${t.event_index}`} trade={t} names={names} integratorName={t.integrator && ours.has(t.integrator) ? BRAND.name : "Integrator"} />
                  ))}
                </tbody>
              </table>
            )}
            {next && (
              <div className={styles.more}>
                <button type="button" onClick={loadEarlier} disabled={more.status === "loading"}>
                  {more.status === "loading" ? "Loading earlier swaps…" : "Show earlier swaps"}
                </button>
                {more.status === "failed" && (
                  <p role="alert" className={styles.note}>
                    Could not load earlier swaps. {more.message}
                  </p>
                )}
              </div>
            )}
            <p className={styles.note}>Every swap this wallet made through Pipeline&apos;s router, on {BRAND.name} or anywhere else. Trades that bypass the router leave no swap event and are not here.</p>
          </>
        );
      }}
    </PanelFrame>
  );
}

function SwapRow({ trade: t, names, integratorName }: { trade: Trade; names: readonly MintName[]; integratorName: string }) {
  const amount = (raw: string, mint: string) => {
    const decimals = nameOf(names, mint).decimals;
    return (
      <span className={styles.amount}>
        {decimals === null ? <span className={table.none}>not read</span> : formatTokenAmount(BigInt(raw), decimals)} <Label names={names} mint={mint} />
      </span>
    );
  };
  return (
    <tr className={styles.row}>
      <td>
        <span className={table.label}>When</span>
        {t.block_time ? (
          <time className={table.age} dateTime={t.block_time} title={formatDate(new Date(t.block_time))}>
            {formatAge(new Date(t.block_time))}
          </time>
        ) : (
          <span className={table.none}>not read</span>
        )}
      </td>
      <td>
        <span className={table.label}>Market</span>
        <MarketLink names={names} market={t.market} base={t.base_mint} quote={t.quote_mint} />
      </td>
      <td className={table.num}>
        <span className={table.label}>Paid</span>
        {amount(t.net_sent, t.input_mint)}
      </td>
      <td className={table.num}>
        <span className={table.label}>Received</span>
        {amount(t.received, t.output_mint)}
      </td>
      <td className={table.num}>
        <span className={table.label}>Fees</span>
        <span className={styles.fees}>
          <span>Pipeline {amount(t.pipeline_fee, t.fee_mint)}</span>
          {BigInt(t.integrator_fee) > 0n && (
            <span>
              {integratorName} {amount(t.integrator_fee, t.input_mint)}
            </span>
          )}
        </span>
      </td>
      <td>
        <span className={table.label}>Transaction</span>
        <ShortSignature signature={t.signature} />
      </td>
    </tr>
  );
}
