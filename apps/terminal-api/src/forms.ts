// A strategy's forms (docs/spec/pipescope.md, Custom-action and create-market forms;
// docs/spec/pipescope-screens.md, Explanation, actions and facts, and Create market): its actions and
// its create form, from its newest metadata as Pipeline's validator accepted it, checked against the
// instruction list of its current version (PIPESCOPE-92) by the discriminator each sends.
//
// Pipeline 0.2 dropped custom actions from its metadata standard, so our strategies describe theirs
// under `aviary_actions` (BAR-41), which the `strategy-actions` package validates and builds; other
// strategies may still carry Pipeline's old `actions` section, the same shape, which Aviary reads
// when there is no `aviary_actions` (PIPESCOPE-141). Every author text is normalised as the pages
// and the explainer see it (EXPLAINER-08) and is never more than plain text.
import { anchorDiscriminator, parseAccountSource, type AccountSource as SdkSource, type MetadataAccount, type MetadataArg, type MetadataInit } from "@pipeline-sol/sdk";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { parseAviaryActions, type AviaryAction } from "strategy-actions";
import { metadataSnapshots, programVersions, strategies, strategyInstructions, type Db } from "terminal-db";
import { authorText, AUTHOR_TEXT_CAPS } from "terminal-explainer";
import { StrategyForms, type AccountSource, type Form, type FormCheck, type PdaSeed } from "./contract";
import { notFound } from "./feed";
import { dbOf, requestDb, type DbEnv } from "./requestDb";

/** The instruction the router's `create_market` calls on the strategy with the create form's data. */
export const INIT_INSTRUCTION = "pipeline_init_market";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** An account source as the contract carries it: the SDK's parse, with seed bytes in hex. */
function sourceView(source: SdkSource): AccountSource {
  switch (source.kind) {
    case "pda":
      return { kind: "pda", program: source.program, seeds: source.seeds.map(seedView) };
    case "ata":
      return { kind: "ata", owner: sourceView(source.owner), mint: sourceView(source.mint) };
    case "token_program_of":
      return { kind: "token_program_of", mint: sourceView(source.mint) };
    default:
      return source as AccountSource;
  }
}

function seedView(seed: Extract<SdkSource, { kind: "pda" }>["seeds"][number]): PdaSeed {
  switch (seed.kind) {
    case "hex":
      return { kind: "hex", hex: hex(seed.bytes) };
    case "key":
      return { kind: "key", source: sourceView(seed.source) };
    default:
      return seed;
  }
}

/** A source string the validator accepted, parsed; the validators refuse any that does not parse. */
function parsed(text: string): AccountSource {
  const source = parseAccountSource(text);
  if (typeof source === "string") throw new Error(`an accepted account source does not parse: ${source}`);
  return sourceView(source);
}

/** The addresses a form asks the user for, in the order they first appear, each marked when it is used as a mint. */
function inputsOf(sources: AccountSource[]): Form["inputs"] {
  const found = new Map<string, boolean>();
  const visit = (source: AccountSource, asMint: boolean) => {
    switch (source.kind) {
      case "input":
        found.set(source.name, (found.get(source.name) ?? false) || asMint);
        return;
      case "pda":
        for (const seed of source.seeds) if (seed.kind === "key") visit(seed.source, false);
        return;
      case "ata":
        visit(source.owner, false);
        visit(source.mint, true);
        return;
      case "token_program_of":
        visit(source.mint, true);
        return;
    }
  };
  // Whether a source is a mint is known only once every use is seen, so each is visited in order and marked as it goes.
  for (const source of sources) visit(source, false);
  return [...found].map(([name, mint]) => ({ name, mint }));
}

type Listed = { name: string; discriminator: string; pipeline: boolean };

/** The check of a form that sends `discriminator`, against the version's list, or none recorded. */
function check(discriminator: string, list: Listed[] | null): FormCheck {
  if (!list) return { outcome: "warn", instruction: null, reason: "no-instruction-list" };
  const found = list.find((i) => i.discriminator === discriminator);
  return found ? { outcome: "pass", instruction: found.name, reason: "found" } : { outcome: "warn", instruction: null, reason: "not-in-program" };
}

const label = (value: unknown) => (typeof value === "string" ? authorText(value, AUTHOR_TEXT_CAPS.label).text || null : null);
const description = (value: unknown) => (typeof value === "string" ? authorText(value, AUTHOR_TEXT_CAPS.description).text || null : null);

function argsOf(args: MetadataArg[] | undefined): Form["args"] {
  return (args ?? []).map((arg) => ({ name: arg.name, type: arg.type, label: label(arg.label), description: description(arg.description), decimals_of: arg.decimals_of ? parsed(arg.decimals_of) : null }));
}

function accountsOf(accounts: MetadataAccount[] | undefined): Form["accounts"] {
  return (accounts ?? []).map((account) => ({ name: authorText(account.name, AUTHOR_TEXT_CAPS.label).text, source: parsed(account.source), writable: account.writable === true, signer: account.signer === true }));
}

function sourcesOf(form: Pick<Form, "args" | "accounts">): AccountSource[] {
  return [...form.accounts.map((a) => a.source), ...form.args.flatMap((a) => (a.decimals_of ? [a.decimals_of] : []))];
}

async function actionForm(action: AviaryAction, list: Listed[] | null): Promise<Form> {
  const discriminator = await actionDiscriminator(action);
  const args = argsOf(action.args);
  const accounts = accountsOf(action.accounts);
  return {
    name: action.name,
    label: label(action.label),
    description: description(action.description),
    kind: label(action.kind),
    discriminator,
    check: check(discriminator, list),
    args,
    accounts,
    inputs: inputsOf(sourcesOf({ args, accounts })),
    market_state: null,
  };
}

async function initForm(init: MetadataInit, list: Listed[] | null): Promise<Form> {
  const discriminator = await initDiscriminator();
  const args = argsOf(init.args);
  const accounts = accountsOf(init.accounts);
  const state = init.market_state ?? "new_keypair";
  return {
    name: INIT_INSTRUCTION,
    label: null,
    description: description(init.description),
    kind: null,
    discriminator,
    check: check(discriminator, list),
    args,
    accounts,
    inputs: inputsOf(sourcesOf({ args, accounts })),
    market_state: state === "new_keypair" ? "new_keypair" : parsed(state),
  };
}

type Document = Record<string, unknown>;

/** The actions a document describes, and in which section; `aviary_actions` wins over Pipeline's old `actions`. */
function actionsOf(document: Document): { section: "aviary_actions" | "actions" | null; result: ReturnType<typeof parseAviaryActions> } {
  if ("aviary_actions" in document) return { section: "aviary_actions", result: parseAviaryActions(document) };
  if ("actions" in document) {
    // The old section has the shape ours has, so the same validator reads it; its findings name its own key.
    const result = parseAviaryActions({ aviary_actions: document.actions });
    return { section: "actions", result: result.ok ? result : { ok: false, errors: result.errors.map((e) => e.replace(/^aviary_actions/, "actions")) } };
  }
  return { section: null, result: { ok: true, actions: [], warnings: [] } };
}

/** The instruction list of a strategy's current version, or null when none is recorded. */
async function currentList(db: Db, program: string): Promise<{ deploySlot: bigint | null; list: Listed[] | null }> {
  const [current] = await db.select({ deploySlot: programVersions.deploySlot, anchor: programVersions.anchor }).from(programVersions).where(eq(programVersions.program, program)).orderBy(desc(programVersions.deploySlot)).limit(1);
  if (!current) return { deploySlot: null, list: null };
  if (current.anchor !== true) return { deploySlot: current.deploySlot, list: null };
  const list = await db
    .select({ name: strategyInstructions.name, discriminator: strategyInstructions.discriminator, pipeline: strategyInstructions.pipeline })
    .from(strategyInstructions)
    .where(and(eq(strategyInstructions.program, program), eq(strategyInstructions.deploySlot, current.deploySlot)))
    .orderBy(asc(strategyInstructions.position));
  return { deploySlot: current.deploySlot, list };
}

/**
 * What a strategy's forms are built from: its newest metadata (not fetched when there is none, or
 * when it was fetched for a URI the strategy no longer names), the document when valid, its actions
 * and in which section, and its current version's instruction list. Null for no strategy.
 */
/** What a strategy's forms are built from, as `readFormSource` reads it. */
export type FormSource = NonNullable<Awaited<ReturnType<typeof readFormSource>>>;

export async function readFormSource(db: Db, program: string) {
  const [known] = await db.select({ program: strategies.program, uri: strategies.metadataUri }).from(strategies).where(eq(strategies.program, program));
  if (!known) return null;
  const [[newest], { deploySlot, list }] = await Promise.all([
    db.select().from(metadataSnapshots).where(eq(metadataSnapshots.program, program)).orderBy(desc(metadataSnapshots.id)).limit(1),
    currentList(db, program),
  ]);
  const snapshot = newest && newest.uri === known.uri ? newest : null;
  const status = snapshot ? (snapshot.status as StrategyForms["metadata"]) : "not-fetched";
  const document = status === "valid" && snapshot?.document ? (snapshot.document as Document) : null;
  return { program, status, errors: snapshot?.errors ?? [], document, actions: document ? actionsOf(document) : null, init: document?.init ? (document.init as MetadataInit) : null, deploySlot, list };
}

/** A strategy's forms now, or null for a program registered as no strategy. */
export async function readStrategyForms(db: Db, program: string): Promise<StrategyForms | null> {
  const source = await readFormSource(db, program);
  if (!source) return null;
  const { status, list, deploySlot } = source;
  const base = {
    program,
    deploy_slot: deploySlot === null ? null : Number(deploySlot),
    instructions_beyond_pipeline: list ? list.filter((i) => !i.pipeline).length : null,
  };
  if (!source.document || !source.actions) {
    return { ...base, metadata: status, actions_section: null, unavailable: `metadata-${status === "valid" ? "invalid" : status}` as StrategyForms["unavailable"], errors: source.errors, actions: [], init: null };
  }
  const { section, result } = source.actions;
  const init = source.init ? await initForm(source.init, list) : null;
  if (!result.ok) return { ...base, metadata: "valid", actions_section: section, unavailable: "actions-invalid", errors: result.errors, actions: [], init };
  return { ...base, metadata: "valid", actions_section: section, unavailable: null, errors: [], actions: await Promise.all(result.actions.map((a) => actionForm(a, list))), init };
}

/** The check of a form that sends `discriminator` against a strategy's current version (PIPESCOPE-143). */
export const checkForm = check;

/** Anchor's discriminator of the create form's instruction, in hex. */
export const initDiscriminator = async () => hex(await anchorDiscriminator(INIT_INSTRUCTION));

/** The discriminator an action sends, in hex: its own, or Anchor's from its name. */
export const actionDiscriminator = async (action: AviaryAction) => (action.discriminator ? action.discriminator.toLowerCase() : hex(await anchorDiscriminator(action.name)));

export const formRoutes = new Hono<DbEnv>();

formRoutes.use(requestDb);

formRoutes.get("/v1/strategies/:program/forms", async (c) => {
  const forms = await readStrategyForms(dbOf(c), c.req.param("program"));
  if (!forms) throw notFound("strategy registered with Pipeline");
  return c.json(StrategyForms.parse(forms));
});
