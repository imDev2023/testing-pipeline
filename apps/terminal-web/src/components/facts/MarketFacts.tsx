"use client";

// The market page's facts panel (docs/spec/pipescope-screens.md, "Explanation, actions and facts";
// PIPESCOPE-16): under the line that says what it is, the parts of Aviary's own reading, "This
// market", "Its strategy" and "Its mints", each worded as Pipeline's SDK words its trust flags. No
// score and no verdict. "What Canary saw" is its first part, across the panel's width, from the
// results the page read with it (#125).
import { Fragment, useCallback } from "react";
import { MarketFacts as MarketFactsAnswer, type MintFacts } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { formatDate, formatInteger, formatTokenAmount } from "@/format";
import { ShortAddress, SubjectAddress } from "../Address";
import { FlagFacts } from "../Flags";
import { Panel } from "../Panel";
import { TokenAmount } from "../MarketsTable";
import { MintLabel } from "../MintLabel";
import { AuthorText } from "../Voice";
import { FactList, FactPart } from "./Facts";
import styles from "./Facts.module.css";
import { StrategyFactList } from "./StrategyFactList";
import { CanaryHeading, CanarySaw } from "../canary/CanarySaw";
import type { CanaryRead } from "../canary/MarketCanary";

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const plural = (n: number, one: string, many: string) => `${formatInteger(n)} ${n === 1 ? one : many}`;

export function MarketFacts({ market, canary }: { market: string; canary: CanaryRead }) {
  const load = useCallback((signal: AbortSignal) => getFromApi(`/v1/markets/${encodeURIComponent(market)}/facts`, MarketFactsAnswer, { signal }), [market]);
  return (
    <Panel title="Facts" what="this market's facts" load={load}>
      {({ market: m, strategy, mints }) => {
        const quote = m.mints.find((x) => x.mint === m.quote_mint)!;
        return (
          <>
            <p className={styles.note}>Read from the chain and measured by {BRAND.name}. No score, and no verdict.</p>
            <div className={styles.parts}>
              <div className={styles.whole}>
                {canary.ok ? (
                  <CanarySaw canary={canary.value} mints={m.mints} />
                ) : (
                  <section className={styles.part} aria-label="What Canary saw">
                    <CanaryHeading>What Canary saw</CanaryHeading>
                    <p role="alert">
                      Could not load what Canary saw. {canary.message} <a href="">Try again</a>
                    </p>
                  </section>
                )}
              </div>
              <FactPart title="This market">
                <FactList
                  facts={[
                    { name: "Market", value: <SubjectAddress address={m.address} short /> },
                    { name: "Market state", value: <ShortAddress address={m.market_state} /> },
                    {
                      name: "Created",
                      value: (
                        <>
                          {formatDate(new Date(m.created_at))} by <ShortAddress address={m.created_by} />
                        </>
                      ),
                    },
                    {
                      name: "Liquidity",
                      value: (
                        <span className={styles.lines}>
                          {m.mints.map((x) => (
                            <TokenAmount key={x.mint} raw={x.liquidity} decimals={x.decimals} mint={x.mint} symbol={x.symbol} token={x.token} />
                          ))}
                        </span>
                      ),
                    },
                    {
                      name: "Last 24 hours",
                      value:
                        m.stats_24h.trades === 0 ? (
                          "No trades"
                        ) : (
                          <>
                            {plural(m.stats_24h.trades, "trade", "trades")}; volume <TokenAmount raw={m.stats_24h.volume_quote} decimals={quote.decimals} mint={quote.mint} symbol={quote.symbol} token={quote.token} />
                          </>
                        ),
                    },
                    {
                      name: "Exact-out swaps",
                      value: m.supports_exact_out === null ? <span className={styles.note}>Not read yet</span> : m.supports_exact_out ? `Supported by the strategy; ${BRAND.name} trades exact in only` : "Not supported",
                    },
                  ]}
                />
              </FactPart>
              <FactPart title="Its strategy">
                <StrategyFactList strategy={strategy} />
              </FactPart>
              <FactPart title="Its mints">
                {mints.map((mint) => (
                  <MintFactList key={mint.mint} mint={mint} />
                ))}
              </FactPart>
            </div>
          </>
        );
      }}
    </Panel>
  );
}

/** A number of a mint's smallest units, in its tokens. */
const tokens = (raw: string, decimals: number | null) => (decimals === null ? `${raw} of its smallest units` : formatTokenAmount(BigInt(raw), decimals));

function MintFactList({ mint }: { mint: MintFacts }) {
  return (
    <div className={styles.mint}>
      <h4 className={styles.mintTitle}>
        <MintLabel mint={mint.mint} symbol={mint.symbol} token={mint.token} />
      </h4>
      <FactList
        label={`Mint ${mint.mint}`}
        facts={[
          mint.symbol
            ? { name: "Named by", value: `${BRAND.name}. It names SOL and USDC itself, and no other token.` }
            : mint.token
              ? {
                  name: "Name",
                  value: (
                    <>
                      {[mint.token.symbol, mint.token.name].filter((n): n is string => !!n).map((n, i) => (
                        <Fragment key={i}>
                          {i > 0 && ", "}
                          <AuthorText>{n}</AuthorText>
                        </Fragment>
                      ))}
                      <span className={styles.sub}>From the mint&apos;s own metadata: its author&apos;s claim, which {BRAND.name} does not check. Check the mint address.</span>
                    </>
                  ),
                }
              : { name: "Name", value: "None: shown by its address" },
          {
            name: "Mint",
            value: (
              <>
                <SubjectAddress address={mint.mint} short />
                {mint.mint === WRAPPED_SOL && <span className={styles.sub}>Wrapped SOL: {BRAND.name} wraps and unwraps it for you.</span>}
              </>
            ),
          },
          ...(mint.readable
            ? [
                { name: "Token program", value: mint.token_program },
                { name: "Decimals, supply", value: `${mint.decimals}; ${tokens(mint.supply ?? "0", mint.decimals)}` },
                {
                  name: "Mint authority",
                  value: mint.mint_authority ? (
                    <>
                      <ShortAddress address={mint.mint_authority} /> can mint more
                    </>
                  ) : (
                    "None"
                  ),
                },
                {
                  name: "Freeze authority",
                  value: mint.freeze_authority ? (
                    <>
                      <ShortAddress address={mint.freeze_authority} /> can freeze accounts
                    </>
                  ) : (
                    "None"
                  ),
                },
                mint.extensions.length > 0 && {
                  name: "Extensions",
                  value: (
                    <ul className={styles.extensions}>
                      {mint.extensions.map((e) => (
                        <li key={e.name}>
                          {e.name}
                          {e.detail && `: ${e.detail}`}
                          {e.address && (
                            <>
                              {" "}
                              <ShortAddress address={e.address} />
                            </>
                          )}
                          {e.authority && (
                            <>
                              ; set by <ShortAddress address={e.authority} />
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  ),
                },
              ]
            : [{ name: "Readable", value: "No: the account is missing, or is no SPL Token or Token-2022 mint" }]),
          mint.vault_amount !== null && {
            name: "In this market's vault",
            value: `${tokens(mint.vault_amount, mint.decimals)}${mint.symbol ? ` ${mint.symbol}` : ""}${mint.vault_share_percent === null ? "" : ` (${mint.vault_share_percent}% of the supply)`}`,
          },
        ]}
      />
      <FlagFacts facts={mint.flags} />
    </div>
  );
}
