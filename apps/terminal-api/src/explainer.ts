// Explainer jobs (docs/spec/pipescope-architecture.md, "Explainer jobs"; docs/spec/pipescope-explainer.md,
// "When an explanation is made" and Inputs; EXPLAINER-04 to EXPLAINER-07, EXPLAINER-23): for each
// strategy's current version, its key; for a key not seen before, the evidence the model is to read,
// built only from what Aviary holds, stored pending with its estimated cost for the owner to approve.
// Nothing here calls a model: no LLM key or SDK is in `terminal-api` (PIPESCOPE-37).
//
// The `explainerKeys` job runs this on the dispatcher's schedule (./config), so a new version, a
// `MetadataUpdated` (a new metadata snapshot), changed Canary outcomes, or a new prompt or model in
// the rules module each make a key within one interval, and nothing else does (EXPLAINER-23).
//
// The evidence: P items, Pipeline's rules (terminal-explainer); F items, the program and its version,
// its instructions, its markets and the markets this version cannot read, the representative market
// (most swaps through Pipeline, then the largest SOL vault; EXPLAINER-03) with its mints and vaults,
// and the transactions observed; C items, Canary's records; A items, the normalised metadata, with
// the F items of what code checked of it. S items wait for verified builds (#128).
import { FLAG_DESCRIPTIONS } from "@pipeline-sol/sdk";
import { and, asc, count, countDistinct, desc, eq, inArray, max, min, sql } from "drizzle-orm";
import {
  canaryResults,
  hasExplainerKey,
  reviveExplainerKey,
  marketMints,
  markets,
  metadataSnapshots,
  programFacts,
  programVersions,
  readCanaryLatest,
  recordExplainerKey,
  strategies,
  trades,
  type CanaryRecord,
  type Db,
} from "terminal-db";
import {
  assembleEvidence,
  authorEvidence,
  EVIDENCE_LIMITS,
  estimateCost,
  explainerKey,
  pipelineRules,
  type EvidenceItem,
  type Fact,
  type MetadataStatus,
  type NormalisedMetadata,
  type Removed,
} from "terminal-explainer";
import type { StrategyMetadata } from "@pipeline-sol/sdk";
import { CHECK_ABOUT } from "./canarySentences";
import { AVIARY_MINT_NAMES, WRAPPED_SOL } from "./config";
import { mintFacts } from "./facts";
import { ROUTER } from "./indexerCore";
import { readStrategyInstructions } from "./strategies";

const MONTH_PAD = (n: number) => String(n).padStart(2, "0");
/** "2026-11-08 21:10 UTC": the form the validator finds dates and times in. */
const utc = (d: Date) => `${d.getUTCFullYear()}-${MONTH_PAD(d.getUTCMonth() + 1)}-${MONTH_PAD(d.getUTCDate())} ${MONTH_PAD(d.getUTCHours())}:${MONTH_PAD(d.getUTCMinutes())} UTC`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A u64 amount in whole tokens, with no grouping and no trailing zeros. */
function units(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / scale}${fraction ? `.${fraction}` : ""}`;
}
const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

type Version = typeof programVersions.$inferSelect;
type Snapshot = typeof metadataSnapshots.$inferSelect;

/** What one strategy's current version stands on, read once for its key and its evidence. */
type Current = { program: string; version: Version; snapshot: Snapshot; outcomes: { market: string; check: string; outcome: string }[] };

/** The strategy's current version, its metadata as last fetched, and its latest Canary outcomes; null with why it must wait. */
async function current(db: Db, program: string, metadataUri: string): Promise<Current | "no-version" | "metadata-not-fetched"> {
  const [version] = await db.select().from(programVersions).where(and(eq(programVersions.program, program), eq(programVersions.role, "strategy"))).orderBy(desc(programVersions.deploySlot)).limit(1);
  if (!version) return "no-version";
  const [snapshot] = await db.select().from(metadataSnapshots).where(eq(metadataSnapshots.program, program)).orderBy(desc(metadataSnapshots.id)).limit(1);
  if (!snapshot || snapshot.uri !== metadataUri) return "metadata-not-fetched";
  const outcomes = await db
    .select({ market: canaryResults.market, check: canaryResults.check, outcome: canaryResults.outcome })
    .from(canaryResults)
    .where(and(eq(canaryResults.program, program), eq(canaryResults.deploySlot, version.deploySlot), eq(canaryResults.latest, true)));
  return { program, version, snapshot, outcomes };
}

const authorOf = (snapshot: Snapshot) => (snapshot.status === "valid" ? (snapshot.normalised as NormalisedMetadata) : null);

/**
 * The author part of the key (EXPLAINER-23): the normalised author text, and with it what else of
 * the metadata the evidence states, its status and whether it has a seeding section, so a change of
 * either makes a new key.
 */
const keyAuthorOf = (snapshot: Snapshot) => ({ status: snapshot.status, text: authorOf(snapshot), seed: snapshot.status === "valid" && Boolean((snapshot.document as StrategyMetadata | null)?.seed) });

/** The program and its version: who can change it, this version and those before it, its build, its instructions. */
async function programItems(db: Db, { program, version }: Current): Promise<{ facts: Fact[]; instructions: { name: string }[] | null; custom: Fact | null }> {
  const facts: Fact[] = [];
  const watch = "Aviary's ProgramData watch";
  facts.push({ group: "Program", label: "Program", value: program, source: "Pipeline's router, the strategy's registration" });
  const [own] = await db.select().from(programFacts).where(eq(programFacts.program, program));
  const authority = own?.upgradeAuthority
    ? `${own.upgradeAuthority}; not frozen, so this key can replace the code. ${FLAG_DESCRIPTIONS.upgradeable}`
    : own?.flags.includes("frozen")
      ? `None: the program is frozen, so its code can no longer change. ${FLAG_DESCRIPTIONS.frozen}`
      : "Not read by Aviary yet.";
  facts.push({ group: "Program", label: "Upgrade authority", value: authority, source: own?.readSlot ? `${watch}, slot ${own.readSlot}` : watch });
  const when = version.blockTime ? `, ${utc(version.blockTime)}` : "";
  facts.push({ group: "Program", label: "This version", value: `Deployed in slot ${version.deploySlot}${when}${version.executableSha256 ? `; executable hash ${version.executableSha256}` : ""}`, source: `${watch}; the hash as Pipeline's SDK computes it` });
  const versions = await db.select().from(programVersions).where(and(eq(programVersions.program, program), eq(programVersions.role, "strategy"))).orderBy(asc(programVersions.deploySlot));
  const each = versions.map((v) => `slot ${v.deploySlot}${v.blockTime ? ` (${utc(v.blockTime)})` : ""}${v.deploySlot === version.deploySlot ? ", this one" : ""}`);
  facts.push({ group: "Program", label: "Version history", value: `${plural(versions.length, "version")}: ${list(each)}.`, source: watch });
  facts.push({ group: "Program", label: "Verified build", value: "None: Aviary has not verified the deployed program against any source.", source: "Aviary's verified builds (none run on this version)" });

  const read = await readStrategyInstructions(db, program, { deploySlot: version.deploySlot, signersShown: EVIDENCE_LIMITS.signersShown });
  if (!read.anchor) {
    facts.push({ group: "Program", label: "Instructions in the deployed program", value: "Aviary could not read the instruction names in this version's code.", source: "names compiled into the program binary" });
    return { facts, instructions: null, custom: null };
  }
  const pipeline = read.instructions.filter((i) => i.pipeline).map((i) => i.name);
  const others = read.instructions.filter((i) => !i.pipeline).map((i) => i.name);
  const own6 = pipeline.length === 6 ? `Pipeline's six (${pipeline.join(", ")})` : `${plural(pipeline.length, "of Pipeline's six")} (${pipeline.join(", ") || "none"})`;
  facts.push({
    group: "Program",
    label: "Instructions in the deployed program",
    value: `${read.instructions.length}: ${own6}${others.length ? ` and ${others.length} more: ${others.join(", ")}` : ", and no other"}.`,
    source: "names compiled into the program binary, each with its discriminator found in the code",
  });
  const called = read.instructions
    .filter((i) => !i.pipeline && i.calls > 0)
    .map((i) => `${i.name}: ${plural(i.calls, "call")}, by ${plural(i.signers_total, "signer")} (${i.signers.map((s) => `${s.address}: ${s.calls}`).join(", ")}${i.signers_total > i.signers.length ? ", and others" : ""})`);
  const custom: Fact = {
    group: "Observed",
    label: "Custom actions called",
    value: called.length ? `${called.join("; ")}.` : others.length ? "None of its other instructions has been called." : "It has no instruction beyond Pipeline's.",
    source: "every successful call on the strategy program Aviary indexed",
  };
  return { facts, instructions: read.instructions.map((i) => ({ name: i.name })), custom };
}

/** The strategy's markets, the ones this version cannot read, and the representative market with its mints, vaults and trading. */
async function marketItems(db: Db, { program, outcomes }: Current): Promise<{ facts: Fact[]; representative: string | null }> {
  const facts: Fact[] = [];
  const rows = await db
    .select({ address: markets.address, createdAt: markets.createdAt, createdBy: markets.createdBy, swaps: sql<number>`(select count(*)::int from ${trades} t where t.market = ${markets.address})`, sol: sql<string | null>`(select mm.vault_amount::text from ${marketMints} mm where mm.market = ${markets.address} and mm.mint = ${WRAPPED_SOL} limit 1)` })
    .from(markets)
    .where(eq(markets.strategyProgram, program));
  if (!rows.length) {
    facts.push({ group: "Program", label: "Markets", value: "No markets registered with Pipeline.", source: "Pipeline's router, every market Aviary indexed" });
    return { facts, representative: null };
  }
  const first = rows.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
  facts.push({ group: "Program", label: "Markets", value: `${plural(rows.length, "market")} registered with Pipeline, the first created ${utc(first.createdAt)}.`, source: "Pipeline's router, every market Aviary indexed" });

  const readable = outcomes.filter((o) => o.check === "readable");
  const unreadable = readable.filter((o) => o.outcome === "fail").map((o) => o.market).sort();
  facts.push({
    group: "Program",
    label: "Markets this version cannot read",
    value: !readable.length
      ? "Not known: Canary's readable check has not run on this version's markets."
      : unreadable.length
        ? `${unreadable.length} of the ${plural(readable.length, "market")} Canary has checked on this version: ${list(unreadable)}, where its readable check failed.`
        : `None of the ${plural(readable.length, "market")} Canary has checked on this version.`,
    source: "Canary's readable check, latest result per market",
  });

  const sol = (r: (typeof rows)[number]) => BigInt(r.sol ?? "0");
  const [rep] = [...rows].sort((a, b) => b.swaps - a.swaps || (sol(b) > sol(a) ? 1 : sol(b) < sol(a) ? -1 : 0) || a.address.localeCompare(b.address));
  const why = rep!.swaps > 0 ? `the market with the most swaps through Pipeline (${rep!.swaps})` : rep!.sol ? "no market has a swap through Pipeline, so the one with the largest SOL vault" : "no market has a swap through Pipeline or a SOL vault, so the first by address";
  facts.push({ group: "Market", label: "Sampled market", value: `${rep!.address}, ${why}; created ${utc(rep!.createdAt)} by ${rep!.createdBy}.`, source: "markets and trades Aviary indexed" });

  const mints = await mintFacts(db, rep!.address);
  const vaults: string[] = [];
  for (const m of mints) {
    const name = m.mint === WRAPPED_SOL ? "Wrapped SOL" : `Token ${m.mint}`;
    if (!m.readable) {
      // A mint with no read slot has not been read by Aviary yet, which says nothing of its account.
      const value = m.read_slot === null ? "Not read by Aviary yet." : "Its account is missing or is not a token mint.";
      facts.push({ group: "Market", label: name, value, source: "the mint account" });
      continue;
    }
    const extensions = m.extensions.length
      ? `Extensions: ${m.extensions.map((e) => [e.name, e.detail, e.address ? `program or address ${e.address}` : null, e.authority ? `authority ${e.authority}` : null].filter(Boolean).join(", ")).join("; ")}.`
      : "No extensions.";
    facts.push({
      group: "Market",
      label: name,
      value: `${m.token_program === "Token-2022" ? "Token-2022" : "SPL Token"}${m.decimals === null ? "" : `, ${m.decimals} decimals`}. Mint authority: ${m.mint_authority ?? "none"}. Freeze authority: ${m.freeze_authority ?? "none"}. ${extensions}`,
      source: m.read_slot ? `the mint account, slot ${m.read_slot}` : "the mint account",
    });
    if (m.vault_amount !== null && m.decimals !== null) vaults.push(m.mint === WRAPPED_SOL ? `${units(m.vault_amount, m.decimals)} ${AVIARY_MINT_NAMES[WRAPPED_SOL]}` : `${units(m.vault_amount, m.decimals)} of token ${m.mint}`);
  }
  if (vaults.length) facts.push({ group: "Market", label: "Vaults of the sampled market", value: `${list(vaults)}.`, source: "the market's vault accounts, as last read" });

  const [own] = await db.select({ swaps: count(), wallets: countDistinct(trades.trader), first: min(trades.blockTime), last: max(trades.blockTime) }).from(trades).where(eq(trades.market, rep!.address));
  facts.push({
    group: "Observed",
    label: "Trading on the sampled market",
    value: own && own.swaps > 0 ? `${plural(own.swaps, "swap")} through Pipeline from ${plural(own.wallets, "wallet")}${own.first && own.last ? `, from ${utc(own.first)} to ${utc(own.last)}` : ""}.` : "No swaps through Pipeline.",
    source: "every swap through the router Aviary indexed",
  });
  const [all] = await db.select({ swaps: count(), wallets: countDistinct(trades.trader) }).from(trades).where(inArray(trades.market, rows.map((r) => r.address)));
  facts.push({ group: "Observed", label: "Trading on all markets", value: `${plural(all?.swaps ?? 0, "swap")} through Pipeline across its ${plural(rows.length, "market")}, from ${plural(all?.wallets ?? 0, "wallet")}.`, source: "every swap through the router Aviary indexed" });
  return { facts, representative: rep!.address };
}

/** Canary's records for this version: the representative market's latest of each check, the roll-up, and the checks not run. */
async function canaryItems(db: Db, { program, version, outcomes }: Current, representative: string | null): Promise<Fact[]> {
  if (!outcomes.length) return [{ group: "Canary", label: "Canary", value: "Canary has not run on this version yet.", source: "Canary's results in Aviary" }];
  const items: Fact[] = [];
  const latest = representative ? await readCanaryLatest(db, { market: representative, version: { program, deploySlot: version.deploySlot } }) : [];
  const order = Object.keys(CHECK_ABOUT);
  const rank = (check: string) => (order.includes(check) ? order.indexOf(check) : order.length);
  for (const r of [...latest].sort((a, b) => rank(a.check) - rank(b.check))) {
    const record = r.record as CanaryRecord;
    const inputs = JSON.stringify(record.inputs ?? {});
    items.push({
      group: "Canary",
      label: `Canary check ${r.check} on the sampled market`,
      value: `Run on ${utc(new Date(record.run_at * 1000))} at slot ${record.slot}, on this version: ${record.outcome}. ${record.reason} Inputs: ${inputs.length > EVIDENCE_LIMITS.canaryInputsCharacters ? `${inputs.slice(0, EVIDENCE_LIMITS.canaryInputsCharacters)}...` : inputs}`,
      source: `Canary record ${record.id}, harness ${record.harness}`,
    });
  }
  const byCheck = new Map<string, Map<string, number>>();
  for (const o of outcomes) {
    const counts = byCheck.get(o.check) ?? new Map<string, number>();
    counts.set(o.outcome, (counts.get(o.outcome) ?? 0) + 1);
    byCheck.set(o.check, counts);
  }
  const marketsChecked = new Set(outcomes.map((o) => o.market)).size;
  const rollup = [...byCheck.keys()]
    .sort()
    .map((check) => `${check}: ${[...byCheck.get(check)!].map(([outcome, n]) => `${outcome} on ${n}`).join(", ")}`);
  items.push({ group: "Canary", label: "Canary across the version's markets", value: `${plural(marketsChecked, "market")} checked. ${rollup.join(". ")}.`, source: "Canary's latest result of each check on each market of this version" });
  if (representative) {
    const ran = new Set(latest.map((r) => r.check));
    const missing = order.filter((c) => !ran.has(c));
    if (missing.length) items.push({ group: "Canary", label: "Canary checks not run on the sampled market", value: `Not run yet: ${missing.join(", ")}.`, source: "Canary's checks (docs/spec/pipescope-canary.md) against its results on the sampled market" });
  }
  return items;
}

/** The evidence of a strategy's current version, and what its key row records beside it. */
async function buildEvidence(db: Db, at: Current): Promise<{ evidence: EvidenceItem[]; representative: string | null; addressesAi: boolean }> {
  const [router] = await db.select({ upgradeAuthority: programFacts.upgradeAuthority }).from(programFacts).where(eq(programFacts.program, ROUTER));
  const program = await programItems(db, at);
  const market = await marketItems(db, at);
  const canary = await canaryItems(db, at, market.representative);
  const { snapshot } = at;
  const author = authorEvidence({
    status: snapshot.status as MetadataStatus,
    metadata: snapshot.status === "valid" ? (snapshot.document as StrategyMetadata) : null,
    normalised: authorOf(snapshot),
    removed: snapshot.status === "valid" ? (snapshot.removed as Removed) : null,
    instructions: program.instructions,
  });
  const facts = [...program.facts, ...author.facts, ...market.facts, ...(program.custom ? [program.custom] : [])];
  const evidence = assembleEvidence({ pipeline: pipelineRules({ routerUpgradeAuthority: router?.upgradeAuthority ?? null }), facts, canary, author: author.author });
  return { evidence, representative: market.representative, addressesAi: author.addressesAi };
}

/**
 * Makes the key of each strategy's current version (of `programs`, or of every strategy), and for
 * each key not recorded yet builds its evidence and records it pending. Says which strategies got a
 * new key, and which wait for their metadata's new link to be fetched.
 */
export async function makeExplainerKeys(db: Db, { programs }: { programs?: string[] } = {}): Promise<{ made: string[]; revived: string[]; waiting: string[] }> {
  const rows = await db.select({ program: strategies.program, metadataUri: strategies.metadataUri }).from(strategies).where(programs ? inArray(strategies.program, programs) : undefined);
  const made: string[] = [];
  const revived: string[] = [];
  const waiting: string[] = [];
  for (const { program, metadataUri } of rows) {
    const at = await current(db, program, metadataUri);
    if (at === "no-version") continue;
    if (at === "metadata-not-fetched") {
      waiting.push(program);
      continue;
    }
    const key = await explainerKey({ program, deploySlot: at.version.deploySlot, author: keyAuthorOf(at.snapshot), canary: at.outcomes });
    // A key recorded before is current again (an outcome flipped back): it alone stays in the queue.
    if (await hasExplainerKey(db, key.id)) {
      if (await reviveExplainerKey(db, key.id)) revived.push(program);
      continue;
    }
    const { evidence, representative, addressesAi } = await buildEvidence(db, at);
    const cost = estimateCost({ program, deploySlot: at.version.deploySlot, evidence });
    const { id, ...parts } = key;
    if (await recordExplainerKey(db, { key: id, ...parts, evidence, representativeMarket: representative, authorTextAddressesAi: addressesAi, estimatedInputTokens: cost.inputTokens, estimatedCostUsd: cost.usd })) made.push(program);
  }
  return { made: made.sort(), revived: revived.sort(), waiting: waiting.sort() };
}
