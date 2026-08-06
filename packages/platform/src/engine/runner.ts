import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import type { Logger } from "../kernel/logger.js";
import { decision as auditDecision, type AuditLog } from "../audit/log.js";
import type { RunStore } from "../record/port.js";
import type {
  ActorRef,
  CostCategory,
  IsoTimestamp,
  OperatingMode,
  Step,
} from "../record/types.js";
import { OPERATING_MODES } from "../record/types.js";
import type { ApprovalService } from "../guard/approvals.js";
import type { Authorizer } from "../guard/authorize.js";
import type { CeilingEnforcer } from "../guard/ceilings.js";
import type { ContainmentController } from "../guard/containment.js";
import type { ActionRegistry } from "../guard/registry.js";
import { computeRescissionDeadline } from "../timeline/compute.js";
import type { HolidayCalendarTable, JurisdictionTable } from "../timeline/types.js";
import { storeUnavailable } from "../store/db.js";
import { definitionDigest, type WorkflowCatalogue } from "./definition.js";
import {
  appendHistory,
  arriveAtBarrier,
  assertContextSafe,
  backoffMsFor,
  buildCompensationQueue,
  canRetry,
  chooseBranch,
  findToken,
  idempotencyKeyFor,
  mergeContext,
  normaliseInstance,
  pickInputs,
  withToken,
  withoutToken,
} from "./instance.js";
import type { WorkflowStore } from "./port.js";
import type {
  HumanTask,
  HumanTaskFilter,
  InstanceDescription,
  StepHandler,
  StepHandlerContext,
  StepOutcome,
  StepToken,
  TimerSchedule,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowStep,
} from "./types.js";
import { isTerminalInstanceStatus } from "./types.js";

/**
 * The executor.
 *
 * The constraint that shapes everything below: an instance's whole state lives
 * in the store, and every transition is written before the next one begins.
 * Nothing needed to continue survives in this object between calls. A process
 * can be killed at any line here and a new engine over the same store picks the
 * case up — which is this module's stated exit gate, and the reason the code
 * reads as claim, act, record, advance rather than as a chain of awaits with
 * the state in local variables.
 *
 * Four controls run on the step boundary rather than at instance start, because
 * a control checked only at the start is a control an in-flight case outruns:
 *
 *   Containment. Re-checked before every step, so an operator's pause stops
 *   work already running at its next step rather than only preventing new work.
 *
 *   Authorization. Every effect passes `Authorizer.authorize`, carrying the
 *   digest of this exact proposal and whatever approval the gate raised, so the
 *   chokepoint sees each step rather than the workflow in aggregate.
 *
 *   Ceilings. The estimate is reserved before the step and the actual is
 *   consumed after it, so a run that overshoots is stopped at its next step
 *   instead of discovering its budget at the end.
 *
 *   Idempotency. The effect's key is checked against the operating record
 *   before the effect happens. A step that already landed is not repeated, and
 *   a step whose outcome the record cannot vouch for is refused rather than
 *   retried — "we do not know whether it happened" and "it did not happen" are
 *   different facts, and only one of them is safe to act on.
 */

/** A step handler failed in a way that is safe to retry: the effect did not land. */
export class RetryableStepError extends Error {
  readonly detail: Record<string, string | number | boolean>;

  constructor(message: string, detail: Record<string, string | number | boolean> = {}) {
    super(message);
    this.name = "RetryableStepError";
    this.detail = detail;
  }
}

/** A step handler failed in a way retrying cannot fix. */
export class TerminalStepError extends Error {
  readonly detail: Record<string, string | number | boolean>;

  constructor(message: string, detail: Record<string, string | number | boolean> = {}) {
    super(message);
    this.name = "TerminalStepError";
    this.detail = detail;
  }
}

/**
 * The implementations a deployment wires up.
 *
 * Definitions name a handler; they never contain one. That is what keeps a
 * definition reviewable by someone who does not read code, and what keeps this
 * module free of any dependency on what the steps actually do.
 */
export class StepHandlerRegistry {
  private readonly handlers = new Map<string, StepHandler>();

  register(name: string, handler: StepHandler): void {
    if (this.handlers.has(name)) {
      throw new InvalidInputError(
        `Step handler "${name}" is already registered. Two implementations under one name means a definition cannot say which it meant.`,
        "name",
      );
    }
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** @throws {DeniedError} `config.missing` — an unwired step must not run. */
  require(name: string): StepHandler {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new DeniedError(
        "config.missing",
        `No step handler is registered under "${name}". The workflow refuses to run a step it cannot perform rather than skipping it.`,
        { handler: name },
      );
    }
    return handler;
  }

  names(): readonly string[] {
    return [...this.handlers.keys()].sort();
  }
}

export interface TimelineOptions {
  readonly rules?: JurisdictionTable | undefined;
  readonly holidayCalendars?: HolidayCalendarTable | undefined;
  readonly requireVerifiedRules?: boolean | undefined;
}

export interface EngineDependencies {
  readonly catalogue: WorkflowCatalogue;
  readonly store: WorkflowStore;
  readonly runs: RunStore;
  readonly audit: AuditLog;
  readonly registry: ActionRegistry;
  readonly authorizer: Authorizer;
  readonly containment: ContainmentController;
  readonly approvals: ApprovalService;
  readonly ceilings: CeilingEnforcer;
  readonly handlers: StepHandlerRegistry;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /**
   * Transitions one `tick` performs before returning.
   *
   * A bound rather than "run to completion", so one pathological instance
   * cannot monopolise a sweep and a definition that somehow cycles stops being
   * this process's problem after a fixed amount of work.
   */
  readonly maxTransitionsPerTick?: number | undefined;
  /**
   * How long a claim on a step is honoured before another process may take it.
   *
   * This is what stops a crashed process from parking an instance forever: the
   * token it was holding becomes claimable again once the lease lapses. It does
   * *not* make the step safe to re-run — that judgement belongs to the
   * idempotency check, which refuses an attempt whose outcome is unknown.
   * Long enough that a slow step is not stolen mid-flight; short enough that a
   * case is not lost for a shift.
   */
  readonly stepLeaseMs?: number | undefined;
  readonly timeline?: TimelineOptions | undefined;
}

export interface StartWorkflowInput {
  readonly workflow: string;
  /** Pin a specific version. Defaults to the highest published one. */
  readonly version?: number | undefined;
  readonly requestedBy: ActorRef;
  readonly context?: WorkflowContext | undefined;
  readonly subject?: Readonly<Record<string, string>> | undefined;
  readonly correlationId?: string | undefined;
  /** Must not be more autonomous than the mode the definition was approved for. */
  readonly mode?: OperatingMode | undefined;
}

export interface TickResult {
  readonly instance: WorkflowInstance;
  readonly transitions: number;
  /** Set when the tick stopped for a reason other than "nothing left to do". */
  readonly blocked?: string | undefined;
}

export interface SweepResult {
  readonly instancesConsidered: number;
  readonly transitions: number;
  readonly tasksEscalated: number;
}

/** Ranks the operating modes so a caller cannot start in a bolder one than approved. */
const MODE_AUTONOMY: Readonly<Record<OperatingMode, number>> = {
  shadow: 0,
  assisted: 1,
  supervised: 2,
  bounded_autonomy: 3,
};

export class WorkflowEngine {
  private readonly maxTransitions: number;
  private readonly leaseMs: number;

  constructor(private readonly deps: EngineDependencies) {
    this.maxTransitions = deps.maxTransitionsPerTick ?? 64;
    this.leaseMs = deps.stepLeaseMs ?? 5 * 60 * 1000;
  }

  // --- lifecycle ---------------------------------------------------------

  /**
   * Publish a definition and record that this deployment did so.
   *
   * The catalogue refuses a changed republication on its own; this adds the
   * audit entry, so "when did this version of this workflow become live" is
   * answerable from the chain rather than from a deploy log.
   */
  async publish(definition: WorkflowDefinition, actor: ActorRef): Promise<WorkflowDefinition> {
    const published = this.deps.catalogue.publish(definition);
    await this.deps.audit.record(
      auditDecision({
        eventType: "workflow.definition_published",
        actorId: actor.actorId,
        actorKind: actor.kind,
        actorRoles: actor.roles,
        subject: { workflow: definition.name, version: String(definition.version) },
        inputDigests: { definition: published.digest },
        decision: { mode: definition.mode, steps: definition.steps.length },
      }),
    );
    return published.definition;
  }

  /**
   * Start an instance.
   *
   * Everything that can refuse refuses here, before any work is recorded: an
   * unknown workflow, a mode bolder than the definition was approved for,
   * missing context, an action nobody registered, a handler nobody wired up, an
   * engaged containment switch. Discovering any of those halfway through would
   * leave a half-finished case nobody asked for.
   */
  async start(input: StartWorkflowInput): Promise<WorkflowInstance> {
    const definition =
      input.version === undefined
        ? this.deps.catalogue.latest(input.workflow)
        : this.deps.catalogue.require(input.workflow, input.version);

    const mode = input.mode ?? definition.mode;
    if (!OPERATING_MODES.includes(mode)) {
      throw new InvalidInputError(`"${mode}" is not an operating mode.`, "mode");
    }
    if (MODE_AUTONOMY[mode] > MODE_AUTONOMY[definition.mode]) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `Workflow "${definition.name}" version ${definition.version} was approved for ${definition.mode} mode and cannot be started in ${mode}, which gives it more latitude than anyone reviewed.`,
        { workflow: definition.name, requested: mode, approved: definition.mode },
      );
    }

    const context: WorkflowContext = Object.freeze({ ...(input.context ?? {}) });
    assertContextSafe(context, `Starting ${definition.name}`);

    const missing = (definition.requiredContext ?? []).filter(
      (key) => !Object.prototype.hasOwnProperty.call(context, key),
    );
    if (missing.length > 0) {
      throw new InvalidInputError(
        `Workflow "${definition.name}" needs context ${missing.join(", ")} before it can start.`,
        "context",
      );
    }

    // Preflight the wiring. A step whose action is unregistered or whose
    // handler is absent must not be discovered on the path that reaches it,
    // because by then the case is half done.
    for (const step of definition.steps) {
      if (step.action !== undefined) this.deps.registry.require(step.action);
      if (step.handler !== undefined) this.deps.handlers.require(step.handler);
    }

    await this.deps.containment.assertClear({ workflowName: definition.name });

    const start = definition.steps.find((step) => step.type !== "compensation");
    if (!start) {
      throw new InvalidInputError(`Workflow "${definition.name}" has no step to start from.`, "steps");
    }

    const now = this.deps.clock.nowIso();
    const instanceId = this.deps.ids.next("workflowInstance");
    const correlationId = input.correlationId ?? instanceId;
    const subject = Object.freeze({ ...(input.subject ?? {}) });

    const run = await this.deps.runs.createRun({
      kind: definition.name,
      status: "running",
      mode,
      requestedBy: input.requestedBy,
      subject,
      correlationId,
      workflowInstanceId: instanceId,
      startedAt: now,
      inputDigest: digestValue(context),
    });
    this.deps.ceilings.markRunStarted(run.id);

    const instance = normaliseInstance({
      id: instanceId,
      definitionName: definition.name,
      definitionVersion: definition.version,
      definitionDigest: definitionDigest(definition),
      status: "running",
      mode,
      runId: run.id,
      correlationId,
      requestedBy: input.requestedBy,
      subject,
      context,
      tokens: [{ stepName: start.name, state: "ready", attempt: 1, enteredAt: now }],
      barriers: [],
      history: [],
      compensationQueue: [],
      approvals: {},
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.deps.store.createInstance(instance);

    await this.deps.audit.record(
      auditDecision({
        eventType: "workflow.instance_started",
        actorId: input.requestedBy.actorId,
        actorKind: input.requestedBy.kind,
        actorRoles: input.requestedBy.roles,
        runId: run.id,
        correlationId,
        subject: { ...subject, workflowInstanceId: instanceId, workflow: definition.name },
        inputDigests: { definition: instance.definitionDigest, context: digestValue(context) },
        decision: { version: definition.version, mode, startStep: start.name },
      }),
    );

    return created;
  }

  // --- driving -----------------------------------------------------------

  /**
   * Advance an instance as far as it goes without waiting for anything.
   *
   * Re-reads the instance between every step. That looks wasteful and is not:
   * it is what makes a pause engaged mid-instance, an approval granted
   * mid-run, and a competing engine's claim all visible at the next step
   * boundary rather than only at the end.
   */
  async tick(instanceId: Id<"workflowInstance">): Promise<TickResult> {
    let instance = await this.deps.store.requireInstance(instanceId);
    const definition = this.resolvePinnedDefinition(instance);

    let transitions = 0;
    let blocked: string | undefined;

    // Approvals resolve before the loop rather than inside it: a granted
    // approval turns a parked token into a ready one and a rejected or expired
    // one ends the instance, and neither is a step execution.
    instance = await this.refreshApprovals(instance, definition);

    while (transitions < this.maxTransitions) {
      instance = await this.deps.store.requireInstance(instanceId);
      if (isTerminalInstanceStatus(instance.status)) break;

      const token = this.pickActionableToken(instance, definition);
      if (!token) break;

      const step = definition.steps.find((candidate) => candidate.name === token.stepName);
      if (!step) {
        // Unreachable while the digest check in `resolvePinnedDefinition`
        // holds. Kept because "unreachable" and "unchecked" are different.
        throw new InvalidInputError(
          `Instance ${instanceId} is at step "${token.stepName}", which is not in ${definition.name} version ${definition.version}.`,
          "stepName",
        );
      }

      const claimed = await this.claim(instanceId, token);
      if (!claimed) {
        blocked = `Step "${token.stepName}" is being run by another process.`;
        break;
      }

      instance = await this.runStep(claimed, definition, step, token);
      transitions += 1;
      if (isTerminalInstanceStatus(instance.status)) break;
    }

    if (transitions >= this.maxTransitions) {
      blocked = `Stopped after ${this.maxTransitions} steps in one pass; the instance is not finished.`;
    }

    instance = await this.finalise(instance);
    return { instance, transitions, blocked };
  }

  /**
   * Drive everything with work to do, and escalate overdue human work.
   *
   * Deliberately one method. A deployment that had to remember to run a second
   * "escalations" job would eventually forget, and a breached SLA would be
   * invisible rather than merely late.
   */
  async sweep(options: { readonly limit?: number } = {}): Promise<SweepResult> {
    const now = this.deps.clock.nowIso();
    const due = await this.deps.store.dueInstances(now, options.limit ?? 50);

    let transitions = 0;
    for (const instance of due) {
      const result = await this.tick(instance.id);
      transitions += result.transitions;
    }

    const tasksEscalated = await this.escalateOverdueTasks(now);
    return { instancesConsidered: due.length, transitions, tasksEscalated };
  }

  // --- external signals --------------------------------------------------

  /** Complete a human task and release the step that was waiting on it. */
  async completeHumanTask(input: {
    readonly taskId: Id<"step">;
    readonly actor: ActorRef;
    readonly outcome: string;
    /** Merged into the instance context, subject to the same safety rules. */
    readonly output?: WorkflowContext | undefined;
  }): Promise<WorkflowInstance> {
    const task = await this.deps.store.getHumanTask(input.taskId);
    if (!task) {
      throw new DeniedError("record.unavailable", `Task ${input.taskId} is not on any queue.`, {
        taskId: input.taskId,
      });
    }
    if (task.status !== "open") {
      throw new DeniedError(
        "record.unavailable",
        `Task ${input.taskId} was already ${task.status}. Completing it twice would advance the workflow twice.`,
        { taskId: input.taskId, status: task.status },
      );
    }
    // The queue's roles are the authorisation for the task itself. Someone
    // holding none of them completing it would be a decision by a person the
    // workflow never asked.
    const permitted =
      input.actor.kind === "system" ||
      input.actor.roles.some((role) => task.assignedRoles.includes(role));
    if (!permitted) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `${input.actor.actorId} holds none of the roles this task was assigned to (${task.assignedRoles.join(", ")}).`,
        { taskId: input.taskId, actorId: input.actor.actorId },
      );
    }

    const now = this.deps.clock.nowIso();
    const instance = await this.deps.store.requireInstance(task.instanceId);
    // Checked before anything is written. A case that was cancelled while the
    // task sat on the queue must not have its step marked complete, because
    // that would record a decision the workflow never acted on.
    if (isTerminalInstanceStatus(instance.status)) {
      throw new DeniedError(
        "record.unavailable",
        `The case this task belongs to already ended as ${instance.status}, so completing the task would record a decision nothing acted on.`,
        { taskId: input.taskId, instanceId: instance.id, status: instance.status },
      );
    }
    const definition = this.resolvePinnedDefinition(instance);
    const step = definition.steps.find((candidate) => candidate.name === task.stepName);

    await this.deps.runs.patchStep(task.id, {
      status: "succeeded",
      endedAt: now,
      outputDigest: digestValue({ outcome: input.outcome, output: input.output ?? {} }),
      detail: { completedBy: input.actor.actorId, outcome: input.outcome.slice(0, 500) },
    });

    await this.deps.store.patchHumanTask(task.id, {
      status: "completed",
      completedAt: now,
      completedBy: input.actor.actorId,
      outcome: input.outcome.slice(0, 500),
    });

    const updated = await this.mutate(task.instanceId, (current) => {
      const token = findToken(current, task.stepName);
      if (!token || token.state !== "waiting_human") return null;
      const context = mergeContext(current.context, input.output, `Completing task ${task.stepName}`);
      const outcome: StepOutcome = {
        stepName: task.stepName,
        status: "succeeded",
        at: now,
        stepId: task.id,
        summary: `${input.actor.actorId} completed "${task.title}": ${input.outcome.slice(0, 200)}`,
        costUsd: 0,
      };
      return this.advance({ ...current, context }, step, token, outcome, now);
    });

    await this.deps.audit.record(
      auditDecision({
        eventType: "step.recorded",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        runId: instance.runId,
        correlationId: instance.correlationId,
        subject: {
          workflowInstanceId: instance.id,
          workflow: instance.definitionName,
          step: task.stepName,
        },
        inputDigests: { output: digestValue(input.output ?? {}) },
        decision: { kind: "human_task", completed: true },
      }),
    );

    return this.finalise(updated ?? (await this.deps.store.requireInstance(task.instanceId)));
  }

  /** Deliver a named external signal to whichever path is waiting for it. */
  async signalEvent(input: {
    readonly instanceId: Id<"workflowInstance">;
    readonly event: string;
    readonly output?: WorkflowContext | undefined;
    readonly actor: ActorRef;
  }): Promise<WorkflowInstance> {
    const now = this.deps.clock.nowIso();
    const instance = await this.deps.store.requireInstance(input.instanceId);
    const definition = this.resolvePinnedDefinition(instance);

    const waiting = instance.tokens.find(
      (token) => token.state === "waiting_event" && token.eventName === input.event,
    );
    if (!waiting) {
      throw new DeniedError(
        "record.unavailable",
        `Instance ${input.instanceId} is not waiting for "${input.event}".`,
        { instanceId: input.instanceId, event: input.event },
      );
    }

    if (waiting.stepId) {
      await this.deps.runs.patchStep(waiting.stepId, {
        status: "succeeded",
        endedAt: now,
        outputDigest: digestValue(input.output ?? {}),
        detail: { event: input.event, signalledBy: input.actor.actorId },
      });
    }

    const step = definition.steps.find((candidate) => candidate.name === waiting.stepName);
    const updated = await this.mutate(input.instanceId, (current) => {
      const token = findToken(current, waiting.stepName);
      if (!token || token.state !== "waiting_event") return null;
      const context = mergeContext(current.context, input.output, `Signal ${input.event}`);
      const outcome: StepOutcome = {
        stepName: waiting.stepName,
        status: "succeeded",
        at: now,
        stepId: token.stepId,
        summary: `Received "${input.event}".`,
        costUsd: 0,
      };
      return this.advance({ ...current, context }, step, token, outcome, now);
    });

    return this.finalise(updated ?? (await this.deps.store.requireInstance(input.instanceId)));
  }

  /**
   * Stop an instance on an operator's instruction.
   *
   * Cancelling does not merely mark the row: it unwinds. Anything already done
   * that declared a compensating action is compensated, because "we stopped"
   * and "we left the world half changed" are not the same outcome.
   */
  async cancel(
    instanceId: Id<"workflowInstance">,
    actor: ActorRef,
    reason: string,
  ): Promise<WorkflowInstance> {
    const now = this.deps.clock.nowIso();
    const instance = await this.deps.store.requireInstance(instanceId);
    if (isTerminalInstanceStatus(instance.status)) return instance;
    const definition = this.resolvePinnedDefinition(instance);

    const updated = await this.mutate(instanceId, (current) => {
      if (isTerminalInstanceStatus(current.status)) return null;
      return this.beginUnwind(
        { ...current, terminalStatus: "cancelled", stuckReason: reason },
        definition,
        now,
      );
    });

    // Recorded when the operator acts, not when the unwind finishes. An
    // instruction that took ten minutes to settle must still be evidenced at
    // the moment it was given.
    await this.deps.audit.record(
      auditDecision({
        eventType: "workflow.instance_ended",
        actorId: actor.actorId,
        actorKind: actor.kind,
        actorRoles: actor.roles,
        runId: instance.runId,
        correlationId: instance.correlationId,
        subject: { workflowInstanceId: instanceId, workflow: instance.definitionName },
        decision: { status: "cancelled", stage: "requested", reason: reason.slice(0, 500) },
      }),
    );

    return this.finalise(updated ?? (await this.deps.store.requireInstance(instanceId)));
  }

  // --- queues and reporting ----------------------------------------------

  listTasks(filter: HumanTaskFilter = {}): Promise<readonly HumanTask[]> {
    return this.deps.store.listHumanTasks(filter);
  }

  /**
   * Open tasks past their target.
   *
   * A queue the console renders. The point of the SLA machinery is that a
   * breach is a row somebody sees, not a line in a log nobody reads.
   */
  breachedTasks(
    filter: Omit<HumanTaskFilter, "breachedAsOf" | "status"> = {},
  ): Promise<readonly HumanTask[]> {
    return this.deps.store.listHumanTasks({
      ...filter,
      status: ["open"],
      breachedAsOf: this.deps.clock.nowIso(),
    });
  }

  /**
   * Where an instance is, why it is stuck, what it cost, what it waits for.
   *
   * Written for a supervisor rather than an engineer. Every string here should
   * be readable without knowing what a token or a barrier is.
   */
  async describeInstance(instanceId: Id<"workflowInstance">): Promise<InstanceDescription> {
    const instance = await this.deps.store.requireInstance(instanceId);
    let definition: WorkflowDefinition | undefined;
    let pinningProblem: string | undefined;
    try {
      definition = this.resolvePinnedDefinition(instance);
    } catch (error) {
      // allow-swallow: describing an instance must never fail. A pinned version
      // that is no longer in source is exactly what a supervisor needs told, so
      // the denial becomes the description's stuck reason instead of an
      // exception. Nothing executes on this path.
      pinningProblem =
        error instanceof DeniedError
          ? error.message
          : `The definition this instance is pinned to could not be resolved: ${String(error)}`;
    }

    const cost = await this.deps.runs.costForRun(instance.runId);
    const tasks = await this.deps.store.listHumanTasks({ instanceId, status: ["open"] });
    const now = this.deps.clock.nowIso();
    const describeStep = (name: string): WorkflowStep | undefined =>
      definition?.steps.find((step) => step.name === name);

    const where: string[] = [];
    const waitingFor: string[] = [];
    const timers: { step: string; firesAt: IsoTimestamp; basis: string }[] = [];

    for (const token of instance.tokens) {
      const label = describeStep(token.stepName)?.description ?? token.stepName;
      switch (token.state) {
        case "ready":
        case "running":
          where.push(`Working on "${label}".`);
          break;
        case "waiting_human":
          where.push(`Waiting for a person: ${label}.`);
          waitingFor.push(token.waitingFor ?? `someone to complete "${label}"`);
          break;
        case "waiting_approval":
          where.push(`Waiting for approval before "${label}".`);
          waitingFor.push(token.waitingFor ?? `an approver to decide on "${label}"`);
          break;
        case "waiting_event":
          where.push(`Waiting for "${token.eventName ?? "an external signal"}" at "${label}".`);
          waitingFor.push(token.waitingFor ?? `the signal "${token.eventName ?? "unknown"}"`);
          break;
        case "waiting_timer":
          where.push(`Waiting until ${token.wakeAt ?? "an unset time"} at "${label}".`);
          waitingFor.push(token.waitingFor ?? `the clock to reach ${token.wakeAt ?? "an unset time"}`);
          if (token.wakeAt) {
            timers.push({
              step: token.stepName,
              firesAt: token.wakeAt,
              basis: token.waitingFor ?? "a scheduled wait",
            });
          }
          break;
      }
    }

    const openTasks = tasks.map((task) => ({
      taskId: task.id,
      step: task.stepName,
      title: task.title,
      roles: task.assignedRoles,
      dueAt: task.dueAt,
      breached: task.dueAt !== undefined && now > task.dueAt,
      escalationLevel: task.escalationLevel,
    }));

    const breachedCount = openTasks.filter((task) => task.breached).length;
    const stuckReason = pinningProblem ?? instance.stuckReason;
    const startedAt = instance.createdAt;
    const endInstant = instance.endedAt ?? now;

    return {
      instanceId: instance.id,
      workflow: instance.definitionName,
      version: instance.definitionVersion,
      status: instance.status,
      headline: this.headlineFor(instance, where, breachedCount, stuckReason),
      where,
      waitingFor,
      stuckReason,
      nextAction: this.nextActionFor(instance, openTasks.length > 0, stuckReason),
      costUsd: cost.totalUsd,
      costByCategory: cost.byCategory,
      startedAt,
      updatedAt: instance.updatedAt,
      endedAt: instance.endedAt,
      elapsedMs: Math.max(0, Date.parse(endInstant) - Date.parse(startedAt)),
      stepsCompleted: instance.history.map((entry) => ({
        step: entry.stepName,
        description: describeStep(entry.stepName)?.description ?? entry.stepName,
        status: entry.status,
        at: entry.at,
        summary: entry.summary,
      })),
      openTasks,
      timers,
    };
  }

  private headlineFor(
    instance: WorkflowInstance,
    where: readonly string[],
    breachedCount: number,
    stuckReason: string | undefined,
  ): string {
    const name = `${instance.definitionName} (version ${instance.definitionVersion})`;
    switch (instance.status) {
      case "succeeded":
        return `${name} finished successfully.`;
      case "failed":
        return `${name} stopped because a step failed: ${instance.failureReason ?? "no reason was recorded"}`;
      case "denied":
        return `${name} was refused: ${instance.stuckReason ?? instance.denialReason ?? "the platform declined to continue"}`;
      case "cancelled":
        return `${name} was cancelled${stuckReason ? `: ${stuckReason}` : "."}`;
      case "compensating":
        return `${name} is undoing what it already did, because it could not finish.`;
      case "waiting_human":
        return breachedCount > 0
          ? `${name} is waiting for a person, and ${breachedCount} task${breachedCount === 1 ? " is" : "s are"} past the agreed turnaround.`
          : `${name} is waiting for a person.`;
      case "waiting_approval":
        return `${name} is waiting for an approver.`;
      case "waiting_event":
        return `${name} is waiting for something outside the platform.`;
      case "waiting_timer":
        return `${name} is waiting for a date to arrive.`;
      default:
        return where.length > 0 ? `${name}: ${where[0]}` : `${name} is running.`;
    }
  }

  private nextActionFor(
    instance: WorkflowInstance,
    hasOpenTasks: boolean,
    stuckReason: string | undefined,
  ): string {
    if (isTerminalInstanceStatus(instance.status)) {
      return instance.status === "succeeded"
        ? "Nothing. This case is closed."
        : "Review the step trail and decide whether the case needs to be started again.";
    }
    if (stuckReason) return `Someone needs to look at this: ${stuckReason}`;
    if (instance.status === "waiting_human" && hasOpenTasks) {
      return "Complete the open task on the queue.";
    }
    if (instance.status === "waiting_approval") return "An approver needs to decide.";
    if (instance.status === "waiting_event") return "Nothing until the external signal arrives.";
    if (instance.status === "waiting_timer") return "Nothing until the scheduled date.";
    return "Nothing. The platform is working on it.";
  }

  // --- internals ---------------------------------------------------------

  /**
   * Resolve the version the instance started under — never the latest one.
   *
   * The digest is checked as well as the number. A version number is a promise
   * of immutability; the digest is a check of it, and catches a definition file
   * edited in place without the version being raised. Refusing is the right
   * answer: the alternative is running the second half of a case under rules
   * the first half never saw.
   */
  private resolvePinnedDefinition(instance: WorkflowInstance): WorkflowDefinition {
    const definition = this.deps.catalogue.require(
      instance.definitionName,
      instance.definitionVersion,
    );
    const digest = definitionDigest(definition);
    if (digest !== instance.definitionDigest) {
      throw new DeniedError(
        "config.invalid",
        `Workflow "${instance.definitionName}" version ${instance.definitionVersion} has changed since instance ${instance.id} started. A published version is immutable; this instance will not be resumed under different rules.`,
        { workflow: instance.definitionName, version: instance.definitionVersion },
      );
    }
    return definition;
  }

  /**
   * Apply a transformation to the stored instance under optimistic concurrency.
   *
   * `apply` must be a pure function of the current state, because it is re-run
   * against a fresh read whenever the swap loses. That is what lets a step's
   * completion merge onto an instance somebody else touched — a human task
   * completed on a parallel path, say — instead of overwriting it.
   */
  private async mutate(
    instanceId: Id<"workflowInstance">,
    apply: (current: WorkflowInstance) => WorkflowInstance | null,
  ): Promise<WorkflowInstance | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.deps.store.requireInstance(instanceId);
      const next = apply(current);
      if (next === null) return null;
      const normalised = normaliseInstance({ ...next, updatedAt: this.deps.clock.nowIso() });
      const saved = await this.deps.store.saveInstance(normalised, current.revision);
      if (saved) return saved;
    }
    throw storeUnavailable(
      "engine.saveInstance",
      new Error(
        `instance ${instanceId} is being written faster than this process can read it; the transition was abandoned rather than applied to stale state`,
      ),
    );
  }

  /**
   * Take exclusive ownership of one step.
   *
   * This is the engine's mutual exclusion, and it happens *before* the effect
   * rather than after it. Two sweeps that both see a ready token will both try
   * to claim; one wins the compare-and-swap and the other finds the token
   * already running and walks away. Doing this after the handler ran would mean
   * the effect had already happened twice by the time anybody noticed.
   */
  private async claim(
    instanceId: Id<"workflowInstance">,
    expected: StepToken,
  ): Promise<WorkflowInstance | null> {
    const at = this.deps.clock.nowIso();
    return this.mutate(instanceId, (current) => {
      const token = findToken(current, expected.stepName);
      if (!token) return null;
      // Refuse if somebody else moved this token since it was picked — the
      // attempt or the state changing means the decision to run it was made
      // against state that no longer holds.
      if (token.attempt !== expected.attempt || token.state !== expected.state) return null;
      if (token.state === "running" && !this.leaseExpired(token)) return null;
      return withToken(current, {
        ...token,
        state: "running",
        claimedAt: at,
        inFlightAttempt: token.attempt,
      });
    });
  }

  private leaseExpired(token: StepToken): boolean {
    if (token.claimedAt === undefined) return true;
    return this.deps.clock.now() - Date.parse(token.claimedAt) >= this.leaseMs;
  }

  /**
   * The next token that can do something now.
   *
   * Ordered by the step's position in the definition, so a fan-out executes in
   * the order a reader of the definition would expect and the seeded
   * demonstration produces the same trail every time.
   */
  private pickActionableToken(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
  ): StepToken | undefined {
    const now = this.deps.clock.nowIso();
    const order = new Map(definition.steps.map((step, index) => [step.name, index] as const));
    const actionable = instance.tokens
      .filter((token) => {
        if (token.state === "ready") return true;
        // A claim that has lapsed is reclaimable, which is what stops a crashed
        // process from parking a case forever. Whether the step may actually be
        // re-run is decided by the idempotency check, not here.
        if (token.state === "running") return this.leaseExpired(token);
        if (token.state === "waiting_timer" || token.state === "waiting_event") {
          return token.wakeAt !== undefined && token.wakeAt <= now;
        }
        return false;
      })
      .sort((left, right) => (order.get(left.stepName) ?? 0) - (order.get(right.stepName) ?? 0));
    return actionable[0];
  }

  /**
   * Resolve any approval a parked token is waiting on.
   *
   * Polled rather than called back, which keeps the approval service unaware of
   * the engine — approvals are also raised outside workflows, and a callback
   * would make that the exception rather than the rule.
   */
  private async refreshApprovals(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
  ): Promise<WorkflowInstance> {
    const parked = instance.tokens.filter(
      (token) => token.state === "waiting_approval" && token.approvalId !== undefined,
    );
    if (parked.length === 0) return instance;

    let current = instance;
    for (const token of parked) {
      const approvalId = token.approvalId;
      if (!approvalId) continue;
      const approval = await this.deps.approvals.get(approvalId);
      if (!approval || approval.status === "pending") continue;

      const now = this.deps.clock.nowIso();
      const step = definition.steps.find((candidate) => candidate.name === token.stepName);

      if (approval.status === "granted" || approval.status === "consumed") {
        if (token.stepId) {
          await this.deps.runs.patchStep(token.stepId, {
            status: "succeeded",
            endedAt: now,
            detail: { approvalId, approvers: approval.decisions.length },
          });
        }
        const moved = await this.mutate(current.id, (state) => {
          const live = findToken(state, token.stepName);
          if (!live || live.state !== "waiting_approval") return null;
          const outcome: StepOutcome = {
            stepName: token.stepName,
            status: "succeeded",
            at: now,
            stepId: live.stepId,
            summary: `Approved by ${approval.decisions.length} approver(s).`,
            costUsd: 0,
          };
          return this.advance(state, step, live, outcome, now);
        });
        if (moved) current = moved;
        continue;
      }

      // Rejected or expired. Either way the gated step must not happen, and the
      // instance is refused rather than left parked forever.
      const denial =
        approval.status === "expired"
          ? new DeniedError(
              "approval.expired",
              `The approval for "${token.stepName}" expired before anyone decided, so the workflow stopped.`,
              { step: token.stepName },
            )
          : new DeniedError(
              "approval.required",
              `An approver declined "${token.stepName}", so the workflow stopped.`,
              { step: token.stepName },
            );
      current = await this.settleDenied(current, definition, token, denial);
    }
    return current;
  }

  // --- step execution ----------------------------------------------------

  private async runStep(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    step: WorkflowStep,
    token: StepToken,
  ): Promise<WorkflowInstance> {
    try {
      // Containment, re-checked at every step. Compensation is exempt: a
      // workflow stopped halfway through an irreversible sequence must still be
      // able to put the world back, or the pause leaves the damage in place.
      // See guard/containment.ts.
      await this.deps.containment.assertClear({
        workflowName: definition.name,
        isCompensation: step.type === "compensation",
      });

      switch (step.type) {
        case "automated_action":
        case "model_call":
        case "compensation":
          return await this.runEffectingStep(instance, definition, step, token);
        case "human_task":
          return await this.runHumanTask(instance, definition, step, token);
        case "approval_gate":
          return await this.runApprovalGate(instance, definition, step, token);
        case "wait_for_event":
          return await this.runWaitForEvent(instance, definition, step, token);
        case "timer":
          return await this.runTimer(instance, definition, step, token);
        case "branch":
          return await this.runBranch(instance, definition, step, token);
        case "parallel":
          return await this.runParallel(instance, definition, step, token);
      }
    } catch (error) {
      // allow-swallow: a DeniedError here is converted into a *recorded
      // refusal*, never into permission. `settleDenied` marks the step denied
      // in the operating record, ends the instance in a denied state, and
      // starts the unwind. Re-raising instead would leave the instance claimed
      // with a token stuck in `running`, which is the one state a later resume
      // cannot safely recover from.
      if (error instanceof DeniedError) {
        return await this.settleDenied(instance, definition, token, error);
      }
      throw error;
    }
  }

  private async runEffectingStep(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    step: WorkflowStep,
    token: StepToken,
  ): Promise<WorkflowInstance> {
    if (step.action === undefined || step.handler === undefined) {
      throw new InvalidInputError(
        `Step "${step.name}" produces an effect but declares no action or handler.`,
        "action",
      );
    }

    const input = pickInputs(instance.context, step.inputs);
    const key = idempotencyKeyFor(instance.id, step.name, input);

    // The operating record is asked first, because when it has an answer that
    // answer beats every inference. A step recorded as succeeded under this key
    // means the effect landed and was witnessed; the workflow moves on without
    // repeating it, whatever the instance's own state suggests.
    const existing = await this.deps.runs.findStepByIdempotencyKey(key);
    let recorded: Step;

    if (existing && existing.status === "succeeded") {
      return await this.skipAlreadyPerformed(instance, step, existing);
    }

    // The record has no answer, so the instance's own state decides.
    // `inFlightAttempt` is written when a token is claimed and cleared only
    // when the attempt finishes, so finding it equal to the current attempt
    // means an earlier process began this exact attempt and never recorded how
    // it went. Nobody can say whether the effect landed. Repeating it might
    // duplicate an irreversible action; skipping it might silently omit one.
    // Stopping and telling a person is the only honest option.
    if (token.inFlightAttempt === token.attempt) {
      return await this.settleFailed(
        instance,
        definition,
        token,
        `Step "${step.name}" was already in progress when this process took it over, so whether its effect landed is unknown. It has not been repeated. Someone must check the downstream system before this case goes any further.`,
      );
    }

    if (existing && existing.id !== token.stepId) {
      return await this.settleFailed(
        instance,
        definition,
        token,
        `Step "${step.name}" is already recorded under this idempotency key as "${existing.status}", by work this process did not start. It has not been repeated.`,
      );
    }

    const now = this.deps.clock.nowIso();
    if (existing) {
      // Our own open row from an earlier attempt. Reusing it keeps exactly one
      // row per idempotency key, so "has this effect happened" never has two
      // answers.
      recorded = existing;
      await this.deps.runs.patchStep(recorded.id, {
        detail: {
          workflowInstanceId: instance.id,
          action: step.action,
          attempt: token.attempt,
          compensation: step.type === "compensation",
        },
      });
    } else {
      recorded = await this.deps.runs.appendStep({
        runId: instance.runId,
        kind: step.type,
        name: step.name,
        idempotencyKey: key,
        attempt: token.attempt,
        status: "running",
        startedAt: now,
        inputDigest: digestValue(input),
        detail: {
          workflowInstanceId: instance.id,
          action: step.action,
          attempt: token.attempt,
          compensation: step.type === "compensation",
        },
      });
    }

    const proposalDigest = this.proposalDigestFor(instance.id, step.name, input);
    const approvalId = instance.approvals[step.name];
    const reserved = step.estimatedCostUsd ?? 0;

    try {
      await this.deps.authorizer.authorize({
        action: step.action,
        actor: instance.requestedBy,
        mode: instance.mode,
        runId: instance.runId,
        correlationId: instance.correlationId,
        subject: { ...instance.subject, workflowInstanceId: instance.id, step: step.name },
        proposalDigest,
        estimatedCostUsd: reserved,
        approvalId: approvalId as Id<"approval"> | undefined,
        workflowName: definition.name,
        requiredScopes: step.requiredScopes,
      });
    } catch (error) {
      // allow-swallow: the denial is recorded against the step and immediately
      // re-raised, so `runStep` settles the instance as denied. The effect did
      // not happen and is not reported as though it did.
      if (error instanceof DeniedError) {
        await this.deps.runs.patchStep(recorded.id, {
          status: "denied",
          endedAt: this.deps.clock.nowIso(),
          denialReason: error.reason,
          error: error.message.slice(0, 500),
        });
      }
      throw error;
    }

    const handler = this.deps.handlers.require(step.handler);
    const handlerContext: StepHandlerContext = {
      instanceId: instance.id,
      runId: instance.runId,
      stepId: recorded.id,
      workflowName: definition.name,
      stepName: step.name,
      attempt: token.attempt,
      mode: instance.mode,
      input,
      subject: instance.subject,
      correlationId: instance.correlationId,
      idempotencyKey: key,
    };

    let result;
    try {
      result = await handler(handlerContext);
    } catch (error) {
      return await this.handleStepFailure(
        instance,
        definition,
        step,
        token,
        recorded.id,
        reserved,
        error,
      );
    }

    const costUsd = Math.max(0, result.costUsd ?? 0);
    if (costUsd > 0) {
      const category: CostCategory =
        result.costCategory ?? (step.type === "model_call" ? "model" : "compute");
      await this.deps.runs.recordCost({
        runId: instance.runId,
        stepId: recorded.id,
        category,
        amountUsd: costUsd,
        units: result.units,
        modelId: result.modelId,
        recordedAt: this.deps.clock.nowIso(),
      });
    }

    // The step is closed in the record *before* the ceiling is consumed. The
    // effect has happened; the record must say so even if the ceiling then
    // refuses to let the workflow continue.
    const finishedAt = this.deps.clock.nowIso();
    await this.deps.runs.patchStep(recorded.id, {
      status: "succeeded",
      endedAt: finishedAt,
      outputDigest: digestValue(result.output ?? {}),
      detail: {
        workflowInstanceId: instance.id,
        action: step.action,
        attempt: token.attempt,
        costUsd,
        ...(result.summary ? { summary: result.summary.slice(0, 400) } : {}),
      },
    });

    await this.recordStepAudit(
      instance,
      definition,
      step,
      recorded.id,
      { input: digestValue(input), output: digestValue(result.output ?? {}) },
      { attempt: token.attempt, costUsd },
    );

    // Ceilings at consumption. This can refuse after the money is spent, which
    // is the point: it bounds the overrun at one step rather than none.
    await this.deps.ceilings.consume(instance.runId, costUsd, reserved);

    // Check the handler's output before the transition rather than inside it.
    // A handler that returns a payload where a reference was expected would
    // otherwise fail the merge *inside* the compare-and-swap, leaving a step
    // recorded as succeeded and a token stuck running — and every later resume
    // would find the same succeeded step, try the same merge, and fail the same
    // way. Failing the instance here is recoverable; that loop is not.
    try {
      mergeContext(instance.context, result.output, `Step ${step.name}`);
    } catch (error) {
      return await this.settleFailed(
        instance,
        definition,
        token,
        `Step "${step.name}" completed, but its output cannot be carried forward: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const applied = await this.mutate(instance.id, (current) => {
      const live = findToken(current, step.name);
      if (!live) return null;
      const context = mergeContext(current.context, result.output, `Step ${step.name}`);
      const outcome: StepOutcome = {
        stepName: step.name,
        status: "succeeded",
        at: finishedAt,
        stepId: recorded.id,
        summary: result.summary,
        costUsd,
      };
      if (step.type === "compensation") {
        return this.completeCompensation({ ...current, context }, step, outcome, finishedAt);
      }
      return this.advance({ ...current, context }, step, live, outcome, finishedAt);
    });

    return applied ?? (await this.deps.store.requireInstance(instance.id));
  }

  /** Move past a step whose effect an earlier attempt already landed. */
  private async skipAlreadyPerformed(
    instance: WorkflowInstance,
    step: WorkflowStep,
    existing: Step,
  ): Promise<WorkflowInstance> {
    const now = this.deps.clock.nowIso();
    const applied = await this.mutate(instance.id, (current) => {
      const live = findToken(current, step.name);
      if (!live) return null;
      const outcome: StepOutcome = {
        stepName: step.name,
        status: "succeeded",
        at: now,
        stepId: existing.id,
        summary: "Already performed on an earlier attempt; not repeated.",
        costUsd: 0,
      };
      if (step.type === "compensation") {
        return this.completeCompensation(current, step, outcome, now);
      }
      return this.advance(current, step, live, outcome, now);
    });
    return applied ?? (await this.deps.store.requireInstance(instance.id));
  }

  private async handleStepFailure(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    step: WorkflowStep,
    token: StepToken,
    stepId: Id<"step">,
    reserved: number,
    error: unknown,
  ): Promise<WorkflowInstance> {
    // Release the reservation the chokepoint took, or a failed step would keep
    // shrinking the run's budget until nothing else could run.
    await this.deps.ceilings.consume(instance.runId, 0, reserved);

    if (error instanceof DeniedError) {
      await this.deps.runs.patchStep(stepId, {
        status: "denied",
        endedAt: this.deps.clock.nowIso(),
        denialReason: error.reason,
        error: error.message.slice(0, 500),
      });
      throw error;
    }

    const retryable = error instanceof RetryableStepError;
    const message = error instanceof Error ? error.message : String(error);

    if (retryable && step.retry && canRetry(step.retry, token.attempt)) {
      const delay = backoffMsFor(step.retry, token.attempt + 1);
      const wakeAt = new Date(this.deps.clock.now() + delay).toISOString();
      // The step row stays open across attempts. Closing and reopening it would
      // put two rows under one idempotency key, and "has this effect happened"
      // would then have two answers.
      await this.deps.runs.patchStep(stepId, {
        detail: {
          workflowInstanceId: instance.id,
          attempt: token.attempt,
          lastError: message.slice(0, 400),
          retryAt: wakeAt,
        },
      });
      const applied = await this.mutate(instance.id, (current) => {
        const live = findToken(current, step.name);
        if (!live) return null;
        return withToken(current, {
          ...live,
          state: "waiting_timer",
          attempt: live.attempt + 1,
          // Cleared so the next attempt is not mistaken for an abandoned one.
          inFlightAttempt: undefined,
          claimedAt: undefined,
          wakeAt,
          stepId,
          waitingFor: `a retry of "${step.name}" after a temporary failure`,
        });
      });
      return applied ?? (await this.deps.store.requireInstance(instance.id));
    }

    await this.deps.runs.patchStep(stepId, {
      status: "failed",
      endedAt: this.deps.clock.nowIso(),
      error: message.slice(0, 500),
      detail: { workflowInstanceId: instance.id, attempt: token.attempt, retryable },
    });

    return await this.settleFailed(
      instance,
      definition,
      token,
      retryable
        ? `Step "${step.name}" failed ${token.attempt} time(s) and ran out of retries: ${message}`
        : `Step "${step.name}" failed and cannot be retried: ${message}`,
    );
  }

  private async runHumanTask(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    step: WorkflowStep,
    token: StepToken,
  ): Promise<WorkflowInstance> {
    if (step.type !== "human_task") throw new InvalidInputError("not a human task", "type");

    const input = pickInputs(instance.context, step.inputs);
    const key = idempotencyKeyFor(instance.id, step.name, input);
    const existing = await this.deps.runs.findStepByIdempotencyKey(key);
    if (existing && existing.status === "succeeded") {
      return await this.skipAlreadyPerformed(instance, step, existing);
    }

    const now = this.deps.clock.nowIso();
    // Reusing an open row makes putting the task on the queue idempotent: a
    // crash between recording the step and creating the task row resumes into
    // exactly this path and completes the pairing rather than duplicating it.
    const recorded =
      existing ??
      (await this.deps.runs.appendStep({
        runId: instance.runId,
        kind: "human_task",
        name: step.name,
        idempotencyKey: key,
        attempt: token.attempt,
        status: "waiting",
        startedAt: now,
        inputDigest: digestValue(input),
        detail: { workflowInstanceId: instance.id, title: step.title },
      }));

    const dueAt =
      step.sla === undefined
        ? undefined
        : new Date(this.deps.clock.now() + step.sla.targetMs).toISOString();

    if (!(await this.deps.store.getHumanTask(recorded.id))) {
      await this.deps.store.createHumanTask({
        id: recorded.id,
        instanceId: instance.id,
        runId: instance.runId,
        workflowName: definition.name,
        stepName: step.name,
        title: step.title,
        assignedRoles: [...step.assignedRoles],
        status: "open",
        createdAt: now,
        dueAt,
        escalationLevel: 0,
        escalatedToRoles: [],
        subject: instance.subject,
      });
    }

    await this.deps.runs.patchRun(instance.runId, { status: "awaiting_human" });

    const applied = await this.mutate(instance.id, (current) => {
      const live = findToken(current, step.name);
      if (!live) return null;
      return withToken(current, {
        ...live,
        state: "waiting_human",
        stepId: recorded.id,
        inFlightAttempt: undefined,
        claimedAt: undefined,
        wakeAt: undefined,
        waitingFor: `${step.assignedRoles.join(" or ")} to ${step.title}`,
      });
    });
    return applied ?? (await this.deps.store.requireInstance(instance.id));
  }

  private async runApprovalGate(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    step: WorkflowStep,
    token: StepToken,
  ): Promise<WorkflowInstance> {
    if (step.type !== "approval_gate") throw new InvalidInputError("not an approval gate", "type");

    const gated = definition.steps.find((candidate) => candidate.name === step.gates);
    if (!gated || gated.action === undefined) {
      throw new InvalidInputError(
        `Approval gate "${step.name}" authorises "${step.gates}", which declares no action to approve.`,
        "gates",
      );
    }

    // The approval is bound to the gated step's proposal, computed from the
    // inputs that step declared as they stand now. If something changes one of
    // them before the gated step runs, the digest no longer matches and the
    // chokepoint refuses. That is the intended behaviour rather than a defect:
    // the approver agreed to a specific proposal, not to a category of them.
    const gatedInput = pickInputs(instance.context, gated.inputs);
    const proposalDigest = this.proposalDigestFor(instance.id, gated.name, gatedInput);
    const descriptor = this.deps.registry.require(gated.action);
    const now = this.deps.clock.nowIso();

    const key = idempotencyKeyFor(instance.id, step.name, gatedInput);
    const existing = await this.deps.runs.findStepByIdempotencyKey(key);
    if (existing && existing.status === "succeeded") {
      return await this.skipAlreadyPerformed(instance, step, existing);
    }

    const recorded =
      existing ??
      (await this.deps.runs.appendStep({
        runId: instance.runId,
        kind: "approval_gate",
        name: step.name,
        idempotencyKey: key,
        attempt: token.attempt,
        status: "waiting",
        startedAt: now,
        inputDigest: proposalDigest,
        detail: { workflowInstanceId: instance.id, gates: gated.name, action: gated.action },
      }));

    // Reuse the approval an earlier attempt already raised.
    //
    // Without this, resuming a gate after a restart would put a second request
    // for the same decision on the approvers' queue — and two live approvals
    // for one proposal is how a rejected action gets performed anyway, by
    // redeeming the other one. The id is read back from the step row rather
    // than from the instance, because the row is written first and is therefore
    // the record that survives a crash between the two.
    const priorApprovalId = recorded.detail["approvalId"];
    const prior =
      typeof priorApprovalId === "string"
        ? await this.deps.approvals.get(priorApprovalId as Id<"approval">)
        : null;

    const approval =
      prior && prior.status === "pending"
        ? prior
        : await this.deps.approvals.request({
            action: gated.action,
            proposalDigest,
            summary: step.summary,
            requestedBy: instance.requestedBy,
            approvalsRequired: Math.max(1, descriptor.approvalsRequired),
            eligibleRoles: [...step.approverRoles],
            runId: instance.runId,
            correlationId: instance.correlationId,
            subject: { ...instance.subject, workflowInstanceId: instance.id, step: gated.name },
            ...(step.ttlMs === undefined ? {} : { ttlMs: step.ttlMs }),
          });

    if (approval.id !== priorApprovalId) {
      // A crash between raising the approval and recording its id would leave
      // one pending request nothing points at. It expires on its own rather
      // than authorising anything, because the gate only ever consumes the id
      // it recorded here.
      await this.deps.runs.patchStep(recorded.id, {
        detail: {
          workflowInstanceId: instance.id,
          gates: gated.name,
          action: gated.action,
          approvalId: approval.id,
        },
      });
    }

    await this.deps.runs.patchRun(instance.runId, { status: "awaiting_approval" });

    const applied = await this.mutate(instance.id, (current) => {
      const live = findToken(current, step.name);
      if (!live) return null;
      const next = withToken(current, {
        ...live,
        state: "waiting_approval",
        stepId: recorded.id,
        approvalId: approval.id,
        inFlightAttempt: undefined,
        claimedAt: undefined,
        wakeAt: undefined,
        waitingFor: `${step.approverRoles.join(" or ")} to approve: ${step.summary}`,
      });
      return { ...next, approvals: { ...next.approvals, [gated.name]: approval.id } };
    });
    return applied ?? (await this.deps.store.requireInstance(instance.id));
  }

  private async runWaitForEvent(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    step: WorkflowStep,
    token: StepToken,
  ): Promise<WorkflowInstance> {
    if (step.type !== "wait_for_event") throw new InvalidInputError("not a wait step", "type");
    const now = this.deps.clock.nowIso();

    // A due token at a wait step means the timeout fired rather than the event.
    if (token.state === "waiting_event") {
      if (token.stepId) {
        await this.deps.runs.patchStep(token.stepId, {
          status: step.onTimeout ? "skipped" : "failed",
          endedAt: now,
          error: `Timed out waiting for "${step.event}".`,
          detail: { workflowInstanceId: instance.id, timedOut: true },
        });
      }
      const onTimeout = step.onTimeout;
      if (onTimeout === undefined) {
        return await this.settleFailed(
          instance,
          definition,
          token,
          `Nothing signalled "${step.event}" before the deadline, and the definition declares nowhere to go on timeout.`,
        );
      }
      const applied = await this.mutate(instance.id, (current) => {
        const live = findToken(current, step.name);
        if (!live) return null;
        const outcome: StepOutcome = {
          stepName: step.name,
          status: "skipped",
          at: now,
          stepId: live.stepId,
          summary: `Timed out waiting for "${step.event}".`,
          costUsd: 0,
        };
        return this.advanceTo(current, live, outcome, onTimeout, now);
      });
      return applied ?? (await this.deps.store.requireInstance(instance.id));
    }

    const input = pickInputs(instance.context, step.inputs);
    const key = idempotencyKeyFor(instance.id, step.name, input);
    const existing = await this.deps.runs.findStepByIdempotencyKey(key);
    if (existing && existing.status === "succeeded") {
      return await this.skipAlreadyPerformed(instance, step, existing);
    }

    const recorded =
      existing ??
      (await this.deps.runs.appendStep({
        runId: instance.runId,
        kind: "wait_for_event",
        name: step.name,
        idempotencyKey: key,
        attempt: token.attempt,
        status: "waiting",
        startedAt: now,
        inputDigest: digestValue(input),
        detail: { workflowInstanceId: instance.id, event: step.event },
      }));

    const wakeAt =
      step.timeoutMs === undefined
        ? undefined
        : new Date(this.deps.clock.now() + step.timeoutMs).toISOString();

    const applied = await this.mutate(instance.id, (current) => {
      const live = findToken(current, step.name);
      if (!live) return null;
      return withToken(current, {
        ...live,
        state: "waiting_event",
        stepId: recorded.id,
        eventName: step.event,
        inFlightAttempt: undefined,
        claimedAt: undefined,
        wakeAt,
        waitingFor: `the signal "${step.event}"`,
      });
    });
    return applied ?? (await this.deps.store.requireInstance(instance.id));
  }

  private async runTimer(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    step: WorkflowStep,
    token: StepToken,
  ): Promise<WorkflowInstance> {
    if (step.type !== "timer") throw new InvalidInputError("not a timer", "type");
    const now = this.deps.clock.nowIso();

    // A due timer token means the wait is over.
    if (token.state === "waiting_timer") {
      if (token.stepId) {
        await this.deps.runs.patchStep(token.stepId, {
          status: "succeeded",
          endedAt: now,
          detail: { workflowInstanceId: instance.id, fired: true },
        });
      }
      const applied = await this.mutate(instance.id, (current) => {
        const live = findToken(current, step.name);
        if (!live) return null;
        const outcome: StepOutcome = {
          stepName: step.name,
          status: "succeeded",
          at: now,
          stepId: live.stepId,
          summary: `The wait ended at ${live.wakeAt ?? now}.`,
          costUsd: 0,
        };
        return this.advance(current, step, live, outcome, now);
      });
      return applied ?? (await this.deps.store.requireInstance(instance.id));
    }

    const scheduled = this.scheduleTimer(instance, step.schedule);
    const input = pickInputs(instance.context, step.inputs);
    const key = idempotencyKeyFor(instance.id, step.name, input);
    const existing = await this.deps.runs.findStepByIdempotencyKey(key);
    if (existing && existing.status === "succeeded") {
      return await this.skipAlreadyPerformed(instance, step, existing);
    }

    const recorded =
      existing ??
      (await this.deps.runs.appendStep({
        runId: instance.runId,
        kind: "timer",
        name: step.name,
        idempotencyKey: key,
        attempt: token.attempt,
        status: "waiting",
        startedAt: now,
        inputDigest: digestValue(input),
        detail: { workflowInstanceId: instance.id, firesAt: scheduled.firesAt, ...scheduled.detail },
      }));

    const applied = await this.mutate(instance.id, (current) => {
      const live = findToken(current, step.name);
      if (!live) return null;
      const contextKey = scheduled.contextKey;
      const context =
        contextKey === undefined
          ? current.context
          : mergeContext(
              current.context,
              { [contextKey]: scheduled.deadlineInstant ?? scheduled.firesAt },
              `Timer ${step.name}`,
            );
      return withToken(
        { ...current, context },
        {
          ...live,
          state: "waiting_timer",
          stepId: recorded.id,
          inFlightAttempt: undefined,
          claimedAt: undefined,
          wakeAt: scheduled.firesAt,
          waitingFor: scheduled.waitingFor,
        },
      );
    });
    return applied ?? (await this.deps.store.requireInstance(instance.id));
  }

  /**
   * Work out when a timer fires.
   *
   * `duration` is ordinary elapsed time and is computed here. The statutory
   * case is not computed here at all: it is asked of `timeline/`, the only
   * place in this platform allowed to turn a statute into a date. That module
   * knows about counting bases, trigger events, weekend rolls, holidays, and
   * the timezone the clock actually runs in — which is why a ten-day window on
   * a contract signed in late October closes an hour later in UTC than the same
   * window in June, and why doing this with `+ 10 * DAY` is wrong in a way
   * nobody notices until a timely cancellation is refused.
   */
  private scheduleTimer(
    instance: WorkflowInstance,
    schedule: TimerSchedule,
  ): {
    readonly firesAt: IsoTimestamp;
    readonly waitingFor: string;
    readonly detail: Record<string, string | number | boolean>;
    readonly contextKey?: string | undefined;
    readonly deadlineInstant?: IsoTimestamp | undefined;
  } {
    if (schedule.kind === "duration") {
      const firesAt = new Date(this.deps.clock.now() + schedule.ms).toISOString();
      return {
        firesAt,
        waitingFor: `a scheduled wait of ${Math.round(schedule.ms / 1000)}s, ending ${firesAt}`,
        detail: { basis: "duration", durationMs: schedule.ms },
      };
    }

    const stateCode = instance.context[schedule.stateCodeKey];
    const executedAt = instance.context[schedule.executedAtKey];
    const deliveredAt =
      schedule.deliveredAtKey === undefined ? undefined : instance.context[schedule.deliveredAtKey];

    if (typeof stateCode !== "string" || typeof executedAt !== "string") {
      throw new DeniedError(
        "knowledge.no_grounding",
        `A statutory timer needs "${schedule.stateCodeKey}" and "${schedule.executedAtKey}" in the workflow context. Without them there is no deadline to compute, and a guessed deadline is worse than none: no deadline gets escalated, a wrong one gets relied on.`,
        { stateCodeKey: schedule.stateCodeKey, executedAtKey: schedule.executedAtKey },
      );
    }

    const computation = computeRescissionDeadline(
      {
        stateCode,
        contractExecutedAt: executedAt,
        documentsDeliveredAt: typeof deliveredAt === "string" ? deliveredAt : undefined,
      },
      {
        clock: this.deps.clock,
        rules: this.deps.timeline?.rules,
        holidayCalendars: this.deps.timeline?.holidayCalendars,
        requireVerifiedRules:
          schedule.requireVerifiedRule ?? this.deps.timeline?.requireVerifiedRules,
      },
    );

    const offsetMs = schedule.offsetMs ?? 0;
    const firesAt = new Date(Date.parse(computation.deadlineInstant) + offsetMs).toISOString();

    return {
      firesAt,
      deadlineInstant: computation.deadlineInstant,
      contextKey: schedule.deadlineContextKey,
      waitingFor:
        offsetMs === 0
          ? `the ${computation.jurisdiction} rescission deadline at ${computation.deadlineInstant}`
          : `${Math.abs(Math.round(offsetMs / 3_600_000))}h ${offsetMs < 0 ? "before" : "after"} the ${computation.jurisdiction} rescission deadline of ${computation.deadlineInstant}`,
      detail: {
        basis: "statutory_rescission",
        jurisdiction: computation.jurisdiction,
        ruleVersion: computation.ruleVersion,
        ruleVerified: computation.ruleVerified,
        deadlineInstant: computation.deadlineInstant,
        deadlineLocalDate: computation.deadlineLocalDate,
        utcOffsetAtDeadline: computation.utcOffsetAtDeadline,
        offsetMs,
      },
    };
  }

  private async runBranch(
    instance: WorkflowInstance,
    _definition: WorkflowDefinition,
    step: WorkflowStep,
    token: StepToken,
  ): Promise<WorkflowInstance> {
    if (step.type !== "branch") throw new InvalidInputError("not a branch", "type");
    const now = this.deps.clock.nowIso();
    const choice = chooseBranch(step, instance.context);
    const input = pickInputs(instance.context, step.inputs);

    const recorded = await this.deps.runs.appendStep({
      runId: instance.runId,
      kind: "branch",
      name: step.name,
      idempotencyKey: idempotencyKeyFor(instance.id, step.name, input),
      attempt: token.attempt,
      status: "succeeded",
      startedAt: now,
      endedAt: now,
      inputDigest: digestValue(input),
      detail: {
        workflowInstanceId: instance.id,
        chose: choice.next,
        because: choice.reason.slice(0, 400),
      },
    });

    const applied = await this.mutate(instance.id, (current) => {
      const live = findToken(current, step.name);
      if (!live) return null;
      const outcome: StepOutcome = {
        stepName: step.name,
        status: "succeeded",
        at: now,
        stepId: recorded.id,
        summary: `Took the "${choice.label}" path because ${choice.reason}`,
        costUsd: 0,
      };
      return this.advanceTo(current, live, outcome, choice.next, now);
    });
    return applied ?? (await this.deps.store.requireInstance(instance.id));
  }

  private async runParallel(
    instance: WorkflowInstance,
    _definition: WorkflowDefinition,
    step: WorkflowStep,
    token: StepToken,
  ): Promise<WorkflowInstance> {
    if (step.type !== "parallel") throw new InvalidInputError("not a fan-out", "type");
    const now = this.deps.clock.nowIso();
    const input = pickInputs(instance.context, step.inputs);

    const recorded = await this.deps.runs.appendStep({
      runId: instance.runId,
      kind: "parallel",
      name: step.name,
      idempotencyKey: idempotencyKeyFor(instance.id, step.name, input),
      attempt: token.attempt,
      status: "succeeded",
      startedAt: now,
      endedAt: now,
      inputDigest: digestValue(input),
      detail: {
        workflowInstanceId: instance.id,
        branches: step.branches.join(","),
        joinsAt: step.next,
      },
    });

    const applied = await this.mutate(instance.id, (current) => {
      const live = findToken(current, step.name);
      if (!live) return null;
      const outcome: StepOutcome = {
        stepName: step.name,
        status: "succeeded",
        at: now,
        stepId: recorded.id,
        summary: `Started ${step.branches.length} paths in parallel; they join at "${step.next}".`,
        costUsd: 0,
      };
      let next = appendHistory(withoutToken(current, step.name), outcome);
      next = {
        ...next,
        barriers: [
          ...next.barriers,
          {
            id: step.name,
            next: step.next,
            expected: step.branches.length,
            arrived: 0,
            parentBarrierId: live.barrierId,
          },
        ],
      };
      for (const head of step.branches) {
        next = withToken(next, {
          stepName: head,
          state: "ready",
          attempt: 1,
          enteredAt: now,
          barrierId: step.name,
        });
      }
      return next;
    });
    return applied ?? (await this.deps.store.requireInstance(instance.id));
  }

  // --- transitions -------------------------------------------------------

  /** Move a token past a completed step to whatever the definition says is next. */
  private advance(
    current: WorkflowInstance,
    step: WorkflowStep | undefined,
    token: StepToken,
    outcome: StepOutcome,
    at: IsoTimestamp,
  ): WorkflowInstance {
    return this.advanceTo(current, token, outcome, step?.next, at);
  }

  private advanceTo(
    current: WorkflowInstance,
    token: StepToken,
    outcome: StepOutcome,
    next: string | undefined,
    at: IsoTimestamp,
  ): WorkflowInstance {
    const withHistory = appendHistory(withoutToken(current, token.stepName), outcome);

    if (next !== undefined) {
      return withToken(withHistory, {
        stepName: next,
        state: "ready",
        attempt: 1,
        enteredAt: at,
        barrierId: token.barrierId,
      });
    }

    // The path ends here. Inside a fan-out that is how a branch reports to the
    // join; outside one it means this path is simply finished.
    if (token.barrierId !== undefined) {
      return arriveAtBarrier(withHistory, token.barrierId, at).instance;
    }
    return withHistory;
  }

  /**
   * Finish a compensation step and move to the next thing to undo.
   *
   * The forward step it compensated is marked in the history, so a second
   * failure during the unwind cannot queue the same compensation twice.
   */
  private completeCompensation(
    current: WorkflowInstance,
    step: WorkflowStep,
    outcome: StepOutcome,
    at: IsoTimestamp,
  ): WorkflowInstance {
    const forward = this.forwardStepCompensatedBy(current, step.name);
    let next = appendHistory(withoutToken(current, step.name), outcome);
    if (forward !== undefined) {
      next = appendHistory(next, {
        stepName: forward,
        status: "compensated",
        at,
        summary: `Undone by "${step.name}".`,
        costUsd: 0,
      });
    }

    const remaining = next.compensationQueue.filter((name) => name !== step.name);
    next = { ...next, compensationQueue: remaining };
    const head = remaining[0];
    if (head !== undefined) {
      next = withToken(next, { stepName: head, state: "ready", attempt: 1, enteredAt: at });
    } else {
      next = { ...next, endedAt: at };
    }
    return next;
  }

  private forwardStepCompensatedBy(
    instance: WorkflowInstance,
    compensationStep: string,
  ): string | undefined {
    if (!this.deps.catalogue.has(instance.definitionName, instance.definitionVersion)) {
      return undefined;
    }
    const definition = this.deps.catalogue.require(
      instance.definitionName,
      instance.definitionVersion,
    );
    return definition.steps.find((step) => step.compensation === compensationStep)?.name;
  }

  /**
   * Start unwinding.
   *
   * Live paths are dropped and the compensating actions queued in reverse order
   * of completion. When there is nothing to undo, the instance lands in its
   * terminal state immediately.
   */
  private beginUnwind(
    current: WorkflowInstance,
    definition: WorkflowDefinition,
    at: IsoTimestamp,
  ): WorkflowInstance {
    const queue = buildCompensationQueue(definition, current.history);
    const cleared: WorkflowInstance = { ...current, tokens: [], barriers: [] };
    const head = queue[0];
    if (head === undefined) {
      return { ...cleared, compensationQueue: [], endedAt: at };
    }
    return withToken(
      { ...cleared, compensationQueue: queue },
      { stepName: head, state: "ready", attempt: 1, enteredAt: at },
    );
  }

  private async settleDenied(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    token: StepToken,
    error: DeniedError,
  ): Promise<WorkflowInstance> {
    const at = this.deps.clock.nowIso();
    const isCompensation = this.isCompensationStep(definition, token.stepName);

    const applied = await this.mutate(instance.id, (current) => {
      if (isTerminalInstanceStatus(current.status)) return null;
      const outcome: StepOutcome = {
        stepName: token.stepName,
        status: "denied",
        at,
        stepId: token.stepId,
        summary: error.message,
        costUsd: 0,
      };
      const withOutcome = appendHistory(withoutToken(current, token.stepName), outcome);

      // A refused compensation step is the end of the line. Re-queueing the
      // unwind would rebuild the same queue from the same history and refuse
      // again, spinning until the transition budget ran out and leaving a case
      // that looks busy rather than blocked.
      if (isCompensation) {
        return {
          ...withOutcome,
          tokens: [],
          barriers: [],
          compensationQueue: [],
          terminalStatus: "denied" as const,
          denialReason: error.reason,
          stuckReason: `The unwind was refused: ${error.message} The world may be left part-way through this workflow. Release whatever refused it and start the compensating action by hand.`,
          endedAt: at,
        };
      }

      return this.beginUnwind(
        {
          ...withOutcome,
          terminalStatus: "denied",
          denialReason: error.reason,
          stuckReason: error.message,
        },
        definition,
        at,
      );
    });
    return applied ?? (await this.deps.store.requireInstance(instance.id));
  }

  private isCompensationStep(definition: WorkflowDefinition, stepName: string): boolean {
    return definition.steps.find((step) => step.name === stepName)?.type === "compensation";
  }

  private async settleFailed(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    token: StepToken,
    reason: string,
  ): Promise<WorkflowInstance> {
    const at = this.deps.clock.nowIso();

    // A compensation step that fails is the end of the line: the unwind itself
    // could not complete, so there is nothing further the platform can safely
    // do and the case needs a person.
    const isCompensation = this.isCompensationStep(definition, token.stepName);

    const applied = await this.mutate(instance.id, (current) => {
      if (isTerminalInstanceStatus(current.status)) return null;
      const outcome: StepOutcome = {
        stepName: token.stepName,
        status: "failed",
        at,
        stepId: token.stepId,
        summary: reason,
        costUsd: 0,
      };
      const withOutcome = appendHistory(withoutToken(current, token.stepName), outcome);
      if (isCompensation) {
        return {
          ...withOutcome,
          tokens: [],
          barriers: [],
          compensationQueue: [],
          terminalStatus: "failed" as const,
          failureReason: reason,
          stuckReason: `The unwind could not complete: ${reason} The world may be left part-way through this workflow and needs a person to check it.`,
          endedAt: at,
        };
      }
      return this.beginUnwind(
        { ...withOutcome, terminalStatus: "failed", failureReason: reason, stuckReason: reason },
        definition,
        at,
      );
    });
    return applied ?? (await this.deps.store.requireInstance(instance.id));
  }

  /**
   * Close the operating-record run and write the closing audit entry.
   *
   * Called after every transition and guarded by the run's own `endedAt`, so an
   * instance that fails, compensates, and only then reaches its terminal state
   * is recorded once, at the moment it is genuinely finished.
   */
  private async finalise(instance: WorkflowInstance): Promise<WorkflowInstance> {
    if (!isTerminalInstanceStatus(instance.status)) return instance;

    const run = await this.deps.runs.getRun(instance.runId);
    if (!run || run.endedAt !== undefined) return instance;

    const status = instance.status;
    const outcome =
      instance.failureReason ??
      instance.stuckReason ??
      (status === "succeeded" ? "Completed every step." : `Ended as ${status}.`);

    await this.deps.runs.patchRun(instance.runId, {
      status,
      endedAt: this.deps.clock.nowIso(),
      outcome: outcome.slice(0, 1000),
      ...(instance.denialReason ? { denialReason: instance.denialReason } : {}),
      outputDigest: digestValue(instance.context),
    });
    this.deps.ceilings.markRunEnded(instance.runId);

    await this.deps.audit.record(
      auditDecision({
        eventType: "workflow.instance_ended",
        actorId: instance.requestedBy.actorId,
        actorKind: instance.requestedBy.kind,
        actorRoles: instance.requestedBy.roles,
        runId: instance.runId,
        correlationId: instance.correlationId,
        subject: {
          workflowInstanceId: instance.id,
          workflow: instance.definitionName,
          version: String(instance.definitionVersion),
        },
        inputDigests: { context: digestValue(instance.context) },
        decision: {
          status,
          stage: "settled",
          steps: instance.history.length,
          ...(instance.denialReason ? { reason: instance.denialReason } : {}),
        },
      }),
    );

    return instance;
  }

  private proposalDigestFor(
    instanceId: string,
    stepName: string,
    input: WorkflowContext,
  ): string {
    return digestValue({ workflowInstanceId: instanceId, step: stepName, input });
  }

  private async recordStepAudit(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    step: WorkflowStep,
    stepId: Id<"step">,
    digests: Readonly<Record<string, string>>,
    detail: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    await this.deps.audit.record(
      auditDecision({
        eventType: "step.recorded",
        actorId: instance.requestedBy.actorId,
        actorKind: instance.requestedBy.kind,
        actorRoles: instance.requestedBy.roles,
        runId: instance.runId,
        correlationId: instance.correlationId,
        subject: {
          workflowInstanceId: instance.id,
          workflow: definition.name,
          step: step.name,
          stepId,
        },
        inputDigests: digests,
        decision: { kind: step.type, ...detail },
      }),
    );
  }

  /**
   * Raise the escalation level on open tasks that have aged past their target.
   *
   * Idempotent by construction: a task's level only moves up, and only to the
   * level the elapsed time has actually earned. Running the sweep twice in the
   * same minute escalates nothing twice.
   */
  private async escalateOverdueTasks(now: IsoTimestamp): Promise<number> {
    const overdue = await this.deps.store.listHumanTasks({
      status: ["open"],
      breachedAsOf: now,
      limit: 200,
    });
    let escalated = 0;

    for (const task of overdue) {
      if (task.dueAt === undefined) continue;

      let definition: WorkflowDefinition;
      try {
        const instance = await this.deps.store.getInstance(task.instanceId);
        if (!instance) continue;
        definition = this.deps.catalogue.require(
          instance.definitionName,
          instance.definitionVersion,
        );
      } catch (error) {
        // allow-swallow: a task whose definition has gone missing still belongs
        // on the breach queue — `breachedTasks` reports it from `dueAt` alone.
        // What cannot be done is work out which escalation rule applies, so the
        // level is left where it is rather than guessed at. Nothing proceeds
        // here that would otherwise have been refused.
        if (error instanceof DeniedError) continue;
        throw error;
      }

      const step = definition.steps.find((candidate) => candidate.name === task.stepName);
      const escalations = step?.sla?.escalations ?? [];
      if (escalations.length === 0) continue;

      const dueMs = Date.parse(task.dueAt);
      const nowMs = Date.parse(now);
      let level = 0;
      for (const rule of escalations) {
        if (nowMs >= dueMs + rule.afterMs) level += 1;
      }
      if (level <= task.escalationLevel) continue;

      const rule = escalations[level - 1];
      if (!rule) continue;

      await this.deps.store.patchHumanTask(task.id, {
        escalationLevel: level,
        escalatedAt: now,
        escalatedToRoles: [...rule.notifyRoles],
        escalationNote: rule.note,
      });
      await this.deps.runs.patchStep(task.id, {
        detail: {
          workflowInstanceId: task.instanceId,
          title: task.title,
          slaBreached: true,
          escalationLevel: level,
          escalatedTo: rule.notifyRoles.join(","),
        },
      });
      // The audit vocabulary has no dedicated SLA event, so the escalation is
      // recorded as a fact about the step it belongs to. Keeping it in the
      // chain is what matters: a breach that only ever appeared on a screen
      // would leave no evidence that anyone was told.
      await this.deps.audit.record(
        auditDecision({
          eventType: "step.recorded",
          actorId: "system",
          actorKind: "system",
          runId: task.runId,
          subject: {
            workflowInstanceId: task.instanceId,
            workflow: task.workflowName,
            step: task.stepName,
          },
          decision: {
            kind: "sla_escalation",
            level,
            dueAt: task.dueAt,
            notified: rule.notifyRoles.join(","),
          },
        }),
      );
      escalated += 1;
    }

    return escalated;
  }
}
