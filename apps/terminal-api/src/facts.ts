// The neutral facts Aviary shows (docs/spec/pipescope.md, "Facts and Canary results"; PIPESCOPE-16):
// Pipeline's trust flags with their fixed descriptions from its SDK, so Aviary's wording is the SDK's
// and the hosted API's, and the program and mint facts behind them. A strategy's flags are its
// program's (`upgradeable`, `frozen` or `program-missing`, from the ProgramData watch) and its
// metadata's (`metadata-missing`, `metadata-unreachable` or `metadata-invalid`, from the fetcher); a
// market's are its strategy's and every mint's, as the SDK's `inspectMarket` unites them; a mint's are
// the SDK's `decodeMint`'s, kept when the mint is read. The hosted API's `checks-*` flags are not
// Aviary's (Canary's own result says the same), nor are `conformance-*`, which would need a URL
// found inside a document fetched (PIPESCOPE-36, PIPESCOPE-93); verified-build flags wait for #128.
import { decodeMint, FLAG_DESCRIPTIONS, FLAGS, type Flag, type MintExtensions } from "@pipeline-sol/sdk";
import { address } from "@solana/kit";
import { desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { marketMints, metadataSnapshots, mints, programFacts, programVersions, strategies, type Db } from "terminal-db";
import { AVIARY_MINT_NAMES } from "./config";
import type { FlagFact, MetadataStatus, MintExtension, MintFacts, Strategy } from "./contract";

/** Flags in Pipeline's SDK's stable order, each once; any the SDK does not know is left out. */
export function orderedFlags(flags: Iterable<string>): Flag[] {
  const set = new Set(flags);
  return FLAGS.filter((flag) => set.has(flag));
}

/** Flags with Pipeline's fixed description of each. */
export const flagFacts = (flags: Iterable<string>): FlagFact[] => orderedFlags(flags).map((flag) => ({ flag, description: FLAG_DESCRIPTIONS[flag] }));

/** The flag a metadata status gives, as Pipeline's SDK's `inspectStrategy` sets it; valid metadata gives none. */
export const METADATA_FLAGS = { missing: "metadata-missing", unreachable: "metadata-unreachable", invalid: "metadata-invalid" } as const satisfies Record<string, Flag>;

const caseOfStatus = (column: string) => sql.raw(`case ${column} ${Object.entries(METADATA_FLAGS).map(([status, flag]) => `when '${status}' then array['${flag}']`).join(" ")} end`);

/**
 * A market's flags in SQL, for the feed's "Hide markets with" filter and its list of the flags
 * present: its strategy's program flags and metadata flag, then every flag of its mints. Written
 * against the `markets` table of the query it is part of.
 */
export const marketFlagsSql: SQL = sql`(
  coalesce((select pf.flags from ${programFacts} pf where pf.program = "markets"."strategy_program"), '{}'::text[])
  || coalesce((select ${caseOfStatus("ms.status")} from ${metadataSnapshots} ms where ms.program = "markets"."strategy_program" order by ms.id desc limit 1), '{}'::text[])
  || coalesce((select array_agg(f) from ${marketMints} mm join ${mints} mi on mi.address = mm.mint cross join lateral unnest(mi.flags) f where mm.market = "markets"."address"), '{}'::text[])
)`;

type StrategyRow = { program: string; metadataUri: string; feePaid: string | null; registeredAt: Date; registeredSignature: string | null; marketCount: number };
type SnapshotRow = typeof metadataSnapshots.$inferSelect;
type Normalised = { name?: string; description?: string | null } | null;

/** The newest metadata snapshot of each program named. */
async function newestSnapshots(db: Db, programs: string[]): Promise<Map<string, SnapshotRow>> {
  if (!programs.length) return new Map();
  const rows = await db
    .selectDistinctOn([metadataSnapshots.program])
    .from(metadataSnapshots)
    .where(inArray(metadataSnapshots.program, programs))
    .orderBy(metadataSnapshots.program, desc(metadataSnapshots.id));
  return new Map(rows.map((r) => [r.program, r]));
}

function metadataStatus(uri: string, snapshot: SnapshotRow | undefined): MetadataStatus {
  if (!snapshot) return { status: "not-fetched", uri, url: null, fetched_at: null, checked_at: null, errors: [], warnings: [], sha256: null, removed: null };
  return {
    status: snapshot.status as MetadataStatus["status"],
    uri: snapshot.uri,
    url: snapshot.url,
    fetched_at: snapshot.fetchedAt.toISOString(),
    checked_at: snapshot.checkedAt.toISOString(),
    errors: snapshot.errors,
    warnings: snapshot.warnings,
    sha256: snapshot.sha256,
    removed: (snapshot.removed as MetadataStatus["removed"]) ?? null,
  };
}

/** What a strategy's facts rest on, read for several strategies at once: its newest metadata, its program's facts and its version in force. */
export type StrategyFacts = { name: string | null; description: string | null; metadata: MetadataStatus; flags: Flag[]; upgradeAuthority: string | null; currentVersion: Strategy["current_version"] };

export async function strategyFacts(db: Db, programs: { program: string; metadataUri: string }[]): Promise<Map<string, StrategyFacts>> {
  const names = programs.map((p) => p.program);
  if (!names.length) return new Map();
  const [snapshots, program, versions] = await Promise.all([
    newestSnapshots(db, names),
    db.select().from(programFacts).where(inArray(programFacts.program, names)),
    db.selectDistinctOn([programVersions.program]).from(programVersions).where(inArray(programVersions.program, names)).orderBy(programVersions.program, desc(programVersions.deploySlot)),
  ]);
  return new Map(
    programs.map(({ program: name, metadataUri }) => {
      const snapshot = snapshots.get(name);
      const metadata = metadataStatus(metadataUri, snapshot);
      const facts = program.find((p) => p.program === name);
      const version = versions.find((v) => v.program === name);
      const normalised = metadata.status === "valid" ? (snapshot!.normalised as Normalised) : null;
      const metadataFlag = METADATA_FLAGS[metadata.status as keyof typeof METADATA_FLAGS];
      return [
        name,
        {
          name: normalised?.name || null,
          description: normalised?.description ?? null,
          metadata,
          flags: orderedFlags([...(facts?.flags ?? []), ...(metadataFlag ? [metadataFlag] : [])]),
          upgradeAuthority: facts?.upgradeAuthority ?? null,
          currentVersion: version ? { deploy_slot: Number(version.deploySlot), executable_sha256: version.executableSha256, deployed_at: version.blockTime?.toISOString() ?? null } : null,
        },
      ];
    }),
  );
}

/** Strategies as the API serves them, with their facts. */
export async function strategyViews(db: Db, rows: StrategyRow[]): Promise<Strategy[]> {
  const facts = await strategyFacts(db, rows);
  return rows.map((s) => {
    const f = facts.get(s.program)!;
    return {
      program: s.program,
      metadata_uri: s.metadataUri,
      fee_paid: s.feePaid,
      registered_at: s.registeredAt.toISOString(),
      registered_signature: s.registeredSignature,
      market_count: s.marketCount,
      name: f.name,
      description: f.description,
      metadata: f.metadata,
      flags: f.flags,
      upgrade_authority: f.upgradeAuthority,
      current_version: f.currentVersion,
      verified_build: null,
    };
  });
}

/** The strategy columns every strategy read selects. */
export const strategyColumns = {
  program: strategies.program,
  metadataUri: strategies.metadataUri,
  feePaid: strategies.feePaid,
  registeredAt: strategies.registeredAt,
  registeredSignature: strategies.registeredSignature,
};

// ---- Mints ----

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** u64's largest value: a transfer fee's maximum set to it is no maximum. */
const U64_MAX = 2n ** 64n - 1n;
const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** A mint's Token-2022 extensions in words, from Pipeline's SDK's decoding, in a fixed order. */
export function extensionsInWords(e: MintExtensions, unknown: number[]): MintExtension[] {
  const out: MintExtension[] = [];
  const add = (name: string, detail: string | null = null, address_: string | null = null, authority: string | null = null) => out.push({ name, detail, address: address_, authority });
  if (e.transferFee) {
    const { current, newer } = e.transferFee;
    const cap = (f: typeof current) => (f.maximumFee === U64_MAX ? "with no maximum" : `at most ${f.maximumFee} of its smallest units`);
    const later = newer.epoch > current.epoch && (newer.basisPoints !== current.basisPoints || newer.maximumFee !== current.maximumFee) ? `; from epoch ${newer.epoch}, ${percent(newer.basisPoints)}, ${cap(newer)}` : "";
    add("Transfer fee", `${percent(current.basisPoints)} of each transfer, ${cap(current)}${later}`, null, e.transferFee.authority);
  }
  if (e.transferHook) add("Transfer hook", e.transferHook.programId ? "every transfer calls this program" : "no program set", e.transferHook.programId, e.transferHook.authority);
  if (e.permanentDelegate) add("Permanent delegate", "can transfer or burn tokens from any account", e.permanentDelegate.delegate);
  if (e.defaultAccountState) add("Default account state", `new token accounts start ${e.defaultAccountState.state}`);
  if (e.pausable) add("Pausable", e.pausable.paused ? "paused now" : "not paused now", null, e.pausable.authority);
  if (e.nonTransferable) add("Non-transferable");
  if (e.mintCloseAuthority) add("Close authority", null, null, e.mintCloseAuthority.closeAuthority);
  if (e.interestBearing) add("Interest-bearing", `${percent(e.interestBearing.currentRateBps)} a year`, null, e.interestBearing.rateAuthority);
  if (e.scaledUiAmount) add("Scaled UI amount", `multiplier ${e.scaledUiAmount.multiplier}`, null, e.scaledUiAmount.authority);
  if (e.confidentialTransfer) add("Confidential transfers", null, null, e.confidentialTransfer.authority);
  if (e.confidentialTransferFee) add("Confidential transfer fee", null, null, e.confidentialTransferFee.authority);
  if (e.confidentialMintBurn) add("Confidential mint and burn");
  if (e.permissionedBurn) add("Permissioned burn", null, null, e.permissionedBurn.authority);
  if (e.metadataPointer) add("Metadata pointer", null, e.metadataPointer.metadataAddress, e.metadataPointer.authority);
  if (e.tokenMetadata) add("Token metadata", null, null, e.tokenMetadata.updateAuthority);
  if (e.groupPointer) add("Group pointer", null, e.groupPointer.groupAddress, e.groupPointer.authority);
  if (e.tokenGroup) add("Token group", `${e.tokenGroup.size} of at most ${e.tokenGroup.maxSize} members`, null, e.tokenGroup.updateAuthority);
  if (e.groupMemberPointer) add("Group member pointer", null, e.groupMemberPointer.memberAddress, e.groupMemberPointer.authority);
  if (e.tokenGroupMember) add("Token group member", `member ${e.tokenGroupMember.memberNumber}`, e.tokenGroupMember.group);
  for (const type of unknown) add(`Extension type ${type}`, "Pipeline's SDK does not decode it");
  return out;
}

/** Each mint of a market as the facts panel shows it, in the market's order. */
export async function mintFacts(db: Db, market: string): Promise<MintFacts[]> {
  const rows = await db
    .select({ mint: marketMints.mint, vaultAmount: marketMints.vaultAmount, read: mints })
    .from(marketMints)
    .leftJoin(mints, eq(mints.address, marketMints.mint))
    .where(eq(marketMints.market, market))
    .orderBy(marketMints.position);
  return rows.map(({ mint, vaultAmount, read }) => {
    const decoded = read?.readable && read.data && read.tokenProgram ? decodeMint(address(mint), address(read.tokenProgram), Uint8Array.from(Buffer.from(read.data, "base64")), read.readEpoch ?? 0n) : null;
    const supply = read?.supply ? BigInt(read.supply) : null;
    return {
      mint,
      symbol: AVIARY_MINT_NAMES[mint] ?? null,
      readable: read?.readable ?? false,
      token_program: read?.tokenProgram ? (read.tokenProgram === TOKEN_2022 ? "Token-2022" : "Token") : null,
      decimals: read?.decimals ?? null,
      supply: read?.supply ?? null,
      mint_authority: read?.mintAuthority ?? null,
      freeze_authority: read?.freezeAuthority ?? null,
      extensions: decoded ? extensionsInWords(decoded.extensions, decoded.unknownExtensions) : [],
      vault_amount: vaultAmount,
      vault_share_percent: supply && vaultAmount !== null ? Number(((Number(BigInt(vaultAmount)) / Number(supply)) * 100).toPrecision(4)) : null,
      flags: flagFacts(read?.flags ?? []),
      read_slot: read?.readSlot === null || read?.readSlot === undefined ? null : Number(read.readSlot),
    };
  });
}
