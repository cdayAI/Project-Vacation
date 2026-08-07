import { describe, it, expect } from "vitest";
import { AuditLog } from "../audit/log.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { MemoryRunStore } from "../record/store.memory.js";
import { MemoryDb } from "../store/db.js";
import { runTimeline } from "../api/run-timeline.js";
import type { Platform } from "../platform.js";
import { DEFAULT_REPORT_LIMITS, ReportIngestor } from "../external/report.js";
import {
  MemoryEnrollmentStore,
  MemoryExternalRunStore,
  MemorySpendStore,
} from "../external/store.memory.js";
import type { EnrolledAgent, ExternalAgentId, RunReport } from "../external/types.js";

/**
 * Pass 5 — do the cost rollups reconcile?
 *
 * The question is whether steps sum to the run and runs sum to the report. The
 * run-level and report-level figures do reconcile: `costForRun` sums the ledger
 * for a run, the ceilings read the same sum, and the spend meter is moved from
 * the same number, so the executive total is right.
 *
 * The step level is where it breaks, and only for external work.
 * `api/run-timeline.ts:160` states the intended property outright — "the run
 * total is the sum of the ledger either way, so the column and the header
 * cannot disagree". They can. The header is the whole ledger for the run; the
 * column is the ledger restricted to entries that name a step
 * (`run-timeline.ts:185`). Every entry without a `stepId` is therefore in the
 * header and in no row.
 *
 * Two paths write exactly such an entry, and they are the two that carry
 * external-agent spend:
 *
 *   `external/report.ts:508`  one cost entry per ingested episode, no `stepId`,
 *                             with the per-step figures kept in step `detail`
 *                             as `reportedCostUsd` — a display value nothing
 *                             sums.
 *   `external/runs.ts:399`    one cost entry per finished live run, no `stepId`.
 *
 * So the run-detail screen for an external agent's episode shows every step at
 * $0.00 under a non-zero total, and a reviewer asking "which step spent this?"
 * cannot be answered from the record. That is the drill-down for precisely the
 * work the external plane exists to make visible.
 *
 * The comment quoted above is not merely optimistic; it is the reason nobody
 * looked. Whether the fix is to attribute the ledger per step or to surface the
 * unattributed remainder as its own row is a product decision, not a bug fix —
 * see the report.
 *
 * **Resolved.** The owner chose both halves of that: the step figures are
 * attributed to their steps, and whatever the agent did not attribute is
 * carried as its own figure rather than spread across them. The analysis above
 * is left as written, because it is the evidence for the decision; the second
 * suite in this file is the decided behaviour, including the case where an
 * agent's steps and its total contradict each other.
 */

const START = "2026-08-06T12:00:00.000Z";
const AGENT = "eag_rollup" as ExternalAgentId;

function agentRow(): EnrolledAgent {
  return {
    id: AGENT,
    name: "crm-renewal-assistant",
    owner: "dana.reyes@mvw.example",
    department: "owner-services",
    hostPlatform: "vendor-crm",
    purpose: "Drafts renewal follow-ups.",
    allowedTools: [],
    riskCeiling: "sensitive",
    spendCeilingUsd: 500,
    budgetPeriod: "monthly",
    wallClockCeilingMs: 60_000,
    dataScopes: [],
    expiresAt: "2026-12-01T00:00:00.000Z",
    status: "active",
    enrolledBy: "admin@mvw.example",
    enrolledAt: START,
    updatedAt: START,
  };
}

const REPORT: RunReport = {
  agentId: AGENT,
  idempotencyKey: "episode-rollup-001",
  goal: "Draft renewal follow-ups for the August cohort",
  startedAt: "2026-08-06T11:45:00.000Z",
  endedAt: "2026-08-06T11:55:00.000Z",
  outcome: "succeeded",
  summary: "Drafted 14 follow-ups and filed them for review.",
  steps: [
    {
      name: "read_contact",
      startedAt: "2026-08-06T11:50:00.000Z",
      endedAt: "2026-08-06T11:50:02.000Z",
      outcome: "succeeded",
      costUsd: 0.85,
    },
    {
      name: "draft_note",
      tool: "crm.draft_note",
      startedAt: "2026-08-06T11:50:02.000Z",
      endedAt: "2026-08-06T11:52:00.000Z",
      outcome: "succeeded",
      costUsd: 0.4,
    },
  ],
  costUsd: 1.25,
  subject: { cohort: "2026-08" },
};

async function ingestOneEpisode(report: RunReport = REPORT) {
  const clock = new FixedClock(START);
  const ids = new SeededIdGenerator("pass5-rollup");
  const db = new MemoryDb();
  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const record = new MemoryRunStore(db, clock, ids);

  const agents = new MemoryEnrollmentStore(db);
  await agents.createAgent(agentRow());

  const ingestor = new ReportIngestor(
    new MemoryExternalRunStore(db),
    agents,
    new MemorySpendStore(db),
    record,
    audit,
    clock,
    ids,
    { limits: DEFAULT_REPORT_LIMITS, operatingMode: "supervised" },
  );

  const ingested = await ingestor.ingest(report);
  const run = await record.requireRun(ingested.runId);
  // `runTimeline` reads only the operating record.
  const timeline = await runTimeline({ runs: record } as unknown as Platform, run);
  return { record, ingested, timeline };
}

describe("cost attribution for an ingested external episode", () => {
  it("puts the whole episode cost on the run", async () => {
    const { record, ingested } = await ingestOneEpisode();
    const cost = await record.costForRun(ingested.runId);

    // The run-level figure is right, and this must stay right whatever the fix.
    expect(cost.totalUsd).toBe(1.25);
    expect(ingested.costUsd).toBe(1.25);
  });

  it("shows a step trail whose costs sum to the run total", async () => {
    const { timeline } = await ingestOneEpisode();

    expect(timeline.steps).toHaveLength(2);
    expect(timeline.totalCostUsd).toBe(1.25);

    const summed = timeline.steps.reduce((total, row) => total + row.costUsd, 0);

    // A run-detail screen that reports $1.25 spent and cannot say on what is
    // not a record of the work; it is a total with no derivation. The agent
    // told us what each step cost — it is in `detail.reportedCostUsd` — and
    // the column that would show it reads a ledger those figures never reach.
    expect(summed).toBeCloseTo(timeline.totalCostUsd, 6);
    // These steps account for the whole episode, so there is nothing left over.
    expect(timeline.unattributedCostUsd).toBe(0);
  });
});

/**
 * The rest of the finding, once the owner decided it.
 *
 * The steps and the total are two separate claims by a system this platform did
 * not run, and they need not agree. The decision recorded here is to show the
 * difference rather than redistribute it: attributing an agent's total across
 * its steps would invent a precision the agent never reported, and the
 * exactly-once meter property depends on the total staying the figure of
 * record. So the screen gets an invariant it can be built on —
 *
 *     sum(steps) + unattributed === total
 *
 * — which holds for every report an agent can send, including the one where its
 * own numbers contradict each other.
 */
describe("what the screen can say about a total it did not attribute", () => {
  it("accounts for the header when the agent attributed only part of it", async () => {
    const { timeline } = await ingestOneEpisode({
      ...REPORT,
      steps: [
        { ...REPORT.steps[0]!, costUsd: 0 },
        { ...REPORT.steps[1]!, costUsd: 0.4 },
      ],
      costUsd: 1.25,
    });

    const summed = timeline.steps.reduce((total, row) => total + row.costUsd, 0);
    expect(summed).toBeCloseTo(0.4, 10);
    // The $0.85 the agent did not place is spend that happened. It is shown as
    // its own figure, so a supervisor reading the detail can still derive the
    // header from what is on the page — which is the difference between a
    // total with a derivation and a total without one.
    expect(timeline.unattributedCostUsd).toBeCloseTo(0.85, 10);
    expect(summed + timeline.unattributedCostUsd).toBeCloseTo(timeline.totalCostUsd, 10);
  });

  it("accounts for the header when the agent's own figures contradict each other", async () => {
    const { timeline } = await ingestOneEpisode({
      ...REPORT,
      // $1.40 of steps inside a $1.25 episode.
      steps: [
        { ...REPORT.steps[0]!, costUsd: 0.9 },
        { ...REPORT.steps[1]!, costUsd: 0.5 },
      ],
      costUsd: 1.25,
    });

    // No step figure is promoted, because publishing them would make the
    // column exceed the header — the same disagreement, inverted. The whole
    // total shows as unattributed instead, and the invariant still holds, so
    // the screen never has to render a header its rows cannot account for.
    expect(timeline.steps.every((row) => row.costUsd === 0)).toBe(true);
    expect(timeline.totalCostUsd).toBe(1.25);
    expect(timeline.unattributedCostUsd).toBe(1.25);

    // What the agent claimed is still on the steps for a person to read.
    expect(timeline.steps[0]?.detail["reportedCostUsd"]).toBe(0.9);
    expect(timeline.steps[1]?.detail["reportedCostUsd"]).toBe(0.5);
  });
});
