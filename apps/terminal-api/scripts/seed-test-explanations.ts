// `tsx scripts/seed-test-explanations.ts`: explanations for Aviary's end-to-end tests only (#127;
// tests/terminal-e2e/src/global-setup.ts runs it on the suite's own database, DATABASE_URL). The
// suite never calls a model (nothing paid runs in a test), so this makes every strategy's current key
// as the `explainerKeys` job makes it (../src/explainer), and writes two devnet strategies an
// explanation each as the owner's approve command would:
//
// - the buy wall AMM's demo strategy gets one built from its key's own evidence, which passes the
//   explainer's validator, so its strategy page and market pages show presentation A;
// - the strategy whose metadata link is unreachable gets that explanation with one more point that
//   carries markup, as the validator would never let through, so the pages show that model text
//   that slips past it still renders as text.
//
// Every other strategy keeps its key pending, so its pages say "No explanation for this version yet."
// A database reused from an earlier run keeps what it was given.
// Given only the first strategy, it writes that one alone: so it gave the local devnet run of #127
// a hand-written explanation for the Lending AMM's current key, on the owner's word, after two paid
// approve runs failed the validator. It never runs against a deployment: nothing here is part of
// the Worker.
import { eq } from "drizzle-orm";
import { createDb, finishExplainerKey, readExplainerKey, strategies, type Db } from "terminal-db";
import { validate, type EvidenceItem, type Explanation } from "terminal-explainer";
import { currentExplainerKey, makeExplainerKeys } from "../src/explainer";

const args = process.argv.slice(2);
if (![1, 3].includes(args.length) || args.some((a) => !a)) {
  console.error("Usage: tsx scripts/seed-test-explanations.ts <explained strategy> [<hostile strategy> <hostile text>], with DATABASE_URL naming the database.");
  process.exit(2);
}
const [EXPLAINED_STRATEGY, HOSTILE_STRATEGY, HOSTILE_TEXT] = args as [string, string | undefined, string | undefined];

/** An item of the evidence by its label, which every key's evidence has. */
const cite = (evidence: EvidenceItem[], label: string | RegExp): string => {
  const item = evidence.find((e) => (typeof label === "string" ? e.label === label : label.test(e.label)));
  if (!item) throw new Error(`the key's evidence has no item labelled ${label}`);
  return item.id;
};

/** An explanation that cites the key's own evidence and passes the validator. */
function explanationFrom(evidence: EvidenceItem[]): Explanation {
  const authority = cite(evidence, "Upgrade authority");
  const protections = cite(evidence, "Router protections on swaps");
  const custom = cite(evidence, "Custom actions");
  const verified = cite(evidence, "Verified build");
  const canary = cite(evidence, /^Canary/);
  return {
    summary: [
      { text: "Pipeline sends your swap to this strategy's program, which holds its own liquidity and sets its own prices.", evidence: [protections] },
      { text: "The upgrade authority can replace this program's code, so how it trades can change after you read this.", evidence: [authority] },
      { text: "Canary's results for this version are in the facts panel, each with the sizes it tested.", evidence: [canary] },
    ],
    claims: [
      { topic: "does", basis: "inferred", text: "It appears to quote and trade from vaults it holds itself, as Pipeline strategies do.", evidence: [protections] },
      { topic: "control", basis: "confirmed", text: "The upgrade authority can replace this program's code at any time.", evidence: [authority] },
      { topic: "canary", basis: "confirmed", text: "Canary traded a private copy of its markets and recorded what came back.", evidence: [canary] },
      { topic: "protection", basis: "confirmed", text: "A swap through the router gets its minimum received and takes nothing beyond what you signed.", evidence: [protections] },
      { topic: "protection", basis: "confirmed", text: "Custom actions are signed directly on the strategy, without the router's protections.", evidence: [custom] },
    ],
    unknowns: [{ text: "No verified source is in the evidence, so how it computes prices and fees is not shown.", evidence: [verified] }],
    author_text_addresses_ai: false,
  };
}

/** Gives the strategy's current key its explanation, unless it already has one. */
async function explain(db: Db, program: string, extra: Explanation["claims"] = []): Promise<void> {
  const [strategy] = await db.select({ metadataUri: strategies.metadataUri }).from(strategies).where(eq(strategies.program, program));
  if (!strategy) throw new Error(`${program} is not indexed: the recording has moved on`);
  const now = await currentExplainerKey(db, program, strategy.metadataUri);
  if (!now.key) throw new Error(`${program} has no current explainer key`);
  const row = await readExplainerKey(db, now.key);
  if (!row) throw new Error(`the key ${now.key} of ${program} was not made`);
  if (row.status === "done") return;
  const evidence = row.evidence as EvidenceItem[];
  const explanation = explanationFrom(evidence);
  const validation = validate(evidence, explanation);
  if (!validation.pass) throw new Error(`the seeded explanation of ${program} fails the validator: ${JSON.stringify(validation.checks.filter((c) => !c.ok))}`);
  explanation.claims.push(...extra);
  await finishExplainerKey(db, now.key, { status: "done", explanation, validation, attempts: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, failure: null });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    // Every strategy's key, as the job makes them every 5 minutes, so the others are pending.
    await makeExplainerKeys(db);
    await explain(db, EXPLAINED_STRATEGY);
    if (HOSTILE_STRATEGY && HOSTILE_TEXT) await explain(db, HOSTILE_STRATEGY, [{ topic: "author", basis: "author", text: HOSTILE_TEXT, evidence: [] }]);
  } finally {
    await close();
  }
}

await main();
