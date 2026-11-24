// The API's zod contract: what each endpoint answers, shared with the web app, which is a pure
// client of the API (docs/spec/pipescope-architecture.md, "terminal-web"). Every endpoint is
// labelled unstable until v1 ships (PIPESCOPE-32).
import { z } from "zod";

/** `GET /health`: healthy only when the database and the RPC both answer. */
export const Health = z.object({
  ok: z.boolean(),
  cluster: z.string(),
  database: z.object({
    ok: z.boolean(),
    latencyMs: z.number().int().nullable(),
    /** How many migrations the database has applied, so a deploy with one missing never looks ready. */
    migrations: z.number().int().nullable(),
    error: z.string().nullable(),
  }),
  rpc: z.object({
    ok: z.boolean(),
    latencyMs: z.number().int().nullable(),
    slot: z.number().int().nullable(),
    error: z.string().nullable(),
  }),
  version: z.object({ id: z.string(), tag: z.string(), timestamp: z.string() }),
});
export type Health = z.infer<typeof Health>;

/** Every refusal and failure: one sentence a page can show as it is. */
export const ApiError = z.object({ error: z.string(), retryAfterSeconds: z.number().int().optional() });
// A refusal from a strategy or the chain also carries the failure decoded (Failure, below) as `failure`.
export type ApiError = z.infer<typeof ApiError>;

/** A u64 token amount, as a string of an integer in the mint's smallest units. */
const Amount = z.string().regex(/^\d+$/);
const Address = z.string().min(32).max(44);
const Time = z.iso.datetime({ offset: true });

// ---- Canary's summaries (#125), on markets, strategies and Canary's own endpoints ----

/** One of Canary's five outcomes (docs/spec/pipescope-canary.md, Outcomes). */
export const CanaryOutcome = z.enum(["pass", "warn", "fail", "not run", "noted"]);
export type CanaryOutcome = z.infer<typeof CanaryOutcome>;

/**
 * A step Canary saw refused (docs/spec/pipescope-screens.md, Canary outcomes): who refused it, in
 * words ("the strategy"), the program, the error's name, number and message, the stage it was raised
 * at, where Anchor says it was raised, and the transaction error as the VM gave it.
 */
export const CanaryRefusal = z.object({
  by: z.string(),
  program: Address.nullable(),
  name: z.string().nullable(),
  number: z.number().int().nullable(),
  message: z.string().nullable(),
  stage: z.string().nullable(),
  origin: z.string().nullable(),
  raw: z.string().nullable(),
});
export type CanaryRefusal = z.infer<typeof CanaryRefusal>;

/** The ordinary trade: Canary's reference size (0.01 SOL with wrapped SOL) bought and sold straight back, and what came back, in millionths. */
const CanaryOrdinary = z.object({ return_ppm: z.number().int(), amount_words: z.string(), stand_in: z.boolean() });

/** The one result a row shows (PIPESCOPE-71): an outcome and a short phrase, never a count. */
export const CanaryLead = z.object({ check: z.string(), outcome: CanaryOutcome, phrase: z.string() });
export type CanaryLead = z.infer<typeof CanaryLead>;

/**
 * What a row says about Canary for a market (docs/spec/pipescope-screens.md, What a row says about
 * Canary), from its latest results under its strategy's current version: when they ran, the ordinary
 * trade's return, the one result chosen in the screens' order, and whether the market is stranded or
 * refuses every trade by its own rules, with the refusal.
 */
export const MarketCanary = z.object({
  run_at: Time,
  ordinary: CanaryOrdinary.nullable(),
  lead: CanaryLead.nullable(),
  stranded: CanaryRefusal.nullable(),
  refuses: CanaryRefusal.nullable(),
});
export type MarketCanary = z.infer<typeof MarketCanary>;

/**
 * What a strategy's row says about Canary (docs/spec/pipescope-screens.md, Feed): over its current
 * version's markets with results, the range of the ordinary trade's return on those that trade, and
 * how many the version cannot read.
 */
export const StrategyCanary = z.object({
  run_at: Time,
  markets: z.number().int(),
  stranded: z.number().int(),
  ordinary: z.object({ min_ppm: z.number().int(), max_ppm: z.number().int(), amount_words: z.string() }).nullable(),
});
export type StrategyCanary = z.infer<typeof StrategyCanary>;

/** A strategy upgraded since Canary last ran on it (PIPESCOPE-19): its new version, and when it was deployed (or first seen). */
export const CanaryUpgrade = z.object({ deploy_slot: z.number().int(), upgraded_at: Time });
export type CanaryUpgrade = z.infer<typeof CanaryUpgrade>;

/**
 * One of Pipeline's trust flags with its fixed description, as Pipeline's SDK words it
 * (`FLAG_DESCRIPTIONS`), so Aviary's wording is the SDK's and the hosted API's (PIPESCOPE-16).
 */
export const FlagFact = z.object({ flag: z.string(), description: z.string() });
export type FlagFact = z.infer<typeof FlagFact>;

/**
 * A strategy's metadata as the fetcher last found it (docs/spec/pipescope-architecture.md, Metadata
 * fetcher): Pipeline's SDK's status, or `not-fetched` before the first fetch. Errors and warnings are
 * the fetch's or Pipeline's validator's words, which can quote the document, so a page shows them as
 * plain text.
 */
export const MetadataStatus = z.object({
  status: z.enum(["not-fetched", "missing", "unreachable", "invalid", "valid"]),
  /** The URI the strategy's account names. */
  uri: z.string(),
  /** The URL the document was read from, after redirects. */
  url: z.string().nullable(),
  fetched_at: Time.nullable(),
  checked_at: Time.nullable(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  /** The SHA-256 of the document's bytes, in hex. */
  sha256: z.string().nullable(),
  /** What the explainer's normaliser removed from its author text (EXPLAINER-08). */
  removed: z.object({ characters: z.number().int(), truncated: z.array(z.string()), images: z.number().int(), links: z.number().int() }).nullable(),
});
export type MetadataStatus = z.infer<typeof MetadataStatus>;

/** A strategy registered with the router (`GET /v1/strategies`, `GET /v1/strategies/{program}`). */
export const Strategy = z.object({
  program: Address,
  metadata_uri: z.string(),
  /** The listing fee paid, in lamports; null when the strategy was found by its account, without its event. */
  fee_paid: Amount.nullable(),
  registered_at: Time,
  registered_signature: z.string().nullable(),
  market_count: z.number().int(),
  /** The name its valid metadata gives, as the normaliser left it: author text, shown as plain text in the author's style. Null without valid metadata. */
  name: z.string().nullable(),
  /** Its valid metadata's description, normalised and capped (EXPLAINER-08); author text too. */
  description: z.string().nullable(),
  metadata: MetadataStatus,
  /** Whether its valid metadata describes a create form (`init`), so the create page can say why one that does not offers none. */
  create_form: z.boolean(),
  /** Pipeline's trust flags for the strategy, in the SDK's order: its program's and its metadata's. */
  flags: z.array(z.string()),
  /** Who can upgrade its program, or null when it is frozen (or not read yet: then `flags` holds neither `upgradeable` nor `frozen`). */
  upgrade_authority: Address.nullable(),
  /** Its program's version in force, or null before the ProgramData watch has read it. */
  current_version: z.object({ deploy_slot: z.number().int(), executable_sha256: z.string().nullable(), deployed_at: Time.nullable() }).nullable(),
  /** A verified build of the current version: none until verified builds exist (#128). */
  verified_build: z.null(),
  /** What Canary saw on its current version's markets, or null before Canary has run any of them on it. */
  canary: StrategyCanary.nullable(),
});
export type Strategy = z.infer<typeof Strategy>;

/** One strategy (`GET /v1/strategies/{program}`), with each of its flags' fixed description for its facts. */
export const StrategyDetail = Strategy.extend({ flag_facts: z.array(FlagFact) });
export type StrategyDetail = z.infer<typeof StrategyDetail>;

/** Every strategy, newest first, with each flag any of them has and its description. */
export const StrategiesList = z.object({ strategies: z.array(Strategy), flags_present: z.array(FlagFact) });
export type StrategiesList = z.infer<typeof StrategiesList>;

/** One version of a program: the program as of one deploy, keyed by the slot of that deploy (docs/spec/pipescope-architecture.md, Indexer, "ProgramData watch"). */
const ProgramVersionFields = {
  deploy_slot: z.number().int(),
  /** The executable's SHA-256 as Pipeline's SDK and `solana-verify get-program-hash` compute it; null for a version found only in the history, whose bytes are gone. */
  executable_sha256: z.string().nullable(),
  /** The deploy or upgrade transaction; null until found in the ProgramData account's history. */
  signature: z.string().nullable(),
  /** When that transaction landed. */
  deployed_at: Time.nullable(),
  /** When Aviary recorded the version. */
  seen_at: Time,
  /** Found in the ProgramData account's history rather than seen by the watch, so its bytes were never read. */
  backfilled: z.boolean(),
  /** The version in force now. */
  current: z.boolean(),
};

/** A strategy's versions, newest first (`GET /v1/strategies/{program}/versions`). Canary checks attach to versions, not to strategies. */
export const StrategyVersion = z.object(ProgramVersionFields);
export type StrategyVersion = z.infer<typeof StrategyVersion>;
export const StrategyVersions = z.object({ program: Address, versions: z.array(StrategyVersion) });
export type StrategyVersions = z.infer<typeof StrategyVersions>;

/** The router's versions, newest first (`GET /v1/router`); an upgrade the watch saw happen is flagged, since it can change event layouts. */
export const RouterVersion = z.object({ ...ProgramVersionFields, flagged: z.boolean() });
export type RouterVersion = z.infer<typeof RouterVersion>;
export const RouterVersions = z.object({ program: Address, versions: z.array(RouterVersion) });
export type RouterVersions = z.infer<typeof RouterVersions>;

/**
 * The instructions compiled into a strategy's current version (`GET /v1/strategies/{program}/instructions`;
 * PIPESCOPE-92, CANARY-18), Pipeline's six marked as Pipeline's, each with how often it has been
 * called and by which signers, from the indexer's history of the strategy program. `anchor` is false
 * when the program names no instruction as Anchor compiles them ("none found"), and null, with
 * `deploy_slot`, before any version is recorded.
 */
export const StrategyInstruction = z.object({
  name: z.string(),
  discriminator: z.string().regex(/^[0-9a-f]{16}$/),
  pipeline: z.boolean(),
  calls: z.number().int(),
  /** The signers that called it, most calls first, at most INSTRUCTION_SIGNERS_SHOWN. */
  signers: z.array(z.object({ address: Address, calls: z.number().int() })),
  signers_total: z.number().int(),
});
export type StrategyInstruction = z.infer<typeof StrategyInstruction>;
export const StrategyInstructions = z.object({ program: Address, deploy_slot: z.number().int().nullable(), anchor: z.boolean().nullable(), instructions: z.array(StrategyInstruction) });
export type StrategyInstructions = z.infer<typeof StrategyInstructions>;

/**
 * Where an account of a form comes from: one of Pipeline's metadata account sources, parsed by its
 * SDK (`parseAccountSource`), so a page can say what it is in words ("your wallet", "the market's
 * vault for SOL", "an address derived from the program itself") and resolve the market's own.
 */
export type AccountSource =
  | { kind: "wallet" | "market_state" | "market" | "strategy_program" | "system_program" | "associated_token_program" | "seeder" | "lp_recipient" }
  | { kind: "mint" | "vault" | "token_program" | "wallet_token_account" | "escrow"; index: number }
  | { kind: "fixed"; address: string }
  | { kind: "input"; name: string }
  | { kind: "pda"; program: string; seeds: PdaSeed[] }
  | { kind: "ata"; owner: AccountSource; mint: AccountSource }
  | { kind: "token_program_of"; mint: AccountSource };
/** One seed of a `pda:` source: text, bytes in hex, an account's address, or an argument's encoding. */
export type PdaSeed = { kind: "str"; text: string } | { kind: "hex"; hex: string } | { kind: "key"; source: AccountSource } | { kind: "arg"; name: string };
export const AccountSource: z.ZodType<AccountSource> = z.lazy(() =>
  z.union([
    z.object({ kind: z.enum(["wallet", "market_state", "market", "strategy_program", "system_program", "associated_token_program", "seeder", "lp_recipient"]) }),
    z.object({ kind: z.enum(["mint", "vault", "token_program", "wallet_token_account", "escrow"]), index: z.number().int() }),
    z.object({ kind: z.literal("fixed"), address: Address }),
    z.object({ kind: z.literal("input"), name: z.string() }),
    z.object({ kind: z.literal("pda"), program: z.string(), seeds: z.array(PdaSeed) }),
    z.object({ kind: z.literal("ata"), owner: AccountSource, mint: AccountSource }),
    z.object({ kind: z.literal("token_program_of"), mint: AccountSource }),
  ]),
);
export const PdaSeed: z.ZodType<PdaSeed> = z.lazy(() =>
  z.union([z.object({ kind: z.literal("str"), text: z.string() }), z.object({ kind: z.literal("hex"), hex: z.string() }), z.object({ kind: z.literal("key"), source: AccountSource }), z.object({ kind: z.literal("arg"), name: z.string() })]),
);

/**
 * Whether the instruction a form sends is in the strategy's current version (PIPESCOPE-92,
 * PIPESCOPE-143): looked up by the discriminator it sends in the version's instruction list, so
 * `instruction` is the name the program itself gives the instruction that runs, whatever the form's
 * label or name say; a warn when no instruction with that discriminator was found in the program, or
 * no list is recorded for it.
 */
export const FormCheck = z.object({
  outcome: z.enum(["pass", "warn"]),
  instruction: z.string().nullable(),
  reason: z.enum(["found", "not-in-program", "no-instruction-list"]),
});
export type FormCheck = z.infer<typeof FormCheck>;

/** One field of a form: the argument's name and type (identifiers), with its author's label and description (author text). */
export const FormArg = z.object({
  name: z.string(),
  type: z.enum(["u8", "u16", "u32", "u64", "i64", "bool", "pubkey", "bytes", "string"]),
  label: z.string().nullable(),
  description: z.string().nullable(),
  /** The account source naming the mint whose decimals an amount is written in, when the metadata names one. */
  decimals_of: AccountSource.nullable(),
});
export type FormArg = z.infer<typeof FormArg>;

/** One account a form's instruction touches: the metadata's name for it (shown as an identifier), where it comes from, and its role. */
export const FormAccount = z.object({ name: z.string(), source: AccountSource, writable: z.boolean(), signer: z.boolean() });
export type FormAccount = z.infer<typeof FormAccount>;

/**
 * A form built from a strategy's metadata (docs/spec/pipescope.md, Custom-action and create-market
 * forms): an action, or the create form. Its label and descriptions are author text, normalised as
 * every author text is (EXPLAINER-08) and shown as plain text in the author's style.
 */
export const Form = z.object({
  /** The instruction's name as the metadata gives it: the action's, or `pipeline_init_market` for the create form. */
  name: z.string(),
  label: z.string().nullable(),
  description: z.string().nullable(),
  /** The action's kind as the metadata gives it (`add_liquidity`, `claim`...), author text; null for the create form. */
  kind: z.string().nullable(),
  /** The 8 bytes that pick the instruction, in hex: the metadata's own, or Anchor's from the name. */
  discriminator: z.string().regex(/^[0-9a-f]{16}$/),
  check: FormCheck,
  args: z.array(FormArg),
  accounts: z.array(FormAccount),
  /** The addresses the user enters (`input:` sources), each marked when it is used as a mint, so a page shows that mint's facts. */
  inputs: z.array(z.object({ name: z.string(), mint: z.boolean() })),
  /** The create form's market state: `new_keypair` (a fresh keypair, made and kept in the page, signs) or an account source; null for an action. */
  market_state: z.union([z.literal("new_keypair"), AccountSource]).nullable(),
});
export type Form = z.infer<typeof Form>;

/**
 * `GET /v1/strategies/{program}/forms`: a strategy's forms, from its newest metadata as Pipeline's
 * validator accepted it (PIPESCOPE-20, PIPESCOPE-21). Its actions come from `aviary_actions` (BAR-41)
 * or, when the metadata has none, from the `actions` section Pipeline's validator now ignores
 * (PIPESCOPE-141). `unavailable` says why there are no forms: the metadata is unavailable (no
 * forms at all), or the actions section failed its validator (no action forms; the create form
 * stays); `errors` is what the fetcher or the validator said, untrusted text, since it can quote the
 * document. `instructions_beyond_pipeline` counts the current version's instructions that are not
 * Pipeline's own, null when no list is recorded.
 */
export const StrategyForms = z.object({
  program: Address,
  /** The strategy version the forms were checked against, null when the indexer has recorded none. */
  deploy_slot: z.number().int().nullable(),
  metadata: MetadataStatus.shape.status,
  actions_section: z.enum(["aviary_actions", "actions"]).nullable(),
  unavailable: z.enum(["metadata-not-fetched", "metadata-missing", "metadata-unreachable", "metadata-invalid", "actions-invalid"]).nullable(),
  errors: z.array(z.string()),
  instructions_beyond_pipeline: z.number().int().nullable(),
  actions: z.array(Form),
  init: Form.nullable(),
});
export type StrategyForms = z.infer<typeof StrategyForms>;

/**
 * A token's own name and picture, from its mint's on-chain token metadata (PIPESCOPE-22, PIPESCOPE-82):
 * author text, never Aviary's words, so a page sets it in the author's style beside the mint's short
 * address. Its symbol and name as the author-text normaliser leaves them, at least one of them set,
 * and `image`, the SHA-256 of the image Aviary keeps of it, served at `/images/<image>`, or null.
 */
export const TokenName = z.object({
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  image: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
export type TokenName = z.infer<typeof TokenName>;

/** One of a market's mints, in the market's own order, with what its vault holds. */
export const MarketMint = z.object({
  mint: Address,
  /** Aviary's own name for the mint (SOL, USDC), set plainly; null for every other mint. */
  symbol: z.string().nullable(),
  /** The token's own name, the author's claim; null for a mint that names none, and for SOL and USDC, which Aviary names. */
  token: TokenName.nullable(),
  /** Null until the mint is read, or when its account is not a mint. */
  decimals: z.number().int().nullable(),
  vault: Address.nullable(),
  /** What the vault held when last read, in the mint's smallest units. */
  liquidity: Amount.nullable(),
  /** Pipeline's trust flags for the mint, in the SDK's order; null until the mint is read. */
  flags: z.array(z.string()).nullable(),
});
export type MarketMint = z.infer<typeof MarketMint>;

/** A market created through the router (`GET /v1/markets`, `GET /v1/markets/{market}`). */
export const Market = z.object({
  address: Address,
  strategy: Address,
  market_state: Address,
  created_at: Time,
  created_by: Address,
  created_signature: z.string().nullable(),
  fee_mint: Address.nullable(),
  supports_exact_out: z.boolean().nullable(),
  mints: z.array(MarketMint),
  /** The pair a price is shown for (PIPESCOPE-74): an amount of the quote mint for one of the base mint. */
  quote_mint: Address,
  base_mint: Address,
  /** The last 24 hours: every trade counted, and the volume of those in the quote mint, in its smallest units. */
  stats_24h: z.object({ trades: z.number().int(), volume_quote: Amount }),
  /** Its strategy's name from valid metadata (author text), or null when its metadata is unavailable. */
  strategy_name: z.string().nullable(),
  /** Its strategy's metadata status, for "Metadata unavailable". */
  strategy_metadata: MetadataStatus.shape.status,
  /** Pipeline's trust flags for the market: its strategy's and every mint's, in the SDK's order, as Pipeline's SDK and hosted API give them. */
  flags: z.array(z.string()),
  /** What Canary saw under its strategy's current version, or null before Canary has run it on that version. */
  canary: MarketCanary.nullable(),
});
export type Market = z.infer<typeof Market>;

/**
 * `GET /v1/markets?min_sol_liquidity=&min_sol_volume_24h=&created_within=&hide=`: markets newest
 * first, all of them or those the filters keep (PIPESCOPE-05, PIPESCOPE-72): at least that much SOL
 * in the market's SOL vault and of SOL traded in the last 24 hours (lamports), created within that
 * many seconds, and none of the trust flags in `hide` (a comma-separated list). Liquidity and volume
 * are measured on the SOL side, so either leaves out a market with no SOL side.
 * `total` counts every market (of the strategy asked for), `matching` those the filters keep, and
 * `no_sol_side` those with no SOL side; `flags_present` is every flag any of the markets has, with
 * its description. `next` is the `before` of the following page, or null after the last.
 */
export const MarketsPage = z.object({
  markets: z.array(Market),
  total: z.number().int(),
  matching: z.number().int(),
  no_sol_side: z.number().int(),
  flags_present: z.array(FlagFact),
  next: z.string().nullable(),
});
export type MarketsPage = z.infer<typeof MarketsPage>;

/** A Token-2022 extension of a mint, in words: its name, what it is set to, the address it names (a hook's program, a delegate), and who can change it. */
export const MintExtension = z.object({ name: z.string(), detail: z.string().nullable(), address: Address.nullable(), authority: Address.nullable() });
export type MintExtension = z.infer<typeof MintExtension>;

/** A mint as the facts panel shows it (docs/spec/pipescope-screens.md, Explanation, actions and facts: "Its mints"). */
export const MintFacts = z.object({
  mint: Address,
  /** Aviary's own name for it (SOL, USDC), or null: no other mint is named by Aviary. */
  symbol: z.string().nullable(),
  /** The token's own name, as on a market's mints. */
  token: TokenName.nullable(),
  readable: z.boolean(),
  /** "Token" or "Token-2022", or null for an unreadable mint. */
  token_program: z.enum(["Token", "Token-2022"]).nullable(),
  decimals: z.number().int().nullable(),
  supply: Amount.nullable(),
  mint_authority: Address.nullable(),
  freeze_authority: Address.nullable(),
  extensions: z.array(MintExtension),
  /** What this market's vault holds of it, and that as a share of the supply in percent (null with no supply). */
  vault_amount: Amount.nullable(),
  vault_share_percent: z.number().nullable(),
  flags: z.array(FlagFact),
  /** When it was last read. */
  read_slot: z.number().int().nullable(),
});
export type MintFacts = z.infer<typeof MintFacts>;

/**
 * `GET /v1/markets/{market}/facts`: the facts panel's three parts of Aviary's own (PIPESCOPE-16):
 * this market, its strategy, and its mints in the market's order. Canary's part joins with #125.
 */
export const MarketFacts = z.object({
  market: Market,
  strategy: StrategyDetail,
  mints: z.array(MintFacts),
});
export type MarketFacts = z.infer<typeof MarketFacts>;

/**
 * `GET /v1/markets/{market}/state?accounts=`: the market's state and the outside accounts a product's
 * panel names (a comma-separated list, at most MARKET_READ.maxAccounts), all read in one request at
 * one slot, so a panel never mixes two moments of the chain (PIPESCOPE-146). Each account's data is
 * base64; an account larger than MARKET_READ.maxAccountBytes comes back with its size and no data.
 */
export const MarketRead = z.object({
  market: Address,
  slot: z.number().int(),
  accounts: z.array(
    z.object({
      address: Address,
      role: z.enum(["market_state", "named"]),
      exists: z.boolean(),
      owner: Address.nullable(),
      lamports: Amount.nullable(),
      executable: z.boolean().nullable(),
      size: z.number().int().nullable(),
      data: z.string().nullable(),
    }),
  ),
});
export type MarketRead = z.infer<typeof MarketRead>;

/** A mint found by search: Aviary's name for it or its own, and every market it trades on. */
export const SearchMint = z.object({
  mint: Address,
  /** Aviary's own name for it (SOL, USDC), or null. */
  symbol: z.string().nullable(),
  token: TokenName.nullable(),
  /** Every market it trades on, newest first. */
  markets: z.array(Address),
});
export type SearchMint = z.infer<typeof SearchMint>;

/** One group of search results: how many match, and the first of them, at most the limit asked for. */
const SearchGroup = <T extends z.ZodType>(result: T) => z.object({ total: z.number().int(), results: z.array(result) });

/**
 * `GET /v1/search?q=&limit=` (docs/spec/pipescope-screens.md, Search; PIPESCOPE-81): what is
 * registered with Pipeline that matches `q`, grouped as strategies, markets and mints. Names match
 * anywhere and in any case (a strategy's name from valid metadata, a token's symbol and name, and
 * Aviary's own SOL and USDC); addresses match exactly as typed from their start or their end (a
 * strategy's program, a market, a market state or a mint). Each group is ordered with a whole address
 * typed first; then strategies by markets, markets newest first and mints by markets.
 */
export const SearchResults = z.object({
  /** What was searched for, trimmed. */
  query: z.string(),
  strategies: SearchGroup(Strategy),
  markets: SearchGroup(Market),
  mints: SearchGroup(SearchMint),
});
export type SearchResults = z.infer<typeof SearchResults>;

/** A swap through the router, from its `Swap` event. */
export const Trade = z.object({
  signature: z.string(),
  event_index: z.number().int(),
  slot: z.number().int(),
  block_index: z.number().int().nullable(),
  block_time: Time.nullable(),
  market: Address,
  trader: Address,
  input_mint: Address,
  output_mint: Address,
  mode: z.enum(["exact_in", "exact_out"]),
  net_sent: Amount,
  received: Amount,
  pipeline_fee: Amount,
  fee_mint: Address,
  integrator: Address.nullable(),
  integrator_fee: Amount,
  /** The trade's pair by the quote mint order, and whether it bought or sold the base mint. */
  quote_mint: Address,
  base_mint: Address,
  side: z.enum(["buy", "sell"]),
});
export type Trade = z.infer<typeof Trade>;

/**
 * Trades, newest first; `next` is the `before` of the following page, or null after the last. Asked
 * with `after` (a reconnecting page's resync), it holds only trades newer than that cursor, the
 * newest of them; `next` is then null when they all fit, or else the `before` of the older ones
 * still between the page and the cursor.
 */
export const TradesPage = z.object({ trades: z.array(Trade), next: z.string().nullable() });
export type TradesPage = z.infer<typeof TradesPage>;

/**
 * What a live room sends a browser (docs/spec/pipescope-architecture.md, Live rooms): a swap just
 * indexed, to a market's room; a market new or changed (its liquidity, its last 24 hours), to the
 * feed's room and the market's own. A page puts each in place by its key, so one that arrives twice,
 * or again in a resync through the API, is shown once.
 */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trade"), trade: Trade }),
  z.object({ type: z.literal("market"), market: Market }),
  /** More new swaps than a room is sent at once landed (LIVE_ROOM_TRADES_MAX): the page catches up through the API, as after a reconnection. */
  z.object({ type: z.literal("resync") }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/** One message of a live room: the events gathered over its batching interval (PIPESCOPE-31). */
export const LiveMessage = z.object({ events: z.array(LiveEvent) });
export type LiveMessage = z.infer<typeof LiveMessage>;

/** A price: an amount of the quote mint for one of the base mint, after both mints' decimals, as a decimal string. */
const Price = z.string().regex(/^\d+(\.\d+)?$/);

/** One candle: its start, its first, highest, lowest and last price, what its swaps moved of each mint, and how many there were. */
export const Candle = z.object({
  start: Time,
  open: Price,
  high: Price,
  low: Price,
  close: Price,
  /** In the base and quote mints' smallest units. */
  volume_base: Amount,
  volume_quote: Amount,
  trades: z.number().int(),
});
export type Candle = z.infer<typeof Candle>;

/**
 * `GET /v1/markets/{market}/candles?interval=&base=&quote=&limit=&from=`: a market's candles of one
 * length for a pair, oldest first, only those with swaps. The pair is the one asked for by `base` and
 * `quote`, or the market's own by the quote mint order (PIPESCOPE-74).
 */
export const Candles = z.object({
  market: Address,
  interval: z.string(),
  seconds: z.number().int(),
  base_mint: Address,
  quote_mint: Address,
  /** Every swap of the pair on this market that the candles are built from, all time. */
  trade_count: z.number().int(),
  candles: z.array(Candle),
});
export type Candles = z.infer<typeof Candles>;
/**
 * The keeper runner's passes (docs/spec/keeper-runner.md, "Triggers"): `start` and `once` run every
 * job, the others their own; `retry` re-runs a failed job, or one refused for a later slot.
 */
export const KeeperPassKind = z.enum(["start", "once", "sweep", "hourly", "daily", "transaction", "retry"]);
export type KeeperPassKind = z.infer<typeof KeeperPassKind>;

/** The runner's caps and balance thresholds, in lamports. */
export const KeeperCaps = z.object({
  maxTxCost: z.number().int().nonnegative(),
  marketDailyCap: z.number().int().nonnegative(),
  dailyCap: z.number().int().nonnegative(),
  minBalance: z.number().int().nonnegative(),
  lowBalance: z.number().int().nonnegative(),
});
export type KeeperCaps = z.infer<typeof KeeperCaps>;

/**
 * The signed heartbeat the runner posts to `POST /keeper/heartbeat` after each pass (SUITE-57), so
 * the keeper page knows the runner is alive while Postgres sleeps: `payload` is the JSON of a
 * `KeeperHeartbeatPayload`, and `signature` the keeper wallet's Ed25519 signature, in base58, of
 * `keeperHeartbeatMessage(payload)`.
 */
export const KeeperHeartbeat = z.object({ payload: z.string().max(8192), signature: z.string().min(64).max(100) }).strict();
export type KeeperHeartbeat = z.infer<typeof KeeperHeartbeat>;

/** The most warnings a heartbeat carries, and the longest each may be; the runner cuts its own to fit. */
export const KEEPER_WARNINGS_MAX = 20;
export const KEEPER_WARNING_MAX_LENGTH = 1000;

export const KeeperHeartbeatPayload = z
  .object({
    /** The keeper wallet, which signed it. */
    wallet: z.string().min(32).max(44),
    pass: KeeperPassKind,
    /** When the pass ended. */
    at: z.iso.datetime(),
    /** When this run of the runner started: parks are kept only in its memory, so older ones are over. */
    startedAt: z.iso.datetime(),
    /** The runner's SWEEP_INTERVAL, which the page's "looks stopped" counts from. */
    sweepIntervalMs: z.number().int().positive(),
    caps: KeeperCaps,
    /** The pass's warnings (a low balance, a failed discovery). */
    warnings: z.array(z.string().max(KEEPER_WARNING_MAX_LENGTH)).max(KEEPER_WARNINGS_MAX),
  })
  .strict();
export type KeeperHeartbeatPayload = z.infer<typeof KeeperHeartbeatPayload>;

/** What a heartbeat's signature signs: a domain line no Solana transaction can begin with, then the payload. */
export const KEEPER_HEARTBEAT_DOMAIN = "keeper-heartbeat/v1";
export const keeperHeartbeatMessage = (payload: string): Uint8Array => new TextEncoder().encode(`${KEEPER_HEARTBEAT_DOMAIN}\n${payload}`);

/** One job the runner recorded: sent (with its signature), held by a cap, parked or unparked. */
export const KeeperJob = z.object({
  at: z.iso.datetime(),
  pass: z.string(),
  market: z.string().nullable(),
  product: z.string().nullable(),
  job: z.string(),
  slot: z.number().int().nullable(),
  outcome: z.string(),
  signature: z.string().nullable(),
  /** Lamports the landed transaction took from the keeper wallet. */
  cost: z.number().int().nullable(),
  cap: z.string().nullable(),
  error: z.string().nullable(),
});
export type KeeperJob = z.infer<typeof KeeperJob>;

/** `GET /keeper`: what the keeper runner did and spends, for the keeper page (PIPESCOPE-97, PIPESCOPE-104). */
export const Keeper = z.object({
  /** The keeper wallet Aviary shows. */
  wallet: z.string(),
  /** Its balance in lamports, read through RPC now. */
  balance: z.object({ lamports: z.number().int().nullable(), error: z.string().nullable() }),
  liveness: z.object({
    /** `running` within the threshold of the last heartbeat, `looks-stopped` after it, `no-heartbeat` when none was ever received. */
    state: z.enum(["running", "looks-stopped", "no-heartbeat"]),
    /** The runner's latest pass (one-off `once` passes aside), from its heartbeats. */
    lastPass: z.object({ pass: KeeperPassKind, at: z.iso.datetime() }).nullable(),
    /** How old the last pass may be before the runner looks stopped: its SWEEP_INTERVAL and a few minutes. */
    stoppedAfterMs: z.number().int().nullable(),
    /** The runner's SWEEP_INTERVAL, from its latest heartbeat. */
    sweepIntervalMs: z.number().int().nullable(),
  }),
  /** Each kind of pass: when it last ran, from heartbeats, and the last one that recorded something. */
  passes: z.array(
    z.object({
      pass: KeeperPassKind,
      lastRanAt: z.iso.datetime().nullable(),
      lastRecorded: z
        .object({ at: z.iso.datetime(), sent: z.number().int(), held: z.number().int(), parked: z.number().int(), failed: z.number().int(), jobs: z.number().int() })
        .nullable(),
    }),
  ),
  /** The caps the runner runs with, from its latest heartbeat or recorded pass; null before either exists. */
  caps: KeeperCaps.nullable(),
  /** Today's spend (UTC), in lamports. */
  today: z.object({
    day: z.string(),
    spentTotal: z.number().int(),
    /** The most one of today's transactions cost, against MAX_TX_COST. */
    highestCost: z.number().int().nullable(),
    markets: z.array(z.object({ market: z.string(), spent: z.number().int() })),
  }),
  /** The latest pass's warnings, and when that pass ran. */
  warnings: z.object({ at: z.iso.datetime(), list: z.array(z.string()) }).nullable(),
  /** Jobs held by a cap today or parked, newest first. */
  waiting: z.array(KeeperJob),
  /** The latest recorded jobs, newest first. */
  recent: z.array(KeeperJob),
  /** Whether the records could be read: a database that does not answer leaves the rest of the page standing. */
  records: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});
export type Keeper = z.infer<typeof Keeper>;

/**
 * `GET /v1/markets/{market}/keeper`: the keeper runner's latest record of each job and slot on one
 * market, newest first, so the market's panel shows beside each due job what the runner last did about
 * it (docs/spec/keeper-runner.md, "How Aviary shows it"; PIPESCOPE-166).
 */
export const MarketKeeper = z.object({
  market: Address,
  /** The keeper wallet whose runner's records these are. */
  wallet: z.string(),
  jobs: z.array(KeeperJob),
});
export type MarketKeeper = z.infer<typeof MarketKeeper>;

// ---- Trading (docs/spec/pipescope-architecture.md, Trading path) ----

/** A fee mint: the integrator fee is charged only on swaps paying in one, into the fee wallet's account for it. */
export const FeeMint = z.object({ mint: Address, symbol: z.string(), account: Address });
export type FeeMint = z.infer<typeof FeeMint>;

/**
 * `GET /v1/fees`: every rate a page shows (PIPESCOPE-10 to PIPESCOPE-13, PIPESCOPE-91): Pipeline's own,
 * the router's, and Aviary's integrator fee with the mints it is charged in and the wallet it goes to.
 */
export const Fees = z.object({
  pipeline_fee_bps: z.number().int(),
  integrator_fee_bps: z.number().int(),
  fee_wallet: Address,
  fee_mints: z.array(FeeMint),
  /** Solana's network fee for each signature, in lamports. */
  network_fee_per_signature: z.number().int(),
});
export type Fees = z.infer<typeof Fees>;

/**
 * A refused quote or a failed simulation, decoded (docs/spec/pipescope-screens.md, "On every page"):
 * its class, the sentence a page shows, the Anchor error's name, number and message when there is one,
 * the program that raised it, and the raw error to show beneath.
 */
export const Failure = z.object({
  class: z.enum(["too_little", "strategy_refused", "router_refused", "token_program_refused", "hook_refused", "other_refused", "cannot_read_state", "crash", "out_of_compute", "unavailable", "too_large", "needs_signer", "bad_input"]),
  sentence: z.string(),
  name: z.string().nullable(),
  number: z.number().int().nullable(),
  message: z.string().nullable(),
  program: z.string().nullable(),
  raw: z.string(),
});
export type Failure = z.infer<typeof Failure>;

/** A refusal from a strategy or the chain: the sentence, the failure decoded with its raw error, and the program's log lines when a simulation gave them. */
export const Refusal = ApiError.extend({ failure: Failure, logs: z.array(z.string()).optional() });
export type Refusal = z.infer<typeof Refusal>;

/**
 * `GET /v1/quote?market=&input_mint=&output_mint=&amount=&trader=`: a quote for the amount typed, which
 * is everything that leaves the wallet for the swap (PIPESCOPE-76), from an RPC simulation of the
 * strategy's `pipeline_quote` (PIPESCOPE-34), with the rates it was worked out at (PIPESCOPE-91).
 */
export const Quote = z.object({
  market: Address,
  input_mint: Address,
  output_mint: Address,
  /** The amount typed: what leaves the wallet, fees included. */
  amount: Amount,
  /** Which side Pipeline's fee is taken on: the input, or the output on a trade into the market's fee mint. */
  fee_side: z.enum(["input", "output"]),
  pipeline_fee_bps: z.number().int(),
  /** The integrator fee's rate on this swap: 0 unless the trader pays in a fee mint. */
  integrator_fee_bps: z.number().int(),
  /** What goes into the market. */
  net_sent: Amount,
  /** Pipeline's fee, in `pipeline_fee_mint`: the input mint, or the output mint on a trade into the market's fee mint. */
  pipeline_fee: Amount,
  pipeline_fee_mint: Address,
  integrator_fee: Amount,
  /** Everything that leaves the wallet for the swap: at most the amount typed. */
  total_spend: Amount,
  /** What the strategy sends. */
  strategy_amount_out: Amount,
  /** What the trader is expected to receive: the strategy's output, less Pipeline's fee when it is taken there. */
  expected_out: Amount,
  compute_units: z.number().int().nullable(),
});
export type Quote = z.infer<typeof Quote>;

/** `POST /v1/swaps/prepare`: the swap to build, for the trader who will sign it. */
export const PrepareSwapRequest = z
  .object({
    market: Address,
    input_mint: Address,
    output_mint: Address,
    amount: Amount,
    /** The slippage accepted, in basis points, below 100%; the highest a page offers is its own (the screens' config module). */
    slippage_bps: z.number().int().min(0).max(9_999),
    trader: Address,
  })
  .strict();
export type PrepareSwapRequest = z.infer<typeof PrepareSwapRequest>;

/** How one account the wallet owns changes: SOL when `mint` is null, else a token account. */
export const BalanceChange = z.object({ mint: Address.nullable(), account: Address, before: Amount, after: Amount });
export type BalanceChange = z.infer<typeof BalanceChange>;

/** The simulation of the exact transaction returned (docs/spec/pipescope-architecture.md, Simulation before every signature). */
export const Simulation = z.object({
  ok: z.boolean(),
  failure: Failure.nullable(),
  logs: z.array(z.string()),
  compute_units: z.number().int().nullable(),
  /** What signing would change in the wallet: its SOL and each token account the transaction touches. */
  changes: z.array(BalanceChange),
  /** The network fee, in lamports. */
  network_fee: Amount,
  /** Token accounts the transaction creates for the wallet and keeps, with the rent each holds. */
  new_accounts: z.array(z.object({ account: Address, mint: Address, rent: Amount })),
  /** The rent of the market's fee account for the fee mint, which the swap creates and pays for when it does not exist yet; 0 otherwise. */
  market_rent: Amount,
  /** What the swap takes from the wallet in the mint paid, and gives in the mint received, measured in the simulation; null when it failed. */
  paid: Amount.nullable(),
  received: Amount.nullable(),
});
export type Simulation = z.infer<typeof Simulation>;

/** The prepared swap: its quote, the minimum after slippage, and the unsigned transaction, only when its simulation passed. */
export const PreparedSwap = z.object({
  quote: Quote,
  slippage_bps: z.number().int(),
  min_amount_out: Amount,
  /**
   * A change of the strategy's own rates due within the transaction's lifetime, which a swap signed now
   * may land after (a tax market's, docs/spec/tax-amm.md "In Aviary"): the slot it applies from and the
   * expected output at the new rates; the minimum is then set from the worse of the two quotes. Null
   * when no such change is due.
   */
  pending_rates: z.object({ from_slot: z.number().int(), expected_out: Amount }).nullable().default(null),
  /** The unsigned transaction, base64, exactly as simulated; null when the simulation failed, so there is nothing to sign. */
  transaction: z.string().nullable(),
  simulation: Simulation,
});
export type PreparedSwap = z.infer<typeof PreparedSwap>;

/**
 * The simulation of a prepared custom action or new market (docs/spec/pipescope-architecture.md,
 * Simulation before every signature): what signing would change in the wallet, its SOL and each token
 * account it owns that the transaction writes, and the token accounts it gains, with their rent.
 */
export const TransactionSimulation = Simulation.pick({ ok: true, failure: true, logs: true, compute_units: true, changes: true, network_fee: true, new_accounts: true });
export type TransactionSimulation = z.infer<typeof TransactionSimulation>;

/** A value typed into a form's field: an integer, an address, hex bytes or text as a string, or a boolean. */
const FormValue = z.union([z.string().max(4096), z.boolean()]);
/** What a form was filled with: each argument by name, and each address the user enters (`input:` sources) by name. */
const FormValues = { args: z.record(z.string(), FormValue), inputs: z.record(z.string(), Address) };

/** `POST /v1/actions/prepare`: a custom action of a market's strategy, by its metadata name, for the wallet that will sign it. */
export const PrepareActionRequest = z.object({ market: Address, action: z.string().min(1).max(64), ...FormValues, trader: Address }).strict();
export type PrepareActionRequest = z.infer<typeof PrepareActionRequest>;

/** One account a prepared instruction touches, resolved to its address. */
export const ResolvedAccount = z.object({ address: Address, writable: z.boolean(), signer: z.boolean() });

/**
 * A prepared custom action: the strategy's instruction as built (its accounts resolved), the SOL
 * wrapped for it (PIPESCOPE-145), and the unsigned transaction, only when its simulation passed. It is
 * signed directly on the strategy, outside the router's swap protections.
 */
export const PreparedAction = z.object({
  market: Address,
  action: z.string(),
  check: FormCheck,
  accounts: z.array(ResolvedAccount),
  wrapped_sol: Amount,
  transaction: z.string().nullable(),
  simulation: TransactionSimulation,
});
export type PreparedAction = z.infer<typeof PreparedAction>;

/** The most actions a new market may run in the transaction that creates it. */
export const OPENING_ACTIONS_MAX = 2;

/**
 * A new market opened in the transaction that creates it (PIPESCOPE-163): its mints and their vaults in
 * the market's order, as the product's own form works them out before the market exists, so the router's
 * fee account for each mint is created, and then the actions of its metadata, by name, run on it.
 */
export const MarketOpening = z
  .object({
    mints: z.array(Address).min(2).max(4),
    vaults: z.array(Address).min(2).max(4),
    actions: z.array(z.object({ action: z.string().min(1).max(64), ...FormValues }).strict()).max(OPENING_ACTIONS_MAX),
  })
  .strict();
export type MarketOpening = z.infer<typeof MarketOpening>;

/**
 * `POST /v1/markets/prepare`: a new market from a strategy's create form. `market_state` is the new
 * market state's address when the form makes one: its keypair is made in the page, which signs with
 * it after the wallet's prompt is built, so no key leaves the page (PIPESCOPE-144).
 */
export const PrepareMarketRequest = z.object({ strategy: Address, ...FormValues, market_state: Address.optional(), trader: Address, then: MarketOpening.optional() }).strict();
export type PrepareMarketRequest = z.infer<typeof PrepareMarketRequest>;

/** A prepared new market: its address and market state, whether that state must sign, the create form's check, and the unsigned transaction when its simulation passed. */
export const PreparedMarket = z.object({
  strategy: Address,
  market: Address,
  market_state: Address,
  market_state_signs: z.boolean(),
  check: FormCheck,
  accounts: z.array(ResolvedAccount),
  wrapped_sol: Amount,
  /** The most SOL the strategy's setup may take from the creator, which `create_market` carries (PIPESCOPE-144). */
  max_creator_lamports: Amount,
  transaction: z.string().nullable(),
  simulation: TransactionSimulation,
});
export type PreparedMarket = z.infer<typeof PreparedMarket>;

/** `POST /v1/transactions`: a custom action's or a new market's signature, from the page that sent it, waited on until it confirms. */
export const TransactionSignature = z
  .object({ signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/), market: Address.optional(), strategy: Address.optional() })
  .strict();
export type TransactionSignature = z.infer<typeof TransactionSignature>;

/** A sent transaction, confirmed: its slot. */
export const TransactionReport = z.object({ signature: z.string(), slot: z.number().int() });
export type TransactionReport = z.infer<typeof TransactionReport>;

/** `POST /v1/trades`: a trade's signature, from the page that sent it (the fast path, PIPESCOPE-33). */
export const TradeSignature = z
  .object({
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/),
    /** The market traded, so a swap that failed on chain is decoded with its strategy named. */
    market: Address.optional(),
  })
  .strict();
export type TradeSignature = z.infer<typeof TradeSignature>;

/**
 * The fast path's answer: the transaction's swaps, read back once it confirmed, each under a provisional
 * order key (no place in its block yet, `block_index` null) that the indexer replaces in place.
 */
export const TradeReport = z.object({ signature: z.string(), slot: z.number().int(), trades: z.array(Trade) });
export type TradeReport = z.infer<typeof TradeReport>;

/** `GET /v1/traders/{trader}/balances?mints=`: what the wallet holds in each mint asked; for wrapped SOL, its plain SOL, which a swap wraps. */
export const Balances = z.object({ trader: Address, balances: z.array(z.object({ mint: Address, amount: Amount })) });
export type Balances = z.infer<typeof Balances>;

// ---- The wallet page (docs/spec/pipescope-screens.md, Wallet page; #122) ----

/** A mint as a list names it: Aviary's own name (SOL, USDC), else the token's, with its decimals (null until read). */
export const MintName = z.object({ mint: Address, symbol: z.string().nullable(), token: TokenName.nullable(), decimals: z.number().int().nullable() });
export type MintName = z.infer<typeof MintName>;

/** `GET /v1/traders/{trader}/trades`: a page of the wallet's swaps through Pipeline, with every mint they name. */
export const TraderTradesPage = TradesPage.extend({ mints: z.array(MintName) });
export type TraderTradesPage = z.infer<typeof TraderTradesPage>;

/**
 * `GET /v1/traders/{trader}/holdings`: what the wallet holds, read through RPC: its SOL; its wrapped
 * SOL, which the page offers to unwrap; each other token it holds that a Pipeline market trades, with
 * those markets (their pairs in `markets`, every mint named in `mints`); and how many tokens it holds
 * that no Pipeline market trades.
 */
export const Holdings = z.object({
  trader: Address,
  sol: Amount,
  wrapped_sol: z.object({ amount: Amount, accounts: z.array(Address) }).nullable(),
  holdings: z.array(MintName.extend({ decimals: z.number().int(), amount: Amount, markets: z.array(Address) })),
  markets: z.array(z.object({ address: Address, base_mint: Address, quote_mint: Address })),
  mints: z.array(MintName),
  not_listed: z.number().int(),
});
export type Holdings = z.infer<typeof Holdings>;

/** `POST /v1/unwrap/prepare`: unwrap the wrapped SOL of the wallet that will sign. */
export const PrepareUnwrapRequest = z.object({ trader: Address }).strict();
export type PrepareUnwrapRequest = z.infer<typeof PrepareUnwrapRequest>;

/**
 * The unwrap prepared: the wrapped-SOL accounts it closes, as many as one transaction holds, what they
 * hold, and how many are `left` for another; the unsigned transaction only when its simulation passed;
 * and the simulation: the network fee and the SOL that comes back (`returned`, every lamport the closed
 * accounts held, the wrapped SOL and their rent; null when it failed).
 */
export const PreparedUnwrap = z.object({
  trader: Address,
  accounts: z.array(Address),
  wrapped: Amount,
  left: z.number().int(),
  transaction: z.string().nullable(),
  simulation: z.object({
    ok: z.boolean(),
    failure: Failure.nullable(),
    logs: z.array(z.string()),
    compute_units: z.number().int().nullable(),
    network_fee: Amount,
    returned: Amount.nullable(),
  }),
});
export type PreparedUnwrap = z.infer<typeof PreparedUnwrap>;


// ---- Canary (#124) ----

/** A program as of one deploy, as a Canary result names it. */
const CanaryRecordVersion = z.object({ deploy_slot: z.number().int().nullable(), executable_sha256: z.string().nullable() });

/**
 * One Canary result (docs/spec/pipescope-canary.md, Records), with the sentences code writes for it
 * (docs/spec/pipescope-screens.md, Canary outcomes), so the page, the trade box and the Telegram bot
 * show the same words: `reason`, the binary's sentence; `about`, what the check does; `ran`, when and
 * on which version it ran.
 */
export const CanaryResult = z.object({
  id: z.string(),
  check: z.string(),
  outcome: CanaryOutcome,
  reason: z.string(),
  about: z.string(),
  ran: z.string(),
  /** The check's plain name, as the pages list it ("Buy, then sell straight back"). */
  name: z.string(),
  /** A check that runs one round trip a step: each size, wait, wallet or buyer, grouped by the mint traded against the money side (its place in the market's mints). */
  steps: z.array(z.object({ pair: z.number().int().nullable(), steps: z.array(z.object({ label: z.string(), state: z.enum(["back", "stuck", "not bought", "no round trip"]), return_ppm: z.number().int().nullable() })) })),
  /** Every distinct step the record names as refused. */
  refusals: z.array(CanaryRefusal),
  harness: z.string(),
  slot: z.number().int(),
  run_at: Time,
  strategy_version: CanaryRecordVersion,
  router_version: CanaryRecordVersion,
  inputs: z.unknown(),
  numbers: z.unknown(),
});
export type CanaryResult = z.infer<typeof CanaryResult>;

/** A strategy version, as Canary's endpoints name it. */
/** `deployed_at` is when its deploy or upgrade landed, null until that transaction is found. */
const CanaryVersion = z.object({ program: Address, deploy_slot: z.number().int(), executable_sha256: z.string().nullable(), deployed_at: Time.nullable(), current: z.boolean() });

/**
 * `GET /v1/markets/{market}/canary[?version=<deploy slot>]`: the market's latest result of each check
 * under its strategy's current version, or the version asked for, and the "could not sell back"
 * notice of the current version's results (CANARY-21), one sentence per result it rests on, each
 * stating its condition; empty when none does.
 */
export const CanaryResults = z.object({
  market: Address,
  /** Null before the watch has recorded any version of the market's strategy: Canary has not run it. */
  version: CanaryVersion.nullable(),
  /** In the checks' fixed order (PIPESCOPE-148). */
  results: z.array(CanaryResult),
  could_not_sell_back: z.array(z.object({ check: z.string(), sentence: z.string() })),
  /** What a row says about these results; null when there are none. */
  summary: MarketCanary.nullable(),
  /** The current version is an upgrade with no result for this market yet: the pages say its tests are pending. */
  upgrade: CanaryUpgrade.nullable(),
});
export type CanaryResults = z.infer<typeof CanaryResults>;

/**
 * `GET /v1/strategies/{program}/versions/{slot}/canary`: the version's roll-up from its markets'
 * latest results, per check how many markets got each outcome and which warn or fail (a count for
 * one check, never a score), and its newest run.
 */
export const CanaryRollup = z.object({
  program: Address,
  deploy_slot: z.number().int(),
  current: z.boolean(),
  markets: z.number().int(),
  /**
   * Each check, with its plain name and its place in the checks' fixed order (`rank`, PIPESCOPE-148),
   * how many markets got each outcome, and the markets that warn or fail, each with its sentence.
   */
  checks: z.record(
    z.string(),
    z.object({
      name: z.string(),
      rank: z.number().int(),
      about: z.string(),
      outcomes: z.partialRecord(CanaryOutcome, z.number().int()),
      warn: z.array(Address),
      fail: z.array(Address),
      held: z.array(z.object({ market: Address, outcome: z.enum(["warn", "fail"]), reason: z.string() })),
    }),
  ),
  /** What the strategy's row says about this version, or null before any result. */
  summary: StrategyCanary.nullable(),
  /** The version is the current one, an upgrade, with no result yet: the pages say its tests are pending. */
  upgrade: CanaryUpgrade.nullable(),
  last_run: z
    .object({ trigger: z.string(), delay_ms: z.number().int(), markets: z.number().int(), started_at: Time, finished_at: Time.nullable() })
    .nullable(),
});
export type CanaryRollup = z.infer<typeof CanaryRollup>;

/**
 * `GET /v1/strategies/{program}/versions/{slot}/canary/schedule`: the runs the version's
 * `CanaryRun` still holds, earliest first, such as a new market's runs 1 hour and 1 day on.
 */
export const CanarySchedule = z.object({
  program: Address,
  deploy_slot: z.number().int(),
  runs: z.array(z.object({ trigger: z.string(), delay_ms: z.number().int(), due_at: Time, markets: z.number().int(), done: z.number().int(), started: z.boolean() })),
});
export type CanarySchedule = z.infer<typeof CanarySchedule>;

/**
 * `POST /v1/canary/reruns`: the owner's re-run (`pnpm canary:rerun`), a payload naming a market or a
 * strategy, signed by the operator wallet (`CANARY_OPERATOR`) over `canaryRerunMessage(payload)`.
 */
export const CanaryRerun = z.object({ payload: z.string().max(1024), signature: z.string().min(64).max(100) }).strict();
export const CanaryRerunPayload = z
  .object({ market: Address.optional(), strategy: Address.optional(), wallet: Address, at: Time })
  .strict()
  .refine((p) => (p.market === undefined) !== (p.strategy === undefined), "A re-run names a market or a strategy.");
export type CanaryRerunPayload = z.infer<typeof CanaryRerunPayload>;
export const CANARY_RERUN_DOMAIN = "canary-rerun/v1";
export const canaryRerunMessage = (payload: string): Uint8Array => new TextEncoder().encode(`${CANARY_RERUN_DOMAIN}\n${payload}`);

// ---- The explanation (#127) ----

/** A sentence an AI wrote, with the ids of the evidence it cites: model text, which a page renders only as plain text. */
export const ExplanationSentence = z.object({ text: z.string(), evidence: z.array(z.string()) });
export type ExplanationSentence = z.infer<typeof ExplanationSentence>;

/** A point of the full explanation: its topic, which groups it on the page, and its basis (the evidence, an inference from it, or author text). */
export const ExplanationClaim = ExplanationSentence.extend({
  topic: z.enum(["does", "control", "canary", "protection", "author"]),
  basis: z.enum(["confirmed", "inferred", "author"]),
});
export type ExplanationClaim = z.infer<typeof ExplanationClaim>;

/** One item of the evidence the explanation was given, as the model read it, with where Aviary read it; `author` marks author text (an A item). */
export const ExplanationEvidence = z.object({ id: z.string(), label: z.string(), value: z.string(), source: z.string(), author: z.boolean() });
export type ExplanationEvidence = z.infer<typeof ExplanationEvidence>;

/**
 * `GET /v1/strategies/{program}/explanation` (docs/spec/pipescope-explainer.md, Presentation;
 * EXPLAINER-15, EXPLAINER-16, EXPLAINER-20): the explanation of the strategy's current version, only
 * for the key that version has now and only once the owner's approve command wrote it, else null;
 * and the fixed notice about author text addressed to AI tools (EXPLAINER-14), shown whether or not
 * an explanation is. `label` is the code-written line above the text, written once here so the pages
 * and the Telegram bot say the same.
 */
export const StrategyExplanation = z.object({
  program: Address,
  /** The current version's deploy slot, or null before the ProgramData watch has read one. */
  deploy_slot: z.number().int().nullable(),
  ai_notice: z.string().nullable(),
  explanation: z
    .object({
      key: z.string(),
      deploy_slot: z.number().int(),
      written_at: Time,
      label: z.string(),
      summary: z.array(ExplanationSentence),
      claims: z.array(ExplanationClaim),
      unknowns: z.array(ExplanationSentence),
      evidence: z.array(ExplanationEvidence),
    })
    .nullable(),
});
export type StrategyExplanation = z.infer<typeof StrategyExplanation>;

/**
 * `POST /v1/explanations/{key}/reports`: "This is wrong", with what the reader says is wrong, if
 * anything. The route refuses a note past REPORT_NOTE_MAX characters (./config); the contract
 * imports nothing, since other packages type-check it on its own.
 */
export const ExplanationReport = z.object({ note: z.string().optional() }).strict();
export type ExplanationReport = z.infer<typeof ExplanationReport>;

/** The answer to a report: its id, and the key it was filed against. */
export const ExplanationReportReceived = z.object({ id: z.string(), key: z.string() });
export type ExplanationReportReceived = z.infer<typeof ExplanationReportReceived>;
