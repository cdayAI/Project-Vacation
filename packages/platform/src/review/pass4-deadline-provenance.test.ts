import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FixedClock, DAY, MINUTE } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { AuditLog } from "../audit/log.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { MemoryRunStore } from "../record/store.memory.js";
import type { ActorRef } from "../record/types.js";
import { ApprovalService } from "../guard/approvals.js";
import { Authorizer } from "../guard/authorize.js";
import { CeilingEnforcer } from "../guard/ceilings.js";
import { ContainmentController } from "../guard/containment.js";
import { ActionRegistry, type ActionDefinition } from "../guard/registry.js";
import { MemoryApprovalStore, MemoryContainmentStore } from "../guard/store.memory.js";
import { MemoryDb } from "../store/db.js";
import { WorkflowCatalogue, defineWorkflow } from "../engine/definition.js";
import { StepHandlerRegistry, WorkflowEngine } from "../engine/runner.js";
import { MemoryWorkflowStore } from "../engine/store.memory.js";
import type { WorkflowStep } from "../engine/types.js";
import { RESCISSION_RULES } from "../timeline/rules.js";
import type { JurisdictionTable } from "../timeline/types.js";

/**
 * Pass 4, group two — what the record says about a deadline once it is decided.
 *
 * Two obligations, and they are not the same one.
 *
 * *Provenance.* A deadline is a legal conclusion. The record of it has to name
 * the rule version it was derived under **and the citation that rule stood on**,
 * because a version identifier is what an engineer re-derives from and a
 * citation is what counsel reads. `DeadlineComputation` carries both; the
 * question this file asks is whether the durable record does.
 *
 * *Immutability of a decided case.* When the rule table changes — and it will,
 * because every row in it is a placeholder awaiting counsel — a contract that
 * was already decided must keep reporting what was decided at the time. A rule
 * change that silently re-interprets a closed case is worse than a wrong
 * deadline, because nobody is looking.
 */

const REQUESTER: ActorRef = {
  actorId: "act_service_agent",
  kind: "service",
  roles: ["supervisor", "owner_services_agent"],
};

const REVIEW_ACTIONS: readonly ActionDefinition[] = [
  {
    name: "review.close_case",
    risk: "sensitive",
    description: "Close the case in the system of record.",
    reversible: true,
    allowedRoles: ["supervisor", "system"],
  },
];

const STATUTORY_TIMER = defineWorkflow({
  name: "review.rescission_clock",
  version: 1,
  description: "Park on a statutory rescission deadline, then close.",
  mode: "supervised",
  steps: [
    {
      name: "await_deadline",
      type: "timer",
      description: "wait for the statutory rescission deadline",
      schedule: {
        kind: "statutory_rescission",
        stateCodeKey: "stateCode",
        executedAtKey: "executedAt",
        deliveredAtKey: "deliveredAt",
        deadlineContextKey: "rescissionDeadline",
      },
      next: "close",
    } as WorkflowStep,
    {
      name: "close",
      type: "automated_action",
      description: "close the case",
      action: "review.close_case",
      handler: "noop",
      inputs: ["rescissionDeadline"],
    } as WorkflowStep,
  ],
});

function buildEngine(options: {
  readonly startAt: string;
  readonly rules?: JurisdictionTable;
  /** Reuse a database, so a rebuilt engine sees the same parked instance. */
  readonly db?: MemoryDb;
  /** Distinct id stream, so a rebuilt engine does not replay the first one's ids. */
  readonly seed?: string;
}) {
  const db = options.db ?? new MemoryDb();
  const clock = new FixedClock(options.startAt);
  const ids = new SeededIdGenerator(options.seed ?? "pass4-provenance");
  const runs = new MemoryRunStore(db, clock, ids);
  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const approvals = new ApprovalService(new MemoryApprovalStore(db), clock, ids, audit);
  const containment = new ContainmentController(new MemoryContainmentStore(db), clock, audit, 0);
  const ceilings = new CeilingEnforcer(
    { runSpendUsd: 100, dailySpendUsd: 1000, runWallClockMs: 60 * DAY, modelCallsPerMinute: 1000 },
    clock,
    runs,
  );
  const registry = new ActionRegistry(REVIEW_ACTIONS);
  const authorizer = new Authorizer(registry, containment, ceilings, approvals, audit, clock, 300);
  const handlers = new StepHandlerRegistry();
  handlers.register("noop", async () => ({ summary: "closed" }));

  const store = new MemoryWorkflowStore(db);
  const dependencies = {
    catalogue: new WorkflowCatalogue([STATUTORY_TIMER]),
    store,
    runs,
    audit,
    registry,
    authorizer,
    containment,
    approvals,
    ceilings,
    handlers,
    clock,
    ids,
    logger: createNullLogger(),
    stepLeaseMs: 5 * MINUTE,
    ...(options.rules ? { timeline: { rules: options.rules } } : {}),
  };

  return { db, clock, runs, store, engine: new WorkflowEngine(dependencies) };
}

/** The rule table with Florida's current window shortened from ten days to three. */
function shortenedFlorida(): JurisdictionTable {
  const changed = new Map(RESCISSION_RULES);
  const florida = RESCISSION_RULES.get("FL");
  if (!florida) throw new Error("FL entry missing from the shipped table");
  changed.set("FL", {
    ...florida,
    versions: florida.versions.map((rule) =>
      rule.effectiveTo === null ? { ...rule, windowLength: 3 } : rule,
    ),
  });
  return changed;
}

async function scheduleDeadline(rules?: JurisdictionTable) {
  const harness = buildEngine({ startAt: "2026-03-05T14:00:00.000Z", ...(rules ? { rules } : {}) });
  const started = await harness.engine.start({
    workflow: "review.rescission_clock",
    requestedBy: REQUESTER,
    context: {
      stateCode: "FL",
      executedAt: "2026-03-05T14:00:00.000Z",
      deliveredAt: "2026-03-05T14:00:00.000Z",
    },
  });
  const parked = (await harness.engine.tick(started.id)).instance;
  const steps = await harness.runs.listSteps(started.runId);
  const timer = steps.find((step) => step.name === "await_deadline");
  if (!timer) throw new Error("the timer step was not recorded");
  return { harness, started, parked, timer };
}

describe("the durable record of a computed deadline", () => {
  it("names the rule version it was derived under", async () => {
    const { parked, timer } = await scheduleDeadline();
    expect(parked.status).toBe("waiting_timer");
    expect(timer.detail["ruleVersion"]).toBe("FL@2");
    expect(timer.detail["ruleVerified"]).toBe(false);
    expect(timer.detail["deadlineInstant"]).toBe(parked.wakeAt);
  });

  it("names the citation the rule stood on", async () => {
    // F-402. The step recorded `ruleVersion` and not `citation`.
    //
    // Both are required and they answer different questions. `FL@2` tells an
    // engineer which row of `rules.ts` to re-read; it tells a compliance
    // reviewer nothing at all. The citation is the field that says on what
    // authority the company told an owner their window had closed — and on
    // this build it also says "PLACEHOLDER — UNVERIFIED", which is the single
    // most important fact about the number. `api/run-timeline.ts:352` already
    // reads this key as the derivation behind a computed deadline, so the
    // reader existed and the writer did not.
    const { timer } = await scheduleDeadline();
    expect(typeof timer.detail["citation"]).toBe("string");
    expect(String(timer.detail["citation"] ?? "")).toContain("PLACEHOLDER");
  });
});

describe("a rule change and a case that was already decided", () => {
  it("does not re-interpret the parked deadline when the window is shortened", async () => {
    // Decide the case under the shipped table.
    const decided = await scheduleDeadline();
    const originalWake = decided.parked.wakeAt;
    const originalDetail = { ...decided.timer.detail };
    // Ten calendar days from 6 March lands on Sunday 15 March, which FL@2
    // rolls to Monday the 16th; the window closes at 23:59:59.999 Eastern.
    expect(originalDetail["deadlineLocalDate"]).toBe("2026-03-16");
    expect(originalWake).toBe("2026-03-17T03:59:59.999Z");

    // Counsel corrects Florida from ten days to three. Everything about the
    // contract is unchanged; only the law the platform holds has moved.
    const rewritten = await scheduleDeadline(shortenedFlorida());
    expect(rewritten.parked.wakeAt).not.toBe(originalWake);

    // The already-decided case must still report what it decided. Re-read it
    // from the operating record rather than from the object in hand, because
    // that is what an auditor would do.
    const steps = await decided.harness.runs.listSteps(decided.started.runId);
    const reread = steps.find((step) => step.name === "await_deadline");
    expect(reread?.detail["deadlineInstant"]).toBe(originalDetail["deadlineInstant"]);
    expect(reread?.detail["ruleVersion"]).toBe(originalDetail["ruleVersion"]);
    expect(reread?.detail["deadlineLocalDate"]).toBe(originalDetail["deadlineLocalDate"]);

    const instance = await decided.harness.store.requireInstance(decided.started.id);
    expect(instance.wakeAt).toBe(originalWake);
    expect(instance.context["rescissionDeadline"]).toBe(originalDetail["deadlineInstant"]);
  });

  it("keeps the derivation on the record after the window has closed", async () => {
    // F-403. `patchStep` replaces `detail` rather than merging it, and the
    // timer's firing branch patched in `{ workflowInstanceId, fired: true }`.
    // Every field of the derivation — jurisdiction, rule version, whether the
    // rule was verified, the citation, the deadline, the UTC offset in force —
    // was therefore erased at the exact moment the case closed and its record
    // became the evidence.
    const decided = await scheduleDeadline();
    const resumed = buildEngine({
      startAt: "2026-03-17T04:00:00.000Z",
      db: decided.harness.db,
      seed: "pass4-provenance-fired",
    });

    const finished = await resumed.engine.tick(decided.started.id);
    expect(finished.instance.status).toBe("succeeded");

    const steps = await resumed.runs.listSteps(decided.started.runId);
    const timer = steps.find((step) => step.name === "await_deadline");
    expect(timer?.status).toBe("succeeded");
    expect(timer?.detail["fired"]).toBe(true);
    expect(timer?.detail["ruleVersion"]).toBe("FL@2");
    expect(timer?.detail["ruleVerified"]).toBe(false);
    expect(String(timer?.detail["citation"] ?? "")).toContain("PLACEHOLDER");
    expect(timer?.detail["deadlineInstant"]).toBe("2026-03-17T03:59:59.999Z");
    expect(timer?.detail["utcOffsetAtDeadline"]).toBe("-04:00");
  });

  it("fires the timer it decided on after a restart carrying the corrected rule", async () => {
    const decided = await scheduleDeadline();

    // A deploy: a second engine over the same store, holding the corrected
    // table, at a moment after the deadline the case was decided under.
    const resumed = buildEngine({
      startAt: "2026-03-17T04:00:00.000Z",
      rules: shortenedFlorida(),
      db: decided.harness.db,
      seed: "pass4-provenance-restart",
    });

    const finished = await resumed.engine.tick(decided.started.id);
    expect(finished.instance.status).toBe("succeeded");

    const steps = await resumed.runs.listSteps(decided.started.runId);
    const timer = steps.find((step) => step.name === "await_deadline");
    expect(timer?.detail["deadlineInstant"]).toBe("2026-03-17T03:59:59.999Z");
    expect(timer?.detail["ruleVersion"]).toBe("FL@2");
  });
});

describe("the switch that makes an unverified rule deny", () => {
  it("is reachable from something a deployment can configure", () => {
    // FINDING (F-401). `timeline/rules.ts` states that
    // "`computeRescissionDeadline` accepts `requireVerifiedRules`, which a
    // production deployment sets so that an unverified rule denies rather than
    // produces a number somebody might act on", and `compute.ts` repeats it.
    //
    // No deployment can set it. There is no environment key for it in
    // `kernel/config.ts`, the composition root in `platform.ts` never builds a
    // workflow engine at all, and the one in-repo caller (`demo/run.ts:398`)
    // omits it. The flag defaults to false, so every deadline this build can
    // produce comes from placeholder data with a warning string that the only
    // programmatic consumer — `scheduleTimer` in `engine/runner.ts` — drops on
    // the floor.
    //
    // This is checked at the source level rather than by asserting a
    // particular design, because the fix could reasonably be an environment
    // key, a hard default of `true`, or wiring in the composition root, and
    // that choice belongs to the owner.
    const read = (relative: string): string =>
      readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

    const configurationSurface = [
      read("../kernel/config.ts"),
      read("../platform.ts"),
      read("../../../../.env.example"),
    ].join("\n");

    expect(configurationSurface).toMatch(/requireVerifiedRule/);
  });
});
