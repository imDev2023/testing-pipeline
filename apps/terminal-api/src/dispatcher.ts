// The every-minute cron's dispatcher (PIPESCOPE-89, docs/spec/pipescope-architecture.md, "terminal-api"):
// one Cron Trigger fires each minute, and this runs whatever the intervals in ./config make due.
// Due-ness is worked out from the minute alone, so deciding what to run never wakes the database.
import { JOB_INTERVAL_MINUTES, type JobName } from "./config";

/** A job's work; each lands with its ticket (the indexer's with #116, verified builds' with #128, and so on). */
export type Job = () => Promise<void>;

const MINUTE_MS = 60_000;

/** The jobs due on the minute `scheduledTime` falls in: those whose interval divides the minutes since the epoch. */
export function dueJobs(scheduledTime: number): JobName[] {
  const minute = Math.floor(scheduledTime / MINUTE_MS);
  return (Object.entries(JOB_INTERVAL_MINUTES) as [JobName, number][]).filter(([, every]) => minute % every === 0).map(([name]) => name);
}

/** Runs each due job that has been built, one after another, so one job failing never stops the rest. */
export async function runDueJobs(scheduledTime: number, jobs: Partial<Record<JobName, Job>>): Promise<{ ran: JobName[]; failed: JobName[] }> {
  const ran: JobName[] = [];
  const failed: JobName[] = [];
  for (const name of dueJobs(scheduledTime)) {
    const job = jobs[name];
    if (!job) continue;
    try {
      await job();
      ran.push(name);
    } catch (e) {
      console.error(`job ${name} failed`, e);
      failed.push(name);
    }
  }
  return { ran, failed };
}
