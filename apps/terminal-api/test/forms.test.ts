// A strategy's forms (docs/spec/pipescope.md, Custom-action and create-market forms; #123): every
// action its validated metadata describes under `aviary_actions` (BAR-41), or under the `actions`
// section Pipeline no longer reads (PIPESCOPE-137), and its create form, each checked against the
// instruction list of the strategy's current version (PIPESCOPE-92) by the discriminator it sends.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDb, metadataSnapshots, programVersions, strategies, strategyInstructions } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StrategyForms, type ApiError } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const ROOT = `${import.meta.dirname}/../../..`;
const TAX_METADATA = JSON.parse(readFileSync(`${ROOT}/programs/tax-amm/metadata.json`, "utf8")) as Record<string, unknown>;
const HOSTILE = (name: string) => JSON.parse(readFileSync(`${ROOT}/packages/terminal-explainer/fixtures/hostile-metadata/${name}.json`, "utf8")) as Record<string, unknown>;

const TAX = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const OLD_ACTIONS = "9mAVr1ngs5Px3yQWdvsmVB8a1Tq9Fzo3yH6zbPzF7vHE";
const BOTH = "4LHmXfrWzQ1NzJ9q2gZ5f3oqA7d8xkL2nAWRT4oVHPuY";
const UNREACHABLE = "ETrmQd3NUmW4xh9uGRbC1F8XoDb2wEJYBGVwF6xGfx4Z";
const INVALID = "2TmcwB8MpxxFYbbqdHmyzN9W3wR4ZVv6s6KKaMbAKv7D";
const BAD_ACTIONS = "4scUhF1hEeZ6kbGU7Zu1yt7VDqjRkC1q3CyHYfDaYbR3";
const LYING = "yRptHnSSg9sxKaM7gUULGQ8b4uJmW6sTD3ZsGEwhxHqv";
const UNKNOWN = "6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp";
const SLOT = 525_400_000n;

const disc = (snake: string) => createHash("sha256").update(`global:${snake}`).digest().subarray(0, 8).toString("hex");
/** The tax AMM's instructions as the indexer lists them from its bytes: the program's own names, Anchor's discriminators. */
const TAX_INSTRUCTIONS: [string, string, boolean][] = [
  ["PipelineInitMarket", "pipeline_init_market", true],
  ["PipelineMarketInfo", "pipeline_market_info", true],
  ["PipelineResolveAccounts", "pipeline_resolve_accounts", true],
  ["PipelineQuote", "pipeline_quote", true],
  ["PipelineSwap", "pipeline_swap", true],
  ["Seed", "seed", false],
  ["Distribute", "distribute", false],
  ["SetTaxes", "set_taxes", false],
  ["SetRecipients", "set_recipients", false],
  ["RenounceTaxAuthority", "renounce_tax_authority", false],
  ["PipelineSeedLiquidity", "pipeline_seed_liquidity", true],
];

const action = (name: string, label: string, extra: Record<string, unknown> = {}) => ({ name, label, args: [], accounts: [{ name: "caller", source: "wallet", signer: true }], ...extra });

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let env: ReturnType<typeof bindings>;

async function strategy(program: string, snapshot: Partial<typeof metadataSnapshots.$inferInsert> | null, instructions: [string, string, boolean][] | null = TAX_INSTRUCTIONS) {
  const { db, close } = createDb(database.url);
  try {
    await db.insert(strategies).values({ program, metadataUri: `https://example.com/${program}.json`, registeredAt: new Date("2026-11-20T00:00:00Z") });
    if (snapshot) {
      const at = new Date("2026-11-24T00:00:00Z");
      await db.insert(metadataSnapshots).values({ program, uri: `https://example.com/${program}.json`, status: "valid", errors: [], warnings: [], fetchedAt: at, checkedAt: at, ...snapshot });
    }
    if (instructions) {
      await db.insert(programVersions).values({ program, deploySlot: SLOT, role: "strategy", anchor: true });
      await db.insert(strategyInstructions).values(instructions.map(([name, snake, pipeline], position) => ({ program, deploySlot: SLOT, position, name, discriminator: disc(snake), pipeline })));
    }
  } finally {
    await close();
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  env = bindings({ databaseUrl: database.url, rpcUrl: "http://127.0.0.1:9/never-called" });
  await strategy(TAX, { document: TAX_METADATA });
  const { aviary_actions: _ours, ...withoutOurs } = TAX_METADATA;
  await strategy(OLD_ACTIONS, { document: { ...withoutOurs, actions: [action("set_taxes", "Old section's taxes")] }, warnings: ["actions: custom actions are no longer part of the schema and are ignored"] });
  await strategy(BOTH, { document: { ...TAX_METADATA, actions: [action("set_taxes", "Old section's taxes")] } });
  await strategy(UNREACHABLE, { status: "unreachable", reason: "http-status", errors: ["HTTP 404"] });
  await strategy(INVALID, { status: "invalid", reason: "invalid", errors: ["name: required", "init.args[0].type: must be one of u8, u16"] });
  await strategy(BAD_ACTIONS, { document: { ...withoutOurs, aviary_actions: [{ name: "not an identifier", label: "" }] } });
  await strategy(LYING, {
    document: {
      ...HOSTILE("lying-label"),
      aviary_actions: [
        action("withdraw_all", "Claim your rewards‮ (safe)"),
        action("claim", "Claim", { discriminator: disc("set_recipients"), description: "<b>Claims</b>​ [x](javascript:alert(1))" }),
      ],
    },
  });
});

afterAll(async () => {
  await database?.drop();
});

async function forms(program: string) {
  const { ctx, settle } = executionContext();
  const response = await app.request(`/v1/strategies/${program}/forms`, {}, env, ctx);
  await settle();
  return { status: response.status, body: (await response.json()) as unknown };
}

describe("GET /v1/strategies/{program}/forms", () => {
  it("builds a form for each action the tax AMM's metadata describes, each checked by the discriminator it sends", async () => {
    const { status, body } = await forms(TAX);
    expect(status).toBe(200);
    const view = StrategyForms.parse(body);
    expect(view).toMatchObject({ program: TAX, deploy_slot: Number(SLOT), metadata: "valid", actions_section: "aviary_actions", unavailable: null, instructions_beyond_pipeline: 5 });
    expect(view.actions.map((a) => [a.name, a.label, a.check.outcome, a.check.instruction])).toEqual([
      ["seed", "Seed liquidity", "pass", "Seed"],
      ["distribute", "Pay out a tax slot", "pass", "Distribute"],
      // The burn action sends `distribute`'s discriminator: the form names the instruction the program runs.
      ["burn", "Burn the burn slot's tax", "pass", "Distribute"],
      ["set_taxes", "Change the taxes", "pass", "SetTaxes"],
      ["set_recipients", "Change the tax recipients", "pass", "SetRecipients"],
      ["renounce_tax_authority", "Renounce the tax authority", "pass", "RenounceTaxAuthority"],
    ]);
    expect(view.actions[2]!.discriminator).toBe(disc("distribute"));
  });

  it("gives every argument its name, type and label, and every account its source, writability and signature", async () => {
    const view = StrategyForms.parse((await forms(TAX)).body);
    const seed = view.actions[0]!;
    expect(seed.args[0]).toEqual({ name: "amount_0", type: "u64", label: "Amount of token 0", description: null, decimals_of: { kind: "mint", index: 0 } });
    expect(seed.accounts[0]).toEqual({ name: "seeder", source: { kind: "wallet" }, writable: false, signer: true });
    expect(seed.accounts[2]).toEqual({ name: "seeder_token_0", source: { kind: "wallet_token_account", index: 0 }, writable: true, signer: false });
    const distribute = view.actions[1]!;
    expect(distribute.accounts.find((a) => a.name === "tax_vault")!.source).toEqual({
      kind: "pda",
      program: "strategy",
      seeds: [{ kind: "str", text: "vault" }, { kind: "key", source: { kind: "market_state" } }, { kind: "key", source: { kind: "input", name: "tax_mint" } }],
    });
    expect(distribute.accounts.find((a) => a.name === "recipient_token_account")!.source).toEqual({ kind: "ata", owner: { kind: "input", name: "recipient" }, mint: { kind: "input", name: "tax_mint" } });
    // Addresses the user enters, the ones used as a mint marked so a page can show the mint's facts.
    expect(distribute.inputs).toEqual([
      { name: "tax_mint", mint: true },
      { name: "recipient", mint: false },
    ]);
  });

  it("builds the create form, checked against the strategy's `pipeline_init_market`, with its mints entered by address", async () => {
    const view = StrategyForms.parse((await forms(TAX)).body);
    expect(view.init).toMatchObject({ name: "pipeline_init_market", check: { outcome: "pass", instruction: "PipelineInitMarket" }, discriminator: disc("pipeline_init_market"), market_state: "new_keypair" });
    expect(view.init!.args).toHaveLength(20);
    expect(view.init!.inputs).toEqual([
      { name: "mint_0", mint: true },
      { name: "mint_1", mint: true },
    ]);
  });

  it("reads Pipeline's old `actions` section when there is no `aviary_actions`, and `aviary_actions` when there are both", async () => {
    const old = StrategyForms.parse((await forms(OLD_ACTIONS)).body);
    expect(old.actions_section).toBe("actions");
    expect(old.actions.map((a) => a.label)).toEqual(["Old section's taxes"]);
    const both = StrategyForms.parse((await forms(BOTH)).body);
    expect(both.actions_section).toBe("aviary_actions");
    expect(both.actions).toHaveLength(6);
  });

  it("warns when the instruction a form sends is not in the deployed program, and names the real one when the label lies", async () => {
    const view = StrategyForms.parse((await forms(LYING)).body);
    const [withdraw, claim] = view.actions;
    expect(withdraw!.check).toEqual({ outcome: "warn", instruction: null, reason: "not-in-program" });
    expect(claim!.check).toEqual({ outcome: "pass", instruction: "SetRecipients", reason: "found" });
    // Author text is normalised as the pages show it: no control or text-direction characters.
    expect(withdraw!.label).toBe("Claim your rewards (safe)");
    expect(claim!.description).toBe("<b>Claims</b> [x](javascript:alert(1))");
    expect(view.init!.label).toBeNull();
    expect(view.init!.description).toBe("Creates the market. The fee below is refunded.");
    expect(view.init!.args.map((a) => a.label)).toEqual(["Refund address (safe: never used to withdraw)", "Fee in basis points zero"]);
  });

  it("warns on every form when no instruction list is recorded for the strategy", async () => {
    const program = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
    await strategy(program, { document: TAX_METADATA }, null);
    const view = StrategyForms.parse((await forms(program)).body);
    expect(view.deploy_slot).toBeNull();
    expect(view.instructions_beyond_pipeline).toBeNull();
    expect(view.actions.every((a) => a.check.outcome === "warn" && a.check.reason === "no-instruction-list")).toBe(true);
  });

  it("gives no forms when the metadata is unavailable, with what the validator said and the program's own instructions counted", async () => {
    const unreachable = StrategyForms.parse((await forms(UNREACHABLE)).body);
    expect(unreachable).toMatchObject({ metadata: "unreachable", unavailable: "metadata-unreachable", errors: ["HTTP 404"], actions: [], init: null, instructions_beyond_pipeline: 5 });
    const invalid = StrategyForms.parse((await forms(INVALID)).body);
    expect(invalid).toMatchObject({ metadata: "invalid", unavailable: "metadata-invalid", errors: ["name: required", "init.args[0].type: must be one of u8, u16"], actions: [], init: null });
  });

  it("gives no action forms when the actions section fails its validator, and says what it said; the create form stays", async () => {
    const view = StrategyForms.parse((await forms(BAD_ACTIONS)).body);
    expect(view.unavailable).toBe("actions-invalid");
    expect(view.actions).toEqual([]);
    expect(view.errors).toEqual(["aviary_actions[0].name: must be an identifier (letters, digits, _)", "aviary_actions[0].label: must not be empty"]);
    expect(view.init).not.toBeNull();
  });

  it("says when the metadata has not been fetched yet", async () => {
    const program = "Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG";
    await strategy(program, null);
    expect(StrategyForms.parse((await forms(program)).body)).toMatchObject({ metadata: "not-fetched", unavailable: "metadata-not-fetched", actions: [], init: null });
  });

  it("treats a document fetched for a URI the strategy no longer names as not fetched yet, as the facts do", async () => {
    const program = "aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv";
    await strategy(program, { document: TAX_METADATA, uri: "https://example.com/the-old-uri.json" });
    expect(StrategyForms.parse((await forms(program)).body)).toMatchObject({ metadata: "not-fetched", unavailable: "metadata-not-fetched", actions: [], init: null });
  });

  it("answers 404 for an address that is no strategy", async () => {
    const { status, body } = await forms(UNKNOWN);
    expect(status).toBe(404);
    expect((body as ApiError).error).toBe("Aviary knows no strategy registered with Pipeline at this address.");
  });
});
