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

async function ingestOneEpisode() {
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

  const ingested = await ingestor.ingest(REPORT);
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
  });
});
