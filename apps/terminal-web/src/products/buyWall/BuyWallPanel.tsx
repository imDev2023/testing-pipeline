"use client";

// The buy wall AMM's panel on its markets' pages (docs/spec/pool4-for-solana.md, Aviary's panel; #57):
// the price and the buy wall, the inventory cap, the tokens retired, owed and burned, the fee with its
// whole split and ledgers, and the market's parameters and recipients, every value read from the
// market state at one slot through the API's one-slot read (PIPESCOPE-146), never from vault balances
// or events, which count retired tokens, the wall, idle SOL and unpaid fees as liquidity. It reads
// the state through terminal-api's reading of the buy wall AMM, which the explainer's facts use too.
import { readBuyWall, readBuyWallState, mintSupply, priceNumber, type BuyWallReading, type BuyWallState } from "terminal-api/products/buy-wall";
import { getBase64Encoder } from "@solana/kit";
import type { ReactNode } from "react";
import type { Market, MarketMint, MarketRead } from "terminal-api/contract";
import { ShortAddress } from "@/components/Address";
import { FactList, FactPart } from "@/components/facts/Facts";
import facts from "@/components/facts/Facts.module.css";
import { TokenAmount } from "@/components/MarketsTable";
import { PanelFrame } from "@/components/Panel";
import { formatDate, formatInteger, formatPrice, formatTokenAmount } from "@/format";
import { useBuyWallRead } from "./useBuyWallRead";
import styles from "./BuyWall.module.css";

const SOL_DECIMALS = 9;
const base64 = getBase64Encoder();
/** An account's data as the one-slot read gives it, base64, as bytes. */
export const bytesOf = (data: string) => new Uint8Array(base64.encode(data));
const share = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });
/** A share as a percentage, to three significant figures: 0.1349 is "13.5%". */
const percent = (fraction: number) => `${share.format(fraction * 100)}%`;
/** Basis points as a percentage. */
const bps = (value: bigint | number) => percent(Number(value) / 10_000);

export function BuyWallPanel({ market }: { market: Market }) {
  const { state, retry, now } = useBuyWallRead(market);
  return (
    <PanelFrame title="Buy wall AMM" what="the market's state" state={state} retry={retry}>
      {(read) => <BuyWallPanelBody market={market} read={read} now={now()} />}
    </PanelFrame>
  );
}

/** The panel's content from a read of the market's state and its token's mint at one slot; `now` is the chain's time in Unix seconds. */
export function BuyWallPanelBody({ market, read, now }: { market: Market; read: MarketRead; now: bigint }) {
  const [stateAccount, mintAccount] = read.accounts;
  const state = stateAccount?.data ? readBuyWallState(bytesOf(stateAccount.data)) : null;
  const mint = mintAccount?.data ? mintSupply(bytesOf(mintAccount.data)) : null;
  if (!state || !mint) return <p role="alert">This market&apos;s state is not a buy wall market state, so there is nothing of the buy wall AMM to show.</p>;
  const reading = readBuyWall(state, { supply: mint.supply, now });
  const token = market.mints.find((m) => m.mint === state.tokenMint) ?? { mint: state.tokenMint, symbol: null, token: null, decimals: mint.decimals };
  return (
    <>
      <p className={facts.note}>
        Read from the market&apos;s state at slot {formatInteger(read.slot)}, not from its vaults: retired tokens, the wall, idle SOL and unpaid fees sit in the vaults too. The buy wall AMM is a port of IMD&apos;s Pool4 design.
      </p>
      <div className={styles.parts}>
        <WallPart reading={reading} token={token} decimals={mint.decimals} />
        <CapPart reading={reading} state={state} token={token} decimals={mint.decimals} />
        <TokensPart reading={reading} token={token} decimals={mint.decimals} />
        <FeePart reading={reading} />
        <ParametersPart reading={reading} state={state} token={token} decimals={mint.decimals} />
      </div>
    </>
  );
}

type Token = Pick<MarketMint, "mint" | "symbol" | "token">;
const Tokens = ({ raw, token, decimals }: { raw: bigint; token: Token; decimals: number }) => <TokenAmount raw={String(raw)} decimals={decimals} mint={token.mint} symbol={token.symbol} token={token.token} />;
const Sol = ({ raw }: { raw: bigint }) => <>{formatTokenAmount(raw, SOL_DECIMALS)} SOL</>;
const Price = ({ sqrt, decimals }: { sqrt: bigint; decimals: number }) => <>{formatPrice(priceNumber(sqrt, decimals))} SOL</>;
const Sub = ({ children }: { children: ReactNode }) => <span className={facts.sub}>{children}</span>;

function WallPart({ reading, token, decimals }: { reading: BuyWallReading; token: Token; decimals: number }) {
  const { wall } = reading;
  return (
    <FactPart title="Price and the buy wall">
      <FactList
        facts={[
          { name: "Price", value: <><Price sqrt={reading.price} decimals={decimals} /> <Sub>per token</Sub></> },
          wall.placed
            ? { name: "Wall's top", value: <><Price sqrt={wall.top} decimals={decimals} /> <Sub>the highest price it buys at</Sub></> }
            : { name: "Buy wall", value: "Not placed yet" },
          wall.placed && { name: "In the wall", value: <Sol raw={wall.sol} /> },
          wall.placed && { name: "Bought since placed", value: <><Tokens raw={wall.bought} token={token} decimals={decimals} />, for <Sol raw={wall.spent} /></> },
          { name: "Wall's floor", value: <><Price sqrt={wall.floor} decimals={decimals} /> <Sub>the wall is placed no higher; it rises about 4% a day toward the price</Sub></> },
          { name: "Idle SOL", value: <><Sol raw={wall.idle} /> <Sub>waiting to be placed as the wall</Sub></> },
        ]}
      />
    </FactPart>
  );
}

function CapPart({ reading, state, token, decimals }: { reading: BuyWallReading; state: BuyWallState; token: Token; decimals: number }) {
  const { cap } = reading;
  const full = cap.decayPerDay > 0n && cap.allowance >= cap.decayPerDay;
  return (
    <FactPart title="Inventory cap">
      <FactList
        facts={[
          { name: "Inventory cap", value: <><Tokens raw={cap.cap} token={token} decimals={decimals} /> <Sub>the most the curve may hold after a sell; above it, a sell is trimmed</Sub></> },
          { name: "The curve holds", value: <><Tokens raw={cap.held} token={token} decimals={decimals} />, {cap.cap > 0n ? percent(Number(cap.held) / Number(cap.cap)) : "0%"} of the cap</> },
          { name: "Cap floor", value: <><Tokens raw={cap.floor} token={token} decimals={decimals} />, {bps(state.capFloorBps)} of the {formatTokenAmount(state.seededTokens, decimals)} seeded</> },
          {
            name: "Cap decay",
            value:
              cap.decayPerDay === 0n ? (
                "None: buys never lower the cap"
              ) : (
                <><Tokens raw={cap.decayPerDay} token={token} decimals={decimals} /> a day, {bps(state.capDecayBps)} of the seeded</>
              ),
          },
          cap.decayPerDay > 0n && { name: "Allowance built up", value: <><Tokens raw={cap.allowance} token={token} decimals={decimals} />{full ? ", a full day's" : ""} <Sub>how far the next buys may lower the cap</Sub></> },
        ]}
      />
    </FactPart>
  );
}

function TokensPart({ reading, token, decimals }: { reading: BuyWallReading; token: Token; decimals: number }) {
  const { tokens } = reading;
  return (
    <FactPart title="Retired, owed and burned">
      <FactList
        facts={[
          { name: "Retired", value: <><Tokens raw={tokens.retired} token={token} decimals={decimals} /> <Sub>trimmed or bought by the wall, waiting to be settled: burned, but for the reward share</Sub></> },
          { name: "Rewards owed", value: <><Tokens raw={tokens.rewardsOwed} token={token} decimals={decimals} /> <Sub>to the rewards recipient</Sub></> },
          { name: "Burned", value: <><Tokens raw={tokens.burned} token={token} decimals={decimals} />, {percent(tokens.burnedPpm / 1_000_000)} of the supply before these burns</> },
        ]}
      />
    </FactPart>
  );
}

function FeePart({ reading }: { reading: BuyWallReading }) {
  const { fee } = reading;
  const fraction = Number(fee.bps) / 10_000;
  const marketShare = 1 - (fee.designerBps + fee.suiteBps) / 10_000;
  const wall = Number(fee.wallSplitBps) / 10_000;
  const ofSwap = (part: number) => `${percent(fraction * part)} of each swap`;
  return (
    <FactPart title="The fee">
      <FactList
        facts={[
          { name: "Fee", value: <>{bps(fee.bps)} of each swap, in SOL <Sub>on top of Pipeline&apos;s own fee; fixed for good at creation</Sub></> },
          { name: "Designer share", value: <>{bps(fee.designerBps)} of the fee ({ofSwap(fee.designerBps / 10_000)}), for IMD and Adam</> },
          { name: "Suite share", value: <>{bps(fee.suiteBps)} of the fee ({ofSwap(fee.suiteBps / 10_000)}), for the suite&apos;s treasury</> },
          {
            name: "The market's part",
            value: (
              <>
                {percent(marketShare)} of the fee: {percent(wall)} to the buy wall ({ofSwap(marketShare * wall)}) and {percent(1 - wall)} to the fee recipient ({ofSwap(marketShare * (1 - wall))})
              </>
            ),
          },
          { name: "Owed to the fee recipient", value: <Sol raw={fee.ledgers.recipient} /> },
          {
            name: "Owed to the designer share",
            value: (
              <>
                <Sol raw={fee.ledgers.designer} />{" "}
                {fee.designerWallet ? (
                  <Sub>
                    paid to <ShortAddress address={fee.designerWallet} />
                  </Sub>
                ) : (
                  <Sub>No wallet yet: it waits in the market until the program names one</Sub>
                )}
              </>
            ),
          },
          {
            name: "Owed to the suite share",
            value: (
              <>
                <Sol raw={fee.ledgers.suite} />{" "}
                <Sub>
                  paid to <ShortAddress address={fee.suiteWallet} />
                </Sub>
              </>
            ),
          },
        ]}
      />
    </FactPart>
  );
}

function ParametersPart({ reading, state, token, decimals }: { reading: BuyWallReading; state: BuyWallState; token: Token; decimals: number }) {
  const { recipients } = reading;
  return (
    <FactPart title="Parameters and recipients">
      <FactList
        facts={[
          { name: "Reward share", value: state.rewardShareBps === 0n ? "None" : <>{bps(state.rewardShareBps)} of the trimmed tokens the cap&apos;s fall matched</> },
          { name: "Buy wall split", value: <>{bps(state.wallSplitBps)} of the market&apos;s part of the fee</> },
          {
            name: "Seeded",
            value:
              state.status === 2 ? (
                <>
                  <Tokens raw={state.seededTokens} token={token} decimals={decimals} /> by <ShortAddress address={state.seeder} /> on {formatDate(new Date(Number(state.seedTime) * 1000))}
                </>
              ) : (
                <>
                  Not yet: only <ShortAddress address={state.seeder} /> may seed it
                </>
              ),
          },
          { name: "Fee recipient", value: recipients.fee ? <ShortAddress address={recipients.fee} /> : "None: the buy wall takes the market's whole part" },
          { name: "Rewards recipient", value: recipients.rewards ? <ShortAddress address={recipients.rewards} /> : "None: no reward share" },
        ]}
      />
      <p className={facts.note}>None of these can change, but each recipient may hand its own role to another wallet.</p>
    </FactPart>
  );
}
