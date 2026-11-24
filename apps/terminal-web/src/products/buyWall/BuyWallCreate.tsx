"use client";

// The buy wall AMM's create form on the create page (docs/spec/pool4-for-solana.md, Creation
// parameters and Creating a market; #57): the strategy's own create form from its metadata, filled in
// with IMD's launch values (./config, the one place they live) and the connected wallet as both
// recipients and the seeder; the whole fee split beside it, the designer and suite shares included;
// and the seed action's amounts, so the market is created, given a fee account for each mint and
// seeded in one transaction, which Aviary prepares and simulates before the wallet signs it.
import { generateKeyPairSigner, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, type KeyPairSigner } from "@solana/kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PreparedMarket, StrategyForms, type Form } from "terminal-api/contract";
import { getFromApi, postToApi } from "@/api";
import { BRAND } from "@/brand";
import { NewMarket } from "@/components/create/NewMarket";
import create from "@/components/create/Create.module.css";
import { FactList } from "@/components/facts/Facts";
import facts from "@/components/facts/Facts.module.css";
import { AccountsTable } from "@/components/forms/AccountsTable";
import { CheckLine } from "@/components/forms/CheckLine";
import { FormFields } from "@/components/forms/FormFields";
import forms from "@/components/forms/Forms.module.css";
import { TransactionReview } from "@/components/forms/TransactionReview";
import { useFormFields } from "@/components/forms/useFormFields";
import { useReview } from "@/components/forms/useReview";
import { PanelFrame, useLoad } from "@/components/Panel";
import { AuthorText } from "@/components/Voice";
import { useWallet } from "@/components/wallet/WalletProvider";
import { formatTokenAmount } from "@/format";
import type { MintInfo } from "@/formValues";
import { DESIGNER_SHARE_BPS, percentOf, SUITE_SHARE_BPS } from "terminal-api/products/buy-wall";
import { hashOf } from "./BuyWallForms";
import { CREATE_FORM_DEFAULTS } from "./config";
import styles from "./BuyWall.module.css";

const WRAPPED_SOL: MintInfo = { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", token: null, decimals: 9 };
const NO_MINTS: never[] = [];
const SOL_DECIMALS = 9;
/** The create form's arguments that start as the connected wallet. */
const WALLET_ARGS = ["fee_recipient", "rewards_recipient", "seeder"] as const;
/** What a token's mint facts flag that the seed refuses (docs/spec/pool4-for-solana.md, Mint rules). */
const REFUSED_AT_SEED: Record<string, string> = {
  "mint-authority": "its mint authority is still set",
  "freeze-authority": "its freeze authority is still set",
  "transfer-hook": "its transfer hook still names a program",
  "transfer-hook-authority": "its transfer hook still has an authority",
};

const share = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });
const percent = (fraction: number) => `${share.format(fraction * 100)}%`;

/**
 * Where each swap's fee goes, for the fee and the buy wall split typed (docs/spec/pool4-for-solana.md,
 * The fee): the designer share and the suite share first, from the program's constants, then the
 * market's part, split between the buy wall and the fee recipient.
 */
export function FeeSplit({ feeBps, wallSplitBps }: { feeBps: number | null; wallSplitBps: number | null }) {
  if (feeBps === null || wallSplitBps === null) return <p className={forms.note}>Enter the fee and the buy wall split to see how each swap&apos;s fee is split.</p>;
  const fee = feeBps / 10_000;
  const market = 1 - (DESIGNER_SHARE_BPS + SUITE_SHARE_BPS) / 10_000;
  const wall = wallSplitBps / 10_000;
  const ofSwap = (part: number) => `${percent(fee * part)} of each swap`;
  return (
    <section className={styles.split} aria-label="The whole fee split">
      <h3 className={forms.subheading}>The whole fee split</h3>
      <FactList
        facts={[
          { name: "Fee", value: `${percent(fee)} of each swap, in SOL, on top of Pipeline's own fee` },
          { name: "Designer share, for IMD and Adam", value: `${ofSwap(DESIGNER_SHARE_BPS / 10_000)} (${percent(DESIGNER_SHARE_BPS / 10_000)} of the fee)` },
          { name: "Suite share", value: `${ofSwap(SUITE_SHARE_BPS / 10_000)} (${percent(SUITE_SHARE_BPS / 10_000)} of the fee)` },
          { name: "Buy wall", value: `${ofSwap(market * wall)} (${percent(wall)} of the market's ${percent(market)})` },
          { name: "Fee recipient", value: `${ofSwap(market * (1 - wall))} (${percent(1 - wall)} of the market's ${percent(market)})` },
        ]}
      />
      <p className={facts.note}>The designer and suite shares are fixed in the program; the fee and the split are fixed for good once the market is created.</p>
    </section>
  );
}

/** The create page's panel for the buy wall AMM: its forms read from its metadata, then its own create form (PIPESCOPE-162). */
export function BuyWallCreate({ program }: { program: string }) {
  const load = useCallback((signal: AbortSignal) => getFromApi(`/v1/strategies/${program}/forms`, StrategyForms, { signal }), [program]);
  const { state, retry } = useLoad(load);
  return (
    <PanelFrame title="The create form" what="the buy wall AMM's create form" state={state} retry={retry}>
      {(view) => <BuyWallCreateForm view={view} />}
    </PanelFrame>
  );
}

/** The create form from the strategy's forms: its `init` form with IMD's values, and its seed. */
export function BuyWallCreateForm({ view }: { view: StrategyForms }) {
  const form = view.init;
  const seed = view.actions.find((a) => a.kind === "add_liquidity" && a.name === "seed") ?? null;
  if (!form || !seed) return <p role="alert">This strategy&apos;s metadata describes no create form with a seed action, so {BRAND.name} cannot create and seed a market from it in one transaction.</p>;
  return <CreateAndSeed form={form} seed={seed} view={view} />;
}

const DEFAULT_VALUES = Object.fromEntries(Object.entries(CREATE_FORM_DEFAULTS).map(([name, value]) => [name, String(value)]));

function CreateAndSeed({ form, seed, view }: { form: Form; seed: Form; view: StrategyForms }) {
  const { account, openMenu } = useWallet();
  const trader = account?.address ?? null;
  const fields = useFormFields(form, NO_MINTS, { values: DEFAULT_VALUES });
  const { values, setValue } = fields;

  // The recipients and the seeder start as the connected wallet, once one is connected, and follow it
  // when another is connected, unless the creator typed something else there.
  const filledWith = useRef<string | null>(null);
  useEffect(() => {
    if (!trader) return;
    for (const name of WALLET_ARGS) if (!values[name] || values[name] === filledWith.current) setValue(name, trader);
    filledWith.current = trader;
  }, [trader]); // eslint-disable-line react-hooks/exhaustive-deps

  // The seed's amounts are in the token entered above and in wrapped SOL, the market's mints 0 and 1.
  const token = fields.context.inputs["token_mint"] ?? null;
  const seedFields = useFormFields(seed, token ? [token, WRAPPED_SOL] : NO_MINTS);
  const typedToken = (fields.inputs["token_mint"] ?? "").trim();
  const tokenRead = fields.entered[typedToken];
  const refused = tokenRead?.status === "read" ? tokenRead.facts.flags.filter((f) => REFUSED_AT_SEED[f.flag]).map((f) => REFUSED_AT_SEED[f.flag]!) : [];

  const number = (name: string) => {
    const reading = fields.readings[name];
    return reading?.kind === "ok" ? Number(reading.value) : null;
  };

  // A new market state's keypair, made in the page for each review and never sent anywhere (PIPESCOPE-144).
  const state = useRef<KeyPairSigner | null>(null);
  const ready = useMemo(() => (fields.request && seedFields.request && token ? { create: fields.request, seed: seedFields.request } : null), [fields.request, seedFields.request, token]);
  const prepare = useCallback(async () => {
    state.current = await generateKeyPairSigner();
    return postToApi("/v1/markets/prepare", { strategy: view.program, ...ready!.create, market_state: state.current.address, trader, seed: { action: seed.name, ...ready!.seed } }, PreparedMarket);
  }, [view.program, ready, trader, seed.name]);
  const presign = useCallback(async (bytes: Uint8Array) => {
    if (!state.current) return bytes;
    const signed = await partiallySignTransaction([state.current.keyPair], getTransactionDecoder().decode(bytes));
    return new Uint8Array(getTransactionEncoder().encode(signed));
  }, []);
  const [created, setCreated] = useState<string | null>(null);
  const { review, start, handlers } = useReview({ prepare, about: { strategy: view.program }, version: hashOf(`${fields.version}:${seedFields.version}`), trader, onConfirmed: (prepared) => setCreated(prepared.market) });
  const mintOf = (mint: string) => (mint === WRAPPED_SOL.mint ? WRAPPED_SOL : token?.mint === mint ? token : null);
  const missing = !token ? "Enter the token's mint above, then the seed's amounts." : (fields.missing ?? seedFields.missing);

  return (
    <div className={create.form}>
      <CheckLine form={form} program={view.program} deploySlot={view.deploy_slot} via="router" />
      <p className={forms.line}>
        You sign it in your own wallet. The market is created through Pipeline&apos;s router with what you fill in below, given a fee account for each of its two mints, and seeded from your wallet: created and seeded in one transaction, so nobody can trade it before its seed.
      </p>
      {form.description && (
        <p className={forms.line}>
          <AuthorText>{form.description}</AuthorText>
        </p>
      )}
      <p className={forms.note}>
        The fee, the reward share, the cap floor and the cap decay start at IMD&apos;s own launch values for Pool4: a {percentOf(CREATE_FORM_DEFAULTS.fee_bps)} fee, a {percentOf(CREATE_FORM_DEFAULTS.reward_share_bps)} reward share, a cap floor of {percentOf(CREATE_FORM_DEFAULTS.cap_floor_bps)} and a cap decay of {percentOf(CREATE_FORM_DEFAULTS.cap_decay_bps)} a day. {percentOf(CREATE_FORM_DEFAULTS.wall_split_bps)} of the market&apos;s part of the fee goes to the buy wall. The recipients and the seeder start as your wallet. Change any of them before you sign; none can change after.
      </p>
      <FormFields form={form} fields={fields} wallet={trader} />
      <FeeSplit feeBps={number("fee_bps")} wallSplitBps={number("wall_split_bps")} />
      <section className={styles.group} aria-label="The seed">
        <h3 className={forms.subheading}>The seed</h3>
        <p className={forms.line}>What the market opens with, from your wallet, for good: there is no withdrawal. The token&apos;s mint and freeze authorities must be removed first, and a transfer hook, if it has one, cleared.</p>
        {refused.length > 0 && (
          <p className={forms.reason} role="alert">
            The seed would be refused: {refused.join(", ")}.
          </p>
        )}
        {token ? <FormFields form={seed} fields={seedFields} wallet={trader} /> : <p className={forms.note}>Enter the token&apos;s mint above to fill in the seed.</p>}
      </section>
      <AccountsTable form={form} context={fields.context} />
      {review ? (
        <TransactionReview
          title="Review the new market"
          building="Building the new market with its seed and simulating it, exactly as it would be signed."
          review={review}
          mintOf={mintOf}
          presign={presign}
          confirmed={() => (created ? <NewMarket market={created} /> : null)}
          {...handlers}
        />
      ) : (
        <div className={forms.actions}>
          {account ? (
            <button type="button" className={forms.simulate} disabled={!ready} onClick={start}>
              Simulate creating and seeding the market
            </button>
          ) : (
            <button type="button" className={forms.simulate} onClick={openMenu}>
              Connect wallet
            </button>
          )}
          {account && missing && <span className={forms.note}>{missing}</span>}
        </div>
      )}
      {review?.status === "ready" && (
        <p className={forms.note}>
          The router lets the strategy&apos;s setup take at most {formatTokenAmount(BigInt(review.prepared.max_creator_lamports), SOL_DECIMALS)} SOL from your wallet; the simulation above shows what it takes, the seed included.
        </p>
      )}
    </div>
  );
}
