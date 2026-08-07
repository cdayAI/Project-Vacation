import type { Clock } from "../kernel/clock.js";
import { canonicalJson } from "../kernel/canonical.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import { storeUnavailable, type Db } from "../store/db.js";
import {
  assertIsoUtc,
  assertOptionalIsoUtc,
  isTerminalStepStatus,
  toStoredUsd,
} from "./migrations.js";
import type { RunStore } from "./port.js";
import type {
  ActorRef,
  CostCategory,
  CostEntry,
  CostSummary,
  NewRun,
  NewStep,
  Run,
  RunCostRollup,
  RunFilter,
  RunPatch,
  RunStatus,
  Step,
  StepKind,
  StepPatch,
  StepStatus,
} from "./types.js";
import { isTerminalRunStatus } from "./types.js";

/**
 * Postgres operating record.
 *
 * The interesting parts are the two operations that cannot be a read followed
 * by a write.
 *
 * `appendStep` takes `SELECT ... FOR NO KEY UPDATE` on the run row before it
 * reads the high-water mark, so concurrent appenders to the same run queue
 * behind each other and each sees the previous one's sequence number. The
 * weaker `FOR NO KEY UPDATE` is used rather than `FOR UPDATE` so that
 * recording a cost against the run — which takes a foreign-key share lock —
 * does not have to wait behind an unrelated step append.
 *
 * `patchStep` takes `SELECT ... FOR UPDATE` on the step row, so two writers
 * racing to finish the same step cannot both observe it as unfinished. One
 * writes the outcome; the other is refused for trying to rewrite it.
 *
 * Every failure the database reports is wrapped in `storeUnavailable`, which
 * raises a `DeniedError`. A caller that cannot reach the operating record must
 * refuse its action rather than perform work nothing will account for.
 */

type RunRow = {
  id: string;
  kind: string;
  status: string;
  mode: string;
  requested_by: ActorRef;
  subject: Record<string, string>;
  correlation_id: string;
  workflow_instance_id: string | null;
  role_id: string | null;
  role_version: number | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  outcome: string | null;
  denial_reason: string | null;
  input_digest: string | null;
  output_digest: string | null;
};

type StepRow = {
  id: string;
  run_id: string;
  seq: number;
  kind: string;
  name: string;
  status: string;
  idempotency_key: string;
  attempt: number;
  started_at: string;
  ended_at: string | null;
  input_digest: string | null;
  output_digest: string | null;
  error: string | null;
  denial_reason: string | null;
  detail: Record<string, string | number | boolean>;
};

type CostRow = {
  run_id: string;
  step_id: string | null;
  category: string;
  amount_usd: string;
  units: string | null;
  model_id: string | null;
  recorded_at: string;
  detail: Record<string, string | number> | null;
};

const RUN_COLUMNS = `id, kind, status, mode, requested_by, subject, correlation_id,
  workflow_instance_id, role_id, role_version, created_at, started_at, ended_at,
  outcome, denial_reason, input_digest, output_digest`;

const STEP_COLUMNS = `id, run_id, seq, kind, name, status, idempotency_key, attempt,
  started_at, ended_at, input_digest, output_digest, error, denial_reason, detail`;

const COST_COLUMNS = `run_id, step_id, category, amount_usd, units, model_id, recorded_at, detail`;

const RUN_PATCH_COLUMNS: Readonly<Record<keyof RunPatch, string>> = {
  status: "status",
  mode: "mode",
  startedAt: "started_at",
  endedAt: "ended_at",
  outcome: "outcome",
  denialReason: "denial_reason",
  outputDigest: "output_digest",
};

const STEP_PATCH_COLUMNS: Readonly<Record<keyof StepPatch, string>> = {
  status: "status",
  endedAt: "ended_at",
  outputDigest: "output_digest",
  error: "error",
  denialReason: "denial_reason",
  detail: "detail",
};

export class PgRunStore implements RunStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async createRun(run: NewRun): Promise<Run> {
    const record: Run = {
      ...run,
      id: run.id ?? this.ids.next("run"),
      status: run.status ?? "pending",
      createdAt: this.clock.nowIso(),
    };
    assertOptionalIsoUtc("startedAt", record.startedAt);
    assertOptionalIsoUtc("endedAt", record.endedAt);

    const rows = await this.run("createRun", () =>
      this.db.query<RunRow>(
        `INSERT INTO run (${RUN_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${RUN_COLUMNS}`,
        [
          record.id,
          record.kind,
          record.status,
          record.mode,
          record.requestedBy,
          record.subject,
          record.correlationId,
          record.workflowInstanceId ?? null,
          record.roleId ?? null,
          record.roleVersion ?? null,
          record.createdAt,
          record.startedAt ?? null,
          record.endedAt ?? null,
          record.outcome ?? null,
          record.denialReason ?? null,
          record.inputDigest ?? null,
          record.outputDigest ?? null,
        ],
      ),
    );

    const row = rows[0];
    if (!row) {
      throw new InvalidInputError(
        `Run ${record.id} already exists. Run identifiers are assigned once; reusing one would overwrite a unit of work that already happened.`,
        "id",
      );
    }
    return toRun(row);
  }

  async getRun(id: Id<"run">): Promise<Run | null> {
    const rows = await this.run("getRun", () =>
      this.db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM run WHERE id = $1`, [id]),
    );
    const row = rows[0];
    return row ? toRun(row) : null;
  }

  async requireRun(id: Id<"run">): Promise<Run> {
    const found = await this.getRun(id);
    if (!found) {
      throw new DeniedError("record.unavailable", `Run ${id} is not in the operating record.`, {
        runId: id,
      });
    }
    return found;
  }

  async patchRun(id: Id<"run">, patch: RunPatch): Promise<Run> {
    assertOptionalIsoUtc("startedAt", patch.startedAt);
    assertOptionalIsoUtc("endedAt", patch.endedAt);

    return this.run("patchRun", () =>
      this.db.transaction(async (tx) => {
        const current = (
          await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM run WHERE id = $1 FOR UPDATE`, [id])
        )[0];
        if (!current) {
          throw new DeniedError("record.unavailable", `Run ${id} is not in the operating record.`, {
            runId: id,
          });
        }

        if (
          isTerminalRunStatus(current.status as RunStatus) &&
          patch.status !== undefined &&
          patch.status !== current.status
        ) {
          throw new DeniedError(
            "record.unavailable",
            `Run ${id} already ended as ${current.status} and cannot be moved to ${patch.status}. A finished run is history.`,
            { runId: id, from: current.status, to: patch.status },
          );
        }

        const assignments = buildAssignments(patch, RUN_PATCH_COLUMNS);
        if (assignments.sql.length === 0) return toRun(current);

        const updated = (
          await tx.query<RunRow>(
            `UPDATE run SET ${assignments.sql.join(", ")} WHERE id = $${assignments.values.length + 1}
             RETURNING ${RUN_COLUMNS}`,
            [...assignments.values, id],
          )
        )[0];
        if (!updated) {
          throw new DeniedError("record.unavailable", `Run ${id} vanished mid-update.`, {
            runId: id,
          });
        }
        return toRun(updated);
      }),
    );
  }

  async listRuns(filter: RunFilter = {}): Promise<readonly Run[]> {
    const query = runFilterSql(filter);
    const values = [...query.values];
    const limit = pageSql(filter, values);
    // Newest first, with the insertion ordinal as the tiebreak. Under a fixed
    // clock every run in a test shares a created_at, and without the tiebreak
    // the order would be whatever the planner felt like.
    const rows = await this.run("listRuns", () =>
      this.db.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM run ${query.where}
         ORDER BY created_at DESC, ordinal DESC${limit}`,
        values,
      ),
    );
    return rows.map(toRun);
  }

  async countRuns(filter: RunFilter = {}): Promise<number> {
    const query = runFilterSql(filter);
    const rows = await this.run("countRuns", () =>
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM run ${query.where}`, query.values),
    );
    return Number(rows[0]?.count ?? 0);
  }

  async appendStep(step: NewStep): Promise<Step> {
    assertIdempotencyKey(step.idempotencyKey);
    const startedAt = step.startedAt ?? this.clock.nowIso();
    assertIsoUtc("startedAt", startedAt);
    assertOptionalIsoUtc("endedAt", step.endedAt);

    const id = step.id ?? this.ids.next("step");

    return this.run("appendStep", () =>
      this.db.transaction(async (tx) => {
        // Serialise appenders for this run. The lock is taken on the run row
        // rather than on the step table so that two different runs can append
        // concurrently, which is the common case.
        const owner = await tx.query<{ id: string }>(
          "SELECT id FROM run WHERE id = $1 FOR NO KEY UPDATE",
          [step.runId],
        );
        if (owner.length === 0) {
          throw new DeniedError(
            "record.unavailable",
            `Cannot append a step to run ${step.runId}: no such run in the operating record.`,
            { runId: step.runId },
          );
        }

        const next = await tx.query<{ next: number }>(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_step WHERE run_id = $1",
          [step.runId],
        );
        const seq = next[0]?.next ?? 1;

        // ON CONFLICT targets the primary key only, so a duplicate step id
        // comes back as an empty result and is reported as bad input. A
        // collision on (run_id, seq) is deliberately *not* absorbed here: that
        // would mean the locking above failed, and it must be loud.
        const inserted = await tx.query<StepRow>(
          `INSERT INTO run_step (${STEP_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${STEP_COLUMNS}`,
          [
            id,
            step.runId,
            seq,
            step.kind,
            step.name,
            step.status ?? "pending",
            step.idempotencyKey,
            step.attempt ?? 1,
            startedAt,
            step.endedAt ?? null,
            step.inputDigest ?? null,
            step.outputDigest ?? null,
            step.error ?? null,
            step.denialReason ?? null,
            step.detail ?? {},
          ],
        );
        const row = inserted[0];
        if (!row) {
          // The rollback that follows releases the sequence number this
          // transaction reserved, so a refused append leaves no hole.
          throw new InvalidInputError(
            `Step ${id} already exists. Step identifiers are assigned once.`,
            "id",
          );
        }
        return toStep(row);
      }),
    );
  }

  async patchStep(id: Id<"step">, patch: StepPatch): Promise<Step> {
    assertOptionalIsoUtc("endedAt", patch.endedAt);

    return this.run("patchStep", () =>
      this.db.transaction(async (tx) => {
        const current = (
          await tx.query<StepRow>(`SELECT ${STEP_COLUMNS} FROM run_step WHERE id = $1 FOR UPDATE`, [
            id,
          ])
        )[0];
        if (!current) {
          throw new DeniedError("record.unavailable", `Step ${id} is not in the operating record.`, {
            stepId: id,
          });
        }

        const step = toStep(current);
        if (isTerminalStepStatus(step.status)) {
          if (isNoOpStepPatch(step, patch)) return step;
          throw new DeniedError(
            "record.unavailable",
            `Step ${id} finished as ${step.status} and cannot be changed${patch.status ? ` to ${patch.status}` : ""}. A completed step is history.`,
            { stepId: id, from: step.status, ...(patch.status ? { to: patch.status } : {}) },
          );
        }

        const assignments = buildAssignments(patch, STEP_PATCH_COLUMNS);
        if (assignments.sql.length === 0) return step;

        const updated = (
          await tx.query<StepRow>(
            `UPDATE run_step SET ${assignments.sql.join(", ")}
             WHERE id = $${assignments.values.length + 1}
             RETURNING ${STEP_COLUMNS}`,
            [...assignments.values, id],
          )
        )[0];
        if (!updated) {
          throw new DeniedError("record.unavailable", `Step ${id} vanished mid-update.`, {
            stepId: id,
          });
        }
        return toStep(updated);
      }),
    );
  }

  async getStep(id: Id<"step">): Promise<Step | null> {
    const rows = await this.run("getStep", () =>
      this.db.query<StepRow>(`SELECT ${STEP_COLUMNS} FROM run_step WHERE id = $1`, [id]),
    );
    const row = rows[0];
    return row ? toStep(row) : null;
  }

  async listSteps(runId: Id<"run">): Promise<readonly Step[]> {
    const rows = await this.run("listSteps", () =>
      this.db.query<StepRow>(
        `SELECT ${STEP_COLUMNS} FROM run_step WHERE run_id = $1 ORDER BY seq ASC`,
        [runId],
      ),
    );
    return rows.map(toStep);
  }

  async findStepByIdempotencyKey(key: string): Promise<Step | null> {
    assertIdempotencyKey(key);
    // `=` on the indexed column: an exact byte comparison, never a pattern or a
    // case-insensitive collation. A loose match here would report an external
    // effect as already done when it never happened.
    const rows = await this.run("findStepByIdempotencyKey", () =>
      this.db.query<StepRow>(
        `SELECT ${STEP_COLUMNS} FROM run_step WHERE idempotency_key = $1
         ORDER BY seq ASC, id ASC LIMIT 1`,
        [key],
      ),
    );
    const row = rows[0];
    return row ? toStep(row) : null;
  }

  async recordCost(entry: CostEntry): Promise<void> {
    assertAmount(entry.amountUsd);
    assertIsoUtc("recordedAt", entry.recordedAt);

    // Casts are explicit because a bare parameter inside INSERT ... SELECT has
    // no column to infer its type from.
    const rows = await this.run("recordCost", () =>
      this.db.query<{ run_id: string }>(
        `INSERT INTO run_cost (${COST_COLUMNS})
         SELECT $1::text, $2::text, $3::text, $4::numeric, $5::numeric, $6::text, $7::text, $8::jsonb
         WHERE EXISTS (SELECT 1 FROM run WHERE id = $1)
         RETURNING run_id`,
        [
          entry.runId,
          entry.stepId ?? null,
          entry.category,
          entry.amountUsd,
          entry.units ?? null,
          entry.modelId ?? null,
          entry.recordedAt,
          entry.detail ?? null,
        ],
      ),
    );

    if (rows.length === 0) {
      throw new DeniedError(
        "record.unavailable",
        `Cannot record cost against run ${entry.runId}: no such run in the operating record.`,
        { runId: entry.runId },
      );
    }
  }

  async costForRun(runId: Id<"run">): Promise<CostSummary> {
    const rows = await this.run("costForRun", () =>
      this.db.query<{ category: string; total: string }>(
        `SELECT category, SUM(amount_usd) AS total FROM run_cost WHERE run_id = $1 GROUP BY category`,
        [runId],
      ),
    );
    const byCategory: Record<string, number> = {};
    let totalUsd = 0;
    for (const row of rows) {
      const amount = Number(row.total);
      byCategory[row.category] = amount;
      totalUsd += amount;
    }
    return { totalUsd, byCategory };
  }

  async costSince(since: string): Promise<number> {
    assertIsoUtc("since", since);
    // At or after: an entry recorded exactly on the window boundary was spent
    // inside the window the daily ceiling is asking about.
    const rows = await this.run("costSince", () =>
      this.db.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM run_cost WHERE recorded_at >= $1`,
        [since],
      ),
    );
    return Number(rows[0]?.total ?? 0);
  }

  async costRollupSince(since: string): Promise<readonly RunCostRollup[]> {
    assertIsoUtc("since", since);

    // One query, not one per run. The caller is an operator staring at a spend
    // alert; a report that walks the runs and then asks each one what it cost
    // would issue a query per run at exactly the moment nobody has the time.
    //
    // Grouped by run and category together and folded below, so the category
    // split comes out of the same scan as the totals. The join is inner: a
    // cost row cannot exist without its run (foreign key, ON DELETE RESTRICT),
    // so an outer join could only ever add rows that are not there.
    const rows = await this.run("costRollupSince", () =>
      this.db.query<{
        run_id: string;
        kind: string;
        status: string;
        mode: string;
        role_id: string | null;
        role_version: number | null;
        workflow_instance_id: string | null;
        category: string;
        total: string;
        entries: string;
        last_recorded_at: string;
      }>(
        `SELECT c.run_id, r.kind, r.status, r.mode, r.role_id, r.role_version,
                r.workflow_instance_id, c.category,
                SUM(c.amount_usd) AS total,
                COUNT(*) AS entries,
                MAX(c.recorded_at) AS last_recorded_at
           FROM run_cost c
           JOIN run r ON r.id = c.run_id
          WHERE c.recorded_at >= $1
          GROUP BY c.run_id, r.kind, r.status, r.mode, r.role_id, r.role_version,
                   r.workflow_instance_id, c.category`,
        [since],
      ),
    );

    const byRun = new Map<string, { rollup: RunCostRollup; byCategory: Record<string, number> }>();
    for (const row of rows) {
      let held = byRun.get(row.run_id);
      if (!held) {
        const byCategory: Record<string, number> = {};
        held = {
          byCategory,
          rollup: {
            runId: row.run_id as Id<"run">,
            kind: row.kind,
            status: row.status as RunStatus,
            mode: row.mode as Run["mode"],
            roleId: row.role_id === null ? undefined : (row.role_id as Id<"role">),
            roleVersion: row.role_version === null ? undefined : row.role_version,
            workflowInstanceId:
              row.workflow_instance_id === null
                ? undefined
                : (row.workflow_instance_id as Id<"workflowInstance">),
            totalUsd: 0,
            byCategory,
            entries: 0,
            lastRecordedAt: row.last_recorded_at,
          },
        };
        byRun.set(row.run_id, held);
      }
      const amount = Number(row.total);
      held.byCategory[row.category] = amount;
      held.rollup = {
        ...held.rollup,
        totalUsd: toStoredUsd(held.rollup.totalUsd + amount),
        entries: held.rollup.entries + Number(row.entries),
        lastRecordedAt:
          row.last_recorded_at > held.rollup.lastRecordedAt
            ? row.last_recorded_at
            : held.rollup.lastRecordedAt,
        byCategory: held.byCategory,
      };
    }

    // Most expensive first, so the row that distinguishes a runaway loop from
    // ordinary volume is the first one read.
    return [...byRun.values()]
      .map((held) => held.rollup)
      .sort((a, b) => b.totalUsd - a.totalUsd || a.runId.localeCompare(b.runId));
  }

  async listCostEntries(runId: Id<"run">): Promise<readonly CostEntry[]> {
    const rows = await this.run("listCostEntries", () =>
      this.db.query<CostRow>(
        `SELECT ${COST_COLUMNS} FROM run_cost WHERE run_id = $1 ORDER BY ordinal ASC`,
        [runId],
      ),
    );
    return rows.map(toCostEntry);
  }

  /**
   * Wrap a database failure so it refuses the caller's action.
   *
   * `DeniedError` passes through untouched: a refusal this adapter raised
   * deliberately must not be reported as an infrastructure problem.
   */
  private async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
      throw storeUnavailable(operation, error);
    }
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as RunStatus,
    mode: row.mode as Run["mode"],
    requestedBy: row.requested_by,
    subject: row.subject,
    correlationId: row.correlation_id,
    // NULL becomes undefined rather than null: `{a: null}` and `{}` are
    // different values to the canonical serialiser, and several of these
    // fields end up inside something that gets hashed.
    workflowInstanceId: row.workflow_instance_id ?? undefined,
    roleId: row.role_id ?? undefined,
    roleVersion: row.role_version ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    outcome: row.outcome ?? undefined,
    denialReason: row.denial_reason ?? undefined,
    inputDigest: row.input_digest ?? undefined,
    outputDigest: row.output_digest ?? undefined,
  };
}

function toStep(row: StepRow): Step {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind as StepKind,
    name: row.name,
    status: row.status as StepStatus,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    inputDigest: row.input_digest ?? undefined,
    outputDigest: row.output_digest ?? undefined,
    error: row.error ?? undefined,
    denialReason: row.denial_reason ?? undefined,
    detail: row.detail,
  };
}

function toCostEntry(row: CostRow): CostEntry {
  return {
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    category: row.category as CostCategory,
    // numeric arrives as a string so that a driver cannot round it on the way
    // out; the conversion to a JS number happens once, here.
    amountUsd: Number(row.amount_usd),
    units: row.units === null ? undefined : Number(row.units),
    modelId: row.model_id ?? undefined,
    recordedAt: row.recorded_at,
    detail: row.detail ?? undefined,
  };
}

function assertIdempotencyKey(key: string): void {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new InvalidInputError(
      "A step needs a non-empty idempotency key. A blank key matches every other blank key, and the engine reads a match as proof that an external effect has already happened — so a blank key does not duplicate an effect, it skips one.",
      "idempotencyKey",
    );
  }
}

function assertAmount(amountUsd: number): void {
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) {
    throw new InvalidInputError(
      `Cost amount must be a finite number, received: ${String(amountUsd)}`,
      "amountUsd",
    );
  }
  if (amountUsd < 0) {
    throw new InvalidInputError(
      `Cost amount must not be negative, received: ${amountUsd}. A negative entry would buy back headroom under the spend ceiling that was never released.`,
      "amountUsd",
    );
  }
}

function isNoOpStepPatch(current: Step, patch: StepPatch): boolean {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = (current as unknown as Record<string, unknown>)[key];
    if (canonicalJson(value) !== canonicalJson(existing)) return false;
  }
  return true;
}

function buildAssignments(
  patch: object,
  columns: Readonly<Record<string, string>>,
): { sql: string[]; values: unknown[] } {
  const sql: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // Only declared patch fields reach the SET clause. A caller that passes a
    // whole entity where a patch was expected cannot rewrite its identity or
    // its creation time through this door.
    const column = columns[field];
    if (!column) continue;
    values.push(value);
    sql.push(`${column} = $${values.length}`);
  }
  return { sql, values };
}

function runFilterSql(filter: RunFilter): { where: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];

  const add = (clause: (placeholder: string) => string, value: unknown): void => {
    values.push(value);
    clauses.push(clause(`$${values.length}`));
  };

  if (filter.status && filter.status.length > 0) {
    add((p) => `status = ANY(${p}::text[])`, [...filter.status]);
  }
  if (filter.kind !== undefined) add((p) => `kind = ${p}`, filter.kind);
  if (filter.mode !== undefined) add((p) => `mode = ${p}`, filter.mode);
  if (filter.workflowInstanceId !== undefined) {
    add((p) => `workflow_instance_id = ${p}`, filter.workflowInstanceId);
  }
  if (filter.roleId !== undefined) add((p) => `role_id = ${p}`, filter.roleId);
  if (filter.requestedByActorId !== undefined) {
    add((p) => `requested_by_actor_id = ${p}`, filter.requestedByActorId);
  }
  // Strictly after and strictly before, matching what the words say and what
  // the in-memory adapter does.
  if (filter.createdAfter !== undefined) add((p) => `created_at > ${p}`, filter.createdAfter);
  if (filter.createdBefore !== undefined) add((p) => `created_at < ${p}`, filter.createdBefore);

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

/** Append LIMIT/OFFSET, extending `values` in place. No implicit page size. */
function pageSql(filter: { limit?: number; offset?: number }, values: unknown[]): string {
  let sql = "";
  if (filter.limit !== undefined) {
    values.push(filter.limit);
    sql += ` LIMIT $${values.length}`;
  }
  if (filter.offset !== undefined) {
    values.push(filter.offset);
    sql += ` OFFSET $${values.length}`;
  }
  return sql;
}
