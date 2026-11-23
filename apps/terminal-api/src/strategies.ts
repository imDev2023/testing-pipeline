// A strategy's versions and its instructions, and the router's versions (docs/spec/pipescope-architecture.md,
// API and Indexer; the zod contract in ./contract), from what the indexer's ProgramData watch and
// its reconciliation of strategy programs keep in Postgres.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { programVersions, strategies, strategyCalls, strategyInstructions, type Db } from "terminal-db";
import { INSTRUCTION_SIGNERS_SHOWN } from "./config";
import { RouterVersions, StrategyInstructions, StrategyVersions, type StrategyInstruction } from "./contract";
import { notFound } from "./feed";
import { ROUTER } from "./indexerCore";
import { dbOf, requestDb, type DbEnv } from "./requestDb";

export const strategyRoutes = new Hono<DbEnv>();

strategyRoutes.use(requestDb);

type VersionRow = typeof programVersions.$inferSelect;

/** A program's versions, newest first. */
const versionsOf = (db: Db, program: string): Promise<VersionRow[]> => db.select().from(programVersions).where(eq(programVersions.program, program)).orderBy(desc(programVersions.deploySlot));

const versionView = (v: VersionRow, i: number) => ({
  deploy_slot: Number(v.deploySlot),
  executable_sha256: v.executableSha256,
  signature: v.signature,
  deployed_at: v.blockTime?.toISOString() ?? null,
  seen_at: v.seenAt.toISOString(),
  backfilled: v.backfilled,
  current: i === 0,
});

async function knownStrategy(db: Db, program: string): Promise<void> {
  const [row] = await db.select({ program: strategies.program }).from(strategies).where(eq(strategies.program, program));
  if (!row) throw notFound("strategy registered with Pipeline");
}

strategyRoutes.get("/v1/strategies/:program/versions", async (c) => {
  const db = dbOf(c);
  const program = c.req.param("program");
  await knownStrategy(db, program);
  return c.json(StrategyVersions.parse({ program, versions: (await versionsOf(db, program)).map(versionView) }));
});

/**
 * The instructions of a strategy's current version, each with how often it has been called and by
 * which signers, counted over the strategy program's whole history by discriminator, which names an
 * instruction across versions. `signersShown` caps each list; the snapshot Canary's runs post (#124)
 * passes none, for every signer.
 */
export async function readStrategyInstructions(db: Db, program: string, { signersShown }: { signersShown?: number } = {}): Promise<StrategyInstructions> {
  const [current] = await versionsOf(db, program);
  if (!current) return { program, deploy_slot: null, anchor: null, instructions: [] };
  const list = await db
    .select()
    .from(strategyInstructions)
    .where(and(eq(strategyInstructions.program, program), eq(strategyInstructions.deploySlot, current.deploySlot)))
    .orderBy(asc(strategyInstructions.position));
  // Per instruction: its calls, and its signers ranked by their calls and cut to the most shown in
  // Postgres, so a strategy whose router swaps each carry a new trader never sends every pair over.
  const limit = signersShown ?? null;
  const [calls, signers] = await Promise.all([
    db
      .select({ discriminator: strategyCalls.discriminator, calls: sql<number>`count(*)::int` })
      .from(strategyCalls)
      .where(eq(strategyCalls.program, program))
      .groupBy(strategyCalls.discriminator),
    db.execute<{ discriminator: string; address: string; calls: number; total: number }>(sql`
      select discriminator, address, calls, total
      from (
        select ${strategyCalls.discriminator} as discriminator, signer as address, count(*)::int as calls,
               row_number() over (partition by ${strategyCalls.discriminator} order by count(*) desc, signer asc) as rank,
               (count(*) over (partition by ${strategyCalls.discriminator}))::int as total
        from ${strategyCalls}, unnest(${strategyCalls.signers}) as signer
        where ${strategyCalls.program} = ${program}
        group by 1, 2
      ) ranked
      where ${limit}::int is null or rank <= ${limit}::int
      order by discriminator, rank
    `),
  ]);
  const rows = [...signers];
  const instructions = list.map((i): StrategyInstruction => {
    const own = rows.filter((s) => s.discriminator === i.discriminator);
    return {
      name: i.name,
      discriminator: i.discriminator,
      pipeline: i.pipeline,
      calls: calls.find((x) => x.discriminator === i.discriminator)?.calls ?? 0,
      signers: own.map((s) => ({ address: s.address, calls: Number(s.calls) })),
      signers_total: own.length ? Number(own[0]!.total) : 0,
    };
  });
  return { program, deploy_slot: Number(current.deploySlot), anchor: current.anchor, instructions };
}

strategyRoutes.get("/v1/strategies/:program/instructions", async (c) => {
  const db = dbOf(c);
  const program = c.req.param("program");
  await knownStrategy(db, program);
  return c.json(StrategyInstructions.parse(await readStrategyInstructions(db, program, { signersShown: INSTRUCTION_SIGNERS_SHOWN })));
});

strategyRoutes.get("/v1/router", async (c) => {
  const versions = await versionsOf(dbOf(c), ROUTER);
  return c.json(RouterVersions.parse({ program: ROUTER, versions: versions.map((v, i) => ({ ...versionView(v, i), flagged: v.flagged })) }));
});
