"use client";

import { Keeper, type KeeperJob } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { formatAge, formatDate, formatDay } from "@/format";
import { formatSol, jobName, livenessSentence, outcomeText, PASS_LABELS, passSummary, productName, waitingReason } from "@/keeperText";
import { ShortAddress, ShortSignature, SubjectAddress } from "./Address";
import { PanelFrame, useLoad, type Loaded } from "./Panel";
import { Table } from "./Table";
import styles from "./KeeperView.module.css";

// A module-level function, so the page loads once per mount rather than once per render.
const loadKeeper = (signal: AbortSignal) => getFromApi("/keeper", Keeper, { signal });

/** An age, with the date on hover (docs/spec/pipescope-screens.md, "On every page"). */
function Age({ at }: { at: string }) {
  const date = new Date(at);
  return (
    <time className={styles.nowrap} dateTime={at} title={formatDate(date)}>
      {formatAge(date)}
    </time>
  );
}

/** The runner's records, or the database's failure as this panel's own, so the wallet and the runner's state still show. */
function records(state: Loaded<Keeper>): Loaded<Keeper> {
  if (state.status !== "loaded" || state.data.records.ok) return state;
  return { status: "failed", message: `The runner's records could not be read: ${state.data.records.error}.` };
}

function Market({ job }: { job: Pick<KeeperJob, "market" | "product"> }) {
  if (!job.market) return <span className={styles.note}>The keeper wallet</span>;
  return (
    <span className={styles.market}>
      <ShortAddress address={job.market} />
      {job.product && <span className={styles.note}>{productName(job.product)}</span>}
    </span>
  );
}

/** A job's name and slot as code, which may break between the two on a narrow screen but never inside either. */
function JobName({ job }: { job: Pick<KeeperJob, "job" | "slot"> }) {
  const [name, slot] = jobName(job).split(", ");
  return (
    <code className={styles.job}>
      <span className={styles.nowrap}>{slot ? `${name},` : name}</span>
      {slot && (
        <>
          {" "}
          <span className={styles.nowrap}>{slot}</span>
        </>
      )}
    </code>
  );
}

/** Why a job waits, with the cap's name as code. */
function Waiting({ job }: { job: Pick<KeeperJob, "outcome" | "cap" | "error"> }) {
  if (job.outcome === "held" && job.cap) {
    return (
      <span>
        Held by <code className={styles.nowrap}>{job.cap}</code>
      </span>
    );
  }
  return <span>{waitingReason(job)}</span>;
}

/**
 * The keeper page (docs/spec/keeper-runner.md, "How Aviary shows it"; PIPESCOPE-97, PIPESCOPE-104):
 * whether the runner is running, the keeper wallet and its balance, today's spend against each cap,
 * the last pass of each kind, the held and parked jobs and the latest jobs with their transactions.
 */
export function KeeperView() {
  const { state, retry } = useLoad(loadKeeper);
  const recorded = records(state);
  const keeper = state.status === "loaded" ? state.data : null;
  const liveness = keeper ? livenessSentence(keeper.liveness) : null;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>Keeper</h1>
        <p className={styles.lede}>
          Some jobs of the suite&apos;s markets wait for someone to send them: payouts, the buy wall, a lending market&apos;s rebalance. Anyone may send them.
          The keeper runner sends each one when it is due, paying from its own wallet under daily caps, and this page shows what it did and spent.
        </p>
        {liveness && keeper && (
          <div className={styles.status} role="status">
            <p>
              <strong className={styles.headline}>{liveness.headline}.</strong> {liveness.detail}
            </p>
            {keeper.warnings && keeper.warnings.list.length > 0 && (
              <div className={styles.warnings}>
                <p>
                  Warnings from the pass that ended <Age at={keeper.warnings.at} />:
                </p>
                <ul>
                  {keeper.warnings.list.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </header>

      <div className={styles.panels}>
        <div className={styles.column}>
          <PanelFrame title="Keeper wallet" what="the keeper wallet" state={state} retry={retry}>
            {(data) => (
              <div className={styles.stack}>
                <SubjectAddress address={data.wallet} />
                <dl className={styles.facts}>
                  <div>
                    <dt>Balance</dt>
                    <dd>{data.balance.lamports === null ? `Not read: ${data.balance.error}.` : formatSol(data.balance.lamports)}</dd>
                  </div>
                  {data.caps && (
                    <>
                      <div>
                        <dt>Every pass warns below</dt>
                        <dd>
                          {formatSol(data.caps.lowBalance)} <code>LOW_BALANCE</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Sends nothing below</dt>
                        <dd>
                          {formatSol(data.caps.minBalance)} <code>MIN_BALANCE</code>
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
              </div>
            )}
          </PanelFrame>

          <PanelFrame title="Held and parked" what="the held and parked jobs" state={recorded} retry={retry}>
            {(data) =>
              data.waiting.length === 0 ? (
                <p className={styles.note}>No job is held by a cap or parked.</p>
              ) : (
                <Table
                  caption="Jobs held by a cap or parked"
                  columns={[
                    { key: "market", label: "Market" },
                    { key: "job", label: "Job" },
                    { key: "since", label: "Since" },
                    { key: "why", label: "Why" },
                  ]}
                  rows={data.waiting.map((job) => ({
                    key: `${job.market}:${job.job}:${job.slot}`,
                    cells: { market: <Market job={job} />, job: <JobName job={job} />, since: <Age at={job.at} />, why: <Waiting job={job} /> },
                  }))}
                />
              )
            }
          </PanelFrame>
        </div>

        <div className={styles.column}>
          <PanelFrame title="Spent today" what="today's spend" state={recorded} retry={retry}>
            {(data) => (
              <div className={styles.stack}>
                <p className={styles.note}>{formatDay(data.today.day)}, in UTC. A cap that is reached holds every job it covers until the next day.</p>
                <dl className={styles.facts}>
                  <div>
                    <dt>All markets</dt>
                    <dd>
                      {formatSol(data.today.spentTotal)}
                      {data.caps && (
                        <>
                          {" "}
                          of {formatSol(data.caps.dailyCap)} <code>DAILY_CAP</code>
                        </>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Most one transaction cost</dt>
                    <dd>
                      {data.today.highestCost === null ? "Nothing sent yet" : formatSol(data.today.highestCost)}
                      {data.caps && (
                        <>
                          {" "}
                          of {formatSol(data.caps.maxTxCost)} <code>MAX_TX_COST</code>
                        </>
                      )}
                    </dd>
                  </div>
                </dl>
                {data.today.markets.length > 0 && (
                  <Table
                    caption="Spent today on each market"
                    columns={[
                      { key: "market", label: "Market" },
                      { key: "spent", label: "Spent" },
                    ]}
                    rows={data.today.markets.map(({ market, spent }) => ({
                      key: market,
                      cells: { market: <ShortAddress address={market} />, spent: <span className={styles.nowrap}>{formatSol(spent)}</span> },
                    }))}
                  />
                )}
                {data.caps && (
                  <p className={styles.note}>
                    At most {formatSol(data.caps.marketDailyCap)} a market a day <code>MARKET_DAILY_CAP</code>.
                  </p>
                )}
              </div>
            )}
          </PanelFrame>

          <PanelFrame title="Passes" what="the runner's passes" state={state} retry={retry}>
            {(data) => (
              <div className={styles.stack}>
                <Table
                  caption="The last pass of each kind"
                  columns={[
                    { key: "pass", label: "Pass" },
                    { key: "ran", label: "Last ran" },
                    { key: "recorded", label: "Last did something" },
                  ]}
                  rows={data.passes.map((pass) => ({
                    key: pass.pass,
                    cells: {
                      pass: PASS_LABELS[pass.pass].label,
                      ran: pass.lastRanAt ? <Age at={pass.lastRanAt} /> : <span className={styles.note}>No heartbeat yet</span>,
                      recorded: !data.records.ok ? (
                        <span className={styles.note}>Not read</span>
                      ) : pass.lastRecorded ? (
                        <span>
                          <Age at={pass.lastRecorded.at} />, {passSummary(pass.lastRecorded)}
                        </span>
                      ) : (
                        <span className={styles.note}>Nothing recorded</span>
                      ),
                    },
                  }))}
                />
                <p className={styles.note}>
                  The runner records a pass only when it sends, holds or parks a job, so {BRAND.name}&apos;s database can sleep while devnet is quiet; its
                  heartbeats say when each pass last ran.
                </p>
              </div>
            )}
          </PanelFrame>
        </div>
      </div>

      <PanelFrame title="Latest jobs" what="the runner's latest jobs" state={recorded} retry={retry}>
        {(data) =>
          data.recent.length === 0 ? (
            <p className={styles.note}>The runner has recorded no job yet.</p>
          ) : (
            <Table
              caption="The runner's latest jobs, newest first"
              columns={[
                { key: "when", label: "When" },
                { key: "market", label: "Market" },
                { key: "job", label: "Job" },
                { key: "outcome", label: "Outcome" },
                { key: "cost", label: "Cost" },
                { key: "transaction", label: "Transaction" },
              ]}
              rows={data.recent.map((job, i) => ({
                key: `${job.at}:${i}`,
                cells: {
                  when: <Age at={job.at} />,
                  market: <Market job={job} />,
                  job: <JobName job={job} />,
                  outcome: job.outcome === "held" || job.outcome === "parked" ? <Waiting job={job} /> : outcomeText(job),
                  cost: job.cost === null ? <span className={styles.note}>None</span> : <span className={styles.nowrap}>{formatSol(job.cost)}</span>,
                  transaction: job.signature ? <ShortSignature signature={job.signature} /> : <span className={styles.note}>None</span>,
                },
              }))}
            />
          )
        }
      </PanelFrame>
    </div>
  );
}
