import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import type { IsoTimestamp } from "../record/types.js";
import type { MemoryDb } from "../store/db.js";
import type { WorkflowStore } from "./port.js";
import {
  isTerminalInstanceStatus,
  type HumanTask,
  type HumanTaskFilter,
  type HumanTaskPatch,
  type InstanceFilter,
  type WorkflowInstance,
} from "./types.js";

/**
 * In-memory workflow state.
 *
 * Used by the test suite, by local development, and by the seeded demonstration,
 * and held to the same contract as the Postgres adapter. Two things are done
 * the hard way on purpose.
 *
 * The compare-and-swap in `saveInstance` runs under `MemoryDb.withLock`,
 * mirroring the conditional UPDATE the Postgres adapter issues. Stated plainly:
 * the body contains no await, so on a single-threaded runtime it could not
 * interleave even without the lock. The lock is taken anyway, because the
 * atomicity is a property of the port rather than of the runtime, and because
 * the first await added to that body later would silently reopen a window
 * nobody would think to look for. The engine's mutual exclusion rests on this
 * swap, so a fake that was merely usually correct would make every concurrency
 * test meaningless.
 *
 * Everything is cloned on the way in and on the way out. A caller holding a
 * reference to a stored instance must not be able to rewrite durable state by
 * mutating an object it was handed — the property the Postgres adapter gets for
 * free and this one has to earn.
 */

const INSTANCES = "workflow_instance";
const TASKS = "workflow_human_task";

export class MemoryWorkflowStore implements WorkflowStore {
  constructor(private readonly db: MemoryDb) {}

  async createInstance(instance: WorkflowInstance): Promise<WorkflowInstance> {
    assertInstanceWritable(instance);
    return this.db.withLock(`engine:instance:${instance.id}`, async () => {
      const table = this.db.table<WorkflowInstance>(INSTANCES);
      if (table.has(instance.id)) {
        throw new InvalidInputError(
          `Workflow instance ${instance.id} already exists. Instance identifiers are assigned once; reusing one would overwrite work that already happened.`,
          "id",
        );
      }
      const stored = structuredClone({ ...instance, revision: instance.revision || 1 });
      table.set(instance.id, stored);
      return structuredClone(stored);
    });
  }

  async getInstance(id: Id<"workflowInstance">): Promise<WorkflowInstance | null> {
    const found = this.db.table<WorkflowInstance>(INSTANCES).get(id);
    return found ? structuredClone(found) : null;
  }

  async requireInstance(id: Id<"workflowInstance">): Promise<WorkflowInstance> {
    const found = await this.getInstance(id);
    if (!found) {
      // Refused rather than returned empty: an engine acting on an instance
      // that is not in the store has lost track of what it is doing, and
      // continuing would produce work nothing accounts for.
      throw new DeniedError(
        "record.unavailable",
        `Workflow instance ${id} is not in the operating record.`,
        { instanceId: id },
      );
    }
    return found;
  }

  async saveInstance(
    next: WorkflowInstance,
    expectedRevision: number,
  ): Promise<WorkflowInstance | null> {
    assertInstanceWritable(next);
    return this.db.withLock(`engine:instance:${next.id}`, async () => {
      const table = this.db.table<WorkflowInstance>(INSTANCES);
      const current = table.get(next.id);
      if (!current) {
        throw new DeniedError(
          "record.unavailable",
          `Workflow instance ${next.id} is not in the operating record.`,
          { instanceId: next.id },
        );
      }
      // The swap. A caller whose read is stale loses, and must re-read rather
      // than overwrite a transition it never saw.
      if (current.revision !== expectedRevision) return null;

      // A finished instance is history. Reopening one would let a late writer
      // resurrect a case that was already accounted for and reported.
      if (isTerminalInstanceStatus(current.status) && !isTerminalInstanceStatus(next.status)) {
        throw new DeniedError(
          "record.unavailable",
          `Workflow instance ${next.id} already ended as ${current.status} and cannot be moved back to ${next.status}.`,
          { instanceId: next.id, from: current.status, to: next.status },
        );
      }

      const stored = structuredClone({ ...next, revision: current.revision + 1 });
      table.set(next.id, stored);
      return structuredClone(stored);
    });
  }

  async listInstances(filter: InstanceFilter = {}): Promise<readonly WorkflowInstance[]> {
    const rows = this.db.rows<WorkflowInstance>(INSTANCES);
    const ordinals = new Map(rows.map((row, index) => [row.id, index]));
    const matched = rows.filter((row) => matchesInstanceFilter(row, filter));
    matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
      return (ordinals.get(right.id) ?? 0) - (ordinals.get(left.id) ?? 0);
    });
    return page(matched, filter.limit, filter.offset).map((row) => structuredClone(row));
  }

  async countInstances(filter: InstanceFilter = {}): Promise<number> {
    return this.db
      .rows<WorkflowInstance>(INSTANCES)
      .filter((row) => matchesInstanceFilter(row, filter)).length;
  }

  async dueInstances(at: IsoTimestamp, limit = 50): Promise<readonly WorkflowInstance[]> {
    assertIsoUtc("at", at);
    const matched = this.db
      .rows<WorkflowInstance>(INSTANCES)
      .filter((row) => isDue(row, at))
      // Oldest first: a case that has been waiting longest is served first, so
      // one busy workflow cannot starve another indefinitely.
      .sort((left, right) => (left.updatedAt < right.updatedAt ? -1 : 1));
    return matched.slice(0, limit).map((row) => structuredClone(row));
  }

  async createHumanTask(task: HumanTask): Promise<HumanTask> {
    assertTaskWritable(task);
    return this.db.withLock(`engine:task:${task.id}`, async () => {
      const table = this.db.table<HumanTask>(TASKS);
      if (table.has(task.id)) {
        throw new InvalidInputError(
          `Task ${task.id} is already on a queue. Creating it twice would put one step in front of two people.`,
          "id",
        );
      }
      table.set(task.id, structuredClone(task));
      return structuredClone(task);
    });
  }

  async getHumanTask(id: Id<"step">): Promise<HumanTask | null> {
    const found = this.db.table<HumanTask>(TASKS).get(id);
    return found ? structuredClone(found) : null;
  }

  async patchHumanTask(id: Id<"step">, patch: HumanTaskPatch): Promise<HumanTask> {
    return this.db.withLock(`engine:task:${id}`, async () => {
      const table = this.db.table<HumanTask>(TASKS);
      const current = table.get(id);
      if (!current) {
        throw new DeniedError("record.unavailable", `Task ${id} is not on any queue.`, {
          taskId: id,
        });
      }
      assertOptionalIsoUtc("escalatedAt", patch.escalatedAt);
      assertOptionalIsoUtc("completedAt", patch.completedAt);

      if (current.status !== "open" && patch.status !== undefined && patch.status !== current.status) {
        throw new DeniedError(
          "record.unavailable",
          `Task ${id} is already ${current.status} and cannot be moved to ${patch.status}.`,
          { taskId: id, from: current.status, to: patch.status },
        );
      }
      // Escalation is one-way. A level that could go down would let a sweep
      // that ran with a stale clock quietly un-escalate a breach somebody had
      // already been told about.
      if (patch.escalationLevel !== undefined && patch.escalationLevel < current.escalationLevel) {
        throw new InvalidInputError(
          `Task ${id} is at escalation level ${current.escalationLevel}; it cannot be lowered to ${patch.escalationLevel}.`,
          "escalationLevel",
        );
      }

      const next: HumanTask = {
        ...current,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.escalationLevel !== undefined ? { escalationLevel: patch.escalationLevel } : {}),
        ...(patch.escalatedAt !== undefined ? { escalatedAt: patch.escalatedAt } : {}),
        ...(patch.escalatedToRoles !== undefined ? { escalatedToRoles: patch.escalatedToRoles } : {}),
        ...(patch.escalationNote !== undefined ? { escalationNote: patch.escalationNote } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        ...(patch.completedBy !== undefined ? { completedBy: patch.completedBy } : {}),
        ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
      };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async listHumanTasks(filter: HumanTaskFilter = {}): Promise<readonly HumanTask[]> {
    const matched = this.db
      .rows<HumanTask>(TASKS)
      .filter((task) => matchesTaskFilter(task, filter))
      // Most overdue first. The queue exists so a breach is the thing a
      // supervisor sees, not something they have to scroll to.
      .sort((left, right) => {
        const leftDue = left.dueAt ?? "9999";
        const rightDue = right.dueAt ?? "9999";
        if (leftDue !== rightDue) return leftDue < rightDue ? -1 : 1;
        return left.createdAt < right.createdAt ? -1 : 1;
      });
    return matched
      .slice(0, filter.limit ?? matched.length)
      .map((task) => structuredClone(task));
  }
}

/** True when the sweep should pick this instance up. */
function isDue(instance: WorkflowInstance, at: IsoTimestamp): boolean {
  if (isTerminalInstanceStatus(instance.status)) return false;
  // `running` is included so an instance whose owning process died is picked up
  // once its claim lapses. The lease is the engine's policy, not the store's,
  // so the store surfaces the candidate and the engine decides. The cost is one
  // wasted read per actively-running instance per sweep.
  if (instance.tokens.some((token) => token.state === "ready" || token.state === "running")) {
    return true;
  }
  return instance.wakeAt !== undefined && instance.wakeAt <= at;
}

function assertInstanceWritable(instance: WorkflowInstance): void {
  assertIsoUtc("createdAt", instance.createdAt);
  assertIsoUtc("updatedAt", instance.updatedAt);
  assertOptionalIsoUtc("endedAt", instance.endedAt);
  assertOptionalIsoUtc("wakeAt", instance.wakeAt);
  for (const token of instance.tokens) {
    assertIsoUtc(`tokens.${token.stepName}.enteredAt`, token.enteredAt);
    assertOptionalIsoUtc(`tokens.${token.stepName}.wakeAt`, token.wakeAt);
    assertOptionalIsoUtc(`tokens.${token.stepName}.claimedAt`, token.claimedAt);
  }
  if (!Number.isInteger(instance.definitionVersion) || instance.definitionVersion < 1) {
    throw new InvalidInputError(
      `Workflow version must be a positive integer, received: ${String(instance.definitionVersion)}`,
      "definitionVersion",
    );
  }
}

function assertTaskWritable(task: HumanTask): void {
  assertIsoUtc("createdAt", task.createdAt);
  assertOptionalIsoUtc("dueAt", task.dueAt);
  assertOptionalIsoUtc("escalatedAt", task.escalatedAt);
  assertOptionalIsoUtc("completedAt", task.completedAt);
  if (task.assignedRoles.length === 0) {
    throw new InvalidInputError(
      `Task ${task.id} is assigned to no roles, so nobody could ever complete it and the workflow would wait forever.`,
      "assignedRoles",
    );
  }
}

function matchesInstanceFilter(instance: WorkflowInstance, filter: InstanceFilter): boolean {
  if (filter.definitionName !== undefined && instance.definitionName !== filter.definitionName) {
    return false;
  }
  if (filter.status && !filter.status.includes(instance.status)) return false;
  if (filter.runId !== undefined && instance.runId !== filter.runId) return false;
  return true;
}

function matchesTaskFilter(task: HumanTask, filter: HumanTaskFilter): boolean {
  if (filter.instanceId !== undefined && task.instanceId !== filter.instanceId) return false;
  if (filter.workflowName !== undefined && task.workflowName !== filter.workflowName) return false;
  if (filter.status && !filter.status.includes(task.status)) return false;
  if (filter.roles && !filter.roles.some((role) => task.assignedRoles.includes(role))) return false;
  if (filter.breachedAsOf !== undefined) {
    if (task.status !== "open") return false;
    if (task.dueAt === undefined) return false;
    // Strictly past the target. A task due at exactly this instant is on time.
    if (!(task.dueAt < filter.breachedAsOf)) return false;
  }
  return true;
}

function page<T>(rows: readonly T[], limit?: number, offset?: number): readonly T[] {
  const from = offset ?? 0;
  const to = limit === undefined ? rows.length : from + limit;
  return rows.slice(from, to);
}
