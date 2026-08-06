import { z } from "zod";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import { OPERATING_MODES } from "../record/types.js";
import {
  WORKFLOW_STEP_TYPES,
  type DefinitionProblem,
  type WorkflowDefinition,
  type WorkflowStep,
} from "./types.js";

/**
 * Workflow definitions: the schema, the validator, and the catalogue.
 *
 * A definition is a declarative artifact in version control. It names steps, it
 * names the registered actions those steps perform, and it names the handlers
 * the deployment wires up — but it contains no logic. Routing is expressed as
 * conditions over the instance context; retries and SLAs are policy objects;
 * timers name the inputs a statutory computation needs rather than doing the
 * arithmetic. All of that exists so a definition can be reviewed as a diff by
 * someone who does not read TypeScript, and so a change to what the platform
 * does is a change to a reviewed file rather than to a call site.
 *
 * The validator is the interesting half. Four of its checks encode obligations
 * that would otherwise be a matter of the author remembering:
 *
 *   1. Every step reference resolves, and every step is reachable. A step
 *      nobody can reach is either a typo or dead policy, and both are worth a
 *      failed build.
 *
 *   2. The graph is acyclic. A workflow that can revisit a step can run
 *      forever; bounded repetition belongs in a step's retry policy, where the
 *      bound is visible.
 *
 *   3. An irreversible step has an approval gate on every path to it, and that
 *      gate names it. "We cannot undo it" is a property of the world rather
 *      than of the classification, so the gate is not optional and the binding
 *      is not implicit.
 *
 *   4. Everything reversible that can run after an irreversible step declares
 *      how to undo itself. Once the unrepeatable thing has happened, the only
 *      remaining safety property is the ability to unwind back to it — and the
 *      moment to discover a missing compensating action is at load, not in the
 *      middle of an incident.
 */

// --- schema ---------------------------------------------------------------

const STEP_NAME = /^[a-z][a-z0-9_]*$/;
const WORKFLOW_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ACTION_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const contextValue = z.union([z.string(), z.number().finite(), z.boolean()]);

const conditionSchema = z
  .object({
    key: z.string().min(1),
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "exists", "absent", "in"]),
    value: contextValue.optional(),
    values: z.array(contextValue).optional(),
  })
  .superRefine((condition, ctx) => {
    const needsValue = ["eq", "neq", "gt", "gte", "lt", "lte"].includes(condition.op);
    if (needsValue && condition.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Condition on "${condition.key}" uses "${condition.op}" and needs a value to compare against.`,
      });
    }
    if (condition.op === "in" && (condition.values === undefined || condition.values.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Condition on "${condition.key}" uses "in" and needs a non-empty values list.`,
      });
    }
  });

const retrySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    backoffMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
    factor: z.number().min(1).max(10).optional(),
    maxBackoffMs: z.number().int().min(0).optional(),
  })
  .strict();

const escalationSchema = z
  .object({
    afterMs: z.number().int().min(0),
    notifyRoles: z.array(z.string().min(1)).min(1),
    note: z.string().min(1).max(500),
  })
  .strict();

const slaSchema = z
  .object({
    targetMs: z.number().int().min(1),
    escalations: z.array(escalationSchema),
  })
  .strict();

const timerScheduleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("duration"),
      // Bounded so a mistyped constant cannot park an instance past the
      // audit retention window, where nobody would ever see it again.
      ms: z.number().int().min(0).max(400 * 24 * 60 * 60 * 1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("statutory_rescission"),
      stateCodeKey: z.string().min(1),
      executedAtKey: z.string().min(1),
      deliveredAtKey: z.string().min(1).optional(),
      offsetMs: z.number().int().optional(),
      requireVerifiedRule: z.boolean().optional(),
      deadlineContextKey: z.string().min(1).optional(),
    })
    .strict(),
]);

const commonFields = {
  name: z.string().regex(STEP_NAME, "Step names are lower_snake_case, e.g. verify_window."),
  description: z.string().min(1).max(500),
  next: z.string().regex(STEP_NAME).optional(),
  action: z.string().regex(ACTION_NAME).optional(),
  handler: z.string().min(1).optional(),
  irreversible: z.boolean().optional(),
  compensation: z.string().regex(STEP_NAME).optional(),
  retry: retrySchema.optional(),
  sla: slaSchema.optional(),
  estimatedCostUsd: z.number().min(0).optional(),
  inputs: z.array(z.string().min(1)).optional(),
  requiredScopes: z.array(z.string().min(1)).optional(),
};

const stepSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...commonFields,
      type: z.literal("automated_action"),
      action: z.string().regex(ACTION_NAME),
      handler: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("model_call"),
      action: z.string().regex(ACTION_NAME),
      handler: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("human_task"),
      title: z.string().min(1).max(200),
      assignedRoles: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("approval_gate"),
      gates: z.string().regex(STEP_NAME),
      approverRoles: z.array(z.string().min(1)).min(1),
      summary: z.string().min(1).max(500),
      ttlMs: z.number().int().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("wait_for_event"),
      event: z.string().min(1).max(120),
      timeoutMs: z.number().int().min(1).optional(),
      onTimeout: z.string().regex(STEP_NAME).optional(),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("timer"),
      schedule: timerScheduleSchema,
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("branch"),
      cases: z.array(z.object({ label: z.string().min(1).max(200), when: conditionSchema, next: z.string().regex(STEP_NAME) })).min(1),
      // Required rather than optional. A branch whose cases all miss would
      // otherwise end that path silently, which looks identical to success.
      otherwise: z.string().regex(STEP_NAME),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("parallel"),
      branches: z.array(z.string().regex(STEP_NAME)).min(2),
      next: z.string().regex(STEP_NAME),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      type: z.literal("compensation"),
      action: z.string().regex(ACTION_NAME),
      handler: z.string().min(1),
    })
    .strict(),
]);

export const workflowDefinitionSchema = z
  .object({
    name: z
      .string()
      .regex(WORKFLOW_NAME, "Workflow names are dotted lower_snake_case, e.g. rescission.verify."),
    version: z.number().int().min(1),
    description: z.string().min(1).max(2000),
    mode: z.enum(OPERATING_MODES as unknown as [string, ...string[]]),
    steps: z.array(stepSchema).min(1),
    requiredContext: z.array(z.string().min(1)).optional(),
  })
  .strict();

// --- graph analysis -------------------------------------------------------

interface Graph {
  readonly byName: ReadonlyMap<string, WorkflowStep>;
  readonly forward: readonly WorkflowStep[];
  readonly start: WorkflowStep | undefined;
  /** Execution successors: the steps that may run immediately after this one. */
  readonly successors: ReadonlyMap<string, readonly string[]>;
  /** Steps that are the join point of a fan-out, which wait for every predecessor. */
  readonly joins: ReadonlySet<string>;
  /** The fan-out each step sits inside, if any. */
  readonly enclosing: ReadonlyMap<string, string | undefined>;
}

/**
 * Build the execution graph.
 *
 * The one subtlety is where a `parallel` step's join edge comes from. It does
 * not come from the fan-out step: the join runs after every branch *finishes*,
 * so its predecessors are the last step of each branch. Modelling it that way
 * rather than as an edge out of the fan-out is what makes the approval-gate
 * analysis below correct — a gate inside a branch really is "before" the join.
 */
function buildGraph(definition: WorkflowDefinition): Graph {
  const byName = new Map<string, WorkflowStep>();
  for (const step of definition.steps) byName.set(step.name, step);

  const forward = definition.steps.filter((step) => step.type !== "compensation");
  const start = forward[0];

  const successors = new Map<string, string[]>();
  const joins = new Set<string>();
  const enclosing = new Map<string, string | undefined>();

  const add = (from: string, to: string): void => {
    const list = successors.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    successors.set(from, list);
  };

  // Depth-first from the start, carrying the fan-out each step sits inside.
  // Guarded against cycles by the visited set; genuine cycles are reported
  // separately, and this walk must terminate either way.
  const seen = new Set<string>();
  const walk = (name: string, inside: string | undefined): void => {
    const step = byName.get(name);
    if (!step) return;
    if (seen.has(name)) return;
    seen.add(name);
    enclosing.set(name, inside);

    if (step.type === "parallel") {
      joins.add(step.next);
      // The join is walked before the branches, and in whatever fan-out the
      // fan-out itself sat in. Walking it afterwards would let a branch reach
      // it first and stamp it with the *inner* scope, which would then make the
      // join look like a branch step reporting to itself.
      walk(step.next, inside);
      for (const head of step.branches) {
        add(name, head);
        walk(head, name);
      }
      return;
    }

    if (step.type === "branch") {
      for (const branchCase of step.cases) {
        add(name, branchCase.next);
        walk(branchCase.next, inside);
      }
      add(name, step.otherwise);
      walk(step.otherwise, inside);
      return;
    }

    if (step.type === "wait_for_event" && step.onTimeout !== undefined) {
      add(name, step.onTimeout);
      walk(step.onTimeout, inside);
    }

    if (step.next !== undefined) {
      add(name, step.next);
      walk(step.next, inside);
      return;
    }

    // The path ends here. If it is inside a fan-out, ending is how this branch
    // reports to the join.
    if (inside !== undefined) {
      const parent = byName.get(inside);
      // The self-edge guard matters: without it a malformed definition whose
      // join is also a branch step would report as a loop, and the cycle check
      // runs first, so the author would be told the wrong thing.
      if (parent && parent.type === "parallel" && parent.next !== name) add(name, parent.next);
    }
  };

  if (start) walk(start.name, undefined);

  return { byName, forward, start, successors, joins, enclosing };
}

/**
 * Every step that can run after `from`.
 *
 * `stopAt` bounds the walk at a join: the step is included, because a branch
 * that names it is worth reporting, but nothing beyond it is. Without that
 * bound, two branches of a nested fan-out would both appear to reach the outer
 * join and be reported as overlapping — which is not an overlap at all, since
 * everything past the join runs once, after every branch has finished.
 */
function reachableFrom(graph: Graph, from: string, stopAt?: string): Set<string> {
  const found = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const next of graph.successors.get(current) ?? []) {
      if (found.has(next)) continue;
      found.add(next);
      if (next !== stopAt) queue.push(next);
    }
  }
  return found;
}

/** Steps that form a cycle, if any. Empty when the graph is a DAG. */
function findCycle(graph: Graph): readonly string[] {
  const state = new Map<string, "open" | "closed">();
  const stack: string[] = [];
  let cycle: readonly string[] = [];

  const visit = (name: string): boolean => {
    const current = state.get(name);
    if (current === "closed") return false;
    if (current === "open") {
      const from = stack.indexOf(name);
      cycle = [...stack.slice(from === -1 ? 0 : from), name];
      return true;
    }
    state.set(name, "open");
    stack.push(name);
    for (const next of graph.successors.get(name) ?? []) {
      if (visit(next)) return true;
    }
    stack.pop();
    state.set(name, "closed");
    return false;
  };

  if (graph.start) visit(graph.start.name);
  return cycle;
}

/**
 * For each reachable step, whether every execution path to it passes an
 * approval gate.
 *
 * An ordinary step is guarded only if *all* of its predecessors are, because
 * reaching it by any one of them is enough to execute it. A join is guarded if
 * *any* of its predecessors are, because it does not run until all of them
 * have. Collapsing those two into one rule is the kind of simplification that
 * produces either a false alarm on every fan-out or a silent hole after one.
 */
function computeGuarded(graph: Graph, reachable: ReadonlySet<string>): ReadonlyMap<string, boolean> {
  const predecessors = new Map<string, string[]>();
  for (const [from, targets] of graph.successors) {
    for (const to of targets) {
      const list = predecessors.get(to) ?? [];
      list.push(from);
      predecessors.set(to, list);
    }
  }

  const guarded = new Map<string, boolean>();
  for (const name of reachable) guarded.set(name, true);
  if (graph.start) guarded.set(graph.start.name, false);

  // Iterate to a fixed point. The graph is small (definitions are read by
  // people), and iterating avoids needing a topological order that a cyclic
  // definition would not have — this runs before the cycle check has decided
  // anything.
  for (let pass = 0; pass < reachable.size + 1; pass += 1) {
    let changed = false;
    for (const name of reachable) {
      if (graph.start && name === graph.start.name) continue;
      const preds = predecessors.get(name) ?? [];
      if (preds.length === 0) continue;
      const contributions = preds.map((pred) => {
        const predStep = graph.byName.get(pred);
        return predStep?.type === "approval_gate" || guarded.get(pred) === true;
      });
      const next = graph.joins.has(name)
        ? contributions.some((value) => value)
        : contributions.every((value) => value);
      if (guarded.get(name) !== next) {
        guarded.set(name, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return guarded;
}

// --- validation -----------------------------------------------------------

/**
 * Check a candidate definition.
 *
 * Returns every problem it finds rather than the first, because a definition
 * with four mistakes should take one round trip to fix rather than four.
 */
export function validateDefinition(candidate: unknown): readonly DefinitionProblem[] {
  const parsed = workflowDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      code: "schema_invalid" as const,
      stepName: typeof issue.path[1] === "number" ? `steps[${issue.path[1]}]` : undefined,
      message: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    }));
  }

  const definition = parsed.data as unknown as WorkflowDefinition;
  const problems: DefinitionProblem[] = [];
  const report = (
    code: DefinitionProblem["code"],
    message: string,
    stepName?: string,
  ): void => {
    problems.push({ code, stepName, message });
  };

  // --- names and references ---------------------------------------------

  const seenNames = new Set<string>();
  for (const step of definition.steps) {
    if (seenNames.has(step.name)) {
      report(
        "duplicate_step_name",
        `Two steps are named "${step.name}". Step names identify the step in the operating record and in the idempotency key, so they must be unique.`,
        step.name,
      );
    }
    seenNames.add(step.name);
  }

  const byName = new Map(definition.steps.map((step) => [step.name, step] as const));
  const requireRef = (from: WorkflowStep, field: string, target: string | undefined): void => {
    if (target === undefined) return;
    if (!byName.has(target)) {
      report(
        "unknown_step_reference",
        `Step "${from.name}" points its ${field} at "${target}", which is not a step in this definition.`,
        from.name,
      );
    }
  };

  for (const step of definition.steps) {
    requireRef(step, "next", step.next);
    requireRef(step, "compensation", step.compensation);
    if (step.type === "branch") {
      for (const branchCase of step.cases) requireRef(step, `case "${branchCase.label}"`, branchCase.next);
      requireRef(step, "otherwise", step.otherwise);
    }
    if (step.type === "parallel") {
      for (const head of step.branches) requireRef(step, "branch", head);
    }
    if (step.type === "approval_gate") requireRef(step, "gates", step.gates);
    if (step.type === "wait_for_event") requireRef(step, "onTimeout", step.onTimeout);

    if (step.sla) {
      let previous = -1;
      for (const escalation of step.sla.escalations) {
        if (escalation.afterMs <= previous) {
          report(
            "escalation_out_of_order",
            `Step "${step.name}" declares an escalation at ${escalation.afterMs}ms after an earlier one at ${previous}ms. Escalation rules apply in order and must be strictly increasing, or a later rule can never fire.`,
            step.name,
          );
        }
        previous = escalation.afterMs;
      }
    }

    if (step.type === "compensation") {
      if (step.next !== undefined) {
        report(
          "compensation_in_forward_path",
          `Compensation step "${step.name}" declares a next step. Compensation runs as an unwind of what already happened, not as a path that continues.`,
          step.name,
        );
      }
      if (step.compensation !== undefined) {
        report(
          "compensation_target_wrong_type",
          `Compensation step "${step.name}" declares a compensation of its own. Nothing compensates a compensation.`,
          step.name,
        );
      }
    }

    if (step.compensation !== undefined) {
      const target = byName.get(step.compensation);
      if (target && target.type !== "compensation") {
        report(
          "compensation_target_wrong_type",
          `Step "${step.name}" names "${step.compensation}" as its compensation, but that step is a ${target.type}. A compensating action must be declared as a compensation step.`,
          step.name,
        );
      }
    }
  }

  // A reference problem makes the graph analysis meaningless, so stop here and
  // let the author fix the references first.
  if (problems.length > 0) return problems;

  // --- structure ---------------------------------------------------------

  const graph = buildGraph(definition);
  if (!graph.start) {
    report(
      "start_step_missing",
      "This definition has no step to start from. At least one step must not be a compensation step.",
    );
    return problems;
  }

  const cycle = findCycle(graph);
  if (cycle.length > 0) {
    report(
      "cycle_detected",
      `Steps ${cycle.join(" -> ")} form a loop. A workflow that can revisit a step can run forever; express repetition as a bounded retry policy on the step, where the bound is visible.`,
      cycle[0],
    );
    return problems;
  }

  const reachable = new Set<string>([graph.start.name, ...reachableFrom(graph, graph.start.name)]);

  for (const step of definition.steps) {
    if (step.type === "compensation") {
      if (reachable.has(step.name)) {
        report(
          "compensation_in_forward_path",
          `Compensation step "${step.name}" is reachable from the start of the workflow. Compensation steps run only on the unwind path.`,
          step.name,
        );
      }
      const referencedBy = definition.steps.filter((other) => other.compensation === step.name);
      if (referencedBy.length === 0) {
        report(
          "compensation_not_referenced",
          `Compensation step "${step.name}" is not named as the compensation of any step, so nothing could ever run it.`,
          step.name,
        );
      } else if (referencedBy.length > 1) {
        report(
          "compensation_not_referenced",
          `Compensation step "${step.name}" is named by ${referencedBy.length} steps (${referencedBy.map((other) => other.name).join(", ")}). A compensating action undoes exactly one step, or the unwind cannot know what it is undoing.`,
          step.name,
        );
      }
      continue;
    }

    if (!reachable.has(step.name)) {
      report(
        "unreachable_step",
        `Step "${step.name}" cannot be reached from "${graph.start.name}". Either wire it into a path or delete it — an unreachable step is dead policy that still reads as though it applies.`,
        step.name,
      );
    }
  }

  // Fan-out branches must be disjoint, and none of them may reach the join
  // directly. Either would let the join run before every branch had finished,
  // which is a race that only shows up under load and only in production.
  for (const step of definition.steps) {
    if (step.type !== "parallel") continue;
    // Bounded at the join: what happens after it belongs to no branch.
    const branchSets = step.branches.map(
      (head) => new Set<string>([head, ...reachableFrom(graph, head, step.next)]),
    );
    for (let i = 0; i < branchSets.length; i += 1) {
      const left = branchSets[i];
      if (!left) continue;
      // Reaching the join is expected — every branch's last step reports to it.
      // What is not allowed is a branch step naming the join as its `next`,
      // which walks past the barrier and lets the join run before the other
      // branches have finished.
      const skipping = [...left].some(
        (name) => graph.byName.get(name)?.next === step.next && name !== step.name,
      );
      if (skipping) {
        report(
          "parallel_branch_reaches_join",
          `A step inside branch "${step.branches[i]}" of "${step.name}" points directly at the join step "${step.next}". Branch paths end by having no next step; the fan-out releases the join once every branch has finished.`,
          step.name,
        );
      }
      for (let j = i + 1; j < branchSets.length; j += 1) {
        const right = branchSets[j];
        if (!right) continue;
        const shared = [...left].filter((name) => right.has(name) && name !== step.next);
        if (shared.length > 0) {
          report(
            "parallel_branches_overlap",
            `Branches "${step.branches[i]}" and "${step.branches[j]}" of "${step.name}" both reach ${shared.join(", ")}. A step must belong to one path, or it would run twice and the join would count wrong.`,
            step.name,
          );
        }
      }
    }
  }

  // --- irreversibility ---------------------------------------------------

  const guarded = computeGuarded(graph, reachable);

  for (const step of definition.steps) {
    if (step.irreversible !== true) continue;
    if (!reachable.has(step.name)) continue;

    if (guarded.get(step.name) !== true) {
      report(
        "irreversible_without_approval_gate",
        `Step "${step.name}" is irreversible but can be reached without passing an approval gate. An effect that cannot be undone requires a human decision on every path that leads to it.`,
        step.name,
      );
    }

    const gate = definition.steps.find(
      (other) => other.type === "approval_gate" && other.gates === step.name,
    );
    if (!gate) {
      report(
        "irreversible_without_approval_gate",
        `Step "${step.name}" is irreversible but no approval gate names it. The gate must name the step it authorises, so the approval is bound to that step's action and proposal rather than to the workflow in general.`,
        step.name,
      );
    } else if (!reachableFrom(graph, gate.name).has(step.name)) {
      report(
        "approval_gate_target_unreachable",
        `Approval gate "${gate.name}" authorises "${step.name}", but "${step.name}" cannot be reached from it. An approval that the gated step never consumes is a signature collected for nothing.`,
        gate.name,
      );
    }

    // Everything downstream that *can* be undone must say how.
    //
    // Steps that are themselves irreversible are exempt: they carry their own
    // approval gate by the rule above, and demanding a compensating action for
    // something that by definition has none would make the rule unsatisfiable.
    // Model calls are exempt too — a model call spends money and produces text;
    // there is no external effect to reverse, and requiring a no-op compensation
    // for one would teach authors to write no-op compensations.
    for (const downstream of reachableFrom(graph, step.name)) {
      if (downstream === step.name) continue;
      const later = graph.byName.get(downstream);
      if (!later || later.type !== "automated_action") continue;
      if (later.irreversible === true) continue;
      if (later.compensation !== undefined) continue;
      report(
        "irreversible_without_downstream_compensation",
        `Step "${later.name}" can run after the irreversible step "${step.name}" but declares no compensating action. Once "${step.name}" has happened it cannot be undone, so everything after it must be able to unwind back to that point.`,
        later.name,
      );
    }
  }

  return problems;
}

/**
 * Validate and return the definition.
 *
 * @throws {InvalidInputError} listing every problem found.
 */
export function assertValidDefinition(candidate: unknown): WorkflowDefinition {
  const problems = validateDefinition(candidate);
  if (problems.length > 0) {
    const detail = problems
      .map((problem) => `  [${problem.code}] ${problem.stepName ? `${problem.stepName}: ` : ""}${problem.message}`)
      .join("\n");
    throw new InvalidInputError(
      `Workflow definition is not valid:\n${detail}`,
      problems[0]?.stepName ?? "steps",
    );
  }
  return candidate as WorkflowDefinition;
}

/**
 * Declare a workflow, validating it at module load.
 *
 * Definitions are declared with this rather than as bare object literals so
 * that a broken definition is a startup failure on a developer's laptop and in
 * CI, not a runtime failure on the first case that touches the broken path.
 */
export function defineWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  assertValidDefinition(definition);
  return Object.freeze({
    ...definition,
    steps: Object.freeze([...definition.steps]),
  });
}

/**
 * Content fingerprint of a definition.
 *
 * An instance stores this alongside the version number. The version alone would
 * be enough if versions were genuinely immutable; the digest is what turns that
 * from a convention into something the engine checks before it resumes work.
 */
export function definitionDigest(definition: WorkflowDefinition): Digest {
  return digestValue({
    name: definition.name,
    version: definition.version,
    mode: definition.mode,
    // Description is excluded deliberately: correcting a typo in prose should
    // not invalidate every instance in flight, and prose cannot change what a
    // step does.
    steps: definition.steps,
    requiredContext: definition.requiredContext ?? [],
  });
}

// --- catalogue ------------------------------------------------------------

export interface PublishedDefinition {
  readonly definition: WorkflowDefinition;
  readonly digest: Digest;
}

/**
 * The set of definitions this deployment knows.
 *
 * Published versions are immutable. Re-publishing a version with different
 * content is refused rather than accepted, because an instance pinned to that
 * version would silently change behaviour mid-flight — which is the exact
 * failure the pinning exists to prevent, arriving through the back door.
 */
export class WorkflowCatalogue {
  private readonly versions = new Map<string, Map<number, PublishedDefinition>>();

  constructor(definitions: readonly WorkflowDefinition[] = []) {
    for (const definition of definitions) this.publish(definition);
  }

  publish(candidate: WorkflowDefinition): PublishedDefinition {
    const definition = assertValidDefinition(candidate);
    const digest = definitionDigest(definition);

    let byVersion = this.versions.get(definition.name);
    if (!byVersion) {
      byVersion = new Map<number, PublishedDefinition>();
      this.versions.set(definition.name, byVersion);
    }

    const existing = byVersion.get(definition.version);
    if (existing) {
      if (existing.digest !== digest) {
        throw new InvalidInputError(
          `Workflow "${definition.name}" version ${definition.version} is already published with different content. A published version is immutable — instances in flight are pinned to it. Publish a new version instead.`,
          "version",
        );
      }
      return existing;
    }

    const published: PublishedDefinition = { definition, digest };
    byVersion.set(definition.version, published);
    return published;
  }

  /**
   * Resolve the exact version an instance was started under.
   *
   * @throws {DeniedError} `config.missing` when that version is no longer in
   *   source. Refusing is the only safe answer: running the instance under a
   *   different version would change its behaviour mid-case, and that is the
   *   thing pinning exists to prevent.
   */
  require(name: string, version: number): WorkflowDefinition {
    const found = this.versions.get(name)?.get(version);
    if (!found) {
      const known = [...(this.versions.get(name)?.keys() ?? [])].sort((a, b) => a - b);
      throw new DeniedError(
        "config.missing",
        `Workflow "${name}" version ${version} is not in this deployment's catalogue${known.length > 0 ? ` (it has ${known.join(", ")})` : ""}. An instance pinned to a version that is no longer in source cannot be resumed under a different one.`,
        { workflow: name, version },
      );
    }
    return found.definition;
  }

  /** @throws {DeniedError} `config.missing` when the workflow is unknown. */
  latest(name: string): WorkflowDefinition {
    const byVersion = this.versions.get(name);
    const highest = [...(byVersion?.keys() ?? [])].sort((a, b) => b - a)[0];
    if (highest === undefined) {
      throw new DeniedError(
        "config.missing",
        `Workflow "${name}" is not in this deployment's catalogue.`,
        { workflow: name },
      );
    }
    return this.require(name, highest);
  }

  digestOf(name: string, version: number): Digest {
    const found = this.versions.get(name)?.get(version);
    if (!found) {
      throw new DeniedError(
        "config.missing",
        `Workflow "${name}" version ${version} is not in this deployment's catalogue.`,
        { workflow: name, version },
      );
    }
    return found.digest;
  }

  has(name: string, version?: number): boolean {
    const byVersion = this.versions.get(name);
    if (!byVersion) return false;
    return version === undefined ? byVersion.size > 0 : byVersion.has(version);
  }

  versionsOf(name: string): readonly number[] {
    return [...(this.versions.get(name)?.keys() ?? [])].sort((a, b) => a - b);
  }

  list(): readonly PublishedDefinition[] {
    const all: PublishedDefinition[] = [];
    for (const byVersion of this.versions.values()) all.push(...byVersion.values());
    return all.sort(
      (a, b) =>
        a.definition.name.localeCompare(b.definition.name) ||
        a.definition.version - b.definition.version,
    );
  }
}

/** Step types that must resolve a handler before an instance may start. */
export function handlerNames(definition: WorkflowDefinition): readonly string[] {
  const names = new Set<string>();
  for (const step of definition.steps) {
    if (step.handler !== undefined) names.add(step.handler);
  }
  return [...names].sort();
}

/** Action names a definition can perform, for a reviewer and for a preflight check. */
export function actionNames(definition: WorkflowDefinition): readonly string[] {
  const names = new Set<string>();
  for (const step of definition.steps) {
    if (step.action !== undefined) names.add(step.action);
  }
  return [...names].sort();
}

/** Exposed for tests and tooling that need the step vocabulary at runtime. */
export const STEP_TYPES = WORKFLOW_STEP_TYPES;
