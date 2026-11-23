// A strategy version's instruction list (docs/spec/pipescope-canary.md, "Custom instructions are
// listed, not called"; PIPESCOPE-92): each "Instruction: Name" string Anchor compiles in, kept only
// when the discriminator of that name is also in the code.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { anchorDiscriminator, instructionList } from "../src/index";

const text = (s: string) => new TextEncoder().encode(s);
const disc = (snake: string) => Uint8Array.from(createHash("sha256").update(`global:${snake}`).digest().subarray(0, 8));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
/** An SBF `lddw` loading a 64-bit immediate: opcode 0x18, its low half in the first slot's immediate, its high half in the second's. */
const lddw = (value: Uint8Array) => concat(Uint8Array.of(0x18, 0x01, 0, 0), value.subarray(0, 4), Uint8Array.of(0, 0, 0, 0), value.subarray(4, 8));
const padding = new Uint8Array(64).fill(0x5a);

describe("anchorDiscriminator", () => {
  it("is the first eight bytes of sha256 of global: and the name in snake case", async () => {
    expect(await anchorDiscriminator("ClaimCreatorFees")).toEqual(disc("claim_creator_fees"));
    expect(await anchorDiscriminator("PipelineInitMarket")).toEqual(disc("pipeline_init_market"));
    expect(await anchorDiscriminator("SwapV2")).toEqual(disc("swap_v2"));
  });
});

describe("instructionList", () => {
  it("keeps each name whose discriminator is in the code, Pipeline's six marked as Pipeline's", async () => {
    const program = concat(padding, text("Instruction: DepositInstruction: PipelineSwap"), padding, disc("deposit"), padding, disc("pipeline_swap"), padding);
    expect(await instructionList(program)).toEqual({
      anchor: true,
      instructions: [
        { name: "Deposit", discriminator: Buffer.from(disc("deposit")).toString("hex"), pipeline: false },
        { name: "PipelineSwap", discriminator: Buffer.from(disc("pipeline_swap")).toString("hex"), pipeline: true },
      ],
    });
  });

  it("cuts a name that runs on into the next string at the longest prefix whose discriminator is in the code", async () => {
    const program = concat(padding, text("Instruction: ClaimFeesInsufficient funds in the vault"), padding, disc("claim_fees"), padding);
    expect((await instructionList(program)).instructions.map((i) => i.name)).toEqual(["ClaimFees"]);
  });

  it("cuts a name that runs on into a string beginning in lower case, as the outside builder's SetMetadata does on devnet", async () => {
    const program = concat(padding, text("Instruction: PublishManifestInstruction: SetMetadatafactoryauthorityquote_mint"), padding, lddw(disc("publish_manifest")), padding, lddw(disc("set_metadata")), padding);
    expect((await instructionList(program)).instructions.map((i) => i.name)).toEqual(["PublishManifest", "SetMetadata"]);
  });

  it("finds names heck writes without the underscores of their functions' names, before digits and between single letters", async () => {
    const program = concat(padding, text("Instruction: Swap2"), padding, disc("swap_2"), padding, text("Instruction: UpdateAB"), padding, disc("update_a_b"), padding, text("Instruction: InitPool2x"), lddw(disc("init_pool_2x")), padding);
    expect((await instructionList(program)).instructions).toEqual([
      { name: "Swap2", discriminator: Buffer.from(disc("swap_2")).toString("hex"), pipeline: false },
      { name: "UpdateAB", discriminator: Buffer.from(disc("update_a_b")).toString("hex"), pipeline: false },
      { name: "InitPool2x", discriminator: Buffer.from(disc("init_pool_2x")).toString("hex"), pipeline: false },
    ]);
  });

  it("drops a name whose discriminator is not in the code", async () => {
    const program = concat(padding, text("Instruction: Deposit"), padding, text("Instruction: Ghost"), padding, disc("deposit"), padding);
    expect((await instructionList(program)).instructions.map((i) => i.name)).toEqual(["Deposit"]);
  });

  it("finds a discriminator compiled into a 64-bit immediate, split over an lddw's two slots", async () => {
    const program = concat(padding, text("Instruction: SetFeeRecipient"), padding, lddw(disc("set_fee_recipient")), padding);
    expect((await instructionList(program)).instructions.map((i) => i.name)).toEqual(["SetFeeRecipient"]);
  });

  it("lists a name once though Anchor compiles it in more than once", async () => {
    const program = concat(padding, text("Instruction: Buy"), padding, text("Instruction: Buy"), disc("buy"), padding);
    expect((await instructionList(program)).instructions.map((i) => i.name)).toEqual(["Buy"]);
  });

  it("says a program with no name it can confirm is not built with Anchor, and lists nothing", async () => {
    expect(await instructionList(concat(padding, text("Program log: hello"), padding))).toEqual({ anchor: false, instructions: [] });
    expect(await instructionList(concat(padding, text("Instruction: Ghost"), padding))).toEqual({ anchor: false, instructions: [] });
  });
});
