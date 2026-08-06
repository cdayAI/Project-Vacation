import { digestValue } from "../kernel/hash.js";
import { InvalidInputError } from "../kernel/errors.js";
import { containsSecret } from "../kernel/redact.js";
import type { IsoTimestamp } from "../record/types.js";
import type {
  BranchStep,
  Condition,
  ContextValue,
  InstanceStatus,
  JoinBarrier,
  RetryPolicy,
  StepOutcome,
  StepToken,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowInstance,
} from "./types.js";
import { TERMINAL_INSTANCE_STATUSES } from "./types.js";

/**
 * Instance state, as pure functions.
 *
 * Everything the engine does to an instance happens here, on plain values, with
 * no store and no clock reading of its own. That separation is not tidiness: it
 * is what makes the resume path testable. A resumed instance is a row read back
 * from storage and pushed through exactly these functions, so if they are
 * correct on values they are correct after a restart, and the restart test is
 * checking the wiring rather than the logic.
 *
 * Every function here returns a new instance rather than mutating one. The
 * engine writes each result to the store before doing anything else, so a
 * partially applied transition cannot exist — either the whole transition is
 * durable or none of it is.
 */

/**
 * Bounds on the instance context.
 *
 * The context is working memory that lives as long as the case does. Without a
 * bound it becomes the convenient place to stash a document, an owner's
 * details, or a model's output — and then the instance row is a second copy of
 * material the operating record deliberately does not keep. The limits are
 * generous for references and hostile to payloads.
 */
export const MAX_CONTEXT_KEYS = 64;
export const MAX_CONTEXT_VALUE_LENGTH = 512;

/**
 * Refuse a context that has stopped being a set of references.
 *
 * @throws {InvalidInputError} on a payload-shaped or credential-shaped value.
 */
export function assertContextSafe(context: WorkflowContext, where: string): void {
  const keys = Object.keys(context);
  if (keys.length > MAX_CONTEXT_KEYS) {
    throw new InvalidInputError(
      `${where} carries ${keys.length} context keys, past the limit of ${MAX_CONTEXT_KEYS}. A workflow context holds references — a contract id, a state code, a finding — not a dataset.`,
      "context",
    );
  }
  for (const key of keys) {
    const value = context[key];
    if (value === undefined) continue;
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new InvalidInputError(
        `${where} sets context.${key} to a ${type}. Workflow context values are scalars, so that the instance row cannot quietly become a copy of owner data.`,
        `context.${key}`,
      );
    }
    if (type === "number" && !Number.isFinite(value as number)) {
      throw new InvalidInputError(
        `${where} sets context.${key} to a non-finite number, which has no stable digest and would break the idempotency key derived from it.`,
        `context.${key}`,
      );
    }
    if (type === "string") {
      const text = value as string;
      if (text.length > MAX_CONTEXT_VALUE_LENGTH) {
        throw new InvalidInputError(
          `${where} sets context.${key} to ${text.length} characters, past the ${MAX_CONTEXT_VALUE_LENGTH}-character limit. Store a digest or an identifier and fetch the material from its system of record.`,
          `context.${key}`,
        );
      }
      if (containsSecret(text)) {
        throw new InvalidInputError(
          `${where} sets context.${key} to something that looks like a credential or a card number. The instance row is durable and is read by the console; it must never carry one.`,
          `context.${key}`,
        );
      }
    }
  }
}

/** Merge a step's declared output into the context, refusing anything unsafe. */
export function mergeContext(
  current: WorkflowContext,
  output: WorkflowContext | undefined,
  where: string,
): WorkflowContext {
  if (!output || Object.keys(output).length === 0) return current;
  const next: Record<string, ContextValue> = { ...current };
  for (const [key, value] of Object.entries(output)) {
    if (value === undefined) continue;
    next[key] = value;
  }
  assertContextSafe(next, where);
  return Object.freeze(next);
}

/**
 * The subset of the context a step declared it reads.
 *
 * Only these keys reach the handler, and only these keys feed the idempotency
 * key. Narrowing both to the declaration is what makes the key mean "the same
 * inputs" rather than "nothing else in the case has changed since".
 */
export function pickInputs(
  context: WorkflowContext,
  keys: readonly string[] | undefined,
): WorkflowContext {
  if (!keys || keys.length === 0) return Object.freeze({});
  const picked: Record<string, ContextValue> = {};
  // Sorted so the digest does not depend on declaration order, which an author
  // may reorder without meaning to change anything.
  for (const key of [...keys].sort()) {
    const value = context[key];
    if (value !== undefined) picked[key] = value;
  }
  return Object.freeze(picked);
}

/**
 * The key under which a step's external effect is recorded.
 *
 * Derived from the instance, the step name, and the attempt-invariant inputs —
 * never from the attempt number or the clock. That is the whole point: a retry
 * after a crash produces the same key, the engine finds the earlier step, and
 * the effect is not repeated.
 */
export function idempotencyKeyFor(
  instanceId: string,
  stepName: string,
  input: WorkflowContext,
): string {
  return `wf:${instanceId}:${stepName}:${digestValue(input)}`;
}

// --- branch conditions ----------------------------------------------------

export interface ConditionResult {
  readonly matched: boolean;
  /** Why, in language the console can show beside the chosen path. */
  readonly reason: string;
}

/**
 * Evaluate one declarative condition against the context.
 *
 * Total: it never throws and never has an undefined answer. A comparison
 * between mismatched types does not match, and says so, rather than coercing —
 * `"10" > 9` being true in JavaScript is exactly the kind of surprise that
 * routes a case down the wrong path and is invisible afterwards.
 */
export function evaluateCondition(condition: Condition, context: WorkflowContext): ConditionResult {
  const present = Object.prototype.hasOwnProperty.call(context, condition.key);
  const actual = present ? context[condition.key] : undefined;

  if (condition.op === "exists") {
    return { matched: present, reason: present ? `${condition.key} is set` : `${condition.key} is not set` };
  }
  if (condition.op === "absent") {
    return { matched: !present, reason: present ? `${condition.key} is set` : `${condition.key} is not set` };
  }

  if (!present || actual === undefined) {
    return { matched: false, reason: `${condition.key} is not set` };
  }

  if (condition.op === "in") {
    const values = condition.values ?? [];
    const matched = values.includes(actual);
    return {
      matched,
      reason: `${condition.key} is ${describe(actual)}, which is ${matched ? "one of" : "not one of"} ${values.map(describe).join(", ")}`,
    };
  }

  if (condition.op === "eq" || condition.op === "neq") {
    const equal = actual === condition.value;
    const matched = condition.op === "eq" ? equal : !equal;
    return {
      matched,
      reason: `${condition.key} is ${describe(actual)} and the rule wanted ${condition.op === "eq" ? "" : "anything but "}${describe(condition.value)}`,
    };
  }

  const expected = condition.value;
  if (typeof actual !== typeof expected || (typeof actual !== "number" && typeof actual !== "string")) {
    return {
      matched: false,
      reason: `${condition.key} is ${describe(actual)}, which cannot be ordered against ${describe(expected)}`,
    };
  }

  // Both sides are the same orderable type, so the comparison is meaningful.
  // Strings compare lexicographically, which is correct for the fixed-width UTC
  // timestamps this platform uses everywhere.
  const left = actual as string | number;
  const right = expected as string | number;
  const matched =
    condition.op === "gt"
      ? left > right
      : condition.op === "gte"
        ? left >= right
        : condition.op === "lt"
          ? left < right
          : left <= right;
  return {
    matched,
    reason: `${condition.key} is ${describe(actual)}, and the rule wanted ${condition.op} ${describe(expected)}`,
  };
}

function describe(value: ContextValue | undefined): string {
  if (value === undefined) return "unset";
  return typeof value === "string" ? `"${value}"` : String(value);
}

export interface BranchChoice {
  readonly next: string;
  /** Plain language for the operating record and the console. */
  readonly label: string;
  readonly reason: string;
}

/** Pick the path a branch step takes. Always returns one: `otherwise` is required. */
export function chooseBranch(step: BranchStep, context: WorkflowContext): BranchChoice {
  for (const branchCase of step.cases) {
    const result = evaluateCondition(branchCase.when, context);
    if (result.matched) {
      return { next: branchCase.next, label: branchCase.label, reason: result.reason };
    }
  }
  return {
    next: step.otherwise,
    label: "no case matched",
    reason: `None of the ${step.cases.length} declared cases matched, so the workflow took the default path.`,
  };
}

// --- tokens ---------------------------------------------------------------

export function findToken(
  instance: WorkflowInstance,
  stepName: string,
): StepToken | undefined {
  return instance.tokens.find((token) => token.stepName === stepName);
}

/** Replace one token, matched by step name. Adds it when it is not there. */
export function withToken(instance: WorkflowInstance, token: StepToken): WorkflowInstance {
  const present = instance.tokens.some((existing) => existing.stepName === token.stepName);
  const tokens = present
    ? instance.tokens.map((existing) => (existing.stepName === token.stepName ? token : existing))
    : [...instance.tokens, token];
  return { ...instance, tokens };
}

export function withoutToken(instance: WorkflowInstance, stepName: string): WorkflowInstance {
  return { ...instance, tokens: instance.tokens.filter((token) => token.stepName !== stepName) };
}

export function appendHistory(instance: WorkflowInstance, outcome: StepOutcome): WorkflowInstance {
  return { ...instance, history: [...instance.history, outcome] };
}

/**
 * Report a finished path to its join, releasing the join when the last one
 * arrives.
 *
 * Returns the instance with the barrier advanced, and the released token when
 * this arrival was the last one.
 */
export function arriveAtBarrier(
  instance: WorkflowInstance,
  barrierId: string,
  at: IsoTimestamp,
): { readonly instance: WorkflowInstance; readonly released: string | undefined } {
  const barrier = instance.barriers.find((candidate) => candidate.id === barrierId);
  if (!barrier) return { instance, released: undefined };

  const arrived = barrier.arrived + 1;
  const next: JoinBarrier = { ...barrier, arrived };
  const barriers = instance.barriers.map((candidate) =>
    candidate.id === barrierId ? next : candidate,
  );

  if (arrived < barrier.expected) {
    return { instance: { ...instance, barriers }, released: undefined };
  }

  // The join fires exactly once, when the last branch reports. Dropping the
  // barrier afterwards means a stray second arrival cannot release it again.
  const released: StepToken = {
    stepName: barrier.next,
    state: "ready",
    attempt: 1,
    enteredAt: at,
    barrierId: barrier.parentBarrierId,
  };
  const withoutBarrier = barriers.filter((candidate) => candidate.id !== barrierId);
  return {
    instance: withToken({ ...instance, barriers: withoutBarrier }, released),
    released: barrier.next,
  };
}

// --- derived state --------------------------------------------------------

/**
 * The instance's status, derived from its tokens rather than stored separately.
 *
 * Derivation rather than assignment removes a class of bug: an instance whose
 * status says "waiting for approval" while its only token is ready to run would
 * be invisible to the sweep and would sit there until someone noticed.
 */
export function deriveStatus(instance: WorkflowInstance): InstanceStatus {
  if (instance.compensationQueue.length > 0) return "compensating";
  if (instance.tokens.length === 0) return instance.terminalStatus ?? "succeeded";
  if (instance.tokens.some((token) => token.state === "ready" || token.state === "running")) {
    return "running";
  }
  // Ordered by how much a person can do about it: a task on someone's queue is
  // the thing a supervisor should see first.
  if (instance.tokens.some((token) => token.state === "waiting_human")) return "waiting_human";
  if (instance.tokens.some((token) => token.state === "waiting_approval")) return "waiting_approval";
  if (instance.tokens.some((token) => token.state === "waiting_event")) return "waiting_event";
  return "waiting_timer";
}

/** The earliest instant at which any token becomes runnable, for the sweep. */
export function deriveWakeAt(instance: WorkflowInstance): IsoTimestamp | undefined {
  let earliest: IsoTimestamp | undefined;
  for (const token of instance.tokens) {
    if (token.wakeAt === undefined) continue;
    if (earliest === undefined || token.wakeAt < earliest) earliest = token.wakeAt;
  }
  return earliest;
}

/**
 * Recompute the fields that are functions of the tokens. Called on every save.
 *
 * `endedAt` is stamped here rather than at each of the half-dozen places an
 * instance can finish. Both adapters key "this case is over" off that column —
 * the Postgres partial indexes that keep the sweep cheap, and the guard that
 * refuses to reopen a closed case — so a terminal instance that left it unset
 * would be invisible to one and resurrectable through the other.
 */
export function normaliseInstance(instance: WorkflowInstance): WorkflowInstance {
  const status = deriveStatus(instance);
  const finished = TERMINAL_INSTANCE_STATUSES.includes(status as never);
  return {
    ...instance,
    status,
    wakeAt: deriveWakeAt(instance),
    endedAt: instance.endedAt ?? (finished ? instance.updatedAt : undefined),
  };
}

// --- compensation ---------------------------------------------------------

/**
 * The compensating steps to run, in the order to run them.
 *
 * Reverse order of completion, which is the only order that makes sense: the
 * last effect is the one nothing else depends on, so it is the one that can be
 * undone first. Steps that did not succeed have nothing to undo, and steps
 * already marked compensated are skipped so a second failure during an unwind
 * does not run the unwind twice.
 */
export function buildCompensationQueue(
  definition: WorkflowDefinition,
  history: readonly StepOutcome[],
): readonly string[] {
  const byName = new Map(definition.steps.map((step) => [step.name, step] as const));
  const compensated = new Set(
    history.filter((entry) => entry.status === "compensated").map((entry) => entry.stepName),
  );

  const queue: string[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry || entry.status !== "succeeded") continue;
    if (compensated.has(entry.stepName)) continue;
    const step = byName.get(entry.stepName);
    if (!step?.compensation) continue;
    if (queue.includes(step.compensation)) continue;
    queue.push(step.compensation);
  }
  return queue;
}

// --- retries --------------------------------------------------------------

/**
 * Backoff before attempt `attempt` (1-based; attempt 2 is the first retry).
 *
 * Deterministic by design. The seeded demonstration must reproduce byte for
 * byte, and a jittered delay would put a random number in the middle of the
 * one path that has to be reproducible. Jitter belongs in how a multi-process
 * sweep picks instances, not in how one step waits.
 */
export function backoffMsFor(policy: RetryPolicy, attempt: number): number {
  const factor = policy.factor ?? 2;
  const exponent = Math.max(0, attempt - 2);
  const raw = policy.backoffMs * Math.pow(factor, exponent);
  const capped = policy.maxBackoffMs === undefined ? raw : Math.min(raw, policy.maxBackoffMs);
  return Math.max(0, Math.round(capped));
}

export function canRetry(policy: RetryPolicy | undefined, attempt: number): boolean {
  if (!policy) return false;
  return attempt < policy.maxAttempts;
}
