import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, CostCategory, IsoTimestamp, OperatingMode } from "../record/types.js";

/**
 * The workflow engine's domain types.
 *
 * A workflow here is two separate things that are deliberately kept apart.
 *
 * A *definition* is a declarative artifact in source control: a name, an integer
 * version, the operating mode it was approved for, and an ordered set of steps.
 * It contains no code. It is reviewed as a diff, and once a version is published
 * it never changes — a correction is a new version. That is what makes "which
 * rules governed this case in March" answerable at all.
 *
 * An *instance* is one execution of one version. It pins the version it started
 * under, so publishing a new definition while work is in flight cannot alter
 * what that work does. It carries its own durable state — where it is, what it
 * is waiting for, what it has already done — because the exit gate for this
 * module is that a deploy in the middle of a case does not lose the case.
 *
 * Three conventions, inherited from the operating record and restated here
 * because every type below obeys them:
 *
 *   - Timestamps are ISO-8601 UTC strings, never `Date`.
 *   - Anything that crosses into the audit log is a digest or an opaque
 *     reference, never a payload.
 *   - Context values are scalars only. A workflow's working memory is a set of
 *     references — a contract id, a state code, a boolean finding — and never a
 *     copy of owner data, because the instance row outlives the case.
 */

/**
 * The step vocabulary.
 *
 * Closed and explicit. A new kind of step is a change to this union and to the
 * validator, which is the point: an engine that accepted "some other kind of
 * step" would be a function dispatcher with extra steps, and the reviewability
 * of the definitions is most of the value here.
 */
export type WorkflowStepType =
  /** Produces an external effect through a registered action. */
  | "automated_action"
  /** Invokes a model through a registered action. Costs money, changes nothing. */
  | "model_call"
  /** Parks the instance on a person's queue, with an SLA and escalation. */
  | "human_task"
  /** Raises an approval bound to a named later step, and waits for a decision. */
  | "approval_gate"
  /** Waits for a named external signal. */
  | "wait_for_event"
  /** Waits until an instant, which may be a statutory deadline. */
  | "timer"
  /** Chooses one of several declared paths from the instance context. */
  | "branch"
  /** Fans out into several paths and joins when all of them finish. */
  | "parallel"
  /** Undoes an earlier step. Reached only through the compensation path. */
  | "compensation";

export const WORKFLOW_STEP_TYPES: readonly WorkflowStepType[] = [
  "automated_action",
  "model_call",
  "human_task",
  "approval_gate",
  "wait_for_event",
  "timer",
  "branch",
  "parallel",
  "compensation",
];

/** Step types that produce an effect and therefore pass the authorization chokepoint. */
export const EFFECTING_STEP_TYPES: readonly WorkflowStepType[] = [
  "automated_action",
  "model_call",
  "compensation",
];

export function isEffectingStepType(type: WorkflowStepType): boolean {
  return EFFECTING_STEP_TYPES.includes(type);
}

/**
 * A value a workflow may carry between steps.
 *
 * Scalars only, and small ones. Widening this to arbitrary objects would make
 * the instance row a convenient place to stash owner data, which is precisely
 * what the operating record is designed not to become.
 */
export type ContextValue = string | number | boolean;
export type WorkflowContext = Readonly<Record<string, ContextValue>>;

/** How a branch case interrogates the context. */
export type ConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "absent"
  | "in";

/**
 * One declarative test against the instance context.
 *
 * Conditions are data rather than predicates for the same reason prompts are:
 * a reviewer has to be able to read the routing rule, and a rule expressed as a
 * function is invisible in a diff of the definition.
 */
export interface Condition {
  readonly key: string;
  readonly op: ConditionOperator;
  readonly value?: ContextValue | undefined;
  readonly values?: readonly ContextValue[] | undefined;
}

export interface BranchCase {
  /** Plain language for the console: "the cancellation arrived inside the window". */
  readonly label: string;
  readonly when: Condition;
  readonly next: string;
}

/**
 * When a timer fires.
 *
 * `duration` is ordinary elapsed time and may be computed arithmetically.
 * `statutory_rescission` is not: it is a legal deadline, and this platform
 * computes exactly one of those in exactly one place. The schedule therefore
 * names the context keys the timeline module needs and nothing else — the
 * engine never does date arithmetic on a statutory period, it asks.
 */
export type TimerSchedule =
  | { readonly kind: "duration"; readonly ms: number }
  | {
      readonly kind: "statutory_rescission";
      /** Context key holding the two-letter state code. */
      readonly stateCodeKey: string;
      /** Context key holding the contract execution instant. */
      readonly executedAtKey: string;
      /** Context key holding the document delivery instant, where the rule needs it. */
      readonly deliveredAtKey?: string | undefined;
      /**
       * Fire this far from the computed deadline. Negative fires before it,
       * which is the useful direction: a workflow that wakes on the deadline
       * has already missed it.
       */
      readonly offsetMs?: number | undefined;
      /** Refuse to schedule from a rule nobody has verified. */
      readonly requireVerifiedRule?: boolean | undefined;
      /**
       * Context key to record the computed deadline under.
       *
       * Later steps — a letter, a check, a decision — need the deadline itself
       * rather than the fact that a timer was set for it, and naming the key in
       * the definition keeps that dependency visible instead of implied.
       */
      readonly deadlineContextKey?: string | undefined;
    };

/**
 * Bounded retry with deterministic backoff.
 *
 * No jitter. Jitter needs randomness, the seeded demo must reproduce byte for
 * byte, and a jittered backoff in a single-instance engine solves a thundering
 * herd that does not exist here. When this engine is sharded across processes,
 * jitter belongs in the sweep's instance selection, not in a step's backoff.
 */
export interface RetryPolicy {
  /** Total attempts including the first. 1 means "do not retry". */
  readonly maxAttempts: number;
  readonly backoffMs: number;
  /** Multiplier applied per attempt. Defaults to 2. */
  readonly factor?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
}

/** What happens when a human task ages past its target. */
export interface EscalationRule {
  /** Measured from `dueAt`, not from creation. Zero escalates the moment it breaches. */
  readonly afterMs: number;
  readonly notifyRoles: readonly string[];
  /** What the escalation is for, in a sentence the recipient can act on. */
  readonly note: string;
}

export interface SlaPolicy {
  /** Target turnaround from the moment the task appears on the queue. */
  readonly targetMs: number;
  /** Applied in order. Later rules must have larger `afterMs`. */
  readonly escalations: readonly EscalationRule[];
}

/** Fields every step carries, whatever its type. */
export interface StepCommon {
  /** Unique within the definition. Appears in the operating record and the console. */
  readonly name: string;
  /** One sentence a supervisor can read. Rendered by `describeInstance`. */
  readonly description: string;
  /** The step this path continues to. Absent means this path ends here. */
  readonly next?: string | undefined;
  /** Registered action name. Required for every step that produces an effect. */
  readonly action?: string | undefined;
  /** Key resolved against the handler registry the deployment wires up. */
  readonly handler?: string | undefined;
  /**
   * True when the effect cannot be undone.
   *
   * Declaring this obliges the definition to put an approval gate in front of
   * the step and to declare a compensating action for everything downstream of
   * it. Both are enforced by `validateDefinition`.
   */
  readonly irreversible?: boolean | undefined;
  /** Name of the `compensation` step that undoes this one. */
  readonly compensation?: string | undefined;
  readonly retry?: RetryPolicy | undefined;
  readonly sla?: SlaPolicy | undefined;
  /** Pre-flight spend estimate, reserved against the run's ceiling. */
  readonly estimatedCostUsd?: number | undefined;
  /**
   * Context keys this step reads.
   *
   * These are the attempt-invariant inputs the idempotency key is derived from,
   * so declaring them is not documentation: a step that reads a key it did not
   * declare gets an idempotency key that does not describe what it actually did.
   */
  readonly inputs?: readonly string[] | undefined;
  /** Data scopes the acting identity must hold. Checked by the chokepoint. */
  readonly requiredScopes?: readonly string[] | undefined;
}

export interface AutomatedActionStep extends StepCommon {
  readonly type: "automated_action";
  readonly action: string;
  readonly handler: string;
}

export interface ModelCallStep extends StepCommon {
  readonly type: "model_call";
  readonly action: string;
  readonly handler: string;
}

export interface HumanTaskStep extends StepCommon {
  readonly type: "human_task";
  /** What the person is being asked to do. Shown on the queue. */
  readonly title: string;
  /** Roles that may claim and complete it. Empty would be an unassignable task. */
  readonly assignedRoles: readonly string[];
}

export interface ApprovalGateStep extends StepCommon {
  readonly type: "approval_gate";
  /** The later step this gate authorises. Its action is what gets approved. */
  readonly gates: string;
  readonly approverRoles: readonly string[];
  /** What the approver is agreeing to, in their words rather than the system's. */
  readonly summary: string;
  readonly ttlMs?: number | undefined;
}

export interface WaitForEventStep extends StepCommon {
  readonly type: "wait_for_event";
  readonly event: string;
  readonly timeoutMs?: number | undefined;
  /** Where to go when the timeout expires. Absent means the instance fails. */
  readonly onTimeout?: string | undefined;
}

export interface TimerStep extends StepCommon {
  readonly type: "timer";
  readonly schedule: TimerSchedule;
}

export interface BranchStep extends StepCommon {
  readonly type: "branch";
  readonly cases: readonly BranchCase[];
  /** Required. A branch that can match nothing is a path that stops silently. */
  readonly otherwise: string;
}

export interface ParallelStep extends StepCommon {
  readonly type: "parallel";
  /** Head step of each concurrent path. */
  readonly branches: readonly string[];
  /** Where the join continues once every branch has finished. */
  readonly next: string;
}

export interface CompensationStep extends StepCommon {
  readonly type: "compensation";
  readonly action: string;
  readonly handler: string;
}

export type WorkflowStep =
  | AutomatedActionStep
  | ModelCallStep
  | HumanTaskStep
  | ApprovalGateStep
  | WaitForEventStep
  | TimerStep
  | BranchStep
  | ParallelStep
  | CompensationStep;

/**
 * A versioned, declarative workflow definition.
 *
 * `version` is an integer rather than a semantic version because there is only
 * one meaningful question — is this the same behaviour the instance started
 * under — and a monotonically increasing integer answers it without anyone
 * having to agree what a minor change is.
 */
export interface WorkflowDefinition {
  /** Dotted lower_snake_case, e.g. `rescission.verify`. */
  readonly name: string;
  readonly version: number;
  readonly description: string;
  /** The operating mode this version was reviewed and approved for. */
  readonly mode: OperatingMode;
  /** Ordered. The first non-compensation step is where an instance starts. */
  readonly steps: readonly WorkflowStep[];
  /** Context keys a caller must supply before an instance may start. */
  readonly requiredContext?: readonly string[] | undefined;
}

/** A validation failure, with enough detail to fix it without reading the validator. */
export interface DefinitionProblem {
  readonly code: DefinitionProblemCode;
  readonly stepName?: string | undefined;
  readonly message: string;
}

export type DefinitionProblemCode =
  | "schema_invalid"
  | "duplicate_step_name"
  | "unknown_step_reference"
  | "unreachable_step"
  | "cycle_detected"
  | "irreversible_without_approval_gate"
  | "irreversible_without_downstream_compensation"
  | "compensation_not_referenced"
  | "compensation_target_wrong_type"
  | "compensation_in_forward_path"
  | "approval_gate_target_unreachable"
  | "parallel_branches_overlap"
  | "parallel_branch_reaches_join"
  | "start_step_missing"
  | "escalation_out_of_order";

// --- instance state -------------------------------------------------------

/**
 * Where one path through the workflow currently is.
 *
 * An instance holds a list of these rather than a single cursor, because a
 * `parallel` step produces several live paths and each waits for its own thing.
 * A token is the unit the engine claims before it acts, which is what stops two
 * processes executing the same step.
 */
export type TokenState =
  | "ready"
  | "running"
  | "waiting_human"
  | "waiting_approval"
  | "waiting_event"
  | "waiting_timer";

export interface StepToken {
  readonly stepName: string;
  readonly state: TokenState;
  /** 1-based. Incremented by a retry, not by a resume. */
  readonly attempt: number;
  readonly enteredAt: IsoTimestamp;
  /** When the current claim was taken. A claim older than the lease is reclaimable. */
  readonly claimedAt?: IsoTimestamp | undefined;
  /**
   * The attempt a process has already begun executing.
   *
   * Written when the token is claimed and read *before* the next claim. If it
   * already equals `attempt`, some earlier process started this exact attempt
   * and never recorded its outcome — which means nobody can say whether the
   * effect landed, and the only safe move is to stop rather than repeat it.
   */
  readonly inFlightAttempt?: number | undefined;
  /** When a `waiting_timer` token becomes ready. Also used for retry backoff. */
  readonly wakeAt?: IsoTimestamp | undefined;
  /** Plain language: "a supervisor to approve the letter". */
  readonly waitingFor?: string | undefined;
  /** The operating-record step this token opened, once it has one. */
  readonly stepId?: Id<"step"> | undefined;
  /** Barrier this token reports to when its path ends. */
  readonly barrierId?: string | undefined;
  /** Approval raised by an `approval_gate` token. */
  readonly approvalId?: Id<"approval"> | undefined;
  /** Event name a `wait_for_event` token is parked on. */
  readonly eventName?: string | undefined;
}

/**
 * A join point for a `parallel` fan-out.
 *
 * `expected` is fixed when the fan-out happens and `arrived` counts paths that
 * have finished. The join releases exactly once, when the two are equal, so a
 * branch that ends early cannot let the workflow run past the join.
 */
export interface JoinBarrier {
  /** The `parallel` step's name. Each step runs at most once per instance. */
  readonly id: string;
  readonly next: string;
  readonly expected: number;
  readonly arrived: number;
  /** Barrier the released token inherits, for nested fan-out. */
  readonly parentBarrierId?: string | undefined;
}

export type StepOutcomeStatus = "succeeded" | "failed" | "skipped" | "denied" | "compensated";

/** What one step did, kept on the instance so compensation can walk it backwards. */
export interface StepOutcome {
  readonly stepName: string;
  readonly status: StepOutcomeStatus;
  readonly at: IsoTimestamp;
  readonly stepId?: Id<"step"> | undefined;
  /** Plain language for the console. Never a payload. */
  readonly summary?: string | undefined;
  readonly costUsd: number;
}

export type InstanceStatus =
  | "running"
  | "waiting_human"
  | "waiting_approval"
  | "waiting_event"
  | "waiting_timer"
  | "compensating"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled";

/**
 * The four ways an instance can be finished.
 *
 * Named as their own type because they are also the run statuses the operating
 * record accepts, and the narrowing lets the compiler check that an instance
 * closing its run cannot pass a waiting state where an ending was required.
 */
export type TerminalInstanceStatus = "succeeded" | "failed" | "denied" | "cancelled";

export const TERMINAL_INSTANCE_STATUSES: readonly TerminalInstanceStatus[] = [
  "succeeded",
  "failed",
  "denied",
  "cancelled",
];

export function isTerminalInstanceStatus(
  status: InstanceStatus,
): status is TerminalInstanceStatus {
  return (TERMINAL_INSTANCE_STATUSES as readonly InstanceStatus[]).includes(status);
}

/**
 * One running workflow.
 *
 * Everything needed to resume is here: which version governs, where every live
 * path is, what has already happened, and what is left to unwind. A new engine
 * over the same store reads this row and continues; nothing is held in the
 * process that dies.
 */
export interface WorkflowInstance {
  readonly id: Id<"workflowInstance">;
  readonly definitionName: string;
  /** Pinned at start. A later version cannot change this instance's behaviour. */
  readonly definitionVersion: number;
  /** Content digest of the pinned version, so a silent edit is detected. */
  readonly definitionDigest: Digest;
  readonly status: InstanceStatus;
  readonly mode: OperatingMode;
  readonly runId: Id<"run">;
  readonly correlationId: string;
  readonly requestedBy: ActorRef;
  readonly subject: Readonly<Record<string, string>>;
  readonly context: WorkflowContext;
  readonly tokens: readonly StepToken[];
  readonly barriers: readonly JoinBarrier[];
  readonly history: readonly StepOutcome[];
  /** Compensation steps still to run, in the order they must run. */
  readonly compensationQueue: readonly string[];
  /** Approvals raised per gated step name, so the gated step can present one. */
  readonly approvals: Readonly<Record<string, string>>;
  /**
   * How this instance will end once the unwind, if any, has finished.
   *
   * Decided at the moment the engine gives up — a denial, a failure, an
   * operator cancellation — and applied when the last compensation completes.
   * Without it, an instance that fails and then compensates successfully would
   * report itself as having succeeded, which is the opposite of the truth.
   */
  readonly terminalStatus?: TerminalInstanceStatus | undefined;
  /** Optimistic-concurrency token. Every save advances it by one. */
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp | undefined;
  /** Earliest `wakeAt` across live tokens. Denormalised so the sweep can index it. */
  readonly wakeAt?: IsoTimestamp | undefined;
  /** Why the instance is not moving, in language a supervisor can act on. */
  readonly stuckReason?: string | undefined;
  readonly denialReason?: string | undefined;
  readonly failureReason?: string | undefined;
}

export interface InstanceFilter {
  readonly definitionName?: string | undefined;
  readonly status?: readonly InstanceStatus[] | undefined;
  readonly runId?: Id<"run"> | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

// --- human work -----------------------------------------------------------

export type HumanTaskStatus = "open" | "completed" | "cancelled";

/**
 * A unit of human work, on a queue.
 *
 * Identified by the operating-record step it belongs to rather than by an id of
 * its own. The queue and the record are then the same fact seen from two sides,
 * and "which step is this person blocking" needs no join table.
 */
export interface HumanTask {
  readonly id: Id<"step">;
  readonly instanceId: Id<"workflowInstance">;
  readonly runId: Id<"run">;
  readonly workflowName: string;
  readonly stepName: string;
  readonly title: string;
  readonly assignedRoles: readonly string[];
  readonly status: HumanTaskStatus;
  readonly createdAt: IsoTimestamp;
  /** Absent when the step declared no SLA; such a task can never breach. */
  readonly dueAt?: IsoTimestamp | undefined;
  /** 0 = never escalated. Each rule that fires raises it by one. */
  readonly escalationLevel: number;
  readonly escalatedAt?: IsoTimestamp | undefined;
  readonly escalatedToRoles: readonly string[];
  readonly escalationNote?: string | undefined;
  readonly completedAt?: IsoTimestamp | undefined;
  readonly completedBy?: string | undefined;
  readonly outcome?: string | undefined;
  readonly subject: Readonly<Record<string, string>>;
}

export type HumanTaskPatch = Partial<
  Pick<
    HumanTask,
    | "status"
    | "escalationLevel"
    | "escalatedAt"
    | "escalatedToRoles"
    | "escalationNote"
    | "completedAt"
    | "completedBy"
    | "outcome"
  >
>;

export interface HumanTaskFilter {
  readonly instanceId?: Id<"workflowInstance"> | undefined;
  readonly workflowName?: string | undefined;
  readonly status?: readonly HumanTaskStatus[] | undefined;
  /** Tasks any of these roles may act on. */
  readonly roles?: readonly string[] | undefined;
  /** Only open tasks whose `dueAt` is at or before this instant. */
  readonly breachedAsOf?: IsoTimestamp | undefined;
  readonly limit?: number | undefined;
}

/** True when an open task has passed its target. */
export function isTaskBreached(task: HumanTask, now: IsoTimestamp): boolean {
  return task.status === "open" && task.dueAt !== undefined && now > task.dueAt;
}

// --- execution ------------------------------------------------------------

/** What a step handler is given. Deliberately narrow: no store, no authorizer. */
export interface StepHandlerContext {
  readonly instanceId: Id<"workflowInstance">;
  readonly runId: Id<"run">;
  readonly stepId: Id<"step">;
  readonly workflowName: string;
  readonly stepName: string;
  readonly attempt: number;
  readonly mode: OperatingMode;
  /** Only the keys the step declared in `inputs`. */
  readonly input: WorkflowContext;
  readonly subject: Readonly<Record<string, string>>;
  readonly correlationId: string;
  /** The idempotency key under which this effect is recorded. */
  readonly idempotencyKey: string;
}

/** What a handler reports back. Scalars and money; never a payload. */
export interface StepHandlerResult {
  /** Merged into the instance context for later steps to read. */
  readonly output?: WorkflowContext | undefined;
  readonly costUsd?: number | undefined;
  readonly costCategory?: CostCategory | undefined;
  readonly units?: number | undefined;
  readonly modelId?: string | undefined;
  /** One sentence for the console: "checked 3 contracts, 1 inside the window". */
  readonly summary?: string | undefined;
}

export type StepHandler = (context: StepHandlerContext) => Promise<StepHandlerResult>;

/** What `describeInstance` hands a supervisor. Every field is plain language. */
export interface InstanceDescription {
  readonly instanceId: string;
  readonly workflow: string;
  readonly version: number;
  readonly status: InstanceStatus;
  /** One sentence covering where it is and whether anyone need do anything. */
  readonly headline: string;
  /** Where each live path is, one line each. */
  readonly where: readonly string[];
  /** What it is waiting on, if anything. */
  readonly waitingFor: readonly string[];
  /** Why it is not moving, when it is not moving on its own. */
  readonly stuckReason?: string | undefined;
  /** What a person should do next. "Nothing" is a valid and common answer. */
  readonly nextAction: string;
  readonly costUsd: number;
  readonly costByCategory: Readonly<Record<string, number>>;
  readonly startedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp | undefined;
  readonly elapsedMs: number;
  readonly stepsCompleted: readonly {
    readonly step: string;
    readonly description: string;
    readonly status: StepOutcomeStatus;
    readonly at: IsoTimestamp;
    readonly summary?: string | undefined;
  }[];
  readonly openTasks: readonly {
    readonly taskId: string;
    readonly step: string;
    readonly title: string;
    readonly roles: readonly string[];
    readonly dueAt?: IsoTimestamp | undefined;
    readonly breached: boolean;
    readonly escalationLevel: number;
  }[];
  readonly timers: readonly {
    readonly step: string;
    readonly firesAt: IsoTimestamp;
    readonly basis: string;
  }[];
}
