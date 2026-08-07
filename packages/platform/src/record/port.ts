/**
 * The largest exact run count the operating record reports.
 *
 * An unfiltered `COUNT(*)` is a sequential scan Postgres cannot answer from any
 * index, and it grows with the whole run history on the console's default
 * screen — for a number whose precision stops mattering once it is large. Both
 * adapters therefore stop counting at this bound and the caller renders
 * "10,000+" rather than a figure it paid a table scan for.
 *
 * Declared here, in the contract, so the two adapters cannot cap differently.
 */
export const RUN_COUNT_CAP = 10_000;

import type { Id } from "../kernel/ids.js";
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

/**
 * Persistence port for the operating record.
 *
 * Modules depend on this interface, never on a concrete adapter. Two adapters
 * exist — Postgres for real deployments, in-memory for tests, local
 * development, and the seeded demo — and a shared contract test suite runs
 * against both, so the fake cannot drift into being more forgiving than the
 * real thing.
 *
 * Implementations must guarantee:
 *   - `appendStep` assigns `seq` monotonically within a run, atomically, so two
 *     concurrent writers cannot produce the same sequence number.
 *   - Steps and cost entries are never mutated destructively; `patchStep` may
 *     only advance a step toward a terminal state.
 *   - A read that cannot be served raises rather than returning an empty
 *     result. An empty operating record and an unreadable one must never look
 *     the same to a caller, because one is "nothing happened" and the other is
 *     "we do not know what happened".
 */
export interface RunStore {
  createRun(run: NewRun): Promise<Run>;
  getRun(id: Id<"run">): Promise<Run | null>;
  /** @throws if the run does not exist. */
  requireRun(id: Id<"run">): Promise<Run>;
  patchRun(id: Id<"run">, patch: RunPatch): Promise<Run>;
  listRuns(filter?: RunFilter): Promise<readonly Run[]>;
  countRuns(filter?: RunFilter): Promise<number>;

  appendStep(step: NewStep): Promise<Step>;
  patchStep(id: Id<"step">, patch: StepPatch): Promise<Step>;
  getStep(id: Id<"step">): Promise<Step | null>;
  listSteps(runId: Id<"run">): Promise<readonly Step[]>;
  /**
   * Find a step already recorded under this idempotency key.
   *
   * The engine calls this before performing an external effect. If a step is
   * returned, the effect already happened and must not happen again.
   */
  findStepByIdempotencyKey(key: string): Promise<Step | null>;

  recordCost(entry: CostEntry): Promise<void>;
  costForRun(runId: Id<"run">): Promise<CostSummary>;
  /** Total spend recorded since `since`, used by the daily ceiling. */
  costSince(since: string): Promise<number>;
  /**
   * The same window as `costSince`, broken down per run.
   *
   * Implementations must return every run with spend at or after `since` and
   * no others, and the totals must sum to `costSince(since)` — the spend meter
   * and the spend report have to be the same number, or an operator raising a
   * ceiling is reasoning from a figure the ceiling does not use.
   */
  costRollupSince(since: string): Promise<readonly RunCostRollup[]>;
  listCostEntries(runId: Id<"run">): Promise<readonly CostEntry[]>;
}
