// The explanation on the pages (docs/spec/pipescope-explainer.md, Presentation and The validator;
// docs/spec/pipescope-screens.md, "Explanation, actions and facts" and Strategy page; EXPLAINER-14,
// EXPLAINER-15, EXPLAINER-16, EXPLAINER-20; #127).
//
// `GET /v1/strategies/{program}/explanation` serves the explanation of the strategy's current
// version, only for the key that version has now (./explainer, `currentExplainerKey`) and only once
// the owner's approve command wrote it, with the code-written label and the evidence the model was
// given, which a page's evidence chips point into; and the fixed notice about author text addressed
// to AI tools, whenever Aviary's detector or the shown explanation's own flag fires, explanation or
// not. `POST /v1/explanations/{key}/reports` files a "This is wrong" report against a key with an
// explanation, counted per IP in the REPORTS binding; `pnpm explainer:reports` lists them.
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { Hono, type MiddlewareHandler } from "hono";
import { explainerKeys, readExplainerKey, recordExplainerReport, strategies, type Db } from "terminal-db";
import { AI_ADDRESSED_NOTICE, type EvidenceItem, type Explanation } from "terminal-explainer";
import { dayOf } from "./canarySentences";
import { REPORT_NOTE_MAX } from "./config";
import { type ApiError, ExplanationReport, ExplanationReportReceived, StrategyExplanation } from "./contract";
import { currentExplainerKey } from "./explainer";
import { notFound } from "./feed";
import { refuse } from "./rateLimits";
import { dbOf, requestDb, type DbEnv } from "./requestDb";

export const explanationRoutes = new Hono<DbEnv>();

explanationRoutes.use("/v1/strategies/:program/explanation", requestDb);
explanationRoutes.use("/v1/explanations/*", requestDb);

/**
 * The line above an explanation (EXPLAINER-16): "Written by an AI on 24 Nov 2026 from on-chain data
 * and Canary results for this strategy version (deployed in slot 520,151,682). It can be wrong. It is
 * not an audit, a safety rating or advice." It names the verified source only when the evidence held
 * excerpts of it (S items).
 */
export function explanationLabel({ writtenAt, deploySlot, verifiedSource }: { writtenAt: Date; deploySlot: bigint; verifiedSource: boolean }): string {
  return `Written by an AI on ${dayOf(writtenAt)} from on-chain data${verifiedSource ? ", its verified source" : ""} and Canary results for this strategy version (deployed in slot ${deploySlot.toLocaleString("en-US")}). It can be wrong. It is not an audit, a safety rating or advice.`;
}

/** What a page shows of a strategy's explanation. */
export async function readStrategyExplanation(db: Db, program: string): Promise<StrategyExplanation> {
  const [strategy] = await db.select({ metadataUri: strategies.metadataUri }).from(strategies).where(eq(strategies.program, program));
  if (!strategy) throw notFound("strategy registered with Pipeline");
  const now = await currentExplainerKey(db, program, strategy.metadataUri);
  const deploy_slot = now.deploySlot === null ? null : Number(now.deploySlot);
  const row = now.key === null ? null : await readExplainerKey(db, now.key);
  const shown = row?.status === "done" && row.explanation !== null && row.finishedAt !== null ? row : null;
  const output = shown?.explanation as Explanation | undefined;
  const evidence = (shown?.evidence ?? []) as EvidenceItem[];
  return StrategyExplanation.parse({
    program,
    deploy_slot,
    ai_notice: now.addressesAi || output?.author_text_addresses_ai ? AI_ADDRESSED_NOTICE : null,
    explanation:
      shown && output
        ? {
            key: shown.key,
            deploy_slot: Number(shown.deploySlot),
            written_at: shown.finishedAt!.toISOString(),
            label: explanationLabel({ writtenAt: shown.finishedAt!, deploySlot: shown.deploySlot, verifiedSource: evidence.some((e) => e.id.startsWith("S")) }),
            summary: output.summary,
            claims: output.claims,
            unknowns: output.unknowns,
            evidence: evidence.map((e) => ({ id: e.id, label: e.label, value: e.value, source: e.source, author: e.id.startsWith("A") })),
          }
        : null,
  });
}

explanationRoutes.get("/v1/strategies/:program/explanation", async (c) => c.json(await readStrategyExplanation(dbOf(c), c.req.param("program"))));

/** "This is wrong" reports, counted per IP in the REPORTS binding (PIPESCOPE-90). */
const limitReports: MiddlewareHandler<DbEnv> = async (c, next) => {
  const { success } = await c.env.REPORTS.limit({ key: c.req.header("cf-connecting-ip") ?? "unknown" });
  return success ? next() : refuse(c);
};

/** A request body as JSON, an empty body as `{}` (a report with no note), and anything else as null, which the contract refuses. */
function jsonOrEmpty(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

explanationRoutes.post("/v1/explanations/:key/reports", limitReports, async (c) => {
  const body = ExplanationReport.safeParse(jsonOrEmpty(await c.req.text()));
  if (!body.success) return c.json<ApiError>({ error: `A report is JSON with at most a note of up to ${REPORT_NOTE_MAX} characters.` }, 400);
  const db = dbOf(c);
  const key = c.req.param("key");
  const [row] = await db.select({ status: explainerKeys.status, explanation: explainerKeys.explanation }).from(explainerKeys).where(eq(explainerKeys.key, key));
  if (!row || row.status !== "done" || row.explanation === null) throw new HTTPException(404, { message: "There is no explanation with this key to report." });
  const note = body.data.note?.trim() ? body.data.note.trim() : null;
  const id = await recordExplainerReport(db, { key, note });
  return c.json(ExplanationReportReceived.parse({ id: String(id), key }), 201);
});
