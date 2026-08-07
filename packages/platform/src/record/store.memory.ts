import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import { canonicalJson } from "../kernel/canonical.js";
import type { MemoryDb } from "../store/db.js";
import {
  assertIsoUtc,
  assertOptionalIsoUtc,
  isTerminalStepStatus,
  toStoredUsd,
} from "./migrations.js";
import type { RunStore } from "./port.js";
import type {
  CostEntry,
  CostSummary,
  NewRun,
  NewStep,
  Run,
  RunCostRollup,
  RunFilter,
  RunPatch,
  Step,
  StepPatch,
} from "./types.js";
import { isTerminalRunStatus } from "./types.js";

/**
 * In-memory operating record.
 *
 * Used by the test suite, by local development, and by the seeded demo. It is
 * held to the same contract as the Postgres adapter — the shared suite in
 * `store/store.contract.test.ts` runs every assertion against both — because a
 * fake that is more forgiving than the real store is worse than no fake at
 * all: it makes the tests pass on code that will fail in production.
 *
 * Two things are therefore done the hard way rather than the convenient way.
 *
 * Operations the port specifies as atomic take `MemoryDb.withLock`, mirroring
 * the row lock the Postgres adapter takes. Stated honestly: the bodies below
 * contain no await, so on a single-threaded runtime they could not interleave
 * even without the lock. The lock is taken anyway, because the atomicity is a
 * property of the *contract* rather than of the runtime, and because the first
 * await added to one of these bodies later — a metric, a persistence hook, a
 * hash — would silently reopen a window nobody would think to look for.
 *
 * Everything is cloned on the way in and on the way out. A caller that keeps a
 * reference to the object it stored, or mutates the object it was handed, must
 * not be able to rewrite the operating record after the fact — that is exactly
 * the property the Postgres adapter has for free, and the fake has to earn.
 */

const RUNS = "run";
const STEPS = "run_step";
const STEP_SEQ = "run_step_seq";
const COSTS = "run_cost";

export class MemoryRunStore implements RunStore {
  constructor(
    private readonly db: MemoryDb,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async createRun(run: NewRun): Promise<Run> {
    const id = run.id ?? this.ids.next("run");
    const record: Run = {
      ...run,
      id,
      status: run.status ?? "pending",
      createdAt: this.clock.nowIso(),
    };
    assertOptionalIsoUtc("startedAt", record.startedAt);
    assertOptionalIsoUtc("endedAt", record.endedAt);

    return this.db.withLock(`record:run:${id}`, async () => {
      const table = this.db.table<Run>(RUNS);
      if (table.has(id)) {
        throw new InvalidInputError(
          `Run ${id} already exists. Run identifiers are assigned once; reusing one would overwrite a unit of work that already happened.`,
          "id",
        );
      }
      table.set(id, structuredClone(record));
      return structuredClone(record);
    });
  }

  async getRun(id: Id<"run">): Promise<Run | null> {
    const found = this.db.table<Run>(RUNS).get(id);
    return found ? structuredClone(found) : null;
  }

  async requireRun(id: Id<"run">): Promise<Run> {
    const found = await this.getRun(id);
    if (!found) {
      // "No such run" is refused rather than returned as an empty result: a
      // caller acting on a run that is not in the record has lost track of
      // what it is doing, and continuing would produce work nothing accounts
      // for.
      throw new DeniedError("record.unavailable", `Run ${id} is not in the operating record.`, {
        runId: id,
      });
    }
    return found;
  }

  async patchRun(id: Id<"run">, patch: RunPatch): Promise<Run> {
    return this.db.withLock(`record:run:${id}`, async () => {
      const table = this.db.table<Run>(RUNS);
      const current = table.get(id);
      if (!current) {
        throw new DeniedError("record.unavailable", `Run ${id} is not in the operating record.`, {
          runId: id,
        });
      }

      assertOptionalIsoUtc("startedAt", patch.startedAt);
      assertOptionalIsoUtc("endedAt", patch.endedAt);

      // How a run ended is the answer to "what did this system do". Once it is
      // recorded, moving it to another outcome rewrites history rather than
      // reporting it.
      if (
        isTerminalRunStatus(current.status) &&
        patch.status !== undefined &&
        patch.status !== current.status
      ) {
        throw new DeniedError(
          "record.unavailable",
          `Run ${id} already ended as ${current.status} and cannot be moved to ${patch.status}. A finished run is history.`,
          { runId: id, from: current.status, to: patch.status },
        );
      }

      // Field by field rather than a spread. A caller that passes a whole run
      // where a patch was expected cannot rewrite its id, its creation time,
      // or who requested it through this door — which is exactly what a spread
      // of an untyped object would allow.
      const next: Run = {
        ...current,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
        ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
        ...(patch.denialReason !== undefined ? { denialReason: patch.denialReason } : {}),
        ...(patch.outputDigest !== undefined ? { outputDigest: patch.outputDigest } : {}),
      };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async listRuns(filter: RunFilter = {}): Promise<readonly Run[]> {
    const rows = this.db.rows<Run>(RUNS);
    const ordinals = new Map(rows.map((run, index) => [run.id, index]));
    const matched = rows.filter((run) => matchesRunFilter(run, filter));

    // Newest first, with insertion order as the tiebreak. Under a fixed clock
    // every run in a test shares a createdAt, so without the tiebreak the
    // order would depend on sort stability rather than on anything meaningful.
    matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
      return (ordinals.get(right.id) ?? 0) - (ordinals.get(left.id) ?? 0);
    });

    return page(matched, filter.limit, filter.offset).map((run) => structuredClone(run));
  }

  async countRuns(filter: RunFilter = {}): Promise<number> {
    // Deliberately ignores limit and offset: a count that respected the page
    // size could never tell a caller how many pages there are.
    return this.db.rows<Run>(RUNS).filter((run) => matchesRunFilter(run, filter)).length;
  }

  async appendStep(step: NewStep): Promise<Step> {
    assertIdempotencyKey(step.idempotencyKey);
    const startedAt = step.startedAt ?? this.clock.nowIso();
    assertIsoUtc("startedAt", startedAt);
    assertOptionalIsoUtc("endedAt", step.endedAt);

    return this.db.withLock(`record:steps:${step.runId}`, async () => {
      if (!this.db.table<Run>(RUNS).has(step.runId)) {
        throw new DeniedError(
          "record.unavailable",
          `Cannot append a step to run ${step.runId}: no such run in the operating record.`,
          { runId: step.runId },
        );
      }

      const id = step.id ?? this.ids.next("step");
      const table = this.db.table<Step>(STEPS);
      // Checked before the counter moves. The Postgres adapter does this work
      // inside a transaction, so a rejected append leaves its sequence number
      // unclaimed; claiming one here would leave a hole in the step history
      // that the real store never produces.
      if (table.has(id)) {
        throw new InvalidInputError(`Step ${id} already exists.`, "id");
      }

      const counters = this.db.table<number>(STEP_SEQ);
      // Read and increment inside the lock. Two appenders that both read the
      // same high-water mark would both be handed the same sequence number,
      // and the step history for that run would fork.
      const seq = (counters.get(step.runId) ?? 0) + 1;
      counters.set(step.runId, seq);

      const record: Step = {
        ...step,
        id,
        seq,
        startedAt,
        status: step.status ?? "pending",
        attempt: step.attempt ?? 1,
        detail: step.detail ?? {},
      };
      table.set(id, structuredClone(record));
      return structuredClone(record);
    });
  }

  async patchStep(id: Id<"step">, patch: StepPatch): Promise<Step> {
    return this.db.withLock(`record:step:${id}`, async () => {
      const table = this.db.table<Step>(STEPS);
      const current = table.get(id);
      if (!current) {
        throw new DeniedError("record.unavailable", `Step ${id} is not in the operating record.`, {
          stepId: id,
        });
      }

      assertOptionalIsoUtc("endedAt", patch.endedAt);

      if (isTerminalStepStatus(current.status)) {
        // A repeat of a patch already applied is allowed through unchanged, so
        // that a retry of the crash-then-recover path is not itself an error.
        // Anything that would actually change the step is refused.
        if (isNoOpStepPatch(current, patch)) return structuredClone(current);
        throw new DeniedError(
          "record.unavailable",
          `Step ${id} finished as ${current.status} and cannot be changed${patch.status ? ` to ${patch.status}` : ""}. A completed step is history.`,
          { stepId: id, from: current.status, ...(patch.status ? { to: patch.status } : {}) },
        );
      }

      const next: Step = {
        ...current,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
        ...(patch.outputDigest !== undefined ? { outputDigest: patch.outputDigest } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.denialReason !== undefined ? { denialReason: patch.denialReason } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async getStep(id: Id<"step">): Promise<Step | null> {
    const found = this.db.table<Step>(STEPS).get(id);
    return found ? structuredClone(found) : null;
  }

  async listSteps(runId: Id<"run">): Promise<readonly Step[]> {
    return this.db
      .rows<Step>(STEPS)
      .filter((step) => step.runId === runId)
      .sort((left, right) => left.seq - right.seq)
      .map((step) => structuredClone(step));
  }

  async findStepByIdempotencyKey(key: string): Promise<Step | null> {
    assertIdempotencyKey(key);
    // Exact match, never a prefix or a case-insensitive one. The engine reads
    // a hit as "this external effect has already happened", so a loose match
    // would silently skip an effect that was never performed.
    const matches = this.db.rows<Step>(STEPS).filter((step) => step.idempotencyKey === key);
    if (matches.length === 0) return null;
    // The earliest step owns the effect. Later ones, if a caller ever creates
    // them, are retries of it.
    const earliest = matches.reduce((best, step) => (step.seq < best.seq ? step : best));
    return structuredClone(earliest);
  }

  async recordCost(entry: CostEntry): Promise<void> {
    assertAmount(entry.amountUsd);
    assertIsoUtc("recordedAt", entry.recordedAt);

    await this.db.withLock(COSTS, async () => {
      if (!this.db.table<Run>(RUNS).has(entry.runId)) {
        throw new DeniedError(
          "record.unavailable",
          `Cannot record cost against run ${entry.runId}: no such run in the operating record.`,
          { runId: entry.runId },
        );
      }
      const table = this.db.table<CostEntry>(COSTS);
      // Cost entries have no identity of their own; the table's size is a
      // monotonic counter because nothing is ever removed from it.
      table.set(`${table.size}`, structuredClone(entry));
    });
  }

  async costForRun(runId: Id<"run">): Promise<CostSummary> {
    const byCategory: Record<string, number> = {};
    let totalUsd = 0;
    for (const entry of this.db.rows<CostEntry>(COSTS)) {
      if (entry.runId !== runId) continue;
      // Snapped to the column's scale after each addition, so this total is
      // the one Postgres's exact decimal SUM produces rather than a binary
      // approximation of it. See `toStoredUsd`.
      totalUsd = toStoredUsd(totalUsd + entry.amountUsd);
      byCategory[entry.category] = toStoredUsd(
        (byCategory[entry.category] ?? 0) + entry.amountUsd,
      );
    }
    return { totalUsd, byCategory };
  }

  async costSince(since: string): Promise<number> {
    assertIsoUtc("since", since);
    // At or after: the daily ceiling asks "how much has been spent in the last
    // 24 hours", and an entry recorded exactly on the boundary was spent
    // inside that window.
    return this.db
      .rows<CostEntry>(COSTS)
      .filter((entry) => entry.recordedAt >= since)
      .reduce((total, entry) => toStoredUsd(total + entry.amountUsd), 0);
  }

  async costRollupSince(since: string): Promise<readonly RunCostRollup[]> {
    assertIsoUtc("since", since);

    const runs = this.db.table<Run>(RUNS);
    const accumulator = new Map<
      string,
      { rollup: RunCostRollup; byCategory: Record<string, number> }
    >();

    for (const entry of this.db.rows<CostEntry>(COSTS)) {
      if (entry.recordedAt < since) continue;

      let held = accumulator.get(entry.runId);
      if (!held) {
        const run = runs.get(entry.runId);
        if (!run) {
          // Unreachable: `recordCost` refuses spend against a run that is not
          // in the record, and nothing deletes a run. Kept because a cost
          // entry with no run would otherwise silently vanish from a report
          // that is supposed to reconcile with the spend meter.
          throw new DeniedError(
            "record.unavailable",
            `Cost is recorded against run ${entry.runId}, which is not in the operating record.`,
            { runId: entry.runId },
          );
        }
        const byCategory: Record<string, number> = {};
        held = {
          byCategory,
          rollup: {
            runId: run.id,
            kind: run.kind,
            status: run.status,
            mode: run.mode,
            roleId: run.roleId,
            roleVersion: run.roleVersion,
            workflowInstanceId: run.workflowInstanceId,
            totalUsd: 0,
            byCategory,
            entries: 0,
            lastRecordedAt: entry.recordedAt,
          },
        };
        accumulator.set(entry.runId, held);
      }

      // Snapped after each addition for the same reason `costForRun` snaps:
      // these totals are compared against the figure Postgres produces with
      // exact decimal arithmetic, and unsnapped binary sums drift off it.
      held.byCategory[entry.category] = toStoredUsd(
        (held.byCategory[entry.category] ?? 0) + entry.amountUsd,
      );
      held.rollup = {
        ...held.rollup,
        totalUsd: toStoredUsd(held.rollup.totalUsd + entry.amountUsd),
        entries: held.rollup.entries + 1,
        lastRecordedAt:
          entry.recordedAt > held.rollup.lastRecordedAt
            ? entry.recordedAt
            : held.rollup.lastRecordedAt,
        byCategory: held.byCategory,
      };
    }

    // Most expensive first. The one row that answers "loop or volume?" is then
    // the first row, which is the whole point of reading this during an alert.
    return [...accumulator.values()]
      .map((held) => held.rollup)
      .sort((a, b) => b.totalUsd - a.totalUsd || a.runId.localeCompare(b.runId));
  }

  async listCostEntries(runId: Id<"run">): Promise<readonly CostEntry[]> {
    return this.db
      .rows<CostEntry>(COSTS)
      .filter((entry) => entry.runId === runId)
      .map((entry) => structuredClone(entry));
  }
}

/** Convenience factory matching the Postgres adapter's shape. */
export function createMemoryRunStore(
  db: MemoryDb,
  clock: Clock,
  ids: IdGenerator,
): MemoryRunStore {
  return new MemoryRunStore(db, clock, ids);
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
    throw new InvalidInputError(`Cost amount must be a finite number, received: ${String(amountUsd)}`, "amountUsd");
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

function matchesRunFilter(run: Run, filter: RunFilter): boolean {
  if (filter.status && !filter.status.includes(run.status)) return false;
  if (filter.kind !== undefined && run.kind !== filter.kind) return false;
  if (filter.mode !== undefined && run.mode !== filter.mode) return false;
  if (filter.workflowInstanceId !== undefined && run.workflowInstanceId !== filter.workflowInstanceId)
    return false;
  if (filter.roleId !== undefined && run.roleId !== filter.roleId) return false;
  if (
    filter.requestedByActorId !== undefined &&
    run.requestedBy.actorId !== filter.requestedByActorId
  ) {
    return false;
  }
  // Strictly after and strictly before, matching what the words say. The
  // Postgres adapter uses the same comparison so a boundary row cannot appear
  // in one adapter and not the other.
  if (filter.createdAfter !== undefined && !(run.createdAt > filter.createdAfter)) return false;
  if (filter.createdBefore !== undefined && !(run.createdAt < filter.createdBefore)) return false;
  return true;
}

function page<T>(rows: readonly T[], limit?: number, offset?: number): readonly T[] {
  const from = offset ?? 0;
  // No implicit page size. A silently truncated listing is indistinguishable
  // from a short one, and "the console showed everything" is a claim the
  // operating record has to be able to make. Paging belongs to the caller.
  const to = limit === undefined ? rows.length : from + limit;
  return rows.slice(from, to);
}
