import { describe, expect, it } from "vitest";
import { decodeFailure } from "../src/trading/failure";

const STRATEGY = "yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx";
const ROUTER = "PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

describe("a failure decoded from a simulation's error and logs (docs/spec/pipescope-screens.md, Review and sign)", () => {
  it("names a strategy's refusal by its Anchor error, with the raw error beneath", () => {
    const failure = decodeFailure({ InstructionError: [3, { Custom: 6004 }] }, [
      `Program ${ROUTER} invoke [1]`,
      `Program ${STRATEGY} invoke [2]`,
      "Program log: AnchorError thrown in programs/curve/src/lib.rs:212. Error Code: WrongStatus. Error Number: 6004. Error Message: Not allowed in the curve's current status.",
      `Program ${STRATEGY} consumed 5121 of 180000 compute units`,
      `Program ${STRATEGY} failed: custom program error: 0x1774`,
      `Program ${ROUTER} failed: custom program error: 0x1774`,
    ], { strategy: STRATEGY });
    expect(failure).toEqual({
      class: "strategy_refused",
      sentence: "The strategy refused it: WrongStatus, \"Not allowed in the curve's current status\".",
      name: "WrongStatus",
      number: 6004,
      message: "Not allowed in the curve's current status",
      program: STRATEGY,
      raw: '{"InstructionError":[3,{"Custom":6004}]}',
    });
  });

  it("reads an error whose numbers Kit's RPC gave as bigints", () => {
    expect(decodeFailure({ InstructionError: [3n, { Custom: 6004n }] }, [`Program ${STRATEGY} failed: custom program error: 0x1774`], { strategy: STRATEGY })).toMatchObject({
      class: "strategy_refused",
      number: 6004,
      raw: '{"InstructionError":[3,{"Custom":6004}]}',
    });
  });

  it("names the router's refusal as the router's", () => {
    const failure = decodeFailure({ InstructionError: [2, { Custom: 6020 }] }, [
      "Program log: AnchorError occurred. Error Code: InsufficientOutput. Error Number: 6020. Error Message: Output is below the minimum.",
      `Program ${ROUTER} failed: custom program error: 0x1784`,
    ], { strategy: STRATEGY });
    expect(failure.class).toBe("router_refused");
    expect(failure.sentence).toBe("Pipeline's router refused it: InsufficientOutput, \"Output is below the minimum\".");
  });

  it("tells a wallet holding too little token so, in those words", () => {
    const failure = decodeFailure({ InstructionError: [2, { Custom: 1 }] }, ["Program log: Error: insufficient funds", `Program ${TOKEN} failed: custom program error: 0x1`], { strategy: STRATEGY });
    expect(failure).toMatchObject({ class: "too_little", name: "InsufficientFunds", program: TOKEN });
    expect(failure.sentence).toBe("Your wallet holds too little for this swap.");
  });

  it("tells a wallet holding too little SOL so, from the system program's transfer", () => {
    const failure = decodeFailure({ InstructionError: [1, { Custom: 1 }] }, [
      "Transfer: insufficient lamports 2039280, need 100000000",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x1",
    ], { strategy: STRATEGY });
    expect(failure).toMatchObject({ class: "too_little", sentence: "Your wallet holds too little for this swap." });
  });

  it("tells a wallet with no SOL for the network fee so", () => {
    expect(decodeFailure("InsufficientFundsForFee", [], { strategy: STRATEGY })).toMatchObject({ class: "too_little", sentence: "Your wallet holds too little for this swap: it cannot pay the network fee." });
    expect(decodeFailure("AccountNotFound", [], { strategy: STRATEGY })).toMatchObject({ class: "too_little", sentence: "Your wallet holds too little for this swap: it has never held SOL, so it cannot pay the network fee." });
  });

  it("names a crash and running out of compute", () => {
    expect(decodeFailure({ InstructionError: [3, "ProgramFailedToComplete"] }, [`Program log: panicked at src/lib.rs:80:32: attempt to subtract with overflow`, `Program ${STRATEGY} failed: SBF program panicked`], { strategy: STRATEGY })).toMatchObject({
      class: "crash",
      sentence: "The strategy crashed instead of answering: panicked at src/lib.rs:80:32: attempt to subtract with overflow.",
    });
    expect(decodeFailure({ InstructionError: [3, "ComputationalBudgetExceeded"] }, [`Program ${STRATEGY} failed: exceeded CUs meter at BPF instruction`], { strategy: STRATEGY })).toMatchObject({
      class: "out_of_compute",
      sentence: "It ran out of compute before it finished.",
    });
  });

  it("names a strategy that cannot read the market's state", () => {
    const failure = decodeFailure({ InstructionError: [3, { Custom: 3003 }] }, [
      "Program log: AnchorError caused by account: pool. Error Code: AccountDidNotDeserialize. Error Number: 3003. Error Message: Failed to deserialize the account.",
      `Program ${STRATEGY} failed: custom program error: 0xbbb`,
    ], { strategy: STRATEGY });
    expect(failure.class).toBe("cannot_read_state");
    expect(failure.sentence).toBe("The strategy cannot read this market's state: AccountDidNotDeserialize, \"Failed to deserialize the account\".");
  });

  it("falls back to the raw error for anything else, naming the program that raised it", () => {
    const failure = decodeFailure({ InstructionError: [0, "InvalidAccountData"] }, ["Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL failed: invalid account data for instruction"], { strategy: STRATEGY });
    expect(failure).toMatchObject({ class: "other_refused", program: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", raw: '{"InstructionError":[0,"InvalidAccountData"]}' });
    expect(failure.sentence).toBe("Program ATok...8knL refused it: invalid account data for instruction.");
  });
});
