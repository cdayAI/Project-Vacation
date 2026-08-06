import { describe, it, expect } from "vitest";
import { FixedClock, DAY, HOUR, MINUTE } from "../kernel/clock.js";
import { isDenied } from "../kernel/errors.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { AuditLog } from "../audit/log.js";
import { verifyChain } from "../audit/chain.js";
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
import { StepHandlerRegistry, TerminalStepError, WorkflowEngine } from "./runner.js";
import { MemoryWorkflowStore } from "./store.memory.js";
import type { StepHandler, WorkflowDefinition, WorkflowStep } from "./types.js";

/**
 * Attacks on the engine.
 *
 * Each of these started as a question of the form "what would make this control
 * quietly not work" — a crash in the one window that matters, two cases that
 * look identical to the deduplication key, a barrier counted twice, a sweep
 * that spins on work nobody can do, a completed instance brought back to life.
 * Three of them found real defects, which are fixed; the tests are what stops
 * them coming back.
 */

const REQUESTER: ActorRef = {
  actorId: "act_service_agent",
  kind: "service",
  roles: ["supervisor"],
};

const ACTIONS: readonly ActionDefinition[] = [
  {
    name: "test.reserve_slot",
    risk: "sensitive",
    description: "Reserve a slot in a downstream system.",
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
];

interface Harness {
  readonly db: MemoryDb;
  readonly clock: FixedClock;
  readonly runs: MemoryRunStore;
  readonly audit: AuditLog;
  readonly store: MemoryWorkflowStore;
  readonly approvals: ApprovalService;
  readonly catalogue: WorkflowCatalogue;
  readonly engine: WorkflowEngine;
  readonly calls: Record<string, number>;
  rebuild(): WorkflowEngine;
}

function buildHarness(options: {
  readonly definitions: readonly WorkflowDefinition[];
  readonly handlers?: Readonly<Record<string, StepHandler>>;
  readonly stepLeaseMs?: number;
}): Harness {
  const db = new MemoryDb();
  const clock = new FixedClock("2026-08-06T09:00:00.000Z");
  const ids = new SeededIdGenerator("adversarial");
  const runs = new MemoryRunStore(db, clock, ids);
  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const approvals = new ApprovalService(new MemoryApprovalStore(db), clock, ids, audit);
  const containment = new ContainmentController(new MemoryContainmentStore(db), clock, audit, 0);
  const ceilings = new CeilingEnforcer(
    { runSpendUsd: 100, dailySpendUsd: 1000, runWallClockMs: 30 * DAY, modelCallsPerMinute: 1000 },
    clock,
    runs,
  );
  const registry = new ActionRegistry(ACTIONS);
  const authorizer = new Authorizer(registry, containment, ceilings, approvals, audit, clock, 300);
  const store = new MemoryWorkflowStore(db);
  const catalogue = new WorkflowCatalogue(options.definitions);

  const calls: Record<string, number> = {};
  const handlers = new StepHandlerRegistry();
  handlers.register("noop", async (context) => {
    calls[context.stepName] = (calls[context.stepName] ?? 0) + 1;
    return {};
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
    logger: createNullLogger(),
    stepLeaseMs: options.stepLeaseMs ?? 5 * MINUTE,
  };

  return {
    db,
    clock,
    runs,
    audit,
    store,
    approvals,
    catalogue,
    engine: new WorkflowEngine(dependencies),
    calls,
    rebuild: () => new WorkflowEngine(dependencies),
  };
}

function action(name: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name,
    type: "automated_action",
    description: `perform ${name}`,
    action: "test.reserve_slot",
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
    description: "A workflow used by the adversarial tests.",
    mode: "supervised",
    steps,
    ...overrides,
  });
}

// --------------------------------------------------------------------------

describe("crash windows", () => {
  /**
   * The window between the effect landing and the instance advancing.
   *
   * The record knows the step succeeded; the instance does not. Resuming must
   * believe the record — anything else either repeats an effect that already
   * happened or abandons a case that was fine.
   */
  it("moves on rather than repeating when the record shows the step already succeeded", async () => {
    const definition = workflow([
      action("reserve", { handler: "effect", next: "close" }),
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

    // The process dies after the step is recorded as succeeded but before the
    // instance advances past it.
    const realSave = harness.store.saveInstance.bind(harness.store);
    let died = false;
    harness.store.saveInstance = async (next, expected) => {
      if (!died && effects === 1 && next.history.some((entry) => entry.stepName === "reserve")) {
        died = true;
        throw new Error("process died before the transition was written");
      }
      return realSave(next, expected);
    };

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await expect(harness.engine.tick(started.id)).rejects.toThrow(/process died/);
    expect(effects).toBe(1);

    const resumed = harness.rebuild();
    harness.clock.advance(10 * MINUTE);
    const result = await resumed.tick(started.id);

    expect(effects).toBe(1);
    expect(result.instance.status).toBe("succeeded");
    expect(harness.calls["close"]).toBe(1);
    const steps = await harness.runs.listSteps(started.runId);
    expect(steps.filter((step) => step.name === "reserve")).toHaveLength(1);
  });

  /**
   * Resuming a gate must not ask for the decision twice.
   *
   * Two live approvals for one proposal is how a rejected action gets performed
   * anyway: the approver declines one, and the chokepoint happily consumes the
   * other. So a restart between raising the approval and recording the token
   * has to find the request that already exists.
   */
  it("does not raise a second approval when a gate is resumed", async () => {
    const definition = workflow([
      {
        name: "approve",
        type: "approval_gate",
        description: "approve the letter",
        gates: "send",
        approverRoles: ["supervisor"],
        summary: "Send the acknowledgement to the owner.",
        next: "send",
      } as WorkflowStep,
      action("send", {
        action: "test.send_letter",
        handler: "send",
        irreversible: true,
        inputs: ["contractId"],
      }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: { send: async () => ({}) },
    });

    // The process dies after the approval is raised but before the token is
    // parked on it.
    const realSave = harness.store.saveInstance.bind(harness.store);
    let died = false;
    harness.store.saveInstance = async (next, expected) => {
      if (!died && next.tokens.some((token) => token.state === "waiting_approval")) {
        died = true;
        throw new Error("process died before the token was parked");
      }
      return realSave(next, expected);
    };

    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { contractId: "ctr_0041" },
    });
    await expect(harness.engine.tick(started.id)).rejects.toThrow(/process died/);
    expect(await harness.approvals.list({ status: ["pending"] })).toHaveLength(1);

    const resumed = harness.rebuild();
    harness.clock.advance(10 * MINUTE);
    const parked = (await resumed.tick(started.id)).instance;

    expect(parked.status).toBe("waiting_approval");
    const pending = await harness.approvals.list({ status: ["pending"] });
    expect(pending).toHaveLength(1);

    // And the one signature that exists still carries the workflow through.
    const approvalId = pending[0]?.id;
    if (!approvalId) throw new Error("expected an approval");
    await harness.approvals.decide({
      approvalId,
      actor: { actorId: "act_supervisor", kind: "human", roles: ["supervisor"] },
      decision: "granted",
    });
    expect((await resumed.tick(started.id)).instance.status).toBe("succeeded");
    expect(harness.calls["send"]).toBe(1);
  });

  it("does not steal a step from a process that is still within its lease", async () => {
    const definition = workflow([action("slow", { handler: "slow" })]);
    let release = (): void => {};
    let handlerEntered = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      handlerEntered = resolve;
    });
    let effects = 0;
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        slow: async () => {
          effects += 1;
          handlerEntered();
          await gate;
          return {};
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const running = harness.engine.tick(started.id);
    await entered;
    expect(effects).toBe(1);

    // A sweep in another process, while the first is still inside the handler.
    const other = harness.rebuild();
    const swept = await other.sweep();
    expect(swept.transitions).toBe(0);
    expect(effects).toBe(1);

    release();
    expect((await running).instance.status).toBe("succeeded");
    expect(effects).toBe(1);
  });
});

// --------------------------------------------------------------------------

describe("the idempotency key", () => {
  /**
   * The key must separate cases as well as it separates attempts.
   *
   * If it were derived only from the step name and the inputs, a second case
   * with the same inputs — the same state code, the same fee amount — would
   * find the first case's step and silently skip its own effect. That is a
   * missing action rather than a duplicated one, which is far harder to notice.
   */
  it("does not confuse two cases that happen to have identical inputs", async () => {
    const definition = workflow([action("reserve", { handler: "effect", inputs: ["stateCode"] })]);
    let effects = 0;
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        effect: async () => {
          effects += 1;
          return {};
        },
      },
    });

    const first = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { stateCode: "FL" },
    });
    const second = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { stateCode: "FL" },
    });

    await harness.engine.tick(first.id);
    await harness.engine.tick(second.id);

    expect(effects).toBe(2);
    expect((await harness.store.requireInstance(second.id)).status).toBe("succeeded");
  });

  it("ignores context the step did not declare, so unrelated churn does not change the key", async () => {
    const definition = workflow([action("reserve", { handler: "capture", inputs: ["stateCode"] })]);
    const keys: string[] = [];
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        capture: async (context) => {
          keys.push(context.idempotencyKey);
          return {};
        },
      },
    });

    const first = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { stateCode: "FL", noise: "a" },
    });
    await harness.engine.tick(first.id);

    // A second case, same declared input, different undeclared context. Keys
    // differ only because the instance ids differ.
    const second = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      context: { stateCode: "FL", noise: "b" },
    });
    await harness.engine.tick(second.id);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain(first.id);
    expect(keys[1]).toContain(second.id);
    // Same declared inputs, so the digest half of the key is identical.
    expect(keys[0]?.split(":").pop()).toBe(keys[1]?.split(":").pop());
  });
});

// --------------------------------------------------------------------------

describe("state that must not be resurrected", () => {
  it("refuses to reopen an instance that has already ended", async () => {
    const definition = workflow([action("only")]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const finished = (await harness.engine.tick(started.id)).instance;
    expect(finished.status).toBe("succeeded");

    await expect(
      harness.store.saveInstance(
        {
          ...finished,
          status: "running",
          terminalStatus: undefined,
          tokens: [{ stepName: "only", state: "ready", attempt: 1, enteredAt: finished.updatedAt }],
        },
        finished.revision,
      ),
    ).rejects.toThrow(/already ended as succeeded/);
  });

  it("refuses to complete a task belonging to a case that was cancelled", async () => {
    const definition = workflow([
      {
        name: "review",
        type: "human_task",
        description: "review the case",
        title: "Review the case",
        assignedRoles: ["supervisor"],
      } as WorkflowStep,
    ]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    const tasks = await harness.engine.listTasks({ instanceId: started.id, status: ["open"] });
    const task = tasks[0];
    if (!task) throw new Error("expected a task");

    await harness.engine.cancel(started.id, REQUESTER, "The owner withdrew.");

    await expect(
      harness.engine.completeHumanTask({
        taskId: task.id,
        actor: { actorId: "act_supervisor", kind: "human", roles: ["supervisor"] },
        outcome: "Reviewed.",
      }),
    ).rejects.toThrow(/already ended as cancelled/);
  });

  it("refuses a signal for an event nothing is waiting on", async () => {
    const definition = workflow([action("only")]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });

    let caught: unknown;
    try {
      await harness.engine.signalEvent({
        instanceId: started.id,
        event: "something_else",
        actor: REQUESTER,
      });
    } catch (error) {
      caught = error;
    }
    expect(isDenied(caught)).toBe(true);
  });

  it("does nothing when an instance that has ended is ticked again", async () => {
    const definition = workflow([action("only")]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    const again = await harness.engine.tick(started.id);
    expect(again.transitions).toBe(0);
    expect(harness.calls["only"]).toBe(1);
  });
});

// --------------------------------------------------------------------------

describe("the sweep", () => {
  it("leaves alone work that only a person or a signal can move", async () => {
    const definition = workflow([
      {
        name: "review",
        type: "human_task",
        description: "review the case",
        title: "Review the case",
        assignedRoles: ["supervisor"],
        next: "wait",
      } as WorkflowStep,
      {
        name: "wait",
        type: "wait_for_event",
        description: "wait for the owner",
        event: "owner_responded",
      } as WorkflowStep,
    ]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    // A task on somebody's queue is not the sweep's business, however long it
    // sits there. A sweep that kept picking it up would spin forever.
    harness.clock.advance(30 * DAY);
    expect(await harness.store.dueInstances(harness.clock.nowIso())).toEqual([]);
    expect((await harness.engine.sweep()).instancesConsidered).toBe(0);
  });

  it("drives several instances in one pass", async () => {
    const definition = workflow([action("first", { next: "second" }), action("second")]);
    const harness = buildHarness({ definitions: [definition] });
    const one = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const two = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });

    const swept = await harness.engine.sweep();
    expect(swept.instancesConsidered).toBe(2);
    expect(swept.transitions).toBe(4);
    expect((await harness.store.requireInstance(one.id)).status).toBe("succeeded");
    expect((await harness.store.requireInstance(two.id)).status).toBe("succeeded");
  });

  it("stops a runaway instance at its transition budget instead of spinning", async () => {
    const chain: WorkflowStep[] = [];
    for (let index = 0; index < 10; index += 1) {
      chain.push(action(`step_${index}`, index < 9 ? { next: `step_${index + 1}` } : {}));
    }
    const definition = workflow(chain);
    const harness = buildHarness({ definitions: [definition] });

    const bounded = new WorkflowEngine({
      catalogue: harness.catalogue,
      store: harness.store,
      runs: harness.runs,
      audit: harness.audit,
      registry: new ActionRegistry(ACTIONS),
      authorizer: new Authorizer(
        new ActionRegistry(ACTIONS),
        new ContainmentController(new MemoryContainmentStore(harness.db), harness.clock, harness.audit, 0),
        new CeilingEnforcer(
          { runSpendUsd: 100, dailySpendUsd: 1000, runWallClockMs: 30 * DAY, modelCallsPerMinute: 1000 },
          harness.clock,
          harness.runs,
        ),
        new ApprovalService(
          new MemoryApprovalStore(harness.db),
          harness.clock,
          new SeededIdGenerator("bounded"),
          harness.audit,
        ),
        harness.audit,
        harness.clock,
        300,
      ),
      containment: new ContainmentController(
        new MemoryContainmentStore(harness.db),
        harness.clock,
        harness.audit,
        0,
      ),
      approvals: new ApprovalService(
        new MemoryApprovalStore(harness.db),
        harness.clock,
        new SeededIdGenerator("bounded-approvals"),
        harness.audit,
      ),
      ceilings: new CeilingEnforcer(
        { runSpendUsd: 100, dailySpendUsd: 1000, runWallClockMs: 30 * DAY, modelCallsPerMinute: 1000 },
        harness.clock,
        harness.runs,
      ),
      handlers: (() => {
        const registry = new StepHandlerRegistry();
        registry.register("noop", async () => ({}));
        return registry;
      })(),
      clock: harness.clock,
      ids: new SeededIdGenerator("bounded-ids"),
      logger: createNullLogger(),
      maxTransitionsPerTick: 3,
    });

    const started = await bounded.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await bounded.tick(started.id);

    expect(result.transitions).toBe(3);
    expect(result.blocked).toMatch(/Stopped after 3 steps/);
    expect(result.instance.status).toBe("running");
  });
});

// --------------------------------------------------------------------------

describe("fan-out arithmetic", () => {
  it("releases a nested join only once every inner path has finished", async () => {
    const order: string[] = [];
    const definition = workflow([
      {
        name: "outer",
        type: "parallel",
        description: "two workstreams",
        branches: ["left", "inner"],
        next: "combine",
      } as WorkflowStep,
      action("left", { handler: "trace" }),
      {
        name: "inner",
        type: "parallel",
        description: "two checks inside the second workstream",
        branches: ["inner_a", "inner_b"],
        next: "inner_join",
      } as WorkflowStep,
      action("inner_a", { handler: "trace" }),
      action("inner_b", { handler: "trace" }),
      action("inner_join", { handler: "trace" }),
      action("combine", { action: "test.close_case", handler: "trace" }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        trace: async (context) => {
          order.push(context.stepName);
          return {};
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("succeeded");
    // Every step ran exactly once, and both joins ran after everything they
    // were waiting on.
    expect(order.filter((name) => name === "inner_join")).toHaveLength(1);
    expect(order.filter((name) => name === "combine")).toHaveLength(1);
    expect(order.indexOf("inner_join")).toBeGreaterThan(order.indexOf("inner_a"));
    expect(order.indexOf("inner_join")).toBeGreaterThan(order.indexOf("inner_b"));
    expect(order.indexOf("combine")).toBe(order.length - 1);
    expect(order.indexOf("combine")).toBeGreaterThan(order.indexOf("inner_join"));
    expect(order.indexOf("combine")).toBeGreaterThan(order.indexOf("left"));
    expect(result.instance.barriers).toEqual([]);
  });

  it("unwinds every branch's work when one branch fails", async () => {
    const undone: string[] = [];
    const definition = workflow([
      {
        name: "fan",
        type: "parallel",
        description: "two workstreams",
        branches: ["good", "bad"],
        next: "combine",
      } as WorkflowStep,
      action("good", { handler: "noop", compensation: "undo_good" }),
      action("bad", { handler: "explodes" }),
      action("combine", { action: "test.close_case" }),
      {
        name: "undo_good",
        type: "compensation",
        description: "undo the good branch",
        action: "test.close_case",
        handler: "undo_good",
      } as WorkflowStep,
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        explodes: async () => {
          throw new TerminalStepError("the second workstream failed");
        },
        undo_good: async () => {
          undone.push("undo_good");
          return {};
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("failed");
    expect(undone).toEqual(["undo_good"]);
    // The join never fired, and no live path was left behind.
    expect(harness.calls["combine"]).toBeUndefined();
    expect(result.instance.tokens).toEqual([]);
    expect(result.instance.barriers).toEqual([]);
  });
});

// --------------------------------------------------------------------------

describe("what the record can prove afterwards", () => {
  it("leaves an intact audit chain covering the whole case", async () => {
    const definition = workflow([
      action("first", { next: "review" }),
      {
        name: "review",
        type: "human_task",
        description: "review the case",
        title: "Review the case",
        assignedRoles: ["supervisor"],
        next: "close",
      } as WorkflowStep,
      action("close", { action: "test.close_case" }),
    ]);
    const harness = buildHarness({ definitions: [definition] });

    const started = await harness.engine.start({
      workflow: "test.case",
      requestedBy: REQUESTER,
      subject: { contractId: "ctr_0031" },
    });
    await harness.engine.tick(started.id);
    const tasks = await harness.engine.listTasks({ instanceId: started.id, status: ["open"] });
    const task = tasks[0];
    if (!task) throw new Error("expected a task");
    await harness.engine.completeHumanTask({
      taskId: task.id,
      actor: { actorId: "act_supervisor", kind: "human", roles: ["supervisor"] },
      outcome: "Checked.",
    });
    await harness.engine.tick(started.id);

    const entries = await harness.audit.readChain();
    expect(verifyChain(entries).intact).toBe(true);

    const types = entries.map((entry) => entry.eventType);
    expect(types).toContain("workflow.instance_started");
    expect(types).toContain("workflow.instance_ended");
    expect(types.filter((type) => type === "workflow.instance_ended")).toHaveLength(1);

    // Every authorization decision is in the chain too, one per effecting step.
    expect(types.filter((type) => type === "authorization.granted")).toHaveLength(2);
  });

  it("records a handler's output as a digest, never as content", async () => {
    const definition = workflow([action("produce", { handler: "produce" })]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: { produce: async () => ({ output: { finding: "inside_window" } }) },
    });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    const entries = await harness.audit.list({ eventType: ["step.recorded"] });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error("expected an entry");
    expect(entry.inputDigests["output"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toContain("inside_window");
  });

  it("fails the case rather than looping when a handler returns something too large to carry", async () => {
    const definition = workflow([
      action("produce", { handler: "produce", next: "close" }),
      action("close", { action: "test.close_case" }),
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        produce: async () => ({ output: { blob: "x".repeat(5000) } }),
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    const result = await harness.engine.tick(started.id);

    expect(result.instance.status).toBe("failed");
    expect(result.instance.failureReason).toMatch(/cannot be carried forward/);
    expect(harness.calls["close"]).toBeUndefined();
    // The effect is still recorded honestly: it did happen.
    const steps = await harness.runs.listSteps(started.runId);
    expect(steps[0]?.status).toBe("succeeded");
    // And a resume does not retry it forever.
    const resumed = harness.rebuild();
    expect((await resumed.tick(started.id)).transitions).toBe(0);
  });

  it("keeps a supervisor's view honest when the case is stuck part-way", async () => {
    const definition = workflow([
      action("reserve", { handler: "noop", compensation: "release", next: "close" }),
      action("close", { action: "test.close_case", handler: "explodes" }),
      {
        name: "release",
        type: "compensation",
        description: "release the slot",
        action: "test.close_case",
        handler: "release_fails",
      } as WorkflowStep,
    ]);
    const harness = buildHarness({
      definitions: [definition],
      handlers: {
        explodes: async () => {
          throw new TerminalStepError("the system of record rejected the close");
        },
        release_fails: async () => {
          throw new TerminalStepError("the downstream system will not release it");
        },
      },
    });

    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    const described = await harness.engine.describeInstance(started.id);
    expect(described.status).toBe("failed");
    expect(described.stuckReason).toMatch(/The unwind could not complete/);
    expect(described.nextAction).toMatch(/Review the step trail/);
    expect(described.stepsCompleted.map((entry) => `${entry.step}:${entry.status}`)).toEqual([
      "reserve:succeeded",
      "close:failed",
      "release:failed",
    ]);
  });
});

// --------------------------------------------------------------------------

describe("service-level queues under stress", () => {
  it("puts the most overdue task at the top of the queue", async () => {
    const definition = workflow([
      {
        name: "review",
        type: "human_task",
        description: "review the case",
        title: "Review the case",
        assignedRoles: ["supervisor"],
        sla: { targetMs: HOUR, escalations: [] },
      } as WorkflowStep,
    ]);
    const harness = buildHarness({ definitions: [definition] });

    const first = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(first.id);
    harness.clock.advance(2 * HOUR);
    const second = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(second.id);
    harness.clock.advance(2 * HOUR);

    const breached = await harness.engine.breachedTasks();
    expect(breached).toHaveLength(2);
    expect(breached[0]?.instanceId).toBe(first.id);
    expect(breached[1]?.instanceId).toBe(second.id);
  });

  it("shows a queue only the roles it was assigned to", async () => {
    const definition = workflow([
      {
        name: "review",
        type: "human_task",
        description: "review the case",
        title: "Review the case",
        assignedRoles: ["supervisor"],
      } as WorkflowStep,
    ]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);

    expect(await harness.engine.listTasks({ roles: ["supervisor"] })).toHaveLength(1);
    expect(await harness.engine.listTasks({ roles: ["finance"] })).toEqual([]);
  });

  it("refuses to lower an escalation level that has already been acted on", async () => {
    const definition = workflow([
      {
        name: "review",
        type: "human_task",
        description: "review the case",
        title: "Review the case",
        assignedRoles: ["supervisor"],
        sla: {
          targetMs: HOUR,
          escalations: [{ afterMs: 0, notifyRoles: ["supervisor"], note: "Overdue." }],
        },
      } as WorkflowStep,
    ]);
    const harness = buildHarness({ definitions: [definition] });
    const started = await harness.engine.start({ workflow: "test.case", requestedBy: REQUESTER });
    await harness.engine.tick(started.id);
    harness.clock.advance(2 * HOUR);
    await harness.engine.sweep();

    const tasks = await harness.engine.listTasks({ status: ["open"] });
    const task = tasks[0];
    if (!task) throw new Error("expected a task");
    expect(task.escalationLevel).toBe(1);

    await expect(
      harness.store.patchHumanTask(task.id, { escalationLevel: 0 }),
    ).rejects.toThrow(/cannot be lowered/);
  });
});
