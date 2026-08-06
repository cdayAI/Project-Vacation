import { describe, it, expect } from "vitest";
import { FixedClock, DAY, HOUR, MINUTE } from "../kernel/clock.js";
import { DeniedError, isDenied } from "../kernel/errors.js";
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
import { WorkflowCatalogue, defineWorkflow } from "./definition.js";
import {
  RetryableStepError,
  StepHandlerRegistry,
  TerminalStepError,
  WorkflowEngine,
} from "./runner.js";
import { MemoryWorkflowStore } from "./store.memory.js";
import type { StepHandler, WorkflowDefinition, WorkflowStep } from "./types.js";

/**
 * Engine behaviour.
 *
 * The tests that matter most here are the unhappy ones. A workflow engine that
 * runs a happy path is a for-loop; what makes this one worth having is that it
 * survives a restart, refuses to repeat an effect whose outcome it cannot
 * vouch for, stops when an operator pauses it, unwinds what it already did, and
 * keeps a case running under the rules it started with rather than the rules
 * that happen to be deployed now. Each of those has its own section below.
 */

const REQUESTER: ActorRef = {
  actorId: "act_service_agent",
  kind: "service",
  roles: ["supervisor", "owner_services_agent"],
};

const APPROVER: ActorRef = {
  actorId: "act_supervisor",
  kind: "human",
  roles: ["supervisor"],
};

const TEST_ACTIONS: readonly ActionDefinition[] = [
  {
    name: "test.record_finding",
    risk: "routine",
    description: "Record a finding against a contract.",
    reversible: true,
    allowedRoles: ["supervisor", "owner_services_agent", "system"],
  },
  {
    name: "test.draft_letter",
    risk: "routine",
    description: "Draft a letter for review.",
    reversible: true,
    allowedRoles: ["supervisor", "owner_services_agent", "system"],
  },
  {
    name: "test.reserve_slot",
    risk: "sensitive",
    description: "Reserve a slot in a downstream system.",
    reversible: true,
    allowedRoles: ["supervisor", "system"],
  },
  {
    name: "test.release_slot",
    risk: "sensitive",
    description: "Release a slot reserved earlier.",
    reversible: true,
    allowedRoles: ["supervisor", "system"],
  },
  {
    name: "test.close_case",
    risk: "sensitive",
    description: "Close the case in the system of record.",
    reversible: true,
    allowedRoles: ["supervisor", "system"],
  },
  {
    name: "test.send_letter",
    risk: "high_consequence",
    description: "Send a letter to an owner. It cannot be unsent.",
    reversible: false,
    allowedRoles: ["supervisor"],
    approvalsRequired: 1,
  },
  {
    name: "test.needs_approval",
    risk: "high_consequence",
    description: "A consequential but reversible action that still needs sign-off.",
    reversible: true,
    allowedRoles: ["supervisor"],
    approvalsRequired: 1,
  },
];

interface Harness {
  readonly db: MemoryDb;
  readonly clock: FixedClock;
  readonly runs: MemoryRunStore;
  readonly audit: AuditLog;
  readonly approvals: ApprovalService;
  readonly containment: ContainmentController;
  readonly ceilings: CeilingEnforcer;
  readonly registry: ActionRegistry;
  readonly store: MemoryWorkflowStore;
  readonly catalogue: WorkflowCatalogue;
  readonly handlers: StepHandlerRegistry;
  readonly engine: WorkflowEngine;
  /** How many times each handler was actually invoked. */
  readonly calls: Record<string, number>;
  /** Build a second engine over the same store, as a restart would. */
  rebuild(options?: { readonly catalogue?: WorkflowCatalogue }): WorkflowEngine;
}

interface HarnessOptions {
  readonly definitions?: readonly WorkflowDefinition[];
  readonly handlers?: Readonly<Record<string, StepHandler>>;
  readonly startAt?: string;
  readonly stepLeaseMs?: number;
  readonly runSpendCeilingUsd?: number;
}

function buildHarness(options: HarnessOptions = {}): Harness {
  const db = new MemoryDb();
  const clock = new FixedClock(options.startAt ?? "2026-08-06T09:00:00.000Z");
  const ids = new SeededIdGenerator("engine-test");
  const logger = createNullLogger();

  const runs = new MemoryRunStore(db, clock, ids);
  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const approvals = new ApprovalService(new MemoryApprovalStore(db), clock, ids, audit);
  // No cache window: the tests engage a switch and expect the very next step to
  // see it, which is also what an operator expects.
  const containment = new ContainmentController(new MemoryContainmentStore(db), clock, audit, 0);
  const ceilings = new CeilingEnforcer(
    {
      runSpendUsd: options.runSpendCeilingUsd ?? 100,
      dailySpendUsd: 1000,
      runWallClockMs: 30 * DAY,
      modelCallsPerMinute: 1000,
    },
    clock,
    runs,
  );
  const registry = new ActionRegistry(TEST_ACTIONS);
  const authorizer = new Authorizer(registry, containment, ceilings, approvals, audit, clock, 300);
  const store = new MemoryWorkflowStore(db);
  const catalogue = new WorkflowCatalogue(options.definitions ?? []);

  const calls: Record<string, number> = {};
  const handlers = new StepHandlerRegistry();
  handlers.register("noop", async (context) => {
    calls[context.stepName] = (calls[context.stepName] ?? 0) + 1;
    return { summary: `did ${context.stepName}` };
  });
  for (const [name, handler] of Object.entries(options.handlers ?? {})) {
    handlers.register(name, async (context) => {
      calls[context.stepName] = (calls[context.stepName] ?? 0) + 1;
      return handler(context);
    });
  }

  const dependencies = {
    catalogue,
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
    logger,
    stepLeaseMs: options.stepLeaseMs ?? 5 * MINUTE,
  };

  return {
    db,
    clock,
    runs,
    audit,
    approvals,
    containment,
    ceilings,
    registry,
    store,
    catalogue,
    handlers,
    engine: new WorkflowEngine(dependencies),
    calls,
    rebuild: (rebuildOptions = {}) =>
      new WorkflowEngine({
        ...dependencies,
        catalogue: rebuildOptions.catalogue ?? catalogue,
      }),
  };
}

function action(
  name: string,
  overrides: Partial<WorkflowStep> = {},
): WorkflowStep {
  return {
    name,
    type: "automated_action",
    description: `perform ${name}`,
    action: "test.record_finding",
    handler: "noop",
    ...overrides,
  } as WorkflowStep;
}

function workflow(
  steps: readonly WorkflowStep[],
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return defineWorkflow({
    name: "test.case",
    version: 1,
    description: "A workflow used by the engine tests.",
    mode: "supervised",
    steps,
    ...overrides,
  });
}

// --------------------------------------------------------------------------

describe("running a workflow", () => {
  it("executes each step in order and records it in the operating record", async () => {
    const definition = workflow([
      action("gather", { next: "assess" }),
      action("assess", { next: "close", action: "test.close_case" }),
      action("close", { action: "test.close_case" }),
    ]);
    const harness = buildHarness({ definitions: [definition] });

    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      subject: { contractId: "ctr_0001" },
      context: { stateCode: "FL" },
    });
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("succeeded");
    expect(result.transitions).toBe(3);
    expect(harness.calls).toEqual({ gather: 1, assess: 1, close: 1 });

    const steps = await harness.runs.listSteps(started.runId);
    expect(steps.map((step) => step.name)).toEqual(["gather", "assess", "close"]);
    expect(steps.every((step) => step.status === "succeeded")).toBe(true);
    expect(steps.every((step) => step.inputDigest?.startsWith("sha256:"))).toBe(true);
    expect(steps.every((step) => step.outputDigest?.startsWith("sha256:"))).toBe(true);

    const run = await harness.runs.requireRun(started.runId);
    expect(run.status).toBe("succeeded");
    expect(run.endedAt).toBeDefined();
  });

  it("records what each step cost, so the price of a resolved case is a number", async () => {
    const definition = workflow([
      action("draft", { action: "test.draft_letter", handler: "costly", next: "close" }),
      action("close", { action: "test.close_case" }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        costly: async () => ({ costUsd: 0.42, costCategory: "model", units: 1200, modelId: "test-model" }),
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    const cost = await harness.runs.costForRun(started.runId);
    expect(cost.totalUsd).toBeCloseTo(0.42, 6);
    expect(cost.byCategory["model"]).toBeCloseTo(0.42, 6);

    const described = await harness.engine.describeInstance(started.id);
    expect(described.costUsd).toBeCloseTo(0.42, 6);
  });

  it("passes only the declared inputs to a handler", async () => {
    let seen: Record<string, unknown> = {};
    const definition = workflow([
      action("only_one", { handler: "capture", inputs: ["stateCode"] }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        capture: async (context) => {
          seen = { ...context.input };
          return {};
        },
      },
    });

    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { stateCode: "FL", contractId: "ctr_0001", irrelevant: true },
    });
    await harness.engine.tick(started.id);

    expect(seen).toEqual({ stateCode: "FL" });
  });

  it("merges a step's output into the context for later steps to read", async () => {
    let downstream: Record<string, unknown> = {};
    const definition = workflow([
      action("produce", { handler: "produce", next: "consume" }),
      action("consume", { handler: "consume", inputs: ["finding"] }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        produce: async () => ({ output: { finding: "inside_window" } }),
        consume: async (context) => {
          downstream = { ...context.input };
          return {};
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);
    expect(downstream).toEqual({ finding: "inside_window" });
  });

  it("refuses to start in a bolder mode than the definition was approved for", async () => {
    const definition = workflow([action("only")], { mode: "assisted" });
    const harness = buildHarness({ definitions: [definition] });

    await expect(
      harness.engine.start({
        workflow: "test.case",
        requestedBy: REQUESTER,
        mode: "bounded_autonomy",
      }),
    ).rejects.toThrow(/approved for assisted mode/);
  });

  it("refuses a context value that looks like a credential", async () => {
    const definition = workflow([action("only")]);
    const harness = buildHarness({ definitions: [definition] });

    await expect(
      harness.engine.start({
        workflow: "test.case",
        requestedBy: REQUESTER,
        context: { apiKey: "sk-abcdefghijklmnopqrstuvwx" },
      }),
    ).rejects.toThrow(/credential/);
  });

  it("refuses to start when a handler is not wired up, rather than failing halfway", async () => {
    const definition = workflow([action("first", { next: "second" }), action("second", { handler: "absent" })]);
    const harness = buildHarness({ definitions: [definition] });

    await expect(
      harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER }),
    ).rejects.toThrow(/No step handler is registered under "absent"/);
    // Nothing ran, so nothing has to be unwound.
    expect(harness.calls).toEqual({});
  });
});

// --------------------------------------------------------------------------

describe("definition version pinning", () => {
  const v1 = workflow([action("first", { next: "second" }), action("second")]);
  const v2 = workflow([action("first", { next: "different" }), action("different")], {
    version: 2,
  });

  it("keeps an in-flight instance on the version it started under", async () => {
    const harness = buildHarness({ definitions: [v1] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });

    // One step in, then the workflow is redefined underneath it.
    const definition = harness.catalogue.require("test.case", 1);
    expect(definition.version).toBe(1);
    await harness.engine.publish(v2, REQUESTER);
    expect(harness.catalogue.latest("test.case").version).toBe(2);

    const result = await harness.engine.tick(started.id);

    expect(result.instance.definitionVersion).toBe(1);
    expect(result.instance.status).toBe("succeeded");
    expect(harness.calls).toEqual({ first: 1, second: 1 });
    // The step that only exists in version 2 was never reached.
    expect(harness.calls["different"]).toBeUndefined();
  });

  it("starts new instances on the newest version while the old one is still running", async () => {
    const harness = buildHarness({ definitions: [v1] });
    const older = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.publish(v2, REQUESTER);
    const newer = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });

    expect(older.definitionVersion).toBe(1);
    expect(newer.definitionVersion).toBe(2);

    await harness.engine.tick(newer.id);
    expect(harness.calls["different"]).toBe(1);
    expect(harness.calls["second"]).toBeUndefined();
  });

  it("refuses to resume when the pinned version has been edited in place", async () => {
    const harness = buildHarness({ definitions: [v1] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });

    // A deploy that changed version 1 rather than publishing version 2. The
    // catalogue in the new process holds different content under the same
    // number, which is exactly what the digest exists to catch.
    const tampered = new WorkflowCatalogue([
      workflow([action("first", { next: "second", action: "test.close_case" }), action("second")]),
    ]);
    const resumed = harness.rebuild({ catalogue: tampered });

    await expect(resumed.tick(started.id)).rejects.toThrow(/has changed since instance/);
  });

  it("refuses to resume when the pinned version is no longer in source", async () => {
    const harness = buildHarness({ definitions: [v1] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });

    const withoutV1 = new WorkflowCatalogue([v2]);
    const resumed = harness.rebuild({ catalogue: withoutV1 });

    let caught: unknown;
    try {
      await resumed.tick(started.id);
    } catch (error) {
      caught = error;
    }
    expect(isDenied(caught)).toBe(true);
    expect((caught as DeniedError).reason).toBe("config.missing");

    // And a supervisor is told, in words, rather than seeing a stuck row.
    const described = await resumed.describeInstance(started.id);
    expect(described.stuckReason).toMatch(/is not in this deployment's catalogue/);
    expect(described.nextAction).toMatch(/Someone needs to look at this/);
  });
});

// --------------------------------------------------------------------------

describe("durability across a restart", () => {
  /**
   * The programme's stated exit gate.
   *
   * The engine object is thrown away in the middle of the case — once while a
   * person holds it, once while a timer holds it — and a completely new engine
   * over the same store finishes the work.
   */
  it("resumes a workflow holding a human task and a timer, and completes it", async () => {
    const definition = workflow([
      action("gather", { next: "review" }),
      {
        name: "review",
        type: "human_task",
        description: "review the gathered evidence",
        title: "Review the evidence",
        assignedRoles: ["supervisor"],
        next: "cool_off",
      } as WorkflowStep,
      {
        name: "cool_off",
        type: "timer",
        description: "wait out the cooling-off period",
        schedule: { kind: "duration", ms: 2 * DAY },
        next: "close",
      } as WorkflowStep,
      action("close", { action: "test.close_case" }),
    ]);

    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      subject: { contractId: "ctr_0007" },
    });

    let state = (await harness.engine.tick(started.id)).instance;
    expect(state.status).toBe("waiting_human");

    // --- the process dies here -------------------------------------------
    const afterFirstRestart = harness.rebuild();

    const tasks = await afterFirstRestart.listTasks({ instanceId: started.id, status: ["open"] });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    if (!task) throw new Error("expected a task on the queue");

    state = await afterFirstRestart.completeHumanTask({
      taskId: task.id,
      actor: APPROVER,
      outcome: "Evidence checked and complete.",
      output: { reviewed: true },
    });
    state = (await afterFirstRestart.tick(started.id)).instance;
    expect(state.status).toBe("waiting_timer");
    expect(state.wakeAt).toBe("2026-08-08T09:00:00.000Z");

    // --- and again, while the timer is still running ----------------------
    const afterSecondRestart = harness.rebuild();

    // Before the timer is due, nothing happens.
    harness.clock.advance(DAY);
    expect((await afterSecondRestart.sweep()).transitions).toBe(0);
    expect((await afterSecondRestart.tick(started.id)).instance.status).toBe("waiting_timer");
    expect(harness.calls["close"]).toBeUndefined();

    // Once it is due, the sweep finishes the case.
    harness.clock.advance(DAY);
    const swept = await afterSecondRestart.sweep();
    expect(swept.transitions).toBeGreaterThan(0);

    const finished = await afterSecondRestart.describeInstance(started.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.stepsCompleted.map((entry) => entry.step)).toEqual([
      "gather",
      "review",
      "cool_off",
      "close",
    ]);
    expect(harness.calls).toEqual({ gather: 1, close: 1 });

    const run = await harness.runs.requireRun(started.runId);
    expect(run.status).toBe("succeeded");
  });

  it("keeps the context a restarted instance had, not a rebuilt one", async () => {
    let observed: Record<string, unknown> = {};
    const definition = workflow([
      action("produce", { handler: "produce", next: "wait" }),
      {
        name: "wait",
        type: "wait_for_event",
        description: "wait for the countersignature",
        event: "countersigned",
        next: "consume",
      } as WorkflowStep,
      action("consume", { handler: "consume", inputs: ["finding", "signedBy"] }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        produce: async () => ({ output: { finding: "inside_window" } }),
        consume: async (context) => {
          observed = { ...context.input };
          return {};
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    const resumed = harness.rebuild();
    await resumed.signalEvent({
      instanceId: started.id,
      event: "countersigned",
      output: { signedBy: "act_supervisor" },
      actor: APPROVER,
    });
    const finished = await resumed.tick(started.id);

    expect(finished.instance.status).toBe("succeeded");
    expect(observed).toEqual({ finding: "inside_window", signedBy: "act_supervisor" });
  });
});

// --------------------------------------------------------------------------

describe("idempotency", () => {
  it("does not repeat a step whose outcome was never recorded", async () => {
    const definition = workflow([
      action("reserve", { action: "test.reserve_slot", handler: "effect", next: "close" }),
      action("close", { action: "test.close_case" }),
    ]);
    let effects = 0;
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        effect: async () => {
          effects += 1;
          return { summary: "reserved" };
        },
      },
    });

    // The process dies between performing the effect and recording that it
    // succeeded. Simulated by failing the patch that closes the step, once.
    const realPatchStep = harness.runs.patchStep.bind(harness.runs);
    let failed = false;
    harness.runs.patchStep = async (id, patch) => {
      if (!failed && patch.status === "succeeded") {
        failed = true;
        throw new Error("process died before the outcome was recorded");
      }
      return realPatchStep(id, patch);
    };

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await expect(harness.engine.tick(started.id)).rejects.toThrow(/process died/);
    expect(effects).toBe(1);

    // A new engine, after the claim has lapsed, takes the case over.
    const resumed = harness.rebuild();
    harness.clock.advance(10 * MINUTE);
    const result = await resumed.tick(started.id);

    // It did not repeat the effect, and it did not pretend the step succeeded.
    expect(effects).toBe(1);
    expect(result.instance.status).toBe("failed");
    expect(result.instance.stuckReason).toMatch(/whether its effect landed is unknown/);
    expect(harness.calls["close"]).toBeUndefined();

    const run = await harness.runs.requireRun(started.runId);
    expect(run.status).toBe("failed");
  });

  it("reuses one operating-record step across retries, so the key has one answer", async () => {
    const definition = workflow([
      action("flaky", {
        action: "test.reserve_slot",
        handler: "flaky",
        retry: { maxAttempts: 3, backoffMs: 1000, factor: 2 },
        next: "close",
      }),
      action("close", { action: "test.close_case" }),
    ]);
    let attempts = 0;
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        flaky: async () => {
          attempts += 1;
          if (attempts < 3) throw new RetryableStepError("the downstream system was busy");
          return { summary: "reserved on the third go" };
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });

    let state = (await harness.engine.tick(started.id)).instance;
    expect(state.status).toBe("waiting_timer");
    expect(state.wakeAt).toBe("2026-08-06T09:00:01.000Z");
    expect(attempts).toBe(1);

    // The backoff is real: ticking before it elapses does nothing.
    expect((await harness.engine.tick(started.id)).transitions).toBe(0);

    harness.clock.advance(1000);
    state = (await harness.engine.tick(started.id)).instance;
    expect(attempts).toBe(2);
    // Exponential, so the second wait is twice the first.
    expect(state.wakeAt).toBe("2026-08-06T09:00:03.000Z");

    harness.clock.advance(2000);
    state = (await harness.engine.tick(started.id)).instance;
    expect(state.status).toBe("succeeded");
    expect(attempts).toBe(3);

    const steps = await harness.runs.listSteps(started.runId);
    const flakySteps = steps.filter((step) => step.name === "flaky");
    expect(flakySteps).toHaveLength(1);
    expect(flakySteps[0]?.status).toBe("succeeded");
  });

  it("gives up after the declared number of attempts", async () => {
    const definition = workflow([
      action("always_fails", {
        action: "test.reserve_slot",
        handler: "always_fails",
        retry: { maxAttempts: 2, backoffMs: 0 },
      }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        always_fails: async () => {
          throw new RetryableStepError("still busy");
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("failed");
    expect(result.instance.failureReason).toMatch(/ran out of retries/);
    expect(harness.calls["always_fails"]).toBe(2);
  });

  it("does not retry an error the handler classified as terminal", async () => {
    const definition = workflow([
      action("hopeless", {
        action: "test.reserve_slot",
        handler: "hopeless",
        retry: { maxAttempts: 5, backoffMs: 0 },
      }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        hopeless: async () => {
          throw new TerminalStepError("the contract does not exist");
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("failed");
    expect(result.instance.failureReason).toMatch(/cannot be retried/);
    expect(harness.calls["hopeless"]).toBe(1);
  });

  it("treats an unclassified error as terminal, because it might have landed", async () => {
    const definition = workflow([
      action("unknown", {
        action: "test.reserve_slot",
        handler: "unknown",
        retry: { maxAttempts: 5, backoffMs: 0 },
      }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        unknown: async () => {
          throw new Error("socket hang up");
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);
    expect(result.instance.status).toBe("failed");
    expect(harness.calls["unknown"]).toBe(1);
  });

  it("performs the effect once when two engines drive the same instance at once", async () => {
    const definition = workflow([
      action("reserve", { action: "test.reserve_slot", handler: "slow", next: "close" }),
      action("close", { action: "test.close_case" }),
    ]);
    let effects = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        slow: async () => {
          effects += 1;
          await gate;
          return {};
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const second = harness.rebuild();

    const first = harness.engine.tick(started.id);
    const competitor = second.tick(started.id);
    release();
    const [a, b] = await Promise.all([first, competitor]);

    expect(effects).toBe(1);
    expect(harness.calls["close"]).toBe(1);
    // Between them the workflow ran once and finished once.
    expect(a.transitions + b.transitions).toBe(2);
    const steps = await harness.runs.listSteps(started.runId);
    expect(steps.filter((step) => step.name === "reserve")).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------

describe("containment at consumption", () => {
  it("stops the next step of an instance that is already running", async () => {
    const definition = workflow([
      action("first", { next: "second" }),
      action("second", { action: "test.close_case" }),
    ]);
    const harness = buildHarness({ definitions: [definition] });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });

    // One step happens, then an operator hits the stop button.
    const partial = new WorkflowEngine({
      catalogue: harness.catalogue,
      store: harness.store,
      runs: harness.runs,
      audit: harness.audit,
      registry: harness.registry,
      authorizer: new Authorizer(
        harness.registry,
        harness.containment,
        harness.ceilings,
        harness.approvals,
        harness.audit,
        harness.clock,
        300,
      ),
      containment: harness.containment,
      approvals: harness.approvals,
      ceilings: harness.ceilings,
      handlers: harness.handlers,
      clock: harness.clock,
      ids: new SeededIdGenerator("partial"),
      logger: createNullLogger(),
      maxTransitionsPerTick: 1,
    });
    await partial.tick(started.id);
    expect(harness.calls).toEqual({ first: 1 });

    await harness.containment.engage("global", "", "act_supervisor", "Output looked wrong.");

    const result = await harness.engine.tick(started.id);

    expect(harness.calls["second"]).toBeUndefined();
    expect(result.instance.status).toBe("denied");
    expect(result.instance.denialReason).toBe("containment.global_pause");

    const run = await harness.runs.requireRun(started.runId);
    expect(run.status).toBe("denied");
    expect(run.denialReason).toBe("containment.global_pause");
  });

  it("stops a workflow whose own switch is engaged, leaving others alone", async () => {
    const definition = workflow([action("first", { next: "second" }), action("second")]);
    const harness = buildHarness({ definitions: [definition] });
    await harness.containment.engage("workflow", "test.case", "act_supervisor", "Under review.");

    await expect(
      harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER }),
    ).rejects.toThrow(/is disabled/);
  });

  it("records the denial in the audit chain", async () => {
    const definition = workflow([action("only")]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.containment.engage("global", "", "act_supervisor", "Stop.");
    await harness.engine.tick(started.id);

    const entries = await harness.audit.list({ eventType: ["workflow.instance_ended"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.decision["status"]).toBe("denied");
    expect(entries[0]?.decision["reason"]).toBe("containment.global_pause");
  });
});

// --------------------------------------------------------------------------

describe("compensation", () => {
  const definition = workflow([
    action("reserve", {
      action: "test.reserve_slot",
      handler: "reserve",
      compensation: "release",
      next: "close",
    }),
    action("close", { action: "test.close_case", handler: "explodes" }),
    {
      name: "release",
      type: "compensation",
      description: "release the slot reserved earlier",
      action: "test.release_slot",
      handler: "release",
    } as WorkflowStep,
  ]);

  it("undoes completed work when a later step fails", async () => {
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        reserve: async () => ({ summary: "slot reserved" }),
        release: async () => ({ summary: "slot released" }),
        explodes: async () => {
          throw new TerminalStepError("the system of record rejected the close");
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);

    expect(harness.calls["reserve"]).toBe(1);
    expect(harness.calls["release"]).toBe(1);
    expect(result.instance.status).toBe("failed");
    expect(result.instance.compensationQueue).toEqual([]);

    const compensated = result.instance.history.filter((entry) => entry.status === "compensated");
    expect(compensated.map((entry) => entry.stepName)).toEqual(["reserve"]);

    const steps = await harness.runs.listSteps(started.runId);
    expect(steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "reserve:succeeded",
      "close:failed",
      "release:succeeded",
    ]);
  });

  it("undoes work in reverse order of completion", async () => {
    const order: string[] = [];
    const twoStage = workflow([
      action("one", { action: "test.reserve_slot", handler: "one", compensation: "undo_one", next: "two" }),
      action("two", { action: "test.reserve_slot", handler: "two", compensation: "undo_two", next: "boom" }),
      action("boom", { action: "test.close_case", handler: "boom" }),
      {
        name: "undo_one",
        type: "compensation",
        description: "undo one",
        action: "test.release_slot",
        handler: "undo_one",
      } as WorkflowStep,
      {
        name: "undo_two",
        type: "compensation",
        description: "undo two",
        action: "test.release_slot",
        handler: "undo_two",
      } as WorkflowStep,
    ]);
    const harness = buildHarness({
      definitions: [twoStage],
      handlers: {
        one: async () => ({}),
        two: async () => ({}),
        boom: async () => {
          throw new TerminalStepError("no");
        },
        undo_one: async () => {
          order.push("undo_one");
          return {};
        },
        undo_two: async () => {
          order.push("undo_two");
          return {};
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    // The last effect is the one nothing else depends on, so it is undone first.
    expect(order).toEqual(["undo_two", "undo_one"]);
  });

  it("stops rather than looping when the unwind itself is refused", async () => {
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        reserve: async () => ({}),
        release: async () => {
          throw new TerminalStepError("the downstream system will not release it");
        },
        explodes: async () => {
          throw new TerminalStepError("the system of record rejected the close");
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("failed");
    expect(harness.calls["release"]).toBe(1);
    expect(result.instance.stuckReason).toMatch(/The unwind could not complete/);
    expect(result.instance.stuckReason).toMatch(/needs a person to check it/);
  });

  it("unwinds when an operator cancels a case that is part-way through", async () => {
    const waiting = workflow([
      action("reserve", {
        action: "test.reserve_slot",
        handler: "reserve",
        compensation: "release",
        next: "review",
      }),
      {
        name: "review",
        type: "human_task",
        description: "check the reservation",
        title: "Check the reservation",
        assignedRoles: ["supervisor"],
      } as WorkflowStep,
      {
        name: "release",
        type: "compensation",
        description: "release the slot reserved earlier",
        action: "test.release_slot",
        handler: "release",
      } as WorkflowStep,
    ]);
    const harness = buildHarness({
      definitions: [waiting],
      handlers: { reserve: async () => ({}), release: async () => ({}) },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    expect((await harness.engine.tick(started.id)).instance.status).toBe("waiting_human");

    await harness.engine.cancel(started.id, APPROVER, "The owner withdrew the request.");
    const result = await harness.engine.tick(started.id);

    expect(harness.calls["release"]).toBe(1);
    expect(result.instance.status).toBe("cancelled");
  });
});

// --------------------------------------------------------------------------

describe("approval gates", () => {
  const definition = workflow([
    action("draft", { action: "test.draft_letter", next: "approve" }),
    {
      name: "approve",
      type: "approval_gate",
      description: "approve the letter before it goes out",
      gates: "send",
      approverRoles: ["supervisor"],
      summary: "Send the rescission acknowledgement to the owner.",
      next: "send",
    } as WorkflowStep,
    action("send", {
      action: "test.send_letter",
      handler: "send",
      irreversible: true,
      inputs: ["contractId"],
    }),
  ]);

  it("waits for a human decision and then performs the gated step", async () => {
    const harness = buildHarness({
      definitions: [definition],
      handlers: { send: async () => ({ summary: "letter sent" }) },
    });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { contractId: "ctr_0002" },
    });

    let state = (await harness.engine.tick(started.id)).instance;
    expect(state.status).toBe("waiting_approval");
    expect(harness.calls["send"]).toBeUndefined();

    // Ticking again changes nothing while the approver has not decided.
    expect((await harness.engine.tick(started.id)).transitions).toBe(0);

    const pending = await harness.approvals.list({ status: ["pending"] });
    expect(pending).toHaveLength(1);
    const approvalId = pending[0]?.id;
    if (!approvalId) throw new Error("expected an approval");
    await harness.approvals.decide({ approvalId, actor: APPROVER, decision: "granted" });

    state = (await harness.engine.tick(started.id)).instance;
    expect(state.status).toBe("succeeded");
    expect(harness.calls["send"]).toBe(1);

    const consumed = await harness.approvals.get(approvalId);
    expect(consumed?.status).toBe("consumed");
  });

  it("stops the workflow when the approver declines", async () => {
    const harness = buildHarness({
      definitions: [definition],
      handlers: { send: async () => ({}) },
    });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { contractId: "ctr_0003" },
    });
    await harness.engine.tick(started.id);

    const pending = await harness.approvals.list({ status: ["pending"] });
    const approvalId = pending[0]?.id;
    if (!approvalId) throw new Error("expected an approval");
    await harness.approvals.decide({ approvalId, actor: APPROVER, decision: "rejected" });

    const result = await harness.engine.tick(started.id);
    expect(result.instance.status).toBe("denied");
    expect(harness.calls["send"]).toBeUndefined();
  });

  it("refuses the gated step if its inputs changed after the approval was given", async () => {
    // The approval is bound to a proposal. Changing what would be sent after
    // sign-off must not be redeemable against that signature.
    const harness = buildHarness({
      definitions: [definition],
      handlers: { send: async () => ({}) },
    });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { contractId: "ctr_0004" },
    });
    await harness.engine.tick(started.id);

    const pending = await harness.approvals.list({ status: ["pending"] });
    const approvalId = pending[0]?.id;
    if (!approvalId) throw new Error("expected an approval");
    await harness.approvals.decide({ approvalId, actor: APPROVER, decision: "granted" });

    // Something rewrites the proposal between sign-off and execution.
    const current = await harness.store.requireInstance(started.id);
    const saved = await harness.store.saveInstance(
      { ...current, context: { ...current.context, contractId: "ctr_9999" } },
      current.revision,
    );
    expect(saved).not.toBeNull();

    const result = await harness.engine.tick(started.id);
    expect(result.instance.status).toBe("denied");
    expect(result.instance.denialReason).toBe("approval.digest_mismatch");
    expect(harness.calls["send"]).toBeUndefined();
  });

  it("refuses a step that needs approval when no gate raised one", async () => {
    const ungated = workflow([
      action("act", { action: "test.needs_approval", handler: "noop" }),
    ]);
    const harness = buildHarness({ definitions: [ungated] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("denied");
    expect(result.instance.denialReason).toBe("approval.required");
    const steps = await harness.runs.listSteps(started.runId);
    expect(steps[0]?.status).toBe("denied");
    expect(steps[0]?.denialReason).toBe("approval.required");
  });
});

// --------------------------------------------------------------------------

describe("branching and parallel fan-out", () => {
  it("takes the declared path and says why", async () => {
    const definition = workflow([
      action("assess", { handler: "assess", next: "route" }),
      {
        name: "route",
        type: "branch",
        description: "decide how to handle the case",
        cases: [
          {
            label: "inside the rescission window",
            when: { key: "insideWindow", op: "eq", value: true },
            next: "cancel",
          },
        ],
        otherwise: "decline",
      } as WorkflowStep,
      action("cancel", { action: "test.close_case" }),
      action("decline", { action: "test.close_case" }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: { assess: async () => ({ output: { insideWindow: true } }) },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("succeeded");
    expect(harness.calls["cancel"]).toBe(1);
    expect(harness.calls["decline"]).toBeUndefined();

    const described = await harness.engine.describeInstance(started.id);
    const routing = described.stepsCompleted.find((entry) => entry.step === "route");
    expect(routing?.summary).toContain("inside the rescission window");
    expect(routing?.summary).toContain("insideWindow is true");
  });

  it("falls to the declared default when nothing matches", async () => {
    const definition = workflow([
      {
        name: "route",
        type: "branch",
        description: "decide how to handle the case",
        cases: [
          { label: "urgent", when: { key: "urgent", op: "eq", value: true }, next: "fast" },
        ],
        otherwise: "slow",
      } as WorkflowStep,
      action("fast"),
      action("slow"),
    ]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);
    expect(harness.calls["slow"]).toBe(1);
  });

  it("joins only once every branch has finished", async () => {
    const definition = workflow([
      {
        name: "fan",
        type: "parallel",
        description: "check the contract and the payment history at once",
        branches: ["check_contract", "check_history"],
        next: "combine",
      } as WorkflowStep,
      action("check_contract", { handler: "contract", next: "score_contract" }),
      action("score_contract", { handler: "noop" }),
      action("check_history", { handler: "history" }),
      action("combine", { action: "test.close_case", handler: "combine" }),
    ]);

    const seen: string[] = [];
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        contract: async () => {
          seen.push("contract");
          return { output: { contractOk: true } };
        },
        history: async () => {
          seen.push("history");
          return { output: { historyOk: true } };
        },
        combine: async (context) => {
          seen.push("combine");
          expect(context.input).toEqual({ contractOk: true, historyOk: true });
          return {};
        },
      },
    });

    // The join reads both branches' output, which is only possible if it ran
    // after both of them.
    harness.catalogue.publish(
      defineWorkflow({
        ...definition,
        version: 2,
        steps: definition.steps.map((step) =>
          step.name === "combine" ? { ...step, inputs: ["contractOk", "historyOk"] } : step,
        ),
      }),
    );

    const started = await harness.engine.start({
      workflow: "test.case",
      version: 2,
      requestedBy: REQUESTER,
    });
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("succeeded");
    expect(seen[seen.length - 1]).toBe("combine");
    expect(harness.calls["combine"]).toBe(1);
    expect(new Set(seen)).toEqual(new Set(["contract", "history", "combine"]));
  });

  it("does not release the join when only one branch has finished", async () => {
    const definition = workflow([
      {
        name: "fan",
        type: "parallel",
        description: "two things at once",
        branches: ["quick", "slow"],
        next: "combine",
      } as WorkflowStep,
      action("quick"),
      {
        name: "slow",
        type: "human_task",
        description: "someone has to look at this one",
        title: "Look at the slow branch",
        assignedRoles: ["supervisor"],
      } as WorkflowStep,
      action("combine", { action: "test.close_case" }),
    ]);
    const harness = buildHarness({ definitions: [definition] });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);

    expect(harness.calls["quick"]).toBe(1);
    expect(harness.calls["combine"]).toBeUndefined();
    expect(result.instance.status).toBe("waiting_human");

    const tasks = await harness.engine.listTasks({ instanceId: started.id, status: ["open"] });
    const task = tasks[0];
    if (!task) throw new Error("expected a task");
    await harness.engine.completeHumanTask({
      taskId: task.id,
      actor: APPROVER,
      outcome: "Checked.",
    });
    const finished = await harness.engine.tick(started.id);

    expect(harness.calls["combine"]).toBe(1);
    expect(finished.instance.status).toBe("succeeded");
  });
});

// --------------------------------------------------------------------------

describe("service levels and escalation", () => {
  const definition = workflow([
    {
      name: "review",
      type: "human_task",
      description: "review the disputed maintenance fee",
      title: "Review the disputed fee",
      assignedRoles: ["owner_services_agent"],
      sla: {
        targetMs: 4 * HOUR,
        escalations: [
          { afterMs: 0, notifyRoles: ["supervisor"], note: "Past the agreed turnaround." },
          {
            afterMs: 24 * HOUR,
            notifyRoles: ["compliance_reviewer"],
            note: "A day past the turnaround; compliance should see it.",
          },
        ],
      },
      next: "close",
    } as WorkflowStep,
    action("close", { action: "test.close_case" }),
  ]);

  it("puts a task on a queue with a due date", async () => {
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      subject: { contractId: "ctr_0011" },
    });
    await harness.engine.tick(started.id);

    const tasks = await harness.engine.listTasks({ status: ["open"] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.dueAt).toBe("2026-08-06T13:00:00.000Z");
    expect(tasks[0]?.assignedRoles).toEqual(["owner_services_agent"]);
    expect(await harness.engine.breachedTasks()).toEqual([]);
  });

  it("surfaces a breach on a queue and escalates by the declared rule", async () => {
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    harness.clock.advance(5 * HOUR);
    const swept = await harness.engine.sweep();
    expect(swept.tasksEscalated).toBe(1);

    const breached = await harness.engine.breachedTasks();
    expect(breached).toHaveLength(1);
    expect(breached[0]?.escalationLevel).toBe(1);
    expect(breached[0]?.escalatedToRoles).toEqual(["supervisor"]);
    expect(breached[0]?.escalationNote).toBe("Past the agreed turnaround.");

    // A supervisor sees it in words rather than as a row of state.
    const described = await harness.engine.describeInstance(started.id);
    expect(described.headline).toMatch(/past the agreed turnaround/);
    expect(described.openTasks[0]?.breached).toBe(true);
    expect(described.nextAction).toBe("Complete the open task on the queue.");
  });

  it("escalates a second time, and no further, as the rules run out", async () => {
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    harness.clock.advance(5 * HOUR);
    await harness.engine.sweep();
    harness.clock.advance(24 * HOUR);
    expect((await harness.engine.sweep()).tasksEscalated).toBe(1);

    const breached = await harness.engine.breachedTasks();
    expect(breached[0]?.escalationLevel).toBe(2);
    expect(breached[0]?.escalatedToRoles).toEqual(["compliance_reviewer"]);

    // Nothing left to escalate to; sweeping again is a no-op rather than noise.
    harness.clock.advance(30 * DAY);
    expect((await harness.engine.sweep()).tasksEscalated).toBe(0);
  });

  it("does not escalate the same breach twice", async () => {
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    harness.clock.advance(5 * HOUR);
    expect((await harness.engine.sweep()).tasksEscalated).toBe(1);
    expect((await harness.engine.sweep()).tasksEscalated).toBe(0);
    expect((await harness.engine.sweep()).tasksEscalated).toBe(0);
  });

  it("takes a completed task off the breach queue", async () => {
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);
    harness.clock.advance(5 * HOUR);
    await harness.engine.sweep();

    const tasks = await harness.engine.listTasks({ status: ["open"] });
    const task = tasks[0];
    if (!task) throw new Error("expected a task");
    await harness.engine.completeHumanTask({
      taskId: task.id,
      actor: { actorId: "act_agent", kind: "human", roles: ["owner_services_agent"] },
      outcome: "Fee waived.",
    });

    expect(await harness.engine.breachedTasks()).toEqual([]);
    expect((await harness.engine.tick(started.id)).instance.status).toBe("succeeded");
  });

  it("refuses a completion by someone the task was not assigned to", async () => {
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);
    const tasks = await harness.engine.listTasks({ status: ["open"] });
    const task = tasks[0];
    if (!task) throw new Error("expected a task");

    await expect(
      harness.engine.completeHumanTask({
        taskId: task.id,
        actor: { actorId: "act_stranger", kind: "human", roles: ["finance"] },
        outcome: "Done.",
      }),
    ).rejects.toThrow(/holds none of the roles/);
  });

  it("refuses to complete a task twice, which would advance the workflow twice", async () => {
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);
    const tasks = await harness.engine.listTasks({ status: ["open"] });
    const task = tasks[0];
    if (!task) throw new Error("expected a task");

    const actor: ActorRef = { actorId: "act_agent", kind: "human", roles: ["owner_services_agent"] };
    await harness.engine.completeHumanTask({ taskId: task.id, actor, outcome: "Done." });
    await expect(
      harness.engine.completeHumanTask({ taskId: task.id, actor, outcome: "Done again." }),
    ).rejects.toThrow(/already completed/);
  });
});

// --------------------------------------------------------------------------

describe("timers", () => {
  const statutory = workflow([
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
    action("close", { action: "test.close_case", handler: "close", inputs: ["rescissionDeadline"] }),
  ]);

  it("computes a statutory deadline through the timeline module, across a DST boundary", async () => {
    // Executed 30 October 2026, ten calendar days counted from the following
    // day, in America/New_York. The window closes on 9 November — after US
    // daylight saving ends on 1 November — so the offset at the deadline is
    // -05:00 and the UTC instant is an hour later than a naive computation
    // that assumed the offset never changed.
    let deadlineSeen: unknown;
    const harness = buildHarness({
      definitions: [statutory],
      startAt: "2026-10-30T12:00:00.000Z",
      handlers: {
        close: async (context) => {
          deadlineSeen = context.input["rescissionDeadline"];
          return {};
        },
      },
    });

    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: {
        stateCode: "FL",
        executedAt: "2026-10-30T12:00:00.000Z",
        deliveredAt: "2026-10-30T12:00:00.000Z",
      },
    });
    const parked = (await harness.engine.tick(started.id)).instance;

    expect(parked.status).toBe("waiting_timer");
    expect(parked.wakeAt).toBe("2026-11-10T04:59:59.999Z");

    const steps = await harness.runs.listSteps(started.runId);
    const timer = steps.find((step) => step.name === "await_deadline");
    expect(timer?.detail["basis"]).toBe("statutory_rescission");
    expect(timer?.detail["utcOffsetAtDeadline"]).toBe("-05:00");
    expect(timer?.detail["deadlineLocalDate"]).toBe("2026-11-09");
    expect(timer?.detail["ruleVersion"]).toBe("FL@2");

    // Naive arithmetic would have fired an hour early, which for a statutory
    // window is the expensive direction of the error.
    const naive = new Date(Date.parse("2026-10-30T12:00:00.000Z") + 10 * DAY).toISOString();
    expect(parked.wakeAt).not.toBe(naive);

    // The timer survives a restart and fires on a new engine.
    const resumed = harness.rebuild();
    harness.clock.set("2026-11-10T05:00:00.000Z");
    const finished = await resumed.tick(started.id);

    expect(finished.instance.status).toBe("succeeded");
    expect(deadlineSeen).toBe("2026-11-10T04:59:59.999Z");
  });

  it("computes the same window an hour earlier in UTC outside daylight saving", async () => {
    const harness = buildHarness({
      definitions: [statutory],
      startAt: "2026-06-01T12:00:00.000Z",
      handlers: { close: async () => ({}) },
    });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: {
        stateCode: "FL",
        executedAt: "2026-06-01T12:00:00.000Z",
        deliveredAt: "2026-06-01T12:00:00.000Z",
      },
    });
    const parked = (await harness.engine.tick(started.id)).instance;
    expect(parked.wakeAt).toBe("2026-06-12T03:59:59.999Z");
  });

  it("fires early by the declared offset, so the workflow wakes before the deadline", async () => {
    const early = workflow([
      {
        name: "await_deadline",
        type: "timer",
        description: "wake a day before the statutory deadline",
        schedule: {
          kind: "statutory_rescission",
          stateCodeKey: "stateCode",
          executedAtKey: "executedAt",
          deliveredAtKey: "deliveredAt",
          offsetMs: -24 * HOUR,
        },
        next: "close",
      } as WorkflowStep,
      action("close", { action: "test.close_case" }),
    ]);
    const harness = buildHarness({ definitions: [early], startAt: "2026-10-30T12:00:00.000Z" });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: {
        stateCode: "FL",
        executedAt: "2026-10-30T12:00:00.000Z",
        deliveredAt: "2026-10-30T12:00:00.000Z",
      },
    });
    const parked = (await harness.engine.tick(started.id)).instance;
    expect(parked.wakeAt).toBe("2026-11-09T04:59:59.999Z");
  });

  it("refuses a Florida window with no delivery date, because the rule counts from the later of two events", async () => {
    const harness = buildHarness({
      definitions: [statutory],
      startAt: "2026-10-30T12:00:00.000Z",
      handlers: { close: async () => ({}) },
    });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { stateCode: "FL", executedAt: "2026-10-30T12:00:00.000Z" },
    });
    const result = await harness.engine.tick(started.id);
    expect(result.instance.status).toBe("denied");
    expect(result.instance.denialReason).toBe("knowledge.no_grounding");
  });

  it("refuses when the context does not carry what a statutory clock needs", async () => {
    const harness = buildHarness({
      definitions: [statutory],
      startAt: "2026-10-30T12:00:00.000Z",
      handlers: { close: async () => ({}) },
    });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { stateCode: "FL" },
    });
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("denied");
    expect(result.instance.stuckReason).toMatch(/a guessed deadline is worse than none/);
  });

  it("refuses a jurisdiction with no rule on file rather than inventing a date", async () => {
    const harness = buildHarness({
      definitions: [statutory],
      startAt: "2026-10-30T12:00:00.000Z",
      handlers: { close: async () => ({}) },
    });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: {
        stateCode: "ZZ",
        executedAt: "2026-10-30T12:00:00.000Z",
        deliveredAt: "2026-10-30T12:00:00.000Z",
      },
    });
    const result = await harness.engine.tick(started.id);
    expect(result.instance.status).toBe("denied");
    expect(result.instance.denialReason).toBe("knowledge.no_grounding");
  });

  it("times out a wait that nothing ever signals", async () => {
    const definition = workflow([
      {
        name: "wait",
        type: "wait_for_event",
        description: "wait for the owner to respond",
        event: "owner_responded",
        timeoutMs: 7 * DAY,
        onTimeout: "escalate",
        next: "close",
      } as WorkflowStep,
      action("escalate", { action: "test.close_case" }),
      action("close", { action: "test.close_case" }),
    ]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    expect((await harness.engine.tick(started.id)).instance.status).toBe("waiting_event");

    harness.clock.advance(8 * DAY);
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("succeeded");
    expect(harness.calls["escalate"]).toBe(1);
    expect(harness.calls["close"]).toBeUndefined();
  });
});

// --------------------------------------------------------------------------

describe("ceilings", () => {
  it("stops the next step once the run's spend ceiling is passed", async () => {
    const definition = workflow([
      action("expensive", { action: "test.draft_letter", handler: "expensive", next: "second" }),
      action("second", { action: "test.close_case" }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      runSpendCeilingUsd: 1,
      handlers: { expensive: async () => ({ costUsd: 5, costCategory: "model" }) },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);

    // The overshoot is bounded at one step: the spend is recorded honestly and
    // the workflow stops rather than continuing to spend.
    expect(harness.calls["expensive"]).toBe(1);
    expect(harness.calls["second"]).toBeUndefined();
    expect(result.instance.status).toBe("denied");
    expect(result.instance.denialReason).toBe("ceiling.spend_exceeded");

    const cost = await harness.runs.costForRun(started.runId);
    expect(cost.totalUsd).toBe(5);
    const steps = await harness.runs.listSteps(started.runId);
    expect(steps[0]?.status).toBe("succeeded");
  });
});

// --------------------------------------------------------------------------

describe("describeInstance", () => {
  it("says where the case is and what to do about it, in plain language", async () => {
    const definition = workflow([
      action("gather", { next: "review" }),
      {
        name: "review",
        type: "human_task",
        description: "review the gathered evidence",
        title: "Review the evidence",
        assignedRoles: ["supervisor"],
        sla: { targetMs: 2 * HOUR, escalations: [] },
      } as WorkflowStep,
    ]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      subject: { contractId: "ctr_0021" },
    });
    await harness.engine.tick(started.id);

    const described = await harness.engine.describeInstance(started.id);
    expect(described.status).toBe("waiting_human");
    expect(described.headline).toBe("test.case (version 1) is waiting for a person.");
    expect(described.where).toEqual(["Waiting for a person: review the gathered evidence."]);
    expect(described.waitingFor).toEqual(["supervisor to Review the evidence"]);
    expect(described.nextAction).toBe("Complete the open task on the queue.");
    expect(described.openTasks[0]?.dueAt).toBe("2026-08-06T11:00:00.000Z");
    expect(described.openTasks[0]?.breached).toBe(false);
    expect(described.stepsCompleted).toEqual([
      expect.objectContaining({ step: "gather", status: "succeeded" }),
    ]);
    expect(described.costUsd).toBe(0);
  });

  it("explains a timer in terms of the date it is waiting for", async () => {
    const definition = workflow([
      {
        name: "cool_off",
        type: "timer",
        description: "wait out the cooling-off period",
        schedule: { kind: "duration", ms: 3 * DAY },
      } as WorkflowStep,
    ]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    const described = await harness.engine.describeInstance(started.id);
    expect(described.status).toBe("waiting_timer");
    expect(described.nextAction).toBe("Nothing until the scheduled date.");
    expect(described.timers).toEqual([
      expect.objectContaining({ step: "cool_off", firesAt: "2026-08-09T09:00:00.000Z" }),
    ]);
  });

  it("says nothing needs doing once the case is closed", async () => {
    const definition = workflow([action("only")]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    const described = await harness.engine.describeInstance(started.id);
    expect(described.headline).toBe("test.case (version 1) finished successfully.");
    expect(described.nextAction).toBe("Nothing. This case is closed.");
    expect(described.waitingFor).toEqual([]);
  });
});
