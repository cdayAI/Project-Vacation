import { DeniedError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { Platform } from "../platform.js";
import type { InstanceDescription } from "../engine/types.js";

/**
 * One workflow instance, described so a supervisor can read it unaided.
 *
 * The engine already renders an instance into plain language — where each live
 * path is, what it is waiting for, what a person should do next — through
 * `describeInstance`. This maps that description to the console's view model and
 * adds nothing the engine did not say. The headline, the waiting-on line, and
 * the per-step status all come from the record; none is composed here from a
 * template that could drift from what the instance is actually doing.
 *
 * **What the record can and cannot source.** The description carries completed
 * steps (name, outcome, when), open human tasks (with their SLA and whether it
 * has breached), and pending timers. It does not carry a machine `kind` per
 * step, so the kind is resolved from the pinned definition — the exact version
 * the instance started under — when that version is still in the catalogue. A
 * pinned version that has been retired from source cannot be resolved, which is
 * itself something a supervisor needs told; on that path the kind is left blank
 * rather than guessed, because inventing a step type for a definition nobody
 * can read would be a claim the record cannot support.
 *
 * A missing instance is a 404, not a denial. `describeInstance` refuses an
 * absent instance with `record.unavailable`; the route wants "there is no such
 * case" rather than "the platform declined", so that one refusal is caught here
 * and turned into `null`. Every other denial propagates untouched.
 */

export interface WorkflowStepView {
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly dueAt?: string | undefined;
  readonly slaBreached: boolean;
}

export interface WorkflowInstanceView {
  readonly instanceId: string;
  readonly definitionName: string;
  readonly definitionVersion: number;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly plainLanguageStatus: string;
  readonly currentStepName?: string | undefined;
  readonly waitingOn?: string | undefined;
  readonly totalCostUsd: number;
  readonly steps: readonly WorkflowStepView[];
}

/**
 * The kind of each step, read from the pinned definition.
 *
 * Empty when that definition version is no longer in the catalogue — a pinned
 * version that cannot be resolved is exactly what `describeInstance` reports as
 * stuck, and a step from a definition nobody can read has no kind to state.
 */
function stepKinds(platform: Platform, workflow: string, version: number): Map<string, string> {
  const kinds = new Map<string, string>();
  if (!platform.catalogue.has(workflow, version)) return kinds;
  const definition = platform.catalogue.require(workflow, version);
  for (const step of definition.steps) kinds.set(step.name, step.type);
  return kinds;
}

function view(platform: Platform, description: InstanceDescription): WorkflowInstanceView {
  const kinds = stepKinds(platform, description.workflow, description.version);

  const completed: WorkflowStepView[] = description.stepsCompleted.map((step) => ({
    name: step.step,
    kind: kinds.get(step.step) ?? "",
    status: step.status,
    startedAt: step.at,
    endedAt: step.at,
    slaBreached: false,
  }));

  // Open human tasks and pending timers are steps in flight — shown after the
  // completed ones so the timeline reads top to bottom. A breached task is
  // carried as such rather than recomputed in the browser: the engine measured
  // it against the clock the instance is actually running on.
  const openTasks: WorkflowStepView[] = description.openTasks.map((task) => ({
    name: task.step,
    kind: kinds.get(task.step) ?? "human_task",
    status: "waiting_human",
    dueAt: task.dueAt,
    slaBreached: task.breached,
  }));

  const seen = new Set(description.stepsCompleted.map((step) => step.step));
  const timers: WorkflowStepView[] = description.timers
    // A timer whose step already recorded an outcome is not still waiting; only
    // genuinely pending timers are shown, so the list is not double-counted.
    .filter((timer) => !seen.has(timer.step))
    .map((timer) => ({
      name: timer.step,
      kind: kinds.get(timer.step) ?? "timer",
      status: "waiting_timer",
      dueAt: timer.firesAt,
      slaBreached: false,
    }));

  return {
    instanceId: description.instanceId,
    definitionName: description.workflow,
    definitionVersion: description.version,
    status: description.status,
    startedAt: description.startedAt,
    endedAt: description.endedAt,
    plainLanguageStatus: description.headline,
    // The first live path, when there is one — the console shows it as "where
    // this case is now". `where` is empty on a finished instance, and the field
    // is then absent rather than a stale last position.
    currentStepName: description.where[0],
    // What it is waiting on, joined into one line. Absent when nothing is.
    waitingOn: description.waitingFor.length > 0 ? description.waitingFor.join("; ") : undefined,
    totalCostUsd: description.costUsd,
    steps: [...completed, ...openTasks, ...timers],
  };
}

/**
 * Describe one instance for the console, or `null` when it does not exist.
 *
 * @throws every denial except `record.unavailable`, which is the absent-instance
 *   case and becomes a 404 at the route.
 */
export async function workflowInstanceView(
  platform: Platform,
  instanceId: Id<"workflowInstance">,
): Promise<WorkflowInstanceView | null> {
  let description: InstanceDescription;
  try {
    description = await platform.engine.describeInstance(instanceId);
  } catch (error) {
    if (error instanceof DeniedError && error.reason === "record.unavailable") return null;
    throw error;
  }
  return view(platform, description);
}
