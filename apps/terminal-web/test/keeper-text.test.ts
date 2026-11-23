import type { KeeperJob } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { BRAND } from "../src/brand";
import { formatSol, jobName, livenessSentence, outcomeText, PASS_LABELS, passSummary, waitingReason } from "../src/keeperText";

// The keeper page's sentences (docs/spec/keeper-runner.md, "How Aviary shows it"), written once by code.
const NOW = new Date("2026-11-22T12:00:00Z");
const job = { at: "2026-11-22T11:30:00.000Z", pass: "sweep", market: "FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB", product: "tax-amm", signature: null, cost: null, cap: null, error: null };

describe("the keeper page's text", () => {
  it("writes lamports as SOL to four significant figures", () => {
    expect(formatSol(5_000)).toBe("0.000005 SOL");
    expect(formatSol(1_987_654_321)).toBe("1.988 SOL");
    expect(formatSol(100_000_000)).toBe("0.1 SOL");
    expect(formatSol(0)).toBe("0 SOL");
  });

  it("says the runner is running, with its last pass and how long ago it ended", () => {
    expect(livenessSentence({ state: "running", lastPass: { pass: "sweep", at: "2026-11-22T11:57:00.000Z" }, stoppedAfterMs: 900_000, sweepIntervalMs: 600_000 }, NOW)).toEqual({
      headline: "Running",
      detail: "Its last pass, a sweep, ended 3m ago.",
    });
  });

  it("says the runner looks stopped once its last pass is past the threshold, and what that means", () => {
    expect(livenessSentence({ state: "looks-stopped", lastPass: { pass: "daily", at: "2026-11-22T11:18:00.000Z" }, stoppedAfterMs: 900_000, sweepIntervalMs: 600_000 }, NOW)).toEqual({
      headline: "Looks stopped",
      detail: "Its last pass, the daily pass, ended 42m ago, and it sweeps every 10 minutes. Due jobs wait meanwhile, and anyone may send them.",
    });
    expect(livenessSentence({ state: "looks-stopped", lastPass: { pass: "sweep", at: "2026-11-22T11:53:00.000Z" }, stoppedAfterMs: 360_000, sweepIntervalMs: 60_000 }, NOW).detail).toBe(
      "Its last pass, a sweep, ended 7m ago, and it sweeps every minute. Due jobs wait meanwhile, and anyone may send them.",
    );
    expect(livenessSentence({ state: "looks-stopped", lastPass: { pass: "sweep", at: "2026-11-22T11:53:00.000Z" }, stoppedAfterMs: 390_000, sweepIntervalMs: 90_000 }, NOW).detail).toContain("it sweeps every 90 seconds.");
  });

  it("says when no heartbeat has ever come", () => {
    expect(livenessSentence({ state: "no-heartbeat", lastPass: null, stoppedAfterMs: null, sweepIntervalMs: null }, NOW)).toEqual({
      headline: "No heartbeat",
      detail: `No heartbeat has reached ${BRAND.name} from the runner, so whether it is running cannot be told.`,
    });
  });

  it("names every kind of pass", () => {
    expect(Object.keys(PASS_LABELS).sort()).toEqual(["daily", "hourly", "once", "retry", "start", "sweep", "transaction"]);
  });

  it("names a job with its slot", () => {
    expect(jobName({ job: "distribute", slot: 2 })).toBe("distribute, slot 2");
    expect(jobName({ job: "place_wall", slot: null })).toBe("place_wall");
  });

  it("says why a job waits: the cap that holds it, or the error it was parked with", () => {
    const held: KeeperJob = { ...job, job: "distribute", slot: 2, outcome: "held", cap: "MARKET_DAILY_CAP" };
    const parked: KeeperJob = { ...job, job: "settle", slot: null, outcome: "parked", error: "custom program error: 0x1772" };
    expect(waitingReason(held)).toBe("Held by MARKET_DAILY_CAP");
    expect(waitingReason(parked)).toBe("Parked after its last retry: custom program error: 0x1772");
  });

  it("says what each recorded job did, as a transaction that landed or as what happened instead", () => {
    const landed = (outcome: string) => outcomeText({ outcome, signature: "5sig" });
    const unsent = (outcome: string) => outcomeText({ outcome, signature: null });
    expect(landed("sent")).toBe("Sent");
    expect(landed("failed")).toBe("Landed refused");
    expect(landed("later-slot")).toBe("Landed too early, sent again");
    expect(landed("nothing-to-do")).toBe("Landed with nothing to do");
    expect(unsent("failed")).toBe("Failed in simulation");
    expect(unsent("later-slot")).toBe("Refused until a later slot");
    expect(unsent("nothing-to-do")).toBe("Nothing to do");
    expect(unsent("chain-error")).toBe("The RPC could not be asked");
    expect(unsent("not-yet")).toBe("Ran too recently");
    expect(unsent("held")).toBe("Held");
    expect(unsent("parked")).toBe("Parked");
    expect(unsent("unparked")).toBe("Unparked, its market changed");
    expect(unsent("no-longer-due")).toBe("No longer due");
    expect(unsent("something-new")).toBe("something-new");
  });

  it("sums up what a recorded pass did", () => {
    expect(passSummary({ sent: 4, held: 0, parked: 0, failed: 0, jobs: 4 })).toBe("sent 4");
    expect(passSummary({ sent: 1, held: 2, parked: 0, failed: 1, jobs: 4 })).toBe("sent 1, held 2, failed 1");
    expect(passSummary({ sent: 0, held: 0, parked: 0, failed: 0, jobs: 1 })).toBe("recorded 1 job");
    expect(passSummary({ sent: 0, held: 0, parked: 0, failed: 0, jobs: 3 })).toBe("recorded 3 jobs");
  });
});

describe("product names", () => {
  it("name the runner's products as people call them, and keep an unknown one's own name", async () => {
    const { productName } = await import("../src/keeperText");
    expect(productName("tax-amm")).toBe("Tax AMM");
    expect(productName("buy-wall-amm")).toBe("Buy wall AMM");
    expect(productName("lending-amm")).toBe("Lending AMM");
    expect(productName("new-thing")).toBe("new-thing");
  });
});
