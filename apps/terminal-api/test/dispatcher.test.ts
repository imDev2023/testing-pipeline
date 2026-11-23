import { describe, expect, it, vi } from "vitest";
import { dueJobs, runDueJobs } from "../src/dispatcher";

const at = (iso: string) => Date.parse(iso);

describe("the every-minute dispatcher (PIPESCOPE-89)", () => {
  it("makes the one-minute jobs due on every minute", () => {
    expect(dueJobs(at("2026-11-22T10:01:00Z"))).toEqual(["reconcileRouter", "programDataWatch", "verifiedBuilds"]);
  });

  it("adds a job on the minutes its interval divides", () => {
    expect(dueJobs(at("2026-11-22T10:05:00Z"))).toEqual(["reconcileRouter", "reconcileStrategies", "programDataWatch", "verifiedBuilds"]);
    expect(dueJobs(at("2026-11-22T10:10:00Z"))).toContain("registrySnapshot");
    expect(dueJobs(at("2026-11-22T10:30:00Z"))).not.toContain("metadataRefetch");
  });

  it("makes the daily candle pruning due only at midnight UTC", () => {
    expect(dueJobs(at("2026-11-22T00:00:00Z"))).toContain("pruneCandles");
    expect(dueJobs(at("2026-11-22T11:00:00Z"))).not.toContain("pruneCandles");
  });

  it("makes every hourly job due at the top of the hour", () => {
    expect(dueJobs(at("2026-11-22T11:00:00Z"))).toEqual([
      "reconcileRouter",
      "reconcileStrategies",
      "registrySnapshot",
      "programDataWatch",
      "verifiedBuilds",
      "metadataRefetch",
    ]);
  });

  it("reads the minute the cron was scheduled for, even when it fires a few seconds late", () => {
    expect(dueJobs(at("2026-11-22T10:05:07.250Z"))).toContain("reconcileStrategies");
  });

  it("runs each due job that has been built, and one job failing never stops the others", async () => {
    const reconcileRouter = vi.fn(async () => {
      throw new Error("the RPC refused");
    });
    const programDataWatch = vi.fn(async () => {});
    const metadataRefetch = vi.fn(async () => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await runDueJobs(at("2026-11-22T10:01:00Z"), { reconcileRouter, programDataWatch, metadataRefetch });
    expect(reconcileRouter).toHaveBeenCalledOnce();
    expect(programDataWatch).toHaveBeenCalledOnce();
    expect(metadataRefetch).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ran: ["programDataWatch"], failed: ["reconcileRouter"] });
    expect(log).toHaveBeenCalledWith("job reconcileRouter failed", expect.any(Error));
    log.mockRestore();
  });
});
