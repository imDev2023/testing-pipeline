"use client";

// A strategy's facts (docs/spec/pipescope-screens.md, Strategy page, "Facts"; PIPESCOPE-16): the
// program, who can upgrade it, the current version's slot, date and code hash, the verified build,
// the metadata's status with its link as plain text, when it was registered and the listing fee, its
// markets and its trust flags, and the instructions compiled into it beyond Pipeline's own, read by
// name from its bytes (PIPESCOPE-92). No score, and no verdict.
import { useCallback } from "react";
import { StrategyInstructions, type StrategyDetail } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { formatDate, formatInteger, formatTokenAmount } from "@/format";
import { SubjectAddress } from "../Address";
import { FactList, FactPart } from "../facts/Facts";
import facts from "../facts/Facts.module.css";
import { MetadataFact, upgradeAuthorityFact, versionFact } from "../facts/StrategyFactList";
import { FlagFacts } from "../Flags";
import { StaticPanel, useLoad } from "../Panel";

export const INSTRUCTIONS_LINE = "Found by name in the deployed program. People call these directly on the strategy, outside the router. Canary lists them and does not call them.";

/** A code hash written short, its whole on hover. */
const shortHash = (hash: string) => `${hash.slice(0, 8)}...${hash.slice(-5)}`;

export function StrategyFacts({ strategy }: { strategy: StrategyDetail }) {
  const load = useCallback((signal: AbortSignal) => getFromApi(`/v1/strategies/${encodeURIComponent(strategy.program)}/instructions`, StrategyInstructions, { signal }), [strategy.program]);
  const instructions = useLoad(load);
  const hash = strategy.current_version?.executable_sha256 ?? null;
  return (
    <StaticPanel title="Facts">
      <p className={facts.note}>Read from the chain by {BRAND.name}, worded as Pipeline&apos;s own SDK words them. No score, and no verdict.</p>
      <div className={facts.split}>
        <FactPart title="Its program">
          <FactList
            facts={[
              { name: "Program", value: <SubjectAddress address={strategy.program} short /> },
              { name: "Upgrade authority", value: upgradeAuthorityFact(strategy) },
              { name: "This version", value: versionFact(strategy) },
              {
                name: "Code hash",
                value: hash ? (
                  <code title={hash}>{shortHash(hash)}</code>
                ) : (
                  <span className={facts.note}>{strategy.current_version ? "Not read: the version was found in the program's history, whose bytes are gone" : "Not read yet"}</span>
                ),
              },
              { name: "Verified build", value: "None: source not verified" },
              { name: "Metadata", value: <MetadataFact metadata={strategy.metadata} /> },
              {
                name: "Registered",
                value: `${formatDate(new Date(strategy.registered_at))}${strategy.fee_paid === null ? "" : `; listing fee paid ${formatTokenAmount(BigInt(strategy.fee_paid), 9)} SOL`}`,
              },
              { name: "Markets", value: formatInteger(strategy.market_count) },
            ]}
          />
        </FactPart>
        <div className={facts.stack}>
          <FactPart title="Its trust flags">
            <FlagFacts facts={strategy.flag_facts} />
          </FactPart>
          <FactPart title="Instructions beyond Pipeline's own">
            {instructions.state.status === "loading" && <p className={facts.note}>Loading the program&apos;s instructions…</p>}
            {instructions.state.status === "failed" && (
              <div role="alert">
                <p>Could not load the program&apos;s instructions. {instructions.state.message}</p>
                <button type="button" onClick={instructions.retry}>
                  Try again
                </button>
              </div>
            )}
            {instructions.state.status === "loaded" && <Instructions list={instructions.state.data} />}
          </FactPart>
        </div>
      </div>
    </StaticPanel>
  );
}

function Instructions({ list }: { list: StrategyInstructions }) {
  if (list.deploy_slot === null) return <p className={facts.note}>Not read yet: the program&apos;s version has not been read.</p>;
  if (list.anchor === false) return <p className={facts.note}>None found: the deployed program names no instruction as Anchor compiles them.</p>;
  const own = list.instructions.filter((i) => !i.pipeline);
  if (!own.length) return <p className={facts.note}>None found by name in the deployed program.</p>;
  return (
    <>
      <ul className={facts.codes} aria-label="Instructions beyond Pipeline's own">
        {own.map((i) => (
          <li key={i.discriminator}>
            <code>{i.name}</code>
          </li>
        ))}
      </ul>
      <p className={facts.note}>{INSTRUCTIONS_LINE}</p>
    </>
  );
}
