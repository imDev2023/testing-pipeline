import type { ReactNode } from "react";
import type { AccountSource } from "terminal-api/contract";
import { mintOf, type MintContext } from "@/formValues";
import { MintLabel } from "../MintLabel";

/**
 * What an account a form touches is, in Aviary's words (docs/spec/pipescope-screens.md, Explanation,
 * actions and facts: "your wallet", "the market's vault for SOL", "an address derived from the program
 * itself by a rule in the metadata", "a fixed address"), from the metadata's account source. The
 * market's mints are named as every page names them; an address the user enters, by its input's name.
 */
export function AccountWords({ source, context }: { source: AccountSource; context: MintContext }) {
  return <>{words(source, context)}</>;
}

function MintWords({ source, context }: { source: AccountSource; context: MintContext }) {
  const mint = source.kind === "mint" ? mintOf(source, context) : null;
  if (mint) return <MintLabel mint={mint.mint} symbol={mint.symbol} token={mint.token} />;
  if (source.kind === "input") {
    return (
      <>
        the mint you enter as <code>{source.name}</code>
      </>
    );
  }
  if (source.kind === "mint") return <>the market&apos;s mint {source.index + 1}</>;
  return <>{words(source, context)}</>;
}

function words(source: AccountSource, context: MintContext): ReactNode {
  switch (source.kind) {
    case "wallet":
      return "your wallet";
    case "market_state":
      return "the market's state";
    case "market":
      return "the market's account with Pipeline's router";
    case "strategy_program":
      return "the strategy's program";
    case "system_program":
      return "the System program";
    case "associated_token_program":
      return "the Associated Token program";
    case "seeder":
      return "the program seeding the market";
    case "lp_recipient":
      return "the account receiving the market's first shares";
    case "escrow":
      return `the seeder's escrow for mint ${source.index + 1}`;
    case "fixed":
      return "a fixed address";
    case "input":
      return (
        <>
          the address you enter as <code>{source.name}</code>
        </>
      );
    case "mint":
      return (
        <>
          the mint <MintWords source={source} context={context} />
        </>
      );
    case "vault":
      return (
        <>
          the market&apos;s vault for <MintWords source={{ kind: "mint", index: source.index }} context={context} />
        </>
      );
    case "token_program":
      return (
        <>
          the token program of <MintWords source={{ kind: "mint", index: source.index }} context={context} />
        </>
      );
    case "wallet_token_account":
      return (
        <>
          your token account for <MintWords source={{ kind: "mint", index: source.index }} context={context} />
        </>
      );
    case "token_program_of":
      return (
        <>
          the token program of <MintWords source={source.mint} context={context} />
        </>
      );
    case "ata":
      return source.owner.kind === "wallet" ? (
        <>
          your token account for <MintWords source={source.mint} context={context} />
        </>
      ) : (
        <>
          the token account of {words(source.owner, context)} for <MintWords source={source.mint} context={context} />
        </>
      );
    case "pda":
      return source.program === "strategy" ? "an address derived from the program itself by a rule in the metadata" : "an address derived from another program by a rule in the metadata";
  }
}
