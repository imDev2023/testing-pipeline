"use client";

// The buy wall AMM's own forms, under Actions after the strategy's metadata forms (docs/spec/pool4-for-solana.md,
// Aviary's panel; docs/spec/keeper-runner.md, How Aviary shows it; #57):
//
// - each keeper job due on the market, by the due rules the keeper runner itself uses
//   (`GET /v1/markets/{market}/keeper`, from packages/keeper-jobs), as a button that prepares the
//   job's metadata action for the viewer's own wallet, simulates it and leads to the same review as
//   every transaction in Aviary, with what it would move and the runner's last attempt at it;
// - the handover of each recipient role, offered only to the wallet holding that role.
//
// The forms are filled from the market's state, read with the panel (./useBuyWallRead), so nobody
// types a recipient's wallet: a payout names the wallet the market or the program names.
import Link from "next/link";
import { isAddress } from "@solana/kit";
import { useCallback, useId, useMemo, useState } from "react";
import { MarketKeeper, PreparedAction, type Market, type MarketRead } from "terminal-api/contract";
import { readBuyWall, readBuyWallState, mintSupply, type BuyWallReading } from "terminal-api/products/buy-wall";
import { getFromApi, postToApi } from "@/api";
import { ShortAddress } from "@/components/Address";
import forms from "@/components/forms/Forms.module.css";
import { TransactionReview } from "@/components/forms/TransactionReview";
import { useReview } from "@/components/forms/useReview";
import { PanelFrame, useLoad, type Loaded } from "@/components/Panel";
import { useWallet } from "@/components/wallet/WalletProvider";
import { BRAND } from "@/brand";
import type { MintInfo } from "@/formValues";
import { formatAge, formatTokenAmount } from "@/format";
import { formatSol, outcomeText, waitingReason } from "@/keeperText";
import { ROUTES } from "@/routes";
import { bytesOf } from "./BuyWallPanel";
import { refreshBuyWall, tokenOf, useBuyWallRead } from "./useBuyWallRead";
import styles from "./BuyWall.module.css";

type Due = MarketKeeper["due"][number];
/** The wallets a payout pays: the market's recipients, and the program's designer and suite wallets. */
export type PayoutWallets = { fee: string | null; rewards: string | null; designer: string | null; suite: string };
type FormValues = { args: Record<string, string>; inputs: Record<string, string> };

/**
 * A due job's form as the strategy's metadata action takes it (programs/buy-wall-amm/metadata.json):
 * `pay_rewards` names the rewards recipient, `sweep_fees` its slot and that slot's wallet. Null for a
 * job no wallet can be paid by yet (slot 1 while the designer share has no wallet).
 */
export function jobFormValues(unit: Pick<Due, "job" | "slot">, wallets: PayoutWallets): FormValues | null {
  switch (unit.job) {
    case "pay_rewards":
      return wallets.rewards ? { args: {}, inputs: { rewards_recipient: wallets.rewards } } : null;
    case "sweep_fees": {
      const wallet = unit.slot === 0 ? wallets.fee : unit.slot === 1 ? wallets.designer : wallets.suite;
      return wallet ? { args: { slot: String(unit.slot) }, inputs: { recipient: wallet } } : null;
    }
    default:
      return { args: {}, inputs: {} };
  }
}

const walletsOf = (reading: BuyWallReading): PayoutWallets => ({ fee: reading.recipients.fee, rewards: reading.recipients.rewards, designer: reading.fee.designerWallet, suite: reading.fee.suiteWallet });

export function BuyWallForms({ market }: { market: Market }) {
  const { account } = useWallet();
  const { state, retry } = useBuyWallRead(market);
  // The due jobs are asked again with each read of the market, so the buttons follow the panel.
  const slot = state.status === "loaded" ? state.data.slot : null;
  const load = useCallback((signal: AbortSignal) => getFromApi(`/v1/markets/${encodeURIComponent(market.address)}/keeper`, MarketKeeper, { signal }), [market.address, slot]); // eslint-disable-line react-hooks/exhaustive-deps
  const { state: keeper } = useLoad(load);
  return (
    <PanelFrame title="Buy wall AMM: keeper jobs and roles" what="the market's state" state={state} retry={retry}>
      {(read) => <BuyWallFormsBody market={market} read={read} keeper={keeper} wallet={account?.address ?? null} now={new Date()} />}
    </PanelFrame>
  );
}

/** The forms from a read of the market and its due jobs; `wallet` is the connected wallet's address. */
export function BuyWallFormsBody({ market, read, keeper, wallet, now }: { market: Market; read: MarketRead; keeper: Loaded<MarketKeeper>; wallet: string | null; now: Date }) {
  const [stateAccount, mintAccount] = read.accounts;
  const state = stateAccount?.data ? readBuyWallState(bytesOf(stateAccount.data)) : null;
  const mint = mintAccount?.data ? mintSupply(bytesOf(mintAccount.data)) : null;
  if (!state || !mint) return <p role="alert">This market&apos;s state is not a buy wall market state, so it has no buy wall forms.</p>;
  const reading = readBuyWall(state, { supply: mint.supply, now: BigInt(Math.floor(now.getTime() / 1000)) });
  const wallets = walletsOf(reading);
  const token = market.mints.find((m) => m.mint === tokenOf(market));
  const tokens = (raw: string) => `${formatTokenAmount(BigInt(raw), mint.decimals)}`;
  const tokenLabel = token ? <TokenName market={market} /> : <ShortAddress address={state.tokenMint} />;
  const roles = [
    wallet && wallet === wallets.fee ? ({ action: "set_fee_recipient", role: "fee recipient" } as const) : null,
    wallet && wallet === wallets.rewards ? ({ action: "set_rewards_recipient", role: "rewards recipient" } as const) : null,
  ].filter((r) => r !== null);

  return (
    <div className={styles.forms}>
      <section className={styles.group} aria-labelledby={`${market.address}-keeper`}>
        <h3 id={`${market.address}-keeper`} className={forms.subheading}>
          Keeper jobs due
        </h3>
        <p className={forms.note}>
          Anyone may run them, and {BRAND.name}&apos;s keeper runner does, from its own wallet; each is simulated for yours before you sign. <Link href={ROUTES.keeper}>The keeper page</Link> shows what the runner is doing.
        </p>
        {keeper.status === "loading" && <p className={forms.note}>Reading which jobs are due…</p>}
        {keeper.status === "failed" && <p role="alert">Could not read which keeper jobs are due. {keeper.message}</p>}
        {keeper.status === "loaded" && (
          <>
            {!keeper.data.records.ok && <p className={forms.note}>The keeper runner&apos;s records could not be read: {keeper.data.records.error}.</p>}
            {keeper.data.due.length === 0 ? (
              <p>No keeper job is due on this market now.</p>
            ) : (
              <ul className={styles.jobs}>
                {keeper.data.due.map((unit) => {
                  const values = jobFormValues(unit, wallets);
                  return (
                    <li key={unit.key} className={styles.job}>
                      <JobLine unit={unit} wallets={wallets} tokens={tokens} tokenLabel={tokenLabel} now={now} />
                      {values ? (
                        <ActionButton market={market} action={unit.job} values={values} label={`Simulate ${TITLES[unit.job]?.toLowerCase() ?? unit.job}`} />
                      ) : (
                        <p className={forms.note}>It waits: there is no wallet to pay yet.</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>
      {roles.map(({ action, role }) => (
        <Handover key={action} market={market} action={action} role={role} current={wallet!} />
      ))}
    </div>
  );
}

const TITLES: Record<string, string> = { place_wall: "Place the buy wall", settle: "Settle the retired tokens", pay_rewards: "Pay the rewards" };
const SLOT_TITLES = ["Sweep the fee recipient's share", "Sweep the designer share", "Sweep the suite share"];

function TokenName({ market }: { market: Market }) {
  const token = market.mints.find((m) => m.mint === tokenOf(market))!;
  return token.symbol ?? token.token?.symbol ?? token.token?.name ? <>{token.symbol ?? token.token?.symbol ?? token.token?.name}</> : <ShortAddress address={token.mint} />;
}

/** The keeper runner's last attempt at a job, in words: "parked after its last retry: ...". */
function attempt(last: NonNullable<Due["last"]>): string {
  const said = last.outcome === "held" || last.outcome === "parked" ? waitingReason(last) : `${outcomeText(last)}${last.error ? `: ${last.error}` : ""}`;
  return said.charAt(0).toLowerCase() + said.slice(1);
}

/** What a due job is, what it would move, and the keeper runner's last attempt at it. */
function JobLine({ unit, wallets, tokens, tokenLabel, now }: { unit: Due; wallets: PayoutWallets; tokens: (raw: string) => string; tokenLabel: React.ReactNode; now: Date }) {
  const owed = unit.owed ?? "0";
  const title = unit.job === "sweep_fees" ? (SLOT_TITLES[unit.slot ?? -1] ?? `Sweep fee slot ${unit.slot}`) : (TITLES[unit.job] ?? unit.job);
  const slotWallet = unit.slot === 0 ? wallets.fee : unit.slot === 1 ? wallets.designer : wallets.suite;
  const what =
    unit.job === "place_wall" ? (
      <>{formatSol(Number(owed))} of idle SOL or spent wall to place again</>
    ) : unit.job === "settle" ? (
      <>
        {tokens(owed)} {tokenLabel} retired: the reward share is kept, the rest burned
      </>
    ) : unit.job === "pay_rewards" ? (
      <>
        {tokens(owed)} {tokenLabel} to {wallets.rewards ? <ShortAddress address={wallets.rewards} /> : "nobody yet"}
      </>
    ) : unit.job === "sweep_fees" ? (
      <>
        {formatSol(Number(owed))} to {slotWallet ? <ShortAddress address={slotWallet} /> : "no wallet yet"}
      </>
    ) : null;
  const last = unit.last;
  return (
    <div className={styles.jobText}>
      <h4 className={forms.subheading}>{title}</h4>
      {what && <p className={forms.line}>{what}</p>}
      <p className={forms.note}>
        {last ? `${BRAND.name}'s keeper runner, ${formatAge(new Date(last.at), now)}: ${attempt(last)}.` : `${BRAND.name}'s keeper runner has not tried it yet.`}
        {unit.due_since && <> Due since {formatAge(new Date(unit.due_since), now)}.</>}
      </p>
    </div>
  );
}

/** A custom action of the market's strategy, filled in, as a button that prepares and simulates it for the connected wallet and leads to its review. */
function ActionButton({ market, action, values, label, disabled = false }: { market: Market; action: string; values: FormValues; label: string; disabled?: boolean }) {
  const { account, openMenu } = useWallet();
  const trader = account?.address ?? null;
  const mints: MintInfo[] = useMemo(() => market.mints.map((m) => ({ mint: m.mint, symbol: m.symbol, token: m.token, decimals: m.decimals })), [market.mints]);
  const version = JSON.stringify(values);
  const prepare = useCallback(() => postToApi("/v1/actions/prepare", { market: market.address, action, ...values, trader }, PreparedAction), [market.address, action, values, trader]);
  const { review, start, handlers } = useReview({ prepare, about: { market: market.address, strategy: market.strategy }, version: hashOf(version), trader, onConfirmed: () => refreshBuyWall(market.address) });
  const mintOf = (mint: string) => mints.find((m) => m.mint === mint) ?? null;
  if (review) return <TransactionReview title="Review this action" building="Building it and simulating it, exactly as it would be signed." review={review} mintOf={mintOf} {...handlers} />;
  return (
    <div className={forms.actions}>
      {account ? (
        <button type="button" className={forms.simulate} disabled={disabled} onClick={start}>
          {label}
        </button>
      ) : (
        <button type="button" className={forms.simulate} onClick={openMenu}>
          Connect wallet
        </button>
      )}
    </div>
  );
}

/** A form's values as the number `useReview` leaves a review on when it changes. */
function hashOf(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return hash;
}

/** The handover of a recipient role, for the wallet holding it: the new wallet, then simulate and review. */
function Handover({ market, action, role, current }: { market: Market; action: "set_fee_recipient" | "set_rewards_recipient"; role: string; current: string }) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const next = typed.trim();
  const problem = !next ? "Enter the wallet to hand the role to." : !isAddress(next) ? "This is not a Solana address." : next === current ? "That is your wallet, which already holds the role." : null;
  return (
    <section className={styles.group} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className={forms.subheading}>
        Hand over the {role} role
      </h3>
      <p className={forms.line}>
        Your wallet is this market&apos;s {role}. You can hand the role, and everything it is owed, to another wallet in one step; nobody else can, and it cannot be undone except by the new holder. Check the address: a mistyped wallet keeps the role for good.
      </p>
      <div className={forms.field}>
        <label htmlFor={`${id}-new`} className={forms.fieldLabel}>
          New {role}
        </label>
        <div className={forms.control}>
          <input id={`${id}-new`} type="text" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" aria-invalid={next && problem ? true : undefined} aria-describedby={`${id}-problem`} />
        </div>
        {next && problem && (
          <span id={`${id}-problem`} className={forms.reason}>
            {problem}
          </span>
        )}
      </div>
      <ActionButton market={market} action={action} values={{ args: { new: next }, inputs: {} }} label="Simulate the handover" disabled={problem !== null} />
    </section>
  );
}
