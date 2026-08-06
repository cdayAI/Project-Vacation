import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";
import { storeUnavailable, type Db } from "../store/db.js";
import type { WorkflowStore } from "./port.js";
import {
  isTerminalInstanceStatus,
  type HumanTask,
  type HumanTaskFilter,
  type HumanTaskPatch,
  type HumanTaskStatus,
  type InstanceFilter,
  type InstanceStatus,
  type JoinBarrier,
  type StepOutcome,
  type StepToken,
  type WorkflowContext,
  type WorkflowInstance,
} from "./types.js";

/**
 * Postgres workflow state.
 *
 * `saveInstance` is the interesting one, and it is deliberately not a
 * transaction: it is a single conditional UPDATE with `revision` in the WHERE
 * clause. Zero rows updated means another process moved first, and the caller
 * must re-read rather than overwrite a transition it never saw. That is the
 * whole of the engine's mutual exclusion — the engine claims a step by saving
 * before it acts, so the loser of this swap never reaches the effect.
 *
 * A transaction with `SELECT ... FOR UPDATE` would work too and is worse here:
 * it would hold a row lock across the read, and the pattern the engine uses is
 * read-decide-write with real thinking in between. A conditional UPDATE holds
 * nothing and fails cheaply, which is the right shape when losing is ordinary.
 *
 * Every database failure is wrapped in `storeUnavailable`, which raises a
 * `DeniedError`. An engine that cannot reach its state must refuse to act, not
 * act and hope to record it later.
 */

type InstanceRow = {
  id: string;
  definition_name: string;
  definition_version: number;
  definition_digest: string;
  status: string;
  terminal_status: string | null;
  mode: string;
  run_id: string;
  correlation_id: string;
  requested_by: ActorRef;
  subject: Record<string, string>;
  context: WorkflowContext;
  tokens: StepToken[];
  barriers: JoinBarrier[];
  history: StepOutcome[];
  compensation_queue: string[];
  approvals: Record<string, string>;
  revision: number;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  wake_at: string | null;
  stuck_reason: string | null;
  denial_reason: string | null;
  failure_reason: string | null;
};

type TaskRow = {
  id: string;
  instance_id: string;
  run_id: string;
  workflow_name: string;
  step_name: string;
  title: string;
  assigned_roles: string[];
  status: string;
  created_at: string;
  due_at: string | null;
  escalation_level: number;
  escalated_at: string | null;
  escalated_to_roles: string[];
  escalation_note: string | null;
  completed_at: string | null;
  completed_by: string | null;
  outcome: string | null;
  subject: Record<string, string>;
};

const INSTANCE_COLUMNS = `id, definition_name, definition_version, definition_digest, status,
  terminal_status, mode, run_id, correlation_id, requested_by, subject, context, tokens, barriers,
  history, compensation_queue, approvals, revision, created_at, updated_at, ended_at, wake_at,
  stuck_reason, denial_reason, failure_reason`;

const TASK_COLUMNS = `id, instance_id, run_id, workflow_name, step_name, title, assigned_roles,
  status, created_at, due_at, escalation_level, escalated_at, escalated_to_roles, escalation_note,
  completed_at, completed_by, outcome, subject`;

export class PgWorkflowStore implements WorkflowStore {
  constructor(private readonly db: Db) {}

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
      throw storeUnavailable(operation, error);
    }
  }

  async createInstance(instance: WorkflowInstance): Promise<WorkflowInstance> {
    assertInstanceWritable(instance);
    const rows = await this.guard("createInstance", () =>
      this.db.query<InstanceRow>(
        `INSERT INTO workflow_instance (${INSTANCE_COLUMNS}, runnable)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING ${INSTANCE_COLUMNS}`,
        [
          instance.id,
          instance.definitionName,
          instance.definitionVersion,
          instance.definitionDigest,
          instance.status,
          instance.terminalStatus ?? null,
          instance.mode,
          instance.runId,
          instance.correlationId,
          JSON.stringify(instance.requestedBy),
          JSON.stringify(instance.subject),
          JSON.stringify(instance.context),
          JSON.stringify(instance.tokens),
          JSON.stringify(instance.barriers),
          JSON.stringify(instance.history),
          JSON.stringify(instance.compensationQueue),
          JSON.stringify(instance.approvals),
          Math.max(1, instance.revision),
          instance.createdAt,
          instance.updatedAt,
          instance.endedAt ?? null,
          instance.wakeAt ?? null,
          instance.stuckReason ?? null,
          instance.denialReason ?? null,
          instance.failureReason ?? null,
          isRunnable(instance),
        ],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw storeUnavailable("createInstance", new Error("insert returned no row"));
    }
    return toInstance(row);
  }

  async getInstance(id: Id<"workflowInstance">): Promise<WorkflowInstance | null> {
    const rows = await this.guard("getInstance", () =>
      this.db.query<InstanceRow>(
        `SELECT ${INSTANCE_COLUMNS} FROM workflow_instance WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toInstance(row) : null;
  }

  async requireInstance(id: Id<"workflowInstance">): Promise<WorkflowInstance> {
    const found = await this.getInstance(id);
    if (!found) {
      throw new DeniedError(
        "record.unavailable",
        `Workflow instance ${id} is not in the operating record.`,
        { instanceId: id },
      );
    }
    return found;
  }

  /**
   * Compare-and-swap.
   *
   * The `revision` predicate is the concurrency control. The extra
   * `ended_at IS NULL OR ...` guard refuses to reopen a finished instance,
   * which the memory adapter enforces the same way: a late writer resurrecting
   * a closed case would contradict a run the record has already reported as
   * ended.
   */
  async saveInstance(
    next: WorkflowInstance,
    expectedRevision: number,
  ): Promise<WorkflowInstance | null> {
    assertInstanceWritable(next);
    const rows = await this.guard("saveInstance", () =>
      this.db.query<InstanceRow>(
        `UPDATE workflow_instance SET
           status = $3,
           terminal_status = $4,
           context = $5,
           tokens = $6,
           barriers = $7,
           history = $8,
           compensation_queue = $9,
           approvals = $10,
           updated_at = $11,
           ended_at = $12,
           wake_at = $13,
           stuck_reason = $14,
           denial_reason = $15,
           failure_reason = $16,
           runnable = $17,
           revision = revision + 1
         WHERE id = $1
           AND revision = $2
           AND (status NOT IN ('succeeded','failed','denied','cancelled') OR $18)
         RETURNING ${INSTANCE_COLUMNS}`,
        [
          next.id,
          expectedRevision,
          next.status,
          next.terminalStatus ?? null,
          JSON.stringify(next.context),
          JSON.stringify(next.tokens),
          JSON.stringify(next.barriers),
          JSON.stringify(next.history),
          JSON.stringify(next.compensationQueue),
          JSON.stringify(next.approvals),
          next.updatedAt,
          next.endedAt ?? null,
          next.wakeAt ?? null,
          next.stuckReason ?? null,
          next.denialReason ?? null,
          next.failureReason ?? null,
          isRunnable(next),
          isTerminalInstanceStatus(next.status),
        ],
      ),
    );
    const row = rows[0];
    if (row) return toInstance(row);

    // No row updated. Either the revision was stale — ordinary, and the caller
    // re-reads — or the instance is finished, which is not ordinary and must
    // not be reported as a lost race.
    const current = await this.getInstance(next.id);
    if (!current) {
      throw new DeniedError(
        "record.unavailable",
        `Workflow instance ${next.id} is not in the operating record.`,
        { instanceId: next.id },
      );
    }
    if (isTerminalInstanceStatus(current.status) && !isTerminalInstanceStatus(next.status)) {
      throw new DeniedError(
        "record.unavailable",
        `Workflow instance ${next.id} already ended as ${current.status} and cannot be moved back to ${next.status}.`,
        { instanceId: next.id, from: current.status, to: next.status },
      );
    }
    return null;
  }

  async listInstances(filter: InstanceFilter = {}): Promise<readonly WorkflowInstance[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.definitionName !== undefined) {
      params.push(filter.definitionName);
      where.push(`definition_name = $${params.length}`);
    }
    if (filter.status && filter.status.length > 0) {
      params.push([...filter.status]);
      where.push(`status = ANY($${params.length})`);
    }
    if (filter.runId !== undefined) {
      params.push(filter.runId);
      where.push(`run_id = $${params.length}`);
    }
    let sql = `SELECT ${INSTANCE_COLUMNS} FROM workflow_instance`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY created_at DESC, ordinal DESC";
    if (filter.limit !== undefined) {
      params.push(filter.limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (filter.offset !== undefined) {
      params.push(filter.offset);
      sql += ` OFFSET $${params.length}`;
    }
    const rows = await this.guard("listInstances", () =>
      this.db.query<InstanceRow>(sql, params),
    );
    return rows.map(toInstance);
  }

  async countInstances(filter: InstanceFilter = {}): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.definitionName !== undefined) {
      params.push(filter.definitionName);
      where.push(`definition_name = $${params.length}`);
    }
    if (filter.status && filter.status.length > 0) {
      params.push([...filter.status]);
      where.push(`status = ANY($${params.length})`);
    }
    if (filter.runId !== undefined) {
      params.push(filter.runId);
      where.push(`run_id = $${params.length}`);
    }
    let sql = "SELECT count(*)::int AS total FROM workflow_instance";
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    const rows = await this.guard("countInstances", () =>
      this.db.query<{ total: number }>(sql, params),
    );
    return rows[0]?.total ?? 0;
  }

  async dueInstances(at: IsoTimestamp, limit = 50): Promise<readonly WorkflowInstance[]> {
    assertIsoUtc("at", at);
    const rows = await this.guard("dueInstances", () =>
      this.db.query<InstanceRow>(
        `SELECT ${INSTANCE_COLUMNS} FROM workflow_instance
         WHERE ended_at IS NULL
           AND (runnable OR (wake_at IS NOT NULL AND wake_at <= $1))
         ORDER BY updated_at ASC
         LIMIT $2`,
        [at, limit],
      ),
    );
    return rows.map(toInstance);
  }

  async createHumanTask(task: HumanTask): Promise<HumanTask> {
    assertTaskWritable(task);
    const rows = await this.guard("createHumanTask", () =>
      this.db.query<TaskRow>(
        `INSERT INTO workflow_human_task (${TASK_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING ${TASK_COLUMNS}`,
        [
          task.id,
          task.instanceId,
          task.runId,
          task.workflowName,
          task.stepName,
          task.title,
          JSON.stringify([...task.assignedRoles]),
          task.status,
          task.createdAt,
          task.dueAt ?? null,
          task.escalationLevel,
          task.escalatedAt ?? null,
          JSON.stringify([...task.escalatedToRoles]),
          task.escalationNote ?? null,
          task.completedAt ?? null,
          task.completedBy ?? null,
          task.outcome ?? null,
          JSON.stringify(task.subject),
        ],
      ),
    );
    const row = rows[0];
    if (!row) throw storeUnavailable("createHumanTask", new Error("insert returned no row"));
    return toTask(row);
  }

  async getHumanTask(id: Id<"step">): Promise<HumanTask | null> {
    const rows = await this.guard("getHumanTask", () =>
      this.db.query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM workflow_human_task WHERE id = $1`, [id]),
    );
    const row = rows[0];
    return row ? toTask(row) : null;
  }

  /**
   * Patch a task under a row lock.
   *
   * Locked because two sweeps racing to escalate the same breach would
   * otherwise both read level 0 and both write level 1, notifying twice. The
   * `escalation_level` guard makes the write monotonic regardless.
   */
  async patchHumanTask(id: Id<"step">, patch: HumanTaskPatch): Promise<HumanTask> {
    assertOptionalIsoUtc("escalatedAt", patch.escalatedAt);
    assertOptionalIsoUtc("completedAt", patch.completedAt);

    return this.guard("patchHumanTask", () =>
      this.db.transaction(async (tx) => {
        const currentRows = await tx.query<TaskRow>(
          `SELECT ${TASK_COLUMNS} FROM workflow_human_task WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const current = currentRows[0];
        if (!current) {
          throw new DeniedError("record.unavailable", `Task ${id} is not on any queue.`, {
            taskId: id,
          });
        }
        if (
          current.status !== "open" &&
          patch.status !== undefined &&
          patch.status !== current.status
        ) {
          throw new DeniedError(
            "record.unavailable",
            `Task ${id} is already ${current.status} and cannot be moved to ${patch.status}.`,
            { taskId: id, from: current.status, to: patch.status },
          );
        }
        if (
          patch.escalationLevel !== undefined &&
          patch.escalationLevel < current.escalation_level
        ) {
          throw new InvalidInputError(
            `Task ${id} is at escalation level ${current.escalation_level}; it cannot be lowered to ${patch.escalationLevel}.`,
            "escalationLevel",
          );
        }

        const rows = await tx.query<TaskRow>(
          `UPDATE workflow_human_task SET
             status = COALESCE($2, status),
             escalation_level = GREATEST(escalation_level, COALESCE($3, escalation_level)),
             escalated_at = COALESCE($4, escalated_at),
             escalated_to_roles = COALESCE($5, escalated_to_roles),
             escalation_note = COALESCE($6, escalation_note),
             completed_at = COALESCE($7, completed_at),
             completed_by = COALESCE($8, completed_by),
             outcome = COALESCE($9, outcome)
           WHERE id = $1
           RETURNING ${TASK_COLUMNS}`,
          [
            id,
            patch.status ?? null,
            patch.escalationLevel ?? null,
            patch.escalatedAt ?? null,
            patch.escalatedToRoles ? JSON.stringify([...patch.escalatedToRoles]) : null,
            patch.escalationNote ?? null,
            patch.completedAt ?? null,
            patch.completedBy ?? null,
            patch.outcome ?? null,
          ],
        );
        const row = rows[0];
        if (!row) throw storeUnavailable("patchHumanTask", new Error("update returned no row"));
        return toTask(row);
      }),
    );
  }

  async listHumanTasks(filter: HumanTaskFilter = {}): Promise<readonly HumanTask[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.instanceId !== undefined) {
      params.push(filter.instanceId);
      where.push(`instance_id = $${params.length}`);
    }
    if (filter.workflowName !== undefined) {
      params.push(filter.workflowName);
      where.push(`workflow_name = $${params.length}`);
    }
    if (filter.status && filter.status.length > 0) {
      params.push([...filter.status]);
      where.push(`status = ANY($${params.length})`);
    }
    if (filter.roles && filter.roles.length > 0) {
      params.push(JSON.stringify([...filter.roles]));
      // Overlap rather than containment: the caller's roles are the set the
      // person holds, and any one of them is enough to see the task.
      where.push(`assigned_roles ?| ARRAY(SELECT jsonb_array_elements_text($${params.length}::jsonb))`);
    }
    if (filter.breachedAsOf !== undefined) {
      assertIsoUtc("breachedAsOf", filter.breachedAsOf);
      params.push(filter.breachedAsOf);
      where.push(`status = 'open' AND due_at IS NOT NULL AND due_at < $${params.length}`);
    }

    let sql = `SELECT ${TASK_COLUMNS} FROM workflow_human_task`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    // Most overdue first, so the breach queue reads top-down by urgency.
    sql += " ORDER BY due_at ASC NULLS LAST, created_at ASC";
    if (filter.limit !== undefined) {
      params.push(filter.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const rows = await this.guard("listHumanTasks", () => this.db.query<TaskRow>(sql, params));
    return rows.map(toTask);
  }
}

/** Denormalised for the sweep's index. Kept beside the save that writes it. */
function isRunnable(instance: WorkflowInstance): boolean {
  if (isTerminalInstanceStatus(instance.status)) return false;
  return instance.tokens.some((token) => token.state === "ready" || token.state === "running");
}

function toInstance(row: InstanceRow): WorkflowInstance {
  return {
    id: row.id,
    definitionName: row.definition_name,
    definitionVersion: row.definition_version,
    definitionDigest: row.definition_digest,
    status: row.status as InstanceStatus,
    terminalStatus: (row.terminal_status ?? undefined) as WorkflowInstance["terminalStatus"],
    mode: row.mode as WorkflowInstance["mode"],
    runId: row.run_id,
    correlationId: row.correlation_id,
    requestedBy: row.requested_by,
    subject: row.subject ?? {},
    context: row.context ?? {},
    tokens: row.tokens ?? [],
    barriers: row.barriers ?? [],
    history: row.history ?? [],
    compensationQueue: row.compensation_queue ?? [],
    approvals: row.approvals ?? {},
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at ?? undefined,
    wakeAt: row.wake_at ?? undefined,
    stuckReason: row.stuck_reason ?? undefined,
    denialReason: row.denial_reason ?? undefined,
    failureReason: row.failure_reason ?? undefined,
  };
}

function toTask(row: TaskRow): HumanTask {
  return {
    id: row.id,
    instanceId: row.instance_id,
    runId: row.run_id,
    workflowName: row.workflow_name,
    stepName: row.step_name,
    title: row.title,
    assignedRoles: row.assigned_roles ?? [],
    status: row.status as HumanTaskStatus,
    createdAt: row.created_at,
    dueAt: row.due_at ?? undefined,
    escalationLevel: row.escalation_level,
    escalatedAt: row.escalated_at ?? undefined,
    escalatedToRoles: row.escalated_to_roles ?? [],
    escalationNote: row.escalation_note ?? undefined,
    completedAt: row.completed_at ?? undefined,
    completedBy: row.completed_by ?? undefined,
    outcome: row.outcome ?? undefined,
    subject: row.subject ?? {},
  };
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
