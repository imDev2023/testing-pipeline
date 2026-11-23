// A strategy version's instruction list (docs/spec/pipescope-canary.md, "Custom instructions are
// listed, not called"; PIPESCOPE-92), worked out once per version from its program's bytes and read
// by the facts panel, the forms' instruction check, the explainer's F items and Canary's snapshot.
//
// Anchor compiles a log line "Instruction: Name" into each instruction's handler. Strings sit side by
// side in the program's read-only data with nothing between them, so a name can run on into the next
// string ("ClaimFeesInsufficient funds"); a name is kept only when its discriminator,
// sha256("global:<snake_case_name>")[..8], is also in the code, which cuts such run-ons too.

/** One instruction compiled into a program: its name as Anchor logs it and its discriminator in hex. */
export type ProgramInstruction = { name: string; discriminator: string; pipeline: boolean };

/** What a program's bytes say of its instructions; `anchor` is false when no name could be confirmed, so none can be named. */
export type InstructionList = { anchor: boolean; instructions: ProgramInstruction[] };

/** Pipeline's six strategy instructions (pipeline-strategy-interface), which Canary leaves out by name. */
export const PIPELINE_INSTRUCTIONS = ["PipelineInitMarket", "PipelineMarketInfo", "PipelineResolveAccounts", "PipelineQuote", "PipelineSwap", "PipelineSeedLiquidity"] as const;

const MARKER = new TextEncoder().encode("Instruction: ");
/** The longest name looked at; nothing Anchor names is near it. */
const MAX_NAME = 96;
/** SBF's `lddw`, which loads a 64-bit immediate split over two eight-byte slots. */
const LDDW = 0x18;

/**
 * The snake-case names whose UpperCamelCase, as heck writes it, is `name`: the function names Anchor
 * could have logged as it. heck drops an underscore before a digit ("swap_2" logs as "Swap2") and
 * between one-letter words ("update_a_b" as "UpdateAB"), so at each such place both are tried; the
 * first is the usual reading ("ClaimCreatorFees" is "claim_creator_fees").
 */
export function snakeCases(name: string): string[] {
  // Words: a capital and the small letters after it, a run of digits and the small letters after
  // it ("2x"), or a lone run of small letters at the start.
  const words = name.match(/[A-Z][a-z]*|[0-9]+[a-z]*|[a-z]+/g) ?? [name];
  // Between two words an underscore is certain, except before digits and between one-letter capitals.
  const optional = words.slice(1).map((w, i) => /^[0-9]/.test(w) || (w.length === 1 && words[i]!.length === 1 && /^[A-Z]$/.test(words[i]!)));
  // The usual reading puts an underscore between one-letter capitals and none before digits.
  const usual = words.slice(1).map((w) => !/^[0-9]/.test(w));
  const choices = optional.filter(Boolean).length;
  const names: string[] = [];
  // Each bit of `mask` turns one optional place from its usual reading, at most six of them, so a
  // long name of digits and initials cannot blow up.
  for (let mask = 0; mask < 1 << Math.min(choices, 6); mask++) {
    let bit = 0;
    let out = words[0]!.toLowerCase();
    words.slice(1).forEach((w, i) => {
      const underscore = optional[i] ? usual[i] !== Boolean((mask >> bit++) & 1) : true;
      out += (underscore ? "_" : "") + w.toLowerCase();
    });
    names.push(out);
  }
  return [...new Set(names)];
}

/** Anchor's discriminator of a snake-case instruction name: the first eight bytes of sha256 of "global:" and the name. */
async function discriminatorOf(snake: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${snake}`));
  return new Uint8Array(digest, 0, 8);
}

/** Anchor's discriminator of an instruction named as Anchor logs it, by the usual reading of its name. */
export async function anchorDiscriminator(name: string): Promise<Uint8Array> {
  return discriminatorOf(snakeCases(name)[0]!);
}

const isNameChar = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const isUpper = (b: number) => b >= 0x41 && b <= 0x5a;

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0]!;
  outer: for (let i = haystack.indexOf(first, from); i >= 0 && i <= haystack.length - needle.length; i = haystack.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * The candidate names after each marker: every prefix of the run of name characters that follows
 * it, since the next string can begin with any letter ("SetMetadatafactory"). Each marker's name is
 * its longest candidate whose discriminator is in the code.
 */
function candidatesAt(code: Uint8Array, start: number): string[] {
  let end = start;
  while (end < code.length && end - start < MAX_NAME && isNameChar(code[end]!)) end++;
  if (end === start || !isUpper(code[start]!)) return [];
  const run = new TextDecoder().decode(code.subarray(start, end));
  return Array.from({ length: run.length }, (_, i) => run.slice(0, i + 1));
}

/** SBPF v2's `hor64`, which loads the upper half of a 64-bit immediate where v1 used `lddw`'s second slot. */
const HOR64 = 0xf7;

/**
 * Which of the discriminators the code holds, in one pass over it: side by side (a constant slice
 * compared with `starts_with`), or split over two eight-byte instruction slots as a 64-bit
 * immediate (a u64 compared in a `match`), by `lddw` or by SBPF v2's `mov32` and `hor64`.
 */
function discriminatorsIn(code: Uint8Array, wanted: Map<string, Uint8Array>): Set<string> {
  const byLow = new Map<number, { name: string; high: number }[]>();
  for (const [name, d] of wanted) {
    const view = new DataView(d.buffer, d.byteOffset, 8);
    const low = view.getUint32(0, true);
    byLow.set(low, [...(byLow.get(low) ?? []), { name, high: view.getUint32(4, true) }]);
  }
  const found = new Set<string>();
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  for (let j = 0; j + 8 <= code.length; j++) {
    const candidates = byLow.get(view.getUint32(j, true));
    if (!candidates) continue;
    for (const { name, high } of candidates) {
      if (view.getUint32(j + 4, true) === high) found.add(name);
      else if (j + 12 <= code.length && view.getUint32(j + 8, true) === high && (code[j - 4] === LDDW || code[j + 4] === HOR64)) found.add(name);
    }
  }
  return found;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The instructions compiled into a program, from its executable's bytes, in the order their names appear. */
export async function instructionList(code: Uint8Array): Promise<InstructionList> {
  const markers: string[][] = [];
  for (let at = indexOf(code, MARKER); at >= 0; at = indexOf(code, MARKER, at + MARKER.length)) markers.push(candidatesAt(code, at + MARKER.length));
  // Every reading of every candidate, keyed "name/snake", so each is looked for in the code once.
  const discriminators = new Map<string, Uint8Array>();
  for (const name of new Set(markers.flat())) for (const snake of snakeCases(name)) discriminators.set(`${name}/${snake}`, await discriminatorOf(snake));
  const inCode = discriminatorsIn(code, discriminators);
  const found = new Map<string, ProgramInstruction>();
  for (const candidates of markers) {
    // The longest prefix with a reading whose discriminator is in the code: the name, cut where it ran on.
    for (const name of [...candidates].reverse()) {
      const key = snakeCases(name).map((snake) => `${name}/${snake}`).find((k) => inCode.has(k));
      if (!key) continue;
      if (!found.has(name)) found.set(name, { name, discriminator: hex(discriminators.get(key)!), pipeline: (PIPELINE_INSTRUCTIONS as readonly string[]).includes(name) });
      break;
    }
  }
  const instructions = [...found.values()];
  return { anchor: instructions.length > 0, instructions };
}
