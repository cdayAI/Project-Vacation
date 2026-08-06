import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";

/**
 * The shapes stored in the operating record.
 *
 * The operating record is the platform's single source of truth for "what did
 * this system do". Every other capability reads from it: the console renders
 * it, the audit view evidences it, the improvement loop mines it, and the cost
 * report sums it.
 *
 * Two conventions run through every type here.
 *
 * Timestamps are ISO-8601 strings in UTC, never `Date` objects. They cross a
 * process boundary into JSON and a database and back, and a string that is
 * already in its wire form cannot be silently reinterpreted in a local
 * timezone on the way through.
 *
 * Payloads are stored as digests, not contents. `inputDigest` proves which
 * input a step saw without the record becoming a second copy of owner data —
 * which matters for retention, for subject-rights deletion, and for keeping
 * the audit surface small enough to actually review.
 */

export type IsoTimestamp = string;

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_human"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "denied";

/** Terminal states. A run in one of these will never change again. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "denied",
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * How the platform was operating when this run executed.
 *
 * These are the rungs of the rollout ladder. They are a real mode in the
 * product rather than a label: `shadow` runs must never produce an external
 * effect, and the authorization chokepoint enforces that.
 */
export type OperatingMode = "shadow" | "assisted" | "supervised" | "bounded_autonomy";

export const OPERATING_MODES: readonly OperatingMode[] = [
  "shadow",
  "assisted",
  "supervised",
  "bounded_autonomy",
];

/** Who or what initiated something. */
export interface ActorRef {
  readonly actorId: string;
  /** `human` covers console users; `service` covers machine callers. */
  readonly kind: "human" | "service" | "system";
  /** Directory-provisioned role names held at the time of the action. */
  readonly roles: readonly string[];
}

/**
 * A unit of work.
 *
 * "What was requested, who or what owned it, every step, what it cost, how it
 * ended" — this record and its steps are that sentence, made queryable.
 */
export interface Run {
  readonly id: Id<"run">;
  /** Stable machine name for the kind of work, e.g. `rescission.verify`. */
  readonly kind: string;
  readonly status: RunStatus;
  readonly mode: OperatingMode;
  readonly requestedBy: ActorRef;
  /**
   * What the run is about, as an opaque reference rather than owner data —
   * e.g. `{ contractId: "ctr_..." }`. Never a name, address, or account number.
   */
  readonly subject: Record<string, string>;
  readonly correlationId: string;
  readonly workflowInstanceId?: Id<"workflowInstance"> | undefined;
  readonly roleId?: Id<"role"> | undefined;
  readonly roleVersion?: number | undefined;
  readonly createdAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp | undefined;
  readonly endedAt?: IsoTimestamp | undefined;
  /** Free-text outcome summary for an operator. Redacted before storage. */
  readonly outcome?: string | undefined;
  /** Set when the run ended in `denied`; the machine-readable denial reason. */
  readonly denialReason?: string | undefined;
  readonly inputDigest?: Digest | undefined;
  readonly outputDigest?: Digest | undefined;
}

export type NewRun = Omit<Run, "id" | "createdAt" | "status"> & {
  readonly id?: Id<"run">;
  readonly status?: RunStatus;
};

export type RunPatch = Partial<
  Pick<
    Run,
    "status" | "startedAt" | "endedAt" | "outcome" | "denialReason" | "outputDigest" | "mode"
  >
>;

export type StepKind =
  | "automated_action"
  | "model_call"
  | "human_task"
  | "approval_gate"
  | "wait_for_event"
  | "timer"
  | "branch"
  | "parallel"
  | "compensation"
  | "retrieval"
  | "integration_call"
  | "document_generation"
  | "outbound_message";

export const STEP_KINDS: readonly StepKind[] = [
  "automated_action",
  "model_call",
  "human_task",
  "approval_gate",
  "wait_for_event",
  "timer",
  "branch",
  "parallel",
  "compensation",
  "retrieval",
  "integration_call",
  "document_generation",
  "outbound_message",
];

export type StepStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "compensated"
  | "denied";

/** One step of a run. Steps are append-only in spirit: they are never deleted. */
export interface Step {
  readonly id: Id<"step">;
  readonly runId: Id<"run">;
  /** Monotonic within a run, assigned by the store so concurrent writers cannot collide. */
  readonly seq: number;
  readonly kind: StepKind;
  /** Stable machine name of the step within its workflow definition. */
  readonly name: string;
  readonly status: StepStatus;
  /**
   * Deduplication key for external effects.
   *
   * The engine derives this from (instance, step, attempt-invariant inputs) so
   * that a retry after a crash reuses the same key and the effect happens once.
   */
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp | undefined;
  readonly inputDigest?: Digest | undefined;
  readonly outputDigest?: Digest | undefined;
  readonly error?: string | undefined;
  readonly denialReason?: string | undefined;
  /** Non-sensitive detail an operator needs to understand the step. */
  readonly detail: Record<string, string | number | boolean>;
}

export type NewStep = Omit<Step, "id" | "seq" | "startedAt" | "status" | "attempt"> & {
  readonly id?: Id<"step">;
  readonly seq?: number;
  readonly startedAt?: IsoTimestamp;
  readonly status?: StepStatus;
  readonly attempt?: number;
};

export type StepPatch = Partial<
  Pick<Step, "status" | "endedAt" | "outputDigest" | "error" | "denialReason" | "detail">
>;

export type CostCategory = "model" | "integration" | "storage" | "compute" | "human";

/**
 * A unit of spend.
 *
 * "MVW will ask what a resolved case costs; have the number." Cost is recorded
 * per step so it aggregates cleanly by run, by workflow, by role, and by
 * department without a second accounting system.
 */
export interface CostEntry {
  readonly runId: Id<"run">;
  readonly stepId?: Id<"step"> | undefined;
  readonly category: CostCategory;
  readonly amountUsd: number;
  /** Free-form unit count, e.g. tokens or API calls, for unit-cost reporting. */
  readonly units?: number | undefined;
  /** Model identifier when `category` is `model`; resolved from the inventory. */
  readonly modelId?: string | undefined;
  readonly recordedAt: IsoTimestamp;
  readonly detail?: Record<string, string | number> | undefined;
}

export interface RunFilter {
  readonly status?: readonly RunStatus[];
  readonly kind?: string;
  readonly mode?: OperatingMode;
  readonly workflowInstanceId?: Id<"workflowInstance">;
  readonly roleId?: Id<"role">;
  readonly requestedByActorId?: string;
  readonly createdAfter?: IsoTimestamp;
  readonly createdBefore?: IsoTimestamp;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CostSummary {
  readonly totalUsd: number;
  readonly byCategory: Readonly<Record<string, number>>;
}
