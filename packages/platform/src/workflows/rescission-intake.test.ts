import { describe, it, expect } from "vitest";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { loadConfig } from "../kernel/config.js";
import { MemoryDb } from "../store/db.js";
import { validateDefinition } from "../engine/definition.js";
import type { StepHandlerContext } from "../engine/types.js";
import type { ActorRef } from "../record/types.js";
import { buildPlatform, type Platform } from "../platform.js";
import {
  RESCISSION_INTAKE_WORKFLOW,
  RESCISSION_INTAKE_WORKFLOW_NAME,
  SCREEN_PACKET_HANDLER,
  RECORD_OUTCOME_HANDLER,
} from "./rescission-intake.js";
import { buildRescissionIntakeHandlers } from "./handlers.js";

/**
 * The shipped flow, its handlers, and the durability gate through the composed
 * engine.
 *
 * The point of these tests is the one thing `engine.test.ts` could not assert:
 * that a real, published definition with a human task and a timer, wired into
 * the composition root with its handlers, runs end to end on the engine the
 * product actually builds — and that it resumes on a second engine over the same
 * store, which is Phase 2's exit gate seen from the product rather than from a
 * synthetic definition.
 */

// The morning of the Q2 release, matching the seeded demonstration.
const NOW = "2026-08-06T13:00:00.000Z";

const REQUESTER: ActorRef = {
  actorId: "cli:sam",
  kind: "human",
  roles: ["owner_services_agent"],
};

const REVIEWER: ActorRef = {
  actorId: "cli:priya",
  kind: "human",
  roles: ["compliance_reviewer"],
};

// Executed well in the past so the statutory deadline — computed by the timeline
// module from the placeholder Florida rule — is already behind NOW, and the
// timer fires the moment the instance reaches it.
const CONTEXT = {
  contractId: "ctr_test_0001",
  stateCode: "FL",
  executedAt: "2024-01-10T12:00:00.000Z",
  deliveredAt: "2024-01-10T12:00:00.000Z",
} as const;

/**
 * A platform wired the way the product wires it, over an injected store.
 *
 * `PV_REQUIRE_VERIFIED_STATUTORY_RULES=false` is the deliberate override the
 * seeded demonstration also makes: every shipped rule is an unverified
 * placeholder, and the flow's statutory timer would otherwise deny. No date it
 * produces here may be acted on — the test only needs the engine to reach the
 * timer and pass it.
 */
async function buildTestPlatform(memoryDb: MemoryDb, seed: string): Promise<Platform> {
  const config = loadConfig({
    PV_ENV: "development",
    PV_STORE: "memory",
    PV_MODEL_PROVIDER: "fake",
    PV_REQUIRE_VERIFIED_STATUTORY_RULES: "false",
  });
  return buildPlatform(config, {
    clock: new FixedClock(NOW),
    ids: new SeededIdGenerator(seed),
    logger: createNullLogger(),
    memoryDb,
  });
}

function handlerContext(input: Record<string, string>): StepHandlerContext {
  return {
    instanceId: "wfi_test" as never,
    runId: "run_test" as never,
    stepId: "step_test" as never,
    workflowName: RESCISSION_INTAKE_WORKFLOW_NAME,
    stepName: "screen_packet",
    attempt: 1,
    mode: "supervised",
    input: input as never,
    subject: { contractId: input["contractId"] ?? "" },
    correlationId: "corr_test",
    idempotencyKey: "idem_test",
  };
}

describe("the rescission-intake definition", () => {
  it("validates and stands on a human task and a timer around a model call and an effect", () => {
    expect(validateDefinition(RESCISSION_INTAKE_WORKFLOW)).toEqual([]);

    const types = RESCISSION_INTAKE_WORKFLOW.steps.map((step) => step.type);
    expect(types).toContain("human_task");
    expect(types).toContain("timer");
    expect(types).toContain("model_call");
    expect(types).toContain("automated_action");

    // The timer is statutory, not a bare duration — the platform's flagship
    // clock, computed by the timeline module rather than by arithmetic here.
    const timer = RESCISSION_INTAKE_WORKFLOW.steps.find((step) => step.type === "timer");
    expect(timer?.type === "timer" && timer.schedule.kind).toBe("statutory_rescission");

    // The reviewer's task is a compliance reviewer's.
    const task = RESCISSION_INTAKE_WORKFLOW.steps.find((step) => step.type === "human_task");
    expect(task?.type === "human_task" && task.assignedRoles).toEqual(["compliance_reviewer"]);

    expect(RESCISSION_INTAKE_WORKFLOW.requiredContext).toEqual([
      "contractId",
      "stateCode",
      "executedAt",
      "deliveredAt",
    ]);
  });
});

describe("the rescission-intake handlers", () => {
  it("registers exactly the handlers the definition names", () => {
    const handlers = buildRescissionIntakeHandlers({ seed: "test" });
    expect(Object.keys(handlers).sort()).toEqual(
      [SCREEN_PACKET_HANDLER, RECORD_OUTCOME_HANDLER].sort(),
    );
  });

  it("screens deterministically: the same input yields the same finding", async () => {
    const handlers = buildRescissionIntakeHandlers({ seed: "test" });
    const screen = handlers[SCREEN_PACKET_HANDLER];
    if (!screen) throw new Error("expected the screen handler");

    const first = await screen(handlerContext({ contractId: "ctr_1", stateCode: "FL" }));
    const again = await screen(handlerContext({ contractId: "ctr_1", stateCode: "FL" }));

    expect(first.output).toEqual({ packetScreened: true });
    expect(first.summary).toBe(again.summary);
    expect((first.costUsd ?? 0) > 0).toBe(true);
  });

  it("records the outcome, carrying the computed deadline into its summary", async () => {
    const handlers = buildRescissionIntakeHandlers({ seed: "test" });
    const record = handlers[RECORD_OUTCOME_HANDLER];
    if (!record) throw new Error("expected the record handler");

    const result = await record({
      ...handlerContext({ contractId: "ctr_9", rescissionDeadline: "2026-08-07T03:59:59.999Z" }),
      stepName: "record_outcome",
    });
    expect(result.output).toEqual({ outcomeRecorded: true });
    expect(result.summary).toContain("ctr_9");
    expect(result.summary).toContain("2026-08-07T03:59:59.999Z");
  });
});

describe("buildPlatform composes the shipped flow", () => {
  it("publishes exactly one definition and registers its handlers", async () => {
    const platform = await buildTestPlatform(new MemoryDb(), "compose");
    try {
      const published = platform.catalogue.list();
      expect(published).toHaveLength(1);
      expect(published[0]?.definition.name).toBe(RESCISSION_INTAKE_WORKFLOW_NAME);
      expect(platform.handlers.has(SCREEN_PACKET_HANDLER)).toBe(true);
      expect(platform.handlers.has(RECORD_OUTCOME_HANDLER)).toBe(true);
    } finally {
      await platform.close();
    }
  });
});

describe("the shipped flow, driven through the composed engine and across a restart", () => {
  it("starts, parks on the timer and the human task, resumes on a second engine, and finishes", async () => {
    const store = new MemoryDb();

    // --- one process starts it and drives it to the human task -------------
    const first = await buildTestPlatform(store, "process-a");
    const started = await first.engine.start({
      workflow: RESCISSION_INTAKE_WORKFLOW_NAME,
      requestedBy: REQUESTER,
      context: CONTEXT,
      subject: { contractId: CONTEXT.contractId },
    });
    expect(started.definitionName).toBe(RESCISSION_INTAKE_WORKFLOW_NAME);

    const parked = await first.engine.tick(started.id);
    // The model call ran, the statutory timer was scheduled and — its deadline
    // already past — fired, and the case is now on the reviewer's queue.
    expect(parked.instance.status).toBe("waiting_human");
    const midway = await first.engine.describeInstance(started.id);
    expect(midway.stepsCompleted.map((entry) => entry.step)).toEqual([
      "screen_packet",
      "await_deadline",
    ]);
    // The process dies here.
    await first.close();

    // --- a completely new engine over the same store finishes it ----------
    const second = await buildTestPlatform(store, "process-b");

    const tasks = await second.engine.listTasks({ instanceId: started.id, status: ["open"] });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    if (!task) throw new Error("expected an open task on the queue");
    expect(task.assignedRoles).toEqual(["compliance_reviewer"]);
    expect(task.stepName).toBe("compliance_confirm");

    // A stranger cannot complete it — the queue's roles are the authorisation.
    await expect(
      second.engine.completeHumanTask({
        taskId: task.id,
        actor: { actorId: "cli:nobody", kind: "human", roles: ["finance"] },
        outcome: "Trying anyway.",
      }),
    ).rejects.toThrow(/holds none of the roles/);

    await second.engine.completeHumanTask({
      taskId: task.id,
      actor: REVIEWER,
      outcome: "Finding and deadline confirmed.",
    });
    const finished = await second.engine.tick(started.id);

    expect(finished.instance.status).toBe("succeeded");
    const described = await second.engine.describeInstance(started.id);
    expect(described.stepsCompleted.map((entry) => entry.step)).toEqual([
      "screen_packet",
      "await_deadline",
      "compliance_confirm",
      "record_outcome",
    ]);
    // The whole thing cost something: the model call is on the record.
    expect(described.costUsd).toBeGreaterThan(0);

    const run = await second.runs.requireRun(started.runId);
    expect(run.status).toBe("succeeded");
    await second.close();
  });
});
